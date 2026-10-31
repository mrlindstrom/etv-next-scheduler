// Collections management over library.sqlite (the app's own copy — never the
// ErsatzTV DB). Lists manual Collections, Smart Collections (query-based),
// Multi-Collections, and Playlists; resolves their items to browse cards via the
// scheduling resolver; and supports create / rename / edit-query / delete.
import { DatabaseSync } from "node:sqlite";
import { markForReindex } from "../search-index-queue.js";
import type { ContentResolver } from "../resolver.js";
import type { MediaItem } from "../model.js";
import { LEGACY_ORDER, playlistEntryLabel } from "../sqlite-resolver.js";

export type CollectionType = "collection" | "smart" | "multi" | "playlist";

export interface CollectionInfo {
  type: CollectionType; id: number; name: string;
  group?: string;            // playlist group
  query?: string;            // smart collection query
  count?: number | null;     // item count when cheap to compute
}
export interface CollectionCard { id: number; type: string; title: string; subtitle?: string; year?: number | null; durationMs?: number; hasArt: boolean; }

function openRO(path: string): DatabaseSync {
  // A normal read-only handle sees what a scan just wrote (still in the WAL);
  // `immutable` ignores the WAL, so it's only the fallback for filesystems where a
  // normal handle opens but can't read (FUSE/network mounts) — as the resolver does.
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try { db.exec("PRAGMA busy_timeout=10000;"); db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get(); return db; }
    catch (e) { db.close(); throw e; }
  } catch { return new DatabaseSync(`file:${path}?immutable=1`, { readOnly: true }); }
}
function openRW(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // WAL + busy_timeout so this never deadlocks behind an in-progress scan.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = OFF;");
  return db;
}
const has = (db: DatabaseSync, t: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);

/** List every editable collection, grouped by type, with cheap counts. */
export function listCollections(dbPath: string): CollectionInfo[] {
  const db = openRO(dbPath);
  try {
    const out: CollectionInfo[] = [];
    if (has(db, "Collection")) {
      for (const r of db.prepare(
        `SELECT c.Id id, c.Name name, (SELECT COUNT(*) FROM CollectionItem ci WHERE ci.CollectionId=c.Id) n
         FROM Collection c ORDER BY c.Name`).all() as any[])
        out.push({ type: "collection", id: r.id, name: r.name ?? "(unnamed)", count: r.n });
    }
    if (has(db, "SmartCollection")) {
      for (const r of db.prepare(`SELECT Id id, Name name, Query query FROM SmartCollection ORDER BY Name`).all() as any[])
        out.push({ type: "smart", id: r.id, name: r.name ?? "(unnamed)", query: r.query ?? "", count: null });
    }
    if (has(db, "MultiCollection")) {
      for (const r of db.prepare(
        `SELECT m.Id id, m.Name name,
          (SELECT COUNT(*) FROM MultiCollectionItem mi WHERE mi.MultiCollectionId=m.Id)
          + (SELECT COUNT(*) FROM MultiCollectionSmartItem ms WHERE ms.MultiCollectionId=m.Id) members
         FROM MultiCollection m ORDER BY m.Name`).all() as any[])
        out.push({ type: "multi", id: r.id, name: r.name ?? "(unnamed)", count: r.members });
    }
    if (has(db, "Playlist")) {
      for (const r of db.prepare(
        `SELECT p.Id id, p.Name name, g.Name grp, (SELECT COUNT(*) FROM PlaylistItem pi WHERE pi.PlaylistId=p.Id) n
         FROM Playlist p LEFT JOIN PlaylistGroup g ON g.Id=p.PlaylistGroupId ORDER BY p.Name`).all() as any[])
        out.push({ type: "playlist", id: r.id, name: r.name ?? "(unnamed)", group: r.grp ?? undefined, count: r.n });
    }
    return out;
  } finally { db.close(); }
}

function cardFrom(m: MediaItem): CollectionCard {
  const sub = m.season != null && m.episodeNumber != null
    ? `S${String(m.season).padStart(2, "0")}E${String(m.episodeNumber).padStart(2, "0")}`
    : (m.showTitle || undefined);
  // shows/seasons come back unexpanded with a synthetic id; refId is the real one
  // (what /api/artwork and collection membership key on)
  return { id: Number(m.refId ?? m.id), type: m.kind ?? "other", title: m.title || "(untitled)", subtitle: sub, year: m.year ?? null, durationMs: m.durationMs, hasArt: true };
}

/** Resolve a collection's items to cards (paged). Uses the resolver, which
 *  understands each collection type by name/query. */
export async function collectionItems(
  dbPath: string, resolver: ContentResolver, type: CollectionType, id: number,
  offset = 0, limit = 60,
): Promise<{ name: string; type: CollectionType; query?: string; total: number; cards: CollectionCard[] }> {
  const meta = collectionMeta(dbPath, type, id);
  if (!meta) return { name: "?", type, total: 0, cards: [] };

  // Browse shows a collection's members as-is (shows/seasons/movies), matching the
  // sidebar count; scheduling still expands groups to episodes elsewhere.
  let items: MediaItem[] = [];
  if (type === "smart") items = await resolver.resolveContent({ key: "c", kind: "search", order: "chronological", query: meta.query ?? "", expand: false, raw: {} } as any);
  else if (type === "collection") items = await resolver.resolveContent({ key: "c", kind: "collection", order: "chronological", collection: meta.name, expand: false, raw: {} } as any);
  else if (type === "multi") items = await resolver.resolveContent({ key: "c", kind: "multi_collection", order: "chronological", collection: meta.name, expand: false, raw: {} } as any);
  else if (type === "playlist") items = await playlistItems(dbPath, resolver, id);

  const seen = new Set<string>();
  const uniq = items.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  const cards = uniq.slice(offset, offset + limit).map(cardFrom);
  return { name: meta.name, type, query: meta.query, total: uniq.length, cards };
}

/** Expand a playlist into media items by resolving each of its referenced parts. */
async function playlistItems(dbPath: string, resolver: ContentResolver, playlistId: number): Promise<MediaItem[]> {
  const db = openRO(dbPath);
  let rows: any[];
  try {
    rows = db.prepare(`SELECT CollectionId, MediaItemId, MultiCollectionId, SmartCollectionId FROM PlaylistItem WHERE PlaylistId=? ORDER BY "Index"`).all(playlistId) as any[];
  } finally { db.close(); }
  const nameOf = (type: CollectionType, id: number) => collectionMeta(dbPath, type, id)?.name;
  const out: MediaItem[] = [];
  for (const r of rows) {
    if (r.CollectionId != null) { const n = nameOf("collection", r.CollectionId); if (n) out.push(...await resolver.resolveContent({ key: "p", kind: "collection", order: "chronological", collection: n, raw: {} } as any)); }
    else if (r.SmartCollectionId != null) { const m = collectionMeta(dbPath, "smart", r.SmartCollectionId); if (m) out.push(...await resolver.resolveContent({ key: "p", kind: "search", order: "chronological", query: m.query ?? "", raw: {} } as any)); }
    else if (r.MultiCollectionId != null) { const n = nameOf("multi", r.MultiCollectionId); if (n) out.push(...await resolver.resolveContent({ key: "p", kind: "multi_collection", order: "chronological", collection: n, raw: {} } as any)); }
    // a direct MediaItemId can't be resolved to a full MediaItem cheaply here; skip.
  }
  return out;
}

const TABLE: Record<CollectionType, string> = { collection: "Collection", smart: "SmartCollection", multi: "MultiCollection", playlist: "Playlist" };

export function collectionMeta(dbPath: string, type: CollectionType, id: number): { name: string; query?: string } | null {
  const db = openRO(dbPath);
  try {
    const r = db.prepare(`SELECT * FROM ${TABLE[type]} WHERE Id=?`).get(id) as any;
    if (!r) return null;
    return { name: r.Name ?? "(unnamed)", query: type === "smart" ? (r.Query ?? "") : undefined };
  } finally { db.close(); }
}

/** Create a collection. Returns the new id. */
export function createCollection(dbPath: string, type: CollectionType, name: string, query?: string): number {
  const db = openRW(dbPath);
  try {
    const nm = (name ?? "").trim() || "Untitled";
    if (type === "collection") return Number(db.prepare(`INSERT INTO Collection(Name, UseCustomPlaybackOrder) VALUES(?, 0)`).run(nm).lastInsertRowid);
    if (type === "smart") return Number(db.prepare(`INSERT INTO SmartCollection(Name, Query) VALUES(?, ?)`).run(nm, query ?? "").lastInsertRowid);
    if (type === "multi") return Number(db.prepare(`INSERT INTO MultiCollection(Name) VALUES(?)`).run(nm).lastInsertRowid);
    // playlists live in a playlist group; use the first non-system one (or make one)
    let grp = db.prepare(`SELECT Id FROM PlaylistGroup WHERE IsSystem=0 ORDER BY Id LIMIT 1`).get() as any;
    if (!grp) grp = { Id: Number(db.prepare(`INSERT INTO PlaylistGroup(Name, IsSystem) VALUES('Playlists', 0)`).run().lastInsertRowid) };
    const id = Number(db.prepare(`INSERT INTO Playlist(PlaylistGroupId, Name, IsSystem) VALUES(?, ?, 0)`).run(grp.Id, nm).lastInsertRowid);
    checkpoint(db);
    return id;
  } finally { db.close(); }
}

/** Rename a collection and (for smart) update its query. */
export function updateCollection(dbPath: string, type: CollectionType, id: number, patch: { name?: string; query?: string }): void {
  const db = openRW(dbPath);
  try {
    if (patch.name != null) db.prepare(`UPDATE ${TABLE[type]} SET Name=? WHERE Id=?`).run(patch.name.trim(), id);
    // a manual collection's name is part of its members' search documents (collection:)
    if (type === "collection" && patch.name != null) { const members = () => (db.prepare(`SELECT MediaItemId id FROM CollectionItem WHERE CollectionId=?`).all(id) as any[]).map((r) => r.id as number); markForReindex(db, members()); }
    if (type === "smart" && patch.query != null) db.prepare(`UPDATE SmartCollection SET Query=? WHERE Id=?`).run(patch.query, id);
  } finally { db.close(); }
}

// Fold the change into the main file now: the collection list reads with an
// immutable handle (ignores the WAL), so it would otherwise show stale counts.
function checkpoint(db: DatabaseSync): void { try { db.exec("PRAGMA wal_checkpoint(PASSIVE);"); } catch { /* best-effort */ } }

// ---- manual-collection membership (add/remove a movie, show, season, episode…) ----
// Legacy CollectionItem rows point at a MediaItem id; shows and seasons are
// MediaItems too, so a whole show or one season can be a member.

/** The manual collections that contain this media item. */
export function collectionsContaining(dbPath: string, itemId: number): { id: number; name: string }[] {
  // a normal (non-immutable) reader, so a change just made is visible
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare(`SELECT c.Id id, c.Name name FROM CollectionItem ci JOIN Collection c ON c.Id=ci.CollectionId WHERE ci.MediaItemId=? ORDER BY c.Name`).all(itemId) as any[])
      .map((r) => ({ id: r.id, name: r.name ?? "(unnamed)" }));
  } finally { db.close(); }
}

/** Add a media item to a manual collection (no-op if it's already there). */
export function addToCollection(dbPath: string, collectionId: number, itemId: number): void {
  const db = openRW(dbPath);
  try {
    if (!db.prepare(`SELECT 1 FROM Collection WHERE Id=?`).get(collectionId)) throw new Error(`Collection ${collectionId} not found.`);
    if (!db.prepare(`SELECT 1 FROM MediaItem WHERE Id=?`).get(itemId)) throw new Error(`Media item ${itemId} not found.`);
    const next = (db.prepare(`SELECT COALESCE(MAX(CustomIndex), -1) + 1 n FROM CollectionItem WHERE CollectionId=?`).get(collectionId) as any).n;
    db.prepare(`INSERT OR IGNORE INTO CollectionItem (CollectionId, MediaItemId, CustomIndex) VALUES (?,?,?)`).run(collectionId, itemId, next);
    markForReindex(db, itemId);
    checkpoint(db);
  } finally { db.close(); }
}

export function removeFromCollection(dbPath: string, collectionId: number, itemId: number): void {
  const db = openRW(dbPath);
  try { db.prepare(`DELETE FROM CollectionItem WHERE CollectionId=? AND MediaItemId=?`).run(collectionId, itemId); markForReindex(db, itemId); checkpoint(db); }
  finally { db.close(); }
}

/** Delete a collection and its membership rows (never touches media files). */
export function deleteCollection(dbPath: string, type: CollectionType, id: number): void {
  const db = openRW(dbPath);
  try {
    const del = (sql: string) => { try { db.prepare(sql).run(id); } catch {} };
    if (type === "collection") { const members = () => (db.prepare(`SELECT MediaItemId id FROM CollectionItem WHERE CollectionId=?`).all(id) as any[]).map((r) => r.id as number); markForReindex(db, members()); del(`DELETE FROM CollectionItem WHERE CollectionId=?`); del(`DELETE FROM MultiCollectionItem WHERE CollectionId=?`); del(`DELETE FROM PlaylistItem WHERE CollectionId=?`); del(`DELETE FROM Collection WHERE Id=?`); }
    else if (type === "smart") { del(`DELETE FROM MultiCollectionSmartItem WHERE SmartCollectionId=?`); del(`DELETE FROM PlaylistItem WHERE SmartCollectionId=?`); del(`DELETE FROM SmartCollection WHERE Id=?`); }
    else if (type === "multi") { del(`DELETE FROM MultiCollectionItem WHERE MultiCollectionId=?`); del(`DELETE FROM MultiCollectionSmartItem WHERE MultiCollectionId=?`); del(`DELETE FROM PlaylistItem WHERE MultiCollectionId=?`); del(`DELETE FROM MultiCollection WHERE Id=?`); }
    else if (type === "playlist") { del(`DELETE FROM PlaylistItem WHERE PlaylistId=?`); del(`DELETE FROM Playlist WHERE Id=?`); }
  } finally { db.close(); }
}


// ---- playlists: an ordered list of entries (ErsatzTV legacy PlaylistItem rows) ----
// Each entry plays a collection / smart / multi-collection, or a show, season or
// single item, with its own play order and how many items it plays per turn.

export type PlaylistRef = { type: "collection" | "smart" | "multi" | "item"; id: number };
export interface PlaylistEntryRow {
  id: number; index: number; ref: PlaylistRef; label: string;
  order: string; playAll: boolean; count: number | null; inGuide: boolean;
}
const ORDER_NUM: Record<string, number> = { chronological: 1, random: 2, shuffle: 3, shuffle_in_order: 4, multi_episode_shuffle: 5, season_episode: 6 };

export function playlistEntries(dbPath: string, playlistId: number): PlaylistEntryRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true }); // see writes made a moment ago
  try {
    return (db.prepare(`SELECT * FROM PlaylistItem WHERE PlaylistId=? ORDER BY "Index", Id`).all(playlistId) as any[]).map((it) => ({
      id: it.Id, index: it.Index,
      ref: it.CollectionId != null ? { type: "collection", id: it.CollectionId } : it.SmartCollectionId != null ? { type: "smart", id: it.SmartCollectionId }
        : it.MultiCollectionId != null ? { type: "multi", id: it.MultiCollectionId } : { type: "item", id: it.MediaItemId },
      label: playlistEntryLabel(db, it),
      order: LEGACY_ORDER[it.PlaybackOrder] ?? "chronological",
      playAll: !!it.PlayAll, count: it.Count ?? null, inGuide: it.IncludeInProgramGuide !== 0,
    }));
  } finally { db.close(); }
}

/** Append an entry. Shows and seasons default to playing in order; collections shuffle. */
export function addPlaylistEntry(dbPath: string, playlistId: number, ref: PlaylistRef): number {
  const db = openRW(dbPath);
  try {
    if (!db.prepare(`SELECT 1 FROM Playlist WHERE Id=?`).get(playlistId)) throw new Error(`Playlist ${playlistId} not found.`);
    const next = (db.prepare(`SELECT COALESCE(MAX("Index"), 0) + 1 n FROM PlaylistItem WHERE PlaylistId=?`).get(playlistId) as any).n;
    let collType = 0, order = ORDER_NUM.shuffle;
    const cols: Record<string, number | null> = { CollectionId: null, SmartCollectionId: null, MultiCollectionId: null, MediaItemId: null };
    if (ref.type === "collection") { cols.CollectionId = ref.id; collType = 0; }
    else if (ref.type === "multi") { cols.MultiCollectionId = ref.id; collType = 4; }
    else if (ref.type === "smart") { cols.SmartCollectionId = ref.id; collType = 5; }
    else {
      cols.MediaItemId = ref.id;
      const is = (t: string) => !!db.prepare(`SELECT 1 FROM ${t} WHERE Id=?`).get(ref.id);
      // legacy's collection-type numbers for media items
      collType = is("Show") ? 1 : is("Season") ? 2 : is("Movie") ? 10 : is("Episode") ? 20 : is("MusicVideo") ? 30 : is("OtherVideo") ? 40 : 0;
      order = ORDER_NUM.chronological;
    }
    const id = Number(db.prepare(
      `INSERT INTO PlaylistItem("Index", PlaylistId, CollectionType, CollectionId, MediaItemId, MultiCollectionId, SmartCollectionId, IncludeInProgramGuide, PlaybackOrder, PlayAll, Count)
       VALUES(?,?,?,?,?,?,?,1,?,0,NULL)`).run(next, playlistId, collType, cols.CollectionId, cols.MediaItemId, cols.MultiCollectionId, cols.SmartCollectionId, order).lastInsertRowid);
    checkpoint(db);
    return id;
  } finally { db.close(); }
}

export function updatePlaylistEntry(dbPath: string, entryId: number, patch: { order?: string; playAll?: boolean; count?: number | null; inGuide?: boolean }): void {
  const db = openRW(dbPath);
  try {
    if (patch.order != null && ORDER_NUM[patch.order] != null) db.prepare(`UPDATE PlaylistItem SET PlaybackOrder=? WHERE Id=?`).run(ORDER_NUM[patch.order], entryId);
    if (patch.playAll != null) db.prepare(`UPDATE PlaylistItem SET PlayAll=? WHERE Id=?`).run(patch.playAll ? 1 : 0, entryId);
    if (patch.count !== undefined) db.prepare(`UPDATE PlaylistItem SET Count=? WHERE Id=?`).run(patch.count && patch.count > 0 ? Math.floor(patch.count) : null, entryId);
    if (patch.inGuide != null) db.prepare(`UPDATE PlaylistItem SET IncludeInProgramGuide=? WHERE Id=?`).run(patch.inGuide ? 1 : 0, entryId);
    checkpoint(db);
  } finally { db.close(); }
}

/** Put a playlist's entries in the given order (ids not listed keep their place after). */
export function reorderPlaylist(dbPath: string, playlistId: number, entryIds: number[]): void {
  const db = openRW(dbPath);
  try {
    const all = (db.prepare(`SELECT Id FROM PlaylistItem WHERE PlaylistId=? ORDER BY "Index", Id`).all(playlistId) as any[]).map((r) => r.Id as number);
    const order = [...entryIds.filter((id) => all.includes(id)), ...all.filter((id) => !entryIds.includes(id))];
    const st = db.prepare(`UPDATE PlaylistItem SET "Index"=? WHERE Id=? AND PlaylistId=?`);
    order.forEach((id, i) => st.run(i + 1, id, playlistId));
    checkpoint(db);
  } finally { db.close(); }
}

export function removePlaylistEntry(dbPath: string, entryId: number): void {
  const db = openRW(dbPath);
  try { db.prepare(`DELETE FROM PlaylistItem WHERE Id=?`).run(entryId); checkpoint(db); }
  finally { db.close(); }
}

/** The playlists that already include this media item directly. */
export function playlistsContaining(dbPath: string, itemId: number): { id: number; name: string }[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare(`SELECT DISTINCT p.Id id, p.Name name FROM PlaylistItem pi JOIN Playlist p ON p.Id=pi.PlaylistId WHERE pi.MediaItemId=? ORDER BY p.Name`).all(itemId) as any[])
      .map((r) => ({ id: r.id, name: r.name ?? "(unnamed)" }));
  } finally { db.close(); }
}
