// -----------------------------------------------------------------------------
// "Needs re-indexing" queue, kept inside the library database so every writer —
// the server, scan / deep-scan child processes, the CLI — can record which media
// items it changed, and the index writer picks them up (even after a restart).
// Like legacy's ReindexMediaItems. Any MediaItem id may be queued: an episode,
// movie, other video … or a show / season (re-indexes the whole show).
// Id 0 means "rebuild everything".
// -----------------------------------------------------------------------------
import type { DatabaseSync } from "node:sqlite";

const ensure = (db: DatabaseSync) => db.exec("CREATE TABLE IF NOT EXISTS SearchIndexQueue (MediaItemId INTEGER PRIMARY KEY)");

/** Queue media items (or 0 = everything) for re-indexing. Never throws. */
export function markForReindex(db: DatabaseSync, ids: Iterable<number> | number): void {
  try {
    ensure(db);
    const ins = db.prepare("INSERT OR IGNORE INTO SearchIndexQueue (MediaItemId) VALUES (?)");
    for (const id of typeof ids === "number" ? [ids] : ids) if (Number.isFinite(id) && id >= 0) ins.run(Math.trunc(id));
  } catch { /* the index will notice via its fingerprint check instead */ }
}

export function queuedForReindex(db: DatabaseSync): number[] {
  try { ensure(db); return (db.prepare("SELECT MediaItemId id FROM SearchIndexQueue").all() as any[]).map((r) => r.id); }
  catch { return []; }
}

/** Remove exactly these entries (ones queued meanwhile stay for the next pass). */
export function clearReindexQueue(db: DatabaseSync, ids: number[]): void {
  try {
    const del = db.prepare("DELETE FROM SearchIndexQueue WHERE MediaItemId = ?");
    db.exec("BEGIN"); for (const id of ids) del.run(id); db.exec("COMMIT");
  } catch { try { db.exec("ROLLBACK"); } catch { /* not in a transaction */ } }
}
