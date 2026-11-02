// -----------------------------------------------------------------------------
// Overlays: timed graphics drawn over a channel's programmes (watermarks / bugs,
// lower thirds, "up next" straps, sponsor tags…), built for ErsatzTV next's
// graphics engine.
// -----------------------------------------------------------------------------
// An overlay is a set of layers — images, text with show templates ({{show}},
// {{next_title}}…), boxes and videos — laid out on a 1920x1080 artboard, plus
// when it shows (always, every N minutes, or N seconds into / before the end of
// each programme) and whether it also covers filler.
//
// The engine only records which overlays are on each playout item (the
// channel's own, plus any a block / grid show / YAML `graphics_on` switches
// on). After the build, applyOverlays() resolves each overlay's templates
// against the programme airing (and the next one in the guide), renders the
// still layers into one tightly cropped transparent PNG (cached by content, so
// a show's strap renders once), and attaches it as a next graphics layer
// positioned by percentages: next scales it with the output, and does the
// fading and periodic timing itself. Video layers become their own layers.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, utimesSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { mkdir, writeFile, rm, rename } from "node:fs/promises";
import { join, isAbsolute, basename } from "node:path";
import type { GraphicsLayer, PeriodicTiming, PlayoutItem, WatermarkLocation } from "./model.js";
import type { GuideEntry, ItemLabel } from "./engine.js";
import { formatClock } from "./upnext-ass.js";
import { localParts, type Tz } from "./time.js";
import { layerState, stateBox, animLengths, isAnimated, FULL, type LayerAnim, type LayerState } from "./overlay-anim.js";
import { holidayDate } from "./holidays.js";
import { spawn } from "node:child_process";

export const ARTBOARD = { w: 1920, h: 1080 };

interface Box { x: number; y: number; w: number; h: number; opacity?: number; anim?: LayerAnim }
export type OverlayLayer =
  | (Box & { type: "image"; src: string })
  | (Box & {
      type: "text"; text: string;
      font?: string; size?: number; color?: string; bold?: boolean; italic?: boolean; upper?: boolean;
      align?: "left" | "center" | "right"; valign?: "top" | "middle" | "bottom";
      outline?: string; outlineWidth?: number; shadow?: boolean;
      fit?: boolean;   // shrink to fit: keep it on one line, smaller when it's too long for the box
    })
  | (Box & { type: "box"; color?: string; radius?: number; border?: string; borderWidth?: number })
  | (Box & { type: "video"; src: string });

export interface OverlayTiming {
  /** always on | every N minutes (wall clock) | N seconds after a programme starts | N seconds before it ends */
  mode: "always" | "every" | "start" | "end";
  everyMinutes?: number;
  /** how long it stays on screen (every / start / end) */
  showSeconds?: number;
  /** every: seconds into each cycle; start: seconds after the start; end: seconds before the end */
  offsetSeconds?: number;
}

export interface Overlay {
  id: string;
  name: string;
  layers: OverlayLayer[];
  timing: OverlayTiming;
  fadeSeconds?: number;       // fade in/out (default 1)
  opacity?: number;           // whole overlay, 0-100 (default 100)
  duringFiller?: boolean;     // also over commercials / bumpers (default: programmes only)
  withinContent?: boolean;    // measure from the picture, not the letterbox / pillarbox bars
  /** A single-image overlay anchored the way legacy watermarks were (corner +
   *  margins + width), so next places it without knowing the image's size.
   *  Imported watermarks use this; the designer converts it to x/y on save. */
  anchor?: { location: WatermarkLocation; hMargin: number; vMargin: number; widthPercent?: number };
  /** Only around a holiday (days before / after it) or between two dates every year. */
  season?: OverlaySeason;
  /** Where an example overlay came from (examples/overlays), and its group in the picker. */
  category?: string;
  description?: string;
}
export interface OverlaySeason { holiday?: string; before?: number; after?: number; from?: string; to?: string }

export interface OverlayBuildOptions {
  library: Overlay[];
  channel: string[];          // overlays on every programme of this channel
  assetsDir: string;          // relative image / video `src` files live here
  cacheDir: string;           // rendered PNGs
  channelName?: string;
  channelNumber?: string;
  /** the channel's logo file, for image layers whose src is CHANNEL_LOGO */
  channelLogo?: string;
  /** shipped example artwork (`example:<file>` sources) */
  examplesDir?: string;
  /** animated overlays: ffmpeg to encode their transition clips, and the output size they're drawn at */
  ffmpeg?: string;
  output?: { w: number; h: number };
}

let EXAMPLES_DIR = "";
/** Where `example:<file>` image sources resolve (the repo's examples/overlays/assets). */
export const setOverlayExamplesDir = (dir: string) => { EXAMPLES_DIR = dir; };

/** An image layer `src` that stands for each channel's own logo. */
export const CHANNEL_LOGO = "channel-logo";

/** Template fields an overlay's text can use, for the designer's help. */
export const OVERLAY_FIELDS: { key: string; label: string; sample: string }[] = [
  { key: "show", label: "Show (or movie) title", sample: "Rugrats" },
  { key: "title", label: "Episode / movie title", sample: "Reptar on Ice" },
  { key: "episode_code", label: "Season & episode", sample: "S03E07" },
  { key: "season", label: "Season number", sample: "3" },
  { key: "episode", label: "Episode number", sample: "7" },
  { key: "year", label: "Year", sample: "1994" },
  { key: "start_time", label: "Start time", sample: "7:30 PM" },
  { key: "end_time", label: "End time", sample: "8:00 PM" },
  { key: "next_show", label: "Next show", sample: "Doug" },
  { key: "next_title", label: "Next episode / movie title", sample: "Doug's Big Feat" },
  { key: "next_start_time", label: "Next start time", sample: "8:00 PM" },
  { key: "next2_show", label: "Show after next", sample: "Hey Arnold!" },
  { key: "next2_title", label: "Show after next: episode / movie title", sample: "Arnold's Hat" },
  { key: "next2_start_time", label: "Show after next: start time", sample: "8:30 PM" },
  { key: "next3_show", label: "Third show from now", sample: "Rocko's Modern Life" },
  { key: "next3_title", label: "Third show from now: episode / movie title", sample: "Trash-O-Madness" },
  { key: "next3_start_time", label: "Third show from now: start time", sample: "9:00 PM" },
  { key: "channel", label: "Channel name", sample: "Nickelodeon" },
  { key: "number", label: "Channel number", sample: "21" },
];

export type OverlayVars = Record<string, string>;
export const sampleVars = (): OverlayVars => Object.fromEntries(OVERLAY_FIELDS.map((f) => [f.key, f.sample]));

/** How many upcoming programmes the templates can name (next_, next2_, next3_…). */
export const UPCOMING_FIELDS = 3;

/** The template values for an item: the programme airing and the ones after it
 *  (`upcoming[0]` is next; later ones fill next2_*, next3_*). */
export function overlayVars(cur: GuideEntry | undefined, upcoming: (GuideEntry | undefined)[], tz: Tz, ch: { name?: string; number?: string }): OverlayVars {
  const it = cur?.item, next = upcoming[0], nx = next?.item;
  const pad = (n?: number) => (n == null ? "" : String(n).padStart(2, "0"));
  const later: OverlayVars = {};
  for (let k = 2; k <= UPCOMING_FIELDS; k++) {
    const e = upcoming[k - 1];
    later[`next${k}_show`] = e ? e.item.showTitle || e.item.title || "" : "";
    later[`next${k}_title`] = e?.item.title ?? "";
    later[`next${k}_start_time`] = e ? formatClock(e.startMs, tz) : "";
  }
  return {
    ...later,
    show: it ? it.showTitle || it.title || "" : "",
    title: it?.title ?? "",
    episode_code: it?.season != null && it.episodeNumber != null ? `S${pad(it.season)}E${pad(it.episodeNumber)}` : "",
    season: it?.season != null ? String(it.season) : "",
    episode: it?.episodeNumber != null ? String(it.episodeNumber) : "",
    year: it?.year != null ? String(it.year) : "",
    start_time: cur ? formatClock(cur.startMs, tz) : "",
    end_time: cur ? formatClock(cur.stopMs, tz) : "",
    next_show: nx ? nx.showTitle || nx.title || "" : "",
    next_title: nx?.title ?? "",
    next_start_time: next ? formatClock(next.startMs, tz) : "",
    channel: ch.name ?? "",
    number: ch.number ?? "",
  };
}

export const fillTemplate = (text: string, v: OverlayVars): string =>
  String(text ?? "").replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k: string) => v[k.toLowerCase()] ?? "");

// ---- rendering ---------------------------------------------------------------
const FONT_CANDIDATES = [
  "C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/segoeuib.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp" };
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** An asset reference (a file in the overlays' asset folder, or an absolute path). */
export function assetPath(src: string, assetsDir: string, channelLogo?: string): string {
  if (!src) return "";
  if (src === CHANNEL_LOGO) return channelLogo ?? "";
  if (src.startsWith("example:")) return EXAMPLES_DIR ? join(EXAMPLES_DIR, basename(src.slice(8))) : "";
  return isAbsolute(src) ? src : join(assetsDir, basename(src));
}

/** Greedy word wrap by an average-glyph estimate (text has no layout engine in SVG). */
function wrap(text: string, width: number, size: number, bold: boolean, font = "Arial", italic = false): string[] {
  // measured with the real font when the rasterizer is loaded (it is during builds
  // and renders); otherwise an average-glyph estimate
  const per = Math.max(1, Math.floor(width / (size * (bold ? 0.58 : 0.53))));
  const fits = (t: string) => { const w = textWidth(t, font, size, bold, italic); return w == null ? t.length <= per : w <= width; };
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if (fits(line + " " + word)) line += " " + word;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

const widths = new Map<string, number>();
/** A line of text's drawn width in artboard pixels (null until the rasterizer is loaded). */
function textWidth(t: string, font: string, size: number, bold: boolean, italic: boolean): number | null {
  if (!Resvg) return null;
  const key = `${font}|${size}|${bold}|${italic}|${t}`;
  const have = widths.get(key);
  if (have != null) return have;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(size * (t.length + 2))}" height="${Math.ceil(size * 2)}"><text x="0" y="${size}" font-family="${esc(font)}, Arial, sans-serif" font-size="${size}" font-weight="${bold ? 700 : 400}" font-style="${italic ? "italic" : "normal"}">${esc(t)}</text></svg>`;
  let w = 0;
  try { const b = new Resvg(svg, { font: fontOptions(svg) }).getBBox(); w = b ? b.x + b.width : 0; } catch { return null; }
  if (widths.size > 20000) widths.clear();
  widths.set(key, w);
  return w;
}

/** The still layers' bounding box on the artboard (null if there are none). */
function stillBox(layers: OverlayLayer[]): Box | null {
  const still = layers.filter((l) => l.type !== "video" && l.w > 0 && l.h > 0);
  if (!still.length) return null;
  const x0 = Math.floor(Math.min(...still.map((l) => l.x))), y0 = Math.floor(Math.min(...still.map((l) => l.y)));
  const x1 = Math.ceil(Math.max(...still.map((l) => l.x + l.w))), y1 = Math.ceil(Math.max(...still.map((l) => l.y + l.h)));
  // even sizes: next / ffmpeg round odd dimensions for chroma-subsampled output
  const w = (x1 - x0) + ((x1 - x0) % 2), h = (y1 - y0) + ((y1 - y0) % 2);
  return { x: x0, y: y0, w, h };
}

/** SVG of an overlay's still layers, cropped to their bounding box — or, for an
 *  animation frame, each layer in its `states` look, drawn over `view` (artboard
 *  units) at `px` pixels. */
export function overlaySvg(o: Overlay, v: OverlayVars, readAsset: (src: string) => { data: string; mime: string } | null,
  frame?: { states?: LayerState[]; view?: Box; px?: { w: number; h: number } }): { svg: string; box: Box } | null {
  const box = frame?.view ?? stillBox(o.layers);
  if (!box) return null;
  let defs = "", body = "";
  o.layers.forEach((l, i) => {
    if (l.type === "video") return;
    const st = frame?.states?.[i] ?? FULL;
    if (st.opacity <= 0.001 || st.chars <= 0) return;
    const op = l.opacity != null && l.opacity < 100 ? ` opacity="${Math.max(0, l.opacity) / 100}"` : "";
    let el = "";
    if (l.type === "box") {
      const bw = num(l.borderWidth, 0);
      el = `<rect x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" rx="${num(l.radius, 0)}" fill="${esc(l.color || "#000000")}"${bw > 0 ? ` stroke="${esc(l.border || "#ffffff")}" stroke-width="${bw}"` : ""}${op}/>`;
    } else if (l.type === "image") {
      const a = readAsset(l.src);
      if (a) el = `<image x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" preserveAspectRatio="xMidYMid meet" href="data:${a.mime};base64,${a.data}"${op}/>`;
    } else if (l.type === "text") {
      let size = Math.max(4, num(l.size, 48));
      const bold = !!l.bold;
      let text = fillTemplate(l.text, v);
      if (l.upper) text = text.toUpperCase();
      let lines: string[];
      if (l.fit) {
        // shrink to fit: one line per paragraph, scaled down only when it's too wide
        lines = text.split(/\r?\n/);
        const widest = Math.max(...lines.map((ln) => textWidth(ln, l.font || "Arial", size, bold, !!l.italic) ?? ln.length * size * (bold ? 0.58 : 0.53)));
        if (widest > l.w) size = Math.max(8, Math.floor(size * (l.w / widest) * 0.98));
      } else lines = wrap(text, l.w, size, bold, l.font || "Arial", !!l.italic).filter((s, k, a) => s || a.length === 1);
      if (!lines.join("").trim()) return;
      const lh = size * 1.18;
      const block = lines.length * lh;
      const top = l.valign === "bottom" ? l.y + l.h - block : l.valign === "middle" ? l.y + (l.h - block) / 2 : l.y;
      if (st.chars < 1) { // typewriter: reveal characters across the (already wrapped) lines
        let left = Math.round(lines.join("").length * st.chars);
        lines = lines.map((ln) => { const part = ln.slice(0, Math.max(0, left)); left -= ln.length; return part; });
      }
      const anchor = l.align === "center" ? "middle" : l.align === "right" ? "end" : "start";
      const tx = l.align === "center" ? l.x + l.w / 2 : l.align === "right" ? l.x + l.w : l.x;
      let filter = "";
      if (l.shadow) { defs += `<filter id="s${i}" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="${(size / 16).toFixed(1)}" dy="${(size / 16).toFixed(1)}" stdDeviation="${(size / 20).toFixed(1)}" flood-color="#000" flood-opacity="0.75"/></filter>`; filter = ` filter="url(#s${i})"`; }
      const ow = num(l.outlineWidth, 0);
      const stroke = ow > 0 ? ` stroke="${esc(l.outline || "#000000")}" stroke-width="${ow}" stroke-linejoin="round" paint-order="stroke"` : "";
      const tspans = lines.map((s, k) => `<tspan x="${tx.toFixed(1)}" y="${(top + k * lh + size * 0.92).toFixed(1)}">${esc(s)}</tspan>`).join("");
      el = `<text font-family="${esc(l.font || "Arial")}, Arial, sans-serif" font-size="${size}" font-weight="${bold ? 700 : 400}" font-style="${l.italic ? "italic" : "normal"}" fill="${esc(l.color || "#ffffff")}" text-anchor="${anchor}"${stroke}${filter}${op}>${tspans}</text>`;
    }
    if (!el) return;
    if (st === FULL) { body += el; return; }
    // animated: clip (a wipe) in artboard space, then move / scale about the layer's centre
    const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
    const tf = st.dx || st.dy || st.scale !== 1 ? ` transform="translate(${(st.dx + cx).toFixed(2)} ${(st.dy + cy).toFixed(2)}) scale(${st.scale.toFixed(4)}) translate(${(-cx).toFixed(2)} ${(-cy).toFixed(2)})"` : "";
    let clip = "";
    if (st.clip) { defs += `<clipPath id="c${i}"><rect x="${st.clip.x.toFixed(2)}" y="${st.clip.y.toFixed(2)}" width="${Math.max(0, st.clip.w).toFixed(2)}" height="${Math.max(0, st.clip.h).toFixed(2)}"/></clipPath>`; clip = ` clip-path="url(#c${i})"`; }
    body += `<g${clip}${st.opacity < 1 ? ` opacity="${st.opacity.toFixed(3)}"` : ""}><g${tf}>${el}</g></g>`;
  });
  const px = frame?.px ?? { w: box.w, h: box.h };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px.w}" height="${px.h}" viewBox="${box.x} ${box.y} ${box.w} ${box.h}">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>`;
  return { svg, box };
}

let Resvg: any = undefined;
async function resvg(): Promise<any | null> {
  if (Resvg !== undefined) return Resvg;
  try { Resvg = (await import("@resvg/resvg-js")).Resvg; } catch { Resvg = null; }
  return Resvg;
}
/** Rasterize an overlay SVG to PNG (null if the rasterizer isn't installed). */
export async function rasterize(svg: string): Promise<Buffer | null> {
  const R = await resvg();
  if (!R) return null;
  return Buffer.from(new R(svg, { font: fontOptions(svg), background: "rgba(0,0,0,0)" }).render().asPng());
}
/** Font options for one drawing: loading every system font costs ~150 ms a
 *  drawing, so hand over just the families it uses. */
function fontOptions(svg: string) {
  const idx = fontIndex();
  const files = new Set(FONT_CANDIDATES.filter((f) => existsSync(f)));
  for (const m of svg.matchAll(/font-family="([^"]+)"/g)) for (const fam of m[1].split(",")) for (const file of idx.get(fam.trim().replace(/^['"]|['"]$/g, "").toLowerCase()) ?? []) files.add(file);
  return { loadSystemFonts: false, fontFiles: [...files], defaultFontFamily: "Arial" };
}
/** Load the rasterizer (so text is wrapped by its measured width). */
export const loadRasterizer = () => resvg();

// ---- system font index (family name -> font files), built once per process ----
let FONTS: Map<string, string[]> | null = null;
function fontIndex(): Map<string, string[]> {
  if (FONTS) return FONTS;
  FONTS = new Map();
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const dirs = process.platform === "win32"
    ? [join(process.env.WINDIR || "C:/Windows", "Fonts"), join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "Microsoft", "Windows", "Fonts")]
    : process.platform === "darwin" ? ["/System/Library/Fonts", "/Library/Fonts", join(home, "Library", "Fonts")]
    : ["/usr/share/fonts", "/usr/local/share/fonts", join(home, ".fonts"), join(home, ".local", "share", "fonts")];
  const walk = (d: string, depth: number) => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      if (/\.(ttf|otf)$/i.test(n)) {
        for (const fam of fontFamilies(p)) { const k = fam.toLowerCase(); const list = FONTS!.get(k) ?? []; if (!list.includes(p)) list.push(p); FONTS!.set(k, list); }
      } else if (depth < 4 && !n.includes(".")) walk(p, depth + 1);
    }
  };
  for (const d of dirs) walk(d, 0);
  return FONTS;
}
/** A font file's family names (name table IDs 1 and 16), read from its header. */
function fontFamilies(file: string): string[] {
  try {
    const fd = openSync(file, "r");
    try {
      const head = Buffer.alloc(12 + 16 * 64);
      readSync(fd, head, 0, head.length, 0);
      const n = head.readUInt16BE(4);
      let off = 0, len = 0;
      for (let i = 0; i < Math.min(n, 64); i++) if (head.toString("latin1", 12 + i * 16, 16 + i * 16) === "name") { off = head.readUInt32BE(20 + i * 16); len = head.readUInt32BE(24 + i * 16); }
      if (!off || len > 1_000_000) return [];
      const t = Buffer.alloc(len);
      readSync(fd, t, 0, len, off);
      const count = t.readUInt16BE(2), strings = t.readUInt16BE(4);
      const out = new Set<string>();
      for (let i = 0; i < count; i++) {
        const r = 6 + i * 12;
        const platform = t.readUInt16BE(r), id = t.readUInt16BE(r + 6), l = t.readUInt16BE(r + 8), o = t.readUInt16BE(r + 10);
        if (id !== 1 && id !== 16) continue;
        const raw = t.subarray(strings + o, strings + o + l);
        const name = platform === 3 || platform === 0 ? Buffer.from(raw).swap16().toString("utf16le") : raw.toString("latin1");
        if (name.trim()) out.add(name.trim());
      }
      return [...out];
    } finally { closeSync(fd); }
  } catch { return []; }
}

// ---- timing -------------------------------------------------------------------
/** Visibility for one playout item: {} = always on, a periodic timing, or null
 *  when the overlay doesn't appear during this item at all. `prog` is the
 *  programme the item belongs to (its guide entry). */
export function overlayTiming(o: Overlay, startMs: number, endMs: number, prog: { startMs: number; stopMs: number } | undefined): { timing?: PeriodicTiming } | null {
  const t = o.timing ?? { mode: "always" };
  if (t.mode === "always" || !t.mode) return {};
  const showMs = Math.max(1, num(t.showSeconds, 10)) * 1000;
  let fade = Math.max(CUT_FADE_MS, Math.max(0, num(o.fadeSeconds, 1)) * 1000);
  if (fade * 3 > showMs) fade = Math.floor(showMs / 3);       // next: fade <= hold
  const hold = showMs - 2 * fade;
  if (t.mode === "every") {
    const freq = Math.max(1, num(t.everyMinutes, 15)) * 60_000;
    if (showMs >= freq) return {};
    return { timing: { timing_type: "periodic", clock: "wall", frequency_ms: freq, hold_ms: hold, fade_ms: fade, phase_offset_ms: (Math.max(0, num(t.offsetSeconds, 0)) * 1000) % freq } };
  }
  if (!prog) return null;
  const off = Math.max(0, num(t.offsetSeconds, 0)) * 1000;
  const at = t.mode === "start" ? prog.startMs + off : prog.stopMs - off;
  if (at < startMs || at >= endMs) return null;                // it falls in another part of the programme
  // one appearance, measured from this item's start; a day-long cycle never repeats
  return { timing: { timing_type: "periodic", clock: "content", frequency_ms: 86_400_000, hold_ms: hold, fade_ms: fade, phase_offset_ms: Math.round(at - startMs) } };
}

// ---- the build post-pass -------------------------------------------------------
const round = (n: number) => Math.round(n * 1000) / 1000;
const clampPct = (n: number) => Math.min(100, Math.max(0, round(n)));
/** Artboard box -> next's percentage placement (anchored top-left). */
function placement(b: Box): Pick<GraphicsLayer, "location" | "horizontal_margin_percent" | "vertical_margin_percent" | "width_percent"> {
  return { location: "top_left", horizontal_margin_percent: clampPct((b.x / ARTBOARD.w) * 100), vertical_margin_percent: clampPct((b.y / ARTBOARD.h) * 100), width_percent: clampPct((b.w / ARTBOARD.w) * 100) };
}
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** A YAML `graphics_on: <image path>` that isn't a library overlay: the old
 *  behaviour, a small bug in the bottom-right corner. */
function adHocOverlay(path: string): Overlay {
  return { id: path, name: basename(path), layers: [{ type: "image", src: path, x: 0, y: 0, w: 0, h: 0 }], timing: { mode: "always" }, opacity: 90, duringFiller: true,
    anchor: { location: "bottom_right", hMargin: 5, vMargin: 5, widthPercent: 10 } };
}

/** A still image's pixel size from its header (PNG / JPEG; null for others). */
function imageSize(b: Buffer): { w: number; h: number } | null {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1], len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

/** A copy of a big PNG / JPEG scaled to `maxW` pixels wide (cached), or null to
 *  use the original. Huge images over a small bug are costly for every ffmpeg
 *  next starts, and next's Quick Sync path has been seen to drop segments
 *  (black) with them. */
async function downscaled(file: string, maxW: number, cacheDir: string): Promise<string | null> {
  try {
    const b = readFileSync(file);
    const s = imageSize(b);
    if (!s || s.w <= Math.max(64, maxW) * 1.25) return null;
    const w = Math.round(Math.max(64, maxW)), h = Math.max(1, Math.round((w * s.h) / s.w));
    const mime = b[0] === 0x89 ? "image/png" : "image/jpeg";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><image width="${w}" height="${h}" preserveAspectRatio="none" href="data:${mime};base64,${b.toString("base64")}"/></svg>`;
    const out = join(cacheDir, `${createHash("sha1").update(`${file}|${b.length}|${w}`).digest("hex")}.png`);
    if (existsSync(out)) { try { const now = new Date(); utimesSync(out, now, now); } catch { /* ignore */ } return out; }
    const png = await rasterize(svg);
    if (!png) return null;
    await writeFile(out, png);
    return out;
  } catch { return null; }
}

// ---- seasons -------------------------------------------------------------------
const mdNum = (m: number, d: number) => m * 100 + d;
/** Is `ms` (local date) inside the overlay's holiday window / date range? */
export function inSeason(se: OverlaySeason | undefined, ms: number, tz: Tz): boolean {
  if (!se || (!se.holiday && !(se.from && se.to))) return true;
  const p = localParts(ms, tz);
  const day = Date.UTC(p.y, p.mo, p.da);
  if (se.holiday) {
    for (const y of [p.y - 1, p.y, p.y + 1]) {
      const h = holidayDate(se.holiday, y);
      if (!h) return true; // unknown holiday: don't hide it
      const at = Date.UTC(y, h.month - 1, h.day);
      if (day >= at - Math.max(0, se.before ?? 0) * 86_400_000 && day <= at + Math.max(0, se.after ?? 0) * 86_400_000) return true;
    }
    return false;
  }
  const a = /^(\d{1,2})-(\d{1,2})$/.exec(se.from!), b = /^(\d{1,2})-(\d{1,2})$/.exec(se.to!);
  if (!a || !b) return true;
  const cur = mdNum(p.mo + 1, p.da), lo = mdNum(+a[1], +a[2]), hi = mdNum(+b[1], +b[2]);
  return lo <= hi ? cur >= lo && cur <= hi : cur >= lo || cur <= hi;
}

// ---- animated overlays ---------------------------------------------------------------
// next draws a canvas layer from a local file "content-locked": it seeks the file
// to the viewer's position in the playout item. So an animation baked into a file
// stays in sync with the show for anyone tuning in. Only the transitions are in
// the clip (a sparse, variable-frame-rate video: a transparent frame, the "in"
// frames, a transparent frame, …); the held look is the ordinary still layer,
// timed to fill the gap, so a viewer joining mid-hold still sees it. Each clip
// puts its first transition at CLIP_AT and the layer's in-point lines it up with
// the item, so one clip serves every item with the same text.
const CLIP_AT = 12 * 3_600_000;          // 12 h into the clip (longer than any item)
const CLIP_FPS = 30;
const DAY = 86_400_000;
const STEP = 1000 / CLIP_FPS;
// next writes fade_ms 0 as ffmpeg "fade=d=0", which ffmpeg reads as its default
// 25-frame fade — so a "hard cut" fades over a second. 20 ms is under one frame.
const CUT_FADE_MS = 20;

interface AnimPlan { offset: number; hold: PeriodicTiming | null }
/** Where the overlay's (first) appearance falls in this item, and the still layer's
 *  timing for the held part between the transitions. Null = not in this item. */
function animPlan(o: Overlay, startMs: number, endMs: number, prog: { startMs: number; stopMs: number } | undefined): AnimPlan | null {
  const t = o.timing ?? { mode: "always" };
  const { inMs, outMs } = animLengths(o.layers);
  const showMs = Math.max(1, num(t.showSeconds, 10)) * 1000;
  const hold = (phase: number, len: number, freq: number): PeriodicTiming | null =>
    len > 0 ? { timing_type: "periodic", clock: "content", frequency_ms: freq, hold_ms: Math.round(len), fade_ms: CUT_FADE_MS, phase_offset_ms: Math.round(((phase % freq) + freq) % freq) } : null;
  if (t.mode === "always" || !t.mode) return { offset: 0, hold: hold(inMs, DAY - 1, DAY) };
  const len = showMs - inMs - outMs;
  if (t.mode === "every") {
    const freq = Math.max(1, num(t.everyMinutes, 15)) * 60_000;
    const phase = Math.max(0, num(t.offsetSeconds, 0)) * 1000;
    let first = startMs - ((((startMs - phase) % freq) + freq) % freq);
    if (first + showMs <= startMs) first += freq;
    if (first >= endMs) return null;
    return { offset: first - startMs, hold: hold(first - startMs + inMs, len, freq) };
  }
  if (!prog) return null;
  const off = Math.max(0, num(t.offsetSeconds, 0)) * 1000;
  const at = t.mode === "start" ? prog.startMs + off : prog.stopMs - off;
  if (at < startMs || at >= endMs) return null;
  return { offset: at - startMs, hold: hold(at - startMs + inMs, len, DAY) };
}

function runFfmpeg(ffmpeg: string, args: string[]): Promise<string> {
  return new Promise((res) => {
    let err = "";
    const p = spawn(ffmpeg, args, { windowsHide: true });
    p.stderr.on("data", (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
    p.on("error", (e) => res(String(e.message)));
    p.on("close", (code) => res(code === 0 ? "" : err.trim().split(/\r?\n/).slice(-2).join(" ") || `ffmpeg exited ${code}`));
  });
}

/** The overlay's transition clip for these template values (cached by content):
 *  the file, and where it sits in output pixels. */
async function animatedClip(o: Overlay, v: OverlayVars, readAsset: (src: string) => { data: string; mime: string } | null, opts: OverlayBuildOptions,
  problems: string[]): Promise<{ file: string; origin: { x: number; y: number } } | null> {
  const out = opts.output!, t = o.timing ?? { mode: "always" };
  const sx = out.w / ARTBOARD.w, sy = out.h / ARTBOARD.h;
  const { inMs, outMs } = animLengths(o.layers);
  const showMs = Math.max(1, num(t.showSeconds, 10)) * 1000;
  const mode = t.mode || "always";
  const freq = Math.max(1, num(t.everyMinutes, 15)) * 60_000;

  // one appearance's frames, as times from its start (ms) and the layers' states
  const nIn = Math.ceil(inMs / STEP), nOut = Math.ceil(outMs / STEP);
  const app: { t: number; states: LayerState[] | null }[] = [];
  for (let j = 0; j <= nIn; j++) app.push({ t: j * STEP, states: o.layers.map((l) => layerState(l, "in", j * STEP)) });
  if (mode === "always") app.push({ t: (nIn + 1) * STEP, states: null });
  else {
    const holdMs = showMs - inMs - outMs;
    let outAt = showMs - outMs;
    if (holdMs > 0) app.push({ t: (nIn + 1) * STEP, states: null });
    else outAt = Math.max(outAt, (nIn + 1) * STEP);
    for (let j = 0; j <= nOut; j++) app.push({ t: outAt + j * STEP, states: o.layers.map((l) => layerState(l, "out", j * STEP)) });
    app.push({ t: outAt + (nOut + 1) * STEP, states: null });
  }

  // the region the graphic ever covers, in output pixels (even, inside the frame)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (b: { x: number; y: number; w: number; h: number } | null) => { if (!b) return; x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); };
  for (const f of app) if (f.states) o.layers.forEach((l, i) => { if (l.type !== "video") grow(stateBox(l, f.states![i])); });
  grow(stillBox(o.layers));
  if (!Number.isFinite(x0)) return null;
  const ox = Math.max(0, 2 * Math.floor((Math.max(0, x0) * sx) / 2)), oy = Math.max(0, 2 * Math.floor((Math.max(0, y0) * sy) / 2));
  const ex = Math.min(out.w, 2 * Math.ceil((Math.min(ARTBOARD.w, x1) * sx) / 2)), ey = Math.min(out.h, 2 * Math.ceil((Math.min(ARTBOARD.h, y1) * sy) / 2));
  const pw = ex - ox, ph = ey - oy;
  if (pw < 2 || ph < 2) return null;
  const view = { x: ox / sx, y: oy / sy, w: pw / sx, h: ph / sy };

  const texts = o.layers.map((l) => (l.type === "text" ? fillTemplate(l.text, v) : ""));
  const key = createHash("sha1").update(JSON.stringify({ layers: o.layers, texts, mode, freq, showMs, out, fps: CLIP_FPS, v: 1 })).digest("hex");
  const file = join(opts.cacheDir, `${key}.mkv`);
  if (existsSync(file)) { try { const now = new Date(); utimesSync(file, now, now); } catch { /* ignore */ } return { file, origin: { x: ox, y: oy } }; }

  // render each distinct frame once
  const tmp = join(opts.cacheDir, `tmp-${key}`);
  await mkdir(tmp, { recursive: true });
  const pngs = new Map<string, string>();
  const frameFile = async (states: LayerState[] | null): Promise<string | null> => {
    const k = states ? JSON.stringify(states.map((st) => [st.opacity, st.dx, st.dy, st.scale, st.clip, st.chars].map((n) => (typeof n === "number" ? Math.round(n * 100) / 100 : n)))) : "blank";
    if (pngs.has(k)) return pngs.get(k)!;
    const svg = states ? overlaySvg(o, v, readAsset, { states, view, px: { w: pw, h: ph } })?.svg
      : `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}"/>`;
    const png = svg ? await rasterize(svg) : null;
    if (!png) return null;
    const p = join(tmp, `f${String(pngs.size).padStart(4, "0")}.png`);
    await writeFile(p, png);
    pngs.set(k, p);
    return p;
  };
  const appearances = mode === "every" ? Math.min(400, Math.ceil((6 * 3_600_000) / freq) + 2) : 1;
  const frames: { t: number; file: string }[] = [];
  const blank = await frameFile(null);
  if (!blank) { problems.push("animated overlays need the SVG rasterizer (@resvg/resvg-js) — run npm install"); return null; }
  frames.push({ t: 0, file: blank });
  const rendered: { t: number; file: string }[] = [];
  for (const f of app) { const p = f.states ? await frameFile(f.states) : blank; if (p) rendered.push({ t: f.t, file: p }); }
  for (let k = 0; k < appearances; k++) for (const f of rendered) frames.push({ t: CLIP_AT + k * freq + f.t, file: f.file });
  frames.sort((a, b) => a.t - b.t);
  const list = ["ffconcat version 1.0"];
  frames.forEach((f, i) => {
    const nextT = frames[i + 1]?.t ?? f.t + STEP;
    list.push(`file '${f.file.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`, `duration ${Math.max(0.001, (nextT - f.t) / 1000).toFixed(6)}`);
  });
  list.push(`file '${frames[frames.length - 1].file.replace(/\\/g, "/")}'`);
  const listFile = join(tmp, "frames.ffconcat");
  await writeFile(listFile, list.join("\n") + "\n", "utf8");
  const partial = join(opts.cacheDir, `${key}.part.mkv`);
  const err = await runFfmpeg(opts.ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile,
    "-fps_mode", "passthrough", "-c:v", "ffv1", "-pix_fmt", "bgra", "-an", "-f", "matroska", partial]);
  try { await rm(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  if (err || !existsSync(partial)) { problems.push(`couldn't encode an animated overlay: ${err || "no output"}`); return null; }
  await rename(partial, file);
  return { file, origin: { x: ox, y: oy } };
}

/** An SVG file drawn to a cached PNG `w` pixels wide (null if it can't be). */
async function svgToPng(file: string, w: number, aspect: number, cacheDir: string): Promise<string | null> {
  try {
    const b = readFileSync(file);
    const W = Math.round(w), H = Math.max(1, Math.round(W * aspect));
    const out = join(cacheDir, `${createHash("sha1").update(`${file}|${b.length}|${W}x${H}`).digest("hex")}.png`);
    if (existsSync(out)) { try { const now = new Date(); utimesSync(out, now, now); } catch { /* ignore */ } return out; }
    const png = await rasterize(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><image width="${W}" height="${H}" preserveAspectRatio="xMidYMid meet" href="data:image/svg+xml;base64,${b.toString("base64")}"/></svg>`);
    if (!png) return null;
    await writeFile(out, png);
    return out;
  } catch { return null; }
}

export interface OverlayResult { items: number; rendered: number; problems: string[]; canvas?: boolean }

/** Turn the engine's overlay refs into graphics layers on the playout items. */
export async function applyOverlays(
  items: PlayoutItem[], refs: Map<string, string[]>, labels: Record<string, ItemLabel>, guide: GuideEntry[], tz: Tz, opts: OverlayBuildOptions,
): Promise<OverlayResult> {
  const out: OverlayResult = { items: 0, rendered: 0, problems: [] };
  if (!refs.size) return out;
  await resvg();
  const lib = new Map<string, Overlay>();
  for (const o of opts.library) { lib.set(o.id, o); if (!lib.has(o.name.toLowerCase())) lib.set(o.name.toLowerCase(), o); }
  const find = (ref: string): Overlay | null => lib.get(ref) ?? lib.get(ref.toLowerCase()) ?? (IMAGE_FILE.test(ref) && existsSync(ref) ? adHocOverlay(ref) : null);
  const g = guide.slice().sort((a, b) => a.startMs - b.startMs);
  // guide times keep fractions of a millisecond; item times are written to whole
  // ms, so a show starting as the last one ends can look a hair inside it
  const SLACK_MS = 5;
  const missing = new Set<string>();
  const assets = new Map<string, { data: string; mime: string } | null>();
  const readAsset = (src: string) => {
    const p = assetPath(src, opts.assetsDir, opts.channelLogo);
    if (!p) { out.problems.push("the channel has no logo file for its logo overlay"); return null; }
    if (!assets.has(p)) {
      try { assets.set(p, { data: readFileSync(p).toString("base64"), mime: MIME[p.split(".").pop()!.toLowerCase()] ?? "image/png" }); }
      catch { assets.set(p, null); out.problems.push(`image ${src} isn't readable`); }
    }
    return assets.get(p)!;
  };
  // rendered stills, by overlay + resolved text (a show's strap renders once per build)
  const stills = new Map<string, { file: string; box: Box } | null>();
  await mkdir(opts.cacheDir, { recursive: true });
  const still = async (o: Overlay, v: OverlayVars): Promise<{ file: string; box: Box } | null> => {
    const texts = o.layers.map((l) => (l.type === "text" ? fillTemplate(l.text, v) : ""));
    const key = `${JSON.stringify(o.layers)}|${JSON.stringify(texts)}`;
    if (stills.has(key)) return stills.get(key)!;
    let r: { file: string; box: Box } | null = null;
    const only = o.layers.length === 1 && o.layers[0].type === "image" ? o.layers[0] : null;
    if (only) {
      // a lone image plays straight from its file (keeps animated GIFs moving),
      // scaled down first when it's far bigger than it shows on screen
      const p = assetPath(only.src, opts.assetsDir, opts.channelLogo);
      if (p && existsSync(p)) {
        const shown = o.anchor && o.layers.length === 1 ? (o.anchor.widthPercent ? (o.anchor.widthPercent / 100) * ARTBOARD.w : 0) : only.w;
        // ffmpeg can't read SVG: draw it to a PNG at twice its on-screen size
        const svgPng = /\.svg$/i.test(p) ? await svgToPng(p, Math.max(64, (shown || 240) * 2), only.w && only.h ? only.h / only.w : 1, opts.cacheDir) : null;
        r = { file: svgPng || (shown > 0 && await downscaled(p, shown * 2, opts.cacheDir)) || p, box: only };
      }
      else out.problems.push(only.src === CHANNEL_LOGO ? "the channel has no logo file for its logo overlay" : `image ${only.src} isn't on this machine`);
    } else {
      const s = overlaySvg(o, v, readAsset);
      if (s) {
        const file = join(opts.cacheDir, `${createHash("sha1").update(s.svg).digest("hex")}.png`);
        if (existsSync(file)) { try { const now = new Date(); utimesSync(file, now, now); } catch { /* ignore */ } }
        else {
          const png = await rasterize(s.svg);
          if (png) { await writeFile(file, png); out.rendered++; }
        }
        if (existsSync(file)) r = { file, box: s.box };
        else out.problems.push("text overlays need the SVG rasterizer (@resvg/resvg-js) — run npm install");
      }
    }
    stills.set(key, r);
    return r;
  };

  // each programme's own span: from its first to its last programme (non-filler)
  // item, so "before the end" lands in the show, not in the padding after it
  const span = new Map<GuideEntry, { startMs: number; stopMs: number }>();
  {
    let k = 0;
    for (const item of items) {
      if (labels[item.id]?.fillerKind) continue;
      const s = Date.parse(item.start), f = Date.parse(item.finish);
      while (k < g.length && g[k].stopMs <= s + SLACK_MS) k++;
      if (k >= g.length || g[k].startMs > s + SLACK_MS) continue;
      const cur = span.get(g[k]);
      span.set(g[k], cur ? { startMs: Math.min(cur.startMs, s), stopMs: Math.max(cur.stopMs, f) } : { startMs: s, stopMs: f });
    }
  }

  const note = (itemId: string, id: string, at: number) => {
    const lab = (labels[itemId] ??= {});
    (lab.overlays ??= []).push({ id, at: Math.round(at) });
  };
  let gi = 0;
  for (const item of items) {
    const ids = refs.get(item.id);
    if (!ids?.length) continue;
    const s = Date.parse(item.start), f = Date.parse(item.finish);
    while (gi < g.length && g[gi].stopMs <= s + SLACK_MS) gi++;
    const cur = gi < g.length && g[gi].startMs <= s + SLACK_MS ? g[gi] : undefined;
    const n0 = cur ? gi + 1 : gi;
    const next = Array.from({ length: UPCOMING_FIELDS }, (_, k) => g[n0 + k]);
    const filler = !!labels[item.id]?.fillerKind;
    const layers: GraphicsLayer[] = [];
    let vars: OverlayVars | null = null;
    for (const ref of [...new Set(ids)]) {
      const o = find(ref);
      if (!o) { missing.add(ref); continue; }
      if (filler && !o.duringFiller) continue;
      if (!inSeason(o.season, s, tz)) continue;
      const progSpan = cur ? (span.get(cur) ?? cur) : undefined;
      // animated: the transition clip (canvas) + the held still between transitions
      if (isAnimated(o.layers) && !o.anchor && opts.ffmpeg && opts.output) {
        const plan = animPlan(o, s, f, progSpan);
        if (!plan) continue;
        vars ??= overlayVars(cur, next, tz, { name: opts.channelName, number: opts.channelNumber });
        const clip = await animatedClip(o, vars, readAsset, opts, out.problems);
        if (clip) {
          layers.push({ source: { source_type: "local", path: clip.file, in_point_ms: Math.max(0, Math.round(CLIP_AT - plan.offset)) }, kind: "canvas", location: "top_left", layout: { mode: "region", origin: clip.origin } } as GraphicsLayer);
          out.canvas = true;
          note(item.id, o.id, Math.max(0, plan.offset));
          const st = plan.hold ? await still(o, vars) : null;
          if (st && plan.hold) layers.push({ source: { source_type: "local", path: st.file }, ...placement(st.box), kind: "media",
            ...(o.opacity != null && o.opacity < 100 ? { opacity_percent: Math.max(0, o.opacity) } : {}), timing: plan.hold } as GraphicsLayer);
          continue;
        }
      }
      const t = overlayTiming(o, s, f, progSpan);
      if (!t) continue;
      note(item.id, o.id, !t.timing ? 0 : t.timing.clock === "content" ? t.timing.phase_offset_ms ?? 0
        : (((t.timing.phase_offset_ms ?? 0) - s) % t.timing.frequency_ms + t.timing.frequency_ms) % t.timing.frequency_ms);
      const common: Partial<GraphicsLayer> = {
        kind: "media",
        ...(o.opacity != null && o.opacity < 100 ? { opacity_percent: Math.max(0, o.opacity) } : {}),
        ...(o.withinContent ? { within_source_content: true } : {}),
        ...(t.timing ? { timing: t.timing } : {}),
      };
      vars ??= overlayVars(cur, next, tz, { name: opts.channelName, number: opts.channelNumber });
      const st = await still(o, vars);
      if (st) {
        const place = o.anchor && o.layers.length === 1
          ? { location: o.anchor.location, horizontal_margin_percent: o.anchor.hMargin, vertical_margin_percent: o.anchor.vMargin, ...(o.anchor.widthPercent ? { width_percent: o.anchor.widthPercent } : {}) }
          : placement(st.box);
        layers.push({ source: { source_type: "local", path: st.file }, ...place, ...common } as GraphicsLayer);
      }
      for (const l of o.layers) {
        if (l.type !== "video") continue;
        const p = assetPath(l.src, opts.assetsDir);
        if (!existsSync(p)) { out.problems.push(`video ${l.src} isn't on this machine`); continue; }
        layers.push({ source: { source_type: "local", path: p }, ...placement(l), ...common } as GraphicsLayer);
      }
    }
    if (layers.length) { item.graphics = [...layers, ...(item.graphics ?? [])]; out.items++; }
  }
  for (const m of missing) out.problems.push(`overlay "${m}" isn't in the overlay library`);
  out.problems = [...new Set(out.problems)];
  return out;
}
