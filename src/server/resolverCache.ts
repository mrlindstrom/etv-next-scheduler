// Cache one SqliteResolver per DB path (preload is ~3.6s; reuse across requests).
import { SqliteResolver } from "../sqlite-resolver.js";

const cache = new Map<string, SqliteResolver>();

export function getResolver(dbPath: string): SqliteResolver {
  let r = cache.get(dbPath);
  if (!r) { r = new SqliteResolver({ dbPath, verbose: true }); cache.set(dbPath, r); }
  return r;
}
export function dropResolver(dbPath: string) {
  const r = cache.get(dbPath); if (r) { try { r.close(); } catch {} cache.delete(dbPath); }
}
