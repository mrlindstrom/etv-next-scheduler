// -----------------------------------------------------------------------------
// Persistent playout build worker (runs off the main HTTP thread).
// -----------------------------------------------------------------------------
// A full channel build does a lot of *synchronous* CPU + SQLite work: the
// resolver loads and indexes the whole library on first use (many seconds).
// Run inline on the server's single event loop, that starves every other
// request until the build finishes. So the heavy work happens here.
//
// This worker is LONG-LIVED: it keeps its SqliteResolver (the in-memory search
// index) warm across builds and rebuilds it only when the library changes
// (detected by a cheap fingerprint). So only the first build after startup — or
// the first after a scan — pays the ~15s load; every other build reuses it and
// is fast. Requests are queued and processed one at a time.

import type { OverlayBuildOptions } from "../overlays.js";
import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { buildChannel, writeShiftedXmltv } from "../index.js";
import type { UpNextOptions } from "../engine.js";
import { SqliteResolver } from "../sqlite-resolver.js";
import { writeChannelXmltv, mergeChannelXmltv } from "../xmltv.js";
import type { Tz } from "../time.js";

export interface BuildWorkerChannel {
  name: string;
  configPath: string;
  outputDir: string;
  xmltvDir: string;
  tvgId: string;
  seed: number;
  progress: Record<string, number>;
  audioLang?: string;
  subtitles?: string;
  upNext?: UpNextOptions;
  overlays?: OverlayBuildOptions;
  startMs: number;
  finishMs: number;
  sourceXmltv?: string;      // time-shift channels: the source channel's guide file
}

export interface BuildWorkerRequest {
  jobId: number;
  libDbPath: string;
  disabledLibs: number[];
  excludeSpecials: boolean;
  tz: Tz;
  xmltvMode: "write" | "merge";
  artBase?: string;
  now: number;
  channels: BuildWorkerChannel[];
}

const port = parentPort!;
let resolver: SqliteResolver | undefined;
let loadedDb = "";
let loadedFp = "";

/** Cheap fingerprint of the library's file set + last-update, so a scan (which
 *  adds/updates files) invalidates the warm index but re-builds don't. */
function fingerprint(dbPath: string): string {
  try {
    const db = new DatabaseSync(`file:${dbPath}?immutable=1`, { readOnly: true });
    try {
      const a = db.prepare(`SELECT COUNT(*) n, COALESCE(MAX(Id),0) m FROM MediaFile`).get() as any;
      const b = db.prepare(`SELECT COALESCE(MAX(DateUpdated),'') d FROM MediaVersion`).get() as any;
      return `${a.n}:${a.m}:${b.d}`;
    } finally { db.close(); }
  } catch { return `err:${Date.now()}`; } // unreadable -> force a fresh load next time
}

async function ensureResolver(req: BuildWorkerRequest): Promise<SqliteResolver> {
  if (resolver && loadedDb === req.libDbPath && resolver.indexBacked) return resolver; // follows the search index
  const fp = fingerprint(req.libDbPath);
  if (!resolver || loadedDb !== req.libDbPath || loadedFp !== fp) {
    try { resolver?.close(); } catch { /* ignore */ }
    resolver = new SqliteResolver({ dbPath: req.libDbPath });
    // Warm the index now (a query that matches nothing still triggers the full
    // load + field indexing) so the cost is paid here, once, not per channel.
    await resolver.resolveContent({ key: "__warm", kind: "search", order: "shuffle", query: "type:__warmup__", raw: {} } as any).catch(() => {});
    loadedDb = req.libDbPath; loadedFp = fp;
    port.postMessage({ jobId: req.jobId, type: "log", msg: resolver.indexBacked ? "search index loaded" : "library loaded (search index not ready yet)" });
  }
  return resolver;
}

async function handle(req: BuildWorkerRequest): Promise<void> {
  const post = (m: Record<string, unknown>) => port.postMessage({ jobId: req.jobId, ...m });
  const r = await ensureResolver(req);
  r.setDisabledLibraries(req.disabledLibs);
  r.setExcludeSpecials(req.excludeSpecials);
  for (const c of req.channels) {
    try {
      const res = await buildChannel({
        configPath: c.configPath, resolver: r, outputDir: c.outputDir, sourceXmltv: c.sourceXmltv,
        options: {
          startMs: c.startMs, finishMs: c.finishMs, tz: req.tz,
          seed: c.seed, progress: c.progress,
          preferredAudioLang: c.audioLang || undefined, subtitles: c.subtitles || undefined,
          upNext: c.upNext, overlays: c.overlays,
        },
      });
      let xmltvWarn: string | undefined;
      try {
        if (res.xmltv != null) await writeShiftedXmltv(c.xmltvDir, c.tvgId, res.xmltv);
        else if (req.xmltvMode === "merge") await mergeChannelXmltv(c.xmltvDir, c.tvgId, res.guide, req.tz, req.now, r, req.artBase);
        else await writeChannelXmltv(c.xmltvDir, c.tvgId, res.guide, req.tz, r, req.artBase);
      } catch (e) { xmltvWarn = (e as Error).message; }
      post({ type: "result", name: c.name, itemCount: res.itemCount, file: res.file, progress: res.progress, guideCount: res.guide.length, xmltvWarn, overlayWarn: res.overlayProblems?.join("; ") });
    } catch (e) {
      post({ type: "error", name: c.name, msg: (e as Error).message });
    }
  }
  post({ type: "done" });
}

// Process requests strictly one at a time (a shared warm resolver isn't safe to
// run two builds through concurrently).
let chain: Promise<void> = Promise.resolve();
port.on("message", (req: BuildWorkerRequest) => {
  chain = chain.then(() => handle(req)).catch((e) => port.postMessage({ jobId: req.jobId, type: "done", fatal: String((e as Error)?.message ?? e) }));
});
