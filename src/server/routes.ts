import { appLog, pipeChildToLog } from "./app-log.js";
import type { FastifyInstance } from "fastify";
import { readdir, readFile, writeFile, mkdir, stat, unlink, rename } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { loadPlayout } from "../yaml.js";
import { SchedulingEngine } from "../engine.js";
import { timeshiftSource } from "../index.js";
import { probeRemote } from "../scheduling/remote-module.js";
import { compilePodsDetailed, emitYaml } from "../pods/compile.js";
import { podKey } from "../pods/model.js";
import { MODULES, moduleById, listChannelFiles, channelFile } from "../scheduling/registry.js";
import { floorLocalMidnight, ceilLocalMidnight, type Tz } from "../time.js";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { buildService, type BuildWorkerChannel } from "./build-service.js";
import { ConfigStore } from "./config.js";
import { getResolver, dropResolver } from "./resolverCache.js";
import { registerLegacyElementRoutes } from "./legacy-elements.js";
import { createJob, getJob } from "./jobs.js";
import type { Scheduler } from "./scheduler.js";
import { generateNext, seedNextConfig, playoutBaseDir, upNextOptionsFor, writeGuidePlayout, cardAudioPath } from "./nextgen.js";
import { registerGraphicsRoutes } from "./graphics.js";
import { registerTroubleshootRoutes } from "./troubleshoot.js";
import type { NextRunner } from "./next-runner.js";
import { fallbackChoice, renderStandby } from "./fallback-image.js";
import { effectiveDbPath } from "./library-import.js";
import { listSources, listLibraries, listTrash, emptyTrash, libraryExists, createLocalLibrary, deleteLibrary, deleteSource, listLibraryPaths, addLibraryPath, updateLibraryPath, removeLibraryPath, addRemoteSource, upsertDiscoveredLibraries, listPathReplacements, addPathReplacement, updatePathReplacement, removePathReplacement } from "./library-repo.js";
import { readSourceInfo, discoverLibraries } from "./scanner-remote.js";
import { kindCounts, listCards, letterOffsets, listSeasons, listEpisodes, itemDetail, artworkTarget, listShowTitles, isLibraryFile } from "./library-browse.js";
import { listCollections, collectionItems, createCollection, updateCollection, deleteCollection, collectionsContaining, addToCollection, removeFromCollection, playlistEntries, addPlaylistEntry, updatePlaylistEntry, reorderPlaylist, removePlaylistEntry, playlistsContaining, collectionMeta, multiMembers, addMultiMember, removeMultiMember, collectionUsedBy, type CollectionType } from "./library-collections.js";
import { channelsUsing, renameInChannels } from "./collection-refs.js";
import { Enumerator, PlaylistEnumerator } from "../resolver.js";
import { groupSegments } from "../segments.js";
import { plexCreatePin, plexCheckPin, mediaBrowserLogin } from "./remote-auth.js";
import { refreshPodsConfig, refreshPodsChannelFile } from "./pods-channel.js";
import { readLog, logLine } from "./runtime-log.js";
import { indexService } from "./index-service.js";
import { fieldCatalog, explainQuery, suggestField } from "../search-help.js";
import { parseQuery } from "../search.js";
import { SqliteResolver } from "../sqlite-resolver.js";
import { overlayExamplesDir, overlayOptionsFor, overlayAssetsDir, overlayCacheDir, overlayAssetFile, saveOverlayAsset, pruneOverlayCache, newOverlayId, MAX_VIDEO_BYTES, overlayPicturesDir, listPictures, savePicture, pictureFile } from "./overlay-library.js";
import { OVERLAY_FIELDS, OVERLAY_SLOTS, sampleVars, overlaySvg, rasterize, loadRasterizer, assetPath, fillTemplate, findPicture, type Overlay } from "../overlays.js";
import { planLegacyImportMulti, applyLegacyImport, applyLegacyLogos, applyLegacyWatermarks, checkPlanContent, normalizeChannelNumber, type ContentCheck } from "./legacy-channels.js";
import { parseArtRef, artPosterPath, artImageUrl } from "../art-ref.js";
import { compareChannelNumbers } from "../channel-numbers.js";
import { saveLogo, logoPath, logoContentType, pruneLogos, schedulerBaseUrl, lanAddress, legacyLogoFile, sniffImage, MAX_LOGO_BYTES, hasRealLogo, setGeneratedLogo, fillMissingLogos } from "./channel-logos.js";

const ROOT = process.cwd();
const abs = (p: string) => (p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : join(ROOT, p));

interface ImportJob { running: boolean; done: boolean; error: string | null; index: number; total: number; table: string; result: { tables: number; rows: number } | null; startedAt: number; }
let importJob: ImportJob = { running: false, done: false, error: null, index: 0, total: 0, table: "", result: null, startedAt: 0 };

interface ScanJob { running: boolean; done: boolean; error: string | null; warning: string | null; note?: string | null; scope: "local" | "remote" | null; libraryId: number | null; sourceId: number | null; done_: number; total: number; added: number; updated: number; missing: number; current: string; result: { found: number; added: number; updated: number; unchanged: number; missing: number; errors: number } | null; startedAt: number; }
const emptyScan: ScanJob = { running: false, done: false, error: null, warning: null, note: null, scope: null, libraryId: null, sourceId: null, done_: 0, total: 0, added: 0, updated: 0, missing: 0, current: "", result: null, startedAt: 0 };
let scanJob: ScanJob = { ...emptyScan };

// in-flight Plex PIN sign-ins, keyed by source id
const plexPins = new Map<number, { pinId: number; clientId: string }>();

interface DeepJob { running: boolean; done: boolean; error: string | null; type: string; id: number; done_: number; total: number; current: string; result: { targets: number; refreshed: number; failed: number; chapters: number } | null; }
let deepJob: DeepJob = { running: false, done: false, error: null, type: "", id: 0, done_: 0, total: 0, current: "", result: null };

/** ?refresh=1 re-fetches full metadata for every item/show (backfills cast, crew,
 *  ratings, guids and show metadata an older scan never pulled). */
function wantsRefresh(req: any): boolean {
  const v = req.query?.refresh ?? req.body?.refreshMetadata;
  return v === true || v === "1" || v === "true";
}

// Parse a chunk of scan-remote CLI stdout into the shared scanJob progress.
function remoteScanLine(chunk: string): void {
  for (const line of chunk.split("\n")) {
    const bf = line.match(/^BACKFILL (.+) (\d+)\/(\d+)$/);
    if (bf) {
      const [, lib, batch, total] = bf; const left = +total - +batch;
      const msg = left > 0
        ? `${lib}: filling in full metadata (cast, crew, ratings, ids) for ${batch} of ${total} older items this scan — the other ${left} are fetched on the next scans, or use Refresh metadata on the source to do them all now.`
        : `${lib}: filled in full metadata (cast, crew, ratings, ids) for ${total} older items.`;
      scanJob.note = scanJob.note ? `${scanJob.note} ${msg}` : msg;
      continue;
    }
    const am = line.match(/^ARTWORK (.+) (\d+)$/);
    if (am) { const msg = `${am[1]}: filled in or updated ${am[2]} poster/artwork entr${+am[2] === 1 ? "y" : "ies"}.`; scanJob.note = scanJob.note ? `${scanJob.note} ${msg}` : msg; continue; }
    const sp = line.match(/^(SHOWS|NETWORKS) (.+) (\d+)\/(\d+)$/);
    if (sp) { scanJob.current = `${sp[1] === "SHOWS" ? "show metadata" : "networks"} · ${sp[2]}`; scanJob.done_ = +sp[3]; scanJob.total = +sp[4]; continue; }
    const pm = line.match(/^FETCHING (.+) (\d+)\/(\d+|\?)$/);
    if (pm) { scanJob.current = `fetching ${pm[1]}`; scanJob.done_ = +pm[2]; scanJob.total = pm[3] === "?" ? 0 : +pm[3]; continue; }
    const fm = line.match(/^FETCH (.+)$/); if (fm) { scanJob.current = `fetching ${fm[1]}`; continue; }
    const dp = line.match(/^DETAILING (.+) (\d+)\/(\d+)$/);
    if (dp) { scanJob.current = `refreshing ${dp[1]}`; scanJob.done_ = +dp[2]; scanJob.total = +dp[3]; continue; }
    const lm = line.match(/^LIB (.+): \+(\d+) ~(\d+) missing:(\d+)/);
    if (lm) { scanJob.added += +lm[2]; scanJob.updated += +lm[3]; scanJob.missing += +lm[4]; scanJob.current = lm[1]; continue; }
    const wm = line.match(/^WARN (.+)$/); if (wm) { scanJob.warning = wm[1]; continue; }
    const dm = line.match(/^DONE: \d+ libraries, found (\d+), added (\d+), updated (\d+), missing (\d+)/);
    if (dm) scanJob.result = { found: +dm[1], added: +dm[2], updated: +dm[3], unchanged: 0, missing: +dm[4], errors: 0 };
  }
}


// Decode a compact ISO window filename back to readable ISO for the UI.
function parseWindow(file: string): { start?: string; finish?: string } {
  const m = basename(file, ".json").match(/^(\d{8}T\d{6})\.\d+([+-]\d{4})_(\d{8}T\d{6})\.\d+([+-]\d{4})$/);
  if (!m) return {};
  const iso = (d: string, o: string) =>
    `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}${o.slice(0, 3)}:${o.slice(3)}`;
  return { start: iso(m[1], m[2]), finish: iso(m[3], m[4]) };
}

export async function registerRoutes(app: FastifyInstance, store: ConfigStore, scheduler?: Scheduler, nextRunner?: NextRunner) {
  // Live "coming up next" graphics-canvas endpoint (GET /graphics/upnext).
  registerGraphicsRoutes(app, store, ROOT);

  // --- config ---
  app.get("/api/config", async () => store.get());
  app.put("/api/config", async (req, reply) => {
    let c;
    try { c = store.set(req.body as any); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    scheduler?.reconfigure(); nextRunner?.reconfigure(); return c;
  });

  // --- ErsatzTV next process supervisor ---
  app.get("/api/next/runner", async () => nextRunner?.status() ?? { enabled: false, phase: "stopped" });
  app.post("/api/next/start", async () => { await nextRunner?.start(true); return nextRunner?.status(); });
  app.post("/api/next/stop", async () => { nextRunner?.stop(true); return nextRunner?.status(); });
  app.post("/api/next/restart", async () => { await nextRunner?.restart(); return nextRunner?.status(); });

  // --- scheduler ---
  app.get("/api/scheduler", async () => scheduler?.status() ?? { enabled: false });
  app.post("/api/scheduler/run", async () => { await scheduler?.runNow(); return scheduler?.status() ?? { enabled: false }; });

  // --- media library import (legacy DB -> our own library.sqlite) ---
  app.get("/api/library/status", async () => {
    const cfg = store.get();
    const libPath = abs(cfg.libraryDbPath);
    const imported = !!cfg.libraryDbPath && existsSync(libPath);
    let stats: any = null, sourceCounts: any = null;
    // don't open a resolver mid-import (it would cache an immutable partial snapshot)
    if (imported && !importJob.running) { try { const r = getResolver(libPath); stats = r.stats(); } catch (e) { stats = { error: (e as Error).message }; } }
    return { imported, libraryDbPath: cfg.libraryDbPath, source: cfg.etvDbPath, job: importJob, stats, sourceCounts };
  });

  app.post("/api/library/import", async (_req, reply) => {
    if (importJob.running) return importJob;
    const cfg = store.get();
    if (!cfg.legacyImport) { reply.code(409); return { error: "ErsatzTV legacy import is turned off. Turn it back on on the Connect tab if you need it." }; }
    if (!cfg.etvDbPath) return { error: "Set the ErsatzTV DB path on the Connect tab first." };
    const libPath = abs(cfg.libraryDbPath);
    dropResolver(libPath); // release any open (immutable) handle to the old library
    importJob = { running: true, done: false, error: null, index: 0, total: 0, table: "", result: null, startedAt: Date.now() };
    const child = spawn(process.execPath, [join(ROOT, "dist", "cli.js"), "import-library", "--from", cfg.etvDbPath, "--to", libPath, "--force"], { cwd: ROOT }); // the route already checked legacyImport
    pipeChildToLog(child, "import");
    child.stdout.on("data", (d) => {
      for (const line of String(d).split("\n")) {
        const m = line.match(/^IMPORT (\d+)\/(\d+) (\S+) \((\d+)\)/);
        if (m) { importJob.index = +m[1]; importJob.total = +m[2]; importJob.table = m[3]; }
        const dm = line.match(/^DONE: (\d+) tables, (\d+) rows/);
        if (dm) importJob.result = { tables: +dm[1], rows: +dm[2] };
      }
    });
    child.stderr.on("data", (d) => { const s = String(d); if (!/Experimental|trace-warnings/.test(s)) importJob.error = (importJob.error ?? "") + s; });
    child.on("close", (code) => {
      importJob.running = false; importJob.done = code === 0;
      if (code !== 0 && !importJob.error) importJob.error = `exit ${code}`;
      dropResolver(libPath); // force a fresh (non-stale) handle to the imported library
      if (code === 0) indexService.start(libPath, "the library was imported");
    });
    child.on("error", (e) => { importJob.running = false; importJob.error = String(e); });
    return importJob;
  });

  // --- runtime log (guide-stream diagnostics + server events) ---
  const logFile = () => join(abs(store.getNextConfig().runtimeDir), "guide.log");
  app.get("/api/logs", async (req) => {
    const n = Number((req.query as Record<string, string>)?.n) || 400;
    return { lines: await readLog(logFile(), n) };
  });
  app.post("/api/logs/clear", async () => { try { await writeFile(logFile(), ""); } catch { /* ignore */ } return { ok: true }; });

  // --- media library: sources / libraries / trash ---
  const libDb = () => abs(store.get().libraryDbPath);
  const withEnabled = () => {
    const en = store.libraryEnabledMap();
    return listLibraries(libDb()).map((l) => ({ ...l, enabled: en.get(l.id) ?? true, hasToken: l.sourceType === "local" ? true : store.hasSourceToken(l.sourceId) }));
  };
  app.get("/api/media/sources", async () => libraryExists(libDb()) ? listSources(libDb()) : []);
  app.get("/api/media/libraries", async () => libraryExists(libDb()) ? withEnabled() : []);
  app.post("/api/media/libraries", async (req) => {
    if (!libraryExists(libDb())) return { error: "Import a library first (the app database doesn't exist yet)." };
    const b = (req.body as any) ?? {};
    const paths: string[] = Array.isArray(b.paths) ? b.paths : b.path ? [b.path] : [];
    try {
      const lib = createLocalLibrary(libDb(), { name: b.name, kind: Number(b.kind), paths });
      return lib;
    } catch (e) { return { error: (e as Error).message }; }
  });
  app.delete("/api/media/libraries/:id", async (req) => {
    if (!libraryExists(libDb())) return { deleted: 0 };
    const id = Number((req.params as any).id);
    const r = deleteLibrary(libDb(), id);
    store.removeLibrarySetting(id);
    indexService.changed(); // its items' documents are removed
    return r;
  });

  // --- local library folders (LibraryPath) ---
  app.get("/api/media/libraries/:id/paths", async (req) => libraryExists(libDb()) ? listLibraryPaths(libDb(), Number((req.params as any).id)) : []);
  app.post("/api/media/libraries/:id/paths", async (req) => {
    try { const r = addLibraryPath(libDb(), Number((req.params as any).id), (req.body as any)?.path); return r; }
    catch (e) { return { error: (e as Error).message }; }
  });
  app.put("/api/media/paths/:pathId", async (req) => {
    try { const r = updateLibraryPath(libDb(), Number((req.params as any).pathId), (req.body as any)?.path); return r; }
    catch (e) { return { error: (e as Error).message }; }
  });
  app.delete("/api/media/paths/:pathId", async (req) => {
    try { const r = removeLibraryPath(libDb(), Number((req.params as any).pathId)); indexService.changed(); return r; }
    catch (e) { return { error: (e as Error).message }; }
  });

  // --- add a remote source (Plex/Jellyfin/Emby) + discover its libraries ---
  app.post("/api/media/sources", async (req) => {
    if (!libraryExists(libDb())) return { error: "Import a library first (the app database doesn't exist yet)." };
    const b = (req.body as any) ?? {};
    try {
      const r = addRemoteSource(libDb(), { type: b.type, serverName: b.serverName, address: b.address });
      if (b.token) store.setSourceSecret(r.sourceId, { token: b.token, address: b.address });
      return r;
    } catch (e) { return { error: (e as Error).message }; }
  });
  app.delete("/api/media/sources/:id", async (req, reply) => {
    if (!libraryExists(libDb())) return { deletedLibraries: 0, deletedItems: 0 };
    const id = Number((req.params as any).id);
    // local folders are removed one library at a time, never all at once
    if (listSources(libDb()).find((s) => s.id === id)?.type === "local") return reply.code(400).send({ error: "Local folders are removed one at a time: open the folder on the Sources tab and click Remove." });
    const libIds = listLibraries(libDb()).filter((l) => l.sourceId === id).map((l) => l.id);
    const r = deleteSource(libDb(), id);
    for (const lid of libIds) store.removeLibrarySetting(lid);
    store.removeSourceSecret(id);
    indexService.changed(); // its items' documents are removed
    return r;
  });
  app.post("/api/media/sources/:id/discover", async (req) => {
    if (!libraryExists(libDb())) return { error: "Import a library first." };
    const id = Number((req.params as any).id);
    const info = readSourceInfo(libDb(), id);
    if (!info) return { error: `Source ${id} is not a Plex/Jellyfin/Emby source.` };
    const secret = store.getSourceSecret(id);
    const address = secret.address || info.address;
    if (!address) return { error: "No server address for this source." };
    if (!secret.token) return { error: `Sign in / add a ${info.type} token first.` };
    try {
      const found = await discoverLibraries(info.type, address, secret.token);
      const r = upsertDiscoveredLibraries(libDb(), id, info.type, found);
      return { discovered: found.length, ...r };
    } catch (e) { return { error: `Discovery failed: ${(e as Error).message}` }; }
  });
  app.get("/api/media/sources/:id", async (req) => {
    if (!libraryExists(libDb())) return { source: null, libraries: [] };
    const id = Number((req.params as any).id);
    const source = listSources(libDb()).find((s) => s.id === id) ?? null;
    const libraries = withEnabled().filter((l) => l.sourceId === id);
    return { source, libraries };
  });
  app.put("/api/media/libraries/:id/enabled", async (req) => {
    const id = Number((req.params as any).id);
    const enabled = !!(req.body as any)?.enabled;
    store.setLibraryEnabled(id, enabled); // applied per search/build (no re-indexing needed)
    return { id, enabled };
  });
  app.get("/api/media/trash", async (req) => {
    if (!libraryExists(libDb())) return { total: 0, items: [] };
    const q = req.query as { limit?: string; offset?: string };
    return listTrash(libDb(), Number(q.limit ?? 100), Number(q.offset ?? 0));
  });
  app.post("/api/media/trash/empty", async () => {
    if (!libraryExists(libDb())) return { deleted: 0 };
    const r = emptyTrash(libDb());
    indexService.changed(); // removed items' documents go away
    return r;
  });

  // --- local folder scan (keeps a local library in sync with disk) ---
  app.get("/api/media/scan", async () => scanJob);
  app.post("/api/media/libraries/:id/scan", async (req) => {
    if (scanJob.running) return scanJob;
    if (!libraryExists(libDb())) return { error: "Import a library first." };
    const id = Number((req.params as any).id);
    const lib = listLibraries(libDb()).find((l) => l.id === id);
    if (!lib) return { error: `Library ${id} not found.` };
    const path = libDb();

    // Remote library -> scan just this one library over the provider API.
    if (lib.sourceType !== "local") {
      if (!store.hasSourceToken(lib.sourceId)) return { error: `Sign in to the ${lib.sourceType} source first (open the source to add a token).` };
      scanJob = { ...emptyScan, running: true, scope: "remote", libraryId: id, sourceId: lib.sourceId, total: 1, startedAt: Date.now() };
      const secret = store.getSourceSecret(lib.sourceId);
      const args = [join(ROOT, "dist", "cli.js"), "scan-remote", "--source", String(lib.sourceId), "--library", String(id), "--db", path, "--token", secret.token];
      if (secret.address) args.push("--address", secret.address);
      if (wantsRefresh(req)) args.push("--refresh-metadata");
      const child = spawn(process.execPath, args, { cwd: ROOT });
      pipeChildToLog(child, "scan");
      child.stdout.on("data", (d) => remoteScanLine(String(d)));
      child.stderr.on("data", (d) => { const s = String(d); if (!/Experimental|trace-warnings/.test(s)) scanJob.error = (scanJob.error ?? "") + s; });
      child.on("close", (code) => { scanJob.running = false; scanJob.done = code === 0; if (code !== 0 && !scanJob.error) scanJob.error = `exit ${code}`; indexService.changed(); });
      child.on("error", (e) => { scanJob.running = false; scanJob.error = String(e); });
      return scanJob;
    }

    // Local library -> folder scan.
    scanJob = { ...emptyScan, running: true, scope: "local", libraryId: id, startedAt: Date.now() };
    const ffprobe = store.getNextConfig().ffprobePath || "ffprobe";
    const child = spawn(process.execPath, [join(ROOT, "dist", "cli.js"), "scan-library", "--library", String(id), "--db", path, "--ffprobe", ffprobe], { cwd: ROOT });
    pipeChildToLog(child, "scan");
    child.stdout.on("data", (d) => {
      for (const line of String(d).split("\n")) {
        const wm = line.match(/^WALKED (\d+)$/);
        if (wm) scanJob.total = +wm[1];
        const m = line.match(/^SCAN (\d+)\/(\d+) \+(\d+) ~(\d+) ?(.*)$/);
        if (m) { scanJob.done_ = +m[1]; scanJob.total = +m[2]; scanJob.added = +m[3]; scanJob.updated = +m[4]; scanJob.current = m[5]; }
        const dm = line.match(/^DONE: found (\d+), added (\d+), updated (\d+), unchanged (\d+), missing (\d+), errors (\d+)/);
        if (dm) scanJob.result = { found: +dm[1], added: +dm[2], updated: +dm[3], unchanged: +dm[4], missing: +dm[5], errors: +dm[6] };
      }
    });
    child.stderr.on("data", (d) => { const s = String(d); if (!/Experimental|trace-warnings/.test(s)) scanJob.error = (scanJob.error ?? "") + s; });
    child.on("close", (code) => {
      scanJob.running = false; scanJob.done = code === 0;
      if (scanJob.result) { scanJob.missing = scanJob.result.missing; }
      if (code !== 0 && !scanJob.error) scanJob.error = `exit ${code}`;
      indexService.changed(); // apply what the scan queued for re-indexing
    });
    child.on("error", (e) => { scanJob.running = false; scanJob.error = String(e); });
    return scanJob;
  });

  // --- remote source connection (address is in the imported DB; token is not) ---
  app.get("/api/media/sources/:id/connection", async (req) => {
    const id = Number((req.params as any).id);
    const info = libraryExists(libDb()) ? readSourceInfo(libDb(), id) : null;
    const secret = store.getSourceSecret(id);
    return {
      type: info?.type ?? null,
      address: secret.address || info?.address || null,   // UI override wins, else the imported address
      importedAddress: info?.address ?? null,
      hasToken: !!secret.token,
      pathReplacements: info?.pathReplacements ?? [],
      libraries: info?.libraries ?? [],
    };
  });
  // --- path replacements (map provider media paths to locally-readable paths) --
  app.get("/api/media/sources/:id/path-replacements", async (req) => {
    if (!libraryExists(libDb())) return { sourceType: "unknown", replacements: [] };
    return listPathReplacements(libDb(), Number((req.params as any).id));
  });
  app.post("/api/media/sources/:id/path-replacements", async (req) => {
    if (!libraryExists(libDb())) return { error: "Import a library first." };
    const id = Number((req.params as any).id); const b = (req.body as any) ?? {};
    try { const newId = addPathReplacement(libDb(), id, String(b.remote ?? ""), String(b.local ?? "")); return { id: newId }; }
    catch (e) { return { error: (e as Error).message }; }
  });
  app.put("/api/media/sources/:id/path-replacements/:prId", async (req) => {
    if (!libraryExists(libDb())) return { error: "Import a library first." };
    const p = req.params as any; const b = (req.body as any) ?? {};
    updatePathReplacement(libDb(), Number(p.id), Number(p.prId), String(b.remote ?? ""), String(b.local ?? ""));
    return { ok: true };
  });
  app.delete("/api/media/sources/:id/path-replacements/:prId", async (req) => {
    if (!libraryExists(libDb())) return { error: "Import a library first." };
    const p = req.params as any;
    removePathReplacement(libDb(), Number(p.id), Number(p.prId));
    return { ok: true };
  });

  app.put("/api/media/sources/:id/connection", async (req) => {
    const id = Number((req.params as any).id);
    const b = (req.body as any) ?? {};
    store.setSourceSecret(id, { token: b.token, address: b.address });
    return { ok: true, hasToken: store.hasSourceToken(id) };
  });

  // --- native sign-in: Plex PIN flow ---
  app.post("/api/media/sources/:id/auth/plex/start", async (req) => {
    const id = Number((req.params as any).id);
    const info = libraryExists(libDb()) ? readSourceInfo(libDb(), id) : null;
    if (info && info.type !== "plex") return { error: `Source ${id} is ${info.type}, not Plex.` };
    try {
      const pin = await plexCreatePin(store.getClientId());
      plexPins.set(id, { pinId: pin.id, clientId: pin.clientId });
      return { authUrl: pin.authUrl, pinId: pin.id };
    } catch (e) { return { error: `Could not start Plex sign-in: ${(e as Error).message}` }; }
  });
  app.post("/api/media/sources/:id/auth/plex/poll", async (req) => {
    const id = Number((req.params as any).id);
    const p = plexPins.get(id);
    if (!p) return { authorized: false, error: "No sign-in in progress — start again." };
    try {
      const token = await plexCheckPin(p.pinId, p.clientId);
      if (!token) return { authorized: false };
      store.setSourceSecret(id, { token });
      plexPins.delete(id);
      return { authorized: true };
    } catch (e) { return { authorized: false, error: (e as Error).message }; }
  });

  // --- native sign-in: Jellyfin / Emby username + password ---
  app.post("/api/media/sources/:id/auth/login", async (req) => {
    const id = Number((req.params as any).id);
    const b = (req.body as any) ?? {};
    const info = libraryExists(libDb()) ? readSourceInfo(libDb(), id) : null;
    const secret = store.getSourceSecret(id);
    const address = b.address || secret.address || info?.address;
    if (!address) return { error: "No server address for this source." };
    if (!b.username) return { error: "Username is required." };
    try {
      const token = await mediaBrowserLogin(address, b.username, b.password ?? "", store.getClientId());
      store.setSourceSecret(id, { token, address: b.address || secret.address });
      return { ok: true };
    } catch (e) { return { error: `Sign-in failed: ${(e as Error).message}` }; }
  });

  // --- remote source scan (Plex/Jellyfin/Emby) ---
  app.post("/api/media/sources/:id/scan", async (req) => {
    if (scanJob.running) return scanJob;
    if (!libraryExists(libDb())) return { error: "Import a library first." };
    const id = Number((req.params as any).id);
    const info = readSourceInfo(libDb(), id);
    if (!info) return { error: `Source ${id} is not a Plex/Jellyfin/Emby source.` };
    if (!store.hasSourceToken(id)) return { error: `Add a ${info.type} token for this source first.` };
    const path = libDb();
    scanJob = { ...emptyScan, running: true, scope: "remote", sourceId: id, total: info.libraries.length, startedAt: Date.now() };
    const secret = store.getSourceSecret(id);
    const remoteArgs = [join(ROOT, "dist", "cli.js"), "scan-remote", "--source", String(id), "--db", path, "--token", secret.token];
    if (secret.address) remoteArgs.push("--address", secret.address);
    if (wantsRefresh(req)) remoteArgs.push("--refresh-metadata");
    const child = spawn(process.execPath, remoteArgs, { cwd: ROOT });
    pipeChildToLog(child, "scan");
    child.stdout.on("data", (d) => remoteScanLine(String(d)));
    child.stderr.on("data", (d) => { const s = String(d); if (!/Experimental|trace-warnings/.test(s)) scanJob.error = (scanJob.error ?? "") + s; });
    child.on("close", (code) => { scanJob.running = false; scanJob.done = code === 0; if (code !== 0 && !scanJob.error) scanJob.error = `exit ${code}`; indexService.changed(); });
    child.on("error", (e) => { scanJob.running = false; scanJob.error = String(e); });
    return scanJob;
  });

  // --- media browser (browse by kind, drill shows->seasons->episodes) ---
  const disabled = () => store.disabledLibraryIds();
  registerTroubleshootRoutes(app, { store, root: ROOT, libDb, disabled, nextRunner });
  app.get("/api/browse/kinds", async () => libraryExists(libDb()) ? kindCounts(libDb(), disabled()) : []);
  app.get("/api/browse/shows", async (req) => {
    const { q, limit } = req.query as { q?: string; limit?: string };
    return libraryExists(libDb()) ? listShowTitles(libDb(), q ?? "", Math.min(Number(limit) || 20, 50)) : [];
  });

  // --- collections (manual / smart / multi / playlist) ------------------------
  app.get("/api/collections", async () => libraryExists(libDb()) ? listCollections(libDb()) : []);
  app.get("/api/collections/:type/:id/items", async (req) => {
    if (!libraryExists(libDb())) return { name: "?", type: (req.params as any).type, total: 0, cards: [] };
    const { type, id } = req.params as { type: CollectionType; id: string };
    const { offset, limit } = req.query as { offset?: string; limit?: string };
    const r = getResolver(libDb()); r.setDisabledLibraries(disabled());
    return collectionItems(libDb(), r, type, Number(id), Number(offset) || 0, Math.min(Number(limit) || 200, 500));
  });
  app.post("/api/collections", async (req) => {
    if (!libraryExists(libDb())) return { error: "Import a library first." };
    const b = req.body as any;
    if (!["collection", "smart", "multi", "playlist"].includes(b.type)) return { error: "type must be collection|smart|multi|playlist" };
    const newId = createCollection(libDb(), b.type, b.name || "Untitled", b.query);
    return { id: newId, type: b.type };
  });
  app.put("/api/collections/:type/:id", async (req) => {
    if (!libraryExists(libDb())) return { error: "Import a library first." };
    const { type, id } = req.params as { type: CollectionType; id: string };
    const b = req.body as any;
    const before = collectionMeta(libDb(), type, Number(id))?.name;
    updateCollection(libDb(), type, Number(id), { name: b.name, query: b.query });
    indexService.changed(); // a renamed collection changes its members' documents
    // channels refer to it by name: carry the rename over to them
    const to = typeof b.name === "string" ? b.name.trim() : undefined;
    const channels = before && to && to !== before ? await renameInChannels(abs(store.get().channelsDir), type, before, to) : [];
    return { ok: true, channels };
  });
  // what uses a collection: channels (by name) and multi-collections / playlists in the library
  app.get("/api/collections/:type/:id/usage", async (req) => {
    if (!libraryExists(libDb())) return { channels: [], library: [] };
    const { type, id } = req.params as { type: CollectionType; id: string };
    const name = collectionMeta(libDb(), type, Number(id))?.name;
    return { channels: name ? await channelsUsing(abs(store.get().channelsDir), type, name) : [], library: collectionUsedBy(libDb(), type, Number(id)) };
  });
  // multi-collection members (manual and smart collections)
  app.get("/api/collections/multi/:id/members", async (req) =>
    libraryExists(libDb()) ? multiMembers(libDb(), Number((req.params as any).id)) : []);
  app.post("/api/collections/multi/:id/members", async (req, reply) => {
    if (!libraryExists(libDb())) return { error: "Import a library first." };
    const b = req.body as any;
    if (b?.type !== "collection" && b?.type !== "smart") { reply.code(400); return { error: "type must be collection or smart" }; }
    try { addMultiMember(libDb(), Number((req.params as any).id), { type: b.type, id: Number(b.id) }); return { ok: true }; }
    catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });
  app.delete("/api/collections/multi/:id/members/:type/:memberId", async (req) => {
    if (!libraryExists(libDb())) return { error: "Import a library first." };
    const p = req.params as { id: string; type: string; memberId: string };
    removeMultiMember(libDb(), Number(p.id), { type: p.type === "smart" ? "smart" : "collection", id: Number(p.memberId) });
    return { ok: true };
  });
  app.delete("/api/collections/:type/:id", async (req) => {
    if (!libraryExists(libDb())) return { error: "Import a library first." };
    const { type, id } = req.params as { type: CollectionType; id: string };
    deleteCollection(libDb(), type, Number(id));
    indexService.changed();
    return { ok: true };
  });
  // manual-collection membership for one media item (movie/show/season/episode…)
  app.get("/api/collections/membership/:itemId", async (req) =>
    libraryExists(libDb()) ? collectionsContaining(libDb(), Number((req.params as any).itemId)) : []);
  app.post("/api/collections/collection/:id/items", async (req, reply) => {
    if (!libraryExists(libDb())) return { error: "Import a library first." };
    try { addToCollection(libDb(), Number((req.params as any).id), Number((req.body as any)?.itemId)); indexService.changed(); return { ok: true }; }
    catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });
  // --- playlists: ordered entries -------------------------------------------
  const playlistName = (id: number) => collectionMeta(libDb(), "playlist", id)?.name;
  app.get("/api/playlists/:id", async (req, reply) => {
    if (!libraryExists(libDb())) return { error: "Import a library first." };
    const id = Number((req.params as any).id);
    const name = playlistName(id);
    if (!name) { reply.code(404); return { error: "Playlist not found." }; }
    const entries = playlistEntries(libDb(), id);
    // item counts from the resolver (same order as the rows)
    const r = getResolver(libDb()); r.setDisabledLibraries(disabled());
    const resolved = await r.resolvePlaylist(name).catch(() => []);
    return { id, name, entries: entries.map((e, i) => ({ ...e, items: resolved[i]?.items.length ?? 0 })) };
  });
  app.post("/api/playlists/:id/entries", async (req, reply) => {
    try { const b = req.body as any; return { id: addPlaylistEntry(libDb(), Number((req.params as any).id), { type: b.type, id: Number(b.id) }) }; }
    catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });
  app.put("/api/playlists/:id/entries/:entryId", async (req) => { updatePlaylistEntry(libDb(), Number((req.params as any).entryId), req.body as any); return { ok: true }; });
  app.put("/api/playlists/:id/order", async (req) => { reorderPlaylist(libDb(), Number((req.params as any).id), ((req.body as any)?.ids ?? []).map(Number)); return { ok: true }; });
  app.delete("/api/playlists/:id/entries/:entryId", async (req) => { removePlaylistEntry(libDb(), Number((req.params as any).entryId)); return { ok: true }; });
  app.get("/api/playlists/membership/:itemId", async (req) => libraryExists(libDb()) ? playlistsContaining(libDb(), Number((req.params as any).itemId)) : []);
  // what the playlist plays, in order, from the top (as a fresh channel would)
  app.get("/api/playlists/:id/preview", async (req) => {
    const id = Number((req.params as any).id), n = Math.min(Number((req.query as any).n) || 24, 200);
    const name = playlistName(id);
    if (!name) return { items: [] };
    const r = getResolver(libDb()); r.setDisabledLibraries(disabled());
    const entries = await r.resolvePlaylist(name);
    const shared = new Map<string, Enumerator>();
    const subs = entries.map((en) => {
      const k = `${en.source}::${en.order}`;
      if (!shared.has(k)) shared.set(k, new Enumerator(k, groupSegments(en.items), en.order, 1));
      return { e: shared.get(k)!, take: en.playAll ? "all" as const : Math.max(1, en.count ?? 1), inGuide: en.inGuide, label: en.label };
    });
    const pe = new PlaylistEnumerator("preview", subs);
    const out: { title: string; entry: string; durationMs: number; inGuide: boolean }[] = [];
    for (let i = 0; i < n && !pe.isEmpty; i++) {
      const at = (pe as any).entry as number; // whose turn it is
      const it = pe.next(); if (!it) break;
      out.push({ title: it.showTitle && it.title && it.title !== it.showTitle ? `${it.showTitle}: ${it.title}` : (it.title ?? (it.path ?? "").split(/[\\/]/).pop() ?? ""), entry: subs[at]?.label ?? "", durationMs: it.durationMs, inGuide: pe.lastInGuide });
    }
    return { items: out };
  });
  app.delete("/api/collections/collection/:id/items/:itemId", async (req) => {
    if (!libraryExists(libDb())) return { error: "Import a library first." };
    const { id, itemId } = req.params as { id: string; itemId: string };
    removeFromCollection(libDb(), Number(id), Number(itemId));
    indexService.changed();
    return { ok: true };
  });
  app.get("/api/browse/list", async (req) => {
    if (!libraryExists(libDb())) return { total: 0, cards: [] };
    const q = req.query as any;
    return listCards(libDb(), String(q.kind ?? "movie"), { offset: Number(q.offset ?? 0), limit: Number(q.limit ?? 60), disabled: disabled() });
  });
  // where each letter starts in a kind's grid, for the A–Z bar
  app.get("/api/browse/letters", async (req) => libraryExists(libDb()) ? letterOffsets(libDb(), String((req.query as any).kind ?? "movie"), disabled()) : {});
  app.get("/api/browse/seasons/:showId", async (req) => libraryExists(libDb()) ? listSeasons(libDb(), Number((req.params as any).showId), disabled()) : { show: null, seasons: [] });
  app.get("/api/browse/episodes/:seasonId", async (req) => libraryExists(libDb()) ? listEpisodes(libDb(), Number((req.params as any).seasonId), disabled()) : { season: null, episodes: [] });
  app.get("/api/browse/detail", async (req) => {
    if (!libraryExists(libDb())) return null;
    const q = req.query as any;
    return itemDetail(libDb(), String(q.type), Number(q.id));
  });
  app.get("/api/browse/search", async (req) => {
    if (!libraryExists(libDb())) return { total: 0, unknownFields: [], items: [] };
    const q = req.query as any;
    try {
      const r = getResolver(libDb());
      r.setDisabledLibraries(disabled());
      r.setExcludeSpecials(!store.get().includeSpecials);
      const query = String(q.q ?? "");
      const res = r.search(query, Number(q.offset ?? 0), Number(q.limit ?? 60));
      // guidance for the search box: what the query means, and fixes for unknown fields
      const didYouMean = Object.fromEntries(res.unknownFields.map((f) => [f, suggestField(f)]).filter(([, s]) => s));
      return { ...res, explain: query.trim() ? explainQuery(parseQuery(r.expandQuery(query))) : "", didYouMean };
    } catch (e) { return { total: 0, unknownFields: [], items: [], error: (e as Error).message }; }
  });

  // Deep scan — force a full metadata/chapter/stream refresh for a show/season/item.
  // --- search index status / rebuild (Library tab) ---
  app.get("/api/index/status", async () => indexService.status);
  app.post("/api/index/rebuild", async () => { indexService.rebuild(); return indexService.status; });

  // search-box guidance: every field (description + example), and library values for one
  app.get("/api/search/fields", async () => fieldCatalog());
  app.get("/api/search/values", async (req) => {
    if (!libraryExists(libDb())) return [];
    const q = req.query as { field?: string; text?: string; limit?: string };
    const r = getResolver(libDb()); r.setDisabledLibraries(disabled());
    return r.fieldValues(String(q.field ?? ""), String(q.text ?? ""), Math.min(Number(q.limit) || 20, 100));
  });
  app.get("/api/browse/deep-scan", async () => deepJob);
  app.post("/api/browse/deep-scan", async (req) => {
    if (deepJob.running) return deepJob;
    if (!libraryExists(libDb())) return { error: "Import a library first." };
    const b = (req.body as any) ?? {};
    const type = String(b.type ?? ""); const id = Number(b.id);
    if (!type || !Number.isFinite(id)) return { error: "type and id are required." };
    const path = libDb();
    deepJob = { running: true, done: false, error: null, type, id, done_: 0, total: 0, current: "", result: null };
    const ffprobe = store.getNextConfig().ffprobePath || "ffprobe";
    const child = spawn(process.execPath, [join(ROOT, "dist", "cli.js"), "deep-scan", "--type", type, "--id", String(id), "--db", path, "--ffprobe", ffprobe], { cwd: ROOT });
    pipeChildToLog(child, "deep-scan");
    child.stdout.on("data", (d) => {
      for (const line of String(d).split("\n")) {
        const m = line.match(/^DEEP (\d+)\/(\d+) ?(.*)$/);
        if (m) { deepJob.done_ = +m[1]; deepJob.total = +m[2]; deepJob.current = m[3]; }
        const dm = line.match(/^DONE: targets (\d+), refreshed (\d+), failed (\d+), chapters (\d+)/);
        if (dm) deepJob.result = { targets: +dm[1], refreshed: +dm[2], failed: +dm[3], chapters: +dm[4] };
      }
    });
    child.stderr.on("data", (d) => { const s = String(d); if (!/Experimental|trace-warnings/.test(s)) deepJob.error = (deepJob.error ?? "") + s; });
    child.on("close", (code) => { deepJob.running = false; deepJob.done = code === 0; if (code !== 0 && !deepJob.error) deepJob.error = `exit ${code}`; indexService.changed(); });
    child.on("error", (e) => { deepJob.running = false; deepJob.error = String(e); });
    return deepJob;
  });

  // Artwork proxy — resolves an item's poster/thumb and streams it from the provider.
  app.get("/api/artwork/:type/:id", async (req, reply) => {
    if (!libraryExists(libDb())) return reply.code(404).send();
    const p = req.params as any;
    const t = artworkTarget(libDb(), String(p.type), Number(p.id));
    if (!t || !["plex", "jellyfin", "emby"].includes(t.provider)) return reply.code(404).send(); // local: fallback in UI
    const info = readSourceInfo(libDb(), t.sourceId);
    const secret = store.getSourceSecret(t.sourceId);
    const address = secret.address || info?.address;
    const token = secret.token;
    if (!address || !token) return reply.code(404).send();
    const sep = t.resourcePath.includes("?") ? "&" : "?";
    const auth = t.provider === "plex" ? `X-Plex-Token=${encodeURIComponent(token)}` : `api_key=${encodeURIComponent(token)}`;
    const url = `${address.replace(/\/+$/, "")}${t.resourcePath}${sep}${auth}`;
    try {
      const r = await fetch(url, { headers: t.provider === "plex" ? {} : { "X-Emby-Token": token } });
      if (!r.ok) return reply.code(404).send();
      reply.header("content-type", r.headers.get("content-type") || "image/jpeg");
      reply.header("cache-control", "public, max-age=86400");
      return reply.send(Buffer.from(await r.arrayBuffer()));
    } catch { return reply.code(404).send(); }
  });

  // --- ErsatzTV next streaming config + lineup generation ---
  app.get("/api/next-config", async () => { await seedNextConfig(store, ROOT); return store.getNextConfig(); });
  app.put("/api/next-config", async (req) => store.setNextConfig(req.body as any));
  app.post("/api/next/apply", async () => generateNext(store, ROOT));

  // --- db verify ---
  app.post("/api/db/verify", async (req) => {
    const body = (req.body ?? {}) as { path?: string };
    const path = body.path || store.get().etvDbPath;
    if (!path) return { ok: false, error: "No database path configured." };
    try {
      await stat(path);
    } catch { return { ok: false, error: `File not found: ${path}` }; }
    try {
      const r = getResolver(path);
      const problems = r.verifySchema();
      const stats = r.stats();
      return { ok: problems.length === 0, problems, stats, path };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });

  // --- scheduling modules (pluggable scheduling modes) ---
  app.get("/api/scheduling/modules", async () => MODULES.map((m) => ({ id: m.id, label: m.label, description: m.description, editor: m.editor, schema: m.schema ? m.schema() : null, defaultConfig: m.defaultConfig() })));

  // Remote stream channels: what the playlist and guide resolve to (the form's "Check stream")
  app.post("/api/remote/probe", async (req, reply) => {
    const { config } = req.body as { config?: string };
    try { return await probeRemote(config ?? "{}", store.get().tz); }
    catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });

  // whether a typed file path (e.g. a channel's card music) exists on this machine
  app.get("/api/file-exists", async (req) => {
    const p = cardAudioPath(String((req.query as any).path ?? ""));
    return { exists: !!p && existsSync(p) };
  });

  // What a channel shows when there's nothing to play: ?channel=<name>&value=<setting being edited>
  // (omit value to use the saved one; a blank channel previews the Streaming default for a sample channel)
  app.get("/api/fallback/preview", async (req, reply) => {
    const q = req.query as { channel?: string; value?: string };
    const nc = store.getNextConfig();
    const meta = q.channel ? store.channelMetas().find((m) => m.name === q.channel) : undefined;
    const sample = { name: meta?.name ?? q.channel ?? "Your Channel", logo: meta?.logo ?? "", fallbackImage: q.value ?? meta?.fallbackImage ?? "" };
    const c = fallbackChoice(sample, nc);
    if (c.kind === "black") return reply.code(204).send();
    if (c.kind === "image") {
      const p = abs(c.path);
      if (!existsSync(p)) return reply.code(404).send({ error: "not found" });
      const data = await readFile(p);
      const kind = sniffImage(data);
      if (!kind) return reply.code(415).send({ error: "not an image" });
      return reply.type(kind.type).header("cache-control", "no-store").send(data);
    }
    const png = await renderStandby(sample, logosDir(), 960, 540);
    if (!png) return reply.code(501).send({ error: "Install @resvg/resvg-js (npm install) to draw standby cards." });
    return reply.type("image/png").header("cache-control", "no-store").send(png);
  });

  // --- channels ---
  app.get("/api/channels", async () => {
    const dir = abs(store.get().channelsDir);
    const out = [];
    for (const c of await listChannelFiles(dir)) {
      const meta = store.ensureChannelMeta(c.name); // registry row (created on first sight)
      try {
        const raw = await readFile(c.path, "utf8");
        out.push({ name: c.name, file: c.file, mode: c.module.id, meta, ...c.module.summarize(raw) });
      } catch (e) { out.push({ name: c.name, file: c.file, mode: c.module.id, meta, valid: false, error: (e as Error).message }); }
    }
    return out;
  });

  // --- import channels + Classic schedules from ErsatzTV legacy ---
  let unfilteredCache: { base: SqliteResolver; r: SqliteResolver } | null = null;
  // The live legacy DB first, then older copies (e.g. the one the library was
  // imported from) to recover schedules whose items legacy has since dropped.
  const legacySources = (extra?: string): string[] => {
    const cfg = store.get();
    const extras = [extra, "data/ersatztv.sqlite3"].filter(Boolean).map((p) => abs(p!));
    return [...new Set([cfg.etvDbPath ? abs(cfg.etvDbPath) : "", ...extras])].filter((p) => p && existsSync(p));
  };
  const legacyPlans = async (extra?: string) => {
    const cfg = store.get();
    const dir = abs(cfg.channelsDir);
    const existing = new Set((await listChannelFiles(dir)).map((c) => c.name));
    // channel numbers your channels (with a config file) already use
    const existingNumbers = new Map<string, string>();
    for (const m of store.channelMetas()) if (existing.has(m.name) && m.number && !existingNumbers.has(normalizeChannelNumber(m.number))) existingNumbers.set(normalizeChannelNumber(m.number), m.name);
    const sources = legacySources(extra);
    return { sources, dir, existingNumbers, plans: planLegacyImportMulti(sources, { channelsDir: dir, existing, existingNumbers, libraryDbPath: abs(cfg.libraryDbPath), logoDbPaths: sources }) };
  };
  app.get("/api/legacy/channels", async (req) => {
    if (!store.get().legacyImport) return { off: true, error: "ErsatzTV legacy import is turned off. Turn it back on on the Connect tab if you need it." };
    const { sources, plans, existingNumbers } = await legacyPlans((req.query as any)?.also);
    if (!sources.length) return { error: "No ErsatzTV legacy database found — set its path on the Connect tab." };
    // what each channel would actually air, resolved like a build would
    let checks: Record<string, ContentCheck | null> = {};
    if (libraryExists(libDb())) {
      const r = getResolver(libDb()); r.setDisabledLibraries(disabled());
      // Disabled libraries included — only to explain empty channels. Cached with
      // (and invalidated alongside) the shared resolver, which scans replace.
      if (unfilteredCache && unfilteredCache.base !== r) { try { unfilteredCache.r.close(); } catch { /* ignore */ } unfilteredCache = null; }
      const unfiltered = () => (unfilteredCache ??= { base: r, r: new SqliteResolver({ dbPath: libDb() }) }).r;
      for (const p of plans) checks[p.key] = await checkPlanContent(p, r, libDb(), unfiltered);
    }
    return { sources, usedNumbers: Object.fromEntries(existingNumbers), channels: plans.map((p) => ({ ...p, check: checks[p.key] ?? null, ...(p.status === "exists" ? { hasLogo: hasRealLogo(store.channelMeta(p.name)), hasWatermark: !!p.watermark && (store.channelMeta(p.name)?.overlays ?? []).includes(`legacy-watermark-${p.watermark.row.Id}`) } : {}) })) };
  });
  app.post("/api/legacy/channels/import", async (req, reply) => {
    if (!store.get().legacyImport) { reply.code(409); return { error: "ErsatzTV legacy import is turned off. Turn it back on on the Connect tab if you need it." }; }
    const body = (req.body ?? {}) as { keys?: string[]; overwrite?: boolean; also?: string; numbers?: Record<string, string> };
    if (!body.keys?.length) return { error: "Pick at least one channel." };
    const { dir, plans, existingNumbers } = await legacyPlans(body.also);
    const res = await applyLegacyImport(plans, body.keys, dir, store, { overwrite: !!body.overwrite, numbers: body.numbers, existingNumbers, logosDir: logosDir(), overlayAssetsDir: overlayAssetsDir(store, ROOT) });
    await fillLogos(res.imported.map((c) => c.name));
    return res;
  });
  // logos for channels you already imported (same name in legacy)
  app.post("/api/legacy/channels/logos", async (req, reply) => {
    if (!store.get().legacyImport) { reply.code(409); return { error: "ErsatzTV legacy import is turned off. Turn it back on on the Connect tab if you need it." }; }
    const body = (req.body ?? {}) as { names?: string[]; replace?: boolean; also?: string };
    const { plans } = await legacyPlans(body.also);
    return applyLegacyLogos(plans, store, logosDir(), { names: body.names, replace: !!body.replace });
  });
  // watermarks for channels you already imported (same name in legacy), as overlays
  app.post("/api/legacy/channels/watermarks", async (req, reply) => {
    if (!store.get().legacyImport) { reply.code(409); return { error: "ErsatzTV legacy import is turned off. Turn it back on on the Connect tab if you need it." }; }
    const body = (req.body ?? {}) as { names?: string[]; also?: string };
    const { plans } = await legacyPlans(body.also);
    return applyLegacyWatermarks(plans, store, overlayAssetsDir(store, ROOT), { names: body.names });
  });
  // a legacy logo (by its artwork-cache key), to preview it in the import list
  app.get("/api/legacy/logo/:hash", async (req, reply) => {
    const f = legacyLogoFile(legacySources(), String((req.params as any).hash));
    if (!f) return reply.code(404).send();
    const data = await readFile(f);
    reply.header("content-type", sniffImage(data)?.type ?? "application/octet-stream").header("cache-control", "public, max-age=86400");
    return reply.send(data);
  });

  // reset a channel's playout progress (restart episode order from the beginning)
  app.post("/api/channels/:name/reset-progress", async (req) => {
    store.clearProgress((req.params as any).name);
    return { ok: true };
  });

  // per-channel next metadata (number / tvg_id / logo / group / enabled)
  app.put("/api/channels/:name/meta", async (req, reply) => {
    const { name } = req.params as { name: string };
    const patch = (req.body ?? {}) as { number?: string };
    // channel numbers are unique across the lineup — refuse a CHANGE to a number
    // another channel uses (keeping an already-shared number is allowed, so the
    // channel's other settings can still be edited while it gets sorted out)
    if (patch.number !== undefined) {
      const want = normalizeChannelNumber(patch.number);
      const current = normalizeChannelNumber(store.channelMeta(name)?.number);
      if (want && want !== current) {
        const withFile = new Set((await listChannelFiles(abs(store.get().channelsDir))).map((c) => c.name));
        const owner = store.channelMetas().find((m) => m.name !== name && withFile.has(m.name) && normalizeChannelNumber(m.number) === want);
        if (owner) { reply.code(409); return { error: `Channel number ${patch.number} is already used by "${owner.name}".` }; }
      }
    }
    // only the server marks a logo as generated (the page echoes the old flag back)
    const { logoGenerated: _fromPage, ...body } = (req.body ?? {}) as any;
    const saved = store.upsertChannelMeta(name, body);
    if ((req.body as any)?.logo !== undefined) pruneUnusedLogos();
    return saved;
  });

  // --- channel logos (stored in <runtime>/logos, served to TV apps at /logos/…) ---
  const logosDir = () => join(abs(store.getNextConfig().runtimeDir), "logos");
  const fillLogos = async (names?: string[]): Promise<string[]> => {
    try {
      const withFile = new Set((await listChannelFiles(abs(store.get().channelsDir))).map((c) => c.name));
      return await fillMissingLogos(store, logosDir(), (names ?? [...withFile]).filter((n) => withFile.has(n)));
    } catch (e) { appLog("server", `generating channel logos failed: ${(e as Error).message}`); return []; }
  };
  void fillLogos().then((n) => { if (n.length) appLog("server", `generated name logos for ${n.length} channel(s) without one: ${n.join(", ")}`); });
  // the guide channel's logo lives in the streaming settings, not channel_meta
  const pruneUnusedLogos = () => { try { pruneLogos(logosDir(), [...store.channelMetas().map((m) => m.logo), store.getNextConfig().guide.logo]); } catch { /* ignore */ } };
  // uploads arrive as the raw image body (Content-Type: image/…)
  app.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: MAX_LOGO_BYTES + 1024 }, (_req, body, done) => done(null, body));
  app.get("/logos/:file", async (req, reply) => {
    const p = logoPath(logosDir(), String((req.params as any).file));
    if (!p || !existsSync(p)) return reply.code(404).send();
    reply.header("content-type", logoContentType(p)).header("cache-control", "public, max-age=604800, immutable"); // content-addressed
    return reply.send(await readFile(p));
  });
  app.post("/api/channels/:name/logo", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!Buffer.isBuffer(req.body) || !req.body.length) { reply.code(400); return { error: "Send the image file as the request body." }; }
    try {
      const logo = await saveLogo(logosDir(), req.body);
      const meta = store.upsertChannelMeta(name, { logo });
      pruneUnusedLogos();
      return meta;
    } catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });
  // the guide channel's logo (Streaming → Guide channel); stored with the streaming settings
  app.post("/api/guide/logo", async (req, reply) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) { reply.code(400); return { error: "Send the image file as the request body." }; }
    try {
      const logo = await saveLogo(logosDir(), req.body);
      const cfg = store.setNextConfig({ guide: { ...store.getNextConfig().guide, logo } });
      pruneUnusedLogos();
      return cfg;
    } catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });
  app.delete("/api/guide/logo", async () => {
    const cfg = store.setNextConfig({ guide: { ...store.getNextConfig().guide, logo: "" } });
    pruneUnusedLogos();
    return cfg;
  });
  // removing a logo goes back to the generated channel-name logo (as legacy does)
  app.delete("/api/channels/:name/logo", async (req) => {
    const { name } = req.params as { name: string };
    if (!(await setGeneratedLogo(store, logosDir(), name).catch(() => null))) store.upsertChannelMeta(name, { logo: "" });
    pruneUnusedLogos();
    return store.channelMeta(name);
  });
  // --- overlays (timed graphics over programmes; see src/overlays.ts) ---------
  app.addContentTypeParser(/^video\//, { parseAs: "buffer", bodyLimit: MAX_VIDEO_BYTES + 1024 }, (_req, body, done) => done(null, body));
  if (!app.hasContentTypeParser("application/octet-stream")) app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_VIDEO_BYTES + 1024 }, (_req, body, done) => done(null, body));
  // drop cached stills / clips nothing has used for two weeks: at startup and daily
  const pruneCache = () => { try { const n = pruneOverlayCache(overlayCacheDir(store, ROOT)); if (n) appLog("server", `overlay cache: removed ${n} file${n === 1 ? "" : "s"} nothing has used for 14 days`); } catch { /* ignore */ } };
  pruneCache();
  setInterval(pruneCache, 86_400_000).unref();
  // overlays drawn live: next fetches each layer's PNG as it airs (see liveLayers
  // in overlays.ts). The show details come in the address, baked in by the build.
  const livePngs = new Map<string, Buffer>();
  app.get("/graphics/overlay.png", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const key = req.url;
    let png = livePngs.get(key);
    if (!png) {
      const o = store.getOverlay(String(q.o ?? "")) as Overlay | null;
      const W = Math.max(16, Math.min(7680, Number(q.w) || 1920)), H = Math.max(16, Math.min(4320, Number(q.h) || 1080));
      let vars: Record<string, string> = {};
      try { vars = JSON.parse(Buffer.from(String(q.d ?? ""), "base64url").toString("utf8")) ?? {}; } catch { /* none */ }
      const idx = String(q.l ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 0);
      const layers = o ? idx.map((i) => o.layers[i]).filter(Boolean) : [];
      const oo = overlayOptionsFor(store, String(q.c ?? ""), ROOT); // asset folder, channel logo, pictures folder
      await loadRasterizer();
      const s = overlaySvg({ ...(o ?? { id: "", name: "", timing: { mode: "always" } }), layers } as Overlay, vars, (src) => {
        try { const p = assetPath(src, oo.assetsDir, oo.channelLogo); if (!p) return null; return { data: readFileSync(p).toString("base64"), mime: logoContentType(p) }; } catch { return null; }
      }, { view: { x: 0, y: 0, w: 1920, h: 1080 }, px: { w: W, h: H } });
      png = (s && (await rasterize(s.svg))) || (await rasterize(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"/>`)) || Buffer.alloc(0);
      if (livePngs.size > 400) livePngs.delete(livePngs.keys().next().value!);
      livePngs.set(key, png);
    }
    reply.header("content-type", "image/png").header("cache-control", "public, max-age=600");
    return reply.send(png);
  });
  // a changed overlay draws afresh live (its addresses stay the same)
  app.addHook("onResponse", async (req) => { if (req.url.startsWith("/api/overlays") && req.method !== "GET") livePngs.clear(); });
  const examplesDir = overlayExamplesDir(ROOT); // also where example: image sources resolve
  // ready-made overlays that ship with the scheduler (examples/overlays/*.json)
  app.get("/api/overlays/examples", async () => {
    const dir = join(examplesDir, "..");
    const out: any[] = [];
    try {
      for (const n of (await readdir(dir)).filter((x) => x.endsWith(".json")).sort()) {
        try { out.push({ ...JSON.parse(await readFile(join(dir, n), "utf8")), id: `example:${n.replace(/\.json$/, "")}` }); } catch { /* skip a broken file */ }
      }
    } catch { /* no examples folder */ }
    return out;
  });
  app.get("/overlay-examples/:file", async (req, reply) => {
    const file = String((req.params as any).file);
    if (!/^[\w.-]+\.(svg|png|jpg|webp|gif)$/i.test(file) || !existsSync(join(examplesDir, file))) return reply.code(404).send();
    reply.header("content-type", logoContentType(file)).header("cache-control", "public, max-age=3600");
    return reply.send(await readFile(join(examplesDir, file)));
  });
  app.get("/api/overlays", async () => {
    const usedBy: Record<string, string[]> = {};
    for (const m of store.channelMetas()) for (const id of m.overlays ?? []) (usedBy[id] ??= []).push(m.name);
    return { overlays: store.listOverlays(), fields: OVERLAY_FIELDS, slots: OVERLAY_SLOTS.map((s) => s.label), usedBy };
  });
  app.post("/api/overlays", async (req, reply) => {
    const o = (req.body ?? {}) as Overlay;
    if (!o.name?.trim()) { reply.code(400); return { error: "Give the overlay a name." }; }
    if (!Array.isArray(o.layers)) { reply.code(400); return { error: "An overlay needs a list of layers." }; }
    const saved = { ...o, id: o.id || newOverlayId(), name: o.name.trim() };
    store.saveOverlay(saved);
    return store.getOverlay(saved.id);
  });
  app.delete("/api/overlays/:id", async (req) => {
    const id = String((req.params as any).id);
    store.deleteOverlay(id);
    // take it off every channel that showed it
    for (const m of store.channelMetas()) if (m.overlays?.includes(id)) store.upsertChannelMeta(m.name, { overlays: m.overlays.filter((x) => x !== id) });
    return { ok: true };
  });
  // images / videos for overlay layers arrive as the raw file body
  app.post("/api/overlays/assets", async (req, reply) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) { reply.code(400); return { error: "Send the image or video file as the request body." }; }
    try { return await saveOverlayAsset(overlayAssetsDir(store, ROOT), req.body, decodeURIComponent(String(req.headers["x-file-name"] ?? ""))); }
    catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });
  app.get("/overlay-assets/:file", async (req, reply) => {
    const p = overlayAssetFile(overlayAssetsDir(store, ROOT), String((req.params as any).file));
    if (!p || !existsSync(p)) return reply.code(404).send();
    const ext = p.split(".").pop()!.toLowerCase();
    const type = ({ mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska" } as Record<string, string>)[ext] ?? logoContentType(p);
    reply.header("content-type", type).header("cache-control", "public, max-age=604800, immutable"); // content-addressed
    return reply.send(await readFile(p));
  });
  // --- the pictures folder: pictures layers pick by the schedule (match:{{next_show}}) ---
  const picturesDir = () => overlayPicturesDir(store, ROOT);
  app.get("/api/overlays/pictures", async () => {
    const dir = picturesDir();
    return { dir, isDefault: !store.get().overlayPicturesDir?.trim(), ...listPictures(dir) };
  });
  // raw file body; x-file-name keeps the name people gave it (that's what layers match)
  app.post("/api/overlays/pictures", async (req, reply) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) { reply.code(400); return { error: "Send the picture file as the request body." }; }
    try {
      const name = await savePicture(picturesDir(), req.body, decodeURIComponent(String(req.headers["x-file-name"] ?? "")), decodeURIComponent(String(req.headers["x-folder"] ?? "")));
      return { name };
    } catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });
  app.delete("/api/overlays/pictures", async (req, reply) => {
    const p = pictureFile(picturesDir(), String((req.query as any).name ?? ""));
    if (!p || !existsSync(p)) { reply.code(404); return { error: "No such picture." }; }
    await unlink(p);
    return { ok: true };
  });
  // which file a name picks (the designer's "with the sample values…" check)
  app.get("/api/overlays/pictures/match", async (req) => {
    const q = req.query as { name?: string; kind?: string };
    const dir = picturesDir();
    const hit = findPicture(String(q.name ?? ""), q.kind === "video" ? "video" : "image", dir);
    return { name: String(q.name ?? ""), file: hit ? hit.slice(dir.length + 1).replace(/\\/g, "/") : null };
  });
  const sendPicture = async (reply: any, p: string | null) => {
    if (!p || !existsSync(p)) return reply.code(404).send();
    const ext = p.split(".").pop()!.toLowerCase();
    const type = ({ mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska" } as Record<string, string>)[ext] ?? logoContentType(p);
    reply.header("content-type", type).header("cache-control", "no-cache");
    return reply.send(await readFile(p));
  };
  app.get("/overlay-pictures/file", async (req, reply) => sendPicture(reply, pictureFile(picturesDir(), String((req.query as any).name ?? ""))));
  app.get("/overlay-pictures/match", async (req, reply) => {
    const q = req.query as { name?: string; kind?: string };
    return sendPicture(reply, findPicture(String(q.name ?? ""), q.kind === "video" ? "video" : "image", picturesDir()) || null);
  });
  // ErsatzTV legacy graphics elements: import (paste / upload / folder) and test
  registerLegacyElementRoutes(app, store, ROOT, libDb);
  // one frame of a library file, for the designer's reference picture (any format
  // ffmpeg reads, unlike the browser); only files that are in the library
  app.get("/api/overlays/reference-frame", async (req, reply) => {
    const q = req.query as { path?: string; t?: string };
    const path = String(q.path ?? "");
    if (!path || !libraryExists(libDb()) || !isLibraryFile(libDb(), path)) return reply.code(404).send({ error: "That file isn't in the library." });
    if (!existsSync(path)) return reply.code(404).send({ error: "That file isn't reachable from this computer." });
    const nc = store.getNextConfig();
    const ffmpeg = nc.ffmpegPath ? abs(nc.ffmpegPath) : "ffmpeg";
    const t = Math.max(0, Number(q.t) || 0);
    const jpg = await new Promise<Buffer | null>((done) => {
      const p = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", path, "-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "4", "-f", "image2", "-c:v", "mjpeg", "pipe:1"], { windowsHide: true });
      const chunks: Buffer[] = [];
      p.stdout.on("data", (d: Buffer) => chunks.push(d));
      const kill = setTimeout(() => p.kill(), 20_000);
      p.on("error", () => { clearTimeout(kill); done(null); });
      p.on("close", () => { clearTimeout(kill); done(chunks.length ? Buffer.concat(chunks) : null); });
    });
    if (!jpg) return reply.code(500).send({ error: "ffmpeg couldn't read a frame there." });
    reply.header("content-type", "image/jpeg").header("cache-control", "private, max-age=3600");
    return reply.send(jpg);
  });
  // exactly what a build draws for the still layers (server fonts), with sample
  // or given template values; PNG cropped to the layers, plus where it sits
  app.post("/api/overlays/render", async (req, reply) => {
    const body = (req.body ?? {}) as { overlay?: Overlay; vars?: Record<string, string> };
    if (!body.overlay?.layers) { reply.code(400); return { error: "Send the overlay to render." }; }
    const dir = overlayAssetsDir(store, ROOT);
    picturesDir(); // where match: layers look
    const vars = { ...sampleVars(), ...(body.vars ?? {}) };
    await loadRasterizer(); // so text wraps by its measured width
    const s = overlaySvg(body.overlay, vars, (src) => {
      try { const p = assetPath(src, dir); if (!p) return null; const b = readFileSync(p); return { data: b.toString("base64"), mime: logoContentType(p) }; } catch { return null; }
    });
    if (!s) return { png: null, box: null };
    const png = await rasterize(s.svg);
    if (!png) { reply.code(500); return { error: "The SVG rasterizer (@resvg/resvg-js) isn't installed — run npm install." }; }
    return { png: `data:image/png;base64,${png.toString("base64")}`, box: s.box, texts: body.overlay.layers.map((l: any) => (l.type === "text" ? fillTemplate(l.text, vars) : null)) };
  });

  // give every channel without a logo a generated one (also runs at startup)
  app.post("/api/channels/logos/generate", async () => ({ generated: await fillLogos() }));
  // renumber the whole lineup 1, 2, 3… keeping the current channel order
  // (10.10 < 10.11 < 10.12 < 11; blank or non-numeric numbers go last).
  // Without `apply` it only returns the plan, for the preview.
  app.post("/api/channels/renumber", async (req) => {
    const body = (req.body ?? {}) as { apply?: boolean; start?: number };
    const start = Math.max(1, Math.floor(Number(body.start) || 1));
    const withFile = new Set((await listChannelFiles(abs(store.get().channelsDir))).map((c) => c.name));
    const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
    const metas = store.channelMetas().filter((m) => withFile.has(m.name))
      .sort((a, b) => compareChannelNumbers(a.number, b.number) || byName(a.name, b.name));
    const plan = metas.map((m, i) => ({ name: m.name, from: m.number, to: String(start + i), enabled: m.enabled }));
    const changed = plan.filter((p) => normalizeChannelNumber(p.from) !== p.to).length;
    if (body.apply) for (const p of plan) store.upsertChannelMeta(p.name, { number: p.to, sort: Number(p.to) });
    return { start, plan, changed, applied: !!body.apply };
  });
  // Programme posters for the published guide (XMLTV <icon>): /art/{sourceId}/{type}/{key}
  // is fetched from the media server with the stored token, server-side. Keys are
  // validated (art-ref.ts) so only item posters can be requested, and only images
  // are returned. Small in-memory cache: guide apps re-fetch the same posters.
  const artCache = new Map<string, { type: string; data: Buffer; at: number }>();
  app.get("/art/:sid/:type/:key", async (req, reply) => {
    const p = req.params as { sid: string; type: string; key: string };
    const ref = parseArtRef(`art://${p.sid}/${p.type}/${p.key}`);
    if (!ref || !artPosterPath(ref.type, ref.key) || !libraryExists(libDb())) return reply.code(404).send();
    const id = `${ref.sourceId}/${ref.type}/${p.key}`;
    const hit = artCache.get(id);
    const send = (c: { type: string; data: Buffer }) => reply.header("content-type", c.type).header("cache-control", "public, max-age=86400").send(c.data);
    if (hit && Date.now() - hit.at < 6 * 3_600_000) { artCache.delete(id); artCache.set(id, hit); return send(hit); }
    const sid = Number(ref.sourceId);
    const info = readSourceInfo(libDb(), sid);
    if (!info || info.type !== ref.type) return reply.code(404).send();
    const secret = store.getSourceSecret(sid);
    const address = secret.address || info.address;
    const url = address && secret.token ? artImageUrl(ref, address, secret.token) : null;
    if (!url) return reply.code(404).send();
    try {
      const r = await fetch(url, { headers: ref.type === "plex" ? {} : { "X-Emby-Token": secret.token! }, signal: AbortSignal.timeout(15_000) });
      const type = (r.headers.get("content-type") || "").split(";")[0];
      if (!r.ok || !type.startsWith("image/")) return reply.code(404).send();
      const entry = { type, data: Buffer.from(await r.arrayBuffer()), at: Date.now() };
      artCache.set(id, entry);
      while (artCache.size > 300) artCache.delete(artCache.keys().next().value!);
      return send(entry);
    } catch { return reply.code(404).send(); }
  });
  // where TV apps fetch logos from (shown on the Streaming tab)
  app.get("/api/logos/address", async () => {
    const port = Number(process.env.PORT ?? 8730);
    const publicUrl = store.getNextConfig().publicUrl ?? "";
    return { publicUrl, auto: `http://${lanAddress()}:${port}`, effective: schedulerBaseUrl(publicUrl, port) };
  });

  // delete a channel: YAML + registry row + generated runtime config + outputs
  app.delete("/api/channels/:name", async (req) => {
    const { name } = req.params as { name: string };
    const cfg = store.get();
    const nc = store.getNextConfig();
    const rt = abs(nc.runtimeDir);
    const rmQuiet = async (p: string) => { try { await unlink(p); } catch {} };
    const ch = await channelFile(abs(cfg.channelsDir), name);
    if (ch) await rmQuiet(ch.path);
    await rmQuiet(join(rt, "channels", `${name}.config.json`));
    await rmQuiet(join(rt, "xmltv", `${name}.xml`));
    const tvgId = store.channelMeta(name)?.tvgId; // the guide file is named by guide id
    if (tvgId && tvgId !== name) await rmQuiet(join(rt, "xmltv", `${tvgId}.xml`));
    store.deleteChannelMeta(name);
    store.clearProgress(name); // a later channel with this name starts fresh
    pruneUnusedLogos();
    return { deleted: name };
  });

  // Rename a channel everywhere its name is used: config file, settings, episode
  // progress, build history, playout folder, guide file (when the guide id is the
  // default), a generated name logo, and time-shift channels that follow it.
  app.post("/api/channels/:name/rename", async (req, reply) => {
    const from = (req.params as { name: string }).name;
    const b = (req.body ?? {}) as { to?: string; keepGuideId?: boolean };
    const to = String(b.to ?? "").trim();
    if (!to) { reply.code(400); return { error: "Enter a new name." }; }
    if (/[\\/:*?"<>|]/.test(to)) { reply.code(400); return { error: `A channel name can't contain \\ / : * ? " < > |` }; }
    if (to === from) return { name: to, meta: store.channelMeta(to) };
    const cfg = store.get();
    const dir = abs(cfg.channelsDir);
    const files = await listChannelFiles(dir);
    const ch = files.find((c) => c.name === from);
    if (!ch) { reply.code(404); return { error: `Channel "${from}" not found.` }; }
    if (files.some((c) => c.name !== from && c.name.toLowerCase() === to.toLowerCase())) { reply.code(400); return { error: `There's already a channel called "${to}".` }; }
    // Windows paths ignore case: a case-only rename goes through a temporary name
    const move = async (a: string, b2: string) => {
      if (a.toLowerCase() === b2.toLowerCase()) { const tmp = `${a}.renaming`; await rename(a, tmp); await rename(tmp, b2); }
      else await rename(a, b2);
    };
    const meta = store.channelMeta(from);
    // the stored data first (it can fail); the config file only once that worked
    try { store.renameChannel(from, to); }
    catch (e) { reply.code(500); return { error: `Couldn't rename the channel's settings: ${(e as Error).message}` }; }
    try { await move(ch.path, join(dir, to + ch.file.slice(from.length))); }
    catch (e) { store.renameChannel(to, from); reply.code(500); return { error: `Couldn't rename the channel's config file: ${(e as Error).message}` }; }
    // guide id: when it's still the default (the name), follow the new name unless asked to keep it
    const rt = abs(store.getNextConfig().runtimeDir);
    if (!meta?.tvgId || meta.tvgId === from) {
      if (b.keepGuideId) store.upsertChannelMeta(to, { tvgId: from });
      else {
        store.upsertChannelMeta(to, { tvgId: to });
        try { await move(join(rt, "xmltv", `${from}.xml`), join(rt, "xmltv", `${to}.xml`)); } catch { /* no guide yet */ }
      }
    }
    // the playout folder ErsatzTV next streams from
    const base = playoutBaseDir(store, ROOT);
    try {
      const dirs = (await readdir(base, { withFileTypes: true })).filter((x) => x.isDirectory());
      const d = dirs.find((x) => x.name.toLowerCase() === from.toLowerCase());
      // a folder already under the new name is a deleted channel's: park it, don't merge
      const stale = from.toLowerCase() !== to.toLowerCase() && dirs.find((x) => x.name.toLowerCase() === to.toLowerCase());
      if (d && stale) await rename(join(base, stale.name), join(base, `${stale.name}.old-${new Date().toISOString().slice(0, 10)}`));
      if (d) await move(join(base, d.name), join(base, to));
    } catch { /* not built yet */ }
    try { await unlink(join(rt, "channels", `${from}.config.json`)); } catch { /* rewritten on publish */ }
    if (meta?.logoGenerated) { await setGeneratedLogo(store, logosDir(), to).catch(() => null); pruneUnusedLogos(); }
    // time-shift channels that repeat this one
    const followers: string[] = [];
    for (const f of files.filter((c) => c.module.id === "timeshift")) {
      try {
        const c = JSON.parse(await readFile(f.path, "utf8"));
        if (String(c.source ?? "").toLowerCase() === from.toLowerCase()) { c.source = to; await writeFile(f.path, JSON.stringify(c, null, 2), "utf8"); followers.push(f.name); }
      } catch { /* leave unreadable configs alone */ }
    }
    appLog("server", `renamed channel "${from}" to "${to}"${followers.length ? ` (updated time-shift: ${followers.join(", ")})` : ""}`);
    return { name: to, meta: store.channelMeta(to), timeshiftUpdated: followers };
  });

  app.get("/api/channels/:name", async (req) => {
    const { name } = req.params as { name: string };
    const dir = abs(store.get().channelsDir);
    const ch = await channelFile(dir, name);
    if (!ch) return { name, config: "", mode: "yaml", editor: "yaml", schema: null, summary: { valid: false, error: "not found" } };
    const raw = await readFile(ch.path, "utf8");
    let summary: any; try { summary = ch.module.summarize(raw); } catch (e) { summary = { valid: false, error: (e as Error).message }; }
    // keep `yaml` for back-compat with the existing editor
    return { name, config: raw, yaml: raw, mode: ch.module.id, editor: ch.module.editor, schema: ch.module.schema ? ch.module.schema() : null, summary };
  });

  app.put("/api/channels/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const b = req.body as { config?: string; yaml?: string };
    let raw = b.config ?? b.yaml ?? "";
    const dir = abs(store.get().channelsDir);
    const ch = await channelFile(dir, name);
    const mod = ch?.module ?? moduleById("yaml")!;
    // Pod scheduler: complete the embedded pod snapshot with each show pod's
    // dependencies (mid-roll break + tail filler) from the pod library, so the
    // channel stays self-contained even if the UI didn't include them.
    if (mod.id === "pods") raw = refreshPodsConfig(raw, store.listPods());
    let summary: any; try { summary = mod.summarize(raw); } catch (e) { summary = { valid: false, error: (e as Error).message }; }
    if (!summary.valid) { reply.code(400); return summary; }
    await mkdir(dir, { recursive: true });
    await writeFile(ch?.path ?? join(dir, `${name}${mod.saveExt}`), raw, "utf8");
    return { name, mode: mod.id, summary };
  });

  app.post("/api/channels", async (req, reply) => {
    const { name, mode, config } = req.body as { name: string; mode?: string; config?: string };
    if (!name) { reply.code(400); return { error: "name required" }; }
    const mod = moduleById(mode ?? "yaml") ?? moduleById("yaml")!;
    const dir = abs(store.get().channelsDir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}${mod.saveExt}`), config ?? mod.defaultConfig(), "utf8");
    store.ensureChannelMeta(name);
    await fillLogos([name]);
    return { name, mode: mod.id };
  });

  // --- builds ---
  app.post("/api/build", async (req) => {
    const body = (req.body ?? {}) as { channel?: string; channels?: string[]; days?: number; tz?: Tz; rebuild?: boolean };
    const cfg = store.get();
    const dir = abs(cfg.channelsDir);
    let channels: string[];
    if (body.channels?.length) {
      // a specific set (e.g. just-imported channels) — only ones that exist
      const known = new Set((await listChannelFiles(dir)).map((c) => c.name));
      channels = body.channels.filter((c) => known.has(c));
    } else if (!body.channel || body.channel === "__all__") {
      channels = (await listChannelFiles(dir)).map((c) => c.name);
    } else channels = [body.channel];

    const days = body.days ?? cfg.days;
    const tz = body.tz ?? cfg.tz;
    const job = createJob(channels);
    void runBuild(job.id, channels, cfg, days, tz, store, !!body.rebuild);
    return { jobId: job.id, channels };
  });

  app.get("/api/build/:id", async (req, reply) => {
    const job = getJob((req.params as any).id);
    if (!job) { reply.code(404); return { error: "no such job" }; }
    return job;
  });

  app.get("/api/builds", async () => store.recentBuilds());

  // --- playouts (preview) — same folder ErsatzTV next serves from ---
  app.get("/api/playouts/:channel", async (req) => {
    const { channel } = req.params as { channel: string };
    const dir = join(playoutBaseDir(store, ROOT), channel);
    let files: string[] = [];
    try { files = (await readdir(dir)).filter((f) => f.endsWith(".json") && !f.endsWith(".labels.json")); } catch { return []; }
    files.sort();
    return files.map((f) => ({ file: f, ...parseWindow(f) }));
  });

  // how far ahead each channel is built: channel folder -> end of its last window
  app.get("/api/coverage", async () => {
    const base = playoutBaseDir(store, ROOT);
    const out: Record<string, string | null> = {};
    let dirs: string[] = [];
    try { dirs = (await readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
    for (const ch of dirs) {
      let files: string[] = [];
      try { files = (await readdir(join(base, ch))).filter((f) => f.endsWith(".json") && !f.endsWith(".labels.json")).sort(); } catch {}
      out[ch] = files.length ? parseWindow(files[files.length - 1]).finish ?? null : null;
    }
    return out;
  });

  app.get("/api/playouts/:channel/:file", async (req) => {
    const { channel, file } = req.params as { channel: string; file: string };
    const dir = join(playoutBaseDir(store, ROOT), channel);
    const playout = JSON.parse(await readFile(join(dir, file), "utf8"));
    let labels: Record<string, any> = {};
    try { labels = JSON.parse(await readFile(join(dir, file.replace(/\.json$/, ".labels.json")), "utf8")); } catch {}
    return { playout, labels };
  });

  // --- pods (authoring building blocks) --------------------------------------
  app.get("/api/pods", async () => store.listPods());
  app.get("/api/pods/:id", async (req) => store.getPod((req.params as any).id) ?? { error: "not found" });
  app.post("/api/pods", async (req) => {
    const b = req.body as any;
    const id = podKey(b.id || b.name || "");
    if (!id) return { error: "A pod needs an id or name." };
    if (!["break", "filler", "show"].includes(b.type)) return { error: "type must be break|filler|show" };
    store.savePod({ id, name: b.name || id, type: b.type, config: b.config ?? {} });
    return store.getPod(id);
  });
  app.delete("/api/pods/:id", async (req) => { store.deletePod((req.params as any).id); return { ok: true }; });

  // Compile a set of pods to YAML, and optionally test-build one pod for preview.
  app.post("/api/pods/preview", async (req) => {
    const b = (req.body as any) ?? {};
    const pods = (b.pods && b.pods.length ? b.pods : store.listPods()) as any[];
    const entryId = podKey(b.entryId || "");
    let yaml = "", entryKey = "";
    try {
      const { doc, entry } = compilePodsDetailed(pods);
      const ref = entry.get(entryId);
      const playout = ref ? [{ [ref.kind]: ref.key }, { repeat: true }] : undefined;
      yaml = emitYaml({ ...doc, playout });
      entryKey = ref?.key ?? "";
      if (!ref) return { yaml, items: [], labels: {}, warning: "No entry pod selected to preview." };
    } catch (e) { return { error: `compile failed: ${(e as Error).message}` }; }

    // Test-build a short window against the library so the preview shows real items.
    const cfg = store.get();
    const dbPath = effectiveDbPath(abs(cfg.libraryDbPath), cfg.etvDbPath);
    if (!dbPath) return { yaml, items: [], labels: {}, warning: "No database configured — YAML only." };
    try {
      const resolver = getResolver(dbPath);
      resolver.setDisabledLibraries(store.disabledLibraryIds());
      resolver.setExcludeSpecials(!cfg.includeSpecials);
      const off = cfg.tz;
      const start = floorLocalMidnight(Date.now(), off);
      const hours = Math.min(Math.max(Number(b.hours) || 4, 1), 12);
      const eng = new SchedulingEngine(loadPlayout(yaml), resolver, {
        startMs: start, finishMs: start + hours * 3_600_000, tz: off, seed: 1234,
      });
      const items = await eng.build();
      return { yaml, entryKey, items, labels: eng.getLabels() };
    } catch (e) { return { yaml, items: [], labels: {}, error: `build failed: ${(e as Error).message}` }; }
  });
}

async function runBuild(jobId: string, channels: string[], cfg: any, days: number, tz: Tz, store: ConfigStore, clean = false) {
  const job = getJob(jobId)!;
  job.status = "running";
  // Day-align: start at the local midnight on/before now (so "now" is covered
  // without a gap), build to the local midnight on/after now+days.
  const now = Date.now();
  const startMs = floorLocalMidnight(now, tz);
  const finishMs = ceilLocalMidnight(now + days * 86_400_000, tz);
  const dbPath = effectiveDbPath(abs(cfg.libraryDbPath), cfg.etvDbPath);
  const chDir = abs(cfg.channelsDir);
  const xmltvDir = abs(join(store.getNextConfig().runtimeDir, "xmltv"));

  // --- Main-thread prep (fast): resolve paths, refresh pod snapshots, force-clean
  // old windows, open build records. The heavy build itself runs in a worker so
  // the server keeps serving Browse/other tabs while it churns.
  const specs: BuildWorkerChannel[] = [];
  const recByName = new Map<string, number>();
  for (const name of channels) {
    const rec = store.startBuild(name);
    recByName.set(name, rec);
    if (!dbPath) { store.finishBuild(rec, "error", null, null, "No ErsatzTV database configured"); job.results.push({ channel: name, error: "No ErsatzTV database configured" }); continue; }
    const ch = await channelFile(chDir, name);
    if (!ch) { store.finishBuild(rec, "error", null, null, "channel config not found"); job.results.push({ channel: name, error: "channel config not found" }); continue; }
    await refreshPodsChannelFile(ch.path, store.listPods()); // keep pod snapshot fresh
    // Force rebuild: wipe every existing playout window for this channel so the
    // whole coverage window is regenerated (a normal build only replaces the
    // windows it overlaps; a scheduler top-up only appends new future windows).
    if (clean) {
      const outDir = join(playoutBaseDir(store, ROOT), name);
      try {
        for (const fn of await readdir(outDir)) if (fn.endsWith(".json")) await unlink(join(outDir, fn)).catch(() => {});
        job.log.push(`  ${name}: cleared old windows (force rebuild)`);
      } catch { /* no existing playout dir */ }
    }
    const cm = store.channelMeta(name);
    const shiftOf = await timeshiftSource(ch.path);
    specs.push({
      name, configPath: ch.path, outputDir: join(playoutBaseDir(store, ROOT), name),
      sourceXmltv: shiftOf ? join(xmltvDir, `${store.channelMeta(shiftOf)?.tvgId || shiftOf}.xml`) : undefined,
      xmltvDir, tvgId: cm?.tvgId || name, seed: hashName(name), progress: store.getProgress(name),
      audioLang: cm?.audioLang || undefined, subtitles: cm?.subtitles || undefined,
      upNext: await upNextOptionsFor(store, name, ROOT),
      overlays: overlayOptionsFor(store, name, ROOT),
      startMs, finishMs,
    });
    job.log.push(`building ${name}...`);
  }

  // time-shift channels copy another channel's playout, so build them after the rest
  specs.sort((a, b) => Number(!!a.sourceXmltv) - Number(!!b.sourceXmltv));

  if (specs.length) {
    // --- Heavy work off the main event loop, on a persistent worker that keeps
    // the search index warm across builds (see build-worker.ts / build-service.ts).
    await buildService.run(
      { libDbPath: dbPath!, disabledLibs: store.disabledLibraryIds(), excludeSpecials: !cfg.includeSpecials, tz, xmltvMode: "write", now, channels: specs,
        artBase: schedulerBaseUrl(store.getNextConfig().publicUrl, Number(process.env.PORT ?? 8730)) },
      (m: any) => {
        if (m.type === "log") { job.log.push(`  ${m.msg}`); appLog("build", String(m.msg)); return; }
        if (m.type === "result") {
          store.saveProgress(m.name, m.progress); // resume episode order on next build
          if (m.xmltvWarn) job.log.push(`  ${m.name}: xmltv warning ${m.xmltvWarn}`);
          if (m.overlayWarn) job.log.push(`  ${m.name}: overlays: ${m.overlayWarn}`);
          job.results.push({ channel: m.name, itemCount: m.itemCount, file: m.file });
          job.log.push(`  ${m.name}: ${m.itemCount} items, ${m.guideCount} guide entries`);
          const rec = recByName.get(m.name); if (rec != null) store.finishBuild(rec, "done", m.itemCount, m.file, null);
        } else if (m.type === "error") {
          job.results.push({ channel: m.name, error: m.msg });
          job.log.push(`  ${m.name}: ERROR ${m.msg}`);
          const rec = recByName.get(m.name); if (rec != null) store.finishBuild(rec, "error", null, null, m.msg);
        }
      },
    );
    // fail any channel that never reported (e.g. a worker crash mid-job)
    for (const s of specs) { const rec = recByName.get(s.name); if (rec != null && !job.results.some((r) => r.channel === s.name)) { store.finishBuild(rec, "error", null, null, "build did not complete"); job.results.push({ channel: s.name, error: "build did not complete" }); } }
  }

  // TV-guide scroller channel: write its (script-source) playout for the window.
  const gLog = join(abs(store.getNextConfig().runtimeDir), "guide.log");
  try {
    const gf = await writeGuidePlayout(store, ROOT, startMs, finishMs, tz);
    if (gf) { job.log.push(`  guide: wrote scroller playout ${gf}`); void logLine(gLog, `[build] guide playout written (${new Date().toLocaleString()})`); }
  } catch (e) { job.log.push(`  guide: ERROR ${(e as Error).message}`); void logLine(gLog, `[build] guide playout ERROR: ${(e as Error).message}`); }

  job.status = "done";
  job.finishedAt = Date.now();
}

function hashName(s: string): number { let h = 0; for (const c of s) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0; return Math.abs(h); }
