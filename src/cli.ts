// -----------------------------------------------------------------------------
// CLI: generate ErsatzTV "next" playouts (+ XMLTV) for channels.
// -----------------------------------------------------------------------------
// Two modes:
//
//  1) App-DB mode (the web UI is the single source of truth):
//       node dist/cli.js --app-db data/app.sqlite
//     Reads streaming settings + channel registry + days/offset from the app
//     config DB, (re)writes runtime/lineup.json + runtime/channels/*.config.json
//     (same as the UI's "Apply"), then builds every ENABLED channel. Prints the
//     server port from the generated lineup so a launcher can honor it.
//
//  2) Flag mode (standalone / cron):
//       node dist/cli.js --db ersatztv.sqlite3 --channels ./channels \
//         --out ./playouts --xmltv ./xmltv --days 3 --tz America/Chicago

import { readdir, readFile, mkdtemp, writeFile, copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { join, basename, extname, isAbsolute } from "node:path";
import { buildChannel } from "./index.js";
import { SqliteResolver } from "./sqlite-resolver.js";
import { writeChannelXmltv, artRefFromUrl } from "./xmltv.js";
import { parseArtRef, artImageUrl } from "./art-ref.js";
import { floorLocalMidnight, ceilLocalMidnight, machineTz, type Tz } from "./time.js";
import { ConfigStore } from "./server/config.js";
import { generateNext, seedNextConfig } from "./server/nextgen.js";
import { importLibrary, effectiveDbPath } from "./server/library-import.js";
import { scanLocalLibrary } from "./server/scanner-local.js";
import { scanRemoteSource } from "./server/scanner-remote.js";
import { runDeepScan } from "./server/deep-scan.js";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const abs = (root: string, p: string) => (isAbsolute(p) || /^[A-Za-z]:/.test(p) ? p : join(root, p));
function hashName(s: string): number { let h = 0; for (const c of s) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0; return Math.abs(h); }

interface ChannelSpec { name: string; yamlPath: string; }

async function findYamls(dir: string): Promise<ChannelSpec[]> {
  const { listChannelFiles } = await import("./scheduling/registry.js");
  return (await listChannelFiles(dir)).map((c) => ({ name: c.name, yamlPath: c.path }));
}

async function buildAll(resolver: SqliteResolver, specs: ChannelSpec[], o: {
  startMs: number; finishMs: number; tz: Tz; days: number; outBase: string; xmltvDir?: string; store?: ConfigStore;
}) {
  console.log(`Building ${specs.length} channel(s) for ${o.days} day(s)...`);
  for (const s of specs) {
    try {
      const res = await buildChannel({
        configPath: s.yamlPath, resolver, outputDir: join(o.outBase, s.name),
        options: { startMs: o.startMs, finishMs: o.finishMs, tz: o.tz, seed: hashName(s.name), progress: o.store?.getProgress(s.name) },
      });
      o.store?.saveProgress(s.name, res.progress); // resume episode order next build
      let note = "";
      if (o.xmltvDir) { const gx = await writeChannelXmltv(o.xmltvDir, s.name, res.guide, o.tz, resolver); note = ` + ${res.guide.length} programmes -> ${gx}`; }
      console.log(`  ${s.name}: ${res.itemCount} items -> ${res.file}${note}`);
    } catch (e) { console.error(`  ${s.name}: FAILED - ${(e as Error).message}`); }
  }
}

async function main() {
  const root = process.cwd();

  // one-time library import:  node dist/cli.js import-library [--from ...] [--to ...]
  if (process.argv[2] === "import-library") {
    {
      const off = process.argv.includes("--force") ? false : !new ConfigStore(process.env.APP_DB ?? arg("app-db", "data/app.sqlite")!).get().legacyImport;
      if (off) { console.error("ErsatzTV legacy import is turned off (Connect tab). Pass --force to run it anyway."); process.exit(2); }
    }
    const from = arg("from", "data/ersatztv.sqlite3")!;
    const to = arg("to", "data/library.sqlite")!;
    console.log(`Importing library ${from} -> ${to} ...`);
    const res = importLibrary(from, to, (p) => console.log(`IMPORT ${p.index}/${p.total} ${p.table} (${p.rows})`));
    console.log(`DONE: ${res.tables} tables, ${res.rows} rows in ${(res.ms / 1000).toFixed(1)}s -> ${res.dest}`);
    return;
  }

  // local folder scan:  node dist/cli.js scan-library --library <id> [--app-db ...] [--db ...] [--ffprobe ...]
  if (process.argv[2] === "scan-library") {
    const libId = Number(arg("library"));
    if (!Number.isFinite(libId)) { console.error("scan-library requires --library <id>"); process.exit(2); }
    let dbPath = arg("db");
    let ffprobePath = arg("ffprobe");
    if (!dbPath || !ffprobePath) {
      // fall back to the app config DB for anything not passed explicitly
      const store = new ConfigStore(process.env.APP_DB ?? arg("app-db", "data/app.sqlite")!);
      const cfg = store.get();
      dbPath = dbPath || effectiveDbPath(cfg.libraryDbPath, cfg.etvDbPath || "");
      ffprobePath = ffprobePath || store.getNextConfig().ffprobePath || "ffprobe";
    }
    if (!dbPath) { console.error("No library DB (import a library first, or pass --db)."); process.exit(2); }
    console.log(`Scanning local library ${libId} in ${dbPath} ...`);
    const res = scanLocalLibrary(dbPath, libId, {
      ffprobePath,
      onEvent: (e) => {
        if (e.phase === "walked") console.log(`WALKED ${e.found}`);
        if (e.phase === "scanning") console.log(`SCAN ${e.done}/${e.total} +${e.added} ~${e.updated} ${e.current ?? ""}`);
      },
    });
    console.log(`DONE: found ${res.found}, added ${res.added}, updated ${res.updated}, unchanged ${res.unchanged}, missing ${res.missing}, errors ${res.errors} in ${(res.ms / 1000).toFixed(1)}s`);
    return;
  }

  // import ErsatzTV legacy channels + Classic schedules as Schedule (blocks) channels.
  //   node dist/cli.js import-channels [--legacy-db p] [--also-db older.sqlite3] [--channels dir] [--only 3,12.5,Name] [--apply] [--overwrite] [--use-suggested-numbers]
  // Without --apply it only prints the plan (nothing is written).
  if (process.argv[2] === "import-channels") {
    const { planLegacyImportMulti, applyLegacyImport, normalizeChannelNumber } = await import("./server/legacy-channels.js");
    const { listChannelFiles } = await import("./scheduling/registry.js");
    const store = new ConfigStore(process.env.APP_DB ?? arg("app-db", "data/app.sqlite")!);
    const cfg = store.get();
    if (!cfg.legacyImport && !process.argv.includes("--force")) { console.error("ErsatzTV legacy import is turned off (Connect tab). Pass --force to run it anyway."); process.exit(2); }
    const legacy = arg("legacy-db") || cfg.etvDbPath;
    if (!legacy || !existsSync(legacy)) { console.error(`Legacy DB not found: ${legacy || "(not configured)"} — pass --legacy-db`); process.exit(2); }
    const channelsDir = arg("channels") || cfg.channelsDir;
    const existing = new Set((await listChannelFiles(channelsDir)).map((c) => c.name));
    // --also-db: older legacy copies to recover schedules the live DB lost (repeatable, comma-separated)
    const also = (arg("also-db") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const existingNumbers = new Map<string, string>();
    for (const m of store.channelMetas()) if (existing.has(m.name) && m.number && !existingNumbers.has(normalizeChannelNumber(m.number))) existingNumbers.set(normalizeChannelNumber(m.number), m.name);
    const plans = planLegacyImportMulti([legacy, ...also], { channelsDir, existing, existingNumbers, libraryDbPath: cfg.libraryDbPath });
    const only = arg("only") ? new Set(arg("only")!.split(",").map((s) => s.trim())) : null;
    const chosen = plans.filter((p) => !only || only.has(p.number) || only.has(p.name)); // channel numbers or names
    for (const p of chosen) {
      console.log(`${p.status.toUpperCase().padEnd(11)} #${p.number} ${p.name} [${p.kind}]${p.schedule ? ` ← ${p.schedule}` : ""}${p.file ? ` -> ${p.file}` : ""}`);
      for (const w of p.warnings) console.log(`             ! ${w}`);
      if (process.argv.includes("--verbose") && p.config) console.log(p.config.replace(/^/gm, "             "));
    }
    const counts = chosen.reduce((a, p) => ((a[p.status] = (a[p.status] ?? 0) + 1), a), {} as Record<string, number>);
    console.log(`PLAN: ${chosen.length} channels — ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
    if (!process.argv.includes("--apply")) { console.log("(dry run — pass --apply to write)"); return; }
    // --use-suggested-numbers: import channels whose number is taken under the suggested free number
    const numbers = process.argv.includes("--use-suggested-numbers") ? Object.fromEntries(chosen.filter((p) => p.suggestedNumber).map((p) => [p.key, p.suggestedNumber!])) : undefined;
    const res = await applyLegacyImport(plans, chosen.map((p) => p.key), channelsDir, store, { overwrite: process.argv.includes("--overwrite"), numbers, existingNumbers });
    for (const i of res.imported) console.log(`IMPORTED ${i.name} -> ${i.file}`);
    for (const s of res.skipped) console.log(`SKIPPED  ${s.name}: ${s.reason}`);
    console.log(`DONE: imported ${res.imported.length}, skipped ${res.skipped.length}`);
    return;
  }

  // remote scan (Plex/Jellyfin/Emby):  node dist/cli.js scan-remote --source <id> [--token ...] [--db ...]
  if (process.argv[2] === "scan-remote") {
    const sourceId = Number(arg("source"));
    if (!Number.isFinite(sourceId)) { console.error("scan-remote requires --source <id>"); process.exit(2); }
    let dbPath = arg("db");
    let token = arg("token");
    // address is an OPTIONAL override — its absence must NOT force us to open the
    // app config DB (the server already holds it open; a second writable handle can
    // lock/fail and kill the scan before it starts). Only open the store when we
    // actually need db path or token.
    let address = arg("address");
    if (!dbPath || token === undefined) {
      const store = new ConfigStore(process.env.APP_DB ?? arg("app-db", "data/app.sqlite")!);
      const cfg = store.get();
      dbPath = dbPath || effectiveDbPath(cfg.libraryDbPath, cfg.etvDbPath || "");
      const secret = store.getSourceSecret(sourceId);
      if (token === undefined) token = secret.token;
      if (address === undefined) address = secret.address ?? undefined;
    }
    if (!dbPath) { console.error("No library DB (import a library first, or pass --db)."); process.exit(2); }
    const onlyLib = arg("library");
    console.log(`Scanning remote source ${sourceId}${onlyLib ? ` (library ${onlyLib})` : ""} ...`);
    const { libraries, errors } = await scanRemoteSource(dbPath, sourceId, token || "", {
      address: address ?? null,
      libraryId: onlyLib != null ? Number(onlyLib) : undefined,
      refreshMetadata: process.argv.includes("--refresh-metadata"),
      onEvent: (e) => {
        if (e.phase === "probing") console.log(`PROBE ${e.library}`);
        if (e.phase === "show-detailing" && e.fetched != null) console.log(`SHOWS ${e.library} ${e.fetched}/${e.total ?? "?"}`);
        if (e.phase === "networks" && e.fetched != null) console.log(`NETWORKS ${e.library} ${e.fetched}/${e.total ?? "?"}`);
        if (e.phase === "backfill") console.log(`BACKFILL ${e.library} ${e.fetched}/${e.total}`);
        if (e.phase === "networks-error") console.log(`WARN ${e.library}: network scan failed, networks left unchanged: ${e.error}`);
        if (e.phase === "shows-done") console.log(`SHOWS ${e.library}: ${e.found} shows, +${e.added} ~${e.updated}`);
        if (e.phase === "connected") console.log(`CONNECTED ${e.library}`);
        if (e.phase === "fetching" && e.fetched != null) console.log(`FETCHING ${e.library} ${e.fetched}/${e.total ?? "?"}`);
        else if (e.phase === "fetching") console.log(`FETCH ${e.library}`);
        if (e.phase === "detailing" && e.fetched != null) console.log(`DETAILING ${e.library} ${e.fetched}/${e.total ?? "?"}`);
        if (e.phase === "library-done") { console.log(`LIB ${e.library}: +${e.added} ~${e.updated} missing:${e.missing} (fetched ${e.found} of ${e.existing} in library)`); if (e.artwork) console.log(`ARTWORK ${e.library} ${e.artwork}`); if (e.missingSkipped) console.log(`WARN ${e.library}: only fetched ${e.found} of ${e.existing} items — server returned an incomplete list, so nothing was flagged missing`); }
        if (e.phase === "library-error") console.log(`LIBERR ${e.library}: ${e.error}`);
      },
    });
    const tot = libraries.reduce((a, s) => ({ found: a.found + s.found, added: a.added + s.added, updated: a.updated + s.updated, missing: a.missing + s.missing }), { found: 0, added: 0, updated: 0, missing: 0 });
    console.log(`DONE: ${libraries.length} libraries, found ${tot.found}, added ${tot.added}, updated ${tot.updated}, missing ${tot.missing}${errors.length ? `, ${errors.length} errors` : ""}`);
    if (errors.length) for (const e of errors) console.error("  ERR " + e);
    return;
  }

  // targeted deep scan:  node dist/cli.js deep-scan --type show --id 5
  if (process.argv[2] === "deep-scan") {
    const type = arg("type"); const id = Number(arg("id"));
    if (!type || !Number.isFinite(id)) { console.error("deep-scan requires --type <t> --id <n>"); process.exit(2); }
    const store = new ConfigStore(process.env.APP_DB ?? arg("app-db", "data/app.sqlite")!);
    const cfg = store.get();
    const dbPath = arg("db") || effectiveDbPath(cfg.libraryDbPath, cfg.etvDbPath || "");
    if (!dbPath) { console.error("No library DB."); process.exit(2); }
    const ffprobePath = arg("ffprobe") || store.getNextConfig().ffprobePath || "ffprobe";
    console.log(`Deep-scanning ${type} ${id} ...`);
    const res = await runDeepScan(dbPath, type!, id, {
      ffprobePath,
      secretFor: (sid) => store.getSourceSecret(sid),
      onEvent: (e) => { if (e.phase === "scanning") console.log(`DEEP ${e.done}/${e.total} ${e.current ?? ""}`); },
    });
    console.log(`DONE: targets ${res.targets}, refreshed ${res.refreshed}, failed ${res.failed}, chapters ${res.chapters}`);
    return;
  }

  // guide poster diagnostic:  node dist/cli.js guide-artcheck [--app-db data/app.sqlite]
  // Samples library items and prints how each one's guide poster resolves, so we
  // can see whether art:// source refs are being produced (and for which source).
  if (process.argv[2] === "guide-artcheck") {
    const store = new ConfigStore(process.env.APP_DB ?? arg("app-db", "data/app.sqlite")!);
    const cfg = store.get();
    const dbPath = arg("db") || effectiveDbPath(cfg.libraryDbPath, cfg.etvDbPath || "");
    if (!dbPath) { console.error("No library DB (pass --db or --app-db)."); process.exit(2); }
    console.log(`Library DB: ${dbPath}`);
    const resolver = new SqliteResolver({ dbPath });
    const rows = resolver.artDiag(8);
    if (!rows.length) console.log("No movies/episodes found to sample.");
    for (const r of rows) console.log(`${r.kind.padEnd(7)} #${String(r.id).padEnd(6)} [${r.sourceType.padEnd(8)}] -> ${r.icon}`);
    const plexJf = rows.filter((r) => r.sourceType === "plex" || r.sourceType === "jellyfin" || r.sourceType === "emby");
    const withRef = rows.filter((r) => r.icon.startsWith("art://") || /^https?:/.test(r.icon));
    console.log(`\nSummary: ${withRef.length}/${rows.length} resolved a poster; ${plexJf.length} were Plex/Jellyfin/Emby items.`);
    if (plexJf.length && !withRef.length) console.log("Plex/Jellyfin items present but no refs — the provider-key lookup is failing; send me this output.");
    if (!plexJf.length) console.log("These sampled items are local (or unknown) — local media has no source poster API.");
    return;
  }

  // guide scroller stream:  node dist/cli.js guide-stream [--app-db data/app.sqlite]
  // Renders the current TV-guide grid and streams a vertical scroll (fixed header
  // + live clock + random background music) as MPEG-TS on stdout, for next's
  // `script` playout source. Runs until next closes the pipe.
  if (process.argv[2] === "guide-stream") {
    // Read a self-contained snapshot (written by writeGuidePlayout) so this
    // spawned process never opens app.sqlite (which the server holds open).
    const cfgPath = arg("config", join(root, "runtime", "guide-config.json"))!;
    const guideMod = await import("./guide.js");
    const { readGuideRows, readAllProgrammes, pickFeatured, renderGridSvg, renderHeaderSvg,
      renderFeaturedStripSvg, guideGridHeight, guideFeaturedBandHeight, guidePromoBox,
      loadGuideTheme, DEFAULT_GUIDE_LAYOUT, DEFAULT_GUIDE_THEMES,
      guidePromoHeight, guideTimeBarHeight } = guideMod;
    const gc = JSON.parse(await readFile(cfgPath, "utf8")) as {
      channels: { number: string; name: string; tvgId: string }[];
      xmltvDir: string; tz: Tz; width: number; height: number; fps?: string;
      columns: number; scrollSpeed: number; ffmpegPath?: string; ffprobePath?: string; fontFile?: string; musicFolder?: string;
      promoRotateSec?: number; promoFolder?: string;
      sources?: Record<string, { address: string; token: string }>;
      themeId?: string; guideThemesDir?: string; logFile?: string;
      theme?: typeof DEFAULT_GUIDE_THEMES.classic;
    };
    // Mirror diagnostics to stderr AND the runtime log file (the web "Logs" tab
    // reads it), since next swallows this process's stderr.
    const { logLine } = await import("./server/runtime-log.js");
    const diag = (msg: string) => { console.error(msg); void logLine(gc.logFile || "", msg); };
    const W = gc.width, H = gc.height, FPS = String(gc.fps || "24");
    // Reload the theme file live so edits to <themeId>.json (fonts, colors) apply
    // on the next stream without a full guide rebuild; fall back to the snapshot.
    let theme = gc.theme ?? DEFAULT_GUIDE_THEMES.classic;
    let themeSrc = "snapshot (re-Apply the guide to enable live theme reload)";
    if (gc.guideThemesDir && gc.themeId) {
      try { theme = await loadGuideTheme(gc.guideThemesDir, gc.themeId); themeSrc = `${gc.themeId}.json`; } catch { /* keep snapshot */ }
    }
    diag(`[guide] theme from ${themeSrc}; theme.fontFile=${JSON.stringify(theme.fontFile ?? "")}`);
    const now = Date.now();

    const layout = { ...DEFAULT_GUIDE_LAYOUT, width: W, height: H, columns: Math.max(1, gc.columns || 3) };
    const { rows, colTimes, windowStart, windowEnd } =
      await readGuideRows(gc.xmltvDir, gc.channels, now, layout.columns, layout.slotMinutes, gc.tz);
    const gridSvg = renderGridSvg(rows, layout, theme, windowStart, windowEnd, gc.tz);
    const headerSvg = renderHeaderSvg(colTimes, layout, gc.tz, theme);

    // rotating "featured" panel: pick random programmes from every enabled channel
    const rotateSec = Math.max(5, gc.promoRotateSec || 30);
    const allProgs = await readAllProgrammes(gc.xmltvDir, gc.channels, gc.tz);
    const picks = pickFeatured(allProgs, 6, now, gc.tz);
    // Resolve each featured programme's artwork to a data: URL for the logo box.
    // Handles http(s) urls (media server) and local files; failures fall back to
    // the placeholder, so a bad/missing poster never breaks the stream.
    const mimeFor = (p: string) =>
      /\.png$/i.test(p) ? "image/png" : /\.webp$/i.test(p) ? "image/webp" :
      /\.gif$/i.test(p) ? "image/gif" : "image/jpeg";
    // Turn an art://{sourceId}/{type}/{base64url(key)} ref into a live source image
    // URL using the scheduler's stored token+address (kept only in this snapshot).
    const resolveArtRef = (ref: string): string | undefined => {
      const r = parseArtRef(ref);
      const src = r ? gc.sources?.[r.sourceId] : undefined;
      if (!r || !src?.address || !src.token) return undefined;
      return artImageUrl(r, src.address, src.token) ?? undefined;
    };
    const loadIcon = async (ref?: string): Promise<string | undefined> => {
      if (!ref) return undefined;
      if (ref.startsWith("data:")) return ref;
      // the published guide points posters at the scheduler's /art/… (for TV apps);
      // fetch those straight from the media server instead of looping through it
      ref = artRefFromUrl(ref) ?? ref;
      const url = ref.startsWith("art://") ? resolveArtRef(ref) : ref;
      if (!url) return undefined;
      try {
        if (/^https?:\/\//i.test(url)) {
          const res = await fetch(url);
          if (!res.ok) return undefined;
          const mime = res.headers.get("content-type")?.split(";")[0] || mimeFor(url);
          const buf = Buffer.from(await res.arrayBuffer());
          return `data:${mime};base64,${buf.toString("base64")}`;
        }
        const clean = url.replace(/^file:\/\//i, "");
        if (!existsSync(clean)) return undefined;
        return `data:${mimeFor(clean)};base64,${(await readFile(clean)).toString("base64")}`;
      } catch { return undefined; }
    };
    await Promise.all(picks.map(async (p) => { p.iconData = await loadIcon(p.iconPath); }));
    // Diagnostics (stderr): how poster resolution went, so a blank LOGO box is
    // debuggable. Shows refs present, refs resolved, and a sample (token redacted).
    {
      const withRef = picks.filter((p) => p.iconPath).length;
      const resolved = picks.filter((p) => p.iconData).length;
      const sample = picks.find((p) => p.iconPath);
      const sampleRef = sample?.iconPath ? (artRefFromUrl(sample.iconPath) ?? sample.iconPath) : undefined;
      const sampleUrl = sampleRef?.startsWith("art://") ? resolveArtRef(sampleRef) : sampleRef;
      diag(`[guide] posters: ${resolved}/${picks.length} resolved, ${withRef} had a ref; ` +
        `sources=${Object.keys(gc.sources ?? {}).length}; ` +
        `sample=${sampleUrl ? sampleUrl.replace(/(X-Plex-Token|api_key)=[^&]+/i, "$1=***") : "(none)"}`);
    }
    const featSvg = renderFeaturedStripSvg(picks, layout, theme);
    const nPicks = Math.max(1, picks.length);

    // rasterize grid + header + featured strip to PNGs. If a theme font is set we
    // render with system fonts OFF so *all* SVG text uses that font (resvg falls
    // back to the single loaded face); otherwise use the built-in sans family.
    const Resvg = (await import("@resvg/resvg-js")).Resvg;
    const font = (theme.fontFile || gc.fontFile || "").trim();
    if (font && !existsSync(font)) diag(`[guide] theme fontFile not found: "${font}" — falling back to a system font. Check the path in the theme JSON.`);
    else if (font) diag(`[guide] using theme font: ${font}`);
    const fontOpt = font && existsSync(font)
      ? { loadSystemFonts: false, fontFiles: [font] }
      : { loadSystemFonts: true };
    const png = (svg: string) => Buffer.from(new Resvg(svg, { font: fontOpt }).render().asPng());
    const tmp = await mkdtemp(join(tmpdir(), "etv-guide-"));
    await writeFile(join(tmp, "grid.png"), png(gridSvg));
    await writeFile(join(tmp, "header.png"), png(headerSvg));
    await writeFile(join(tmp, "feat.png"), png(featSvg));
    if (font && existsSync(font)) { try { await copyFile(font, join(tmp, "font.ttf")); } catch { /* fall back to system font */ } }
    const hasFont = existsSync(join(tmp, "font.ttf"));

    const GH = guideGridHeight(rows, theme, windowStart);
    const promoH = guidePromoHeight(theme, H);
    const tbH = guideTimeBarHeight(theme);
    const HH = promoH + tbH;
    const bandH = guideFeaturedBandHeight(theme, H);
    const SPEED = Math.max(1, gc.scrollSpeed || 60);

    // Scroll performance: pre-stack the grid vertically ONCE here so the live
    // ffmpeg can decode it a single time (loop filter) and `crop` just the visible
    // window each frame — cost is flat in channel count. The old split + two-overlay
    // + `-loop 1` scroll re-decoded/re-composited the whole tall grid every frame,
    // so CPU grew linearly with the number of channels.
    const gridVis = H - HH;
    const scroll = GH > gridVis;
    if (scroll) {
      const ff = gc.ffmpegPath || "ffmpeg";
      const r = spawnSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", "grid.png", "-i", "grid.png", "-filter_complex", "vstack=inputs=2", "-frames:v", "1", "grid2.png"], { cwd: tmp });
      if (r.status !== 0) diag(`[guide] grid pre-stack failed (${r.status}); scroll will fall back heavier`);
    }

    // pick a random background track from the music folder (if any)
    let music = "";
    if (gc.musicFolder && existsSync(gc.musicFolder)) {
      try {
        const files = (await readdir(gc.musicFolder, { recursive: true })).filter((f) => /\.(mp3|m4a|aac|flac|wav|ogg|opus)$/i.test(String(f)));
        if (files.length) music = join(gc.musicFolder, String(files[Math.floor(Math.random() * files.length)]));
      } catch { /* no music */ }
    }

    // Build the promo/trailer playlist. Real trailers are heterogeneous (different
    // codecs, resolutions, frame rates), so we use the concat FILTER (each clip is
    // decoded independently and normalised to the box) rather than the concat
    // demuxer (which corrupts on codec changes). Shuffle all eligible clips, probe
    // a bounded sample, and keep those that have an audio track (uniform concat).
    const PROMO_MAX = 24;
    let promoFiles: string[] = [];
    if (gc.promoFolder && existsSync(gc.promoFolder)) {
      try {
        const probe = gc.ffprobePath || "ffprobe";
        // recursive: trailers are often organised in subfolders (e.g. by year)
        const all = (await readdir(gc.promoFolder, { recursive: true }))
          .filter((f) => /\.(mp4|mkv|mov|m4v|webm|avi|ts|wmv|flv|mpg|mpeg)$/i.test(f))
          .map((f) => join(gc.promoFolder!, f));
        for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
        for (const full of all.slice(0, 40)) {
          if (promoFiles.length >= PROMO_MAX) break;
          try {
            const r = spawnSync(probe, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", full], { encoding: "utf8" });
            if ((r.stdout || "").trim()) promoFiles.push(full);
          } catch { /* skip unreadable clip */ }
        }
        // few clips? repeat the shuffled sequence so the window doesn't idle quickly
        if (promoFiles.length && promoFiles.length < 6) {
          const base = [...promoFiles]; let i = 0;
          while (promoFiles.length < 6) promoFiles.push(base[i++ % base.length]);
        }
      } catch { promoFiles = []; }
    }
    const promo = promoFiles.length > 0;
    const promoBase = 5;            // ffmpeg input index of the first promo clip
    const nPromo = promoFiles.length;
    if (gc.promoFolder) diag(`[guide] promo folder: ${existsSync(gc.promoFolder) ? "found" : "MISSING"}; ${nPromo} playable clip(s) with audio selected${music ? `; music: ${music}` : ""}`);
    const pbox = guidePromoBox(layout, theme);

    // featured strip steps up one band every `rotateSec` (wraps over nPicks*rotateSec)
    const period = nPicks * rotateSec;
    const featY = `-${bandH}*floor(mod(t\\, ${period})/${rotateSec})`;
    // Decode each PNG once (loop filter) and crop the visible grid window from the
    // pre-doubled grid — O(frame) per frame, independent of channel count.
    const chains = [
      `[1:v]loop=loop=-1:size=1:start=0,fps=${FPS}[g]`,
      `[2:v]loop=loop=-1:size=1:start=0,fps=${FPS}[hdr]`,
      `[3:v]loop=loop=-1:size=1:start=0,fps=${FPS}[ft]`,
    ];
    if (scroll) chains.push(`[g]crop=${W}:${gridVis}:0:'mod(t*${SPEED}\\, ${GH})'[gw]`);
    else chains.push(`[g]null[gw]`);               // grid shorter than window — static
    chains.push(`[0:v][gw]overlay=x=0:y=${HH}[o1]`);
    chains.push(`[o1][hdr]overlay=x=0:y=0[o2]`);    // fixed header chrome
    chains.push(`[o2][ft]overlay=x=0:y='${featY}'[o3]`); // rotating featured panel
    // promo/trailer window: normalise each clip to the box, then concat them into
    // one video+audio pair (concat filter handles the mixed codecs/resolutions).
    let last = "o3";
    if (promo) {
      const segs: string[] = [];
      for (let i = 0; i < nPromo; i++) {
        const idx = promoBase + i;
        chains.push(`[${idx}:v]scale=${pbox.w}:${pbox.h}:force_original_aspect_ratio=increase,crop=${pbox.w}:${pbox.h},setsar=1,fps=30,format=yuv420p[pv${i}]`);
        chains.push(`[${idx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[pa${i}]`);
        segs.push(`[pv${i}][pa${i}]`);
      }
      chains.push(`${segs.join("")}concat=n=${nPromo}:v=1:a=1[promovideo][promoaudio]`);
      chains.push(`[${last}][promovideo]overlay=x=${pbox.x}:y=${pbox.y}[o5]`);
      last = "o5";
    }
    const clockFont = hasFont ? "fontfile=font.ttf:" : "";
    const hex = (c: string) => (c || "#FFFFFF").replace(/^#/, "0x");
    // Live ticking time in the time-bar's first cell. drawtext's y is the TOP of
    // the text (unlike SVG's baseline), so center it in the bar with the real text
    // height (th) rather than guessing — robust across fonts.
    const clockFS = Math.round(tbH * 0.5);
    const clockY = `${promoH}+(${tbH}-th)/2`;
    // Compose the clock from single-directive localtime calls with literal colons
    // between them: avoids the drawtext "colon-inside-format" parser bug and uses
    // only Windows-safe strftime directives (%I %M %S %p) — %r/%T aren't portable.
    const t12 = `%{localtime\\:%I}\\:%{localtime\\:%M}\\:%{localtime\\:%S} %{localtime\\:%p}`;
    const clock = `[${last}]drawtext=${clockFont}text='${t12}':fontcolor=${hex(theme.clockColor)}:fontsize=${clockFS}:x=24:y=${clockY}[v]`;
    chains.push(clock);

    // Audio: input 4 is the music bed (or silence). When a trailer is playing its
    // audio is the foreground and the music is ducked under it; after the playlist
    // ends the bed continues (amix duration=longest over the looping input 4).
    let audioMap = "4:a";
    if (promo) {
      chains.push(`[4:a]volume=${music ? 0.4 : 0},aresample=48000[bed]`);
      chains.push(`[promoaudio]volume=1.6[pa]`);
      chains.push(`[bed][pa]amix=inputs=2:duration=longest:dropout_transition=0[aout]`);
      audioMap = "[aout]";
    }

    const promoInputs: string[] = [];
    for (const f of promoFiles) promoInputs.push("-i", f);
    const args = [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-re", "-f", "lavfi", "-i", `color=c=${(theme.bg || "#000000").replace(/^#/, "0x")}:s=${W}x${H}:r=${FPS}`,
      // single-frame reads; the loop filter repeats the decoded frame (decode once).
      // grid2.png is the pre-doubled grid used for seamless crop-scrolling.
      "-i", scroll ? "grid2.png" : "grid.png",
      "-i", "header.png",
      "-i", "feat.png",
      ...(music ? ["-stream_loop", "-1", "-i", music] : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]),
      // promo clips are inputs 5..N (each normalised + concatenated in the filtergraph)
      ...promoInputs,
      "-filter_complex", chains.join(";"),
      "-map", "[v]", "-map", audioMap,
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-g", "48",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-f", "mpegts", "pipe:1",
    ];
    const ffmpeg = gc.ffmpegPath || "ffmpeg";
    diag(`[guide] streaming ${gc.channels.length} channel(s) @ ${W}x${H} — grid ${rows.length} rows, ${nPicks} featured, ${nPromo} promo clip(s)`);
    const child = spawn(ffmpeg, args, { cwd: tmp, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(process.stdout);
    // ffmpeg runs at -loglevel error, so anything on its stderr is a real problem:
    // surface it to our stderr AND the runtime log (the web "Logs" tab).
    child.stderr.on("data", (b: Buffer) => {
      const s = b.toString().trim();
      if (s) { process.stderr.write(`${s}\n`); void logLine(gc.logFile || "", `[ffmpeg] ${s.replace(/\s+/g, " ").slice(0, 500)}`); }
    });
    const done = (code: number) => { rm(tmp, { recursive: true, force: true }).catch(() => {}); process.exit(code); };
    child.on("exit", (c) => done(c ?? 0));
    child.on("error", (e) => { diag(`[guide] ffmpeg failed to start: ${e.message}`); done(1); });
    process.on("SIGTERM", () => child.kill("SIGKILL"));
    process.on("SIGINT", () => child.kill("SIGKILL"));
    process.stdout.on("error", () => child.kill("SIGKILL")); // next closed the pipe
    return;
  }

  const appDb = arg("app-db");

  if (appDb) {
    // --- app-DB mode: everything from the web UI's settings ---
    const store = new ConfigStore(appDb);
    const cfg = store.get();
    const channelsDir = abs(root, cfg.channelsDir);

    // auto-register any channel YAML that isn't in the registry yet (enabled by default)
    let specs = await findYamls(channelsDir).catch(() => []);
    for (const s of specs) store.ensureChannelMeta(s.name);

    await seedNextConfig(store, root);
    const apply = await generateNext(store, root);       // writes lineup.json + configs from UI settings
    const nc = store.getNextConfig();
    console.log(`Applied UI settings -> ${apply.lineup} (${apply.channels.length} enabled channel(s), port ${nc.port})`);

    // use the imported library.sqlite once it exists, else the legacy source DB
    const dbPath = effectiveDbPath(cfg.libraryDbPath, cfg.etvDbPath || arg("db") || "");
    if (!dbPath) { console.error("No media DB (set the ErsatzTV DB on Connect, or import a library)."); process.exit(2); }
    const resolver = new SqliteResolver({ dbPath });
    resolver.setDisabledLibraries(store.disabledLibraryIds());
    resolver.setExcludeSpecials(!cfg.includeSpecials);

    const runtimeDir = abs(root, nc.runtimeDir);
    const enabled = new Set(store.channelMetas().filter((m) => m.enabled).map((m) => m.name));
    specs = specs.filter((s) => enabled.has(s.name));

    const now = Date.now();
    await buildAll(resolver, specs, {
      startMs: floorLocalMidnight(now, cfg.tz),
      finishMs: ceilLocalMidnight(now + cfg.days * 86_400_000, cfg.tz),
      tz: cfg.tz, days: cfg.days,
      outBase: join(runtimeDir, "playouts"), xmltvDir: join(runtimeDir, "xmltv"), store,
    });
    resolver.close();
    // Emit the port on its own line so a launcher can capture it if desired.
    console.log(`ETV_PORT=${nc.port}`);
    return;
  }

  // --- flag mode ---
  const dbPath = arg("db");
  const channelsDir = arg("channels", "./channels")!;
  const outBase = arg("out", "./playouts")!;
  const days = Number(arg("days", "3"));
  // --tz America/Chicago (default: this machine's zone), or a fixed offset in minutes
  const tzArg = arg("tz", machineTz())!;
  const tz: Tz = /^[+-]?\d+$/.test(tzArg) ? Number(tzArg) : tzArg;
  const xmltvDir = arg("xmltv");
  if (!dbPath) { console.error("--db <ersatztv.sqlite3> is required (or use --app-db)"); process.exit(2); }

  const resolver = new SqliteResolver({ dbPath });
  const problems = resolver.verifySchema();
  if (problems.length) { console.warn("Schema check warnings:"); for (const p of problems) console.warn("  - " + p); }

  const now = Date.now();
  await buildAll(resolver, await findYamls(channelsDir), {
    startMs: floorLocalMidnight(now, tz),
    finishMs: ceilLocalMidnight(now + days * 86_400_000, tz),
    tz, days, outBase, xmltvDir,
  });
  resolver.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
