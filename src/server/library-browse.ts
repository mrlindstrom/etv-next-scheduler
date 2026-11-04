// Media browser over library.sqlite — mirrors ErsatzTV legacy's media pages:
// browse by kind, drill Shows -> Seasons -> Episodes, and resolve poster/thumb
// artwork (served by proxying the provider, e.g. Plex, like legacy did).
import { DatabaseSync } from "node:sqlite";

/** Whether a path is one of the library's media files (so a page may read frames from it). */
export function isLibraryFile(dbPath: string, path: string): boolean {
  const db = open(dbPath);
  try { return !!db.prepare("SELECT 1 FROM MediaFile WHERE Path = ? LIMIT 1").get(path); } finally { db.close(); }
}

function open(dbPath: string): DatabaseSync {
  // A normal read-only handle sees what a scan just wrote (still in the WAL);
  // `immutable` ignores the WAL, so it's only the fallback for filesystems where a
  // normal handle opens but can't read (FUSE/network mounts) — as the resolver does.
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { db.exec("PRAGMA busy_timeout=10000;"); db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get(); return db; }
    catch (e) { db.close(); throw e; }
  } catch { return new DatabaseSync(`file:${dbPath}?immutable=1`, { readOnly: true }); }
}

function tsToMs(ts: string | null): number {
  if (!ts) return 0;
  const m = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(ts.trim());
  if (!m) return 0;
  const [, d, h, mm, s, frac] = m;
  let ms = ((+(d ?? 0)) * 86400 + (+h) * 3600 + (+mm) * 60 + (+s)) * 1000;
  if (frac) ms += Math.round(Number("0." + frac) * 1000);
  return ms;
}

// type -> { kind table, version fk, metadata table + item fk, Artwork fk column }
interface KindCfg { table: string; vfk: string; meta: string; ifk: string; artFk: string; }
const KIND: Record<string, KindCfg> = {
  movie: { table: "Movie", vfk: "MovieId", meta: "MovieMetadata", ifk: "MovieId", artFk: "MovieMetadataId" },
  episode: { table: "Episode", vfk: "EpisodeId", meta: "EpisodeMetadata", ifk: "EpisodeId", artFk: "EpisodeMetadataId" },
  other_video: { table: "OtherVideo", vfk: "OtherVideoId", meta: "OtherVideoMetadata", ifk: "OtherVideoId", artFk: "OtherVideoMetadataId" },
  music_video: { table: "MusicVideo", vfk: "MusicVideoId", meta: "MusicVideoMetadata", ifk: "MusicVideoId", artFk: "MusicVideoMetadataId" },
  song: { table: "Song", vfk: "SongId", meta: "SongMetadata", ifk: "SongId", artFk: "SongMetadataId" },
  image: { table: "Image", vfk: "ImageId", meta: "ImageMetadata", ifk: "ImageId", artFk: "ImageMetadataId" },
};
const KIND_LABEL: Record<string, string> = { movie: "Movies", show: "Shows", other_video: "Other Videos", music_video: "Music Videos", song: "Songs", image: "Images" };

function tableExists(db: DatabaseSync, t: string): boolean { return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t); }
const libFilter = (disabled: number[]) => (disabled.length ? ` AND lp.LibraryId NOT IN (${disabled.join(",")})` : "");

/** Typeahead: distinct show titles matching `q` (contains, case-insensitive). */
export function listShowTitles(dbPath: string, q: string, limit = 20): string[] {
  const db = open(dbPath);
  try {
    if (!tableExists(db, "ShowMetadata")) return [];
    const like = `%${(q ?? "").trim().toLowerCase()}%`;
    return (db.prepare(
      `SELECT DISTINCT Title FROM ShowMetadata
       WHERE Title IS NOT NULL AND LOWER(Title) LIKE ?
       ORDER BY (LOWER(Title) LIKE ?) DESC, Title LIMIT ?`
    ).all(like, `${(q ?? "").trim().toLowerCase()}%`, limit) as any[]).map((r) => r.Title).filter(Boolean);
  } catch { return []; }
  finally { db.close(); }
}

export interface KindCount { kind: string; label: string; count: number; }
export function kindCounts(dbPath: string, disabled: number[] = []): KindCount[] {
  const db = open(dbPath);
  try {
    const out: KindCount[] = [];
    const f = libFilter(disabled);
    for (const kind of Object.keys(KIND)) {
      const k = KIND[kind];
      if (!tableExists(db, k.table)) continue;
      const n = (db.prepare(
        `SELECT COUNT(*) n FROM ${k.table} kt JOIN MediaItem mi ON mi.Id=kt.Id LEFT JOIN LibraryPath lp ON lp.Id=mi.LibraryPathId WHERE mi.State=0${f}`
      ).get() as any).n;
      if (kind === "episode") {
        // report shows instead of raw episodes in the kind list
        const shows = (db.prepare(
          `SELECT COUNT(DISTINCT se.ShowId) n FROM Season se JOIN Episode e ON e.SeasonId=se.Id JOIN MediaItem mi ON mi.Id=e.Id LEFT JOIN LibraryPath lp ON lp.Id=mi.LibraryPathId WHERE mi.State=0${f}`
        ).get() as any).n;
        out.push({ kind: "show", label: KIND_LABEL.show, count: shows });
      } else out.push({ kind, label: KIND_LABEL[kind] ?? kind, count: n });
    }
    return out.filter((c) => c.count > 0);
  } finally { db.close(); }
}

export interface Card { id: number; type: string; title: string; subtitle?: string; year?: number | null; durationMs?: number; episodes?: number; hasArt: boolean; }

/** The rows a kind's grid pages through, and the sort key it's ordered by
 *  (shared by the grid and its A–Z index, so the index's offsets line up). */
function gridSource(kind: string, f: string): { from: string; key: string } | null {
  if (kind === "show") return {
    from: `FROM Show sh LEFT JOIN ShowMetadata sm ON sm.ShowId=sh.Id
      WHERE EXISTS (SELECT 1 FROM Season se JOIN Episode e ON e.SeasonId=se.Id JOIN MediaItem mi ON mi.Id=e.Id LEFT JOIN LibraryPath lp ON lp.Id=mi.LibraryPathId WHERE se.ShowId=sh.Id AND mi.State=0${f})`,
    key: "COALESCE(sm.SortTitle, sm.Title) COLLATE NOCASE",
  };
  const k = KIND[kind];
  if (!k) return null;
  return {
    from: `FROM ${k.table} kt JOIN MediaItem mi ON mi.Id=kt.Id
       JOIN MediaVersion mv ON mv.${k.vfk}=kt.Id
       LEFT JOIN ${k.meta} md ON md.${k.ifk}=kt.Id
       LEFT JOIN LibraryPath lp ON lp.Id=mi.LibraryPathId
       WHERE mi.State=0${f}`,
    key: "COALESCE(md.SortTitle, md.Title) COLLATE NOCASE",
  };
}

/** Where each starting letter begins in a kind's grid: { "#": 0, A: 12, B: 40, … }.
 *  Titles starting with anything but A–Z count as "#". */
export function letterOffsets(dbPath: string, kind: string, disabled: number[] = []): Record<string, number> {
  const db = open(dbPath);
  try {
    const src = gridSource(kind, libFilter(disabled));
    if (!src || (kind !== "show" && !tableExists(db, KIND[kind].table))) return {};
    const rows = db.prepare(
      `SELECT UPPER(SUBSTR(k, 1, 1)) l, MIN(rn) at FROM
         (SELECT ${src.key} k, ROW_NUMBER() OVER (ORDER BY ${src.key}) - 1 rn ${src.from})
       GROUP BY l`
    ).all() as any[];
    const out: Record<string, number> = {};
    for (const r of rows) {
      const l = /^[A-Z]$/.test(r.l ?? "") ? r.l : "#";
      out[l] = Math.min(out[l] ?? Infinity, r.at);
    }
    return out;
  } finally { db.close(); }
}

export function listCards(dbPath: string, kind: string, opts: { offset?: number; limit?: number; disabled?: number[] } = {}): { total: number; cards: Card[] } {
  const db = open(dbPath);
  try {
    const offset = opts.offset ?? 0, limit = Math.min(opts.limit ?? 60, 200);
    const f = libFilter(opts.disabled ?? []);
    if (kind === "show") {
      const src = gridSource("show", f)!;
      const total = (db.prepare(`SELECT COUNT(*) n ${src.from}`).get() as any).n;
      const rows = db.prepare(
        `SELECT sh.Id id, sm.Id metaId, sm.Title title, sm.Year year,
           (SELECT COUNT(*) FROM Season se JOIN Episode e ON e.SeasonId=se.Id JOIN MediaItem mi ON mi.Id=e.Id WHERE se.ShowId=sh.Id AND mi.State=0) episodes
         ${src.from}
         ORDER BY ${src.key} LIMIT ? OFFSET ?`
      ).all(limit, offset) as any[];
      const cards = rows.map((r) => ({ id: r.id, type: "show", title: r.title ?? "(untitled)", year: r.year, episodes: r.episodes, hasArt: hasArtwork(db, "show", r.metaId) }));
      return { total, cards };
    }
    const k = KIND[kind];
    if (!k) return { total: 0, cards: [] };
    const total = (db.prepare(`SELECT COUNT(*) n FROM ${k.table} kt JOIN MediaItem mi ON mi.Id=kt.Id LEFT JOIN LibraryPath lp ON lp.Id=mi.LibraryPathId WHERE mi.State=0${f}`).get() as any).n;
    const src = gridSource(kind, f)!;
    const rows = db.prepare(
      `SELECT mi.Id id, md.Id metaId, md.Title title, md.Year year, mv.Duration dur
       ${src.from}
       ORDER BY ${src.key} LIMIT ? OFFSET ?`
    ).all(limit, offset) as any[];
    const cards = rows.map((r) => ({ id: r.id, type: kind, title: r.title ?? "(untitled)", year: r.year, durationMs: tsToMs(r.dur), hasArt: hasArtwork(db, kind, r.metaId) }));
    return { total, cards };
  } finally { db.close(); }
}

export function listSeasons(dbPath: string, showId: number, disabled: number[] = []): { show: { id: number; title: string }; seasons: Card[] } {
  const db = open(dbPath);
  try {
    const f = libFilter(disabled);
    const sh = db.prepare(`SELECT sh.Id id, sm.Title title FROM Show sh LEFT JOIN ShowMetadata sm ON sm.ShowId=sh.Id WHERE sh.Id=?`).get(showId) as any;
    const rows = db.prepare(
      `SELECT se.Id id, se.SeasonNumber num, sm.Id metaId,
         (SELECT COUNT(*) FROM Episode e JOIN MediaItem mi ON mi.Id=e.Id LEFT JOIN LibraryPath lp ON lp.Id=mi.LibraryPathId WHERE e.SeasonId=se.Id AND mi.State=0${f}) episodes
       FROM Season se LEFT JOIN SeasonMetadata sm ON sm.SeasonId=se.Id WHERE se.ShowId=? ORDER BY se.SeasonNumber`
    ).all(showId) as any[];
    const seasons = rows.filter((r) => r.episodes > 0).map((r) => ({ id: r.id, type: "season", title: r.num === 0 ? "Specials" : `Season ${r.num}`, episodes: r.episodes, hasArt: hasArtwork(db, "season", r.metaId) }));
    return { show: { id: showId, title: sh?.title ?? "(untitled)" }, seasons };
  } finally { db.close(); }
}

export function listEpisodes(dbPath: string, seasonId: number, disabled: number[] = []): { season: { id: number; title: string; showTitle: string; showId: number | null }; episodes: Card[] } {
  const db = open(dbPath);
  try {
    const f = libFilter(disabled);
    const se = db.prepare(
      `SELECT se.Id id, se.SeasonNumber num, se.ShowId showId, sm.Title showTitle FROM Season se LEFT JOIN Show sh ON sh.Id=se.ShowId LEFT JOIN ShowMetadata sm ON sm.ShowId=sh.Id WHERE se.Id=?`
    ).get(seasonId) as any;
    const rows = db.prepare(
      `SELECT mi.Id id, em.Id metaId, em.Title title, em.EpisodeNumber num, mv.Duration dur
       FROM Episode e JOIN MediaItem mi ON mi.Id=e.Id JOIN MediaVersion mv ON mv.EpisodeId=e.Id
       LEFT JOIN EpisodeMetadata em ON em.EpisodeId=e.Id
       LEFT JOIN LibraryPath lp ON lp.Id=mi.LibraryPathId
       WHERE e.SeasonId=? AND mi.State=0${f} ORDER BY em.EpisodeNumber`
    ).all(seasonId) as any[];
    const sNum = se?.num ?? 0;
    const code = (ep: number | null) => `S${String(sNum).padStart(2, "0")}E${String(ep ?? 0).padStart(2, "0")}`;
    const episodes = rows.map((r) => ({ id: r.id, type: "episode", title: r.title ?? "(untitled)", subtitle: r.num != null ? code(r.num) : undefined, durationMs: tsToMs(r.dur), hasArt: hasArtwork(db, "episode", r.metaId) }));
    return { season: { id: seasonId, title: se?.num === 0 ? "Specials" : `Season ${se?.num ?? "?"}`, showTitle: se?.showTitle ?? "", showId: se?.showId ?? null }, episodes };
  } finally { db.close(); }
}

function bits(db: DatabaseSync, tbl: string, fk: string, metaId: number, col = "Name"): string[] {
  try { return (db.prepare(`SELECT ${col} v FROM ${tbl} WHERE ${fk}=?`).all(metaId) as any[]).map((r) => r.v).filter(Boolean); } catch { return []; }
}

export interface Detail {
  id: number; type: string; title: string; showTitle?: string; season?: number; episode?: number;
  year?: number | null; plot?: string | null; durationMs: number; path?: string; library?: string;
  genres: string[]; tags: string[]; studios: string[]; guids: string[];
  streams: { kind: string; codec: string | null; language: string | null; channels?: number }[];
  chapters: number; hasArt: boolean;
}
export function itemDetail(dbPath: string, type: string, id: number): Detail | null {
  const db = open(dbPath);
  try {
    const k = KIND[type];
    if (!k) return null;
    const r = db.prepare(
      `SELECT mi.Id id, md.Id metaId, md.Title title, md.Year year, ${tableHasCol(db, k.meta, "Plot") ? "md.Plot" : "NULL"} plot,
              mv.Id versionId, mv.Duration dur, lib.Name library,
              (SELECT Path FROM MediaFile WHERE MediaVersionId=mv.Id LIMIT 1) path
       FROM ${k.table} kt JOIN MediaItem mi ON mi.Id=kt.Id JOIN MediaVersion mv ON mv.${k.vfk}=kt.Id
       LEFT JOIN ${k.meta} md ON md.${k.ifk}=kt.Id
       LEFT JOIN LibraryPath lp ON lp.Id=mi.LibraryPathId LEFT JOIN Library lib ON lib.Id=lp.LibraryId
       WHERE kt.Id=?`
    ).get(id) as any;
    if (!r) return null;
    let showTitle: string | undefined, season: number | undefined, episode: number | undefined;
    if (type === "episode") {
      const e = db.prepare(`SELECT sm.Title showTitle, se.SeasonNumber season, em.EpisodeNumber episode FROM Episode ep JOIN Season se ON se.Id=ep.SeasonId LEFT JOIN Show sh ON sh.Id=se.ShowId LEFT JOIN ShowMetadata sm ON sm.ShowId=sh.Id LEFT JOIN EpisodeMetadata em ON em.EpisodeId=ep.Id WHERE ep.Id=?`).get(id) as any;
      if (e) { showTitle = e.showTitle ?? undefined; season = e.season ?? undefined; episode = e.episode ?? undefined; }
    }
    const streams = (db.prepare(`SELECT MediaStreamKind kind, Codec codec, Language language, Channels channels FROM MediaStream WHERE MediaVersionId=? ORDER BY "Index"`).all(r.versionId) as any[])
      .map((s) => ({ kind: s.kind === 1 ? "video" : s.kind === 2 ? "audio" : s.kind === 3 ? "subtitle" : "other", codec: s.codec, language: s.language, channels: s.channels || undefined }));
    const chapters = (db.prepare(`SELECT COUNT(*) n FROM MediaChapter WHERE MediaVersionId=?`).get(r.versionId) as any).n;
    return {
      id: r.id, type, title: r.title ?? "(untitled)", showTitle, season, episode,
      year: r.year, plot: r.plot, durationMs: tsToMs(r.dur), path: r.path, library: r.library,
      genres: bits(db, "Genre", k.artFk, r.metaId), tags: bits(db, "Tag", k.artFk, r.metaId),
      studios: bits(db, "Studio", k.artFk, r.metaId), guids: bits(db, "MetadataGuid", k.artFk, r.metaId, "Guid"),
      streams, chapters, hasArt: hasArtwork(db, type, r.metaId),
    };
  } finally { db.close(); }
}

// ---- artwork ----------------------------------------------------------------
const ART_FK: Record<string, string> = { movie: "MovieMetadataId", episode: "EpisodeMetadataId", other_video: "OtherVideoMetadataId", music_video: "MusicVideoMetadataId", song: "SongMetadataId", image: "ImageMetadataId", show: "ShowMetadataId", season: "SeasonMetadataId" };
const META_OF: Record<string, { meta: string; fk: string }> = {
  movie: { meta: "MovieMetadata", fk: "MovieId" }, episode: { meta: "EpisodeMetadata", fk: "EpisodeId" },
  other_video: { meta: "OtherVideoMetadata", fk: "OtherVideoId" }, music_video: { meta: "MusicVideoMetadata", fk: "MusicVideoId" },
  song: { meta: "SongMetadata", fk: "SongId" }, image: { meta: "ImageMetadata", fk: "ImageId" },
  show: { meta: "ShowMetadata", fk: "ShowId" }, season: { meta: "SeasonMetadata", fk: "SeasonId" },
};
function tableHasCol(db: DatabaseSync, t: string, c: string): boolean { try { return (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).some((x) => x.name === c); } catch { return false; } }
function hasArtwork(db: DatabaseSync, type: string, metaId: number | null): boolean {
  if (metaId == null) return false;
  const fk = ART_FK[type]; if (!fk) return false;
  try { return !!db.prepare(`SELECT 1 FROM Artwork WHERE ${fk}=? AND ArtworkKind IN (0,1) LIMIT 1`).get(metaId); } catch { return false; }
}

export interface ArtTarget { provider: string; sourceId: number; resourcePath: string; }
/** Resolve an item's poster/thumb Artwork.Path into a provider resource to proxy. */
export function artworkTarget(dbPath: string, type: string, id: number): ArtTarget | null {
  const db = open(dbPath);
  try {
    const mo = META_OF[type]; const fk = ART_FK[type];
    if (!mo || !fk) return null;
    const meta = db.prepare(`SELECT Id FROM ${mo.meta} WHERE ${mo.fk}=? LIMIT 1`).get(id) as any;
    if (!meta) return null;
    let a = db.prepare(`SELECT Path FROM Artwork WHERE ${fk}=? AND ArtworkKind IN (0,1) ORDER BY ArtworkKind LIMIT 1`).get(meta.Id) as any;
    // a season without its own poster shows its show's
    if (!a?.Path && type === "season") {
      a = db.prepare(`SELECT a.Path FROM Season se JOIN ShowMetadata sm ON sm.ShowId=se.ShowId
                        JOIN Artwork a ON a.ShowMetadataId=sm.Id AND a.ArtworkKind IN (0,1)
                       WHERE se.Id=? ORDER BY a.ArtworkKind LIMIT 1`).get(id) as any;
    }
    if (!a?.Path) return null;
    // Jellyfin/Emby: "jellyfin://Items/{id}/Images/Primary?tag=…" — the source is the item's
    const scheme = /^(jellyfin|emby):[/][/](.+)$/i.exec(String(a.Path));
    if (scheme) {
      const src = db.prepare(`SELECT l.MediaSourceId s FROM MediaItem mi JOIN LibraryPath lp ON lp.Id=mi.LibraryPathId
                                JOIN Library l ON l.Id=lp.LibraryId WHERE mi.Id=?`).get(id) as any;
      if (!src?.s) return null;
      return { provider: scheme[1].toLowerCase(), sourceId: Number(src.s), resourcePath: "/" + scheme[2] };
    }
    const parts = String(a.Path).split("/");            // e.g. plex/3/library/metadata/123/thumb/456
    if (parts.length < 3) return null;
    return { provider: parts[0], sourceId: Number(parts[1]), resourcePath: "/" + parts.slice(2).join("/") };
  } finally { db.close(); }
}
