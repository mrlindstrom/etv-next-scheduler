// -----------------------------------------------------------------------------
// Legacy ErsatzTV search-query parser + matcher (mini-Lucene subset)
// -----------------------------------------------------------------------------
// Handles the query forms that appear in real ErsatzTV YAML, e.g.
//   type:episode AND show_title:"Night Court" AND minutes:[1 TO 31]
//   type:other_video AND title:(bumper AND nick) AND seconds:[1 TO 11] NOT title:"Nick at Night"
//   library_name:("Nick Sourced Filler" OR "mixed commercials") AND title:commercial*
//   show_title:M*A*S*H
// Supports: field:value, field:"quoted phrase", field:value* (wildcard),
//   field:[lo TO hi] ranges, field:(A AND/OR/NOT B ...) groups, top-level
//   AND / OR / NOT and implicit-AND, and bare (grouped) sub-expressions.
//
// Matching is evaluated in JS against a normalized row so boolean grouping is
// exact. Field semantics:
//   type, library_name, tag  -> keyword (exact, case-insensitive; wildcard=regex)
//   title, show_title        -> text    (substring/phrase contains; wildcard=regex)
//   minutes, seconds         -> numeric range over duration

export type Node =
  | { t: "and"; nodes: Node[] }
  | { t: "or"; nodes: Node[] }
  | { t: "not"; node: Node }
  | { t: "term"; field: string; value: string; wildcard: boolean }
  | { t: "range"; field: string; lo: number | null; hi: number | null; loText?: string | null; hiText?: string | null }
  | { t: "true" };

export interface SearchRow {
  // core (always set)
  type: string;
  title: string;
  show_title: string;
  library: string;         // library_name
  tags: string[];          // regular tags (network/country excluded)
  durationMs: number;      // -> minutes / seconds (ceiling)
  // scalars
  sort_title?: string;
  plot?: string;
  library_id?: number;
  state?: string;
  content_rating?: string;
  show_content_rating?: string;
  metadata_kind?: string;
  jump_letter?: string;
  title_and_year?: string;
  video_codec?: string;
  video_dynamic_range?: string;
  album?: string;
  artist?: string;
  album_artist?: string;
  // numerics
  height?: number; width?: number;
  season?: number; episode?: number;
  chapters?: number; video_bit_depth?: number;
  added_date?: number; release_date?: number;   // yyyymmdd
  year?: number;
  // multi-valued
  genres?: string[]; tag_full?: string[]; network?: string[]; country?: string[];
  studios?: string[]; actors?: string[]; directors?: string[]; writers?: string[];
  moods?: string[]; styles?: string[]; collections?: string[];
  languages?: string[]; language_tags?: string[]; sub_languages?: string[]; sub_language_tags?: string[];
  show_genres?: string[]; show_tags?: string[]; show_studios?: string[]; show_network?: string[];
  guids?: string[];        // this item's external ids, full form ("imdb://tt0086770")
  library_folder_ids?: string[]; // legacy library_folder_id
  trakt_lists?: string[];         // legacy trakt_list (Trakt list ids)
  show_guids?: string[];   // parent show's external ids (so episodes match a show by id)
}

export type FieldKind = "keyword" | "text" | "int" | "date" | "reldate" | "guid";
type RelMode = "inthelast" | "notinthelast" | "onthisday";
export interface FieldCfg { prop: keyof SearchRow | "__minutes" | "__seconds" | "__id" | "__smart"; kind: FieldKind; multi?: boolean; cs?: boolean; mode?: RelMode; scheme?: string; }

// Every legacy ErsatzTV search field -> how to evaluate it against a SearchRow.
export const FIELD: Record<string, FieldCfg> = {
  type: { prop: "type", kind: "keyword" },
  title: { prop: "title", kind: "text" },
  sort_title: { prop: "sort_title", kind: "keyword" },
  plot: { prop: "plot", kind: "text" },
  library_name: { prop: "library", kind: "text" },
  library_id: { prop: "library_id", kind: "int" },
  state: { prop: "state", kind: "keyword" },
  content_rating: { prop: "content_rating", kind: "keyword", cs: true },       // ErsatzTV: case-sensitive
  show_content_rating: { prop: "show_content_rating", kind: "keyword", cs: true },
  metadata_kind: { prop: "metadata_kind", kind: "keyword" },
  jump_letter: { prop: "jump_letter", kind: "keyword" },
  title_and_year: { prop: "title_and_year", kind: "keyword" },
  video_codec: { prop: "video_codec", kind: "keyword" },
  video_dynamic_range: { prop: "video_dynamic_range", kind: "keyword" },
  album: { prop: "album", kind: "text" },
  artist: { prop: "artist", kind: "text" },
  album_artist: { prop: "album_artist", kind: "text" },
  genre: { prop: "genres", kind: "text", multi: true },
  tag: { prop: "tags", kind: "text", multi: true },
  tag_full: { prop: "tag_full", kind: "keyword", multi: true },
  network: { prop: "network", kind: "text", multi: true },
  country: { prop: "country", kind: "text", multi: true },
  studio: { prop: "studios", kind: "text", multi: true },
  actor: { prop: "actors", kind: "text", multi: true },
  director: { prop: "directors", kind: "text", multi: true },
  writer: { prop: "writers", kind: "text", multi: true },
  mood: { prop: "moods", kind: "text", multi: true },
  style: { prop: "styles", kind: "text", multi: true },
  collection: { prop: "collections", kind: "text", multi: true },
  language: { prop: "languages", kind: "text", multi: true },
  language_tag: { prop: "language_tags", kind: "text", multi: true },
  sub_language: { prop: "sub_languages", kind: "text", multi: true },
  sub_language_tag: { prop: "sub_language_tags", kind: "text", multi: true },
  show_title: { prop: "show_title", kind: "text" },
  show_genre: { prop: "show_genres", kind: "text", multi: true },
  show_tag: { prop: "show_tags", kind: "text", multi: true },
  show_studio: { prop: "show_studios", kind: "text", multi: true },
  show_network: { prop: "show_network", kind: "text", multi: true },
  height: { prop: "height", kind: "int" },
  width: { prop: "width", kind: "int" },
  season_number: { prop: "season", kind: "int" },
  episode_number: { prop: "episode", kind: "int" },
  chapters: { prop: "chapters", kind: "int" },
  video_bit_depth: { prop: "video_bit_depth", kind: "int" },
  minutes: { prop: "__minutes", kind: "int" },
  seconds: { prop: "__seconds", kind: "int" },
  added_date: { prop: "added_date", kind: "date" },
  release_date: { prop: "release_date", kind: "date" },
  year: { prop: "year", kind: "int" },
  // ErsatzTV special relative-date fields (value is e.g. "1 week", "3 months").
  released_inthelast: { prop: "release_date", kind: "reldate", mode: "inthelast" },
  released_notinthelast: { prop: "release_date", kind: "reldate", mode: "notinthelast" },
  released_onthisday: { prop: "release_date", kind: "reldate", mode: "onthisday" },
  added_inthelast: { prop: "added_date", kind: "reldate", mode: "inthelast" },
  added_notinthelast: { prop: "added_date", kind: "reldate", mode: "notinthelast" },
  // External-id fields. A scheme-specific field (imdb/tvdb/…) matches the value
  // after "scheme://"; `guid` matches the whole "scheme://value". For episodes
  // these also test the parent show's ids, so `type:episode AND imdb:tt0086770`
  // pins one specific show (e.g. the 1984 Night Court, not the 2023 reboot).
  imdb: { prop: "guids", kind: "guid", scheme: "imdb" },
  tvdb: { prop: "guids", kind: "guid", scheme: "tvdb" },
  tmdb: { prop: "guids", kind: "guid", scheme: "tmdb" },
  plex: { prop: "guids", kind: "guid", scheme: "plex" },
  jellyfin: { prop: "guids", kind: "guid", scheme: "jellyfin" },
  emby: { prop: "guids", kind: "guid", scheme: "emby" },
  guid: { prop: "guids", kind: "guid" },
  // the rest of legacy's index fields
  id: { prop: "__id", kind: "keyword" },                                   // media item id
  library_folder_id: { prop: "library_folder_ids", kind: "keyword", multi: true },
  trakt_list: { prop: "trakt_lists", kind: "keyword", multi: true },
  title_and_year_search: { prop: "title_and_year", kind: "keyword" },      // lowercased title_and_year
  // smart_collection:"Name" is expanded into that collection's query before
  // parsing (expandSmartCollections); one that's left over matches nothing.
  smart_collection: { prop: "__smart", kind: "keyword" },
  // Extension (not in legacy): the parent show's id only, e.g. show_guid:"tvdb://184871".
  // Unlike tvdb:/guid:, it never matches an episode's OWN id, so it pins exactly one
  // show regardless of its title (which differs by region, e.g. Bake Off/Baking Show).
  show_guid: { prop: "show_guids", kind: "guid" },
};

/** Local today as a yyyymmdd number. */
function todayYmd(now = new Date()): number {
  return now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
}
/** A yyyymmdd number for `now` minus `n` of `unit` (day/week/month/year). */
function agoYmd(value: string, now = new Date()): number | null {
  const m = /(\d+)\s*(day|week|month|year)s?/i.exec(value ?? "");
  if (!m) return null;
  const n = Number(m[1]); const unit = m[2].toLowerCase();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (unit === "day") d.setDate(d.getDate() - n);
  else if (unit === "week") d.setDate(d.getDate() - n * 7);
  else if (unit === "month") d.setMonth(d.getMonth() - n);
  else if (unit === "year") d.setFullYear(d.getFullYear() - n);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/** All field names ErsatzTV legacy understands (for unknown-field warnings). */
export const KNOWN_FIELDS = new Set(Object.keys(FIELD));

class QParser {
  private i = 0;
  constructor(private s: string) {}

  parse(): Node {
    const n = this.parseOr(null);
    this.ws();
    return n;
  }

  // field === null -> boolean expression of atoms; field set -> values for that field
  private parseOr(field: string | null): Node {
    const nodes = [this.parseAnd(field)];
    for (;;) {
      const save = this.i;
      const kw = this.keyword();
      if (kw === "or") nodes.push(this.parseAnd(field));
      else { this.i = save; break; }
    }
    return nodes.length === 1 ? nodes[0] : { t: "or", nodes };
  }

  private parseAnd(field: string | null): Node {
    const nodes = [this.parseUnary(field)];
    for (;;) {
      const save = this.i;
      const kw = this.keyword();
      if (kw === "and") { nodes.push(this.parseUnary(field)); continue; }
      if (kw === "or") { this.i = save; break; }
      if (kw === "not") { this.i = save; nodes.push(this.parseUnary(field)); continue; }
      // implicit AND: another atom follows?
      this.i = save;
      if (this.atStartOfAtom(field)) { nodes.push(this.parseUnary(field)); continue; }
      break;
    }
    return nodes.length === 1 ? nodes[0] : { t: "and", nodes };
  }

  private parseUnary(field: string | null): Node {
    const save = this.i;
    if (this.keyword() === "not") return { t: "not", node: this.parseUnary(field) };
    this.i = save;
    return this.parseAtom(field);
  }

  private parseAtom(field: string | null): Node {
    this.ws();
    if (this.peek() === "(") {
      this.i++;
      const inner = this.parseOr(field);
      this.ws();
      if (this.peek() === ")") this.i++;
      return inner;
    }
    if (field !== null) {
      // a value for the current field
      if (this.peek() === "[") return this.range(field);
      const v = this.value();
      return { t: "term", field, value: stripWild(v), wildcard: v.includes("*") };
    }
    // expect field:...
    const f = this.fieldName();
    if (!f) {
      // A bare word/phrase searches titles (legacy's default field): "christmas story"
      // -> title contains "christmas" AND title contains "story".
      const v = this.value();
      if (!v) { this.i++; return { t: "true" }; } // stray character: skip it (never loop)
      return { t: "term", field: "title", value: stripWild(v), wildcard: v.includes("*") };
    }
    if (this.peek() === "(") return this.parseAtom(f);         // field:( group )
    if (this.peek() === "[") return this.range(f);             // field:[lo TO hi]
    const v = this.value();
    return { t: "term", field: f, value: stripWild(v), wildcard: v.includes("*") };
  }

  private range(field: string): Node {
    this.expect("[");
    const body = this.until("]");
    this.expect("]");
    const m = body.match(/^\s*(\S+)\s+TO\s+(\S+)\s*$/i);
    if (!m) return { t: "true" };
    const lo = m[1] === "*" ? null : Number(m[1]);
    const hi = m[2] === "*" ? null : Number(m[2]);
    // keep the literal bounds too: date ranges compare as text, and "1980*" is a legal Lucene bound
    return { t: "range", field, lo, hi, loText: m[1] === "*" ? null : m[1], hiText: m[2] === "*" ? null : m[2] };
  }

  // --- lexing helpers --------------------------------------------------------
  private ws() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++; }
  private peek(): string { this.ws(); return this.s[this.i] ?? ""; }
  private expect(c: string) { this.ws(); if (this.s[this.i] === c) this.i++; }
  private until(stop: string): string { let out = ""; while (this.i < this.s.length && this.s[this.i] !== stop) out += this.s[this.i++]; return out; }

  private keyword(): string | null {
    this.ws();
    const m = /^(and|or|not)\b/i.exec(this.s.slice(this.i));
    if (m) { this.i += m[0].length; return m[1].toLowerCase(); }
    return null;
  }

  private fieldName(): string | null {
    this.ws();
    const m = /^([A-Za-z_]+)\s*:/.exec(this.s.slice(this.i));
    if (m) { this.i += m[0].length; return m[1].toLowerCase(); }
    return null;
  }

  // A single value: quoted phrase, or a bareword (may include * . / - etc.)
  private value(): string {
    this.ws();
    if (this.s[this.i] === '"') {
      this.i++;
      const v = this.until('"');
      if (this.s[this.i] === '"') this.i++;
      return v;
    }
    let out = "";
    while (this.i < this.s.length && !/[\s()\[\]]/.test(this.s[this.i])) out += this.s[this.i++];
    return out;
  }

  private atStartOfAtom(field: string | null): boolean {
    this.ws();
    const c = this.peek();
    if (c === "" || c === ")" || c === "]") return false;
    if (c === "(" || c === "[" || c === '"') return true;
    return true;                                          // a value, another field:, or a bare title word
  }
}

function stripWild(v: string): string { return v; }

export function parseQuery(query: string): Node {
  try { return new QParser(query).parse(); }
  catch { return { t: "true" }; }
}

// --- matching ----------------------------------------------------------------
function wildcardRegex(v: string): RegExp {
  const esc = v.replace(/[.+?^${}()|\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + esc + "$", "i");
}

// Resolve a field's value(s) from a row. Numeric fields return a number.
function fieldValue(cfg: FieldCfg, row: SearchRow): string[] | number | undefined {
  if (cfg.prop === "__minutes") return Math.ceil(row.durationMs / 60000);
  if (cfg.prop === "__seconds") return Math.ceil(row.durationMs / 1000);
  if (cfg.prop === "__id") { const r = row as any; return [String(r.groupId ?? r.id ?? "")]; }
  if (cfg.prop === "__smart") return [];
  const raw = (row as any)[cfg.prop];
  if (cfg.kind === "int" || cfg.kind === "date" || cfg.kind === "reldate") return typeof raw === "number" ? raw : raw == null ? undefined : Number(raw);
  if (raw == null) return [];
  return Array.isArray(raw) ? raw.map((x) => String(x)) : [String(raw)];
}

function termMatches(node: Extract<Node, { t: "term" }>, row: SearchRow): boolean {
  const cfg = FIELD[node.field];
  // unknown field -> matches nothing, like Lucene/ErsatzTV (a typo such as `genra:x` inside
  // NOT (...) must be a no-op, not exclude everything). Callers still warn via unknownFields.
  if (!cfg) return false;
  if (cfg.kind === "guid") return guidMatches(node, row, cfg);
  const val = fieldValue(cfg, row);
  if (cfg.kind === "reldate") {
    // Relative-date fields evaluated against the underlying release/added date.
    if (typeof val !== "number" || !isFinite(val)) return false;
    const today = todayYmd();
    if (cfg.mode === "onthisday") return (val % 10000) === (today % 10000);
    const cutoff = agoYmd(node.value);
    if (cutoff == null) return false;
    return cfg.mode === "inthelast" ? (val >= cutoff && val <= today) : (val < cutoff);
  }
  if (cfg.kind === "date") {
    // Dates are yyyymmdd numbers. A short value (with or without a trailing `*`)
    // is a prefix: `2015` -> all of 2015, `201*` -> the 2010s, `201503` -> that
    // month. A full 8-digit value is an exact match. (Lucene/ErsatzTV parity.)
    if (typeof val !== "number" || !isFinite(val)) return false;
    const digits = node.value.replace(/[^0-9]/g, "");
    if (!digits) return false;
    if (digits.length >= 8) return val === Number(digits.slice(0, 8));
    return val >= Number(digits.padEnd(8, "0")) && val <= Number(digits.padEnd(8, "9"));
  }
  if (cfg.kind === "int") {
    if (typeof val !== "number" || !isFinite(val)) return false;
    const n = Number(node.value);
    return isFinite(n) && val === n;
  }
  const arr = val as string[];
  const v = cfg.cs ? node.value : node.value.toLowerCase();
  const re = node.wildcard ? wildcardRegex(node.value) : null;
  return arr.some((s) => {
    const hay = cfg.cs ? (s ?? "") : (s ?? "").toLowerCase();
    // Text fields are word-tokenized in legacy (Lucene): a wildcard matches the whole
    // value OR any single word in it ("christ*" finds "A Christmas Story").
    if (re) return re.test(s ?? "") || (cfg.kind === "text" && (s ?? "").split(/[^\p{L}\p{N}']+/u).some((w) => w && re.test(w)));
    return cfg.kind === "keyword" ? hay === v : hay.includes(v);
  });
}

// Match an external-id term against a row's own ids plus its parent show's ids.
function guidMatches(node: Extract<Node, { t: "term" }>, row: SearchRow, cfg: FieldCfg): boolean {
  const all = cfg.prop === "show_guids" ? (row.show_guids ?? []) : [...(row.guids ?? []), ...(row.show_guids ?? [])];
  if (!all.length) return false;
  // For a scheme field, compare the value after "scheme://" (strip a redundant
  // "scheme://" the user may have typed); for the generic `guid`, the whole id.
  const want = (cfg.scheme ? node.value.replace(new RegExp(`^${cfg.scheme}://`, "i"), "") : node.value).toLowerCase();
  const re = node.wildcard ? wildcardRegex(cfg.scheme ? node.value.replace(new RegExp(`^${cfg.scheme}://`, "i"), "") : node.value) : null;
  return all.some((g) => {
    const i = g.indexOf("://");
    const scheme = i >= 0 ? g.slice(0, i).toLowerCase() : "";
    const value = i >= 0 ? g.slice(i + 3) : g;
    if (cfg.scheme) {
      if (scheme !== cfg.scheme) return false;
      return re ? re.test(value) : value.toLowerCase() === want;
    }
    return re ? re.test(g) : g.toLowerCase() === want;
  });
}

function rangeMatches(node: Extract<Node, { t: "range" }>, row: SearchRow): boolean {
  const cfg = FIELD[node.field];
  if (!cfg) return false; // unknown field: no match (Lucene parity)
  const val = fieldValue(cfg, row);
  if (typeof val !== "number") return false; // ranges apply to numeric/date fields
  // Dates are indexed as yyyymmdd text in legacy (Lucene), so ranges compare as
  // strings: [1940 TO 1979] spans 19400101..19781231 ("19790101" sorts after "1979").
  if (cfg.kind === "date") {
    const v = String(val);
    if (node.loText != null && v < node.loText) return false;
    if (node.hiText != null && v > node.hiText) return false;
    return true;
  }
  if (node.lo != null && val < node.lo) return false;
  if (node.hi != null && val > node.hi) return false; // inclusive (legacy stores ceilings)
  return true;
}

export function matchNode(node: Node, row: SearchRow): boolean {
  switch (node.t) {
    case "true": return true;
    case "and": return node.nodes.every((n) => matchNode(n, row));
    case "or": return node.nodes.some((n) => matchNode(n, row));
    case "not": return !matchNode(node.node, row);
    case "term": return termMatches(node, row);
    case "range": return rangeMatches(node, row);
  }
}

/** Collect field names referenced (to warn on unknowns). */
export function fieldsUsed(node: Node, out = new Set<string>()): Set<string> {
  if (node.t === "term" || node.t === "range") out.add(node.field);
  else if (node.t === "and" || node.t === "or") node.nodes.forEach((n) => fieldsUsed(n, out));
  else if (node.t === "not") fieldsUsed(node.node, out);
  return out;
}

/** Legacy SearchQueryParser: replace each smart_collection:"Name" (quotes required)
 *  with "(that collection's query)", nesting allowed. A cycle stops expansion
 *  (the leftover reference matches nothing); an unknown name becomes a clause
 *  that matches nothing ("(type:bad_query)"). */
export function expandSmartCollections(query: string, lookup: (name: string) => string | undefined): string {
  const RE = /smart_collection:"([^"]+)"/g;
  const expand = (q: string, stack: string[], depth: number): string | null => {
    if (depth > 100) return q;
    let cycle = false;
    const out = q.replace(RE, (whole, name: string) => {
      if (cycle) return whole;
      if (stack.includes(name.toLowerCase())) { cycle = true; return whole; }
      const inner = lookup(name);
      if (inner === undefined) return "(type:bad_query)";
      const sub = expand(inner, [...stack, name.toLowerCase()], depth + 1);
      if (sub === null) { cycle = true; return whole; }
      return `(${sub})`;
    });
    return cycle ? null : out;
  };
  if (!query.includes("smart_collection")) return query;
  return expand(query, [], 0) ?? query; // on a cycle, legacy evaluates the query unexpanded
}
