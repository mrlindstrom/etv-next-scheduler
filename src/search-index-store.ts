// -----------------------------------------------------------------------------
// The persisted search index (legacy ErsatzTV keeps a Lucene index; this is ours):
// one pre-built search document per media item / show / season, in
// search-index.sqlite next to the library.
//
//   docs(id, doc)        document JSON, keyed by the row id the resolver uses
//   changes(gen, id)     which documents each generation touched (incremental
//                        catch-up for readers in other threads/processes)
//   meta(key, value)     format version, library path, generation, full-rebuild
//                        generation, library fingerprint, timestamps, count
//
// Exactly one writer (the server's index worker) writes it. Readers (the server,
// the build worker, CLI builds) load it — ~4x faster than deriving documents from
// the library — and apply later generations incrementally.
// -----------------------------------------------------------------------------
import { DatabaseSync } from "node:sqlite";
import { existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Bump when the document shape or meaning changes: forces a full rebuild.
 *  3: music videos carry their artist (from the Artist, i.e. their folder). */
export const INDEX_VERSION = 3;
const KEEP_GENERATIONS = 500;   // change-log history kept for catching up

export interface IndexMeta {
  version: number; library: string; gen: number; fullGen: number; minGen: number;
  complete: boolean; fingerprint: string; builtAt: string; updatedAt: string; count: number;
}

const samePath = (a: string, b: string) => {
  const n = (p: string) => resolve(p).replace(/\\/g, "/").toLowerCase();
  return n(a) === n(b);
};

/** Documents are stored without empty arrays / nulls (readers restore defaults). */
function compact(row: unknown): string {
  return JSON.stringify(row, (k, v) => (k !== "" && ((Array.isArray(v) && v.length === 0) || v === null) ? undefined : v));
}

export class SearchIndexStore {
  private constructor(readonly path: string, private db: DatabaseSync, private libraryPath: string) {}

  /** search-index.sqlite next to the library. */
  static pathFor(libraryDbPath: string): string { return join(dirname(libraryDbPath), "search-index.sqlite"); }

  /** A complete, current-format index for this library, or null. */
  static openForRead(path: string, libraryDbPath: string): SearchIndexStore | null {
    if (!existsSync(path)) return null;
    const db = new DatabaseSync(path, { readOnly: true });
    try { db.exec("PRAGMA busy_timeout=10000;"); } catch { /* ignore */ }
    const store = new SearchIndexStore(path, db, libraryDbPath);
    const m = store.meta();
    if (!m || !store.usable(m)) { db.close(); return null; }
    return store;
  }

  /** The writer's handle. A file that can't be opened is deleted and recreated. */
  static openForWrite(path: string, libraryDbPath: string): SearchIndexStore {
    const create = () => {
      const db = new DatabaseSync(path);
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; PRAGMA synchronous=NORMAL;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, doc TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS changes (gen INTEGER NOT NULL, id INTEGER NOT NULL, PRIMARY KEY (gen, id));`);
      return db;
    };
    let db: DatabaseSync;
    try { db = create(); db.prepare("SELECT COUNT(*) FROM meta").get(); }
    catch {
      for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(path + s); } catch { /* not there */ } }
      db = create();
    }
    return new SearchIndexStore(path, db, libraryDbPath);
  }

  close(): void { try { this.db.close(); } catch { /* ignore */ } }

  meta(): IndexMeta | null {
    try {
      const m: Record<string, string> = {};
      for (const r of this.db.prepare("SELECT key, value FROM meta").all() as any[]) m[r.key] = r.value;
      const n = (k: string) => Number(m[k] ?? 0) || 0;
      return { version: n("version"), library: m.library ?? "", gen: n("gen"), fullGen: n("fullGen"), minGen: n("minGen"),
        complete: m.complete === "1", fingerprint: m.fingerprint ?? "", builtAt: m.builtAt ?? "", updatedAt: m.updatedAt ?? "", count: n("count") };
    } catch { return null; }
  }

  /** Right format, built for this library, and finished. */
  usable(m: IndexMeta | null = this.meta()): boolean {
    return !!m && m.version === INDEX_VERSION && m.complete && !!m.library && samePath(m.library, this.libraryPath);
  }

  /** SQLite's own consistency check (corruption). */
  healthy(): boolean {
    try { return String(Object.values((this.db.prepare("PRAGMA quick_check(1)").get() as any) ?? {})[0]).toLowerCase() === "ok"; }
    catch { return false; }
  }

  /** Every document, with the generation they belong to (one consistent snapshot). */
  loadAll(): { gen: number; rows: any[] } | null {
    this.db.exec("BEGIN");
    try {
      const m = this.meta();
      if (!this.usable(m)) return null;
      const rows: any[] = [];
      for (const r of this.db.prepare("SELECT doc FROM docs").iterate() as Iterable<any>) rows.push(JSON.parse(r.doc));
      return { gen: m!.gen, rows };
    } finally { this.db.exec("COMMIT"); }
  }

  /** Documents changed after generation `gen`, or null if that's too far back
   *  (or the index was rebuilt since) — the caller then reloads everything. */
  changesSince(gen: number): { gen: number; upserts: any[]; removed: number[] } | null {
    this.db.exec("BEGIN");
    try {
      const m = this.meta();
      if (!this.usable(m) || m!.fullGen > gen || gen < m!.minGen - 1) return null;
      const upserts: any[] = [], removed: number[] = [];
      const doc = this.db.prepare("SELECT doc FROM docs WHERE id = ?");
      for (const r of this.db.prepare("SELECT DISTINCT id FROM changes WHERE gen > ?").all(gen) as any[]) {
        const d = doc.get(r.id) as any;
        if (d) upserts.push(JSON.parse(d.doc)); else removed.push(r.id);
      }
      return { gen: m!.gen, upserts, removed };
    } finally { this.db.exec("COMMIT"); }
  }

  private setMeta(values: Record<string, string | number>): void {
    const st = this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    for (const [k, v] of Object.entries(values)) st.run(k, String(v));
  }

  /** Replace every document (a full rebuild). Returns the new generation. */
  writeFull(rows: { id: number }[], fingerprint: string): number {
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      const gen = (this.meta()?.gen ?? 0) + 1;
      this.db.exec("DELETE FROM docs; DELETE FROM changes;");
      const ins = this.db.prepare("INSERT INTO docs (id, doc) VALUES (?, ?)");
      for (const r of rows) ins.run(r.id, compact(r));
      this.setMeta({ version: INDEX_VERSION, library: resolve(this.libraryPath), gen, fullGen: gen, minGen: gen + 1, complete: 1,
        fingerprint, builtAt: now, updatedAt: now, count: rows.length });
      this.db.exec("COMMIT");
      return gen;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  /** Apply an incremental update. Returns the new generation. */
  writeChanges(upserts: { id: number }[], removed: number[], fingerprint: string): number {
    this.db.exec("BEGIN");
    try {
      const m = this.meta()!;
      const gen = m.gen + 1;
      const put = this.db.prepare("INSERT INTO docs (id, doc) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc");
      const del = this.db.prepare("DELETE FROM docs WHERE id = ?");
      const log = this.db.prepare("INSERT OR IGNORE INTO changes (gen, id) VALUES (?, ?)");
      for (const r of upserts) { put.run(r.id, compact(r)); log.run(gen, r.id); }
      for (const id of removed) { del.run(id); log.run(gen, id); }
      const keepFrom = gen - KEEP_GENERATIONS + 1;
      this.db.prepare("DELETE FROM changes WHERE gen < ?").run(keepFrom);
      const count = (this.db.prepare("SELECT COUNT(*) n FROM docs").get() as any).n;
      this.setMeta({ gen, minGen: Math.max(m.minGen, keepFrom), fingerprint, updatedAt: new Date().toISOString(), count });
      this.db.exec("COMMIT");
      return gen;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  setFingerprint(fingerprint: string): void { this.setMeta({ fingerprint }); }
}

/** A cheap summary of the library's indexed content: row counts, highest ids and
 *  latest update stamps. If it changes while nothing was queued for re-indexing,
 *  the library was changed behind our back (e.g. replaced) and the index is rebuilt. */
export function libraryFingerprint(lib: DatabaseSync): string {
  const parts: string[] = [];
  const has = (t: string) => !!lib.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const col = (t: string, c: string) => (lib.prepare(`PRAGMA table_info(${t})`).all() as any[]).some((x) => x.name === c);
  const tables = ["MediaItem", "MediaVersion", "MediaFile", "MediaStream", "MediaChapter", "Episode", "Season", "Show", "Movie", "OtherVideo",
    "MusicVideo", "Song", "Image", "EpisodeMetadata", "ShowMetadata", "SeasonMetadata", "MovieMetadata", "OtherVideoMetadata",
    "MusicVideoMetadata", "SongMetadata", "ImageMetadata", "Genre", "Tag", "Studio", "Actor", "Director", "Writer", "Mood", "Style",
    "MetadataGuid", "Collection", "CollectionItem", "Library", "LibraryPath", "TraktList", "TraktListItem"];
  for (const t of tables) {
    if (!has(t)) { parts.push(`${t}:-`); continue; }
    const r = lib.prepare(`SELECT COUNT(*) n, COALESCE(MAX(rowid), 0) m${col(t, "DateUpdated") ? ", COALESCE(MAX(DateUpdated), '') d" : ""} FROM ${t}`).get() as any;
    parts.push(`${t}:${r.n}:${r.m}${r.d !== undefined ? `:${r.d}` : ""}`);
  }
  return parts.join("|");
}
