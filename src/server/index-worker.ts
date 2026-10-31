// -----------------------------------------------------------------------------
// Search-index writer (a worker thread, so a rebuild never blocks the server).
// The only process that writes search-index.sqlite.
//
//   ensure   on startup / after a library import: rebuild if the index is missing,
//            corrupt, in an old format, for another library, or the library
//            changed with nothing queued; otherwise apply the queue
//   drain    apply queued changes (SearchIndexQueue) incrementally
//   rebuild  full rebuild on request
// -----------------------------------------------------------------------------
import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { existsSync, unlinkSync } from "node:fs";
import { SqliteResolver } from "../sqlite-resolver.js";
import { SearchIndexStore, libraryFingerprint } from "../search-index-store.js";
import { queuedForReindex, clearReindexQueue } from "../search-index-queue.js";

export type IndexRequest = { op: "ensure" | "drain" | "rebuild"; libraryDbPath: string; reason?: string };
export interface IndexStatusMsg {
  type: "status";
  phase: "idle" | "checking" | "rebuilding" | "updating" | "error";
  detail?: string; docs?: number; gen?: number; builtAt?: string; updatedAt?: string;
  last?: { kind: "rebuild" | "update"; docs: number; removed?: number; ms: number; at: string; reason?: string };
  error?: string;
}

let libPath = "";
let lib: DatabaseSync | null = null;
let store: SearchIndexStore | null = null;
let resolver: SqliteResolver | null = null;

const log = (msg: string) => console.log(`[index] ${msg}`);
const status = (s: Omit<IndexStatusMsg, "type">) => {
  const m = store?.meta();
  parentPort!.postMessage({ type: "status", docs: m?.count, gen: m?.gen, builtAt: m?.builtAt, updatedAt: m?.updatedAt, ...s } satisfies IndexStatusMsg);
};

function open(libraryDbPath: string): void {
  if (libPath === libraryDbPath && lib && store) return;
  try { lib?.close(); } catch { /* ignore */ }
  store?.close(); resolver = null;
  libPath = libraryDbPath;
  lib = new DatabaseSync(libraryDbPath);
  lib.exec("PRAGMA busy_timeout=10000;");
  store = SearchIndexStore.openForWrite(SearchIndexStore.pathFor(libraryDbPath), libraryDbPath);
}

function fullRebuild(reason: string): void {
  status({ phase: "rebuilding", detail: reason });
  log(`rebuilding the search index (${reason})…`);
  const t0 = Date.now();
  const taken = queuedForReindex(lib!);                       // anything queued now is covered by this build
  const rows = new SqliteResolver({ dbPath: libPath, indexPath: false }).collectRows();
  const gen = store!.writeFull(rows, libraryFingerprint(lib!));
  resolver = new SqliteResolver({ dbPath: libPath, indexPath: false, writer: true });
  resolver.setRows(rows as any); resolver.generation = gen;
  clearReindexQueue(lib!, taken);
  const ms = Date.now() - t0;
  log(`search index rebuilt: ${rows.length.toLocaleString()} documents in ${(ms / 1000).toFixed(1)}s`);
  status({ phase: "idle", last: { kind: "rebuild", docs: rows.length, ms, at: new Date().toISOString(), reason } });
}

function drain(): void {
  for (let pass = 0; pass < 20; pass++) {
    const ids = queuedForReindex(lib!);
    if (!ids.length) return;
    if (ids.includes(0)) { fullRebuild("a full re-index was requested"); continue; }
    status({ phase: "updating", detail: `${ids.length} changed item${ids.length === 1 ? "" : "s"}` });
    const t0 = Date.now();
    if (!resolver) { resolver = new SqliteResolver({ dbPath: libPath, writer: true }); resolver.allRows(); resolver.generation = store!.meta()?.gen ?? 0; }
    const { upserts, removed } = resolver.reindex(ids);
    const gen = store!.writeChanges(upserts, removed, libraryFingerprint(lib!));
    resolver.generation = gen;
    clearReindexQueue(lib!, ids);
    const ms = Date.now() - t0;
    log(`updated ${upserts.length.toLocaleString()} document${upserts.length === 1 ? "" : "s"}${removed.length ? `, removed ${removed.length}` : ""} for ${ids.length} changed item${ids.length === 1 ? "" : "s"} in ${ms}ms`);
    status({ phase: "idle", last: { kind: "update", docs: upserts.length, removed: removed.length, ms, at: new Date().toISOString() } });
  }
}

function ensure(reason?: string): void {
  status({ phase: "checking" });
  const m = store!.meta();
  if (!store!.usable(m)) return fullRebuild(!m || !m.version ? "no search index yet" : m.version && m.complete ? "the index format or library changed" : "the previous build didn't finish");
  if (!store!.healthy()) {
    log("the search index file is damaged; recreating it");
    const p = store!.path; store!.close();
    for (const s of ["", "-wal", "-shm"]) { try { if (existsSync(p + s)) unlinkSync(p + s); } catch { /* ignore */ } }
    store = SearchIndexStore.openForWrite(p, libPath); resolver = null;
    return fullRebuild("the index file was damaged");
  }
  const queued = queuedForReindex(lib!);
  if (!queued.length && libraryFingerprint(lib!) !== m!.fingerprint) return fullRebuild(`${reason ? reason + ": " : ""}the library changed outside the app`);
  drain();
  if (!queued.length) { log(`search index is up to date (${m!.count.toLocaleString()} documents)`); status({ phase: "idle" }); }
}

parentPort!.on("message", (req: IndexRequest) => {
  try {
    if (!req.libraryDbPath || !existsSync(req.libraryDbPath)) { status({ phase: "idle", detail: "no library imported yet" }); return; }
    open(req.libraryDbPath);
    if (req.op === "rebuild") fullRebuild(req.reason ?? "rebuild requested");
    else if (req.op === "drain") drain();
    else ensure(req.reason);
    status({ phase: "idle" });
  } catch (e) {
    log(`ERROR: ${(e as Error).message}`);
    status({ phase: "error", error: (e as Error).message });
  }
});
