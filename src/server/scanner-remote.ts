// Remote scanner — mirrors ErsatzTV legacy's Plex/Jellyfin/Emby scan behaviour.
//
// Key parity points taken from the legacy source (PlexServerApiClient.cs etc.):
//   * Items are identified by the PROVIDER KEY (Plex `/library/metadata/{id}`,
//     Jellyfin/Emby ItemId) stored per item — NOT by file path.
//   * A Shows library is enumerated as EPISODES (Plex `type=4`), not shows.
//   * Change detection uses the item's updatedAt vs our stored DateUpdated, so
//     unchanged items are left alone (their imported metadata/chapters survive).
//   * New / changed items get a full metadata refresh: title, plot, year, release
//     date, genres, tags (Plex labels), studios, guids (plex/imdb/tmdb/tvdb),
//     plus streams and chapters (Plex via a per-item metadata call; Jellyfin/Emby
//     from the listing with rich Fields).
//   * Items whose key the server no longer returns are flagged trash (never
//     deleted), with a safety guard against incomplete fetches.
//
// The HTTP layer is injectable so the upsert/matching logic is testable offline.

import { DatabaseSync } from "node:sqlite";
import { markForReindex } from "../search-index-queue.js";
import {
  openRW, tsFromSec, dtFmt, pathHash, KIND_TABLE, KIND_FK, StateEnum, MetaKindEnum,
  findOrCreateShow, findOrCreateSeason, findOrCreateArtist,
} from "./scanner-local.js";

export type ProviderType = "plex" | "jellyfin" | "emby";

export interface PathReplacement { remote: string; local: string; }
export interface RemoteLibrary { libraryId: number; kind: number; providerKey: string; name: string; }
export interface SourceInfo { type: ProviderType; sourceId: number; address: string | null; addresses: string[]; pathReplacements: PathReplacement[]; libraries: RemoteLibrary[]; }

export interface RemoteStream { index: number; kind: number; codec: string | null; profile: string | null; language: string | null; channels: number; title: string | null; def: boolean; forced: boolean; bits: number; pixel: string | null; colorTransfer?: string | null; colorSpace?: string | null; colorPrimaries?: string | null; colorRange?: string | null; }
export interface RemoteChapter { id: number; start: string; end: string; title: string | null; }

export interface RemotePerson { name: string; role?: string | null; }
export interface RemoteTag { name: string; ext?: string | null; type?: string | null; }

// Metadata "bits" (multi-valued rows). `undefined` means the source didn't supply
// that list (e.g. a Plex section listing, which omits guids/cast and truncates
// others), so the stored rows are left alone; an array — even empty — is
// authoritative and replaces what the scanner owns.
export interface RemoteBits {
  genres?: string[];
  tags?: RemoteTag[];
  studios?: string[];
  guids?: string[];
  actors?: RemotePerson[];
  directors?: string[];
  writers?: string[];
}

// A normalized item; streams/chapters are attached for new/changed items only.
export interface RemoteItem extends RemoteBits {
  key: string;                 // provider identity (Plex metadata key / Jellyfin ItemId)
  path: string | null;         // server path (pre-replacement)
  durationMs: number;
  width: number; height: number;
  scanKind: number;
  updatedAt: number;           // unix seconds (change detector)
  title: string;
  plot?: string | null;
  year?: number | null;
  releaseDate?: string | null;
  contentRating?: string | null;
  // episodes:
  show?: string; season?: number; episode?: number;
  showKey?: string;            // parent show's provider key (PlexShow.Key / JellyfinShow.ItemId)
  // artwork, provider-relative (see artworkPath): the item's own poster/thumb and
  // fan art; for episodes also their season's poster and fan art
  poster?: string | null;
  fanArt?: string | null;
  seasonPoster?: string | null;
  seasonFanArt?: string | null;
  // attached on new/changed:
  streams?: RemoteStream[];
  chapters?: RemoteChapter[];
}

// A TV show (Show + ShowMetadata), keyed like legacy: PlexShow.Key is
// "/library/metadata/{ratingKey}/children"; Jellyfin/Emby use the series ItemId.
export interface RemoteShow extends RemoteBits {
  key: string;
  detailKey?: string;          // Plex: "/library/metadata/{ratingKey}" for the full fetch
  updatedAt: number;
  title: string;
  plot?: string | null;
  tagline?: string | null;
  year?: number | null;
  releaseDate?: string | null;
  contentRating?: string | null;
  poster?: string | null;      // provider-relative artwork paths
  fanArt?: string | null;
}

// Tag ownership (legacy Tag.cs): several scanners write tags on one metadata row
// and each may remove only its own. The library scanner owns labels (typed
// "plex/label", or untyped rows from older versions); networks ("319"), NFO
// countries and provider collections belong to other scanners.
export const TAG_TYPE = { PlexLabel: "plex/label", PlexNetwork: "319", NfoCountry: "nfo/country" } as const;
const OWNED_TAG_SQL = `(ExternalTypeId IS NULL OR ExternalTypeId = '${TAG_TYPE.PlexLabel}')`;

export type Fetcher = (url: string, headers?: Record<string, string>) => Promise<any>;
const redact = (url: string) => url.replace(/(X-Plex-Token|api_key)=[^&]+/gi, "$1=***");
/** Pull the underlying reason out of a native fetch() failure (undici hides the
 *  real cause — ECONNREFUSED / ENOTFOUND / ETIMEDOUT / cert errors — in .cause). */
function fetchCause(e: any): string {
  const c = e?.cause;
  const detail = c?.code || c?.message || (typeof c === "string" ? c : "");
  return detail ? `${e.message} (${detail})` : (e?.message || String(e));
}
const defaultFetcher: Fetcher = async (url, headers) => {
  let r: Response;
  try {
    r = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new Error(`${fetchCause(e)} for ${redact(url)}`);
  }
  const body = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} for ${redact(url)}`);
  return body ? JSON.parse(body) : {};
};

/** Quick liveness check for one server URL (short timeout, no auth needed). */
async function probeAddress(type: ProviderType, address: string, token: string): Promise<boolean> {
  const base = address.replace(/\/+$/, "");
  const url = type === "plex"
    ? `${base}/identity?X-Plex-Token=${encodeURIComponent(token)}`
    : `${base}/System/Info/Public`;
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6_000) });
    return r.ok || r.status === 401; // reachable even if it wants auth
  } catch { return false; }
}

/** Try candidate connection URIs in order; return the first reachable one.
 *  Throws a descriptive error (listing what was tried) if none respond. */
export async function pickReachableAddress(
  type: ProviderType, candidates: string[], token: string,
  emit: (e: RemoteScanEvent) => void,
): Promise<string> {
  const tried: string[] = [];
  for (const addr of candidates) {
    emit({ phase: "probing", library: redact(addr) });
    if (await probeAddress(type, addr, token)) { emit({ phase: "connected", library: redact(addr) }); return addr; }
    tried.push(redact(addr));
  }
  throw new Error(`no reachable ${type} connection (tried: ${tried.join(", ") || "none"}). Is the server on and on the same network? Update its address in the source settings if its IP changed.`);
}

// ---- connection details from the imported DB (unchanged) -------------------
export function readSourceInfo(dbPath: string, sourceId: number): SourceInfo | null {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const has = (t: string, id: number) => { try { return !!db.prepare(`SELECT 1 FROM ${t} WHERE Id=?`).get(id); } catch { return false; } };
    let type: ProviderType;
    if (has("PlexMediaSource", sourceId)) type = "plex";
    else if (has("JellyfinMediaSource", sourceId)) type = "jellyfin";
    else if (has("EmbyMediaSource", sourceId)) type = "emby";
    else return null;

    let address: string | null = null;
    let addresses: string[] = [];
    let pathReplacements: PathReplacement[] = [];
    const libraries: RemoteLibrary[] = [];
    const safeAll = (sql: string, ...a: any[]): any[] => { try { return db.prepare(sql).all(...a) as any[]; } catch { return []; } };
    const safeGet = (sql: string, ...a: any[]): any => { try { return db.prepare(sql).get(...a); } catch { return undefined; } };
    const libRows = db.prepare(`SELECT l.Id id, l.MediaKind kind, l.Name name FROM Library l WHERE l.MediaSourceId=? AND l.MediaKind<>7`).all(sourceId) as any[];

    if (type === "plex") {
      // All known connection URIs, active first. The single stored "active" URI
      // can be stale (server IP changed / different network), so the scanner
      // probes these in order and uses the first that responds.
      addresses = safeAll("SELECT Uri FROM PlexConnection WHERE PlexMediaSourceId=? ORDER BY IsActive DESC", sourceId).map((r) => r.Uri).filter(Boolean);
      address = addresses[0] ?? null;
      pathReplacements = safeAll("SELECT PlexPath remote, LocalPath local FROM PlexPathReplacement WHERE PlexMediaSourceId=?", sourceId).map((r) => ({ remote: r.remote, local: r.local }));
      for (const l of libRows) { const pl = safeGet("SELECT Key FROM PlexLibrary WHERE Id=?", l.id); if (pl?.Key != null) libraries.push({ libraryId: l.id, kind: l.kind, providerKey: String(pl.Key), name: l.name }); }
    } else {
      const connT = type === "jellyfin" ? "JellyfinConnection" : "EmbyConnection";
      const connFk = type === "jellyfin" ? "JellyfinMediaSourceId" : "EmbyMediaSourceId";
      const repT = type === "jellyfin" ? "JellyfinPathReplacement" : "EmbyPathReplacement";
      const repCol = type === "jellyfin" ? "JellyfinPath" : "EmbyPath";
      const libT = type === "jellyfin" ? "JellyfinLibrary" : "EmbyLibrary";
      addresses = safeAll(`SELECT Address FROM ${connT} WHERE ${connFk}=?`, sourceId).map((r) => r.Address).filter(Boolean);
      address = addresses[0] ?? null;
      pathReplacements = safeAll(`SELECT ${repCol} remote, LocalPath local FROM ${repT} WHERE ${connFk}=?`, sourceId).map((r) => ({ remote: r.remote, local: r.local }));
      for (const l of libRows) { const jl = safeGet(`SELECT ItemId FROM ${libT} WHERE Id=?`, l.id); if (jl?.ItemId != null) libraries.push({ libraryId: l.id, kind: l.kind, providerKey: String(jl.ItemId), name: l.name }); }
    }
    return { type, sourceId, address, addresses, pathReplacements, libraries };
  } finally { db.close(); }
}

export interface DiscoveredLibrary { providerKey: string; name: string; kind: number; locations: string[] }

// Enumerate the libraries a provider exposes (for "add source" discovery).
const PLEX_SECTION_KIND: Record<string, number> = { movie: 1, show: 2, artist: 5, photo: 6 };
const JF_COLLECTION_KIND: Record<string, number> = { movies: 1, tvshows: 2, music: 5, musicvideos: 3, homevideos: 4, photos: 6, mixed: 4 };

export async function discoverLibraries(type: ProviderType, address: string, token: string, fetcher: Fetcher = defaultFetcher): Promise<DiscoveredLibrary[]> {
  const base = address.replace(/\/+$/, "");
  if (type === "plex") {
    const j = await fetcher(`${base}/library/sections?X-Plex-Token=${encodeURIComponent(token)}`, { Accept: "application/json", "X-Plex-Token": token });
    const out: DiscoveredLibrary[] = [];
    for (const d of j?.MediaContainer?.Directory ?? []) {
      const kind = PLEX_SECTION_KIND[String(d.type).toLowerCase()];
      if (!kind) continue;
      out.push({ providerKey: String(d.key), name: d.title ?? "(library)", kind, locations: (d.Location ?? []).map((l: any) => l.path).filter(Boolean) });
    }
    return out;
  }
  // jellyfin / emby
  const j = await fetcher(`${base}/Library/VirtualFolders?api_key=${encodeURIComponent(token)}`, { "X-Emby-Token": token, Accept: "application/json" });
  const arr = Array.isArray(j) ? j : (j?.Items ?? []);
  const out: DiscoveredLibrary[] = [];
  for (const v of arr) {
    const kind = JF_COLLECTION_KIND[String(v.CollectionType ?? "mixed").toLowerCase()] ?? 4;
    out.push({ providerKey: String(v.ItemId ?? v.Id ?? v.Name), name: v.Name ?? "(library)", kind, locations: v.Locations ?? [] });
  }
  return out;
}

export function applyReplacements(p: string | null, reps: PathReplacement[]): string | null {
  if (!p) return p;
  for (const r of reps) { if (r.remote && p.startsWith(r.remote)) return r.local + p.slice(r.remote.length); }
  return p;
}
function normKey(p: string): string { return p.toLowerCase().replace(/\\/g, "/"); }

// ---- Plex ------------------------------------------------------------------
const PAGE = 200;
// media kind -> Plex `type` for a section listing (1 movie, 4 episode)
const PLEX_TYPE: Record<number, number> = { 1: 1, 2: 4, 3: 4, 4: 1, 5: 1, 6: 1 };

function normalizePlexGuid(g: string): string | null {
  const s = g.toLowerCase();
  if (s.startsWith("plex://")) return g;
  if (s.startsWith("com.plexapp.agents.imdb")) return "imdb://" + g.replace(/^com\.plexapp\.agents\.imdb:\/\//i, "").split("?")[0];
  if (s.startsWith("com.plexapp.agents.thetvdb")) return "tvdb://" + g.replace(/^com\.plexapp\.agents\.thetvdb:\/\//i, "").split("?")[0];
  if (s.startsWith("com.plexapp.agents.themoviedb")) return "tmdb://" + g.replace(/^com\.plexapp\.agents\.themoviedb:\/\//i, "").split("?")[0];
  if (/^(imdb|tmdb|tvdb):\/\//i.test(g)) return g;
  return null; // local:// and unknown agents are ignored, like legacy
}

/** Multi-valued Plex tags. `full` = a /library/metadata/{id} response (complete
 *  lists, absent == none); otherwise a section listing, whose tag lists are
 *  partial, so they're reported as unknown (undefined) and left untouched. */
function plexBits(it: any, full: boolean): RemoteBits {
  const tags = (xs: any[] | undefined) => (xs ?? []).map((x: any) => String(x.tag ?? "")).filter(Boolean);
  if (!full) return { studios: it.studio ? [it.studio] : undefined };
  const guids: string[] = [];
  for (const g of [...(it.Guid ?? []).map((x: any) => x.id), it.guid]) { const n = normalizePlexGuid(String(g ?? "")); if (n && !guids.includes(n)) guids.push(n); }
  return {
    genres: tags(it.Genre),
    tags: (it.Label ?? []).filter((l: any) => l.tag).map((l: any) => ({ name: l.tag, ext: l.id != null ? String(l.id) : null, type: TAG_TYPE.PlexLabel })),
    studios: it.studio ? [it.studio] : [],
    guids,
    actors: (it.Role ?? []).filter((r: any) => r.tag).map((r: any) => ({ name: r.tag, role: r.role ?? null })),
    directors: tags(it.Director),
    writers: tags(it.Writer),
  };
}

function projectPlexItem(it: any, full = false): RemoteItem | null {
  const media = (it.Media ?? []).filter((m: any) => (m.Part ?? []).length > 0).sort((a: any, b: any) => (b.id ?? 0) - (a.id ?? 0))[0];
  const part = media?.Part?.[0];
  return {
    key: it.key,
    path: part?.file ?? null,
    durationMs: Number(media?.duration ?? it.duration ?? 0) || 0,
    width: Number(media?.width ?? 0) || 0,
    height: Number(media?.height ?? 0) || 0,
    scanKind: 0,
    updatedAt: Number(it.updatedAt ?? 0) || 0,
    title: it.title ?? "(untitled)",
    plot: it.summary ?? null,
    year: it.year ?? null,
    releaseDate: it.originallyAvailableAt ?? null,
    contentRating: it.contentRating ?? null,
    ...plexBits(it, full),
    show: it.grandparentTitle, season: it.parentIndex, episode: it.index,
    showKey: it.grandparentKey ? `${it.grandparentKey}/children` : undefined,
    poster: it.thumb ?? null, fanArt: it.art ?? null,
    // legacy: a season's poster is its own thumb, its fan art the show's
    seasonPoster: it.parentThumb ?? null, seasonFanArt: it.grandparentArt ?? null,
  };
}

function projectPlexShow(it: any, full = false): RemoteShow | null {
  if (!it?.key) return null;
  return {
    key: String(it.key),
    detailKey: it.ratingKey != null ? `/library/metadata/${it.ratingKey}` : String(it.key).replace(/\/children$/, ""),
    updatedAt: Number(it.updatedAt ?? 0) || 0,
    title: it.title ?? "(untitled)",
    plot: it.summary ?? null,
    tagline: it.tagline ?? null,
    year: it.year ?? null,
    releaseDate: it.originallyAvailableAt ?? null,
    contentRating: it.contentRating ?? null,
    poster: it.thumb ?? null,
    fanArt: it.art ?? null,
    ...plexBits(it, full),
  };
}

export async function fetchPlexListing(address: string, token: string, lib: RemoteLibrary, fetcher: Fetcher, onPage?: (n: number, total: number) => void): Promise<RemoteItem[]> {
  const base = address.replace(/\/+$/, "");
  const type = PLEX_TYPE[lib.kind] ?? 1;
  const items: RemoteItem[] = [];
  const seen = new Set<string>();
  let start = 0, total = 0;
  for (let guard = 0; guard < 1_000_000; guard++) {
    const url = `${base}/library/sections/${encodeURIComponent(lib.providerKey)}/all` +
      `?type=${type}&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PAGE}&X-Plex-Token=${encodeURIComponent(token)}`;
    const j = await fetcher(url, { Accept: "application/json", "X-Plex-Token": token });
    const mc = j?.MediaContainer ?? {};
    const page = mc.Metadata ?? [];
    if (page.length === 0) break;
    total = Number(mc.totalSize ?? mc.size ?? 0) || total;
    let fresh = 0;
    for (const raw of page) {
      const it = projectPlexItem(raw);
      if (!it || !it.key || seen.has(it.key)) continue;
      seen.add(it.key); fresh++; items.push(it);
    }
    start += page.length;
    onPage?.(items.length, total || items.length);
    if (fresh === 0) break;
    if (total && start >= total) break;
    if (!total && page.length < PAGE) break;
  }
  return items;
}

// One Plex item's full metadata (complete genres/labels/guids/cast/crew) plus
// streams + chapters in a single call — Plex only returns these per item. Used
// for new/changed items during a library scan and by deep scan.
export async function fetchPlexItemFull(address: string, token: string, key: string, fetcher: Fetcher): Promise<RemoteItem | null> {
  const base = address.replace(/\/+$/, "");
  // includeChapters=1 is REQUIRED — Plex omits Chapter data from /library/metadata otherwise
  const j = await fetcher(`${base}${key}?includeChapters=1&X-Plex-Token=${encodeURIComponent(token)}`, { Accept: "application/json", "X-Plex-Token": token });
  const md = j?.MediaContainer?.Metadata?.[0];
  if (!md) return null;
  const item = projectPlexItem(md, true);
  if (!item) return null;
  const media = (md.Media ?? []).filter((m: any) => (m.Part ?? []).length > 0).sort((a: any, b: any) => (b.id ?? 0) - (a.id ?? 0))[0] ?? {};
  const part = media.Part?.[0] ?? {};
  const streams: RemoteStream[] = [];
  for (const s of part.Stream ?? []) {
    const kind = s.streamType === 1 ? 1 : s.streamType === 2 ? 2 : s.streamType === 3 ? 3 : 0;
    if (kind === 0) continue;
    if (kind === 1) { item.width = Number(s.width ?? media.width ?? item.width) || 0; item.height = Number(s.height ?? media.height ?? item.height) || 0; item.scanKind = s.scanType === "progressive" ? 2 : s.scanType === "interlaced" ? 1 : 0; }
    streams.push({ index: Number(s.index ?? 0) || 0, kind, codec: s.codec ?? null, profile: s.profile ?? null, language: s.languageCode ?? s.language ?? null, channels: Number(s.channels ?? 0) || 0, title: s.title ?? null, def: !!s.default, forced: !!s.forced, bits: Number(s.bitDepth ?? 0) || 0, pixel: s.chromaSubsampling ?? null,
      colorTransfer: s.colorTrc ?? null, colorSpace: s.colorSpace ?? null, colorPrimaries: s.colorPrimaries ?? null, colorRange: s.colorRange ?? null });
  }
  item.streams = streams;
  item.chapters = (md.Chapter ?? []).map((c: any, i: number) => ({ id: Number(c.index ?? i) || i, start: tsFromSec((Number(c.startTimeOffset ?? 0) || 0) / 1000), end: tsFromSec((Number(c.endTimeOffset ?? 0) || 0) / 1000), title: c.tag ?? null }));
  return item;
}

/** Fold a full per-item fetch into the listing item it refreshes. */
export function mergeDetail(it: RemoteItem, d: RemoteItem): void {
  it.streams = d.streams; it.chapters = d.chapters;
  if (d.width) { it.width = d.width; it.height = d.height; it.scanKind = d.scanKind; }
  for (const k of ["genres", "tags", "studios", "guids", "actors", "directors", "writers"] as const) if (d[k] !== undefined) (it as any)[k] = d[k];
  if (d.contentRating !== undefined) it.contentRating = d.contentRating;
}

async function pagedPlex(base: string, path: string, token: string, fetcher: Fetcher, pick: (mc: any) => any[], onPage?: (n: number, total: number) => void): Promise<any[]> {
  const out: any[] = [];
  let start = 0;
  for (let guard = 0; guard < 100_000; guard++) {
    const sep = path.includes("?") ? "&" : "?";
    const j = await fetcher(`${base}${path}${sep}X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PAGE}&X-Plex-Token=${encodeURIComponent(token)}`, { Accept: "application/json", "X-Plex-Token": token });
    const mc = j?.MediaContainer ?? {};
    const page = pick(mc) ?? [];
    if (page.length === 0) break;
    out.push(...page);
    start += page.length;
    const total = Number(mc.totalSize ?? 0) || 0;
    onPage?.(out.length, total || out.length);
    if (total ? start >= total : page.length < PAGE) break;
  }
  return out;
}

/** The shows in a Plex Shows section (listing data; detail comes separately). */
export async function fetchPlexShows(address: string, token: string, lib: RemoteLibrary, fetcher: Fetcher): Promise<RemoteShow[]> {
  const base = address.replace(/\/+$/, "");
  const raw = await pagedPlex(base, `/library/sections/${encodeURIComponent(lib.providerKey)}/all?type=2`, token, fetcher, (mc) => mc.Metadata);
  const seen = new Set<string>();
  return raw.map((r) => projectPlexShow(r)).filter((s): s is RemoteShow => !!s && !seen.has(s.key) && !!seen.add(s.key));
}

/** One show's full metadata (complete genres/labels/guids/cast) — legacy's GetShowMetadata. */
export async function fetchPlexShowFull(address: string, token: string, show: RemoteShow, fetcher: Fetcher): Promise<RemoteShow | null> {
  const base = address.replace(/\/+$/, "");
  const j = await fetcher(`${base}${show.detailKey ?? show.key}?X-Plex-Token=${encodeURIComponent(token)}`, { Accept: "application/json", "X-Plex-Token": token });
  const md = j?.MediaContainer?.Metadata?.[0];
  if (!md) return null;
  const full = projectPlexShow({ ...md, key: show.key }, true);
  return full;
}

/** Networks, legacy PlexNetworkScanner-style: Plex doesn't put a show's network
 *  on the show itself, so enumerate every network tag (type 319) on the server,
 *  then list which of this section's shows carry each one. Returns show key ->
 *  network names, plus the names whose show list couldn't be fetched (their
 *  existing assignments must be kept, not cleared). Throws if the network list
 *  itself can't be read, so the caller leaves every assignment alone. */
export async function fetchPlexNetworks(address: string, token: string, lib: RemoteLibrary, fetcher: Fetcher, onProgress?: (done: number, total: number) => void): Promise<{ byShow: Map<string, Set<string>>; failed: Set<string>; networks: number }> {
  const base = address.replace(/\/+$/, "");
  const tags = (await pagedPlex(base, `/library/tags?type=${TAG_TYPE.PlexNetwork}`, token, fetcher, (mc) => mc.Directory))
    .filter((t) => t?.tag)
    .map((t) => {
      // filter looks like "network=1234"; legacy takes the (last) value
      let value = "";
      for (const [, v] of new URLSearchParams(String(t.filter ?? ""))) value = v;
      return { name: String(t.tag), value: value || String(t.id ?? "") };
    })
    .filter((t) => t.value);
  const byShow = new Map<string, Set<string>>();
  const failed = new Set<string>();
  let done = 0;
  await pooled(tags, 6, async (t) => {
    try {
      const shows = await pagedPlex(base, `/library/sections/${encodeURIComponent(lib.providerKey)}/all?type=2&network=${encodeURIComponent(t.value)}`, token, fetcher, (mc) => mc.Metadata);
      for (const s of shows) if (s?.key) { const k = String(s.key); (byShow.get(k) ?? byShow.set(k, new Set()).get(k)!).add(t.name); }
    } catch { failed.add(t.name); }
    done++; if (done % 25 === 0 || done === tags.length) onProgress?.(done, tags.length);
  });
  return { byShow, failed, networks: tags.length };
}

// ---- Jellyfin / Emby (rich listing includes streams + chapters) ------------
const JF_TYPE: Record<number, string> = { 1: "Movie", 2: "Episode", 3: "MusicVideo", 4: "Video", 5: "Audio", 6: "Photo" };

function projectJellyfinItem(it: any): RemoteItem {
  const streams: RemoteStream[] = [];
  let width = 0, height = 0, scanKind = 0;
  for (const s of it.MediaStreams ?? []) {
    const t = String(s.Type ?? "").toLowerCase();
    const kind = t === "video" ? 1 : t === "audio" ? 2 : t === "subtitle" ? 3 : 0;
    if (kind === 0) continue;
    if (kind === 1 && width === 0) { width = Number(s.Width ?? 0) || 0; height = Number(s.Height ?? 0) || 0; scanKind = s.IsInterlaced ? 1 : 2; }
    streams.push({ index: Number(s.Index ?? 0) || 0, kind, codec: s.Codec ?? null, profile: s.Profile ?? null, language: s.Language ?? null, channels: Number(s.Channels ?? 0) || 0, title: s.Title ?? s.DisplayTitle ?? null, def: !!s.IsDefault, forced: !!s.IsForced, bits: Number(s.BitDepth ?? 0) || 0, pixel: s.PixelFormat ?? null,
      colorTransfer: s.ColorTransfer ?? null, colorSpace: s.ColorSpace ?? null, colorPrimaries: s.ColorPrimaries ?? null, colorRange: s.ColorRange ?? null });
  }
  const chapters: RemoteChapter[] = (it.Chapters ?? []).map((c: any, i: number) => ({ id: i, start: tsFromSec((Number(c.StartPositionTicks ?? 0) || 0) / 1e7), end: "00:00:00", title: c.Name ?? null }));
  return {
    key: String(it.Id),
    path: it.Path ?? null,
    durationMs: it.RunTimeTicks ? Math.round(Number(it.RunTimeTicks) / 1e4) : 0,
    width, height, scanKind,
    updatedAt: it.DateLastMediaAdded || it.DateCreated ? Math.floor(new Date(it.DateLastMediaAdded ?? it.DateCreated).getTime() / 1000) : 0,
    title: it.Name ?? "(untitled)",
    plot: it.Overview ?? null,
    year: it.ProductionYear ?? null,
    releaseDate: it.PremiereDate ?? null,
    contentRating: it.OfficialRating ?? null,
    ...jellyfinBits(it),
    show: it.SeriesName, season: it.ParentIndexNumber, episode: it.IndexNumber,
    showKey: it.SeriesId ? String(it.SeriesId) : undefined,
    ...jellyfinArt(it),
    streams, chapters,
  };
}

// Jellyfin/Emby return complete lists for every requested Field, so these are
// authoritative (legacy JellyfinApiClient: People split by Type).
const JF_ITEM_FIELDS = "Path,Overview,ProductionYear,PremiereDate,RunTimeTicks,Genres,Studios,Tags,ProviderIds,MediaStreams,Chapters,DateCreated,People,OfficialRating";
const JF_SERIES_FIELDS = "Overview,ProductionYear,PremiereDate,Genres,Studios,Tags,ProviderIds,DateCreated,People,OfficialRating,Taglines";
/** Jellyfin/Emby image references, stored (like legacy) as
 *  "jellyfin://Items/{id}/Images/Primary?tag={tag}" — see artworkPath(). */
function jellyfinArt(it: any): { poster: string | null; fanArt: string | null } {
  const img = (id: any, kind: string, tag: any) => (id && tag ? `Items/${id}/Images/${kind}?tag=${tag}` : null);
  return {
    poster: img(it.Id, "Primary", it.ImageTags?.Primary),
    fanArt: img(it.Id, "Backdrop", it.BackdropImageTags?.[0]),
  };
}

function jellyfinBits(it: any): RemoteBits {
  const guids: string[] = [];
  for (const [k, v] of Object.entries(it.ProviderIds ?? {})) { const kk = String(k).toLowerCase(); if (["imdb", "tmdb", "tvdb"].includes(kk) && v) guids.push(`${kk}://${v}`); }
  const people = (type: string) => (it.People ?? []).filter((p: any) => p?.Name && String(p.Type ?? "").toLowerCase() === type);
  return {
    genres: it.Genres ?? [],
    tags: (it.Tags ?? []).map((t: string) => ({ name: t })),
    studios: (it.Studios ?? []).map((s: any) => s.Name).filter(Boolean),
    guids,
    actors: people("actor").map((p: any) => ({ name: p.Name, role: p.Role ?? null })),
    directors: people("director").map((p: any) => p.Name),
    writers: people("writer").map((p: any) => p.Name),
  };
}

/** Series in a Jellyfin/Emby TV library (the listing is complete — no detail call). */
export async function fetchJellyfinShows(address: string, token: string, lib: RemoteLibrary, fetcher: Fetcher): Promise<RemoteShow[]> {
  const base = address.replace(/\/+$/, "");
  const out: RemoteShow[] = [];
  let start = 0;
  for (let guard = 0; guard < 100_000; guard++) {
    const j = await fetcher(`${base}/Items?ParentId=${encodeURIComponent(lib.providerKey)}&Recursive=true&IncludeItemTypes=Series&Fields=${JF_SERIES_FIELDS}&StartIndex=${start}&Limit=${PAGE}&api_key=${encodeURIComponent(token)}`, { "X-Emby-Token": token, Accept: "application/json" });
    const page = j?.Items ?? [];
    if (page.length === 0) break;
    for (const it of page) {
      if (!it?.Id) continue;
      out.push({
        key: String(it.Id), updatedAt: 0, title: it.Name ?? "(untitled)", plot: it.Overview ?? null,
        tagline: it.Taglines?.[0] ?? null, year: it.ProductionYear ?? null, releaseDate: it.PremiereDate ?? null,
        contentRating: it.OfficialRating ?? null, ...jellyfinBits(it), ...jellyfinArt(it),
      });
    }
    start += page.length;
    if (start >= Number(j?.TotalRecordCount ?? start)) break;
  }
  return out;
}

// Deep-scan: fetch specific Jellyfin/Emby items by id, with streams + chapters.
export async function fetchJellyfinByIds(address: string, token: string, ids: string[], fetcher: Fetcher): Promise<RemoteItem[]> {
  if (!ids.length) return [];
  const base = address.replace(/\/+$/, "");
  const fields = JF_ITEM_FIELDS;
  const j = await fetcher(`${base}/Items?Ids=${ids.map(encodeURIComponent).join(",")}&Fields=${fields}&api_key=${encodeURIComponent(token)}`, { "X-Emby-Token": token, Accept: "application/json" });
  return (j?.Items ?? []).map((it: any) => projectJellyfinItem(it));
}

export async function fetchJellyfinListing(address: string, token: string, lib: RemoteLibrary, fetcher: Fetcher, onPage?: (n: number, total: number) => void): Promise<RemoteItem[]> {
  const base = address.replace(/\/+$/, "");
  const type = JF_TYPE[lib.kind] ?? "Video";
  const fields = JF_ITEM_FIELDS;
  const items: RemoteItem[] = [];
  const seen = new Set<string>();
  let start = 0;
  for (let guard = 0; guard < 1_000_000; guard++) {
    const url = `${base}/Items?ParentId=${encodeURIComponent(lib.providerKey)}&Recursive=true&IncludeItemTypes=${type}` +
      `&Fields=${fields}&StartIndex=${start}&Limit=${PAGE}&api_key=${encodeURIComponent(token)}`;
    const j = await fetcher(url, { "X-Emby-Token": token, Accept: "application/json" });
    const page = j?.Items ?? [];
    if (page.length === 0) break;
    let fresh = 0;
    for (const raw of page) { const it = projectJellyfinItem(raw); if (!it.key || seen.has(it.key)) continue; seen.add(it.key); fresh++; items.push(it); }
    const total = Number(j?.TotalRecordCount ?? (start + page.length));
    start += page.length;
    onPage?.(items.length, total);
    if (fresh === 0 || start >= total) break;
  }
  return items;
}

// ---- DB helpers ------------------------------------------------------------
const providerKeyTable = (type: ProviderType, kind: number) => `${type === "plex" ? "Plex" : type === "jellyfin" ? "Jellyfin" : "Emby"}${KIND_TABLE[kind]}`;
const providerKeyCol = (type: ProviderType) => (type === "plex" ? "Key" : "ItemId");
const metaBitFk = (kind: number) => `${KIND_TABLE[kind]}MetadataId`;

function safeRun(db: DatabaseSync, sql: string, ...args: any[]): void { try { db.prepare(sql).run(...args); } catch { /* column/table may not exist for this kind */ } }

// ---- artwork (legacy ArtworkKind + Path formats) ----------------------------
const ART = { Poster: 0, Thumbnail: 1, FanArt: 3 } as const;
/** Provider-relative artwork -> the Artwork.Path legacy stores:
 *  Plex "plex/{sourceId}/library/metadata/1/thumb/2", Jellyfin/Emby
 *  "jellyfin://Items/{id}/Images/Primary?tag=…" (the source comes from the item). */
export function artworkPath(type: ProviderType, sourceId: number, p: string | null | undefined): string | null {
  if (!p) return null;
  return type === "plex" ? `plex/${sourceId}${p.startsWith("/") ? p : "/" + p}` : `${type}://${p.replace(/^\/+/, "")}`;
}
/** Make this metadata row's artwork match: one row per kind given a path. A kind
 *  the provider didn't send is left alone (listings can omit it). */
export function syncArtwork(db: DatabaseSync, fk: string, metaId: number, art: [number, string | null][], now: string): number {
  let changed = 0;
  for (const [kind, path] of art) {
    if (!path) continue;
    let rows: any[];
    try { rows = db.prepare(`SELECT Id, Path FROM Artwork WHERE ${fk}=? AND ArtworkKind=?`).all(metaId, kind) as any[]; } catch { return changed; }
    if (rows.length === 1 && rows[0].Path === path) continue;
    for (const r of rows) db.prepare("DELETE FROM Artwork WHERE Id=?").run(r.Id);
    db.prepare(`INSERT INTO Artwork (${fk}, ArtworkKind, Path, DateAdded, DateUpdated) VALUES (?,?,?,?,?)`).run(metaId, kind, path, now, now);
    changed++;
  }
  return changed;
}
/** An item's own artwork (episodes: a thumbnail; others: poster + fan art), and
 *  for episodes their season's, once per season per scan. */
function syncItemArtwork(db: DatabaseSync, type: ProviderType, sourceId: number, kind: number, itemId: number, metaId: number | null, it: RemoteItem, now: string, seasonsDone: Set<number>): number {
  let n = 0;
  const a = (p: string | null | undefined) => artworkPath(type, sourceId, p);
  if (metaId != null) n += syncArtwork(db, metaBitFk(kind), metaId, kind === 2 ? [[ART.Thumbnail, a(it.poster)]] : [[ART.Poster, a(it.poster)], [ART.FanArt, a(it.fanArt)]], now);
  if (kind === 2 && (it.seasonPoster || it.seasonFanArt)) {
    const se = db.prepare("SELECT sm.Id metaId, e.SeasonId seasonId FROM Episode e JOIN SeasonMetadata sm ON sm.SeasonId=e.SeasonId WHERE e.Id=? LIMIT 1").get(itemId) as any;
    if (se && !seasonsDone.has(se.seasonId)) {
      seasonsDone.add(se.seasonId);
      n += syncArtwork(db, "SeasonMetadataId", se.metaId, [[ART.Poster, a(it.seasonPoster)], [ART.FanArt, a(it.seasonFanArt)]], now);
    }
  }
  return n;
}

/** Replace the metadata rows this scanner owns — only for lists the source
 *  actually supplied (undefined = leave the stored rows alone). Tags other
 *  scanners own (networks, countries, collections) are never touched. `fk` is
 *  the metadata column, e.g. "MovieMetadataId" / "ShowMetadataId". */
export function setMetaBits(db: DatabaseSync, fk: string, metaId: number, b: RemoteBits): void {
  const replace = <T>(table: string, xs: T[] | undefined, cols: string, vals: (x: T) => any[], where = "") => {
    if (xs === undefined) return;
    safeRun(db, `DELETE FROM ${table} WHERE ${fk}=? ${where}`, metaId);
    const n = cols.split(",").length + 1;
    for (const x of xs) safeRun(db, `INSERT INTO ${table} (${fk}, ${cols}) VALUES (${Array(n).fill("?").join(",")})`, metaId, ...vals(x));
  };
  const uniq = (xs?: string[]) => (xs === undefined ? undefined : [...new Set(xs.filter(Boolean))]);
  replace("Genre", uniq(b.genres), "Name", (g) => [g]);
  replace("Studio", uniq(b.studios), "Name", (s) => [s]);
  replace("MetadataGuid", uniq(b.guids), "Guid", (g) => [g]);
  replace("Director", uniq(b.directors), "Name", (d) => [d]);
  replace("Writer", uniq(b.writers), "Name", (w) => [w]);
  replace("Actor", b.actors, `Name, Role, "Order"`, (a) => [a.name, a.role ?? null, b.actors!.indexOf(a)]);
  replace("Tag", b.tags, "Name, ExternalCollectionId, ExternalTypeId", (t) => [t.name, t.ext ?? null, t.type ?? null], `AND ${OWNED_TAG_SQL}`);
}

function setStreamsChapters(db: DatabaseSync, versionId: number, it: RemoteItem): void {
  // A valid media item always has at least a video stream. If the detail fetch
  // returned no streams, it failed/was empty — do NOT wipe the existing streams
  // and chapters (this is what previously erased chapters on a bad fetch).
  if (!(it.streams && it.streams.length)) return;
  db.prepare("DELETE FROM MediaStream WHERE MediaVersionId=?").run(versionId);
  db.prepare("DELETE FROM MediaChapter WHERE MediaVersionId=?").run(versionId);
  const si = db.prepare(`INSERT INTO MediaStream ("Index", Codec, Profile, MediaStreamKind, Language, Channels, Title, "Default", "Forced", MediaVersionId, BitsPerRawSample, PixelFormat, ColorTransfer, ColorSpace, ColorPrimaries, ColorRange, AttachedPic) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`);
  for (const s of it.streams ?? []) si.run(s.index, s.codec, s.profile, s.kind, s.language, s.channels, s.title, s.def ? 1 : 0, s.forced ? 1 : 0, versionId, s.bits, s.pixel, s.colorTransfer ?? null, s.colorSpace ?? null, s.colorPrimaries ?? null, s.colorRange ?? null);
  const ci = db.prepare("INSERT INTO MediaChapter (MediaVersionId, ChapterId, StartTime, EndTime, Title) VALUES (?,?,?,?,?)");
  for (const c of it.chapters ?? []) ci.run(versionId, c.id, c.start, c.end, c.title);
}

function writeMetadataFields(db: DatabaseSync, kind: number, metaId: number, it: RemoteItem, now: string): void {
  const tbl = `${KIND_TABLE[kind]}Metadata`;
  safeRun(db, `UPDATE ${tbl} SET Title=?, Plot=?, Year=?, ReleaseDate=?, DateUpdated=? WHERE Id=?`, it.title, it.plot ?? null, it.year ?? null, it.releaseDate ?? null, now, metaId);
  // separate statement: not every *Metadata table has ContentRating
  if (it.contentRating !== undefined) safeRun(db, `UPDATE ${tbl} SET ContentRating=? WHERE Id=?`, it.contentRating, metaId);
}

// ---- shows -----------------------------------------------------------------
const showKeyTable = (type: ProviderType) => `${type === "plex" ? "Plex" : type === "jellyfin" ? "Jellyfin" : "Emby"}Show`;
const showEtag = (s: RemoteShow) => (s.updatedAt ? `u:${s.updatedAt}` : null);

/** Show key -> Show.Id for every keyed show already in this library. */
export function libraryShowKeys(db: DatabaseSync, type: ProviderType, libraryId: number): Map<string, { showId: number; etag: string | null }> {
  const m = new Map<string, { showId: number; etag: string | null }>();
  const keyCol = providerKeyCol(type);
  try {
    for (const r of db.prepare(
      `SELECT k.${keyCol} k, k.Id id, k.Etag etag FROM ${showKeyTable(type)} k JOIN MediaItem mi ON mi.Id=k.Id
        WHERE mi.LibraryPathId IN (SELECT Id FROM LibraryPath WHERE LibraryId=?)`
    ).all(libraryId) as any[]) if (r.k) m.set(String(r.k), { showId: r.id, etag: r.etag ?? null });
  } catch { /* key table absent */ }
  return m;
}

/** Shows whose stored etag differs from the listing — they need a full refresh. */
export function showsNeedingDetail(db: DatabaseSync, type: ProviderType, libraryId: number, shows: RemoteShow[], force = false): RemoteShow[] {
  const known = libraryShowKeys(db, type, libraryId);
  return shows.filter((s) => force || !known.has(s.key) || known.get(s.key)!.etag !== showEtag(s));
}

export interface ShowUpsertSummary { found: number; added: number; adopted: number; updated: number; }

/** Upsert a library's shows by provider key (legacy matches PlexShow.Key within
 *  the library). A keyless show of the same title in this library — one an older
 *  scan created from an episode's show name — is adopted rather than duplicated.
 *  Returns show key -> Show.Id for placing episodes. */
export function upsertRemoteShows(db: DatabaseSync, type: ProviderType, sourceId: number, libraryId: number, shows: RemoteShow[], summary?: ShowUpsertSummary): Map<string, number> {
  const lp = db.prepare("SELECT Id FROM LibraryPath WHERE LibraryId=? LIMIT 1").get(libraryId) as any;
  if (!lp) throw new Error(`Library ${libraryId} has no LibraryPath`);
  const keyTbl = showKeyTable(type), keyCol = providerKeyCol(type);
  const known = libraryShowKeys(db, type, libraryId);
  const now = dtFmt(Date.now());
  const map = new Map<string, number>();
  const s = summary ?? { found: 0, added: 0, adopted: 0, updated: 0 };
  s.found += shows.length;
  const keyless = db.prepare(
    `SELECT sm.ShowId id FROM ShowMetadata sm JOIN MediaItem mi ON mi.Id=sm.ShowId
      WHERE sm.Title=? AND mi.LibraryPathId IN (SELECT Id FROM LibraryPath WHERE LibraryId=?)
        AND sm.ShowId NOT IN (SELECT Id FROM ${keyTbl}) LIMIT 1`);

  for (const show of shows) {
    let showId = known.get(show.key)?.showId;
    const stamp = show.updatedAt ? dtFmt(show.updatedAt * 1000) : now;
    // Only a full (detail) record earns the new etag; a listing-only record whose
    // detail fetch failed keeps the old one so the next scan retries it.
    const etag = show.guids === undefined ? (known.get(show.key)?.etag ?? null) : showEtag(show);
    if (showId == null) {
      const adopt = keyless.get(show.title, libraryId) as any;
      if (adopt) { showId = adopt.id as number; s.adopted++; }
      else {
        showId = Number((db.prepare("INSERT INTO MediaItem (LibraryPathId, State) VALUES (?, ?)").run(lp.Id, StateEnum.Normal) as any).lastInsertRowid);
        db.prepare("INSERT INTO Show (Id) VALUES (?)").run(showId);
        s.added++;
      }
      db.prepare(`INSERT INTO ${keyTbl} (Id, ${keyCol}, Etag) VALUES (?,?,?)`).run(showId, show.key, etag);
    } else {
      // listing-only rows (no detail fetched) with an unchanged etag: nothing to do
      if (known.get(show.key)!.etag === showEtag(show) && show.guids === undefined) { map.set(show.key, showId); continue; }
      safeRun(db, `UPDATE ${keyTbl} SET Etag=? WHERE Id=?`, etag, showId);
      s.updated++;
    }
    map.set(show.key, showId);
    markForReindex(db, showId);

    let meta = db.prepare("SELECT Id FROM ShowMetadata WHERE ShowId=? LIMIT 1").get(showId) as any;
    if (!meta) meta = { Id: Number((db.prepare("INSERT INTO ShowMetadata (ShowId, MetadataKind, Title, SortTitle, DateAdded, DateUpdated) VALUES (?,?,?,?,?,?)").run(showId, 2, show.title, show.title, now, stamp) as any).lastInsertRowid) };
    db.prepare(`UPDATE ShowMetadata SET MetadataKind=2, Title=?, SortTitle=COALESCE(SortTitle, ?), Plot=?, Tagline=?, Year=?, ReleaseDate=?, ContentRating=?, DateUpdated=? WHERE Id=?`)
      .run(show.title, show.title, show.plot ?? null, show.tagline ?? null, show.year ?? null, show.releaseDate ?? null, show.contentRating ?? null, stamp, meta.Id);
    setMetaBits(db, "ShowMetadataId", meta.Id, show);
    syncArtwork(db, "ShowMetadataId", meta.Id, [[ART.Poster, artworkPath(type, sourceId, show.poster)], [ART.FanArt, artworkPath(type, sourceId, show.fanArt)]], now);
  }
  return map;
}

/** Apply network tags (type 319) to this library's shows. Only shows the listing
 *  returned are touched, and names whose lookup failed keep what they had. */
export function applyShowNetworks(db: DatabaseSync, showMap: Map<string, number>, net: { byShow: Map<string, Set<string>>; failed: Set<string> }): { added: number; removed: number } {
  let added = 0, removed = 0;
  const metaOf = db.prepare("SELECT Id FROM ShowMetadata WHERE ShowId=?");
  const existing = db.prepare(`SELECT Id, Name FROM Tag WHERE ShowMetadataId=? AND ExternalTypeId='${TAG_TYPE.PlexNetwork}'`);
  const del = db.prepare("DELETE FROM Tag WHERE Id=?");
  const ins = db.prepare("INSERT INTO Tag (Name, ExternalTypeId, ShowMetadataId) VALUES (?,?,?)");
  for (const [key, showId] of showMap) {
    const want = net.byShow.get(key) ?? new Set<string>();
    for (const m of metaOf.all(showId) as any[]) {
      const have = existing.all(m.Id) as any[];
      const haveNames = new Set(have.map((t) => t.Name));
      let changedShow = false;
      for (const t of have) if (!want.has(t.Name) && !net.failed.has(t.Name)) { del.run(t.Id); removed++; changedShow = true; }
      for (const n of want) if (!haveNames.has(n)) { ins.run(n, TAG_TYPE.PlexNetwork, m.Id); added++; changedShow = true; }
      if (changedShow) markForReindex(db, showId);
    }
  }
  return { added, removed };
}

// ---- upsert one library ----------------------------------------------------
export interface RemoteScanSummary { libraryId: number; kind: number; found: number; existing: number; added: number; updated: number; unchanged: number; missing: number; missingSkipped?: boolean; reparented?: number; artwork?: number; shows?: ShowUpsertSummary; networks?: { networks: number; added: number; removed: number; failed: number }; ms: number; }

interface ExistRec { itemId: number; versionId: number; metaId: number | null; dateUpdated: string; path: string; showId?: number | null; }

export function upsertRemoteLibrary(db: DatabaseSync, type: ProviderType, lib: RemoteLibrary, items: RemoteItem[], reps: PathReplacement[], opts: { skipMissing?: boolean; showMap?: Map<string, number> } = {}): RemoteScanSummary {
  const t0 = Date.now();
  const kind = lib.kind;
  const tbl = KIND_TABLE[kind], fk = KIND_FK[kind];
  if (!tbl) throw new Error(`Unsupported media kind ${kind}`);
  const lp = db.prepare("SELECT Id FROM LibraryPath WHERE LibraryId=? LIMIT 1").get(lib.libraryId) as any;
  if (!lp) throw new Error(`Library ${lib.libraryId} has no LibraryPath`);
  const lpId = lp.Id;
  const keyTbl = providerKeyTable(type, kind), keyCol = providerKeyCol(type);
  const metaTbl = `${tbl}Metadata`;
  const now = dtFmt(Date.now());
  const sourceId = Number((db.prepare("SELECT MediaSourceId s FROM Library WHERE Id=?").get(lib.libraryId) as any)?.s ?? 0);
  const seasonsDone = new Set<number>();
  let artwork = 0;

  // existing items: index by provider key AND by normalized path (fallback)
  const byKey = new Map<string, ExistRec>();
  const byPath = new Map<string, ExistRec>();
  const rows = db.prepare(
    `SELECT k.Id itemId, mv.Id versionId, mv.DateUpdated du, mf.Path path,
            (SELECT pk.${keyCol} FROM ${keyTbl} pk WHERE pk.Id=k.Id) pkey,
            (SELECT m.Id FROM ${metaTbl} m WHERE m.${fk}=k.Id LIMIT 1) metaId,
            ${kind === 2 ? "(SELECT se.ShowId FROM Season se WHERE se.Id=k.SeasonId)" : "NULL"} showId
       FROM ${tbl} k
       JOIN MediaItem mi ON mi.Id=k.Id
       JOIN MediaVersion mv ON mv.${fk}=k.Id
       LEFT JOIN MediaFile mf ON mf.MediaVersionId=mv.Id
      WHERE mi.LibraryPathId IN (SELECT Id FROM LibraryPath WHERE LibraryId=?)`
  ).all(lib.libraryId) as any[];
  for (const r of rows) {
    const rec: ExistRec = { itemId: r.itemId, versionId: r.versionId, metaId: r.metaId ?? null, dateUpdated: r.du ?? "", path: r.path ?? "", showId: r.showId ?? null };
    if (r.pkey) byKey.set(String(r.pkey), rec);
    if (r.path) byPath.set(normKey(String(r.path)), rec);
  }

  const matchedIds = new Set<number>();
  let added = 0, updated = 0, unchanged = 0, reparented = 0;

  for (const it of items) {
    const path = applyReplacements(it.path, reps);
    let prev = byKey.get(it.key);
    if (!prev && path) prev = byPath.get(normKey(path));
    const stamp = it.updatedAt ? dtFmt(it.updatedAt * 1000) : now;

    if (prev) {
      matchedIds.add(prev.itemId);
      // ensure the provider key is recorded (heals keyless imported items)
      safeRun(db, `INSERT INTO ${keyTbl} (Id, ${keyCol}) VALUES (?, ?)`, prev.itemId, it.key);
      safeRun(db, `UPDATE ${keyTbl} SET ${keyCol}=? WHERE Id=?`, it.key, prev.itemId);
      markFull(db, keyTbl, prev.itemId, it);
      if ((db.prepare("UPDATE MediaItem SET State=? WHERE Id=? AND State<>?").run(StateEnum.Normal, prev.itemId, StateEnum.Normal) as any).changes) markForReindex(db, prev.itemId);
      // Episode filed under the wrong show (older scans matched shows by title
      // across libraries): move it to its keyed show. Cheap, so done even when
      // the episode itself is unchanged.
      const target = kind === 2 && it.showKey ? opts.showMap?.get(it.showKey) : undefined;
      if (target != null && target !== prev.showId) {
        db.prepare("UPDATE Episode SET SeasonId=? WHERE Id=?").run(findOrCreateSeason(db, target, it.season ?? 1, now, lpId), prev.itemId);
        prev.showId = target;
        reparented++;
        markForReindex(db, prev.itemId);
      }
      // artwork too, even when the item is unchanged (heals items scanned before
      // artwork was recorded; cheap — rows are only written when they differ)
      artwork += syncItemArtwork(db, type, sourceId, kind, prev.itemId, prev.metaId, it, now, seasonsDone);
      // "unchanged" only if the file path ALSO still matches — a Plex rename keeps
      // the same rating key and often the same updated-timestamp, so without the
      // path check the renamed file would keep its stale path forever.
      if (prev.dateUpdated === stamp && (!path || normKey(prev.path || "") === normKey(path)) && !it.streams && !it.chapters) { unchanged++; continue; }
      // changed -> refresh
      db.prepare(`UPDATE MediaVersion SET Duration=?, Width=?, Height=?, VideoScanKind=?, DateUpdated=? WHERE Id=?`)
        .run(tsFromSec((it.durationMs || 0) / 1000), it.width, it.height, it.scanKind, stamp, prev.versionId);
      // Upsert the file row (insert if this version lost its MediaFile) — never
      // touches other libraries' rows, so libraries stay independent.
      if (path) {
        const ph = pathHash(path);
        if (db.prepare("SELECT 1 FROM MediaFile WHERE MediaVersionId=?").get(prev.versionId))
          safeRun(db, `UPDATE MediaFile SET Path=?, PathHash=? WHERE MediaVersionId=?`, path, ph, prev.versionId);
        else safeRun(db, `INSERT INTO MediaFile (MediaVersionId, Path, PathHash) VALUES (?,?,?)`, prev.versionId, path, ph);
      }
      if (prev.metaId != null) { writeMetadataFields(db, kind, prev.metaId, it, now); setMetaBits(db, metaBitFk(kind), prev.metaId, it); }
      setStreamsChapters(db, prev.versionId, it);
      markForReindex(db, prev.itemId);
      updated++;
    } else {
      if (!path) continue; // unplayable without a path
      const rec = insertRemoteItem(db, type, kind, lpId, path, it, now, stamp, opts.showMap);
      markForReindex(db, rec.itemId);
      artwork += syncItemArtwork(db, type, sourceId, kind, rec.itemId, rec.metaId, it, now, seasonsDone);
      // Register the just-inserted item so another batch item that resolves to the
      // SAME file path (duplicate Plex entries) matches it instead of trying to
      // insert a second MediaFile with the same PathHash (UNIQUE constraint).
      byKey.set(it.key, rec);
      byPath.set(normKey(path), rec);
      added++;
    }
  }

  // trash by key: existing items not matched -> Unavailable (never delete). Guarded.
  let missing = 0, missingSkipped = false;
  const existingCount = rows.length;
  const looksComplete = existingCount === 0 || matchedIds.size >= Math.floor(existingCount * 0.5);
  if (opts.skipMissing) {
    missingSkipped = true; // targeted deep scan: never flag the untouched items
  } else if (looksComplete) {
    const flag = db.prepare("UPDATE MediaItem SET State=? WHERE Id=? AND State=?");
    for (const r of rows) if (!matchedIds.has(r.itemId)) { const res = flag.run(2, r.itemId, StateEnum.Normal) as any; if (res.changes) { missing++; markForReindex(db, r.itemId); } }
  } else missingSkipped = true;

  unchanged = Math.max(0, existingCount - updated - missing);
  db.prepare("UPDATE Library SET LastScan=? WHERE Id=?").run(new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, ""), lib.libraryId);
  return { libraryId: lib.libraryId, kind, found: items.length, existing: existingCount, added, updated, unchanged, missing, missingSkipped, reparented, artwork, ms: Date.now() - t0 };
}

function insertRemoteItem(db: DatabaseSync, type: ProviderType, kind: number, lpId: number, path: string, it: RemoteItem, now: string, stamp: string, showMap?: Map<string, number>): ExistRec {
  const fk = KIND_FK[kind];
  const keyTbl = providerKeyTable(type, kind), keyCol = providerKeyCol(type);
  const itemId = Number((db.prepare("INSERT INTO MediaItem (LibraryPathId, State) VALUES (?, ?)").run(lpId, StateEnum.Normal) as any).lastInsertRowid);

  let metaId = 0;
  if (kind === 2) {
    const keyed = it.showKey ? showMap?.get(it.showKey) : undefined;
    const showId = keyed ?? findOrCreateShow(db, it.show || "Unknown Show", now, lpId);
    const seasonId = findOrCreateSeason(db, showId, it.season ?? 1, now, lpId);
    db.prepare("INSERT INTO Episode (Id, SeasonId) VALUES (?, ?)").run(itemId, seasonId);
    metaId = Number((db.prepare("INSERT INTO EpisodeMetadata (EpisodeId, MetadataKind, Title, EpisodeNumber, Plot, Year, ReleaseDate, DateAdded, DateUpdated) VALUES (?,?,?,?,?,?,?,?,?)").run(itemId, MetaKindEnum.Fallback, it.title, it.episode ?? 0, it.plot ?? null, it.year ?? null, it.releaseDate ?? null, now, now) as any).lastInsertRowid);
  } else if (kind === 3) {
    const artistId = findOrCreateArtist(db, it.show || "Various Artists", now, lpId);
    db.prepare("INSERT INTO MusicVideo (Id, ArtistId) VALUES (?, ?)").run(itemId, artistId);
    metaId = Number((db.prepare("INSERT INTO MusicVideoMetadata (MusicVideoId, MetadataKind, Title, Year, Plot, DateAdded, DateUpdated) VALUES (?,?,?,?,?,?,?)").run(itemId, MetaKindEnum.Fallback, it.title, it.year ?? null, it.plot ?? null, now, now) as any).lastInsertRowid);
  } else if (kind === 1) {
    db.prepare("INSERT INTO Movie (Id) VALUES (?)").run(itemId);
    metaId = Number((db.prepare("INSERT INTO MovieMetadata (MovieId, MetadataKind, Title, Year, Plot, ReleaseDate, DateAdded, DateUpdated) VALUES (?,?,?,?,?,?,?,?)").run(itemId, MetaKindEnum.Fallback, it.title, it.year ?? null, it.plot ?? null, it.releaseDate ?? null, now, now) as any).lastInsertRowid);
  } else {
    db.prepare(`INSERT INTO ${KIND_TABLE[kind]} (Id) VALUES (?)`).run(itemId);
    metaId = Number((db.prepare(`INSERT INTO ${KIND_TABLE[kind]}Metadata (${fk}, MetadataKind, Title, Year, Plot, DateAdded, DateUpdated) VALUES (?,?,?,?,?,?,?)`).run(itemId, MetaKindEnum.Fallback, it.title, it.year ?? null, it.plot ?? null, now, now) as any).lastInsertRowid);
  }
  safeRun(db, `INSERT INTO ${keyTbl} (Id, ${keyCol}) VALUES (?, ?)`, itemId, it.key);
  markFull(db, keyTbl, itemId, it);
  if (metaId) setMetaBits(db, metaBitFk(kind), metaId, it);
  if (metaId && it.contentRating != null) safeRun(db, `UPDATE ${KIND_TABLE[kind]}Metadata SET ContentRating=? WHERE Id=?`, it.contentRating, metaId);

  const versionId = Number((db.prepare(
    `INSERT INTO MediaVersion (${fk}, Name, DateAdded, DateUpdated, Duration, Width, Height, VideoScanKind) VALUES (?, 'Main', ?, ?, ?, ?, ?, ?)`
  ).run(itemId, now, stamp, tsFromSec((it.durationMs || 0) / 1000), it.width, it.height, it.scanKind) as any).lastInsertRowid);
  db.prepare("INSERT INTO MediaFile (MediaVersionId, Path, PathHash) VALUES (?,?,?)").run(versionId, path, pathHash(path));
  setStreamsChapters(db, versionId, it);
  return { itemId, versionId, metaId: metaId || null, dateUpdated: stamp, path };
}

// ---- top-level: scan one whole remote source -------------------------------
export interface RemoteScanEvent { phase: string; library?: string; fetched?: number; total?: number; found?: number; existing?: number; added?: number; updated?: number; missing?: number; missingSkipped?: boolean; artwork?: number; error?: string; }

async function pooled<T>(xs: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (i < xs.length) { const j = i++; await fn(xs[j]); } }));
}

export async function scanRemoteSource(
  dbPath: string, sourceId: number, token: string,
  // refreshMetadata: re-fetch full metadata for EVERY item/show, not just new or
  // changed ones — backfills cast/crew/ratings/guids an older scan never pulled.
  opts: { fetcher?: Fetcher; onEvent?: (e: RemoteScanEvent) => void; address?: string | null; libraryId?: number; refreshMetadata?: boolean } = {}
): Promise<{ libraries: RemoteScanSummary[]; errors: string[] }> {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const emit = opts.onEvent ?? (() => {});
  const info = readSourceInfo(dbPath, sourceId);
  if (!info) throw new Error(`Source ${sourceId} is not a Plex/Jellyfin/Emby source`);
  if (!token) throw new Error(`A ${info.type} token/API key is required`);
  // Candidate connections, in preference order: an explicitly-supplied address
  // first, then every known connection URI (active first). The scanner probes
  // them and uses the first that responds, so a stale saved address still falls
  // back to the others.
  const candidates = [...new Set([opts.address, ...info.addresses, info.address].filter(Boolean) as string[])];
  if (!candidates.length) throw new Error(`No server address on record for source ${sourceId}`);
  const address = await pickReachableAddress(info.type, candidates, token, emit);

  const targets = opts.libraryId != null ? info.libraries.filter((l) => l.libraryId === opts.libraryId) : info.libraries;
  if (opts.libraryId != null && !targets.length) throw new Error(`Library ${opts.libraryId} is not on source ${sourceId}`);

  const db = openRW(dbPath);
  const summaries: RemoteScanSummary[] = [];
  const errors: string[] = [];
  try {
    for (const lib of targets) {
      try {
        emit({ phase: "fetching", library: lib.name });
        const items = info.type === "plex"
          ? await fetchPlexListing(address, token, lib, fetcher, (n, t) => emit({ phase: "fetching", library: lib.name, fetched: n, total: t }))
          : await fetchJellyfinListing(address, token, lib, fetcher, (n, t) => emit({ phase: "fetching", library: lib.name, fetched: n, total: t }));

        // For Plex, fetch full per-item metadata + streams + chapters for NEW or
        // CHANGED items only (or all of them on a metadata refresh).
        if (info.type === "plex") {
          const existing = existingKeyStamps(db, info.type, lib);
          const changed = (it: RemoteItem) => { const e = existing.get(it.key); return !e || e.du !== (it.updatedAt ? dtFmt(it.updatedAt * 1000) : ""); };
          let need: RemoteItem[];
          if (opts.refreshMetadata) need = items;
          else {
            // new/changed items always; plus a capped batch of items never fully
            // fetched (backfill) so an ordinary rescan fills in cast/crew/ratings
            const fresh = items.filter(changed);
            const stale = items.filter((it) => !changed(it) && !existing.get(it.key)?.full);
            const batch = stale.slice(0, BACKFILL_PER_SCAN);
            need = [...fresh, ...batch];
            if (stale.length) emit({ phase: "backfill", library: lib.name, fetched: batch.length, total: stale.length });
          }
          emit({ phase: "detailing", library: lib.name, total: need.length });
          let done = 0;
          await pooled(need, 6, async (it) => {
            try { const d = await fetchPlexItemFull(address, token, it.key, fetcher); if (d) mergeDetail(it, d); } catch { /* keep listing-only data */ }
            done++; if (done % 25 === 0) emit({ phase: "detailing", library: lib.name, fetched: done, total: need.length });
          });
        }

        // Shows libraries: the shows themselves first (their metadata is what
        // show_network / show_genre / show_studio search), keyed by provider id.
        let shows: RemoteShow[] | null = null;
        if (lib.kind === 2) {
          emit({ phase: "shows", library: lib.name });
          shows = info.type === "plex" ? await fetchPlexShows(address, token, lib, fetcher) : await fetchJellyfinShows(address, token, lib, fetcher);
          if (info.type === "plex") {
            const need = showsNeedingDetail(db, info.type, lib.libraryId, shows, opts.refreshMetadata);
            emit({ phase: "show-detailing", library: lib.name, total: need.length });
            let done = 0;
            await pooled(need, 6, async (s) => {
              try { const full = await fetchPlexShowFull(address, token, s, fetcher); if (full) Object.assign(s, full); } catch { /* listing-only; retried next scan */ }
              done++; if (done % 25 === 0) emit({ phase: "show-detailing", library: lib.name, fetched: done, total: need.length });
            });
          }
        }
        // Networks come from a separate tag walk (legacy PlexNetworkScanner).
        // Fetched before the write transaction; a failed walk leaves networks alone.
        let net: Awaited<ReturnType<typeof fetchPlexNetworks>> | null = null;
        if (lib.kind === 2 && info.type === "plex") {
          emit({ phase: "networks", library: lib.name });
          try { net = await fetchPlexNetworks(address, token, lib, fetcher, (d, t) => emit({ phase: "networks", library: lib.name, fetched: d, total: t })); }
          catch (e) { emit({ phase: "networks-error", library: lib.name, error: (e as Error).message }); }
        }

        db.exec("BEGIN");
        try {
          const showSummary: ShowUpsertSummary = { found: 0, added: 0, adopted: 0, updated: 0 };
          const showMap = shows ? upsertRemoteShows(db, info.type, info.sourceId, lib.libraryId, shows, showSummary) : undefined;
          const s = upsertRemoteLibrary(db, info.type, lib, items, info.pathReplacements, { showMap });
          if (shows) s.shows = showSummary;
          if (net && showMap) { const r = applyShowNetworks(db, showMap, net); s.networks = { networks: net.networks, added: r.added, removed: r.removed, failed: net.failed.size }; }
          db.exec("COMMIT");
          summaries.push(s);
          if (s.shows) emit({ phase: "shows-done", library: lib.name, found: s.shows.found, added: s.shows.added, updated: s.shows.updated + s.shows.adopted });
          emit({ phase: "library-done", library: lib.name, found: s.found, existing: s.existing, added: s.added, updated: s.updated, missing: s.missing, missingSkipped: s.missingSkipped, artwork: s.artwork });
        }
        catch (e) { db.exec("ROLLBACK"); throw e; }
      } catch (e) { const msg = `${lib.name}: ${(e as Error).message}`; errors.push(msg); emit({ phase: "library-error", library: lib.name, error: (e as Error).message }); }
    }
  } finally { db.close(); }
  emit({ phase: "done" });
  return { libraries: summaries, errors };
}

// existing key -> stored DateUpdated stamp, for deciding which items need detail
function existingKeyStamps(db: DatabaseSync, type: ProviderType, lib: RemoteLibrary): Map<string, { du: string; full: boolean }> {
  const tbl = KIND_TABLE[lib.kind], fk = KIND_FK[lib.kind];
  const keyTbl = providerKeyTable(type, lib.kind), keyCol = providerKeyCol(type);
  const m = new Map<string, { du: string; full: boolean }>();
  try {
    for (const r of db.prepare(
      `SELECT pk.${keyCol} k, pk.Etag etag, mv.DateUpdated du FROM ${keyTbl} pk
         JOIN MediaItem mi ON mi.Id=pk.Id
         JOIN MediaVersion mv ON mv.${fk}=pk.Id
        WHERE mi.LibraryPathId IN (SELECT Id FROM LibraryPath WHERE LibraryId=?)`
    ).all(lib.libraryId) as any[]) if (r.k) m.set(String(r.k), { du: r.du ?? "", full: String(r.etag ?? "").startsWith(FULL_ETAG) });
  } catch { /* provider key table may not exist */ }
  return m;
}

/** Items we've fetched complete metadata for are marked in their provider key
 *  row's Etag. Anything without the mark (imported from legacy, or scanned by an
 *  older version that only read the listing) gets backfilled by normal scans. */
const FULL_ETAG = "full:";
export const BACKFILL_PER_SCAN = 5000;
function markFull(db: DatabaseSync, keyTbl: string, itemId: number, it: RemoteItem): void {
  if (it.guids !== undefined) safeRun(db, `UPDATE ${keyTbl} SET Etag=? WHERE Id=?`, `${FULL_ETAG}${it.updatedAt}`, itemId);
}
