// Local folder scanner — keeps a local (LocalMediaSource) library in sync with
// what is actually on disk, mirroring ErsatzTV legacy behaviour:
//   * new / changed files are ffprobed and upserted into the polymorphic schema
//   * files that vanished from disk are flagged State=FileNotFound (never deleted)
//   * incremental: unchanged files (by mtime) are skipped
//
// It writes into the app's own library.sqlite (a mirror of the legacy schema),
// so the legacy ErsatzTV database is never touched.
//
// Runs fully synchronously (sync node:sqlite + execFileSync ffprobe) so it can be
// spawned as a child process for the API / scheduler without blocking the server.

import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { readSidecarChapters } from "./chapters-sidecar.js";
import { markForReindex } from "../search-index-queue.js";

// ---- enums (from the ErsatzTV schema) --------------------------------------
const State = { Normal: 0, FileNotFound: 1 };
const StreamKind = { Video: 1, Audio: 2, Subtitle: 3 };
const MetaKind = { Fallback: 0 };
// MediaKind: 1 Movie, 2 Show(Episode), 3 MusicVideo, 4 OtherVideo, 5 Song, 6 Image, 7 RemoteStream

const VIDEO_EXT = new Set([".mkv", ".mp4", ".avi", ".mov", ".m4v", ".ts", ".m2ts", ".wmv", ".flv", ".webm", ".mpg", ".mpeg", ".vob", ".ogv", ".3gp", ".divx", ".mts"]);
const AUDIO_EXT = new Set([".mp3", ".flac", ".m4a", ".ogg", ".oga", ".wav", ".aac", ".opus", ".wma", ".alac", ".ape"]);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff", ".tif"]);

function extsForKind(kind: number): Set<string> {
  if (kind === 5) return AUDIO_EXT;
  if (kind === 6) return IMAGE_EXT;
  return VIDEO_EXT; // 1,2,3,4
}

// kind -> table + version foreign-key column
export const KIND_TABLE: Record<number, string> = { 1: "Movie", 2: "Episode", 3: "MusicVideo", 4: "OtherVideo", 5: "Song", 6: "Image" };
export const KIND_FK: Record<number, string> = { 1: "MovieId", 2: "EpisodeId", 3: "MusicVideoId", 4: "OtherVideoId", 5: "SongId", 6: "ImageId" };
export const StateEnum = State;
export const MetaKindEnum = MetaKind;

// ---- helpers ---------------------------------------------------------------
export function tsFromSec(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const frac = Math.round((sec - Math.floor(sec)) * 1e7);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(h)}:${p2(m)}:${p2(s)}.${String(frac).padStart(7, "0")}`;
}
export function dtFmt(ms: number): string {
  // "YYYY-MM-DD HH:MM:SS" in UTC, matching legacy DateAdded/DateUpdated format
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}
export function pathHash(p: string): string {
  return createHash("md5").update(p).digest("hex");
}
function parsePaths(raw: string | null): string[] {
  if (!raw) return [];
  const t = raw.trim();
  if (t.startsWith("{")) {
    try { const o = JSON.parse(t); return Array.isArray(o.paths) ? o.paths.filter(Boolean) : []; } catch { return []; }
  }
  return [t];
}

function walk(root: string, exts: Set<string>, cb: (file: string, mtime: number) => void): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith(".") || e.name === "@eaDir") continue;
      walk(full, exts, cb);
    } else if (e.isFile()) {
      if (!exts.has(path.extname(e.name).toLowerCase())) continue;
      try { const st = fs.statSync(full); cb(full, st.mtimeMs); } catch { /* ignore */ }
    }
  }
}

// ---- ffprobe ---------------------------------------------------------------
interface Stream { index: number; kind: number; codec: string | null; profile: string | null; language: string | null; channels: number; title: string | null; def: number; forced: number; bits: number; pixel: string | null; colorTransfer?: string | null; colorSpace?: string | null; colorPrimaries?: string | null; colorRange?: string | null; }
interface Chapter { id: number; start: string; end: string; title: string | null; }
interface Probe { durationSec: number; width: number; height: number; scan: number; dar: string | null; sar: string | null; rfr: string | null; streams: Stream[]; chapters: Chapter[]; }

function ffprobe(ffprobePath: string, file: string): Probe | null {
  let out: string;
  try {
    out = execFileSync(ffprobePath, ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch { return null; }
  let j: any;
  try { j = JSON.parse(out); } catch { return null; }
  const fmtDur = parseFloat(j.format?.duration ?? "");
  let dur = isFinite(fmtDur) ? fmtDur : 0;
  let width = 0, height = 0, scan = 0;
  let dar: string | null = null, sar: string | null = null, rfr: string | null = null;
  const streams: Stream[] = [];
  for (const s of j.streams ?? []) {
    const ct = s.codec_type;
    const kind = ct === "video" ? StreamKind.Video : ct === "audio" ? StreamKind.Audio : ct === "subtitle" ? StreamKind.Subtitle : 0;
    if (kind === 0) continue;
    if (!isFinite(fmtDur) && s.duration) { const d = parseFloat(s.duration); if (isFinite(d) && d > dur) dur = d; }
    if (kind === StreamKind.Video && width === 0) {
      width = s.width ?? 0; height = s.height ?? 0;
      dar = s.display_aspect_ratio ?? null; sar = s.sample_aspect_ratio ?? null; rfr = s.r_frame_rate ?? null;
      const fo = s.field_order;
      scan = fo === "progressive" ? 2 : (fo && fo !== "unknown") ? 1 : 0;
    }
    streams.push({
      index: s.index ?? 0, kind, codec: s.codec_name ?? null, profile: s.profile ?? null,
      language: s.tags?.language ?? null, channels: s.channels ?? 0, title: s.tags?.title ?? null,
      def: s.disposition?.default ? 1 : 0, forced: s.disposition?.forced ? 1 : 0,
      bits: parseInt(s.bits_per_raw_sample ?? "0", 10) || 0, pixel: s.pix_fmt ?? null,
      colorTransfer: s.color_transfer ?? null, colorSpace: s.color_space ?? null,
      colorPrimaries: s.color_primaries ?? null, colorRange: s.color_range ?? null,
    });
  }
  const chapters: Chapter[] = [];
  for (const c of j.chapters ?? []) {
    chapters.push({ id: c.id ?? chapters.length, start: tsFromSec(parseFloat(c.start_time ?? "0") || 0), end: tsFromSec(parseFloat(c.end_time ?? "0") || 0), title: c.tags?.title ?? null });
  }
  // No embedded chapters? Fall back to a sidecar chapters file next to the media.
  if (chapters.length === 0) { for (const c of readSidecarChapters(file)) chapters.push(c); }
  return { durationSec: dur, width, height, scan, dar, sar, rfr, streams, chapters };
}

// ---- filename metadata parsing --------------------------------------------
function stem(file: string): string { return path.basename(file, path.extname(file)); }

function parseMovie(file: string): { title: string; year: number | null } {
  const base = stem(file);
  let m = /^(.*?)\s*\((\d{4})\)\s*$/.exec(base);
  if (m) return { title: m[1].trim(), year: parseInt(m[2], 10) };
  // year in parent folder e.g. "Title (1999)/movie.mkv"
  const parent = path.basename(path.dirname(file));
  m = /^(.*?)\s*\((\d{4})\)\s*$/.exec(parent);
  if (m) return { title: m[1].trim(), year: parseInt(m[2], 10) };
  return { title: base, year: null };
}

function parseEpisode(file: string): { show: string; season: number; episode: number; title: string } {
  const base = stem(file);
  const parts = file.split(/[\\/]/);
  // season folder like "Season 01" / "Season 1" / "S01" / "Specials"
  let season = NaN;
  let showFromPath = "";
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i];
    let sm = /^Season\s+(\d{1,3})$/i.exec(seg) || /^S(\d{1,3})$/i.exec(seg);
    if (sm) { season = parseInt(sm[1], 10); showFromPath = parts[i - 1] ?? ""; break; }
    if (/^Specials$/i.exec(seg)) { season = 0; showFromPath = parts[i - 1] ?? ""; break; }
  }
  // SxxEyy or NxNN inside filename
  let em = /[Ss](\d{1,3})[Ee](\d{1,4})/.exec(base) || /\b(\d{1,3})x(\d{1,4})\b/.exec(base);
  let episode = NaN;
  if (em) { if (isNaN(season)) season = parseInt(em[1], 10); episode = parseInt(em[2], 10); }
  // title = text after the episode token, cleaned up
  let title = base;
  if (em) {
    const after = base.slice((em.index ?? 0) + em[0].length).replace(/^[\s._-]+/, "").trim();
    if (after) title = after;
  }
  const show = (showFromPath || path.basename(path.dirname(file)) || "Unknown Show").replace(/\s*\(\d{4}\)\s*$/, "").trim();
  return { show, season: isNaN(season) ? 1 : season, episode: isNaN(episode) ? 0 : episode, title };
}

// ---- DB open ---------------------------------------------------------------
export function openRW(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  // WAL lets the server keep reading (Library/Browse tabs) while a scan writes —
  // a scan must never lock the rest of the app out. busy_timeout waits briefly on
  // any momentary contention instead of erroring with SQLITE_BUSY.
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; PRAGMA foreign_keys=OFF; PRAGMA synchronous=NORMAL;");
  migrateSchema(db);
  return db;
}

/** Idempotent schema migrations run whenever the library is opened for writing. */
export function migrateSchema(db: DatabaseSync): void {
  // MediaFile.PathHash must be NON-unique: the same file can legitimately appear
  // in more than one library, and each library owns its own independent MediaFile
  // row. A global UNIQUE index breaks multi-library setups (scan crashes / files
  // stolen between libraries), so downgrade it to a plain (still fast) index.
  try {
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='IX_MediaFile_PathHash'").get() as { sql?: string } | undefined;
    if (idx && /UNIQUE/i.test(idx.sql ?? "")) {
      db.exec('DROP INDEX "IX_MediaFile_PathHash"; CREATE INDEX "IX_MediaFile_PathHash" ON "MediaFile" ("PathHash");');
    }
  } catch { /* best-effort; a locked/edge DB just keeps the old index */ }
  try {
    db.exec("BEGIN");
    if (repairGroupingIds(db) > 0) markForReindex(db, 0); // ids moved: rebuild the whole search index
    db.exec("COMMIT");
  } catch { try { db.exec("ROLLBACK"); } catch { /* not in a transaction */ } }
}

// existing on-disk files already in the library, keyed by lowercase path
interface ExistRec { fileId: number; versionId: number; itemId: number; dateUpdated: string; }
function existingFiles(db: DatabaseSync, libraryId: number, kind: number): Map<string, ExistRec> {
  const tbl = KIND_TABLE[kind], fk = KIND_FK[kind];
  const rows = db.prepare(
    `SELECT mf.Id fileId, mf.Path path, mv.Id versionId, mv.DateUpdated dateUpdated, k.Id itemId
       FROM LibraryPath lp
       JOIN MediaItem mi ON mi.LibraryPathId = lp.Id
       JOIN ${tbl} k ON k.Id = mi.Id
       JOIN MediaVersion mv ON mv.${fk} = k.Id
       JOIN MediaFile mf ON mf.MediaVersionId = mv.Id
      WHERE lp.LibraryId = ?`
  ).all(libraryId) as any[];
  const map = new Map<string, ExistRec>();
  for (const r of rows) {
    if (!r.path) continue;
    map.set(String(r.path).toLowerCase(), { fileId: r.fileId, versionId: r.versionId, itemId: r.itemId, dateUpdated: r.dateUpdated ?? "" });
  }
  return map;
}

function insertStreamsAndChapters(db: DatabaseSync, versionId: number, probe: Probe): void {
  const sIns = db.prepare(
    `INSERT INTO MediaStream ("Index", Codec, Profile, MediaStreamKind, Language, Channels, Title, "Default", "Forced", MediaVersionId, BitsPerRawSample, PixelFormat, ColorTransfer, ColorSpace, ColorPrimaries, ColorRange, AttachedPic)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`
  );
  for (const s of probe.streams) sIns.run(s.index, s.codec, s.profile, s.kind, s.language, s.channels, s.title, s.def, s.forced, versionId, s.bits, s.pixel, s.colorTransfer ?? null, s.colorSpace ?? null, s.colorPrimaries ?? null, s.colorRange ?? null);
  const cIns = db.prepare(`INSERT INTO MediaChapter (MediaVersionId, ChapterId, StartTime, EndTime, Title) VALUES (?,?,?,?,?)`);
  for (const c of probe.chapters) cIns.run(versionId, c.id, c.start, c.end, c.title);
}

/** Deep re-probe one existing local item's file: refresh duration/dimensions +
 *  streams + chapters, ignoring the incremental mtime check. Returns chapter count. */
/** ffprobe just the chapter markers embedded in a file (ground truth, whatever
 *  the provider reports). Returns [] if the file can't be probed. */
export function ffprobeChapters(ffprobePath: string, file: string): { id: number; start: string; end: string; title: string | null }[] {
  const p = ffprobe(ffprobePath, file);
  if (p && p.chapters.length) return p.chapters;   // embedded (already includes sidecar fallback)
  return readSidecarChapters(file);                // ffprobe unavailable/failed — try sidecar directly
}

export function reprobeLocalVersion(db: DatabaseSync, versionId: number, itemId: number, filePath: string, ffprobePath = "ffprobe"): { ok: boolean; chapters: number; streams: number } {
  const probe = ffprobe(ffprobePath, filePath);
  if (!probe) return { ok: false, chapters: 0, streams: 0 };
  db.prepare(`UPDATE MediaVersion SET Duration=?, Width=?, Height=?, VideoScanKind=?, DisplayAspectRatio=?, SampleAspectRatio=?, RFrameRate=?, DateUpdated=? WHERE Id=?`)
    .run(tsFromSec(probe.durationSec), probe.width, probe.height, probe.scan, probe.dar, probe.sar, probe.rfr, dtFmt(Date.now()), versionId);
  db.prepare("DELETE FROM MediaStream WHERE MediaVersionId=?").run(versionId);
  db.prepare("DELETE FROM MediaChapter WHERE MediaVersionId=?").run(versionId);
  insertStreamsAndChapters(db, versionId, probe);
  db.prepare("UPDATE MediaItem SET State=0 WHERE Id=?").run(itemId);
  markForReindex(db, itemId);
  return { ok: true, chapters: probe.chapters.length, streams: probe.streams.length };
}

// find-or-create Show / Season / Artist groupings. In the legacy schema these ARE
// media items (Show.Id / Season.Id / Artist.Id are FKs to MediaItem.Id), so each
// new one gets its own MediaItem row first — inserting into Show directly would
// let its AUTOINCREMENT hand out an id already owned by an episode or movie.
function newGroupingItem(db: DatabaseSync, lpId: number): number {
  return Number((db.prepare("INSERT INTO MediaItem (LibraryPathId, State) VALUES (?, ?)").run(lpId, State.Normal) as any).lastInsertRowid);
}
const SAME_LIBRARY = "mi.LibraryPathId IN (SELECT Id FROM LibraryPath WHERE LibraryId = (SELECT LibraryId FROM LibraryPath WHERE Id = ?))";

/** Find a show by title within the library that owns `lpId` (never across libraries,
 *  so e.g. a local "Night Court" and a Plex "Night Court" stay separate). */
export function findOrCreateShow(db: DatabaseSync, title: string, now: string, lpId: number): number {
  const ex = db.prepare(`SELECT sm.ShowId FROM ShowMetadata sm JOIN MediaItem mi ON mi.Id = sm.ShowId WHERE sm.Title = ? AND ${SAME_LIBRARY} LIMIT 1`).get(title, lpId) as any;
  if (ex) return ex.ShowId;
  const showId = newGroupingItem(db, lpId);
  db.prepare("INSERT INTO Show (Id) VALUES (?)").run(showId);
  db.prepare("INSERT INTO ShowMetadata (ShowId, MetadataKind, Title, SortTitle, DateAdded, DateUpdated) VALUES (?,?,?,?,?,?)").run(showId, MetaKind.Fallback, title, title, now, now);
  return showId;
}
export function findOrCreateSeason(db: DatabaseSync, showId: number, num: number, now: string, lpId: number): number {
  const ex = db.prepare("SELECT Id FROM Season WHERE ShowId = ? AND SeasonNumber = ? LIMIT 1").get(showId, num) as any;
  if (ex) return ex.Id;
  const seasonId = newGroupingItem(db, lpId);
  db.prepare("INSERT INTO Season (Id, ShowId, SeasonNumber) VALUES (?,?,?)").run(seasonId, showId, num);
  db.prepare("INSERT INTO SeasonMetadata (SeasonId, MetadataKind, Title, DateAdded, DateUpdated) VALUES (?,?,?,?,?)").run(seasonId, MetaKind.Fallback, `Season ${num}`, now, now);
  return seasonId;
}
export function findOrCreateArtist(db: DatabaseSync, name: string, now: string, lpId: number): number {
  const ex = db.prepare(`SELECT am.ArtistId FROM ArtistMetadata am JOIN MediaItem mi ON mi.Id = am.ArtistId WHERE am.Title = ? AND ${SAME_LIBRARY} LIMIT 1`).get(name, lpId) as any;
  if (ex) return ex.ArtistId;
  const artistId = newGroupingItem(db, lpId);
  db.prepare("INSERT INTO Artist (Id) VALUES (?)").run(artistId);
  db.prepare("INSERT INTO ArtistMetadata (ArtistId, MetadataKind, Title, SortTitle, DateAdded, DateUpdated) VALUES (?,?,?,?,?,?)").run(artistId, MetaKind.Fallback, name, name, now, now);
  return artistId;
}

// Grouping rows (Show/Season/Artist) that earlier versions created without a
// MediaItem, whose ids therefore collide with real media items (or with each
// other). Each is moved to a fresh MediaItem id and every reference follows it.
const MEDIA_KIND_TABLES = ["Movie", "Episode", "MusicVideo", "OtherVideo", "Song", "Image", "RemoteStream"];
const GROUPINGS = [
  { table: "Show", refs: [["ShowMetadata", "ShowId"], ["Season", "ShowId"]], keyTables: ["PlexShow", "JellyfinShow", "EmbyShow"],
    childLp: "SELECT mi.LibraryPathId lp FROM Season se JOIN Episode e ON e.SeasonId = se.Id JOIN MediaItem mi ON mi.Id = e.Id WHERE se.ShowId = ?" },
  { table: "Season", refs: [["SeasonMetadata", "SeasonId"], ["Episode", "SeasonId"]], keyTables: ["PlexSeason", "JellyfinSeason", "EmbySeason"],
    childLp: "SELECT mi.LibraryPathId lp FROM Episode e JOIN MediaItem mi ON mi.Id = e.Id WHERE e.SeasonId = ?" },
  { table: "Artist", refs: [["ArtistMetadata", "ArtistId"], ["MusicVideo", "ArtistId"]], keyTables: ["JellyfinArtist", "EmbyArtist"],
    childLp: "SELECT mi.LibraryPathId lp FROM MusicVideo m JOIN MediaItem mi ON mi.Id = m.Id WHERE m.ArtistId = ?" },
];

/** Idempotent: returns how many grouping rows were moved to fresh ids. */
export function repairGroupingIds(db: DatabaseSync): number {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name));
  const groupings = GROUPINGS.filter((g) => tables.has(g.table));
  const hasKey = (g: typeof GROUPINGS[number], id: number) => g.keyTables.some((t) => tables.has(t) && db.prepare(`SELECT 1 FROM ${t} WHERE Id = ?`).get(id));
  let moved = 0;
  for (const g of groupings) {
    const others = [...MEDIA_KIND_TABLES, ...groupings.map((x) => x.table)].filter((t) => t !== g.table && tables.has(t));
    const suspects = (db.prepare(
      `SELECT Id FROM ${g.table} WHERE Id NOT IN (SELECT Id FROM MediaItem) ${others.map((t) => `OR Id IN (SELECT Id FROM ${t})`).join(" ")}`
    ).all() as any[]).map((r) => r.Id as number);
    for (const oldId of suspects) {
      // A grouping-vs-grouping collision: keep the one the provider knows (legacy import).
      const collidesWithGrouping = groupings.some((o) => o.table !== g.table && db.prepare(`SELECT 1 FROM ${o.table} WHERE Id = ?`).get(oldId));
      const collidesWithMedia = MEDIA_KIND_TABLES.some((t) => tables.has(t) && db.prepare(`SELECT 1 FROM ${t} WHERE Id = ?`).get(oldId));
      const inMediaItem = !!db.prepare("SELECT 1 FROM MediaItem WHERE Id = ?").get(oldId);
      if (inMediaItem && !collidesWithMedia && collidesWithGrouping && hasKey(g, oldId)) continue;
      // library path: where most of its children live, else its current MediaItem row
      const lps = (db.prepare(g.childLp).all(oldId) as any[]).map((r) => r.lp as number);
      const counts = new Map<number, number>();
      for (const lp of lps) counts.set(lp, (counts.get(lp) ?? 0) + 1);
      let lpId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (lpId == null && !collidesWithMedia && !collidesWithGrouping) lpId = (db.prepare("SELECT LibraryPathId lp FROM MediaItem WHERE Id = ?").get(oldId) as any)?.lp;
      if (lpId == null) continue; // childless and unplaceable: leave it
      const newId = newGroupingItem(db, lpId);
      db.prepare(`UPDATE ${g.table} SET Id = ? WHERE Id = ?`).run(newId, oldId);
      for (const [t, col] of g.refs) if (tables.has(t)) db.prepare(`UPDATE ${t} SET ${col} = ? WHERE ${col} = ?`).run(newId, oldId);
      for (const t of g.keyTables) if (tables.has(t)) db.prepare(`UPDATE ${t} SET Id = ? WHERE Id = ?`).run(newId, oldId);
      moved++;
    }
  }
  return moved;
}

// ErsatzTV behavior: for Other Videos, every subfolder between the library root
// and the file becomes a Tag on the video (so `tag:"Cartoon Network Bumpers"`
// works). Returns the folder segments below the root (excluding the filename).
function folderTagsFor(root: string, file: string): string[] {
  const norm = (s: string) => s.replace(/[\\/]+$/, "");
  const r = norm(root);
  let rel = file.toLowerCase().startsWith(r.toLowerCase()) ? file.slice(r.length) : file;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  parts.pop(); // drop the filename, keep only folder segments
  return parts;
}

/** Apply folder-as-tag for Other Videos. `onlyIfMissing` (used for unchanged files)
 *  backfills tags once without re-writing on every scan. */
function setFolderTags(db: DatabaseSync, kind: number, itemId: number, root: string, file: string, onlyIfMissing = false): void {
  if (kind !== 4) return; // Other Videos only, matching ErsatzTV
  const metaTbl = `${KIND_TABLE[kind]}Metadata`;      // OtherVideoMetadata
  const itemFk = KIND_FK[kind];                        // OtherVideoId
  const tagFk = `${KIND_TABLE[kind]}MetadataId`;       // OtherVideoMetadataId
  const meta = db.prepare(`SELECT Id FROM ${metaTbl} WHERE ${itemFk}=? LIMIT 1`).get(itemId) as any;
  if (!meta) return;
  if (onlyIfMissing && db.prepare(`SELECT 1 FROM Tag WHERE ${tagFk}=? LIMIT 1`).get(meta.Id)) return;
  db.prepare(`DELETE FROM Tag WHERE ${tagFk}=?`).run(meta.Id); // folder tags are the only tag source here
  const ins = db.prepare(`INSERT INTO Tag (${tagFk}, Name) VALUES (?,?)`);
  for (const t of folderTagsFor(root, file)) ins.run(meta.Id, t);
  markForReindex(db, itemId);
}

function insertItem(db: DatabaseSync, kind: number, lpId: number, file: string, mtimeMs: number, now: string, root: string): void {
  const probe = ffprobeCached(file);
  if (!probe) throw new Error("probe-failed");
  const fk = KIND_FK[kind];
  const added = dtFmt(mtimeMs);

  // 1) MediaItem
  const itemId = Number((db.prepare("INSERT INTO MediaItem (LibraryPathId, State) VALUES (?, ?)").run(lpId, State.Normal) as any).lastInsertRowid);

  // 2) kind row + metadata
  if (kind === 2) {
    const info = parseEpisode(file);
    const showId = findOrCreateShow(db, info.show, now, lpId);
    const seasonId = findOrCreateSeason(db, showId, info.season, now, lpId);
    db.prepare("INSERT INTO Episode (Id, SeasonId) VALUES (?, ?)").run(itemId, seasonId);
    db.prepare("INSERT INTO EpisodeMetadata (EpisodeId, MetadataKind, Title, EpisodeNumber, DateAdded, DateUpdated) VALUES (?,?,?,?,?,?)").run(itemId, MetaKind.Fallback, info.title, info.episode, now, now);
  } else if (kind === 3) {
    const artist = path.basename(path.dirname(file)) || "Various Artists";
    const artistId = findOrCreateArtist(db, artist, now, lpId);
    db.prepare("INSERT INTO MusicVideo (Id, ArtistId) VALUES (?, ?)").run(itemId, artistId);
    db.prepare("INSERT INTO MusicVideoMetadata (MusicVideoId, MetadataKind, Title, DateAdded, DateUpdated) VALUES (?,?,?,?,?)").run(itemId, MetaKind.Fallback, stem(file), now, now);
  } else if (kind === 1) {
    const mv = parseMovie(file);
    db.prepare("INSERT INTO Movie (Id) VALUES (?)").run(itemId);
    db.prepare("INSERT INTO MovieMetadata (MovieId, MetadataKind, Title, Year, DateAdded, DateUpdated) VALUES (?,?,?,?,?,?)").run(itemId, MetaKind.Fallback, mv.title, mv.year, now, now);
  } else {
    const tbl = KIND_TABLE[kind];
    db.prepare(`INSERT INTO ${tbl} (Id) VALUES (?)`).run(itemId);
    const metaTbl = `${tbl}Metadata`, metaFk = fk;
    db.prepare(`INSERT INTO ${metaTbl} (${metaFk}, MetadataKind, Title, DateAdded, DateUpdated) VALUES (?,?,?,?,?)`).run(itemId, MetaKind.Fallback, stem(file), now, now);
  }

  // 3) MediaVersion
  const versionId = Number((db.prepare(
    `INSERT INTO MediaVersion (${fk}, Name, DateAdded, DateUpdated, Duration, Width, Height, VideoScanKind, DisplayAspectRatio, SampleAspectRatio, RFrameRate)
     VALUES (?, 'Main', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(itemId, added, added, tsFromSec(probe.durationSec), probe.width, probe.height, probe.scan, probe.dar, probe.sar, probe.rfr) as any).lastInsertRowid);

  // 4) MediaFile + streams + chapters
  db.prepare("INSERT INTO MediaFile (MediaVersionId, Path, PathHash) VALUES (?,?,?)").run(versionId, file, pathHash(file));
  insertStreamsAndChapters(db, versionId, probe);
  setFolderTags(db, kind, itemId, root, file);
  markForReindex(db, itemId);
}

function updateExisting(db: DatabaseSync, rec: ExistRec, file: string, mtimeMs: number): void {
  const probe = ffprobeCached(file);
  if (!probe) throw new Error("probe-failed");
  const updated = dtFmt(mtimeMs);
  db.prepare(
    `UPDATE MediaVersion SET Duration=?, Width=?, Height=?, VideoScanKind=?, DisplayAspectRatio=?, SampleAspectRatio=?, RFrameRate=?, DateUpdated=? WHERE Id=?`
  ).run(tsFromSec(probe.durationSec), probe.width, probe.height, probe.scan, probe.dar, probe.sar, probe.rfr, updated, rec.versionId);
  db.prepare("DELETE FROM MediaStream WHERE MediaVersionId=?").run(rec.versionId);
  db.prepare("DELETE FROM MediaChapter WHERE MediaVersionId=?").run(rec.versionId);
  insertStreamsAndChapters(db, rec.versionId, probe);
  db.prepare("UPDATE MediaItem SET State=? WHERE Id=?").run(State.Normal, rec.itemId);
  markForReindex(db, rec.itemId);
}

// small per-scan ffprobe memo so an item probed for the "changed?" test isn't reprobed
let PROBE_PATH = "ffprobe";
const probeMemo = new Map<string, Probe | null>();
function ffprobeCached(file: string): Probe | null {
  if (probeMemo.has(file)) return probeMemo.get(file)!;
  const p = ffprobe(PROBE_PATH, file);
  probeMemo.set(file, p);
  return p;
}

// ---- public API ------------------------------------------------------------
export interface ScanEvent { phase: string; found?: number; done?: number; total?: number; current?: string; added?: number; updated?: number; missing?: number; }
export interface ScanSummary { libraryId: number; kind: number; found: number; added: number; updated: number; unchanged: number; missing: number; errors: number; ms: number; }

export function scanLocalLibrary(dbPath: string, libraryId: number, opts: { ffprobePath?: string; onEvent?: (e: ScanEvent) => void } = {}): ScanSummary {
  PROBE_PATH = opts.ffprobePath ?? "ffprobe";
  probeMemo.clear();
  const emit = opts.onEvent ?? (() => {});
  const t0 = Date.now();
  const db = openRW(dbPath);
  try {
    const lib = db.prepare("SELECT Id, MediaKind, Name, MediaSourceId FROM Library WHERE Id=?").get(libraryId) as any;
    if (!lib) throw new Error(`Library ${libraryId} not found`);
    const kind = lib.MediaKind;
    if (kind === 7) throw new Error("RemoteStream libraries are not local");
    if (!KIND_TABLE[kind]) throw new Error(`Unsupported media kind ${kind}`);
    const isLocal = db.prepare("SELECT Id FROM LocalMediaSource WHERE Id=?").get(lib.MediaSourceId);
    if (!isLocal) throw new Error(`Library ${libraryId} is not on a local media source`);

    const exts = extsForKind(kind);
    const lpRows = db.prepare("SELECT Id, Path FROM LibraryPath WHERE LibraryId=?").all(libraryId) as any[];

    // walk disk (track the library root each file was found under, for folder tags)
    const found: { lpId: number; root: string; file: string; mtime: number }[] = [];
    for (const lp of lpRows) for (const root of parsePaths(lp.Path)) walk(root, exts, (file, mtime) => found.push({ lpId: lp.Id, root, file, mtime }));
    emit({ phase: "walked", found: found.length });

    const existing = existingFiles(db, libraryId, kind);
    const foundSet = new Set(found.map((f) => f.file.toLowerCase()));

    let added = 0, updated = 0, unchanged = 0, errors = 0;
    db.exec("BEGIN");
    try {
      let i = 0;
      for (const f of found) {
        i++;
        const prev = existing.get(f.file.toLowerCase());
        const stamp = dtFmt(f.mtime);
        try {
          if (prev) {
            if (prev.dateUpdated === stamp) { unchanged++; if ((db.prepare("UPDATE MediaItem SET State=? WHERE Id=? AND State<>?").run(State.Normal, prev.itemId, State.Normal) as any).changes) markForReindex(db, prev.itemId); setFolderTags(db, kind, prev.itemId, f.root, f.file, true); }
            else { updateExisting(db, prev, f.file, f.mtime); setFolderTags(db, kind, prev.itemId, f.root, f.file); updated++; }
          } else { insertItem(db, kind, f.lpId, f.file, f.mtime, dtFmt(Date.now()), f.root); added++; }
        } catch { errors++; }
        // commit periodically so a big scan holds only a short-lived write lock and
        // readers see progress (WAL keeps them unblocked either way).
        if (i % 1000 === 0) { db.exec("COMMIT"); db.exec("BEGIN"); }
        if (i % 25 === 0) emit({ phase: "scanning", done: i, total: found.length, current: path.basename(f.file), added, updated });
      }

      // trash: DB files no longer on disk -> FileNotFound (never delete)
      let missing = 0;
      const flag = db.prepare("UPDATE MediaItem SET State=? WHERE Id=? AND State=?");
      for (const [pl, rec] of existing) if (!foundSet.has(pl)) { const r = flag.run(State.FileNotFound, rec.itemId, State.Normal) as any; if (r.changes) { missing++; markForReindex(db, rec.itemId); } }

      const now = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
      db.prepare("UPDATE Library SET LastScan=? WHERE Id=?").run(now, libraryId);
      db.prepare("UPDATE LibraryPath SET LastScan=? WHERE LibraryId=?").run(now, libraryId);
      db.exec("COMMIT");

      const ms = Date.now() - t0;
      emit({ phase: "done", found: found.length, added, updated, missing });
      return { libraryId, kind, found: found.length, added, updated, unchanged, missing, errors, ms };
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  } finally { db.close(); }
}
