// -----------------------------------------------------------------------------
// Query guidance for the web search box: a catalog of every search field with a
// plain description and example, "did you mean" for misspelled fields, and a
// plain-English reading of a parsed query.
// -----------------------------------------------------------------------------
import { FIELD, KNOWN_FIELDS, type FieldKind, type Node } from "./search.js";

export interface FieldHelp { name: string; group: string; kind: FieldKind; desc: string; example: string; values: boolean; }

// field -> [group, description, example, suggest values from the library?]
const HELP: Record<string, [string, string, string, boolean?]> = {
  type: ["Basics", "Kind of media: movie, episode, show, season, other_video, music_video, song, image", "type:episode", true],
  title: ["Basics", "Title contains the text (plain words with no field search titles too)", 'title:"christmas story"'],
  show_title: ["Shows", "The show an episode or season belongs to", 'show_title:"The Simpsons"', true],
  library_name: ["Basics", "Which library it's in", 'library_name:"TV Shows"', true],
  collection: ["Basics", "Member of a collection", 'collection:"Christmas Movies"', true],
  genre: ["Basics", "Genre of the item itself (for episodes use show_genre)", "genre:comedy", true],
  tag: ["Basics", "Tag or Plex label (other videos get their folder names as tags)", 'tag:"Back To"', true],
  plot: ["Basics", "Plot / summary contains the text", "plot:heist"],
  content_rating: ["Basics", "Content rating (exact, case-sensitive)", "content_rating:PG-13", true],
  country: ["Basics", "Country of origin (from NFO metadata)", "country:japan", true],
  state: ["Basics", "Library state: normal, filenotfound, unavailable, remoteonly", "state:normal", true],
  sort_title: ["Basics", "Sort title (exact)", 'sort_title:"simpsons"'],
  jump_letter: ["Basics", "First letter of the sort title", "jump_letter:a"],
  title_and_year: ["Basics", "Exact \"Title (Year)\"", 'title_and_year:"Clerks (1994)"'],
  tag_full: ["Basics", "Tag, exact whole value", 'tag_full:"Back To"'],
  year: ["Dates", "Release year — a number or a range", "year:[1990 TO 1999]"],
  release_date: ["Dates", "Release date as yyyymmdd — a range or a prefix", "release_date:[1980* TO 2010*]"],
  added_date: ["Dates", "Date added to the library, yyyymmdd", "added_date:2025*"],
  released_inthelast: ["Dates", "Released within the last …", 'released_inthelast:"6 months"'],
  released_notinthelast: ["Dates", "NOT released within the last …", 'released_notinthelast:"20 years"'],
  released_onthisday: ["Dates", "Released on today's month and day, any year", "released_onthisday:1"],
  added_inthelast: ["Dates", "Added within the last …", 'added_inthelast:"2 weeks"'],
  added_notinthelast: ["Dates", "NOT added within the last …", 'added_notinthelast:"1 year"'],
  minutes: ["Length", "Length in minutes (rounded up)", "minutes:[20 TO 30]"],
  seconds: ["Length", "Length in seconds (good for short clips)", "seconds:[1 TO 45]"],
  chapters: ["Length", "Number of chapter markers", "chapters:[1 TO *]"],
  season_number: ["Shows", "Season number", "season_number:1"],
  episode_number: ["Shows", "Episode number within its season", "episode_number:[1 TO 3]"],
  network: ["Shows", "TV network of a show (on episodes use show_network)", 'network:"Cartoon Network"', true],
  show_network: ["Shows", "Network of the episode's show", "show_network:Nickelodeon", true],
  show_genre: ["Shows", "Genre of the episode's show", "show_genre:animation", true],
  show_tag: ["Shows", "Tag / label on the episode's show", "show_tag:favorites", true],
  show_studio: ["Shows", "Studio of the episode's show", 'show_studio:"Studio Ghibli"', true],
  show_content_rating: ["Shows", "Content rating of the episode's show (exact, case-sensitive)", "show_content_rating:TV-Y7", true],
  show_guid: ["IDs", "The episode's show by external id — pins one show regardless of its title", 'show_guid:"tvdb://76703"'],
  studio: ["People", "Studio", 'studio:"Pixar"', true],
  actor: ["People", "Cast member", 'actor:"Tom Hanks"', true],
  director: ["People", "Director", 'director:"Kevin Smith"', true],
  writer: ["People", "Writer", 'writer:"Mel Brooks"', true],
  mood: ["Music", "Mood", "mood:chill", true],
  style: ["Music", "Style", "style:synthpop", true],
  album: ["Music", "Album name", 'album:"Thriller"', true],
  artist: ["Music", "Artist", 'artist:"Weird Al"', true],
  album_artist: ["Music", "Album artist", 'album_artist:"Various Artists"', true],
  language: ["Tech", "Audio language name", "language:english", true],
  language_tag: ["Tech", "Audio language code", "language_tag:eng"],
  sub_language: ["Tech", "Subtitle language name", "sub_language:english", true],
  sub_language_tag: ["Tech", "Subtitle language code", "sub_language_tag:eng"],
  height: ["Tech", "Video height in pixels", "height:[1080 TO *]"],
  width: ["Tech", "Video width in pixels", "width:[1920 TO *]"],
  video_codec: ["Tech", "Video codec", "video_codec:h264", true],
  video_dynamic_range: ["Tech", "sdr or hdr", "video_dynamic_range:sdr", true],
  video_bit_depth: ["Tech", "Video bit depth", "video_bit_depth:10"],
  metadata_kind: ["Tech", "Where metadata came from: fallback, sidecar, external", "metadata_kind:external", true],
  library_id: ["IDs", "Library id number", "library_id:62"],
  imdb: ["IDs", "IMDb id (episodes also match their show's)", "imdb:tt0086770"],
  tvdb: ["IDs", "TVDB id (episodes also match their show's)", "tvdb:78857"],
  tmdb: ["IDs", "TMDb id", "tmdb:603"],
  plex: ["IDs", "Plex guid", 'plex:"show/5d9c08097b5c2e001e652a87"'],
  jellyfin: ["IDs", "Jellyfin id", "jellyfin:abc123"],
  emby: ["IDs", "Emby id", "emby:abc123"],
  guid: ["IDs", "Any external id, full form", 'guid:"imdb://tt0086770"'],
  smart_collection: ["Basics", "Everything another smart collection matches (its query is inserted; name in quotes)", 'smart_collection:"Christmas TV Smart Collection"', true],
  id: ["IDs", "Media item id", "id:124772"],
  library_folder_id: ["IDs", "Library folder id the file is in", "library_folder_id:12", true],
  trakt_list: ["IDs", "Trakt list id the item is on", "trakt_list:123456", true],
  title_and_year_search: ["Basics", "Exact \"Title (Year)\", any capitalization", 'title_and_year_search:"clerks (1994)"'],
};

/** Every search field with a plain description and an example. */
export function fieldCatalog(): FieldHelp[] {
  return Object.keys(FIELD).map((name) => {
    const h = HELP[name] ?? ["Other", name.replace(/_/g, " "), `${name}:…`];
    return { name, group: h[0], kind: FIELD[name].kind, desc: h[1], example: h[2], values: !!h[3] };
  });
}

/** The SearchRow property a field reads (for suggesting values), if any. */
export function fieldProp(name: string): string | null {
  const p = FIELD[name]?.prop;
  return p && !String(p).startsWith("__") ? String(p) : null;
}

function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Closest known field to a misspelled one ("genra" -> "genre"), if one is close. */
export function suggestField(name: string): string | null {
  let best: string | null = null, bestD = 3;
  for (const f of KNOWN_FIELDS) { const dist = editDistance(name.toLowerCase(), f); if (dist < bestD) { bestD = dist; best = f; } }
  return best;
}

/** A plain-English reading of a parsed query. */
export function explainQuery(node: Node, top = true): string {
  const label = (f: string) => f.replace(/_/g, " ");
  switch (node.t) {
    case "true": return top ? "everything" : "anything";
    case "term": {
      const cfg = FIELD[node.field];
      const v = `"${node.value}"`;
      if (!cfg) return `${label(node.field)} (unknown field — matches nothing)`;
      if (node.wildcard) return `${label(node.field)} has a word matching ${v}`;
      if (cfg.kind === "guid") return `${label(node.field)} id is ${v}`;
      if (cfg.kind === "reldate") return `${label(node.field)} ${v}`;
      if (cfg.kind === "date") return `${label(node.field)} starts with ${node.value}`;
      if (cfg.kind === "int") return `${label(node.field)} is ${node.value}`;
      return `${label(node.field)} ${cfg.kind === "keyword" ? "is" : "contains"} ${v}`;
    }
    case "range": {
      const lo = node.loText ?? (node.lo != null ? String(node.lo) : null);
      const hi = node.hiText ?? (node.hi != null ? String(node.hi) : null);
      if (lo != null && hi != null) return `${label(node.field)} from ${lo} to ${hi}`;
      if (lo != null) return `${label(node.field)} at least ${lo}`;
      if (hi != null) return `${label(node.field)} at most ${hi}`;
      return `${label(node.field)} is set`;
    }
    case "not": return `not (${explainQuery(node.node, false)})`;
    case "and": return node.nodes.map((n) => (n.t === "or" ? `(${explainQuery(n, false)})` : explainQuery(n, false))).join(" and ");
    case "or": return node.nodes.map((n) => (n.t === "and" ? `(${explainQuery(n, false)})` : explainQuery(n, false))).join(" or ");
  }
}
