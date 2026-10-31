// -----------------------------------------------------------------------------
// One-time import of the ErsatzTV legacy media library into our own library.sqlite
// -----------------------------------------------------------------------------
// Mirrors the legacy schema exactly for the media/library/source/metadata/
// collection subset (so the existing resolver/search/guide work unchanged), then
// bulk-copies the rows. After this, scheduling no longer needs the source DB;
// scanners maintain library.sqlite going forward (P2/P3). Playout/channel/config
// tables are intentionally left behind — this app owns that side.

import { DatabaseSync } from "node:sqlite";
import { unlinkSync, existsSync } from "node:fs";

/** Use the imported library.sqlite once it exists; otherwise the legacy source. */
export function effectiveDbPath(libraryDbPath: string, etvDbPath: string): string {
  return libraryDbPath && existsSync(libraryDbPath) ? libraryDbPath : etvDbPath;
}

/** Tables to import (media library subset). Everything else (playout/channel/
 *  scheduling/config/Trakt/EF) stays in the source DB and is not needed here. */
export function includeTable(t: string): boolean {
  return (
    /^(MediaItem|MediaVersion|MediaFile|MediaStream|MediaChapter)$/.test(t) ||
    /^(Movie|Show|Season|Episode|MusicVideo|OtherVideo|Song|Image|Artist|RemoteStream)$/.test(t) ||
    /Metadata$/.test(t) ||
    /^(Genre|Tag|Studio|Actor|Director|Writer|MetadataGuid|Artwork|Subtitle|Mood|Style|LanguageCode|MusicVideoArtist)$/.test(t) ||
    /^(Library|LibraryPath|LibraryFolder|ImageFolderDuration)$/.test(t) ||
    /MediaSource$/.test(t) ||
    /^(Plex|Jellyfin|Emby)(Connection|Library|PathReplacement|PathInfo|Movie|Show|Season|Episode|OtherVideo|MediaFile|Collection)$/.test(t) ||
    /^Local(MediaSource|Library)$/.test(t) ||
    /^(Collection|CollectionItem|CollectionEnumeratorState|SmartCollection|MultiCollection|MultiCollectionItem|MultiCollectionSmartItem|Playlist|PlaylistGroup|PlaylistItem)$/.test(t) ||
    /^(TraktList|TraktListItem)$/.test(t) // the trakt_list search field
  );
}

export interface ImportProgress { table: string; rows: number; index: number; total: number; }
export interface ImportResult { tables: number; rows: number; ms: number; dest: string; perTable: Record<string, number>; }

function uri(p: string): string {
  const fwd = p.replace(/\\/g, "/").replace(/ /g, "%20");
  const base = /^[A-Za-z]:/.test(fwd) ? `file:///${fwd}` : fwd.startsWith("/") ? `file://${fwd}` : `file:${fwd}`;
  return `${base}?immutable=1`;
}

export function importLibrary(srcPath: string, destPath: string, onProgress?: (p: ImportProgress) => void): ImportResult {
  const t0 = Date.now();
  // start clean so a re-import fully replaces
  for (const suffix of ["", "-wal", "-shm"]) { try { if (existsSync(destPath + suffix)) unlinkSync(destPath + suffix); } catch {} }

  const src = new DatabaseSync(uri(srcPath), { readOnly: true });
  const dest = new DatabaseSync(destPath);
  dest.exec("PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF; PRAGMA foreign_keys = OFF;");

  const allTables: string[] = (src.prepare(`SELECT name, sql FROM sqlite_master WHERE type='table'`).all() as any[])
    .filter((r) => includeTable(r.name)).map((r) => r.name);

  // 1) create tables (schema mirrored verbatim)
  const createStmt = src.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`);
  for (const t of allTables) {
    const sql = (createStmt.get(t) as any)?.sql;
    if (sql) dest.exec(sql);
  }

  // 2) copy rows, one table at a time, in a transaction
  const perTable: Record<string, number> = {};
  let totalRows = 0;
  let i = 0;
  for (const t of allTables) {
    i++;
    const cols = (src.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name);
    if (cols.length === 0) continue;
    const colList = cols.map((c) => `"${c}"`).join(", ");
    const placeholders = cols.map(() => "?").join(", ");
    const ins = dest.prepare(`INSERT INTO "${t}" (${colList}) VALUES (${placeholders})`);
    const rows = src.prepare(`SELECT ${colList} FROM "${t}"`).all() as any[];
    dest.exec("BEGIN");
    for (const r of rows) ins.run(...cols.map((c) => (r as any)[c]));
    dest.exec("COMMIT");
    perTable[t] = rows.length;
    totalRows += rows.length;
    onProgress?.({ table: t, rows: rows.length, index: i, total: allTables.length });
  }

  // 3) recreate indexes (after data = faster). MediaFile.PathHash is made
  //    NON-unique so the same file can live in multiple libraries independently.
  const idxRows = src.prepare(`SELECT name, sql, tbl_name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL`).all() as any[];
  for (const r of idxRows) if (includeTable(r.tbl_name)) {
    const sql = r.name === "IX_MediaFile_PathHash" ? String(r.sql).replace(/UNIQUE\s+/i, "") : r.sql;
    try { dest.exec(sql); } catch {}
  }

  dest.exec("PRAGMA optimize;");
  src.close(); dest.close();
  return { tables: allTables.length, rows: totalRows, ms: Date.now() - t0, dest: destPath, perTable };
}
