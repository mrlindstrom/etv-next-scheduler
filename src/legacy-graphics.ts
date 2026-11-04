// -----------------------------------------------------------------------------
// ErsatzTV legacy graphics elements, built into ErsatzTV next layers.
// -----------------------------------------------------------------------------
// Legacy kept graphics elements as YAML files under templates/graphics-elements/
// (image/, text/, motion/, subtitle/, script/) and filled each one in as a Scriban
// template for every item it played over — so one element could place a
// different picture, at a different spot and time, for every bumper. This keeps
// the element's YAML exactly as written and does the same thing at build time:
//   1. legacyVars(): the variables legacy gave the template — the item
//      (MediaItem_Path, _Title, _ShowTitle, _Genres…), the guide from the item's
//      start (Epg[0], Epg[1]… with Title, SubTitle, Description, Start…), the
//      item's times and the output size
//   2. fillLegacy(): render the template (scriban.ts), then read the YAML
//   3. legacyLayers(): turn the element into next graphics layers with legacy's
//      own placement rules — image: a picture layer (location, margins, scale,
//      within the picture); text: drawn to a full-frame PNG (styles, [style]…[/style]
//      spans, wrap / scale to fit, alignment, halo); motion: a video layer; and
//      opacity_expression -> next's fade timing (ncalc.ts), or for other curves one
//      timed layer per stretch it's visible.
// Subtitle and script elements aren't supported yet (reported, not drawn).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, utimesSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, dirname, basename, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import type { GraphicsLayer, PeriodicTiming, WatermarkLocation } from "./model.js";
import type { GuideEntry } from "./engine.js";
import type { Tz } from "./time.js";
import { renderTemplate, TemplateDate, TemplateSpan, formatNetDate, ianaZone, toText } from "./scriban.js";
import { parseOpacity, evaluate, type NativeFade } from "./ncalc.js";
import { rasterize, svgBBox, addFontDir, fontAlias } from "./overlays.js";

export type LegacyKind = "image" | "text" | "motion" | "subtitle" | "script";
export const LEGACY_KINDS: LegacyKind[] = ["image", "text", "motion", "subtitle", "script"];
/** A legacy element stored as an overlay: its YAML as written, and the file name
 *  legacy knew it by ("image/cn_city.yml"), so YAML graphics_on finds it. */
export interface LegacyElement { kind: LegacyKind; yaml: string; file?: string }

/** Library details legacy put in the MediaItem_* variables. */
export interface LegacyItemData {
  title?: string; plot?: string; releaseDateMs?: number | null; studios?: string[]; directors?: string[]; genres?: string[]; contentRating?: string;
  showTitle?: string; showYear?: number | null; showContentRating?: string; showGenres?: string[];
  durationMs?: number; width?: number; height?: number; track?: number | null; album?: string; artist?: string; artists?: string[]; year?: number | null;
}

/** What one item looks like to a legacy element. */
export interface LegacyContext {
  path: string; startMs: number; stopMs: number; tz: Tz;
  /** library details for a file (MediaItem_*, and Epg categories) */
  info: (path: string) => LegacyItemData | null;
  /** the guide (sorted); Epg[0] is the programme at the item's start */
  guide: GuideEntry[];
  output: { w: number; h: number };
}

/** The kind of an element from its legacy folder ("image/x.yml"), else from its keys. */
export function legacyKindOf(file: string, yaml: string): LegacyKind {
  const m = /(?:^|[\\/])(image|text|motion|subtitle|script)[\\/][^\\/]+$/i.exec(file);
  if (m) return m[1].toLowerCase() as LegacyKind;
  const has = (k: string) => new RegExp(`^\\s*${k}\\s*:`, "m").test(yaml);
  if (has("video_path")) return "motion";
  if (has("command")) return "script";
  if (has("template") && !has("text")) return "subtitle";
  if (has("text") || has("styles")) return "text";
  return "image";
}
/** How YAML graphics_on refers to an element ("image/cn_city.yml", any case / slash). */
export const legacyRef = (f: string) => f.replace(/\\/g, "/").replace(/^.*graphics-elements\//i, "").replace(/^\.?\//, "").replace(/\.ya?ml$/i, "").toLowerCase();

const zoneOf = (tz: Tz): string | number => (typeof tz === "number" ? tz : ianaZone(tz) || "UTC");
const date = (ms: number | null | undefined, tz: Tz) => (ms == null || !Number.isFinite(ms) ? null : new TemplateDate(ms, zoneOf(tz)));

/** The variables legacy filled an element in with, for this item. `epgEntries`: how
 *  many guide entries to give (the element's epg_entries). */
export function legacyVars(ctx: LegacyContext, epgEntries: number): Record<string, unknown> {
  const d = ctx.info(ctx.path) ?? {};
  const durMs = d.durationMs ?? Math.max(0, ctx.stopMs - ctx.startMs);
  const v: Record<string, unknown> = {
    Resolution: { Width: ctx.output.w, Height: ctx.output.h }, ScaledResolution: { Width: ctx.output.w, Height: ctx.output.h },
    RFrameRate: "30000/1001", FrameRate: 29.97,
    Channel_StartTime: date(ctx.startMs, ctx.tz),
    MediaItem_StreamSeek: new TemplateSpan(0), MediaItem_Start: date(ctx.startMs, ctx.tz), MediaItem_Stop: date(ctx.stopMs, ctx.tz),
    MediaItem_Path: ctx.path, MediaItem_Title: d.title ?? basename(ctx.path, extname(ctx.path)), MediaItem_Plot: d.plot ?? "",
    MediaItem_ReleaseDate: date(d.releaseDateMs, ctx.tz), MediaItem_Studios: d.studios ?? [], MediaItem_Directors: d.directors ?? [],
    MediaItem_Genres: d.genres ?? [], MediaItem_Resolution: { Width: d.width ?? 0, Height: d.height ?? 0 }, MediaItem_Duration: new TemplateSpan(durMs),
    MediaItem_ContentRating: d.contentRating ?? "",
  };
  if (d.showTitle) Object.assign(v, { MediaItem_ShowTitle: d.showTitle, MediaItem_ShowYear: d.showYear ?? null, MediaItem_ShowContentRating: d.showContentRating ?? "", MediaItem_ShowGenres: d.showGenres ?? [] });
  if (d.artist || d.album) Object.assign(v, { MediaItem_Track: d.track ?? null, MediaItem_Album: d.album ?? "", MediaItem_Artist: d.artist ?? "", MediaItem_Artists: d.artists ?? [] });
  if (epgEntries > 0) {
    const from = ctx.guide.findIndex((e) => e.stopMs > ctx.startMs + 5);
    const list = from < 0 ? [] : ctx.guide.slice(from, from + epgEntries);
    v.Epg = list.map((e) => {
      const it = e.item, show = it.showTitle || it.title || "";
      return {
        Title: show, SubTitle: it.showTitle ? it.title ?? "" : "", Description: it.plot ?? "", Rating: "",
        Categories: (it as { genres?: string[] }).genres ?? (it.path ? ctx.info(it.path)?.genres : undefined) ?? [], Date: it.year != null ? String(it.year) : "",
        Start: date(e.startMs, ctx.tz), Stop: date(e.stopMs, ctx.tz),
      };
    });
  }
  return v;
}

/** The element's epg_entries (legacy read it from the file before filling it in). */
export const epgEntriesOf = (yaml: string) => Math.max(0, ...[...yaml.matchAll(/epg_entries:\s*(\d+)/g)].map((m) => +m[1]));

/** Fill an element in for these variables and read it. Throws with a plain message. */
export function fillLegacy(el: LegacyElement, vars: Record<string, unknown>, tz: Tz): { yaml: string; def: Record<string, any> } {
  const zone = zoneOf(tz);
  const yaml = renderTemplate(el.yaml, vars, {
    zone,
    functions: {
      convert_timezone: (d: unknown, id: unknown) => (d instanceof TemplateDate ? new TemplateDate(d.ms, ianaZone(String(id)) || d.zone) : d),
      format_datetime: (d: unknown, id: unknown, fmt: unknown) => (d instanceof TemplateDate ? formatNetDate(new TemplateDate(d.ms, ianaZone(String(id)) || d.zone), String(fmt ?? "")) : toText(d)),
      get_directory_name: (p: unknown) => dirname(String(p ?? "")).replace(/\//g, process.platform === "win32" ? "\\" : "/"),
      get_filename_without_extension: (p: unknown) => basename(String(p ?? ""), extname(String(p ?? ""))),
    },
  });
  let def: unknown;
  try { def = parseYaml(yaml); } catch (e) { throw new Error(`the filled-in element isn't valid YAML: ${(e as Error).message.split("\n")[0]}`); }
  if (!def || typeof def !== "object") throw new Error("the filled-in element is empty");
  return { yaml, def: def as Record<string, any> };
}

// ---- placement (legacy GraphicsElement.CalculatePosition / ImageElementBase.CalculateBounds) ----
const LOCATIONS: Record<string, WatermarkLocation> = {
  bottomright: "bottom_right", bottomleft: "bottom_left", topright: "top_right", topleft: "top_left", topmiddle: "top_center",
  rightmiddle: "center_right", bottommiddle: "bottom_center", leftmiddle: "center_left", middlecenter: "center",
};
const LOCATION_BY_NUMBER = ["bottomright", "bottomleft", "topright", "topleft", "topmiddle", "rightmiddle", "bottommiddle", "leftmiddle", "middlecenter"];
function locationOf(v: unknown): { next: WatermarkLocation; key: string } {
  const key = typeof v === "number" || /^\d+$/.test(String(v ?? "")) ? LOCATION_BY_NUMBER[Number(v)] ?? "bottomright" : String(v ?? "BottomRight").replace(/[^a-z]/gi, "").toLowerCase();
  return { next: LOCATIONS[key] ?? "bottom_right", key: LOCATIONS[key] ? key : "bottomright" };
}
const numOr = (v: unknown, d: number) => { const n = Number(v); return v != null && v !== "" && Number.isFinite(n) ? n : d; };
const yes = (v: unknown) => v === true || /^(true|yes|1)$/i.test(String(v ?? ""));
/** Where a w x h box sits in a W x H frame (legacy's rules, margins in pixels). */
export function legacyPosition(key: string, W: number, H: number, w: number, h: number, hm: number, vm: number): { x: number; y: number } {
  switch (key) {
    case "bottomleft": return { x: hm, y: H - h - vm };
    case "topleft": return { x: hm, y: vm };
    case "topright": return { x: W - w - hm, y: vm };
    case "topmiddle": return { x: Math.floor((W - w) / 2), y: vm };
    case "rightmiddle": return { x: W - w - hm, y: Math.floor((H - h) / 2) };
    case "bottommiddle": return { x: Math.floor((W - w) / 2), y: H - h - vm };
    case "leftmiddle": return { x: hm, y: Math.floor((H - h) / 2) };
    case "middlecenter": return { x: Math.floor((W - w) / 2) + hm, y: Math.floor((H - h) / 2) + vm };
    default: return { x: W - w - hm, y: H - h - vm };
  }
}

// ---- opacity -> next timing ------------------------------------------------------------
const DAY = 86_400_000;
type Shown = { timing?: PeriodicTiming; opacity: number };
/** When (and how strongly) an element shows over one item, as next timings. */
function shownTimes(def: Record<string, any>, ctx: LegacyContext, problems: string[]): Shown[] {
  const base = Math.max(0, Math.min(100, numOr(def.opacity_percent ?? def.opacity, 100))) / 100;
  const expr = def.opacity_expression != null ? String(def.opacity_expression).trim() : "";
  if (!expr) return base > 0 ? [{ opacity: base }] : [];
  let plan;
  try { plan = parseOpacity(expr); } catch (e) { problems.push(`opacity_expression: ${(e as Error).message}`); return []; }
  if (plan.kind === "constant") return plan.opacity > 0 ? [{ opacity: plan.opacity }] : [];
  if (plan.kind === "fade") return [fadeTiming(plan.fade, ctx)];
  // any other curve: one timed layer per stretch it's visible (sampled 10x a second)
  const len = Math.min(Math.max(0, ctx.stopMs - ctx.startMs), 4 * 3_600_000);
  const zone = zoneOf(ctx.tz);
  const runs: { s: number; e: number; peak: number; rise: number; fall: number }[] = [];
  let cur: { s: number; peak: number; vals: number[] } | null = null;
  const STEP = 100;
  for (let t = 0; t <= len; t += STEP) {
    const at = ctx.startMs + t;
    const tod = new TemplateDate(at, zone).TimeOfDay.TotalSeconds;
    let v = 0;
    try { const r = evaluate(plan.expr, { content_seconds: t / 1000, content_total_seconds: len / 1000, channel_seconds: at / 1000, time_of_day_seconds: tod }); v = typeof r === "number" ? r : r === true ? 1 : 0; }
    catch (e) { problems.push(`opacity_expression: ${(e as Error).message}`); return []; }
    v = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
    if (v > 0.001 && t < len) { if (!cur) cur = { s: t, peak: 0, vals: [] }; cur.vals.push(v); cur.peak = Math.max(cur.peak, v); }
    else if (cur) {
      const top = cur.peak * 0.95, first = cur.vals.findIndex((x) => x >= top), last = cur.vals.length - 1 - [...cur.vals].reverse().findIndex((x) => x >= top);
      runs.push({ s: cur.s, e: cur.s + cur.vals.length * STEP, peak: cur.peak, rise: first * STEP, fall: (cur.vals.length - 1 - last) * STEP });
      cur = null;
      if (runs.length > 300) { problems.push("the opacity expression turns on and off more than 300 times in one item — only the first 300 are shown"); break; }
    }
  }
  return runs.map((r) => {
    const total = r.e - r.s, fade = Math.max(20, Math.min((r.rise + r.fall) / 2, total / 3));
    return { opacity: r.peak, timing: { timing_type: "periodic", clock: "content", frequency_ms: DAY, phase_offset_ms: Math.round(r.s), fade_ms: Math.round(fade), hold_ms: Math.max(1, Math.round(total - 2 * fade)) } };
  });
}
function fadeTiming(f: NativeFade, ctx: LegacyContext): Shown {
  const total = (f.fadeInS + f.holdS + f.fadeOutS) * 1000;
  // next fades in and out over the same time: the average of legacy's two
  const fade = Math.max(20, Math.min(((f.fadeInS + f.fadeOutS) / 2) * 1000, total / 3));
  const hold = Math.max(1, Math.round(total - 2 * fade));
  if (f.clock === "content") {
    const freq = f.everyS ? Math.round(f.everyS * 1000) : DAY;
    return { opacity: f.peak, timing: { timing_type: "periodic", clock: "content", frequency_ms: freq, phase_offset_ms: Math.round(f.startS * 1000) % freq, fade_ms: Math.round(fade), hold_ms: hold } };
  }
  // the time of day is local; next's wall clock counts from midnight UTC
  const freq = Math.round((f.everyS ?? 86_400) * 1000);
  const off = new TemplateDate(ctx.startMs, zoneOf(ctx.tz)).Offset.ms;
  const phase = ((Math.round(f.startS * 1000 - off) % freq) + freq) % freq;
  return { opacity: f.peak, timing: { timing_type: "periodic", clock: "wall", frequency_ms: freq, phase_offset_ms: phase, fade_ms: Math.round(fade), hold_ms: hold } };
}

// ---- text (legacy TextElement: RichTextKit, drawn here as SVG) ------------------------------
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** "#RGB", "#RRGGBB" or "#AARRGGBB" (Skia's order) -> SVG colour + opacity. */
function color(c: unknown, d = "#ffffff"): { fill: string; opacity: number } {
  const s = String(c ?? "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{8}$/i.test(s)) return { fill: `#${s.slice(2)}`, opacity: parseInt(s.slice(0, 2), 16) / 255 };
  if (/^[0-9a-f]{6}$/i.test(s) || /^[0-9a-f]{3}$/i.test(s)) return { fill: `#${s}`, opacity: 1 };
  if (/^[0-9a-f]{4}$/i.test(s)) return { fill: `#${s.slice(1)}`, opacity: parseInt(s[0] + s[0], 16) / 255 };
  return { fill: d, opacity: 1 };
}
interface Style { family: string; size: number; weight: number; weightSet: boolean; italic: boolean; italicSet: boolean; color: string; letter: number; lineHeight: number; halo?: string; haloW: number; haloBlur: number }
function stylesOf(def: Record<string, any>, problems: string[]): { base: Style; byName: Map<string, Style> } {
  const defs: any[] = Array.isArray(def.styles) ? def.styles : [];
  const baseDef = defs.find((s) => s?.name === def.base_style) ?? (def.base_style == null && defs.length === 0 ? {} : null);
  if (!baseDef) problems.push(`base_style "${def.base_style ?? ""}" isn't in the styles list`);
  const from = (s: any, parent?: Style): Style => ({
    family: s?.font_family ?? parent?.family ?? def.font_family ?? "Arial",
    size: numOr(s?.font_size, parent?.size ?? numOr(def.font_size, 32)),
    weight: numOr(s?.font_weight, parent?.weight ?? numOr(def.font_weight, 400)),
    weightSet: s?.font_weight != null || (parent?.weightSet ?? def.font_weight != null),
    italicSet: s?.font_italic != null ? yes(s.font_italic) : parent?.italicSet ?? yes(def.font_italic),
    italic: s?.font_italic != null ? yes(s.font_italic) : parent?.italic ?? yes(def.font_italic),
    color: s?.text_color ?? parent?.color ?? def.text_color ?? "#FFFFFF",
    letter: numOr(s?.letter_spacing, parent?.letter ?? numOr(def.letter_spacing, 0)),
    lineHeight: numOr(s?.line_height, parent?.lineHeight ?? numOr(def.line_height, 1)),
    halo: parent ? parent.halo : s?.halo_color ?? def.halo_color, haloW: parent ? parent.haloW : numOr(s?.halo_width ?? def.halo_width, 0),
    haloBlur: parent ? parent.haloBlur : numOr(s?.halo_blur ?? def.halo_blur, 0),
  });
  const base = from(baseDef ?? {});
  const byName = new Map<string, Style>();
  for (const s of defs) if (s?.name) byName.set(String(s.name), from(s, base));
  return { base, byName };
}
type Run = { text: string; st: Style };
function runsOf(line: string, styles: { base: Style; byName: Map<string, Style> }): Run[] {
  const out: Run[] = [];
  const re = /\[(\w+)\](.*?)\[\/\1\]/g;
  let last = 0;
  for (const m of line.matchAll(re)) {
    if (m.index! > last) out.push({ text: line.slice(last, m.index), st: styles.base });
    const st = styles.byName.get(m[1]);
    out.push(st ? { text: m[2], st } : { text: m[0], st: styles.base });
    last = m.index! + m[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last), st: styles.base });
  return out.length ? out : [{ text: "", st: styles.base }];
}
const tspan = (r: Run, scale: number, halo = false) => {
  // "Montserrat ExtraBold" (how Windows names it, and legacy took it) -> "Montserrat" at 800
  const a = fontAlias(r.st.family);
  const weight = r.st.weightSet ? r.st.weight : a.weight ?? r.st.weight, italic = r.st.italicSet || (a.italic ?? r.st.italic);
  const c = color(halo ? r.st.halo : r.st.color);
  return `<tspan font-family="${esc(a.family)}, ${esc(r.st.family)}, Arial, sans-serif" font-size="${(r.st.size * scale).toFixed(2)}" font-weight="${weight}" font-style="${italic ? "italic" : "normal"}"${r.st.letter ? ` letter-spacing="${(r.st.letter * scale).toFixed(2)}"` : ""} fill="${c.fill}"${c.opacity < 1 ? ` fill-opacity="${c.opacity.toFixed(3)}"` : ""}${halo ? ` stroke="${c.fill}" stroke-width="${(r.st.haloW * 2 * scale).toFixed(2)}" stroke-linejoin="round"` : ""}>${esc(r.text)}</tspan>`;
};
async function lineWidth(runs: Run[], scale: number): Promise<number> {
  if (!runs.some((r) => r.text.trim())) return 0;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="8000" height="1000"><text x="0" y="500" xml:space="preserve">${runs.map((r) => tspan(r, scale)).join("")}</text></svg>`;
  const b = await svgBBox(svg);
  return b ? b.x + b.width : runs.reduce((a, r) => a + r.text.length * r.st.size * scale * 0.55, 0);
}
/** A text element drawn on a transparent output-size frame -> SVG (null: nothing to draw). */
export async function legacyTextSvg(def: Record<string, any>, W: number, H: number, problems: string[]): Promise<string | null> {
  if (def.include_fonts_from) { const dir = String(def.include_fonts_from); if (existsSync(dir)) addFontDir(dir); else problems.push(`include_fonts_from folder ${dir} isn't on this machine`); }
  const styles = stylesOf(def, problems);
  const text = String(def.text ?? "").replace(/\r/g, "").replace(/\n+$/, "");
  if (!text.trim()) return null;
  const fit = String(def.text_fit ?? "none").toLowerCase();
  const maxW = def.width_percent != null ? Math.round((numOr(def.width_percent, 100) / 100) * W) : null;
  let lines = text.split("\n").map((l) => runsOf(l, styles));
  let scale = 1;
  if (maxW && fit === "wrap") {
    const wrapped: Run[][] = [];
    for (const line of lines) {
      let curLine: Run[] = [];
      const words = line.flatMap((r) => r.text.split(/(\s+)/).filter((x) => x !== "").map((w) => ({ text: w, st: r.st })));
      for (const w of words) {
        const trial = [...curLine, w];
        if (curLine.length && w.text.trim() && (await lineWidth(trial, 1)) > maxW) { wrapped.push(curLine); curLine = w.text.trim() ? [w] : []; }
        else curLine = trial;
      }
      wrapped.push(curLine);
    }
    lines = wrapped;
  }
  const widths = await Promise.all(lines.map((l) => lineWidth(l, 1)));
  if (maxW && fit === "scale") { const widest = Math.max(...widths); if (widest > maxW) scale = maxW / widest; }
  const lw = widths.map((w) => w * scale);
  const heights = lines.map((l) => Math.max(...l.map((r) => r.st.size * 1.2 * r.st.lineHeight)) * scale);
  const blockW = Math.ceil(fit === "wrap" && maxW ? maxW : Math.max(1, ...lw)), blockH = Math.ceil(heights.reduce((a, b) => a + b, 0));
  const loc = locationOf(def.location);
  const hm = Math.round((numOr(def.horizontal_margin_percent, 0) / 100) * W), vm = Math.round((numOr(def.vertical_margin_percent, 0) / 100) * H);
  const pos = legacyPosition(loc.key, W, H, blockW, blockH, hm, vm);
  const align = String(def.text_align ?? "left").toLowerCase();
  let y = pos.y, body = "", defs = "";
  lines.forEach((l, k) => {
    const x = align === "center" ? pos.x + (blockW - lw[k]) / 2 : align === "right" ? pos.x + blockW - lw[k] : pos.x;
    const base = y + Math.max(...l.map((r) => r.st.size)) * scale * 0.93;
    const haloRuns = l.filter((r) => r.st.halo && r.st.haloW > 0);
    if (haloRuns.length) {
      const blur = Math.max(...l.map((r) => r.st.haloBlur));
      if (blur > 0 && !defs.includes('id="hb"')) defs += `<filter id="hb" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="${(blur * scale).toFixed(2)}"/></filter>`;
      body += `<text x="${x.toFixed(1)}" y="${base.toFixed(1)}" xml:space="preserve"${blur > 0 ? ' filter="url(#hb)"' : ""}>${l.map((r) => (r.st.halo && r.st.haloW > 0 ? tspan(r, scale, true) : `<tspan fill="none">${esc(r.text)}</tspan>`)).join("")}</text>`;
    }
    body += `<text x="${x.toFixed(1)}" y="${base.toFixed(1)}" xml:space="preserve">${l.map((r) => tspan(r, scale)).join("")}</text>`;
    y += heights[k];
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>`;
}

// ---- the build: an element -> next layers ---------------------------------------------------------
const durations = new Map<string, number>();
/** A video's length in ms (ffprobe, remembered). */
function videoMs(path: string, ffprobe: string): number {
  const have = durations.get(path);
  if (have != null) return have;
  let ms = 0;
  try { ms = Math.round(Number(execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { windowsHide: true, timeout: 20_000 }).toString().trim()) * 1000) || 0; } catch { /* unknown */ }
  durations.set(path, ms);
  return ms;
}
const isUrl = (s: string) => /^https?:\/\//i.test(s);

export interface LegacyBuildDeps { cacheDir: string; ffprobe?: string; problems: string[] }

/** One legacy element over one item: next graphics layers (with their z_index). */
export async function legacyLayers(el: LegacyElement, ctx: LegacyContext, deps: LegacyBuildDeps): Promise<{ z: number; layer: GraphicsLayer }[]> {
  if (el.kind === "subtitle" || el.kind === "script") { deps.problems.push(`${el.kind} elements aren't supported yet`); return []; }
  let def: Record<string, any>;
  try { def = fillLegacy(el, legacyVars(ctx, epgEntriesOf(el.yaml)), ctx.tz).def; }
  catch (e) { deps.problems.push((e as Error).message); return []; }
  const z = numOr(def.z_index, 0);
  const shown = shownTimes(def, ctx, deps.problems);
  if (!shown.length) return [];
  const W = ctx.output.w, H = ctx.output.h;
  const loc = locationOf(def.location);
  const place = {
    location: loc.next,
    horizontal_margin_percent: numOr(def.horizontal_margin_percent, 0),
    vertical_margin_percent: numOr(def.vertical_margin_percent, 0),
  };
  const withOpacity = (s: Shown) => ({ ...(s.opacity < 0.999 ? { opacity_percent: Math.round(s.opacity * 1000) / 10 } : {}), ...(s.timing ? { timing: s.timing } : {}) });
  if (el.kind === "image") {
    const src = String(def.image ?? "").trim();
    if (!src) { deps.problems.push("an image element without an image"); return []; }
    if (!isUrl(src) && !existsSync(src)) { deps.problems.push(`image ${src} isn't on this machine`); return []; }
    const source = isUrl(src) ? { source_type: "http" as const, uri: src } : { source_type: "local" as const, path: src };
    const scaled = yes(def.scale) ? { width_percent: numOr(def.scale_width_percent, 100) } : {};
    const within = yes(def.place_within_source_content) ? { within_source_content: true } : {};
    return shown.map((s) => ({ z, layer: { kind: "media", source, ...place, ...scaled, ...within, ...withOpacity(s) } as GraphicsLayer }));
  }
  if (el.kind === "motion") {
    const src = String(def.video_path ?? "").trim();
    if (!src || !existsSync(src)) { deps.problems.push(src ? `video ${src} isn't on this machine` : "a motion element without a video_path"); return []; }
    const start = numOr(def.start_seconds, 0) * 1000;
    const end = String(def.end_behavior ?? "disappear").toLowerCase();
    const len = ctx.stopMs - ctx.startMs;
    const vid = deps.ffprobe ? videoMs(src, deps.ffprobe) : 0;
    const show = end === "loop" || end === "1" ? len - start : (vid || len - start) + (end === "hold" || end === "2" ? numOr(def.hold_seconds, 0) * 1000 : 0);
    if (show <= 0 || start >= len) return [];
    if (end === "hold" || end === "2") deps.problems.push("motion end_behavior: hold — next can't freeze the last frame, so the video keeps playing for the hold time");
    const scaled = yes(def.scale) ? { width_percent: numOr(def.scale_width_percent, 100) } : {};
    return [{ z, layer: { kind: "media", source: { source_type: "local", path: src }, ...place, ...scaled,
      timing: { timing_type: "periodic", clock: "content", frequency_ms: DAY, phase_offset_ms: Math.round(start), fade_ms: 20, hold_ms: Math.max(1, Math.round(show - 40)) } } as GraphicsLayer }];
  }
  // text: drawn here at the output size, placed as a full-frame picture
  const svg = await legacyTextSvg(def, W, H, deps.problems);
  if (!svg) return [];
  const file = join(deps.cacheDir, `${createHash("sha1").update(svg).digest("hex")}.png`);
  if (existsSync(file)) { try { const now = new Date(); utimesSync(file, now, now); } catch { /* ignore */ } }
  else { const png = await rasterize(svg); if (!png) { deps.problems.push("text elements need the SVG rasterizer (@resvg/resvg-js) — run npm install"); return []; } await writeFile(file, png); }
  return shown.map((s) => ({ z, layer: { kind: "media", source: { source_type: "local", path: file }, location: "top_left", horizontal_margin_percent: 0, vertical_margin_percent: 0, width_percent: 100, ...withOpacity(s) } as GraphicsLayer }));
}

/** Absolute paths written in an element that aren't on this machine (import warnings). */
export function missingPaths(yaml: string): string[] {
  const out = new Set<string>();
  for (const m of yaml.matchAll(/(?:[A-Za-z]:[\\/]|\\\\)[^"'\n{}|]*/g)) {
    let p = m[0].trim().replace(/[\\/]+$/, "");
    if (!p) continue;
    // a template part follows: check the folder it starts in
    if (!existsSync(p) && /\.[a-z0-9]{2,4}$/i.test(p) === false) p = p.replace(/[\\/][^\\/]*$/, "") || p;
    if (p.length > 3 && !existsSync(p)) out.add(m[0].trim());
  }
  return [...out];
}

/** A picture's size from its header (PNG, GIF, JPEG, WebP, BMP). */
export function imageSize(file: string): { w: number; h: number } | null {
  try {
    const b = readFileSync(file);
    if (b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.toString("ascii", 0, 3) === "GIF") return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (b.toString("ascii", 0, 2) === "BM") return { w: b.readInt32LE(18), h: Math.abs(b.readInt32LE(22)) };
    if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
      const kind = b.toString("ascii", 12, 16);
      if (kind === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      if (kind === "VP8L") { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
      return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch { /* unreadable */ }
  return null;
}
