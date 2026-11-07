// Movie channel module — premium-movie-channel scheduling (HBO / TCM style):
// movies start on the clock (:00 / :30) with trailers and shorts filling the
// gaps, a monthly rotation (each month a fresh set of titles, each airing
// several times at different times of day), and theme nights ("Western
// Wednesday", "Friday Fright Night") that take over their time windows.
// Compiles to dayparts: theme nights first, then the rotation all day.
import type { ContentDef, Daypart, Instruction, PlayoutDoc, PodDef, Sequence } from "../yaml.js";
import type { Field, SchedulingModule, ModuleSummary } from "./module.js";
import { parseCollectionRef } from "../collection-ref.js";
import { stationIdContent, STATION_FIELDS, type StationOptions } from "./station.js";

interface Theme { title?: string; days?: string; from?: string; to?: string; source?: "search" | "collection"; content?: string }
interface MoviesConfig extends StationOptions {
  source?: "search" | "collection";
  content?: string;                 // the movie pool
  rotation?: number;                // titles per month (0 = the whole pool)
  align?: string;                   // start movies on this clock grid ("0" = back-to-back)
  fillerLibraries?: string[];       // trailers / shorts between movies
  fillerCollection?: string;
  ads?: boolean;                    // commercial breaks during movies (premium channels: off)
  adTags?: string[];                // breaks: only filler with one of these tags
  adBreaks?: number;                // breaks per half hour of movie
  themes?: Theme[];
}

const DAYSETS: Record<string, number[]> = {
  daily: [0, 1, 2, 3, 4, 5, 6], weekdays: [1, 2, 3, 4, 5], weekends: [0, 6],
  sun: [0], mon: [1], tue: [2], wed: [3], thu: [4], fri: [5], sat: [6],
};
const quote = (s: string) => `"${String(s).replace(/"/g, "")}"`;
const hhmm = (s: string | undefined, dflt: number) => { const m = String(s ?? "").match(/^(\d{1,2}):(\d{2})$/); return m ? Math.min(1440, +m[1] * 60 + +m[2]) : dflt; };

function def(key: string, source: string | undefined, value: string, rotation?: number): ContentDef {
  const rot = rotation && rotation > 0 ? { size: rotation } : undefined;
  if (source === "collection") {
    const { type, name } = parseCollectionRef(value);
    const kind = type === "smart" ? "smart_collection" : type === "multi" ? "multi_collection" : type === "playlist" ? "playlist" : "collection";
    return { key, kind, order: "shuffle", collection: type === "playlist" ? undefined : name, playlist: type === "playlist" ? name : undefined, rotation: rot, raw: {} };
  }
  return { key, kind: "search", order: "shuffle", query: value, rotation: rot, raw: {} };
}

export function compileMovies(cfg: MoviesConfig): PlayoutDoc {
  const content: ContentDef[] = [];
  const sequences: Record<string, Sequence> = {};
  const pods: Record<string, PodDef> = {};
  const dayparts: Daypart[] = [];
  const align = Number(cfg.align ?? "30") || 0;

  let fill: string | null = null;
  const libs = (cfg.fillerLibraries ?? []).filter(Boolean);
  if (cfg.fillerCollection) { content.push(def("MOVIE_FILLER", "collection", cfg.fillerCollection)); fill = "MOVIE_FILLER"; }
  else if (libs.length) { content.push(def("MOVIE_FILLER", "search", `library_name:(${libs.map(quote).join(" OR ")})`)); fill = "MOVIE_FILLER"; }
  if (fill && cfg.matchEra) content[content.length - 1].matchEra = true;
  const sid = stationIdContent(cfg);
  if (sid) content.push(sid);
  // breaks limited to filler with certain tags: their own pool, so the gaps between movies keep everything
  let breakFill = fill;
  const adTags = (cfg.adTags ?? []).filter(Boolean);
  if (cfg.ads && fill && adTags.length) {
    const base = content.find((c) => c.key === fill)!;
    breakFill = "MOVIE_BREAK_FILLER";
    content.push({ ...base, key: breakFill, tags: adTags });
  }
  if (cfg.ads && fill) pods.MOVIE_BREAK = { key: "MOVIE_BREAK", target: "2 minutes", slots: [{ content: breakFill!, fill: true, fillerKind: "midroll" }] };

  const block = (contentKey: string, seqKey: string) => {
    const items: Instruction[] = [{ op: "epg_group", value: true }];
    items.push(cfg.ads && fill ? { op: "mid_roll", enabled: true, pod: "MOVIE_BREAK", mode: "count", breaks: cfg.adBreaks ?? 1 } : { op: "mid_roll", enabled: false });
    items.push({ op: "count", content: contentKey, count: 1, fitMinutes: align > 0 && cfg.ads ? align : undefined });
    items.push({ op: "mid_roll", enabled: false });
    if (align > 0 && fill) items.push({ op: "pad_to_next", content: fill, minutes: align, fillerKind: "tail", trim: true });
    items.push({ op: "epg_group", value: false });
    sequences[seqKey] = { key: seqKey, items };
  };

  (cfg.themes ?? []).forEach((t, i) => {
    if (!t.content) return;
    const k = `THEME_${i + 1}`;
    content.push(def(k, t.source, t.content));
    block(k, `${k}_SEQ`);
    dayparts.push({ label: t.title || `Theme ${i + 1}`, days: DAYSETS[t.days ?? "daily"] ?? DAYSETS.daily, fromMin: hhmm(t.from, 1200), toMin: hhmm(t.to, 1440) || 1440, sequence: `${k}_SEQ` });
  });

  if (cfg.content) {
    content.push(def("MOVIES", cfg.source, cfg.content, cfg.rotation));
    block("MOVIES", "MOVIES_SEQ");
    dayparts.push({ label: "Rotation", days: DAYSETS.daily, fromMin: 0, toMin: 1440, sequence: "MOVIES_SEQ" });
  }
  return { content, sequences, pods, dayparts, reset: [], playout: [], stationId: sid ? sid.key : undefined };
}

const DAY_OPTIONS = [
  { value: "daily", label: "Every day" }, { value: "weekdays", label: "Weekdays" }, { value: "weekends", label: "Weekends" },
  { value: "mon", label: "Mondays" }, { value: "tue", label: "Tuesdays" }, { value: "wed", label: "Wednesdays" }, { value: "thu", label: "Thursdays" },
  { value: "fri", label: "Fridays" }, { value: "sat", label: "Saturdays" }, { value: "sun", label: "Sundays" },
];

const SCHEMA: Field[] = [
  { type: "select", key: "source", label: "Movies from", options: [{ value: "collection", label: "A collection" }, { value: "search", label: "A search query" }], default: "collection" },
  { type: "collection", key: "content", label: "Movie collection", showIf: { key: "source", equals: "collection" } },
  { type: "query", key: "content", label: "Movie search", placeholder: "type:movie AND genre:Comedy", showIf: { key: "source", equals: "search" } },
  { type: "number", key: "rotation", label: "Titles in rotation each month (0 = all)", default: 40, min: 0, help: "Each month a fresh set of this many movies is picked, and each airs several times at different times of day, like a premium movie channel. 0 shuffles the whole pool." },
  { type: "select", key: "align", label: "Start movies on", options: [{ value: "30", label: "The hour or half hour (:00 / :30)" }, { value: "60", label: "The hour (:00)" }, { value: "15", label: "Quarter hours" }, { value: "0", label: "Back-to-back (no gaps)" }], default: "30" },
  { type: "libraries", key: "fillerLibraries", label: "Between movies: trailers, shorts, promos", help: "Fills the gap until the next start time." },
  { type: "collection", key: "fillerCollection", label: "Or a filler collection (overrides the libraries)" },
  { type: "checkbox", key: "ads", label: "Commercial breaks during movies (premium channels run none)" },
  { type: "number", key: "adBreaks", label: "Breaks per half hour of movie", default: 1, min: 1, showIf: { key: "ads", equals: true as any } },
  { type: "tags", key: "adTags", label: "Only break filler with these tags (optional)", libraries: "fillerLibraries", collection: "fillerCollection", showIf: { key: "ads", equals: true as any },
    help: "Breaks play only items carrying at least one of the ticked tags. Nothing ticked = any filler. The gaps between movies still use all of it." },
  ...STATION_FIELDS,
  {
    type: "list", key: "themes", label: "Theme nights", addLabel: "+ Add theme night", itemTitle: "title",
    help: "Take over a time window on certain days with a different set of movies, e.g. Westerns on Wednesday nights.",
    fields: [
      { type: "text", key: "title", label: "Name", placeholder: "Western Wednesday" },
      { type: "select", key: "days", label: "On", options: DAY_OPTIONS, default: "wed" },
      { type: "text", key: "from", label: "From (HH:MM)", default: "20:00" },
      { type: "text", key: "to", label: "To (HH:MM, 24:00 = midnight)", default: "24:00" },
      { type: "select", key: "source", label: "Movies from", options: [{ value: "search", label: "A search query" }, { value: "collection", label: "A collection" }], default: "search" },
      { type: "query", key: "content", label: "Search", placeholder: "type:movie AND genre:Western", showIf: { key: "source", equals: "search" } },
      { type: "collection", key: "content", label: "Collection", showIf: { key: "source", equals: "collection" } },
    ],
  },
];

export const moviesModule: SchedulingModule = {
  id: "movies",
  label: "Movie channel",
  description: "Premium-movie-channel style: movies start on the clock with trailers between, a monthly rotation where each title airs several times, and theme nights.",
  editor: "form",
  fileExts: [".movies.json"],
  saveExt: ".movies.json",
  defaultConfig: () => JSON.stringify({ source: "collection", content: "", rotation: 40, align: "30", themes: [] }, null, 2),
  schema: () => SCHEMA,
  compile: (raw) => compileMovies(JSON.parse(raw || "{}")),
  summarize(raw): ModuleSummary {
    try {
      const c = JSON.parse(raw || "{}") as MoviesConfig;
      if (!c.content) return { valid: false, error: "Pick the movies this channel plays." };
      const themes = (c.themes ?? []).filter((t) => t.content).length;
      return { valid: true, rotation: c.rotation ?? 0, themes, dayparts: themes + 1, sequences: themes + 1 };
    } catch (e) { return { valid: false, error: (e as Error).message }; }
  },
};
