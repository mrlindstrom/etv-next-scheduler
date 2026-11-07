// -----------------------------------------------------------------------------
// Read-only resolver over a legacy ErsatzTV SQLite database
// -----------------------------------------------------------------------------
// Validated against a real (May-2025) ersatztv.sqlite3. Opens READ-ONLY.
//
// Schema facts this relies on (checked via verifySchema()):
//  - MediaItem(Id, LibraryPathId); kind tables Episode/Movie/OtherVideo/... each
//    have Id == MediaItem.Id (Episode also has SeasonId).
//  - MediaVersion links to a kind via EpisodeId/MovieId/OtherVideoId/MusicVideoId/
//    SongId/ImageId (NOT MediaItemId). It carries Duration.
//  - MediaFile(MediaVersionId, Path); MediaChapter(MediaVersionId, StartTime,
//    EndTime).  Durations/chapter times are .NET TimeSpan strings.
//  - Metadata per kind (EpisodeMetadata.EpisodeId, ShowMetadata.ShowId, ...).
//  - Tags live in Tag with a per-metadata FK column (OtherVideoMetadataId, ...).
//  - Show GUIDs live in MetadataGuid.Guid ("imdb://tt...") via ShowMetadataId.
//  - Library name via MediaItem.LibraryPathId -> LibraryPath.LibraryId -> Library.

import { DatabaseSync } from "node:sqlite";
import type { MediaItem, Chapter } from "./model.js";
import type { ContentDef, PlaybackOrder } from "./yaml.js";
import type { ContentResolver, GraphicsAsset, MediaStreamInfo, PlaylistEntry } from "./resolver.js";
import { parseQuery, matchNode, fieldsUsed, KNOWN_FIELDS, expandSmartCollections, type SearchRow } from "./search.js";
import { fieldProp } from "./search-help.js";
import { SearchIndexStore } from "./search-index-store.js";

// MediaItem.State enum -> name; MetadataKind enum -> name (for the `state` /
// `metadata_kind` search fields). Plex network tags use ExternalTypeId 319;
// legacy's NfoCountryTypeId marks country tags.
const STATE_NAME: Record<number, string> = { 0: "normal", 1: "filenotfound", 2: "unavailable", 3: "remoteonly" };
const META_KIND_NAME: Record<number, string> = { 0: "fallback", 1: "sidecar", 2: "external" };
const COUNTRY_TYPE_ID = "nfo/country"; // legacy Tag.NfoCountryTypeId (country tags; absent in Plex data)

/** "2025-04-05 09:46:59" | "1999-05-01" -> 20250405 (yyyymmdd int), else undefined. */
function ymd(s: any): number | undefined {
  if (!s) return undefined;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? Number(m[1] + m[2] + m[3]) : undefined;
}
function jumpLetter(s: any): string {
  const c = (String(s ?? "").trim().replace(/^(the|a|an)\s+/i, "")[0] ?? "").toUpperCase();
  if (!c) return "#";
  return /[A-Z]/.test(c) ? c : "#";
}
// HDR if the transfer is PQ/HLG or the space/primaries are BT.2020.
function isHdr(ct?: string, cs?: string, cp?: string): boolean {
  const t = (ct ?? "").toLowerCase(), s = (cs ?? "").toLowerCase(), p = (cp ?? "").toLowerCase();
  return t === "smpte2084" || t === "arib-std-b67" || s.includes("bt2020") || p.includes("bt2020");
}
// Minimal ISO-639 code -> English name for the common cases (language field).
const LANG: Record<string, string> = {
  eng: "english", en: "english", spa: "spanish", es: "spanish", fre: "french", fra: "french", fr: "french",
  ger: "german", deu: "german", de: "german", ita: "italian", it: "italian", jpn: "japanese", ja: "japanese",
  chi: "chinese", zho: "chinese", zh: "chinese", kor: "korean", ko: "korean", rus: "russian", ru: "russian",
  por: "portuguese", pt: "portuguese", dut: "dutch", nld: "dutch", nl: "dutch", pol: "polish", pl: "polish",
  swe: "swedish", nor: "norwegian", dan: "danish", fin: "finnish", ara: "arabic", hin: "hindi", tur: "turkish",
  cze: "czech", ces: "czech", gre: "greek", ell: "greek", heb: "hebrew", tha: "thai", vie: "vietnamese", hun: "hungarian",
};
function langName(code?: string): string | undefined { const c = (code ?? "").toLowerCase(); return LANG[c]; }

/** A tag rule: one tag, or a path of tags that must all be on the item. */
export type TagRule = string | string[];
/** A folder rule: everything in this folder (relative to the library's root, "/"-separated) and below it. */
export interface FolderRule { library?: string; folder: string }
/** A tag rule from the tag tree: every one of `tags`, except items that also have all of
 *  one of the `except` paths (tags below it in the tree, e.g. PSA except Christmas). */
export interface TagSetRule { tags: string[]; except?: string[][] }
export type FillerRule = TagRule | FolderRule | TagSetRule;
export const isFolderRule = (r: unknown): r is FolderRule => !!r && typeof r === "object" && !Array.isArray(r) && typeof (r as any).folder === "string";
export const isTagSetRule = (r: unknown): r is TagSetRule => !!r && typeof r === "object" && !Array.isArray(r) && Array.isArray((r as any).tags);
/** Does an item with these (lower-cased) tags match a tag-tree rule? */
export function matchesTagSet(have: Set<string>, r: TagSetRule): boolean {
  const need = r.tags.map((t) => t.toLowerCase());
  if (!need.length || !need.every((t) => have.has(t))) return false;
  return !(r.except ?? []).some((e) => e.length > 0 && e.every((t) => have.has(t.toLowerCase())));
}
/** Rules as lower-cased tag sets (blank tags and empty rules dropped). */
export function normalizeTagRules(rules: TagRule[]): string[][] {
  return rules.map((r) => (Array.isArray(r) ? r : [r]).map((t) => String(t ?? "").trim().toLowerCase()).filter(Boolean)).filter((r) => r.length);
}
/** Items matching any rule — every tag of that rule on the item (case-insensitive;
 *  a show's tags count for its episodes). */
export function filterByTags(items: MediaItem[], rules: TagRule[]): MediaItem[] {
  const want = normalizeTagRules(rules);
  if (!want.length) return items;
  return items.filter((m) => { const have = new Set((m.tags ?? []).map((t) => t.toLowerCase())); return want.some((r) => r.every((t) => have.has(t))); });
}

/** The distinct tag sets across a set of items, with how many items have each set
 *  (enough for the channel form to draw the tag tree and count any rule exactly). */
export function tagCombos(items: MediaItem[]): { tags: string[]; count: number }[] {
  const by = new Map<string, { tags: string[]; count: number }>();
  for (const m of items) {
    const seen = new Map<string, string>();
    for (const t of m.tags ?? []) if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
    const tags = [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const k = tags.map((t) => t.toLowerCase()).join("\u0001");
    const e = by.get(k); if (e) e.count++; else by.set(k, { tags, count: 1 });
  }
  return [...by.values()];
}

/** Tags across a set of items, most common first. */
export function tagCounts(items: MediaItem[]): { tag: string; count: number }[] {
  const by = new Map<string, { tag: string; count: number }>();
  for (const m of items) for (const t of new Set((m.tags ?? []).filter(Boolean))) {
    const k = t.toLowerCase();
    const e = by.get(k); if (e) e.count++; else by.set(k, { tag: t, count: 1 });
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Build a SQLite `file:` URI with ?immutable=1 for a path (Windows or POSIX). */
export function toImmutableUri(p: string): string {
  const fwd = p.replace(/\\/g, "/").replace(/ /g, "%20");
  const base = /^[A-Za-z]:/.test(fwd) ? `file:///${fwd}` : fwd.startsWith("/") ? `file://${fwd}` : `file:${fwd}`;
  return `${base}?immutable=1`;
}

export function timeSpanToMs(ts: string | null): number {
  if (!ts) return 0;
  const m = String(ts).match(/^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!m) { const n = Number(ts); return Number.isFinite(n) ? n : 0; }
  const days = m[1] ? Number(m[1]) : 0;
  const frac = m[5] ? Number("0." + m[5]) : 0;
  return ((days * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])) + frac) * 1000;
}

interface Row extends SearchRow {
  id: number;
  versionId: number;
  path: string;
  season?: number;
  episode?: number;
  aired?: string;
  plot?: string;
  year?: number;
  libraryId?: number;
  // grouping rows (type "show"/"season") are searchable but not schedulable
  // directly — for scheduling they expand to these episode ids.
  episodeIds?: number[];
  groupId?: number; // real Show.Id / Season.Id (row.id is a synthetic negative)
  parentShowId?: number;
  /** show/season rows: their metadata row id, which orders them (as a fresh build does) */
  ord?: number; // season rows: their show (for incremental re-indexing)
}

/** "(1,2,3)" for an SQL IN list of integer ids (never empty: "(-1)" matches nothing). */
let kindRank: Map<string, number> | null = null;
function rowRank(): (r: Row) => number {
  kindRank ??= new Map(Object.values(KIND_META).map((k, i) => [k.type, i]));
  const n = kindRank.size;
  return (r) => r.episodeIds ? (r.type === "show" ? n : n + 1) : (kindRank!.get(r.type) ?? n + 2);
}

function sqlIds(ids: Iterable<number>): string {
  const a = [...ids].filter((n) => Number.isFinite(n)).map((n) => Math.trunc(n));
  return `(${a.length ? a.join(",") : "-1"})`;
}

/** Documents loaded from the index file are stored compactly; restore what the
 *  search code relies on being present. */
function normalizeRow(r: Row): void {
  if (!Array.isArray(r.tags)) r.tags = [];
  if (r.title == null) r.title = "";
  if (r.show_title == null) r.show_title = "";
  if (r.library == null) r.library = "";
  if (r.durationMs == null) r.durationMs = 0;
}

const KIND_META: Record<string, { kindTable: string; versionFk: string; metaTable: string; metaFk: string; tagFk: string; type: string }> = {
  episode:     { kindTable: "Episode",    versionFk: "EpisodeId",    metaTable: "EpisodeMetadata",    metaFk: "EpisodeId",    tagFk: "EpisodeMetadataId",    type: "episode" },
  movie:       { kindTable: "Movie",      versionFk: "MovieId",      metaTable: "MovieMetadata",      metaFk: "MovieId",      tagFk: "MovieMetadataId",      type: "movie" },
  other_video: { kindTable: "OtherVideo", versionFk: "OtherVideoId", metaTable: "OtherVideoMetadata", metaFk: "OtherVideoId", tagFk: "OtherVideoMetadataId", type: "other_video" },
  music_video: { kindTable: "MusicVideo", versionFk: "MusicVideoId", metaTable: "MusicVideoMetadata", metaFk: "MusicVideoId", tagFk: "MusicVideoMetadataId", type: "music_video" },
  song:        { kindTable: "Song",       versionFk: "SongId",       metaTable: "SongMetadata",       metaFk: "SongId",       tagFk: "SongMetadataId",       type: "song" },
  image:       { kindTable: "Image",      versionFk: "ImageId",      metaTable: "ImageMetadata",      metaFk: "ImageId",       tagFk: "ImageMetadataId",      type: "image" },
};

export interface SqliteResolverOptions {
  dbPath: string; verbose?: boolean;
  // the persisted search index: default = search-index.sqlite next to the library
  // (used when it exists and is complete); false = always build in memory
  indexPath?: string | false;
  // the index writer: never catches up from the file (it's the one writing it)
  writer?: boolean;
}

export class SqliteResolver implements ContentResolver {
  private db: DatabaseSync;
  private rows: Row[] | null = null;
  private byId = new Map<number, Row>();
  private chapterCache = new Map<number, Chapter[]>();
  private extrasCache = new Map<string, { genres: string[]; contentRating?: string; icon?: string }>();

  constructor(private opts: SqliteResolverOptions) {
    // Prefer a normal read-only handle so we see WAL-committed data from an
    // in-progress scan and never block it. But some filesystems (FUSE mounts,
    // network shares, a DB held open by ErsatzTV) let a normal handle OPEN yet
    // error on the first read — so we probe with a real read and, if it throws,
    // fall back to `immutable` (ignores locks/WAL; reads the main file directly).
    let probe: DatabaseSync | undefined;
    try {
      probe = new DatabaseSync(opts.dbPath, { readOnly: true });
      try { probe.exec("PRAGMA busy_timeout=10000;"); } catch { /* ignore */ }
      probe.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get(); // probe read
      this.db = probe;
    } catch {
      try { probe?.close(); } catch { /* ignore */ }
      this.db = new DatabaseSync(toImmutableUri(opts.dbPath), { readOnly: true });
    }
  }
  close() { this.db.close(); }

  private disabledLibs = new Set<number>();
  /** Exclude items belonging to these library ids from all content resolution. */
  setDisabledLibraries(ids: Iterable<number>): void {
    const next = new Set(ids);
    if ([...next].sort().join() !== [...this.disabledLibs].sort().join()) this.valueCache.clear();
    this.disabledLibs = next;
  }

  /** Distinct values of a field across enabled libraries, for search-box
   *  suggestions: those containing `text` (case-insensitive), values starting
   *  with it first, then by how many items have them. */
  private valueCache = new Map<string, Map<string, number>>();
  fieldValues(field: string, text = "", limit = 20): { value: string; count: number }[] {
    this.ensureLoaded();
    if (field === "smart_collection") {
      const t = text.toLowerCase();
      return this.tableExists("SmartCollection")
        ? (this.db.prepare(`SELECT Name FROM SmartCollection ORDER BY Name`).all() as any[]).map((r) => String(r.Name ?? ""))
            .filter((n) => n && (!t || n.toLowerCase().includes(t))).slice(0, limit).map((value) => ({ value, count: 0 }))
        : [];
    }
    const prop = field === "type" ? "type" : fieldProp(field);
    if (!prop) return [];
    let counts = this.valueCache.get(prop);
    if (!counts) {
      counts = new Map();
      for (const r of this.rows!) {
        if (r.libraryId != null && this.disabledLibs.has(r.libraryId)) continue;
        const v = (r as any)[prop];
        for (const x of Array.isArray(v) ? v : v == null || v === "" ? [] : [v]) { const k = String(x); counts.set(k, (counts.get(k) ?? 0) + 1); }
      }
      // collection names are indexed lowercased; suggest them as you named them
      if (prop === "collections" && this.tableExists("Collection")) {
        const proper = new Map((this.db.prepare(`SELECT Name FROM Collection`).all() as any[]).map((r) => [String(r.Name ?? "").toLowerCase(), String(r.Name ?? "")]));
        counts = new Map([...counts].map(([k, n]) => [proper.get(k.toLowerCase()) ?? k, n]));
      }
      this.valueCache.set(prop, counts);
    }
    const t = text.toLowerCase();
    return [...counts].filter(([v]) => !t || v.toLowerCase().includes(t))
      .sort((a, b) => Number(b[0].toLowerCase().startsWith(t)) - Number(a[0].toLowerCase().startsWith(t)) || b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit).map(([value, count]) => ({ value, count }));
  }

  private excludeSpecials = true;
  /** When true (default), Season 0 (specials) episodes are excluded unless a
   *  content definition opts in with `include_specials: true`. */
  setExcludeSpecials(v: boolean): void { this.excludeSpecials = v; }

  /** Fast COUNT-based stats for the Connect screen (no full preload). */
  stats(): { mediaItems: number; episodes: number; shows: number; chapters: number } {
    const c = (sql: string): number => {
      try { return Number((this.db.prepare(sql).get() as any)?.n ?? 0); } catch { return 0; }
    };
    return {
      mediaItems: c(`SELECT COUNT(*) n FROM MediaItem`),
      episodes: c(`SELECT COUNT(*) n FROM Episode`),
      shows: c(`SELECT COUNT(*) n FROM Show`),
      chapters: c(`SELECT COUNT(DISTINCT MediaVersionId) n FROM MediaChapter`),
    };
  }

  verifySchema(): string[] {
    const problems: string[] = [];
    const need = ["MediaItem", "MediaVersion", "MediaFile", "MediaChapter", "Episode",
      "EpisodeMetadata", "ShowMetadata", "Season", "Show", "Library", "LibraryPath",
      "Collection", "CollectionItem", "OtherVideo", "OtherVideoMetadata", "Tag", "MetadataGuid"];
    for (const t of need) {
      const row = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);
      if (!row) problems.push(`missing table: ${t}`);
    }
    return problems;
  }

  // --- the search index -------------------------------------------------------
  // Every searchable document — episodes/movies/other videos/… plus `show` and
  // `season` group rows (legacy indexes those too). collectRows() builds them from
  // the library: with no scope, all of them; with a scope, just those items (and
  // reindex() rebuilds the affected show/season rows), so an incremental update
  // runs exactly the same code as a full build.
  //
  // When a persisted index file is available (search-index.sqlite, written by the
  // server's index worker), documents are loaded from it instead of being derived
  // from the library (~4x faster), and later changes are caught up incrementally.
  private store: SearchIndexStore | null | undefined;   // undefined = not opened yet
  private gen = 0;                                      // index generation this copy reflects
  private lastCatchUp = 0;
  private docs = new Map<number, Row>();                // row.id -> document

  /** True when documents come from (and follow) the persisted index file. */
  get indexBacked(): boolean { return !!this.openStore(); }

  private storeTriedAt = 0;
  private openStore(): SearchIndexStore | null {
    // not there yet (e.g. the first build is still running)? look again every 30s
    if (this.store || (this.store === null && Date.now() - this.storeTriedAt < 30_000)) return this.store ?? null;
    this.storeTriedAt = Date.now();
    this.store = null;
    if (this.opts.indexPath === false) return null;
    try { this.store = SearchIndexStore.openForRead(this.opts.indexPath ?? SearchIndexStore.pathFor(this.opts.dbPath), this.opts.dbPath); }
    catch { this.store = null; }
    return this.store;
  }

  private ensureLoaded(): void {
    if (this.rows) { this.catchUp(); return; }
    const t0 = Date.now();
    const store = this.openStore();
    if (store) {
      try {
        const loaded = store.loadAll();
        if (loaded) {
          this.gen = loaded.gen;
          this.setRows(loaded.rows as Row[]);
          if (this.opts.verbose) console.log(`[index] loaded ${loaded.rows.length} documents from the search index in ${Date.now() - t0}ms`);
          return;
        }
      } catch (e) { if (this.opts.verbose) console.warn(`[index] couldn't read the search index (${(e as Error).message}); building it in memory`); }
    }
    this.setRows(this.collectRows());
    if (this.opts.verbose) console.log(`[sqlite] loaded ${this.rows!.length} items in ${Date.now() - t0}ms`);
  }

  /** Apply index changes another process wrote since this copy was loaded. */
  private catchUp(force = false): void {
    const store = this.openStore();
    if (!store || this.opts.writer) return;
    const now = Date.now();
    if (!force && now - this.lastCatchUp < 500) return;
    this.lastCatchUp = now;
    try {
      const m = store.meta();
      if (!m || m.gen === this.gen) return;
      const ch = m.fullGen > this.gen ? null : store.changesSince(this.gen);
      if (!ch) {
        const loaded = store.loadAll();
        if (loaded) { this.gen = loaded.gen; this.setRows(loaded.rows as Row[]); if (this.opts.verbose) console.log(`[index] reloaded ${loaded.rows.length} documents (index was rebuilt)`); }
        return;
      }
      this.applyDocChanges(ch.upserts as Row[], ch.removed);
      this.gen = ch.gen;
    } catch { /* keep serving what we have */ }
  }

  /** Replace the document set and rebuild the lookup structures. */
  setRows(rows: Row[]): void {
    for (const r of rows) normalizeRow(r);
    // One canonical order however the documents arrived (fresh build, index file,
    // incremental changes): items by kind then id, then shows, then seasons — the
    // order a fresh build produces. Results (and so shuffles) depend on it.
    const rank = rowRank();
    rows.sort((a, b) => (rank(a) - rank(b)) || ((a.ord ?? a.groupId ?? a.id) - (b.ord ?? b.groupId ?? b.id)));
    this.rows = rows;
    this.docs = new Map(rows.map((r) => [r.id, r]));
    this.byId = new Map();
    for (const r of rows) this.byId.set(r.groupId ?? r.id, r);
    this.buildFieldIndexes(rows);
    this.valueCache.clear();
    this.pathStreamIndex = undefined;
  }

  private applyDocChanges(upserts: Row[], removed: number[]): void {
    for (const id of removed) this.docs.delete(id);
    for (const r of upserts) { normalizeRow(r); this.docs.set(r.id, r); }
    this.setRows([...this.docs.values()]);
  }

  /** Current documents (for the index writer). */
  allRows(): Row[] { this.ensureLoaded(); return this.rows!; }
  /** The index generation this copy reflects (the writer advances it). */
  get generation(): number { return this.gen; }
  set generation(g: number) { this.gen = g; }

  /** Rebuild the documents for these media items. Any id may be an episode,
   *  movie, other video, … or a show / season (which re-indexes the show, its
   *  seasons and its episodes). Returns what changed, and applies it here. */
  reindex(rawIds: Iterable<number>): { upserts: Row[]; removed: number[] } {
    this.ensureLoaded();
    const ids = [...new Set(rawIds)].filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) return { upserts: [], removed: [] };
    const q = (sql: string): any[] => { try { return this.db.prepare(sql).all() as any[]; } catch { return []; } };
    const showIds = new Set<number>(), itemIds = new Set<number>();
    const IN = sqlIds(ids);
    for (const r of q(`SELECT Id FROM Show WHERE Id IN ${IN}`)) showIds.add(r.Id);
    for (const r of q(`SELECT Id, ShowId FROM Season WHERE Id IN ${IN}`)) showIds.add(r.ShowId);
    const groupIds = new Set([...q(`SELECT Id FROM Show WHERE Id IN ${IN}`), ...q(`SELECT Id FROM Season WHERE Id IN ${IN}`)].map((r) => r.Id));
    for (const id of ids) if (!groupIds.has(id)) itemIds.add(id);
    // ids that used to be a show/season document but are gone from the library
    for (const id of ids) { const old = this.byId.get(id); if (old?.episodeIds) { itemIds.delete(id); if (old.type === "show") showIds.add(id); else if (old.parentShowId != null) showIds.add(old.parentShowId); } }
    // every episode of an affected show is re-indexed (its show_* fields may have changed)
    if (showIds.size) for (const r of q(`SELECT e.Id FROM Episode e JOIN Season se ON se.Id = e.SeasonId WHERE se.ShowId IN ${sqlIds(showIds)}`)) itemIds.add(r.Id);
    // the shows these episodes belong to now …
    if (itemIds.size) for (const r of q(`SELECT DISTINCT se.ShowId FROM Episode e JOIN Season se ON se.Id = e.SeasonId WHERE e.Id IN ${sqlIds(itemIds)}`)) showIds.add(r.ShowId);
    // … and the shows they were filed under before (moved or deleted episodes)
    for (const r of this.rows!) if (r.episodeIds && r.episodeIds.some((e) => itemIds.has(e))) showIds.add(r.type === "show" ? r.groupId! : r.parentShowId!);
    showIds.delete(undefined as any);

    // 1) item documents
    const fresh = itemIds.size ? this.collectRows({ itemIds: [...itemIds] }) : [];
    const freshIds = new Set(fresh.map((r) => r.id));
    const removed: number[] = [];
    for (const id of itemIds) if (!freshIds.has(id) && this.docs.has(id)) removed.push(id);
    for (const id of removed) { this.docs.delete(id); this.byId.delete(id); }
    for (const r of fresh) { this.docs.set(r.id, r); this.byId.set(r.id, r); }

    // 2) show/season group documents for the affected shows
    const oldGroups = [...this.docs.values()].filter((r) => r.episodeIds && (r.type === "show" ? showIds.has(r.groupId!) : showIds.has(r.parentShowId!)));
    for (const g of oldGroups) { this.docs.delete(g.id); if (this.byId.get(g.groupId!) === g) this.byId.delete(g.groupId!); }
    const groups: Row[] = [];
    if (showIds.size) this.addShowSeasonRows(groups, this.loadShowBits(showIds), this.byId, showIds);
    for (const g of groups) this.docs.set(g.id, g);
    const groupIdsNow = new Set(groups.map((g) => g.id));
    for (const g of oldGroups) if (!groupIdsNow.has(g.id)) removed.push(g.id);

    this.setRows([...this.docs.values()]);
    return { upserts: [...fresh, ...groups], removed };
  }

  /** Build documents from the library: everything, or just `scope.itemIds`
   *  (item documents only — reindex() adds the show/season rows). */
  collectRows(scope?: { itemIds: number[] }): Row[] {
    const rows: Row[] = [];
    const byId = new Map<number, Row>();
    const ids = scope ? sqlIds(scope.itemIds) : null;
    if (scope && !scope.itemIds.length) return rows;
    const collectionMap = this.loadCollections(ids);
    const chapterMap = this.loadChapterCounts(ids);
    // show metadata only for the shows these episodes belong to
    const showsOf = ids ? new Set((this.db.prepare(`SELECT DISTINCT se.ShowId AS id FROM Episode e JOIN Season se ON se.Id = e.SeasonId WHERE e.Id IN ${ids}`).all() as any[]).map((r) => r.id as number)) : null;
    const showBits = this.loadShowBits(showsOf);
    const traktLists = this.loadTraktLists(ids);
    const hasFolderId = this.columnExists("MediaFile", "LibraryFolderId");

    for (const kind of Object.keys(KIND_META)) {
      const k = KIND_META[kind];
      if (!this.tableExists(k.kindTable) || !this.tableExists(k.metaTable)) continue;
      const showJoin = kind === "episode"
        ? `LEFT JOIN Season se ON se.Id = kt.SeasonId
           LEFT JOIN Show sh ON sh.Id = se.ShowId
           LEFT JOIN ShowMetadata sm ON sm.ShowId = sh.Id`
        : "";
      const showCols = kind === "episode"
        ? `sm.Title AS show_title, se.SeasonNumber AS season, md.EpisodeNumber AS episode, sm.Id AS showMetaId`
        : `NULL AS show_title, NULL AS season, NULL AS episode, NULL AS showMetaId`;
      const col = (t: string, c: string, expr = `md.${c}`) => (this.columnExists(t, c) ? expr : "NULL");
      const sql = `
        SELECT mi.Id AS id, '${k.type}' AS type, mi.State AS state, mv.Id AS versionId, mv.Duration AS dur,
               mv.Width AS width, mv.Height AS height,
               md.Id AS metaId, md.Title AS title, ${col(k.metaTable, "SortTitle")} AS sort_title,
               ${col(k.metaTable, "ReleaseDate")} AS aired, ${col(k.metaTable, "Plot")} AS plot,
               ${col(k.metaTable, "Year")} AS year, ${col(k.metaTable, "ContentRating")} AS content_rating,
               ${col(k.metaTable, "MetadataKind")} AS metadata_kind, ${col(k.metaTable, "DateAdded")} AS date_added,
               ${col(k.metaTable, "Album")} AS album, ${col(k.metaTable, "Artists")} AS artist, ${col(k.metaTable, "AlbumArtists")} AS album_artist,
               lib.Name AS library, lp.LibraryId AS libraryId,
               (SELECT Path FROM MediaFile WHERE MediaVersionId = mv.Id LIMIT 1) AS path,
               ${hasFolderId ? "(SELECT LibraryFolderId FROM MediaFile WHERE MediaVersionId = mv.Id LIMIT 1)" : "NULL"} AS folderId,
               ${showCols}
        FROM ${k.kindTable} kt
        JOIN MediaItem mi ON mi.Id = kt.Id
        JOIN MediaVersion mv ON mv.${k.versionFk} = kt.Id
        LEFT JOIN ${k.metaTable} md ON md.${k.metaFk} = kt.Id
        LEFT JOIN LibraryPath lp ON lp.Id = mi.LibraryPathId
        LEFT JOIN Library lib ON lib.Id = lp.LibraryId
        ${showJoin}
        ${ids ? `WHERE kt.Id IN ${ids}` : ""}`;

      // meta-bit maps for this kind (keyed by metadata id), limited to the scope
      const fk = k.tagFk;
      const metaWhere = ids ? `${fk} IN (SELECT Id FROM ${k.metaTable} WHERE ${k.metaFk} IN ${ids})` : null;
      const genres = this.loadBits("Genre", fk, metaWhere), studios = this.loadBits("Studio", fk, metaWhere);
      const actors = this.loadBits("Actor", fk, metaWhere), directors = this.loadBits("Director", fk, metaWhere);
      const writers = this.loadBits("Writer", fk, metaWhere), moods = this.loadBits("Mood", fk, metaWhere), styles = this.loadBits("Style", fk, metaWhere);
      const tg = this.loadTagsTyped(fk, metaWhere);
      const guidsById = this.loadGuids(fk, metaWhere);
      const streams = this.loadStreams(k.kindTable, k.versionFk, ids);

      for (const r of this.db.prepare(sql).all() as any[]) {
        if (!r.path) continue; // unplayable
        const st = streams.get(r.versionId);
        const sb = r.showMetaId != null ? showBits.get(r.showMetaId) : undefined;
        const row: Row = {
          id: r.id, versionId: r.versionId, path: r.path,
          type: r.type, title: r.title ?? "", show_title: r.show_title ?? "",
          library: r.library ?? "", tags: tg.tags.get(r.metaId) ?? [], // shared with tag_full (as before: propagated show tags appear in both)
          durationMs: timeSpanToMs(r.dur),
          season: r.season ?? undefined, episode: r.episode ?? undefined, aired: r.aired ?? undefined,
          plot: r.plot ?? undefined, year: r.year ?? undefined, libraryId: r.libraryId ?? undefined,
          // search-field parity
          sort_title: (r.sort_title ?? r.title ?? "").toString().toLowerCase(),
          state: STATE_NAME[r.state] ?? undefined,
          content_rating: r.content_rating ?? undefined,
          metadata_kind: META_KIND_NAME[r.metadata_kind] ?? undefined,
          jump_letter: jumpLetter(r.sort_title ?? r.title),
          title_and_year: r.year ? `${r.title} (${r.year})` : (r.title ?? undefined),
          added_date: ymd(r.date_added), release_date: ymd(r.aired),
          width: r.width || undefined, height: r.height || undefined,
          chapters: chapterMap.get(r.versionId) ?? 0,
          genres: genres.get(r.metaId) ?? [], tag_full: tg.tags.get(r.metaId) ?? [],
          network: tg.network.get(r.metaId) ?? [], country: tg.country.get(r.metaId) ?? [],
          studios: studios.get(r.metaId) ?? [], actors: actors.get(r.metaId) ?? [],
          directors: directors.get(r.metaId) ?? [], writers: writers.get(r.metaId) ?? [],
          moods: moods.get(r.metaId) ?? [], styles: styles.get(r.metaId) ?? [],
          collections: collectionMap.get(r.id) ?? [],
          album: r.album ?? undefined, artist: r.artist ?? undefined, album_artist: r.album_artist ?? undefined,
          video_codec: st?.codec, video_bit_depth: st?.bits, video_dynamic_range: st?.dynamicRange,
          languages: st?.langs ?? [], language_tags: st?.langTags ?? [],
          sub_languages: st?.subLangs ?? [], sub_language_tags: st?.subLangTags ?? [],
          show_genres: sb?.genres, show_tags: sb?.tags, show_studios: sb?.studios, show_network: sb?.network, show_content_rating: sb?.contentRating,
          guids: guidsById.get(r.metaId) ?? [], show_guids: sb?.guids ?? [],
          library_folder_ids: r.folderId != null ? [String(r.folderId)] : [],
          trakt_lists: traktLists.get(r.id) ?? [],
        };
        rows.push(row); byId.set(row.id, row);
      }
    }
    this.propagateShowTags(byId, ids); // legacy: show tags also searchable as episode tags

    // Legacy also indexes `show` and `season` documents. They aren't schedulable
    // on their own; when a search/collection matches them they expand to episodes.
    if (!scope) this.addShowSeasonRows(rows, showBits, byId, null);
    return rows;
  }

  // --- candidate-narrowing indexes (speed up per-query full scans) ------------
  // A channel resolves ~one search per content def; each was a linear scan of
  // every row. These indexes let runSearch start from a small candidate set
  // (rows that satisfy one positive top-level clause) instead of all rows, then
  // apply the full predicate to that set. Keys mirror the SearchRow fields so a
  // bucket is always a *superset* of the true matches — correctness is unchanged.
  private typeIndex = new Map<string, Row[]>();
  private showTitleIndex = new Map<string, Row[]>();
  private libraryIndex = new Map<string, Row[]>();
  private tagIndex = new Map<string, Row[]>();

  private buildFieldIndexes(rows: Row[]): void {
    this.typeIndex.clear(); this.showTitleIndex.clear(); this.libraryIndex.clear(); this.tagIndex.clear();
    const add = (m: Map<string, Row[]>, key: string, r: Row) => { const k = key.toLowerCase(); const a = m.get(k); if (a) a.push(r); else m.set(k, [r]); };
    for (const r of rows) {
      if (r.type) add(this.typeIndex, r.type, r);
      if (r.show_title) add(this.showTitleIndex, r.show_title, r);
      if (r.library) add(this.libraryIndex, r.library, r);
      for (const t of r.tags ?? []) if (t) add(this.tagIndex, t, r);
    }
  }

  /** Smallest superset candidate list for a query, or null to scan all rows.
   *  Uses one positive, non-wildcard top-level AND clause on an indexed field. */
  private candidateRows(node: import("./search.js").Node): Row[] | null {
    const terms = node.t === "and" ? node.nodes : [node];
    let best: Row[] | null = null;
    for (const c of terms) {
      if (c.t !== "term" || c.wildcard) continue;
      const set = this.indexLookup(c.field, c.value);
      if (set && (best == null || set.length < best.length)) best = set;
    }
    return best;
  }

  private indexLookup(field: string, value: string): Row[] | null {
    const v = value.toLowerCase();
    if (field === "type") return this.typeIndex.get(v) ?? [];
    // substring fields with few distinct keys: scan the (small) key set, union
    // buckets. Multi-valued fields (tag) can put one row in several matching
    // buckets, so dedupe by row identity to avoid double-counting.
    const substr = (m: Map<string, Row[]>): Row[] => {
      const seen = new Set<Row>();
      for (const [k, rows] of m) if (k.includes(v)) for (const r of rows) seen.add(r);
      return [...seen];
    };
    if (field === "show_title") return substr(this.showTitleIndex);
    if (field === "library_name") return substr(this.libraryIndex);
    if (field === "tag") return substr(this.tagIndex);
    return null;
  }

  /** Show + season group documents. `byId` holds the (playable) episode rows;
   *  `showIds` limits it to those shows (null = all). */
  private addShowSeasonRows(rows: Row[], showBits: Map<number, { genres: string[]; tags: string[]; studios: string[]; network: string[]; guids: string[]; contentRating?: string }>, byId: Map<number, Row>, showIds: Set<number> | null): void {
    if (!this.tableExists("ShowMetadata")) return;
    const showFilter = showIds ? `WHERE se.ShowId IN ${sqlIds(showIds)}` : "";
    // episode ids grouped by season and by show (only episodes we actually indexed)
    const bySeason = new Map<number, number[]>();
    const byShow = new Map<number, number[]>();
    const seasonMeta = new Map<number, { showId: number; num: number }>();
    for (const r of this.db.prepare(
      `SELECT e.Id AS id, e.SeasonId AS seasonId, se.ShowId AS showId, se.SeasonNumber AS num
       FROM Episode e JOIN Season se ON se.Id = e.SeasonId ${showFilter}`).all() as any[]) {
      const ep = byId.get(r.id);
      if (!ep || ep.episodeIds) continue; // skip unplayable/omitted (and never a group row)
      (bySeason.get(r.seasonId) ?? bySeason.set(r.seasonId, []).get(r.seasonId)!).push(r.id);
      (byShow.get(r.showId) ?? byShow.set(r.showId, []).get(r.showId)!).push(r.id);
      if (!seasonMeta.has(r.seasonId)) seasonMeta.set(r.seasonId, { showId: r.showId, num: r.num });
    }
    // library per show (from its first indexed episode)
    const showLibrary = new Map<number, { name: string; id?: number }>();
    for (const [showId, ids] of byShow) { const ep = byId.get(ids[0]); if (ep) showLibrary.set(showId, { name: ep.library, id: ep.libraryId }); }

    // shows
    const showTitles = new Map<number, string>();
    const smFilter = showIds ? `WHERE sm.ShowId IN ${sqlIds(showIds)}` : "";
    for (const s of this.db.prepare(`SELECT sm.Id AS metaId, sm.ShowId AS showId, sm.Title AS title, sm.SortTitle AS sortTitle, ${this.columnExists("ShowMetadata", "Year") ? "sm.Year" : "NULL"} AS year, ${this.columnExists("ShowMetadata", "Plot") ? "sm.Plot" : "NULL"} AS plot, ${this.columnExists("ShowMetadata", "ReleaseDate") ? "sm.ReleaseDate" : "NULL"} AS aired, ${this.columnExists("ShowMetadata", "DateAdded") ? "sm.DateAdded" : "NULL"} AS added FROM ShowMetadata sm ${smFilter}`).all() as any[]) {
      const eps = byShow.get(s.showId); if (!eps?.length) continue;
      const sb = showBits.get(s.metaId);
      const lib = showLibrary.get(s.showId);
      const gr = this.groupRow("show", s.showId, eps, s.title, s.sortTitle, s.year, s.plot, lib, sb);
      gr.release_date = ymd(s.aired); gr.added_date = ymd(s.added); gr.ord = s.metaId; // e.g. `type:show AND release_date:198*`
      rows.push(gr); byId.set(s.showId, gr); // index by real id so collection members resolve
      showTitles.set(s.showId, s.title ?? "");
    }
    // seasons
    const seFilter = showIds ? `WHERE sm.SeasonId IN (SELECT Id FROM Season WHERE ShowId IN ${sqlIds(showIds)})` : "";
    for (const s of this.db.prepare(`SELECT sm.Id AS metaId, sm.SeasonId AS seasonId, sm.Title AS title FROM SeasonMetadata sm ${seFilter}`).all() as any[]) {
      const eps = bySeason.get(s.seasonId); if (!eps?.length) continue;
      const meta = seasonMeta.get(s.seasonId);
      const lib = meta ? showLibrary.get(meta.showId) : undefined;
      const row = this.groupRow("season", s.seasonId, eps, s.title || (meta ? `Season ${meta.num}` : "Season"), s.title, undefined, undefined, lib, undefined);
      row.season = meta?.num;
      row.parentShowId = meta?.showId;
      row.ord = s.metaId;
      // a season's show_title is its SHOW's title (legacy indexes it that way), not "Season 2"
      if (meta && showTitles.has(meta.showId)) row.show_title = showTitles.get(meta.showId)!;
      rows.push(row); byId.set(s.seasonId, row); // index by real id so collection members resolve
    }
  }

  private groupRow(type: string, id: number, episodeIds: number[], title: string, sortTitle: string, year: number | undefined, plot: string | undefined, lib: { name: string; id?: number } | undefined, sb?: { genres: string[]; tags: string[]; studios: string[]; network: string[]; guids: string[]; contentRating?: string }): Row {
    return {
      id: -(type === "show" ? 1 : 2) * 1_000_000_000 - id, // negative synthetic id (never a real MediaItem)
      groupId: id,
      versionId: 0, path: "", episodeIds,
      type, title: title ?? "", show_title: type === "season" ? title ?? "" : "",
      library: lib?.name ?? "", libraryId: lib?.id, durationMs: 0,
      sort_title: (sortTitle ?? title ?? "").toString().toLowerCase(),
      year: year ?? undefined, plot: plot ?? undefined,
      title_and_year: year ? `${title} (${year})` : title,
      jump_letter: jumpLetter(sortTitle ?? title),
      tags: sb?.tags ?? [], genres: sb?.genres ?? [], studios: sb?.studios ?? [],
      network: sb?.network ?? [], content_rating: sb?.contentRating,
      // show_* mirror on the show row too so either field style works
      show_genres: sb?.genres, show_tags: sb?.tags, show_studios: sb?.studios, show_network: sb?.network, show_content_rating: sb?.contentRating,
      guids: sb?.guids ?? [], show_guids: sb?.guids ?? [],
    };
  }

  // meta-bit table (Genre/Studio/Actor/...) -> Map<metadataId, name[]>
  private loadBits(table: string, fk: string, where: string | null = null): Map<number, string[]> {
    const map = new Map<number, string[]>();
    if (!this.tableExists(table) || !this.columnExists(table, fk)) return map;
    for (const r of this.db.prepare(`SELECT ${fk} AS mid, Name FROM ${table} WHERE ${fk} IS NOT NULL${where ? ` AND ${where}` : ""}`).all() as any[]) {
      const a = map.get(r.mid) ?? []; a.push(r.Name); map.set(r.mid, a);
    }
    return map;
  }

  /** External ids from MetadataGuid ("imdb://tt…"), keyed by metadata id. `fk`
   *  is the metadata-type column (EpisodeMetadataId / MovieMetadataId / …). */
  private loadGuids(fk: string, where: string | null = null): Map<number, string[]> {
    const map = new Map<number, string[]>();
    if (!this.tableExists("MetadataGuid") || !this.columnExists("MetadataGuid", fk)) return map;
    for (const r of this.db.prepare(`SELECT ${fk} AS mid, Guid FROM MetadataGuid WHERE ${fk} IS NOT NULL${where ? ` AND ${where}` : ""}`).all() as any[]) {
      if (!r.Guid) continue; const a = map.get(r.mid) ?? []; a.push(r.Guid); map.set(r.mid, a);
    }
    return map;
  }

  // Tags split by Plex tag type: network (319) vs country vs regular tag.
  private loadTagsTyped(fk: string, where: string | null = null): { tags: Map<number, string[]>; network: Map<number, string[]>; country: Map<number, string[]> } {
    const tags = new Map<number, string[]>(), network = new Map<number, string[]>(), country = new Map<number, string[]>();
    if (!this.tableExists("Tag") || !this.columnExists("Tag", fk)) return { tags, network, country };
    const hasType = this.columnExists("Tag", "ExternalTypeId");
    const sel = hasType ? "ExternalTypeId" : "NULL";
    for (const r of this.db.prepare(`SELECT ${fk} AS mid, Name, ${sel} AS ext FROM Tag WHERE ${fk} IS NOT NULL${where ? ` AND ${where}` : ""}`).all() as any[]) {
      const bucket = String(r.ext) === "319" ? network : String(r.ext) === COUNTRY_TYPE_ID ? country : tags;
      const a = bucket.get(r.mid) ?? []; a.push(r.Name); bucket.set(r.mid, a);
    }
    return { tags, network, country };
  }

  private loadChapterCounts(ids: string | null = null): Map<number, number> {
    const map = new Map<number, number>();
    if (!this.tableExists("MediaChapter")) return map;
    const where = ids ? `WHERE MediaVersionId IN (SELECT Id FROM MediaVersion WHERE ${Object.values(KIND_META).filter((k) => this.columnExists("MediaVersion", k.versionFk)).map((k) => `${k.versionFk} IN ${ids}`).join(" OR ")})` : "";
    for (const r of this.db.prepare(`SELECT MediaVersionId AS vid, COUNT(*) AS n FROM MediaChapter ${where} GROUP BY MediaVersionId`).all() as any[]) map.set(r.vid, r.n);
    return map;
  }

  private loadCollections(ids: string | null = null): Map<number, string[]> {
    const map = new Map<number, string[]>();
    if (!this.tableExists("CollectionItem") || !this.tableExists("Collection")) return map;
    for (const r of this.db.prepare(`SELECT ci.MediaItemId AS id, c.Name AS name FROM CollectionItem ci JOIN Collection c ON c.Id = ci.CollectionId${ids ? ` WHERE ci.MediaItemId IN ${ids}` : ""}`).all() as any[]) {
      const a = map.get(r.id) ?? []; a.push(String(r.name).toLowerCase()); map.set(r.id, a);
    }
    return map;
  }

  // stream-derived fields per MediaVersion for one kind
  private loadStreams(kindTable: string, versionFk: string, ids: string | null = null): Map<number, { codec?: string; bits?: number; dynamicRange?: string; langs: string[]; langTags: string[]; subLangs: string[]; subLangTags: string[] }> {
    const map = new Map<number, any>();
    if (!this.tableExists("MediaStream")) return map;
    const sql = `SELECT mv.Id AS vid, s.MediaStreamKind AS kind, s.Codec AS codec, s.Language AS lang,
                        s.BitsPerRawSample AS bits, s.ColorTransfer AS ct, s.ColorSpace AS cs, s.ColorPrimaries AS cp
                 FROM ${kindTable} kt JOIN MediaVersion mv ON mv.${versionFk} = kt.Id
                 JOIN MediaStream s ON s.MediaVersionId = mv.Id${ids ? ` WHERE kt.Id IN ${ids}` : ""}`;
    for (const r of this.db.prepare(sql).all() as any[]) {
      let e = map.get(r.vid);
      if (!e) { e = { langs: [], langTags: [], subLangs: [], subLangTags: [] }; map.set(r.vid, e); }
      if (r.kind === 1) { // video
        if (r.codec && !e.codec) e.codec = String(r.codec).toLowerCase();
        if (r.bits && !e.bits) e.bits = r.bits;
        if (!e.dynamicRange) e.dynamicRange = isHdr(r.ct, r.cs, r.cp) ? "hdr" : "sdr";
      } else if (r.kind === 2 && r.lang) { // audio
        if (!e.langTags.includes(r.lang)) e.langTags.push(String(r.lang).toLowerCase());
        const en = langName(r.lang); if (en && !e.langs.includes(en)) e.langs.push(en);
      } else if (r.kind === 3 && r.lang) { // subtitle
        if (!e.subLangTags.includes(r.lang)) e.subLangTags.push(String(r.lang).toLowerCase());
        const en = langName(r.lang); if (en && !e.subLangs.includes(en)) e.subLangs.push(en);
      }
    }
    return map;
  }

  // show-level metadata bits (for episode show_* fields), keyed by ShowMetadata.Id;
  // `showIds` limits it to those shows (null = all)
  private loadShowBits(showIds: Set<number> | null = null): Map<number, { genres: string[]; tags: string[]; studios: string[]; network: string[]; guids: string[]; contentRating?: string }> {
    const map = new Map<number, any>();
    if (!this.tableExists("ShowMetadata")) return map;
    if (showIds && !showIds.size) return map;
    const smIn = showIds ? ` AND ShowMetadataId IN (SELECT Id FROM ShowMetadata WHERE ShowId IN ${sqlIds(showIds)})` : "";
    const get = (id: number) => { let e = map.get(id); if (!e) { e = { genres: [], tags: [], studios: [], network: [], guids: [] }; map.set(id, e); } return e; };
    const bits = (table: string, key: "genres" | "studios") => { if (this.tableExists(table) && this.columnExists(table, "ShowMetadataId")) for (const r of this.db.prepare(`SELECT ShowMetadataId AS mid, Name FROM ${table} WHERE ShowMetadataId IS NOT NULL${smIn}`).all() as any[]) get(r.mid)[key].push(r.Name); };
    bits("Genre", "genres"); bits("Studio", "studios");
    if (this.tableExists("Tag") && this.columnExists("Tag", "ShowMetadataId")) {
      const hasType = this.columnExists("Tag", "ExternalTypeId");
      for (const r of this.db.prepare(`SELECT ShowMetadataId AS mid, Name, ${hasType ? "ExternalTypeId" : "NULL"} AS ext FROM Tag WHERE ShowMetadataId IS NOT NULL${smIn}`).all() as any[]) {
        const e = get(r.mid); if (String(r.ext) === "319") e.network.push(r.Name); else e.tags.push(r.Name);
      }
    }
    if (this.columnExists("ShowMetadata", "ContentRating")) for (const r of this.db.prepare(`SELECT Id, ContentRating FROM ShowMetadata WHERE ContentRating IS NOT NULL${showIds ? ` AND ShowId IN ${sqlIds(showIds)}` : ""}`).all() as any[]) get(r.Id).contentRating = r.ContentRating;
    if (this.tableExists("MetadataGuid") && this.columnExists("MetadataGuid", "ShowMetadataId"))
      for (const r of this.db.prepare(`SELECT ShowMetadataId AS mid, Guid FROM MetadataGuid WHERE ShowMetadataId IS NOT NULL${smIn}`).all() as any[]) if (r.Guid) get(r.mid).guids.push(r.Guid);
    return map;
  }

  /** Legacy: a show's tags are also searchable as tags of its episodes. */
  private propagateShowTags(byId: Map<number, Row>, ids: string | null): void {
    if (!this.tableExists("ShowMetadata")) return;
    const rows = this.db.prepare(
      `SELECT t.Name AS name, e.Id AS itemId
       FROM Tag t
       JOIN ShowMetadata sm ON sm.Id = t.ShowMetadataId
       JOIN Season se ON se.ShowId = sm.ShowId
       JOIN Episode e ON e.SeasonId = se.Id
       WHERE t.ShowMetadataId IS NOT NULL${ids ? ` AND e.Id IN ${ids}` : ""}`).all() as any[];
    for (const r of rows) { const it = byId.get(r.itemId); if (it && !it.episodeIds && !it.tags.includes(r.name)) it.tags.push(r.name); }
  }

  private tableExists(t: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
  }

  private colCache = new Map<string, boolean>();
  private columnExists(table: string, col: string): boolean {
    const key = `${table}.${col}`;
    let v = this.colCache.get(key);
    if (v === undefined) {
      try { v = (this.db.prepare(`PRAGMA table_info(${table})`).all() as any[]).some((c) => c.name === col); }
      catch { v = false; }
      this.colCache.set(key, v);
    }
    return v;
  }

  // --- ContentResolver -------------------------------------------------------
  async resolveContent(def: ContentDef): Promise<MediaItem[]> {
    this.ensureLoaded();
    let rows: Row[];
    switch (def.kind) {
      case "search": rows = this.runSearch(def.query ?? ""); break;
      case "smart_collection": rows = this.runSearch(this.smartCollectionQuery(def.collection ?? "")); break;
      case "collection": rows = this.idsToRows(this.collectionIds(def.collection ?? "")); break;
      case "multi_collection": rows = this.multiCollectionRows(def.collection ?? ""); break;
      case "show": rows = this.idsToRows(this.showEpisodeIds(def.guids ?? [])); break;
      case "playlist": rows = this.playlistRows(def.playlist ?? def.collection ?? ""); break;
      default: rows = [];
    }
    const items = this.finishRows(rows, def.expand !== false, def.includeSpecials);
    return def.tags?.length ? this.filterByRules(items, def.tags) : items;
  }

  // ---- filler rules: folders (relative to the library's root) or tags ----
  private libRoots?: { root: string; library: string }[];
  /** The library an item's file sits in and its folder inside it ("Commercials/Food"; "" = the library's root). */
  folderOf(path: string): { library: string; dir: string } | null {
    if (!this.libRoots) {
      let rows: any[] = [];
      try { rows = this.db.prepare(`SELECT lp.Path p, l.Name n FROM LibraryPath lp JOIN Library l ON l.Id = lp.LibraryId`).all() as any[]; } catch { /* no table */ }
      this.libRoots = rows.filter((r) => r.p).map((r) => ({ root: String(r.p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() + "/", library: r.n ?? "" }))
        .sort((a, b) => b.root.length - a.root.length);
    }
    const norm = (path ?? "").replace(/\\/g, "/");
    const lower = norm.toLowerCase();
    const hit = this.libRoots.find((r) => lower.startsWith(r.root));
    if (!hit) return null;
    const rel = norm.slice(hit.root.length);
    const cut = rel.lastIndexOf("/");
    return { library: hit.library, dir: cut < 0 ? "" : rel.slice(0, cut) };
  }
  /** Items matching any rule: a folder rule takes everything in that folder and below
   *  it; a tag rule needs every one of its tags on the item. */
  filterByRules(items: MediaItem[], rules: FillerRule[]): MediaItem[] {
    const folders = rules.filter(isFolderRule).map((r) => ({ library: (r.library ?? "").toLowerCase(), dir: r.folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase() })).filter((r) => r.dir);
    const sets = rules.filter(isTagSetRule);
    const tagRules = rules.filter((r) => !isFolderRule(r) && !isTagSetRule(r)) as TagRule[];
    const tagged = tagRules.length ? new Set(filterByTags(items, tagRules)) : null;
    if (!folders.length && !tagged && !sets.length) return items;
    return items.filter((m) => {
      if (tagged?.has(m)) return true;
      if (sets.length) { const have = new Set((m.tags ?? []).map((t) => t.toLowerCase())); if (sets.some((r) => matchesTagSet(have, r))) return true; }
      if (!folders.length) return false;
      const f = this.folderOf(m.path);
      if (!f) return false;
      const dir = f.dir.toLowerCase(), lib = f.library.toLowerCase();
      return folders.some((r) => (!r.library || r.library === lib) && (dir === r.dir || dir.startsWith(r.dir + "/")));
    });
  }

  /** Shared tail of content resolution: expand shows/seasons to episodes, drop
   *  disabled libraries and (unless opted in) specials, build media items. */
  private finishRows(rows: Row[], expand: boolean, includeSpecials?: boolean): MediaItem[] {
    const groupOf = new Map<Row, string>();
    if (expand) rows = this.expandGroups(rows, groupOf);
    if (this.disabledLibs.size) rows = rows.filter((r) => r.libraryId == null || !this.disabledLibs.has(r.libraryId));
    // specials (Season 0) excluded by default; a content def can opt in
    if (!(includeSpecials ?? !this.excludeSpecials)) rows = rows.filter((r) => !(r.type === "episode" && (r.season ?? 0) === 0));
    return rows.map((r) => { const it = this.toMediaItem(r); const g = groupOf.get(r); if (g) it.group = g; return it; });
  }

  /** A playlist's entries in order (ErsatzTV legacy PlaylistItem rows), each
   *  resolved to its own items with its play order, count and guide flag. */
  async resolvePlaylist(name: string, opts?: { includeSpecials?: boolean }): Promise<PlaylistEntry[]> {
    this.ensureLoaded();
    let pl: any, rows: any[] = [];
    try {
      pl = this.db.prepare(`SELECT Id FROM Playlist WHERE Name = ?`).get(name);
      if (!pl) return [];
      rows = this.db.prepare(`SELECT * FROM PlaylistItem WHERE PlaylistId = ? ORDER BY "Index", Id`).all(pl.Id) as any[];
    } catch { return []; }
    return rows.map((it) => {
      let r: Row[] = [];
      if (it.CollectionId != null) r = this.idsToRows((this.db.prepare(`SELECT MediaItemId AS id FROM CollectionItem WHERE CollectionId = ? ORDER BY CustomIndex`).all(it.CollectionId) as any[]).map((x) => x.id));
      else if (it.SmartCollectionId != null) { const q = this.db.prepare(`SELECT Query FROM SmartCollection WHERE Id = ?`).get(it.SmartCollectionId) as any; if (q) r = this.runSearch(q.Query ?? ""); }
      else if (it.MultiCollectionId != null) { const m = this.db.prepare(`SELECT Name FROM MultiCollection WHERE Id = ?`).get(it.MultiCollectionId) as any; if (m) r = this.multiCollectionRows(m.Name); }
      else if (it.MediaItemId != null) r = this.idsToRows([it.MediaItemId]); // a show/season expands to its episodes
      return {
        label: playlistEntryLabel(this.db, it),
        source: it.CollectionId != null ? `collection:${it.CollectionId}` : it.SmartCollectionId != null ? `smart:${it.SmartCollectionId}`
          : it.MultiCollectionId != null ? `multi:${it.MultiCollectionId}` : `item:${it.MediaItemId}`,
        items: this.finishRows(r, true, opts?.includeSpecials),
        order: LEGACY_ORDER[it.PlaybackOrder] ?? "chronological",
        count: it.Count ?? undefined,
        playAll: !!it.PlayAll,
        inGuide: it.IncludeInProgramGuide !== 0,
      };
    });
  }

  async resolveGraphics(element: string): Promise<GraphicsAsset | null> {
    return { path: element, kind: /\.(png|jpg|jpeg|webp)$/i.test(element) || element.startsWith("image/") ? "image" : "text" };
  }

  /** Test a playout-style search query (same semantics the engine uses when a
   *  content definition has `kind: search`). Returns matching items, paged. */
  search(query: string, offset = 0, limit = 60): {
    total: number; unknownFields: string[];
    items: { id: number; type: string; title: string; showTitle: string; season?: number; episode?: number; year?: number; durationMs: number }[];
  } {
    this.ensureLoaded();
    const q = this.expandQuery(query.trim()) || "type:*";
    const node = parseQuery(q);
    const unknownFields = [...fieldsUsed(node)].filter((f) => !KNOWN_FIELDS.has(f));
    let rows = (this.candidateRows(node) ?? this.rows!).filter((r) => matchNode(node, r));
    if (this.disabledLibs.size) rows = rows.filter((r) => r.libraryId == null || !this.disabledLibs.has(r.libraryId));
    if (this.excludeSpecials) rows = rows.filter((r) => !(r.type === "episode" && (r.season ?? 0) === 0));
    const total = rows.length;
    const items = rows.slice(offset, offset + limit).map((r) => ({
      id: r.episodeIds ? (r.groupId ?? r.id) : r.id, type: r.type, title: r.title, showTitle: r.show_title,
      season: r.season, episode: r.episode, year: r.year, durationMs: r.durationMs,
    }));
    return { total, unknownFields, items };
  }

  // --- query paths -----------------------------------------------------------
  private runSearch(query: string): Row[] {
    query = this.expandQuery(query);
    const node = parseQuery(query);
    for (const f of fieldsUsed(node)) if (!KNOWN_FIELDS.has(f)) console.warn(`[search] unsupported field '${f}' in: ${query}`);
    const candidates = this.candidateRows(node) ?? this.rows!;
    return candidates.filter((r) => matchNode(node, r));
  }

  /** MediaItem id -> Trakt list ids (legacy's trakt_list field), if the tables exist. */
  private loadTraktLists(ids: string | null = null): Map<number, string[]> {
    const m = new Map<number, string[]>();
    if (!this.tableExists("TraktListItem") || !this.tableExists("TraktList")) return m;
    try {
      for (const r of this.db.prepare(`SELECT tli.MediaItemId AS id, tl.TraktId AS tid FROM TraktListItem tli JOIN TraktList tl ON tl.Id = tli.TraktListId WHERE tli.MediaItemId IS NOT NULL${ids ? ` AND tli.MediaItemId IN ${ids}` : ""}`).all() as any[])
        (m.get(r.id) ?? m.set(r.id, []).get(r.id)!).push(String(r.tid));
    } catch { /* older schema */ }
    return m;
  }

  /** Replace smart_collection:"Name" with that collection's query, as legacy does. */
  expandQuery(query: string): string {
    return expandSmartCollections(query, (name) => {
      const r = this.db.prepare(`SELECT Query FROM SmartCollection WHERE Name = ?`).get(name) as any;
      return r ? String(r.Query ?? "") : undefined;
    });
  }

  private smartCollectionQuery(name: string): string {
    const r = this.db.prepare(`SELECT Query FROM SmartCollection WHERE Name = ?`).get(name) as any;
    return r?.Query ?? "";
  }

  private collectionIds(name: string): number[] {
    return (this.db.prepare(
      `SELECT ci.MediaItemId AS id FROM Collection c
       JOIN CollectionItem ci ON ci.CollectionId = c.Id WHERE c.Name = ?
       ORDER BY ci.CustomIndex`).all(name) as any[]).map((r) => r.id);
  }

  private multiCollectionIds(name: string): number[] {
    return (this.db.prepare(
      `SELECT ci.MediaItemId AS id FROM MultiCollection mc
       JOIN MultiCollectionItem mci ON mci.MultiCollectionId = mc.Id
       JOIN CollectionItem ci ON ci.CollectionId = mci.CollectionId
       WHERE mc.Name = ?`).all(name) as any[]).map((r) => r.id);
  }

  /** Rows for a playlist: expand each ordered item (collection / smart / multi /
   *  direct media item) and merge, preserving order, de-duplicated. */
  private playlistRows(name: string): Row[] {
    let pl: any, items: any[] = [];
    try {
      pl = this.db.prepare(`SELECT Id FROM Playlist WHERE Name = ?`).get(name);
      if (!pl) return [];
      items = this.db.prepare(`SELECT CollectionId, MediaItemId, MultiCollectionId, SmartCollectionId FROM PlaylistItem WHERE PlaylistId = ? ORDER BY "Index"`).all(pl.Id) as any[];
    } catch { return []; }
    const out: Row[] = []; const seen = new Set<number>();
    const add = (rows: Row[]) => { for (const r of rows) if (!seen.has(r.id)) { seen.add(r.id); out.push(r); } };
    for (const it of items) {
      if (it.CollectionId != null) add(this.idsToRows((this.db.prepare(`SELECT MediaItemId AS id FROM CollectionItem WHERE CollectionId = ? ORDER BY CustomIndex`).all(it.CollectionId) as any[]).map((r) => r.id)));
      else if (it.SmartCollectionId != null) { const q = this.db.prepare(`SELECT Query FROM SmartCollection WHERE Id = ?`).get(it.SmartCollectionId) as any; if (q) add(this.runSearch(q.Query ?? "")); }
      else if (it.MultiCollectionId != null) { const m = this.db.prepare(`SELECT Name FROM MultiCollection WHERE Id = ?`).get(it.MultiCollectionId) as any; if (m) add(this.multiCollectionRows(m.Name)); }
      else if (it.MediaItemId != null) add(this.idsToRows([it.MediaItemId]));
    }
    return out;
  }

  /** Rows for a multi-collection: manual-collection members PLUS smart-collection
   *  members (whose queries are run and merged). */
  private multiCollectionRows(name: string): Row[] {
    const rows = this.idsToRows(this.multiCollectionIds(name));
    let smartQueries: any[] = [];
    try {
      smartQueries = this.db.prepare(
        `SELECT sc.Query AS q FROM MultiCollection mc
         JOIN MultiCollectionSmartItem msi ON msi.MultiCollectionId = mc.Id
         JOIN SmartCollection sc ON sc.Id = msi.SmartCollectionId
         WHERE mc.Name = ?`).all(name) as any[];
    } catch { /* schema may lack the smart-item table */ }
    const seen = new Set(rows.map((r) => r.id));
    for (const s of smartQueries) {
      for (const r of this.runSearch(s.q ?? "")) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
    }
    return rows;
  }

  private showEpisodeIds(guids: { source: string; value: string }[]): number[] {
    if (!guids.length) return [];
    const conds = guids.map(() => `mg.Guid = ?`).join(" OR ");
    const params = guids.map((g) => `${g.source}://${g.value}`);
    return (this.db.prepare(
      `SELECT e.Id AS id
       FROM MetadataGuid mg
       JOIN ShowMetadata sm ON sm.Id = mg.ShowMetadataId
       JOIN Season se ON se.ShowId = sm.ShowId
       JOIN Episode e ON e.SeasonId = se.Id
       WHERE ${conds}`).all(...params) as any[]).map((r) => r.id);
  }

  private idsToRows(ids: number[]): Row[] {
    const out: Row[] = [];
    for (const id of ids) { const r = this.byId.get(id); if (r) out.push(r); }
    return out;
  }

  /** Replace any grouping rows (show/season matches) with their episodes, and
   *  drop duplicates — so `type:show ...` schedules the shows' episodes.
   *  `groupOf` records the show each expanded episode came from (a season counts
   *  as its show), for show-balanced shuffle. */
  private expandGroups(rows: Row[], groupOf?: Map<Row, string>): Row[] {
    if (!rows.some((r) => r.episodeIds)) return rows;
    const out: Row[] = [];
    const seen = new Set<number>();
    for (const r of rows) {
      const ids = r.episodeIds ?? [r.id];
      const group = r.episodeIds ? `show:${r.type === "show" ? r.groupId : (r.parentShowId ?? r.groupId)}` : undefined;
      for (const id of ids) {
        if (seen.has(id)) continue;
        const ep = r.episodeIds ? this.byId.get(id) : r;
        if (ep) { seen.add(id); out.push(ep); if (group) groupOf?.set(ep, group); }
      }
    }
    return out;
  }

  // --- hydrate ---------------------------------------------------------------
  private toMediaItem(r: Row): MediaItem {
    return {
      id: String(r.id), refId: r.groupId != null ? String(r.groupId) : undefined, path: r.path, durationMs: r.durationMs,
      chapters: this.chapters(r.versionId), title: r.title, kind: r.type,
      season: r.season, episodeNumber: r.episode, aired: r.aired,
      showTitle: r.show_title || undefined, plot: r.plot, year: r.year,
      tags: r.tags,
    };
  }

  /** Extra guide metadata (genres, rating, icon) for a scheduled item. Cached. */
  guideExtras(id: string): { genres: string[]; contentRating?: string; icon?: string } {
    const cached = this.extrasCache.get(id);
    if (cached) return cached;
    const n = Number(id);
    let genres: string[] = []; let contentRating: string | undefined; let icon: string | undefined;
    try {
      // resolve the metadata id + kind for this item, then pull genre/rating/artwork
      // episodes: genre/rating live on the SHOW; movies/other: on the item's metadata
      const ep = this.db.prepare(
        `SELECT sm.Id AS showMetaId, sm.ContentRating AS rating, sh.Id AS showId
         FROM Episode e JOIN Season se ON se.Id=e.SeasonId JOIN Show sh ON sh.Id=se.ShowId
         JOIN ShowMetadata sm ON sm.ShowId=sh.Id WHERE e.Id=?`).get(n) as any;
      if (ep) {
        contentRating = ep.rating ?? undefined;
        genres = (this.db.prepare(`SELECT Name FROM Genre WHERE ShowMetadataId=?`).all(ep.showMetaId) as any[]).map((g) => g.Name);
        // poster: a source URL if one is stored, else a token-free source ref for
        // the SHOW (a series poster beats an episode still in the guide).
        icon = this.artworkUrl("ShowMetadataId", ep.showMetaId) ?? this.sourceRef(Number(ep.showId), "Show");
      } else {
        // movie / other_video: metadata id via kind tables
        for (const meta of ["MovieMetadata", "OtherVideoMetadata"]) {
          const fk = meta === "MovieMetadata" ? "MovieId" : "OtherVideoId";
          const m = this.db.prepare(`SELECT Id, ContentRating AS rating FROM ${meta} WHERE ${fk}=?`).get(n) as any;
          if (m) {
            contentRating = m.rating ?? undefined;
            genres = (this.db.prepare(`SELECT Name FROM Genre WHERE ${meta}Id=?`).all(m.Id) as any[]).map((g) => g.Name);
            icon = this.artworkUrl(`${meta}Id`, m.Id) ?? this.sourceRef(n, meta === "MovieMetadata" ? "Movie" : "OtherVideo");
            break;
          }
        }
      }
    } catch { /* metadata is best-effort */ }
    const out = { genres, contentRating, icon };
    this.extrasCache.set(id, out);
    return out;
  }

  /** Diagnostic: for a sample of movies/episodes, report the source type and how
   *  the guide poster resolves (an http url, an art:// source ref, or none). Lets
   *  us see why the featured LOGO box is or isn't getting a poster. */
  artDiag(limit = 6): { id: number; kind: string; sourceType: string; icon: string }[] {
    const out: { id: number; kind: string; sourceType: string; icon: string }[] = [];
    const srcOf = (id: number): string => {
      try {
        const s = this.db.prepare(
          `SELECT l.MediaSourceId sid FROM MediaItem mi
           JOIN LibraryPath lp ON lp.Id=mi.LibraryPathId
           JOIN Library l ON l.Id=lp.LibraryId WHERE mi.Id=?`).get(id) as any;
        return s?.sid ? this.sourceType(Number(s.sid)) : "?";
      } catch { return "?"; }
    };
    for (const [tbl, kind] of [["Movie", "movie"], ["Episode", "episode"]] as const) {
      try {
        for (const r of this.db.prepare(`SELECT Id FROM ${tbl} LIMIT ?`).all(limit) as any[]) {
          out.push({ id: r.Id, kind, sourceType: srcOf(r.Id), icon: this.guideExtras(String(r.Id)).icon ?? "(none)" });
        }
      } catch { /* table missing */ }
    }
    return out;
  }

  // Audio/subtitle streams by lowercased path, built once. Querying MediaFile by
  // `Path COLLATE NOCASE` per item is a full table scan (~16ms each) — deadly at
  // thousands of items. One pass over MediaStream builds this map instead; only
  // audio/subtitle streams are kept (video is never used for track selection).
  private pathStreamIndex?: Map<string, MediaStreamInfo[]>;
  private buildPathStreamIndex(): void {
    const m = new Map<string, MediaStreamInfo[]>();
    try {
      const rows = this.db.prepare(
        `SELECT mf.Path AS path, ms."Index" AS idx, ms.MediaStreamKind AS kind, ms.Language AS lang,
                ms.Channels AS ch, ms."Default" AS def, ms."Forced" AS forced, ms.Title AS title
         FROM MediaFile mf JOIN MediaStream ms ON ms.MediaVersionId = mf.MediaVersionId
         WHERE ms.MediaStreamKind IN (2, 3)`).all() as any[];
      for (const r of rows) {
        if (!r.path) continue;
        const key = String(r.path).toLowerCase();
        const info: MediaStreamInfo = {
          index: Number(r.idx), kind: r.kind === 2 ? "audio" : "subtitle",
          language: r.lang ?? undefined, channels: r.ch ?? undefined,
          default: !!r.def, forced: !!r.forced, title: r.title ?? undefined,
        };
        const a = m.get(key); if (a) a.push(info); else m.set(key, [info]);
      }
    } catch { /* best-effort */ }
    this.pathStreamIndex = m;
  }

  /** Audio/subtitle streams for a local file path, for language-based track
   *  selection. Keyed by path (case-insensitive) since a path may exist in more
   *  than one library — the probed stream layout is identical, so any row works. */
  /** What ErsatzTV legacy put in a graphics element's MediaItem_* variables, for a
   *  file: its metadata, show, genres / studios / directors, size and length. */
  templateData(path: string): import("./legacy-graphics.js").LegacyItemData | null {
    const q1 = (sql: string, ...a: (string | number)[]): any => { try { return this.db.prepare(sql).get(...a); } catch { return undefined; } };
    const qa = (sql: string, ...a: (string | number)[]): any[] => { try { return this.db.prepare(sql).all(...a) as any[]; } catch { return []; } };
    const mv = q1(`SELECT mv.Id, mv.EpisodeId, mv.MovieId, mv.OtherVideoId, mv.MusicVideoId, mv.Width, mv.Height, mv.Duration, mv.DisplayAspectRatio, mv.SampleAspectRatio FROM MediaFile mf JOIN MediaVersion mv ON mv.Id = mf.MediaVersionId WHERE mf.Path = ? LIMIT 1`, path);
    if (!mv) return null;
    const names = (table: string, col: string, id: number) => qa(`SELECT Name FROM ${table} WHERE ${col} = ? ORDER BY Name`, id).map((r) => String(r.Name ?? "")).filter(Boolean);
    const ms = (v: unknown) => { if (v == null || v === "") return null; const t = Date.parse(String(v)); return Number.isFinite(t) ? t : null; };
    const durMs = (() => { const s = String(mv.Duration ?? ""); const m = /^(?:(\d+)\.)?(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(s); return m ? ((+(m[1] ?? 0) * 24 + +m[2]) * 60 + +m[3]) * 60_000 + +m[4] * 1000 : Number(s) || 0; })();
    // the shape it's shown at: its display aspect ratio ("4:3"), else its pixels x sample aspect
    const ratio = (v: unknown) => { const m = /^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$/.exec(String(v ?? "")); return m && +m[2] > 0 && +m[1] > 0 ? +m[1] / +m[2] : null; };
    const dar = ratio(mv.DisplayAspectRatio) ?? (mv.Width && mv.Height ? (mv.Width / mv.Height) * (ratio(mv.SampleAspectRatio) ?? 1) : null);
    const out: import("./legacy-graphics.js").LegacyItemData = { width: mv.Width ?? 0, height: mv.Height ?? 0, durationMs: durMs, dar };
    const fill = (md: any, kind: string) => {
      if (!md) return;
      Object.assign(out, { title: md.Title ?? "", plot: md.Plot ?? "", releaseDateMs: ms(md.ReleaseDate), year: md.Year ?? null, contentRating: md.ContentRating ?? "",
        genres: names("Genre", `${kind}MetadataId`, md.Id), studios: names("Studio", `${kind}MetadataId`, md.Id) });
      if (kind !== "Show") out.directors = names("Director", `${kind}MetadataId`, md.Id);
    };
    if (mv.EpisodeId) {
      fill(q1(`SELECT * FROM EpisodeMetadata WHERE EpisodeId = ? LIMIT 1`, mv.EpisodeId), "Episode");
      const sh = q1(`SELECT sm.* FROM Episode e JOIN Season se ON se.Id = e.SeasonId JOIN ShowMetadata sm ON sm.ShowId = se.ShowId WHERE e.Id = ? LIMIT 1`, mv.EpisodeId);
      if (sh) Object.assign(out, { showTitle: sh.Title ?? "", showYear: sh.Year ?? null, showContentRating: sh.ContentRating ?? "", showGenres: names("Genre", "ShowMetadataId", sh.Id) });
    } else if (mv.MovieId) fill(q1(`SELECT * FROM MovieMetadata WHERE MovieId = ? LIMIT 1`, mv.MovieId), "Movie");
    else if (mv.OtherVideoId) fill(q1(`SELECT * FROM OtherVideoMetadata WHERE OtherVideoId = ? LIMIT 1`, mv.OtherVideoId), "OtherVideo");
    else if (mv.MusicVideoId) {
      const md = q1(`SELECT * FROM MusicVideoMetadata WHERE MusicVideoId = ? LIMIT 1`, mv.MusicVideoId);
      fill(md, "MusicVideo");
      if (md) {
        const artist = q1(`SELECT am.Title FROM MusicVideo m JOIN ArtistMetadata am ON am.ArtistId = m.ArtistId WHERE m.Id = ? LIMIT 1`, mv.MusicVideoId);
        Object.assign(out, { album: md.Album ?? "", track: md.Track ?? null, artist: artist?.Title ?? "", artists: names("MusicVideoArtist", "MusicVideoMetadataId", md.Id) });
      }
    }
    return out;
  }

  streamsForPath(path: string): MediaStreamInfo[] | undefined {
    if (!path) return undefined;
    if (!this.pathStreamIndex) this.buildPathStreamIndex();
    return this.pathStreamIndex!.get(path.toLowerCase());
  }

  /** Media-source kind for a MediaSource id (mirrors the scanner's check). */
  private srcTypeCache = new Map<number, string>();
  private sourceType(sourceId: number): string {
    const c = this.srcTypeCache.get(sourceId);
    if (c) return c;
    const has = (t: string) => { try { return !!this.db.prepare(`SELECT 1 FROM ${t} WHERE Id=?`).get(sourceId); } catch { return false; } };
    const t = has("PlexMediaSource") ? "plex" : has("JellyfinMediaSource") ? "jellyfin" : has("EmbyMediaSource") ? "emby" : "local";
    this.srcTypeCache.set(sourceId, t);
    return t;
  }

  /** A token-free "art://{sourceId}/{type}/{base64url(providerKey)}" reference for
   *  a Plex/Jellyfin/Emby item, resolved live (with the scheduler's stored token)
   *  when the guide is streamed. Returns undefined for local/unknown sources. */
  private sourceRef(itemId: number, kindTable: "Show" | "Movie" | "OtherVideo"): string | undefined {
    try {
      if (!Number.isFinite(itemId)) return undefined;
      const src = this.db.prepare(
        `SELECT l.MediaSourceId sid FROM MediaItem mi
         JOIN LibraryPath lp ON lp.Id=mi.LibraryPathId
         JOIN Library l ON l.Id=lp.LibraryId WHERE mi.Id=?`).get(itemId) as any;
      if (!src?.sid) return undefined;
      const sid = Number(src.sid);
      const type = this.sourceType(sid);
      if (type !== "plex" && type !== "jellyfin" && type !== "emby") return undefined;
      const keyTbl = `${type === "plex" ? "Plex" : type === "jellyfin" ? "Jellyfin" : "Emby"}${kindTable}`;
      const keyCol = type === "plex" ? "Key" : "ItemId";
      const k = this.db.prepare(`SELECT ${keyCol} v FROM ${keyTbl} WHERE Id=?`).get(itemId) as any;
      if (!k?.v) return undefined;
      return `art://${sid}/${type}/${Buffer.from(String(k.v)).toString("base64url")}`;
    } catch { return undefined; }
  }

  /** Best *source-direct* artwork for a metadata row. Only returns artwork that is
   *  directly reachable from the original source (a full http(s) URL). It never
   *  points at ErsatzTV's own artwork cache — source-API image URLs are built from
   *  a sourceRef() at stream time, using the scheduler's stored token. */
  private artworkUrl(fkColumn: string, metaId: number): string | undefined {
    try {
      const rows = this.db.prepare(`SELECT ArtworkKind, Path FROM Artwork WHERE ${fkColumn}=?`).all(metaId) as any[];
      for (const kind of [1, 2, 3]) {
        const r = rows.find((x) => Number(x.ArtworkKind) === kind && /^https?:\/\//i.test(String(x.Path)));
        if (r) return String(r.Path);
      }
      return undefined;
    } catch { return undefined; }
  }

  private chapters(versionId: number): Chapter[] {
    let c = this.chapterCache.get(versionId);
    if (c) return c;
    c = (this.db.prepare(
      `SELECT StartTime AS s, EndTime AS e, Title AS t FROM MediaChapter
       WHERE MediaVersionId = ? ORDER BY StartTime`).all(versionId) as any[])
      .map((x) => ({ startMs: timeSpanToMs(x.s), endMs: timeSpanToMs(x.e), title: x.t ?? undefined }));
    this.chapterCache.set(versionId, c);
    return c;
  }
}

/** ErsatzTV legacy PlaybackOrder numbers (PlaylistItem.PlaybackOrder). */
export const LEGACY_ORDER: Record<number, PlaybackOrder> = {
  0: "chronological", 1: "chronological", 2: "random", 3: "shuffle", 4: "shuffle_in_order", 5: "multi_episode_shuffle", 6: "season_episode", 7: "shuffle", 8: "chronological",
};

/** A readable name for a playlist entry: the collection, show, season or item it plays. */
export function playlistEntryLabel(db: DatabaseSync, it: any): string {
  const one = (sql: string, id: number) => { try { return db.prepare(sql).get(id) as any; } catch { return undefined; } };
  if (it.CollectionId != null) return one(`SELECT Name n FROM Collection WHERE Id=?`, it.CollectionId)?.n ?? "(missing collection)";
  if (it.SmartCollectionId != null) return one(`SELECT Name n FROM SmartCollection WHERE Id=?`, it.SmartCollectionId)?.n ?? "(missing smart collection)";
  if (it.MultiCollectionId != null) return one(`SELECT Name n FROM MultiCollection WHERE Id=?`, it.MultiCollectionId)?.n ?? "(missing multi-collection)";
  if (it.MediaItemId != null) {
    const id = it.MediaItemId;
    const show = one(`SELECT Title t FROM ShowMetadata WHERE ShowId=?`, id); if (show) return show.t;
    const season = one(`SELECT sm.Title t, s.SeasonNumber n FROM Season s JOIN ShowMetadata sm ON sm.ShowId=s.ShowId WHERE s.Id=?`, id); if (season) return `${season.t}, season ${season.n}`;
    for (const t of ["EpisodeMetadata", "MovieMetadata", "OtherVideoMetadata", "MusicVideoMetadata", "SongMetadata", "ImageMetadata"]) {
      const col = t.replace("Metadata", "Id");
      const m = one(`SELECT Title t FROM ${t} WHERE ${col}=?`, id); if (m) return m.t;
    }
    return "(missing item)";
  }
  return "(empty entry)";
}
