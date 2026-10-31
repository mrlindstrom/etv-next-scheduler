// -----------------------------------------------------------------------------
// Read/manage the imported media library (library.sqlite) — sources, libraries,
// and trash. Matches legacy MediaItem.State semantics:
//   0 Normal · 1 FileNotFound (trash) · 2 Unavailable (trash) · 3 RemoteOnly (Plex/Jellyfin, NOT trash)
// Missing files are only ever FLAGGED by scanning; deletion is manual (empty trash).
// -----------------------------------------------------------------------------
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { markForReindex } from "../search-index-queue.js";

export const STATE = { Normal: 0, FileNotFound: 1, Unavailable: 2, RemoteOnly: 3 } as const;
const TRASH_STATES = [STATE.FileNotFound, STATE.Unavailable];

const KIND_NAME: Record<number, string> = { 1: "Movies", 2: "Shows", 3: "Music Videos", 4: "Other Videos", 5: "Songs", 6: "Images", 7: "Remote Streams" };

export interface SourceInfo { id: number; type: string; name: string; libraries: number; items: number; }
export interface LibraryInfo { id: number; name: string; kind: string; kindId: number; sourceId: number; sourceType: string; sourceName: string; lastScan: string | null; present: number; missing: number; remote: number; paths: string[]; }
export interface TrashItem { id: number; state: number; stateName: string; path: string | null; }

function open(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // WAL (not DELETE) so these connections coexist with an in-progress scan: a read
  // for the Library tab must not block behind a scanning writer. Forcing DELETE
  // here would try to flip the journal mode and deadlock behind the WAL writer.
  // busy_timeout waits out brief contention. foreign_keys OFF: some referenced
  // tables (e.g. Channel via Artwork.ChannelId) aren't imported, so cascades are
  // manual.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = OFF;");
  return db;
}

// media-item kinds that ARE media items (Id == MediaItem.Id)
const ITEM_KINDS = [
  { kind: "Episode", meta: "EpisodeMetadata", fk: "EpisodeId", metaFk: "EpisodeMetadataId" },
  { kind: "Movie", meta: "MovieMetadata", fk: "MovieId", metaFk: "MovieMetadataId" },
  { kind: "OtherVideo", meta: "OtherVideoMetadata", fk: "OtherVideoId", metaFk: "OtherVideoMetadataId" },
  { kind: "MusicVideo", meta: "MusicVideoMetadata", fk: "MusicVideoId", metaFk: "MusicVideoMetadataId" },
  { kind: "Song", meta: "SongMetadata", fk: "SongId", metaFk: "SongMetadataId" },
  { kind: "Image", meta: "ImageMetadata", fk: "ImageId", metaFk: "ImageMetadataId" },
  { kind: "RemoteStream", meta: "RemoteStreamMetadata", fk: "RemoteStreamId", metaFk: "RemoteStreamMetadataId" },
];
const META_BITS = ["Genre", "Tag", "Studio", "Actor", "Director", "Writer", "Artwork", "MetadataGuid", "Subtitle", "Mood", "Style"];

/** Manually cascade-delete media items and all their dependents (FKs are off). */
function deleteMediaItems(db: DatabaseSync, ids: number[]): void {
  if (!ids.length) return;
  markForReindex(db, ids); // their search documents go away (and their shows/seasons shrink)
  const del = (sql: string) => { try { db.prepare(sql).run(); } catch { /* table/col may not exist */ } };
  const sel = (sql: string): number[] => { try { return (db.prepare(sql).all() as any[]).map((r) => r.Id); } catch { return []; } };
  const IN = `(${ids.join(",")})`;
  // versions -> files/streams/chapters
  const vids = sel(`SELECT Id FROM MediaVersion WHERE ${ITEM_KINDS.map((k) => `${k.fk} IN ${IN}`).join(" OR ")}`);
  if (vids.length) {
    const VIN = `(${vids.join(",")})`;
    for (const t of ["MediaFile", "MediaStream", "MediaChapter"]) del(`DELETE FROM ${t} WHERE MediaVersionId IN ${VIN}`);
    del(`DELETE FROM MediaVersion WHERE Id IN ${VIN}`);
  }
  // per-kind metadata + its meta-bits
  for (const k of ITEM_KINDS) {
    const metaIds = sel(`SELECT Id FROM ${k.meta} WHERE ${k.fk} IN ${IN}`);
    if (metaIds.length) {
      const MIN = `(${metaIds.join(",")})`;
      for (const b of META_BITS) del(`DELETE FROM ${b} WHERE ${k.metaFk} IN ${MIN}`);
      del(`DELETE FROM ${k.meta} WHERE Id IN ${MIN}`);
    }
    del(`DELETE FROM ${k.kind} WHERE Id IN ${IN}`);
  }
  del(`DELETE FROM CollectionItem WHERE MediaItemId IN ${IN}`);
  db.prepare(`DELETE FROM MediaItem WHERE Id IN ${IN}`).run();
}
function withDb<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const db = open(path); try { return fn(db); } finally { db.close(); }
}
export function libraryExists(path: string): boolean { return !!path && existsSync(path); }

const stateName = (s: number) => (Object.entries(STATE).find(([, v]) => v === s)?.[0] ?? `State${s}`);

function sourceTypeExpr(alias = "ms") {
  return `CASE
    WHEN (SELECT 1 FROM LocalMediaSource x WHERE x.Id=${alias}.Id) THEN 'local'
    WHEN (SELECT 1 FROM PlexMediaSource x WHERE x.Id=${alias}.Id) THEN 'plex'
    WHEN (SELECT 1 FROM JellyfinMediaSource x WHERE x.Id=${alias}.Id) THEN 'jellyfin'
    WHEN (SELECT 1 FROM EmbyMediaSource x WHERE x.Id=${alias}.Id) THEN 'emby'
    ELSE 'unknown' END`;
}
function sourceNameExpr(alias = "ms") {
  return `COALESCE(
    (SELECT ServerName FROM PlexMediaSource x WHERE x.Id=${alias}.Id),
    (SELECT ServerName FROM JellyfinMediaSource x WHERE x.Id=${alias}.Id),
    (SELECT ServerName FROM EmbyMediaSource x WHERE x.Id=${alias}.Id),
    'Local')`;
}

// --- path replacements (map a source's media paths to locally-readable paths) --
export interface PathReplacementRow { id: number; remote: string; local: string; }
const PR_TABLE: Record<string, { table: string; remoteCol: string; fk: string }> = {
  plex: { table: "PlexPathReplacement", remoteCol: "PlexPath", fk: "PlexMediaSourceId" },
  jellyfin: { table: "JellyfinPathReplacement", remoteCol: "JellyfinPath", fk: "JellyfinMediaSourceId" },
  emby: { table: "EmbyPathReplacement", remoteCol: "EmbyPath", fk: "EmbyMediaSourceId" },
};
function sourceKind(db: DatabaseSync, sourceId: number): string {
  for (const [k, tbl] of [["plex", "PlexMediaSource"], ["jellyfin", "JellyfinMediaSource"], ["emby", "EmbyMediaSource"], ["local", "LocalMediaSource"]] as const) {
    try { if (db.prepare(`SELECT 1 FROM ${tbl} WHERE Id=?`).get(sourceId)) return k; } catch { /* table may be absent */ }
  }
  return "unknown";
}

export function listPathReplacements(path: string, sourceId: number): { sourceType: string; replacements: PathReplacementRow[] } {
  return withDb(path, (db) => {
    const st = sourceKind(db, sourceId);
    const cfg = PR_TABLE[st];
    if (!cfg) return { sourceType: st, replacements: [] };
    try {
      const rows = db.prepare(`SELECT Id id, ${cfg.remoteCol} remote, LocalPath local FROM ${cfg.table} WHERE ${cfg.fk}=? ORDER BY Id`).all(sourceId) as any[];
      return { sourceType: st, replacements: rows.map((r) => ({ id: r.id, remote: r.remote ?? "", local: r.local ?? "" })) };
    } catch { return { sourceType: st, replacements: [] }; }
  });
}
export function addPathReplacement(path: string, sourceId: number, remote: string, local: string): number {
  return withDb(path, (db) => {
    const cfg = PR_TABLE[sourceKind(db, sourceId)];
    if (!cfg) throw new Error("This source type doesn't use path replacements.");
    return Number(db.prepare(`INSERT INTO ${cfg.table} (${cfg.remoteCol}, LocalPath, ${cfg.fk}) VALUES (?,?,?)`).run(remote, local, sourceId).lastInsertRowid);
  });
}
export function updatePathReplacement(path: string, sourceId: number, id: number, remote: string, local: string): void {
  withDb(path, (db) => {
    const cfg = PR_TABLE[sourceKind(db, sourceId)];
    if (!cfg) return;
    db.prepare(`UPDATE ${cfg.table} SET ${cfg.remoteCol}=?, LocalPath=? WHERE Id=? AND ${cfg.fk}=?`).run(remote, local, id, sourceId);
  });
}
export function removePathReplacement(path: string, sourceId: number, id: number): void {
  withDb(path, (db) => {
    const cfg = PR_TABLE[sourceKind(db, sourceId)];
    if (!cfg) return;
    db.prepare(`DELETE FROM ${cfg.table} WHERE Id=? AND ${cfg.fk}=?`).run(id, sourceId);
  });
}

export function listLibraries(path: string): LibraryInfo[] {
  return withDb(path, (db) => {
    // one pass over MediaItem for counts by (library, state)
    const counts = new Map<number, { present: number; missing: number; remote: number }>();
    for (const r of db.prepare(`
      SELECT lp.LibraryId AS lid, mi.State AS st, COUNT(*) AS c
      FROM MediaItem mi JOIN LibraryPath lp ON lp.Id = mi.LibraryPathId
      GROUP BY lp.LibraryId, mi.State`).all() as any[]) {
      const e = counts.get(r.lid) ?? { present: 0, missing: 0, remote: 0 };
      if (r.st === STATE.Normal) e.present += r.c;
      else if (r.st === STATE.RemoteOnly) e.remote += r.c;
      else e.missing += r.c;
      counts.set(r.lid, e);
    }
    // type/name per source id
    const srcType = new Map<number, string>(); const srcName = new Map<number, string>();
    for (const s of db.prepare(`SELECT ms.Id AS id, ${sourceTypeExpr("ms")} AS type, ${sourceNameExpr("ms")} AS name FROM MediaSource ms`).all() as any[]) {
      srcType.set(s.id, s.type); srcName.set(s.id, s.name);
    }
    const paths = new Map<number, string[]>();
    for (const p of db.prepare(`SELECT LibraryId AS lid, Path AS path FROM LibraryPath ORDER BY Path`).all() as any[]) {
      const a = paths.get(p.lid) ?? []; if (p.path) a.push(p.path); paths.set(p.lid, a);
    }
    return (db.prepare(`SELECT Id AS id, Name AS name, MediaKind AS kindId, MediaSourceId AS sourceId, LastScan AS lastScan FROM Library ORDER BY Name`).all() as any[])
      .map((l) => {
        const c = counts.get(l.id) ?? { present: 0, missing: 0, remote: 0 };
        return {
          id: l.id, name: l.name ?? "(unnamed)", kind: KIND_NAME[l.kindId] ?? `Kind ${l.kindId}`, kindId: l.kindId,
          sourceId: l.sourceId, sourceType: srcType.get(l.sourceId) ?? "unknown", sourceName: srcName.get(l.sourceId) ?? "?",
          lastScan: l.lastScan, present: c.present, missing: c.missing, remote: c.remote, paths: paths.get(l.id) ?? [],
        };
      });
  });
}

const LOCAL_KINDS = new Set([1, 2, 3, 4, 5, 6]); // everything except RemoteStream(7)

/** Create a new local library (its own Local media source if none exists yet). */
export function createLocalLibrary(path: string, opts: { name: string; kind: number; paths: string[] }): LibraryInfo {
  const name = (opts.name || "").trim();
  if (!name) throw new Error("A library name is required.");
  if (!LOCAL_KINDS.has(opts.kind)) throw new Error(`Invalid media kind ${opts.kind}.`);
  const paths = opts.paths.map((p) => p.trim()).filter(Boolean);
  if (!paths.length) throw new Error("At least one folder path is required.");
  for (const p of paths) if (!existsSync(p)) throw new Error(`Folder not found on the server: ${p}`);

  return withDb(path, (db) => {
    db.exec("BEGIN");
    try {
      // reuse an existing local source, else create MediaSource + LocalMediaSource
      let src = db.prepare("SELECT Id FROM LocalMediaSource LIMIT 1").get() as any;
      let sourceId: number;
      if (src) sourceId = src.Id;
      else {
        sourceId = Number((db.prepare("INSERT INTO MediaSource DEFAULT VALUES").run() as any).lastInsertRowid);
        db.prepare("INSERT INTO LocalMediaSource (Id) VALUES (?)").run(sourceId);
      }
      const libraryId = Number((db.prepare("INSERT INTO Library (Name, MediaKind, MediaSourceId) VALUES (?,?,?)").run(name, opts.kind, sourceId) as any).lastInsertRowid);
      const ins = db.prepare("INSERT INTO LibraryPath (Path, LibraryId) VALUES (?,?)");
      for (const p of paths) ins.run(p, libraryId);
      db.exec("COMMIT");
      return {
        id: libraryId, name, kind: KIND_NAME[opts.kind] ?? `Kind ${opts.kind}`, kindId: opts.kind,
        sourceId, sourceType: "local", sourceName: "Local", lastScan: null, present: 0, missing: 0, remote: 0, paths,
      };
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  });
}

// ---- local library folder (LibraryPath) management -------------------------
export interface LibraryPathInfo { id: number; path: string; present: number; missing: number; }
export function listLibraryPaths(path: string, libraryId: number): LibraryPathInfo[] {
  return withDb(path, (db) => (db.prepare(
    `SELECT lp.Id id, lp.Path path,
       (SELECT COUNT(*) FROM MediaItem mi WHERE mi.LibraryPathId=lp.Id AND mi.State=0) present,
       (SELECT COUNT(*) FROM MediaItem mi WHERE mi.LibraryPathId=lp.Id AND mi.State IN (1,2)) missing
     FROM LibraryPath lp WHERE lp.LibraryId=? ORDER BY lp.Id`
  ).all(libraryId) as any[]).map((r) => ({ id: r.id, path: r.path, present: r.present, missing: r.missing })));
}

function assertLocalFolder(db: DatabaseSync, libraryId: number): void {
  const src = db.prepare(`SELECT ms.Id FROM Library l JOIN MediaSource ms ON ms.Id=l.MediaSourceId JOIN LocalMediaSource lms ON lms.Id=ms.Id WHERE l.Id=?`).get(libraryId);
  if (!src) throw new Error("Folders can only be managed on local libraries.");
}
export function addLibraryPath(path: string, libraryId: number, folder: string): LibraryPathInfo {
  const f = (folder || "").trim();
  if (!f) throw new Error("A folder path is required.");
  if (!existsSync(f)) throw new Error(`Folder not found on the server: ${f}`);
  return withDb(path, (db) => {
    assertLocalFolder(db, libraryId);
    if (db.prepare(`SELECT 1 FROM LibraryPath WHERE LibraryId=? AND Path=?`).get(libraryId, f)) throw new Error("That folder is already in this library.");
    const id = Number((db.prepare(`INSERT INTO LibraryPath (Path, LibraryId) VALUES (?,?)`).run(f, libraryId) as any).lastInsertRowid);
    return { id, path: f, present: 0, missing: 0 };
  });
}
export function updateLibraryPath(path: string, pathId: number, folder: string): { ok: boolean } {
  const f = (folder || "").trim();
  if (!f) throw new Error("A folder path is required.");
  if (!existsSync(f)) throw new Error(`Folder not found on the server: ${f}`);
  return withDb(path, (db) => {
    const row = db.prepare(`SELECT LibraryId FROM LibraryPath WHERE Id=?`).get(pathId) as any;
    if (!row) throw new Error(`Folder ${pathId} not found.`);
    assertLocalFolder(db, row.LibraryId);
    db.prepare(`UPDATE LibraryPath SET Path=? WHERE Id=?`).run(f, pathId);
    return { ok: true };
  });
}
/** Remove one folder from a local library, cascade-deleting its items. */
export function removeLibraryPath(path: string, pathId: number): { deleted: number } {
  return withDb(path, (db) => {
    const row = db.prepare(`SELECT LibraryId FROM LibraryPath WHERE Id=?`).get(pathId) as any;
    if (!row) return { deleted: 0 };
    assertLocalFolder(db, row.LibraryId);
    const count = (db.prepare(`SELECT COUNT(*) n FROM LibraryPath WHERE LibraryId=?`).get(row.LibraryId) as any).n;
    if (count <= 1) throw new Error("Can't remove the only folder — remove the whole library instead.");
    const ids = (db.prepare(`SELECT Id FROM MediaItem WHERE LibraryPathId=?`).all(pathId) as any[]).map((r) => r.Id);
    db.exec("BEGIN");
    try {
      deleteMediaItems(db, ids);
      try { db.prepare(`DELETE FROM LibraryFolder WHERE LibraryPathId=?`).run(pathId); } catch {}
      db.prepare(`DELETE FROM LibraryPath WHERE Id=?`).run(pathId);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    return { deleted: ids.length };
  });
}

// ---- add a remote source (Plex/Jellyfin/Emby) ------------------------------
export function addRemoteSource(path: string, opts: { type: "plex" | "jellyfin" | "emby"; serverName: string; address: string }): { sourceId: number } {
  const name = (opts.serverName || "").trim() || `${opts.type} server`;
  const address = (opts.address || "").trim();
  if (!/^https?:\/\//i.test(address)) throw new Error("Enter a full server address, e.g. http://10.0.0.5:32400");
  return withDb(path, (db) => {
    db.exec("BEGIN");
    try {
      const sourceId = Number((db.prepare("INSERT INTO MediaSource DEFAULT VALUES").run() as any).lastInsertRowid);
      if (opts.type === "plex") {
        db.prepare("INSERT INTO PlexMediaSource (Id, ServerName) VALUES (?,?)").run(sourceId, name);
        db.prepare("INSERT INTO PlexConnection (IsActive, Uri, PlexMediaSourceId) VALUES (1,?,?)").run(address, sourceId);
      } else if (opts.type === "jellyfin") {
        db.prepare("INSERT INTO JellyfinMediaSource (Id, ServerName) VALUES (?,?)").run(sourceId, name);
        db.prepare("INSERT INTO JellyfinConnection (Address, JellyfinMediaSourceId) VALUES (?,?)").run(address, sourceId);
      } else {
        db.prepare("INSERT INTO EmbyMediaSource (Id, ServerName) VALUES (?,?)").run(sourceId, name);
        db.prepare("INSERT INTO EmbyConnection (Address, EmbyMediaSourceId) VALUES (?,?)").run(address, sourceId);
      }
      db.exec("COMMIT");
      return { sourceId };
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  });
}

/** Create Library + provider-library + LibraryPath rows for libraries discovered
 *  from a provider that don't already exist for this source. */
export function upsertDiscoveredLibraries(path: string, sourceId: number, type: "plex" | "jellyfin" | "emby", discovered: { providerKey: string; name: string; kind: number; locations: string[] }[]): { added: number; libraries: { id: number; name: string; kind: string }[] } {
  return withDb(path, (db) => {
    const linkT = type === "plex" ? "PlexLibrary" : type === "jellyfin" ? "JellyfinLibrary" : "EmbyLibrary";
    const linkCol = type === "plex" ? "Key" : "ItemId";
    const added: { id: number; name: string; kind: string }[] = [];
    db.exec("BEGIN");
    try {
      for (const d of discovered) {
        const exists = db.prepare(`SELECT 1 FROM ${linkT} WHERE ${linkCol}=?`).get(d.providerKey);
        if (exists) continue;
        const libId = Number((db.prepare("INSERT INTO Library (Name, MediaKind, MediaSourceId) VALUES (?,?,?)").run(d.name, d.kind, sourceId) as any).lastInsertRowid);
        try { db.prepare(`INSERT INTO ${linkT} (Id, ${linkCol}, ShouldSyncItems) VALUES (?,?,1)`).run(libId, d.providerKey); }
        catch { db.prepare(`INSERT INTO ${linkT} (Id, ${linkCol}) VALUES (?,?)`).run(libId, d.providerKey); }
        db.prepare("INSERT INTO LibraryPath (Path, LibraryId) VALUES (?,?)").run(JSON.stringify({ paths: d.locations }), libId);
        added.push({ id: libId, name: d.name, kind: KIND_NAME[d.kind] ?? `Kind ${d.kind}` });
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    return { added: added.length, libraries: added };
  });
}

/** Remove a library and everything under it (items/versions/files/metadata, its
 *  LibraryPaths/folders, and the provider link row). Never touches the legacy DB. */
export function deleteLibrary(path: string, libraryId: number): { deleted: number } {
  return withDb(path, (db) => {
    const ids = (db.prepare(
      `SELECT mi.Id AS id FROM MediaItem mi JOIN LibraryPath lp ON lp.Id = mi.LibraryPathId WHERE lp.LibraryId = ?`
    ).all(libraryId) as any[]).map((r) => r.id);
    db.exec("BEGIN");
    try {
      deleteMediaItems(db, ids);
      const del = (sql: string, ...a: any[]) => { try { db.prepare(sql).run(...a); } catch { /* table may not exist */ } };
      for (const t of ["PlexLibrary", "JellyfinLibrary", "EmbyLibrary"]) del(`DELETE FROM ${t} WHERE Id = ?`, libraryId);
      del(`DELETE FROM LibraryFolder WHERE LibraryPathId IN (SELECT Id FROM LibraryPath WHERE LibraryId = ?)`, libraryId);
      del(`DELETE FROM LibraryPath WHERE LibraryId = ?`, libraryId);
      db.prepare(`DELETE FROM Library WHERE Id = ?`).run(libraryId);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    db.exec("PRAGMA optimize;");
    return { deleted: ids.length };
  });
}

/** Delete a whole media source: all its libraries + items, its connection/path
 *  rows, and the source record. Never touches the legacy DB or your files. */
export function deleteSource(path: string, sourceId: number): { deletedLibraries: number; deletedItems: number } {
  return withDb(path, (db) => {
    const libIds = (db.prepare(`SELECT Id FROM Library WHERE MediaSourceId=?`).all(sourceId) as any[]).map((r) => r.Id);
    const del = (sql: string, ...a: any[]) => { try { db.prepare(sql).run(...a); } catch { /* table may not exist */ } };
    let deletedItems = 0;
    db.exec("BEGIN");
    try {
      for (const libId of libIds) {
        const ids = (db.prepare(`SELECT mi.Id id FROM MediaItem mi JOIN LibraryPath lp ON lp.Id=mi.LibraryPathId WHERE lp.LibraryId=?`).all(libId) as any[]).map((r) => r.id);
        deleteMediaItems(db, ids);
        deletedItems += ids.length;
        for (const t of ["PlexLibrary", "JellyfinLibrary", "EmbyLibrary"]) del(`DELETE FROM ${t} WHERE Id=?`, libId);
        del(`DELETE FROM LibraryFolder WHERE LibraryPathId IN (SELECT Id FROM LibraryPath WHERE LibraryId=?)`, libId);
        del(`DELETE FROM LibraryPath WHERE LibraryId=?`, libId);
        db.prepare(`DELETE FROM Library WHERE Id=?`).run(libId);
      }
      // connection / path-replacement / provider-source / media-source rows
      del(`DELETE FROM PlexConnection WHERE PlexMediaSourceId=?`, sourceId);
      del(`DELETE FROM PlexPathReplacement WHERE PlexMediaSourceId=?`, sourceId);
      del(`DELETE FROM JellyfinConnection WHERE JellyfinMediaSourceId=?`, sourceId);
      del(`DELETE FROM JellyfinPathReplacement WHERE JellyfinMediaSourceId=?`, sourceId);
      del(`DELETE FROM EmbyConnection WHERE EmbyMediaSourceId=?`, sourceId);
      del(`DELETE FROM EmbyPathReplacement WHERE EmbyMediaSourceId=?`, sourceId);
      for (const t of ["PlexMediaSource", "JellyfinMediaSource", "EmbyMediaSource", "LocalMediaSource"]) del(`DELETE FROM ${t} WHERE Id=?`, sourceId);
      db.prepare(`DELETE FROM MediaSource WHERE Id=?`).run(sourceId);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    db.exec("PRAGMA optimize;");
    return { deletedLibraries: libIds.length, deletedItems };
  });
}

export function listSources(path: string): SourceInfo[] {
  return withDb(path, (db) => {
    // library + item counts per source (may be 0 for a freshly-added source)
    const libCount = new Map<number, number>();
    for (const r of db.prepare(`SELECT MediaSourceId sid, COUNT(*) n FROM Library GROUP BY MediaSourceId`).all() as any[]) libCount.set(r.sid, r.n);
    const itemCount = new Map<number, number>();
    for (const r of db.prepare(
      `SELECT l.MediaSourceId sid, COUNT(*) n FROM MediaItem mi
         JOIN LibraryPath lp ON lp.Id = mi.LibraryPathId JOIN Library l ON l.Id = lp.LibraryId
        WHERE mi.State IN (${STATE.Normal}, ${STATE.RemoteOnly}) GROUP BY l.MediaSourceId`).all() as any[]) itemCount.set(r.sid, r.n);
    // enumerate EVERY media source, even ones with no libraries yet
    return (db.prepare(`SELECT ms.Id id, ${sourceTypeExpr("ms")} type, ${sourceNameExpr("ms")} name FROM MediaSource ms`).all() as any[])
      .map((r) => ({ id: r.id, type: r.type, name: r.name, libraries: libCount.get(r.id) ?? 0, items: itemCount.get(r.id) ?? 0 }))
      .sort((a, b) => a.id - b.id);
  });
}

export function listTrash(path: string, limit = 100, offset = 0): { total: number; items: TrashItem[] } {
  return withDb(path, (db) => {
    const inList = TRASH_STATES.join(",");
    const total = (db.prepare(`SELECT COUNT(*) c FROM MediaItem WHERE State IN (${inList})`).get() as any).c;
    const items = (db.prepare(`
      SELECT mi.Id AS id, mi.State AS state,
        (SELECT mf.Path FROM MediaVersion mv JOIN MediaFile mf ON mf.MediaVersionId = mv.Id
           WHERE mv.EpisodeId=mi.Id OR mv.MovieId=mi.Id OR mv.OtherVideoId=mi.Id
              OR mv.MusicVideoId=mi.Id OR mv.SongId=mi.Id OR mv.ImageId=mi.Id LIMIT 1) AS path
      FROM MediaItem mi WHERE mi.State IN (${inList}) ORDER BY mi.Id LIMIT ? OFFSET ?`).all(limit, offset) as any[])
      .map((r) => ({ id: r.id, state: r.state, stateName: stateName(r.state), path: r.path ?? null }));
    return { total, items };
  });
}

/** Permanently delete trashed items. FK ON DELETE CASCADE removes versions/files/
 *  streams/chapters/metadata. Returns how many media items were removed. */
export function emptyTrash(path: string): { deleted: number } {
  return withDb(path, (db) => {
    const inList = TRASH_STATES.join(",");
    const ids = (db.prepare(`SELECT Id FROM MediaItem WHERE State IN (${inList})`).all() as any[]).map((r) => r.Id);
    db.exec("BEGIN");
    deleteMediaItems(db, ids);
    db.exec("COMMIT");
    db.exec("PRAGMA optimize;");
    return { deleted: ids.length };
  });
}
