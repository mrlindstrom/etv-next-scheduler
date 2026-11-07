// -----------------------------------------------------------------------------
// Legacy ErsatzTV YAML playout: types + loader/normalizer
// -----------------------------------------------------------------------------
// Aims for drop-in compatibility with existing ErsatzTV legacy channel YAML.
// The legacy format is loosely structured (each list entry is a small mapping),
// so we parse permissively and normalize into typed instructions.

import { parse as parseYaml } from "yaml";
import { parseTimeOfDay } from "./time.js";
import { holidayDate, isKnownHoliday, normalizeHolidayName } from "./holidays.js";

export type PlaybackOrder =
  | "chronological" | "shuffle" | "random" | "season_episode"
  | "shuffle_in_order" | "multi_episode_shuffle";

export type FillerKind = "preroll" | "midroll" | "postroll" | "fallback" | "tail" | undefined;

// --- content definitions -----------------------------------------------------
export type ContentKind =
  | "search" | "show" | "collection" | "multi_collection"
  | "smart_collection" | "playlist" | "marathon";

export interface ContentDef {
  key: string;
  kind: ContentKind;
  order: PlaybackOrder;
  query?: string;                              // search
  guids?: { source: string; value: string }[]; // show
  collection?: string;                          // collection / smart / multi
  playlist?: string;
  playlistGroup?: string;
  includeSpecials?: boolean;                    // opt in to Season 0 for this content
  expand?: boolean;                             // expand show/season groups to episodes (default true; false = members as-is for browsing)
  peek?: string;                                // resolve ${next_show_title} from this content key's upcoming item
  matchEra?: boolean;                           // filler: prefer items from the airing program's era (year ±5)
  // keep only items matching a rule: a folder of the library ({ library, folder: "Commercials/Food" },
  // that folder and below), a tag, or a path of tags all on the item (any case)
  tags?: (string | string[] | { library?: string; folder: string })[];
  rotation?: { size: number };                  // monthly rotation: each calendar month plays a fresh set of `size` titles
  raw: Record<string, any>;                     // original entry (for less-common fields)
}

// --- instructions (normalized union) ----------------------------------------
export type Instruction =
  | { op: "epg_group"; value: boolean }
  | { op: "graphics_on"; element: string; variables?: Record<string, string> }
  | { op: "graphics_off"; element: string }
  | { op: "watermark_on"; element: string }
  | { op: "watermark_off"; element: string }
  | { op: "pre_roll_on"; content: string; count?: number }
  | { op: "pre_roll_off" }
  // afterProgram: placed by a module straight after a programme on an unaligned
  // block, so the next programme starts as the card ends (see engine "up_next")
  | { op: "up_next"; theme?: string; count?: number; duration?: string; afterProgram?: boolean }
  | { op: "count"; content: string; count: number; fillerKind?: FillerKind; customTitle?: string; fitMinutes?: number; fitDiscard?: boolean }
  | { op: "duration"; content: string; duration: string; trim?: boolean; discardAttempts?: number; fillerKind?: FillerKind; fallback?: string; stopBeforeEnd?: boolean; offlineTail?: boolean; breakSequence?: string }
  | { op: "pad_to_next"; content: string; minutes: number; trim?: boolean; fillerKind?: FillerKind; fallback?: string; discardAttempts?: number; stopBeforeEnd?: boolean; offlineTail?: boolean }
  | { op: "pad_until"; content: string; when: string; tomorrow?: boolean; trim?: boolean; fillerKind?: FillerKind; fallback?: string }
  | { op: "mid_roll"; enabled: boolean; sequence?: string; pod?: string; expression?: string;
      mode?: MidRollMode; interval?: string; breaks?: number; fallback?: MidRollMode | "none"; minSegment?: string }
  | { op: "sequence"; sequence: string }
  | { op: "pod"; pod: string }
  | { op: "wait_until"; when: string; tomorrow?: boolean; rewindOnReset?: boolean }
  | { op: "repeat" }
  | { op: "skip_items"; content: string; count: number }
  | { op: "skip_to_item"; content: string; season: number; episode: number };

export interface Sequence { key: string; items: Instruction[]; }

// --- commercial-break pods ---------------------------------------------------
export type MidRollMode = "chapters" | "interval" | "count";

export interface PodSlot {
  content: string;      // content key to draw from
  count?: number;       // fixed number of items (default 1 unless fill)
  fill?: boolean;       // fill remaining break time with this content
  noRepeat?: string;    // don't reuse an item seen within this window, e.g. "30 minutes"
  fillerKind?: FillerKind;
}
export interface PodDef {
  key: string;
  target?: string;      // desired total break length, e.g. "2 minutes"
  tolerance?: string;   // acceptable over/under when filling, e.g. "15 seconds"
  maxItems?: number;    // hard cap on items in the pod
  slots: PodSlot[];
}

// --- dayparting --------------------------------------------------------------
/** A specific calendar day. `year` omitted = "every year" (annual). */
export interface DateSpec { year?: number; month: number; day: number } // month 1..12
/** Inclusive calendar range. Both ends share style (both annual or both dated).
 *  Annual ranges may wrap the year end (e.g. Dec 26 -> Jan 2). */
export interface DateRange { from: DateSpec; to: DateSpec }

/** A schedule-grid rule: on matching days (weekday) and, optionally, matching
 *  calendar dates, between from..to (local), run a sequence. Rules are matched
 *  in order; first match wins. Omitting every constraint makes a catch-all
 *  (useful as the last "default" rule). Date facets (months/dates/ranges/
 *  holidays) let you carve out holiday blocks and seasonal programming; a rule
 *  with a date facet only matches on days that also satisfy it, so put the most
 *  specific (holiday) rules first. */
export interface Daypart {
  label?: string;
  days: number[];   // 0=Sun .. 6=Sat
  fromMin: number;  // minutes from local midnight, inclusive
  toMin: number;    // minutes from local midnight, exclusive (1440 = end of day)
  sequence: string;
  months?: number[];      // 1..12; if set, current month must be one of these
  dates?: DateSpec[];     // if set, current date must match one of these
  ranges?: DateRange[];   // if set, current date must fall inside one of these
  holidays?: string[];    // if set, current date must be one of these holidays
}

export interface PlayoutDoc {
  content: ContentDef[];
  sequences: Record<string, Sequence>;
  pods: Record<string, PodDef>;
  dayparts: Daypart[];
  reset: Instruction[];
  playout: Instruction[];
  /** A station ID (content key) played to end exactly on each top of the hour that
   *  a program's padding reaches, as broadcast stations identify themselves. */
  stationId?: string;
}

const DAY_TOKENS: Record<string, number[]> = {
  sun: [0], mon: [1], tue: [2], tues: [2], wed: [3], thu: [4], thur: [4], thurs: [4], fri: [5], sat: [6],
  sunday: [0], monday: [1], tuesday: [2], wednesday: [3], thursday: [4], friday: [5], saturday: [6],
  weekday: [1, 2, 3, 4, 5], weekdays: [1, 2, 3, 4, 5], weekend: [0, 6], weekends: [0, 6], all: [0, 1, 2, 3, 4, 5, 6], daily: [0, 1, 2, 3, 4, 5, 6],
};

function parseDays(v: any): number[] {
  if (v == null) return [0, 1, 2, 3, 4, 5, 6];
  const list = Array.isArray(v) ? v : [v];
  const set = new Set<number>();
  for (const tok of list) for (const d of DAY_TOKENS[String(tok).trim().toLowerCase()] ?? []) set.add(d);
  return set.size ? [...set].sort() : [0, 1, 2, 3, 4, 5, 6];
}

function toMinutes(v: any, dflt: number): number {
  if (v == null) return dflt;
  const s = String(v).trim();
  if (s === "24:00" || s === "2400") return 1440;
  const { h, m } = parseTimeOfDay(s);
  const min = h * 60 + m;
  return min === 0 && dflt === 1440 ? 1440 : min; // a `to` of 00:00 means end-of-day
}

const MONTH_TOKENS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function parseMonths(v: any): number[] | undefined {
  if (v == null) return undefined;
  const list = Array.isArray(v) ? v : [v];
  const set = new Set<number>();
  for (const tok of list) {
    const s = String(tok).trim().toLowerCase();
    const n = MONTH_TOKENS[s] ?? (/^\d{1,2}$/.test(s) ? Number(s) : NaN);
    if (n >= 1 && n <= 12) set.add(n);
  }
  return set.size ? [...set].sort((a, b) => a - b) : undefined;
}

/** Parse "YYYY-MM-DD", "MM-DD"/"MM/DD" (annual), or a holiday name (annual,
 *  resolved per-year at match time via a year-less spec carrying the token). */
function parseDateSpec(v: any): DateSpec | { holiday: string } | null {
  const s = String(v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return { year: +m[1], month: +m[2], day: +m[3] };
  m = s.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (m) return { month: +m[1], day: +m[2] };
  if (isKnownHoliday(s)) return { holiday: normalizeHolidayName(s) };
  return null;
}

/** Collect date/holiday specs from the many accepted daypart keys. */
function parseDateFacets(d: any): { dates?: DateSpec[]; ranges?: DateRange[]; holidays?: string[] } {
  const dates: DateSpec[] = [];
  const holidays: string[] = [];
  const ranges: DateRange[] = [];

  const singles = ([] as any[]).concat(d.date ?? [], d.dates ?? []);
  for (const raw of singles) {
    const spec = parseDateSpec(raw);
    if (spec && "holiday" in spec) holidays.push(spec.holiday);
    else if (spec) dates.push(spec);
  }

  const holidayKeys = ([] as any[]).concat(d.holiday ?? [], d.holidays ?? []);
  for (const raw of holidayKeys) {
    const s = String(raw).trim();
    if (isKnownHoliday(s)) holidays.push(normalizeHolidayName(s));
  }

  // Range forms: date_from/date_to, from_date/to_date, or "A .. B" in date_range.
  const rFrom = d.date_from ?? d.from_date;
  const rTo = d.date_to ?? d.to_date;
  if (rFrom != null && rTo != null) {
    const a = parseDateSpec(rFrom), b = parseDateSpec(rTo);
    if (a && !("holiday" in a) && b && !("holiday" in b)) ranges.push({ from: a, to: b });
  }
  const drList = ([] as any[]).concat(d.date_range ?? []);
  for (const raw of drList) {
    const parts = String(raw).split(/\.\.|~|\bto\b/).map((x) => x.trim()).filter(Boolean);
    if (parts.length === 2) {
      const a = parseDateSpec(parts[0]), b = parseDateSpec(parts[1]);
      if (a && !("holiday" in a) && b && !("holiday" in b)) ranges.push({ from: a, to: b });
    }
  }

  return {
    dates: dates.length ? dates : undefined,
    ranges: ranges.length ? ranges : undefined,
    holidays: holidays.length ? [...new Set(holidays)] : undefined,
  };
}

const CONTENT_KINDS: ContentKind[] = [
  "search", "show", "collection", "multi_collection", "smart_collection", "playlist", "marathon",
];

function normalizeContent(entry: Record<string, any>): ContentDef {
  const kind = CONTENT_KINDS.find((k) => k in entry) ?? "search";
  const guids = Array.isArray(entry.guids)
    ? entry.guids.map((g: any) => ({ source: g.source, value: String(g.value) }))
    : undefined;
  return {
    key: entry.key,
    kind,
    order: (entry.order ?? "shuffle") as PlaybackOrder,
    query: entry.query,
    guids,
    collection: entry.collection ?? entry.multi_collection ?? entry.smart_collection,
    playlist: entry.playlist,
    playlistGroup: entry.playlist_group,
    includeSpecials: entry.include_specials,
    peek: entry.peek,
    matchEra: entry.match_era === true || entry.matchEra === true,
    rotation: entry.rotation ? { size: Math.max(1, Number(entry.rotation.size ?? entry.rotation) || 1) } : undefined,
    raw: entry,
  };
}

/** Convert one raw YAML instruction mapping into a normalized Instruction. */
function normalizeInstruction(e: Record<string, any>): Instruction {
  if ("epg_group" in e) return { op: "epg_group", value: !!e.epg_group };
  if ("graphics_on" in e) return { op: "graphics_on", element: e.graphics_on, variables: e.variables };
  if ("graphics_off" in e) return { op: "graphics_off", element: e.graphics_off };
  if ("watermark_on" in e) return { op: "watermark_on", element: e.watermark_on };
  if ("watermark_off" in e) return { op: "watermark_off", element: e.watermark_off };
  if ("pre_roll_on" in e) return { op: "pre_roll_on", content: e.pre_roll_on, count: e.count != null ? Number(e.count) : undefined };
  if ("pre_roll_off" in e) return { op: "pre_roll_off" };
  if ("up_next" in e) return {
    op: "up_next",
    theme: e.theme != null ? String(e.theme) : undefined,
    count: e.count != null ? Number(e.count) : undefined,
    duration: e.duration != null ? String(e.duration) : undefined,
  };
  if ("mid_roll" in e) return {
    op: "mid_roll", enabled: !!e.mid_roll, sequence: e.sequence, pod: e.pod,
    expression: e.expression != null ? String(e.expression) : undefined,
    mode: e.mode as MidRollMode | undefined, interval: e.interval != null ? String(e.interval) : undefined,
    breaks: e.breaks != null ? Number(e.breaks) : undefined, fallback: e.fallback,
    minSegment: e.min_segment != null ? String(e.min_segment) : undefined,
  };
  if ("pod" in e && !("content" in e) && !("count" in e)) return { op: "pod", pod: e.pod };
  if ("wait_until" in e) return { op: "wait_until", when: String(e.wait_until), tomorrow: e.tomorrow, rewindOnReset: e.rewind_on_reset };
  if ("repeat" in e) return { op: "repeat" };
  if ("skip_items" in e) return { op: "skip_items", content: e.content, count: e.skip_items };
  if ("skip_to_item" in e) return { op: "skip_to_item", content: e.content, season: e.season, episode: e.episode };
  if ("pad_to_next" in e) return { op: "pad_to_next", content: e.content, minutes: Number(e.pad_to_next), trim: e.trim, fillerKind: e.filler_kind, fallback: e.fallback, discardAttempts: e.discard_attempts, stopBeforeEnd: e.stop_before_end, offlineTail: e.offline_tail };
  if ("pad_until" in e) return { op: "pad_until", content: e.content, when: String(e.pad_until), tomorrow: e.tomorrow, trim: e.trim, fillerKind: e.filler_kind, fallback: e.fallback };
  if ("duration" in e) return { op: "duration", content: e.content, duration: String(e.duration), trim: e.trim, discardAttempts: e.discard_attempts, fillerKind: e.filler_kind, fallback: e.fallback, stopBeforeEnd: e.stop_before_end, offlineTail: e.offline_tail, breakSequence: e.break_sequence };
  if ("count" in e && "content" in e) return { op: "count", content: e.content, count: Number(e.count), fillerKind: e.filler_kind, customTitle: e.custom_title, fitMinutes: e.fit_minutes != null ? Number(e.fit_minutes) : undefined, fitDiscard: e.fit_discard };
  // a bare "{ sequence: X }" reference (must be checked last, since many ops carry a sequence field)
  if ("sequence" in e) return { op: "sequence", sequence: e.sequence };
  throw new Error(`Unrecognized instruction: ${JSON.stringify(e)}`);
}

/** Parse a legacy YAML playout string into a normalized document. */
export function loadPlayout(src: string): PlayoutDoc {
  const doc = parseYaml(src) ?? {};
  const content: ContentDef[] = (doc.content ?? [])
    .filter((c: any) => c && c.key)
    .map(normalizeContent);

  const sequences: Record<string, Sequence> = {};
  for (const s of doc.sequence ?? []) {
    sequences[s.key] = { key: s.key, items: (s.items ?? []).map(normalizeInstruction) };
  }
  const pods: Record<string, PodDef> = {};
  for (const p of doc.pods ?? doc.pod_defs ?? []) {
    pods[p.key] = {
      key: p.key, target: p.target != null ? String(p.target) : undefined,
      tolerance: p.tolerance != null ? String(p.tolerance) : undefined, maxItems: p.max_items,
      slots: (p.slots ?? []).map((s: any) => ({
        content: s.content, count: s.count, fill: !!s.fill,
        noRepeat: s.no_repeat != null ? String(s.no_repeat) : undefined, fillerKind: s.filler_kind,
      })),
    };
  }
  const dayparts: Daypart[] = (doc.dayparts ?? doc.daypart ?? []).map((d: any) => {
    const facets = parseDateFacets(d);
    return {
      label: d.label, days: parseDays(d.days), fromMin: toMinutes(d.from, 0), toMin: toMinutes(d.to, 1440), sequence: d.sequence,
      months: parseMonths(d.months ?? d.month), dates: facets.dates, ranges: facets.ranges, holidays: facets.holidays,
    };
  });
  const reset: Instruction[] = (doc.reset ?? []).map(normalizeInstruction);
  const playout: Instruction[] = (doc.playout ?? []).map(normalizeInstruction);
  const stationId = doc.station_id ? String(doc.station_id.content ?? doc.station_id) : undefined;
  return { content, sequences, pods, dayparts, reset, playout, stationId };
}
