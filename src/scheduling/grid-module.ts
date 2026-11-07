// Weekly grid module — schedule a channel the way a TV network does: a week of
// half-hour slots with a show in each (stripping = the same show in the same
// slot across days), several grids for different times of year ("seasons", e.g.
// Fall lineup Sep–May vs summer reruns), and one-off events that pre-empt the
// grid (marathons, holiday specials).
//
// It compiles to the dayparting engine: every grid cell becomes a daypart whose
// window is the cell's time range. The cell's sequence plays one program item
// sized to its half-hour slot (mid-roll breaks budgeted to fit, padded to the
// next :00/:30) and loops until the cell ends, so a 60-minute cell of a 22-minute
// show airs two episodes and an hour-long drama airs one. Rules are matched in
// order — events, then dated seasons, then the default season — and each season
// ends with a catch-all fallback so empty slots never fall through to another
// season's grid.
import type { ContentDef, DateRange, DateSpec, Daypart, Instruction, PlayoutDoc, PodDef, PlaybackOrder, Sequence } from "../yaml.js";
import type { SchedulingModule, ModuleSummary } from "./module.js";
import { parseCollectionRef } from "../collection-ref.js";
import { stationIdContent, type StationOptions } from "./station.js";
import { holidayDate } from "../holidays.js";

export const SLOT_MIN = 30; // grid granularity

export interface GridProgram {
  id: string;                                   // stable key: progress is tracked per program
  title: string;                                // label in the grid / palette
  source: "show" | "search" | "collection";
  value: string;                                // show title, search query, or "<type>::<name>"
  order?: PlaybackOrder;                        // default: chronological for shows, shuffle otherwise
  breaks?: "default" | "off";                   // mid-roll ad breaks for this program
  color?: string;
  overlays?: string[];                          // overlays (library ids) shown during this show
}
export interface GridCell { day: number; start: number; span: number; program: string } // day 0=Sun; minutes
export interface GridSeason { id: string; name: string; from?: string; to?: string; cells: GridCell[]; fallback?: string } // from/to "MM-DD" (annual)
/** A pre-emption: either on fixed dates ("YYYY-MM-DD"), or every year on a named
 *  holiday (e.g. "thanksgiving", "hanukkah") for `days` days starting that day. */
export interface GridEvent { id: string; name: string; dateFrom?: string; dateTo?: string; holiday?: string; days?: number; from?: string; to?: string; program: string }
export interface GridBreaks { enabled?: boolean; mode?: "count" | "interval" | "chapters"; breaks?: number; interval?: number; target?: number; adTags?: string[] /* breaks: only filler with one of these tags */ }
export interface GridConfig extends StationOptions {
  programs: GridProgram[];
  seasons: GridSeason[];
  events: GridEvent[];
  breaks?: GridBreaks;
  fillerLibraries?: string[];                   // local libraries: ad breaks + padding to the half hour
  fillerCollection?: string;                    // OR a collection for both
  fallback?: string;                            // program that fills empty grid time (default season)
}

const quote = (s: string) => `"${String(s).replace(/"/g, "")}"`;
const key = (s: string) => String(s).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "X";

export function parseGrid(raw: string): GridConfig {
  let c: any = {};
  try { c = JSON.parse(raw || "{}"); } catch { /* empty */ }
  return {
    programs: Array.isArray(c.programs) ? c.programs : [],
    seasons: Array.isArray(c.seasons) && c.seasons.length ? c.seasons : [{ id: "default", name: "Regular schedule", cells: [] }],
    events: Array.isArray(c.events) ? c.events : [],
    breaks: c.breaks, fillerLibraries: c.fillerLibraries, fillerCollection: c.fillerCollection, fallback: c.fallback,
    matchEra: c.matchEra, stationIdSource: c.stationIdSource, stationId: c.stationId,
  };
}

function programContent(p: GridProgram): ContentDef {
  const k = `P_${key(p.id)}`;
  const order = (p.order || (p.source === "show" ? "chronological" : "shuffle")) as PlaybackOrder;
  if (p.source === "collection") {
    const { type, name } = parseCollectionRef(p.value);
    const kind = type === "smart" ? "smart_collection" : type === "multi" ? "multi_collection" : type === "playlist" ? "playlist" : "collection";
    return { key: k, kind, order, collection: type === "playlist" ? undefined : name, playlist: type === "playlist" ? name : undefined, raw: {} };
  }
  const query = p.source === "show" ? `type:episode AND show_title:${quote(p.value)}` : p.value;
  return { key: k, kind: "search", order, query, raw: {} };
}

function annual(s?: string): DateSpec | null {
  const m = String(s ?? "").match(/^(\d{1,2})-(\d{1,2})$/);
  return m ? { month: +m[1], day: +m[2] } : null;
}
function dated(s?: string): DateSpec | null {
  const m = String(s ?? "").match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  return m ? { year: +m[1], month: +m[2], day: +m[3] } : null;
}
function hhmm(s: string | undefined, dflt: number): number {
  const m = String(s ?? "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return dflt;
  return Math.min(1440, +m[1] * 60 + +m[2]);
}
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** A holiday's dated ranges for the years around now (holidays like Thanksgiving
 *  or Hanukkah move, so each year is resolved separately). */
function holidayRanges(name: string, days: number): DateRange[] {
  const y0 = new Date().getUTCFullYear();
  const out: DateRange[] = [];
  for (let y = y0 - 1; y <= y0 + 8; y++) {
    const md = holidayDate(name, y);
    if (!md) continue;
    const a = new Date(Date.UTC(y, md.month - 1, md.day)), b = new Date(Date.UTC(y, md.month - 1, md.day + days - 1));
    out.push({ from: { year: a.getUTCFullYear(), month: a.getUTCMonth() + 1, day: a.getUTCDate() }, to: { year: b.getUTCFullYear(), month: b.getUTCMonth() + 1, day: b.getUTCDate() } });
  }
  return out;
}

export function compileGrid(cfg: GridConfig): PlayoutDoc {
  const programs = new Map(cfg.programs.map((p) => [p.id, p]));
  const content: ContentDef[] = cfg.programs.filter((p) => p.value).map(programContent);
  const sequences: Record<string, Sequence> = {};
  const pods: Record<string, PodDef> = {};
  const dayparts: Daypart[] = [];

  // shared filler (ad breaks + padding to the half hour)
  const libs = (cfg.fillerLibraries ?? []).filter(Boolean);
  let fillKey: string | null = null;
  if (cfg.fillerCollection) {
    const { type, name } = parseCollectionRef(cfg.fillerCollection);
    fillKey = "GRID_FILLER";
    content.push({ key: fillKey, kind: type === "smart" ? "smart_collection" : type === "multi" ? "multi_collection" : "collection", order: "shuffle", collection: name, raw: {} });
  } else if (libs.length) {
    fillKey = "GRID_FILLER";
    content.push({ key: fillKey, kind: "search", order: "shuffle", query: `library_name:(${libs.map(quote).join(" OR ")})`, raw: {} });
  }
  if (fillKey && cfg.matchEra) content[content.length - 1].matchEra = true;
  const sid = stationIdContent(cfg);
  if (sid) content.push(sid);
  const br = cfg.breaks ?? {};
  const breaksOn = br.enabled !== false && !!fillKey;
  // breaks limited to filler with certain tags: their own pool, so padding keeps everything
  let breakKey = fillKey;
  const adTags = (br.adTags ?? []).filter(Boolean);
  if (breaksOn && adTags.length) {
    const base = content.find((c) => c.key === fillKey)!;
    breakKey = "GRID_BREAK_FILLER";
    content.push({ ...base, key: breakKey, tags: adTags });
  }
  if (breaksOn) pods.GRID_BREAK = { key: "GRID_BREAK", target: `${br.target ?? 2} minutes`, slots: [{ content: breakKey!, fill: true, fillerKind: "midroll" }] };

  // one sequence per program: a slot-sized item, breaks budgeted to fit, padded to the grid
  const seqFor = (pid: string): string | null => {
    const p = programs.get(pid);
    if (!p || !p.value) return null;
    const sk = `S_${key(p.id)}`;
    if (sequences[sk]) return sk;
    const overlays = (p.overlays ?? []).filter(Boolean);
    const items: Instruction[] = [...overlays.map((o): Instruction => ({ op: "graphics_on", element: o })), { op: "epg_group", value: true }];
    const withBreaks = breaksOn && p.breaks !== "off";
    items.push(withBreaks
      ? { op: "mid_roll", enabled: true, pod: "GRID_BREAK", mode: br.mode ?? "count", interval: `${br.interval ?? 8} minutes`, breaks: br.breaks ?? 2 }
      : { op: "mid_roll", enabled: false });
    items.push({ op: "count", content: `P_${key(p.id)}`, count: 1, fitMinutes: SLOT_MIN });
    items.push({ op: "mid_roll", enabled: false });
    if (fillKey) items.push({ op: "pad_to_next", content: fillKey, minutes: SLOT_MIN, fillerKind: "tail", trim: true });
    items.push({ op: "epg_group", value: false });
    for (const o of overlays) items.push({ op: "graphics_off", element: o });
    sequences[sk] = { key: sk, items };
    return sk;
  };

  // events first: they pre-empt every season
  for (const e of cfg.events) {
    const sk = seqFor(e.program);
    if (!sk) continue;
    let ranges: DateRange[] = [];
    if (e.holiday) ranges = holidayRanges(e.holiday, Math.max(1, e.days ?? 1));
    else { const from = dated(e.dateFrom), to = dated(e.dateTo || e.dateFrom); if (from && to) ranges = [{ from, to }]; }
    if (!ranges.length) continue;
    dayparts.push({ label: e.name || "Event", days: ALL_DAYS, fromMin: hhmm(e.from, 0), toMin: hhmm(e.to, 1440) || 1440, sequence: sk, ranges });
  }

  // dated seasons before the default one; each ends with its own catch-all
  const seasonRange = (s: GridSeason): DateRange[] | undefined => {
    const a = annual(s.from), b = annual(s.to);
    return a && b ? [{ from: a, to: b }] : undefined;
  };
  const ordered = [...cfg.seasons.filter((s) => seasonRange(s)), ...cfg.seasons.filter((s) => !seasonRange(s))];
  for (const s of ordered) {
    const ranges = seasonRange(s);
    // stripping: the same program at the same time on several days is one rule
    const merged = new Map<string, { days: number[]; start: number; span: number; program: string }>();
    for (const c of s.cells ?? []) {
      if (!programs.has(c.program)) continue;
      const k = `${c.start}|${c.span}|${c.program}`;
      const m = merged.get(k) ?? { days: [], start: c.start, span: c.span, program: c.program };
      if (!m.days.includes(c.day)) m.days.push(c.day);
      merged.set(k, m);
    }
    for (const m of [...merged.values()].sort((a, b) => a.start - b.start)) {
      const sk = seqFor(m.program);
      if (!sk) continue;
      dayparts.push({ label: `${s.name}: ${programs.get(m.program)!.title}`, days: m.days.sort(), fromMin: m.start, toMin: Math.min(1440, m.start + m.span), sequence: sk, ranges });
    }
    const fb = seqFor(s.fallback || cfg.fallback || "");
    if (fb) dayparts.push({ label: `${s.name}: fallback`, days: ALL_DAYS, fromMin: 0, toMin: 1440, sequence: fb, ranges });
  }

  return { content, sequences, pods, dayparts, reset: [], playout: [], stationId: sid ? sid.key : undefined };
}

export function summarizeGrid(cfg: GridConfig): ModuleSummary {
  const cells = cfg.seasons.reduce((n, s) => n + (s.cells?.length ?? 0), 0);
  const base = { programs: cfg.programs.length, seasons: cfg.seasons.length, events: cfg.events.length, cells };
  if (!cfg.programs.some((p) => p.value)) return { valid: false, error: "Add a show to the palette, then place it on the grid.", ...base };
  if (cells === 0 && !cfg.fallback && !cfg.events.length) return { valid: false, error: "Place at least one show on the grid (or pick a fallback).", ...base };
  const ids = new Set(cfg.programs.map((p) => p.id));
  const dangling = [...cfg.seasons.flatMap((s) => s.cells.map((c) => c.program)), ...cfg.events.map((e) => e.program)].filter((id) => !ids.has(id));
  if (dangling.length) return { valid: false, error: `Grid uses a show that's no longer in the palette (${[...new Set(dangling)].join(", ")}).`, ...base };
  const overlaps: string[] = [];
  for (const s of cfg.seasons) for (const a of s.cells) for (const b of s.cells)
    if (a !== b && a.day === b.day && a.start < b.start && a.start + a.span > b.start) overlaps.push(`${s.name}`);
  if (overlaps.length) return { valid: false, error: `Two shows overlap in "${overlaps[0]}".`, ...base };
  try { compileGrid(cfg); } catch (e) { return { valid: false, error: (e as Error).message, ...base }; }
  return { valid: true, ...base, dayparts: compileGrid(cfg).dayparts.length };
}

export const gridModule: SchedulingModule = {
  id: "grid",
  label: "Weekly grid",
  description: "Network-style: place shows on a week of half-hour slots (strip a show across weekdays), add seasonal lineups with date ranges, and one-off events (marathons, specials) that pre-empt the grid.",
  editor: "grid",
  fileExts: [".grid.json"],
  saveExt: ".grid.json",
  defaultConfig: () => JSON.stringify({
    programs: [], events: [],
    seasons: [{ id: "default", name: "Regular schedule", cells: [] }],
    breaks: { enabled: true, mode: "count", breaks: 2, target: 2 },
  } satisfies GridConfig, null, 2),
  compile: (raw) => compileGrid(parseGrid(raw)),
  summarize: (raw) => summarizeGrid(parseGrid(raw)),
};
