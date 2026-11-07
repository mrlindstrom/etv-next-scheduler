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
import { layerState, layerStateAt, hasLayerTiming, fadeAt, stateBox, animLengths, isAnimated, drawsLive, liveFadeMs, layerWindow, FULL, type LayerAnim, type LayerAppear, type LayerState } from "./overlay-anim.js";
import { holidayDate } from "./holidays.js";
import { legacyLayers, legacyRef, type LegacyElement, type LegacyItemData } from "./legacy-graphics.js";
import { spawn } from "node:child_process";
import { cpus } from "node:os";

export const ARTBOARD = { w: 1920, h: 1080 };

interface Box { x: number; y: number; w: number; h: number; opacity?: number; anim?: LayerAnim; appear?: LayerAppear }
export type OverlayLayer =
  // `src` may be `match:<name template>` — a picture in the pictures folder picked
  // by the schedule (e.g. `match:{{next_show}}`); `fallback` is used when none matches
  | (Box & { type: "image"; src: string; fallback?: string })
  | (Box & {
      type: "text"; text: string;
      font?: string; size?: number; color?: string; bold?: boolean; italic?: boolean; upper?: boolean;
      align?: "left" | "center" | "right"; valign?: "top" | "middle" | "bottom";
      outline?: string; outlineWidth?: number; shadow?: boolean;
      fit?: boolean;   // shrink to fit: keep it on one line, smaller when it's too long for the box
    })
  // gradient: from `color` to `to` ("transparent" = fade the colour out), across or down
  | (Box & { type: "box"; color?: string; radius?: number; border?: string; borderWidth?: number; gradient?: { to: string; dir?: "right" | "down" } })
  | (Box & { type: "video"; src: string; fallback?: string });

export interface OverlayTiming {
  /** always on | every N minutes (wall clock) | N seconds after a programme starts | N seconds before it ends
   *  | whenever one particular file airs (`media`), N seconds into it */
  mode: "always" | "every" | "start" | "end" | "media";
  /** media: the file that sets it off (on every channel that plays it), and its length */
  media?: { path: string; title?: string; durationMs?: number };
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
  /** How it moves: "live" = drawn live by the scheduler, fades only (no pre-render);
   *  "rendered" = pre-rendered clips with every animation; unset = live when it only fades. */
  motion?: "live" | "rendered";
  /** a renamed copy (the Troubleshooting preview): the saved overlay its live layers draw */
  liveId?: string;
  /** an imported ErsatzTV legacy graphics element: filled in per item at build time
   *  (legacy-graphics.ts) instead of drawn from `layers` */
  legacy?: LegacyElement;
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
  /** the pictures folder `match:` sources pick from */
  picturesDir?: string;
  /** this scheduler's address as next reaches it, for overlays drawn live
   *  (`${liveBase}/graphics/overlay.png`); without it they're pre-rendered */
  liveBase?: string;
  /** animated overlays: ffmpeg to encode their transition clips, and the output size they're drawn at */
  ffmpeg?: string;
  output?: { w: number; h: number };
}

let EXAMPLES_DIR = "";
/** Where `example:<file>` image sources resolve (the repo's examples/overlays/assets). */
export const setOverlayExamplesDir = (dir: string) => { EXAMPLES_DIR = dir; };

/** An image layer `src` that stands for each channel's own logo. */
export const CHANNEL_LOGO = "channel-logo";

/** How many upcoming programmes the templates can name (next_, next2_, next3_…). */
export const UPCOMING_FIELDS = 3;

/** The programmes templates can name: what's on now, then the ones after it.
 *  `prefix` goes in front of each detail's key (show, next_show, next2_show…). */
export const OVERLAY_SLOTS: { prefix: string; label: string }[] = [
  { prefix: "", label: "Now" }, { prefix: "next_", label: "Next" },
  { prefix: "next2_", label: "After next" }, { prefix: "next3_", label: "Third" },
];
/** The details each programme has. */
const SLOT_DETAILS: { key: string; label: string }[] = [
  { key: "show", label: "Show (or movie) title" }, { key: "title", label: "Episode / movie title" },
  { key: "episode_code", label: "Season & episode" }, { key: "season", label: "Season number" },
  { key: "episode", label: "Episode number" }, { key: "year", label: "Year" },
  { key: "kind", label: "Episode or Movie" },
  { key: "start_time", label: "Start time" }, { key: "end_time", label: "End time" },
];
const SAMPLE_SLOTS: Record<string, string>[] = [
  { show: "Rugrats", title: "Reptar on Ice", episode_code: "S03E07", season: "3", episode: "7", year: "1994", kind: "Episode", start_time: "7:30 PM", end_time: "8:00 PM" },
  { show: "Doug", title: "Doug's Big Feat", episode_code: "S01E04", season: "1", episode: "4", year: "1991", kind: "Episode", start_time: "8:00 PM", end_time: "8:30 PM" },
  { show: "Hey Arnold!", title: "Arnold's Hat", episode_code: "S01E10", season: "1", episode: "10", year: "1996", kind: "Episode", start_time: "8:30 PM", end_time: "9:00 PM" },
  { show: "Rocko's Modern Life", title: "Trash-O-Madness", episode_code: "S01E03", season: "1", episode: "3", year: "1993", kind: "Episode", start_time: "9:00 PM", end_time: "9:30 PM" },
];

/** Template fields an overlay can use, for the designer's help (`slot` groups
 *  them: 0 = now, 1 = next…; channel details have none). */
export const OVERLAY_FIELDS: { key: string; label: string; sample: string; slot?: number }[] = [
  ...OVERLAY_SLOTS.flatMap((s, k) => SLOT_DETAILS.map((d) => ({
    key: s.prefix + d.key, label: k ? `${s.label}: ${d.label.charAt(0).toLowerCase()}${d.label.slice(1)}` : d.label, sample: SAMPLE_SLOTS[k][d.key], slot: k,
  }))),
  { key: "channel", label: "Channel name", sample: "Nickelodeon" },
  { key: "number", label: "Channel number", sample: "21" },
];

export type OverlayVars = Record<string, string>;
export const sampleVars = (): OverlayVars => Object.fromEntries(OVERLAY_FIELDS.map((f) => [f.key, f.sample]));

/** One programme's details, keyed with `prefix` (blank when there's none). */
function slotVars(e: GuideEntry | undefined, prefix: string, tz: Tz): OverlayVars {
  const it = e?.item;
  const pad = (n?: number) => (n == null ? "" : String(n).padStart(2, "0"));
  const v: Record<string, string> = {
    show: it ? it.showTitle || it.title || "" : "",
    title: it?.title ?? "",
    episode_code: it?.season != null && it.episodeNumber != null ? `S${pad(it.season)}E${pad(it.episodeNumber)}` : "",
    season: it?.season != null ? String(it.season) : "",
    episode: it?.episodeNumber != null ? String(it.episodeNumber) : "",
    year: it?.year != null ? String(it.year) : "",
    kind: !it ? "" : it.kind === "movie" ? "Movie" : it.kind === "episode" || it.showTitle ? "Episode" : "",
    start_time: e ? formatClock(e.startMs, tz) : "",
    end_time: e ? formatClock(e.stopMs, tz) : "",
  };
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [prefix + k, x]));
}

/** The template values for an item: the programme airing and the ones after it
 *  (`upcoming[0]` is next; later ones fill next2_*, next3_*). */
export function overlayVars(cur: GuideEntry | undefined, upcoming: (GuideEntry | undefined)[], tz: Tz, ch: { name?: string; number?: string }): OverlayVars {
  const out: OverlayVars = { ...slotVars(cur, "", tz) };
  for (let k = 1; k <= UPCOMING_FIELDS; k++) Object.assign(out, slotVars(upcoming[k - 1], OVERLAY_SLOTS[k].prefix, tz));
  out.channel = ch.name ?? "";
  out.number = ch.number ?? "";
  return out;
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

// ---- pictures picked by the schedule ---------------------------------------------
// A `match:` source names a file in the pictures folder by a template, e.g.
// `match:{{next_show}}` or `match:logos/{{show}}`. Names match loosely (capitals,
// punctuation, spaces / underscores and the extension don't matter), so
// "Hey Dude" finds "hey dude.png" or "Hey_Dude.jpg".
export const MATCH_PREFIX = "match:";
export const PICTURE_EXT = ["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp"];
export const MOTION_EXT = ["mp4", "mov", "webm", "mkv", "m4v"];
let PICTURES_DIR = "";
/** Where `match:` sources look (the server sets it from its settings). */
export const setOverlayPicturesDir = (dir: string) => { PICTURES_DIR = dir; };
export const overlayPicturesDirInUse = () => PICTURES_DIR;

/** A source with its schedule template filled in (only `match:` sources have one).
 *  Slashes in the values are dropped, so a title can't point into another folder. */
export function resolveSrc(src: string | undefined, v: OverlayVars): string {
  if (!src || !src.startsWith(MATCH_PREFIX)) return src ?? "";
  const tpl = src.slice(MATCH_PREFIX.length);
  // a detail with no value (nothing after the last show in the guide): pick nothing
  for (const m of tpl.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)) if (!String(v[m[1].toLowerCase()] ?? "").trim()) return MATCH_PREFIX;
  const safe = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x).replace(/[\\/]+/g, " ")]));
  return MATCH_PREFIX + fillTemplate(tpl, safe).trim();
}

/** How names compare: lower case, "&" as "and", letters and digits only. */
export const pictureKey = (s: string) => s.toLowerCase().replace(/&/g, "and").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");
const listings = new Map<string, { at: number; files: string[] }>();
/** The file in the pictures folder whose name matches (blank if none). */
export function findPicture(name: string, kind: "image" | "video" = "image", dir = PICTURES_DIR): string {
  if (!dir || !name.trim()) return "";
  // "logos/Rugrats": a sub-folder, then the name (".." never leaves the folder)
  const parts = name.replace(/\\/g, "/").split("/").map((p) => p.trim()).filter((p) => p && p !== "." && p !== "..");
  const want = parts.pop() ?? "";
  if (!want) return "";
  const folder = join(dir, ...parts);
  let ls = listings.get(folder);
  if (!ls || Date.now() - ls.at > 5000) {
    let files: string[] = [];
    try { files = readdirSync(folder, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name); } catch { /* no folder */ }
    ls = { at: Date.now(), files };
    listings.set(folder, ls);
  }
  const exts = kind === "video" ? MOTION_EXT : PICTURE_EXT;
  const usable = ls.files.filter((f) => exts.includes(f.split(".").pop()!.toLowerCase()));
  const stem = (f: string) => f.replace(/\.[^.]+$/, "");
  const lower = want.toLowerCase();
  const pick = usable.find((f) => f.toLowerCase() === lower)                      // "Rugrats.png" as typed
    ?? usable.find((f) => stem(f).toLowerCase() === lower)                         // any extension
    ?? usable.find((f) => pictureKey(stem(f)) === pictureKey(want))                // loosely: "hey_dude" = "Hey Dude!"
    ?? usable.find((f) => pictureKey(stem(f)).replace(/^the/, "") === pictureKey(want).replace(/^the/, "")); // with or without "The"
  return pick && pictureKey(want) ? join(folder, pick) : "";
}

/** An asset reference (a file in the overlays' asset folder, or an absolute path).
 *  A `match:` source must already be resolved (resolveSrc). */
export function assetPath(src: string, assetsDir: string, channelLogo?: string, kind: "image" | "video" = "image"): string {
  if (!src) return "";
  if (src === CHANNEL_LOGO) return channelLogo ?? "";
  if (src.startsWith(MATCH_PREFIX)) return findPicture(src.slice(MATCH_PREFIX.length), kind);
  if (src.startsWith("example:")) return EXAMPLES_DIR ? join(EXAMPLES_DIR, basename(src.slice(8))) : "";
  return isAbsolute(src) ? src : join(assetsDir, basename(src));
}

/** What makes an overlay's drawing differ between programmes: its texts and the
 *  pictures its `match:` layers pick. */
function drawnKey(o: Overlay, v: OverlayVars): string[] {
  return o.layers.map((l) => (l.type === "text" ? fillTemplate(l.text, v)
    : (l.type === "image" || l.type === "video") && (l.src.startsWith(MATCH_PREFIX) || l.fallback?.startsWith(MATCH_PREFIX)) ? `${resolveSrc(l.src, v)}|${resolveSrc(l.fallback, v)}` : ""));
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
export function overlaySvg(o: Overlay, v: OverlayVars, readAsset: (src: string, quiet?: boolean) => { data: string; mime: string } | null,
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
      let fill = esc(l.color || "#000000");
      if (l.gradient?.to) {
        const fade = l.gradient.to === "transparent", down = l.gradient.dir === "down";
        defs += `<linearGradient id="g${i}" x1="0" y1="0" x2="${down ? 0 : 1}" y2="${down ? 1 : 0}"><stop offset="0" stop-color="${fill}"/><stop offset="1" stop-color="${fade ? fill : esc(l.gradient.to)}" stop-opacity="${fade ? 0 : 1}"/></linearGradient>`;
        fill = `url(#g${i})`;
      }
      el = `<rect x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" rx="${num(l.radius, 0)}" fill="${fill}"${bw > 0 ? ` stroke="${esc(l.border || "#ffffff")}" stroke-width="${bw}"` : ""}${op}/>`;
    } else if (l.type === "image") {
      // a picture picked by the schedule, else its fallback (quiet: a miss with a fallback isn't a problem)
      const a = readAsset(resolveSrc(l.src, v), !!l.fallback) ?? (l.fallback ? readAsset(resolveSrc(l.fallback, v)) : null);
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
let RenderAsync: ((svg: string, opts: object) => Promise<{ asPng(): Uint8Array }>) | null = null;
async function resvg(): Promise<any | null> {
  if (Resvg !== undefined) return Resvg;
  try { const m = await import("@resvg/resvg-js"); Resvg = m.Resvg; RenderAsync = (m as any).renderAsync ?? null; } catch { Resvg = null; }
  return Resvg;
}
/** Rasterize an overlay SVG to PNG (null if the rasterizer isn't installed). */
export async function rasterize(svg: string): Promise<Buffer | null> {
  const R = await resvg();
  if (!R) return null;
  const opts = { font: fontOptions(svg), background: "rgba(0,0,0,0)" };
  if (RenderAsync) return Buffer.from((await RenderAsync(svg, opts)).asPng());
  return Buffer.from(new R(svg, opts).render().asPng());
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
  for (const d of dirs) scanFonts(d, 0);
  return FONTS;
}
function scanFonts(d: string, depth: number) {
  let names: string[] = [];
  try { names = readdirSync(d); } catch { return; }
  for (const n of names) {
    const p = join(d, n);
    if (/\.(ttf|otf)$/i.test(n)) {
      for (const fam of fontFamilies(p)) { const k = fam.toLowerCase(); const list = FONTS!.get(k) ?? []; if (!list.includes(p)) list.push(p); FONTS!.set(k, list); }
    } else if (depth < 4 && !n.includes(".")) scanFonts(p, depth + 1);
  }
}
const extraFontDirs = new Set<string>();
/** Make a folder's fonts available to drawings (legacy text elements' include_fonts_from). */
export function addFontDir(dir: string): void {
  fontIndex();
  const k = dir.replace(/\\/g, "/").toLowerCase();
  if (extraFontDirs.has(k)) return;
  extraFontDirs.add(k);
  scanFonts(dir, 0);
}
/** The drawn (ink) box of an SVG, with the same fonts as rasterize — to measure text. */
export async function svgBBox(svg: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const R = await resvg();
  if (!R) return null;
  try { const b = new R(svg, { font: fontOptions(svg) }).getBBox(); return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null; } catch { return null; }
}
/** How a Windows-style family name ("Montserrat ExtraBold") is asked for by
 *  typographic family and weight ("Montserrat", 800), as the renderer matches fonts. */
export function fontAlias(name: string): { family: string; weight?: number; italic?: boolean } {
  const files = fontIndex().get(name.trim().toLowerCase());
  if (!files?.length) return { family: name };
  const n = fontNames(files[0]);
  if (!n[16] || n[16].toLowerCase() === name.trim().toLowerCase()) return { family: name };
  const sub = (n[17] || n[2] || "").toLowerCase().replace(/\s+/g, "");
  const WEIGHTS: [RegExp, number][] = [[/thin|hairline/, 100], [/extralight|ultralight/, 200], [/semilight|demilight/, 350], [/light/, 300], [/medium/, 500], [/semibold|demibold/, 600], [/extrabold|ultrabold/, 800], [/black|heavy/, 900], [/bold/, 700]];
  const w = WEIGHTS.find(([re]) => re.test(sub))?.[1];
  return { family: n[16], ...(w ? { weight: w } : {}), ...(/italic|oblique/.test(sub) ? { italic: true } : {}) };
}
/** A font file's name table entries 1, 2, 16 and 17 (family, style, typographic family / style). */
function fontNames(file: string): Record<number, string> {
  const out: Record<number, string> = {};
  try {
    const fd = openSync(file, "r");
    try {
      const head = Buffer.alloc(12 + 16 * 64);
      readSync(fd, head, 0, head.length, 0);
      const n = head.readUInt16BE(4);
      let off = 0, len = 0;
      for (let i = 0; i < Math.min(n, 64); i++) if (head.toString("latin1", 12 + i * 16, 16 + i * 16) === "name") { off = head.readUInt32BE(20 + i * 16); len = head.readUInt32BE(24 + i * 16); }
      if (!off || len > 1_000_000) return out;
      const t = Buffer.alloc(len);
      readSync(fd, t, 0, len, off);
      const count = t.readUInt16BE(2), strings = t.readUInt16BE(4);
      for (let i = 0; i < count; i++) {
        const r = 6 + i * 12;
        const platform = t.readUInt16BE(r), id = t.readUInt16BE(r + 6), l = t.readUInt16BE(r + 8), o = t.readUInt16BE(r + 10);
        if (![1, 2, 16, 17].includes(id) || (out[id] && platform !== 3)) continue;
        const raw = t.subarray(strings + o, strings + o + l);
        const s = (platform === 3 || platform === 0 ? Buffer.from(raw).swap16().toString("utf16le") : raw.toString("latin1")).trim();
        if (s) out[id] = s;
      }
    } finally { closeSync(fd); }
  } catch { /* unreadable */ }
  return out;
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
  if (t.mode === "media") {
    // the item is the file itself: N seconds into it (applyOverlays checks the file)
    const off = Math.max(0, num(t.offsetSeconds, 0)) * 1000;
    if (startMs + off >= endMs) return null;
    return { timing: { timing_type: "periodic", clock: "content", frequency_ms: 86_400_000, hold_ms: hold, fade_ms: fade, phase_offset_ms: Math.round(off) } };
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
  const timed = isTimed(o); // the clip holds the whole appearance: no still in between
  const hold = (phase: number, len: number, freq: number): PeriodicTiming | null =>
    len > 0 && !timed ? { timing_type: "periodic", clock: "content", frequency_ms: freq, hold_ms: Math.round(len), fade_ms: CUT_FADE_MS, phase_offset_ms: Math.round(((phase % freq) + freq) % freq) } : null;
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
  if (t.mode === "media") {
    const off = Math.max(0, num(t.offsetSeconds, 0)) * 1000;
    if (startMs + off >= endMs) return null;
    return { offset: off, hold: hold(off + inMs, len, DAY) };
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

/** The show details a set of layers uses (so a live layer's address carries only those). */
function usedVars(layers: OverlayLayer[], v: OverlayVars): OverlayVars {
  const out: OverlayVars = {};
  for (const l of layers) {
    const strs = l.type === "text" ? [l.text] : l.type === "image" || l.type === "video" ? [l.src, l.fallback ?? ""] : [];
    for (const str of strs) for (const m of String(str).matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)) { const k = m[1].toLowerCase(); if (v[k] != null) out[k] = v[k]; }
  }
  return out;
}

/** An overlay drawn live: next graphics layers for one appearance (overlay-level
 *  timing `base`). Neighbouring layers with the same time on screen share a PNG. */
function liveLayers(o: Overlay, v: OverlayVars, base: PeriodicTiming, opts: OverlayBuildOptions): GraphicsLayer[] {
  const showMs = Math.max(1, num(o.timing?.showSeconds, 10)) * 1000;
  const W = opts.output?.w ?? 1920, H = opts.output?.h ?? 1080;
  const wall = base.clock === "wall";
  const common = {
    ...(o.opacity != null && o.opacity < 100 ? { opacity_percent: Math.max(0, o.opacity) } : {}),
    ...(o.withinContent ? { within_source_content: true } : {}),
  };
  const timingFor = (l: OverlayLayer) => {
    const w = layerWindow(l, showMs);
    const start = Math.min(w.end, w.start + Math.max(0, num(l.anim?.in?.delay, 0)) * 1000), len = w.end - start;
    if (len <= 0) return null;
    const fade = Math.max(20, Math.min(liveFadeMs(l, o.fadeSeconds), len / 3));
    let phase = (base.phase_offset_ms ?? 0) + start;
    if (wall) phase = ((phase % base.frequency_ms) + base.frequency_ms) % base.frequency_ms;
    return { timing_type: "periodic" as const, clock: base.clock, frequency_ms: base.frequency_ms, phase_offset_ms: Math.round(phase), hold_ms: Math.round(len - 2 * fade), fade_ms: Math.round(fade) };
  };
  const out: GraphicsLayer[] = [];
  let run: { idx: number[]; timing: ReturnType<typeof timingFor> & object; key: string } | null = null;
  const flush = () => {
    if (!run) return;
    // inside the picture: next places a layer by percentages of the picture, so a
    // full-frame PNG would be shifted (off-screen on a pillarboxed show), not scaled.
    // Draw just the layers' box instead and place that.
    const box = o.withinContent ? stillBox(run.idx.map((i) => o.layers[i])) : null;
    const pw = box ? Math.max(2, Math.round((box.w * W) / ARTBOARD.w)) : W, ph = box ? Math.max(2, Math.round((box.h * H) / ARTBOARD.h)) : H;
    const q = new URLSearchParams({ o: o.liveId ?? o.id, l: run.idx.join(","), w: String(pw), h: String(ph),
      ...(box ? { b: [box.x, box.y, box.w, box.h].join(",") } : {}),
      ...(opts.channelName ? { c: opts.channelName } : {}),
      d: Buffer.from(JSON.stringify(usedVars(run.idx.map((i) => o.layers[i]), v))).toString("base64url") });
    out.push({ kind: "media", location: "top_left", ...(box ? placement(box) : {}),
      source: { source_type: "http", uri: `${opts.liveBase!.replace(/\/+$/, "")}/graphics/overlay.png?${q}`, reconnect: true,
        probe_hint: { format_name: "png_pipe", video: [{ stream_index: 0, codec: "png", width: pw, height: ph, pix_fmt: "rgba" }] } },
      timing: run.timing, ...common } as GraphicsLayer);
    run = null;
  };
  o.layers.forEach((l, i) => {
    const t = timingFor(l);
    if (!t) return;
    if (l.type === "video") {
      flush();
      const want = resolveSrc(l.src, v);
      const p = assetPath(want, opts.assetsDir, opts.channelLogo, "video") || assetPath(resolveSrc(l.fallback, v), opts.assetsDir, opts.channelLogo, "video");
      if (p && existsSync(p)) out.push({ source: { source_type: "local", path: p }, ...placement(l), kind: "media", timing: t, ...common } as GraphicsLayer);
      return;
    }
    const key = JSON.stringify(t);
    if (run && run.key === key) run.idx.push(i);
    else { flush(); run = { idx: [i], timing: t, key }; }
  });
  flush();
  return out;
}

/** A file path compared the way the file system does (Windows: any case, either slash). */
const mediaKey = (p: string) => (/^[A-Za-z]:|\\/.test(p) ? p.replace(/\\/g, "/").toLowerCase() : p);

/** Frames that would draw the same picture share a key (rounded to 1/100). */
const stateKey = (states: LayerState[]) => JSON.stringify(states.map((st) => [st.opacity, st.dx, st.dy, st.scale, st.clip, st.chars].map((n) => (typeof n === "number" ? Math.round(n * 100) / 100 : n))));

/** An overlay whose layers have their own times on screen (only overlays that come
 *  and go: "always on" has no appearance to time them in). Built as one clip. */
export const isTimed = (o: Overlay) => (o.timing?.mode ?? "always") !== "always" && hasLayerTiming(o.layers);

/** The overlay's transition clip for these template values (cached by content):
 *  the file, and where it sits in output pixels. */
async function animatedClip(o: Overlay, v: OverlayVars, readAsset: (src: string, quiet?: boolean) => { data: string; mime: string } | null, opts: OverlayBuildOptions,
  problems: string[]): Promise<{ file: string; origin: { x: number; y: number }; made?: boolean } | null> {
  const out = opts.output!, t = o.timing ?? { mode: "always" };
  const sx = out.w / ARTBOARD.w, sy = out.h / ARTBOARD.h;
  const { inMs, outMs } = animLengths(o.layers);
  const showMs = Math.max(1, num(t.showSeconds, 10)) * 1000;
  const mode = t.mode || "always";
  const freq = Math.max(1, num(t.everyMinutes, 15)) * 60_000;

  // one appearance's frames, as times from its start (ms) and the layers' states
  const nIn = Math.ceil(inMs / STEP), nOut = Math.ceil(outMs / STEP);
  const app: { t: number; states: LayerState[] | null }[] = [];
  if (isTimed(o)) {
    // layers with their own time on screen: the whole appearance is in the clip
    // (nothing is held as a still), one frame per change
    const fade = isAnimated(o.layers) ? null : o.fadeSeconds;
    let prev = "";
    for (let tt = 0; tt < showMs; tt += STEP) {
      const env = fade === null ? 1 : fadeAt(tt, showMs, fade);
      const states = o.layers.map((l) => { const s = layerStateAt(l, tt, showMs, outMs); return env < 1 ? { ...s, opacity: s.opacity * env } : s; });
      const k = stateKey(states);
      if (k !== prev) { app.push({ t: tt, states }); prev = k; }
    }
    app.push({ t: showMs, states: null });
  } else {
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

  const texts = drawnKey(o, v);
  const key = createHash("sha1").update(JSON.stringify({ layers: o.layers, texts, mode, freq, showMs, out, fps: CLIP_FPS, v: 1, ...(isTimed(o) ? { timed: true, fade: o.fadeSeconds ?? 1 } : {}) })).digest("hex");
  const file = join(opts.cacheDir, `${key}.mkv`);
  if (existsSync(file)) { try { const now = new Date(); utimesSync(file, now, now); } catch { /* ignore */ } return { file, origin: { x: ox, y: oy } }; }

  // render each distinct frame once
  const tmp = join(opts.cacheDir, `tmp-${key}`);
  await mkdir(tmp, { recursive: true });
  // each distinct frame drawn once; frames draw at the same time (resvg's threads)
  const pngs = new Map<string, Promise<string | null>>();
  let nFrame = 0;
  const frameFile = (states: LayerState[] | null): Promise<string | null> => {
    const k = states ? stateKey(states) : "blank";
    const have = pngs.get(k);
    if (have) return have;
    const job = (async () => {
      const svg = states ? overlaySvg(o, v, readAsset, { states, view, px: { w: pw, h: ph } })?.svg
        : `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}"/>`;
      const png = svg ? await rasterize(svg) : null;
      if (!png) return null;
      const p = join(tmp, `f${String(nFrame++).padStart(4, "0")}.png`);
      await writeFile(p, png);
      return p;
    })();
    pngs.set(k, job);
    return job;
  };
  const appearances = mode === "every" ? Math.min(400, Math.ceil((6 * 3_600_000) / freq) + 2) : 1;
  const frames: { t: number; file: string }[] = [];
  const blank = await frameFile(null);
  if (!blank) { problems.push("animated overlays need the SVG rasterizer (@resvg/resvg-js) — run npm install"); return null; }
  frames.push({ t: 0, file: blank });
  const drawn = await Promise.all(app.map(async (f) => ({ t: f.t, file: f.states ? await frameFile(f.states) : blank })));
  const rendered = drawn.filter((f): f is { t: number; file: string } => !!f.file);
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
  return { file, origin: { x: ox, y: oy }, made: true };
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
  /** progress lines for the build log ("overlays: 12 of 40 animated clips ready…") */
  report?: (msg: string) => void,
  /** library details for a file (legacy graphics elements' MediaItem_* variables) */
  itemInfo?: (path: string) => LegacyItemData | null,
): Promise<OverlayResult> {
  const out: OverlayResult = { items: 0, rendered: 0, problems: [] };
  // overlays set off by one file: on every channel, wherever that file airs
  const byMedia = new Map<string, string[]>();
  for (const o of opts.library) {
    if (o.timing?.mode !== "media" || !o.timing.media?.path) continue;
    const k = mediaKey(o.timing.media.path);
    byMedia.set(k, [...(byMedia.get(k) ?? []), o.id]);
  }
  if (!refs.size && !byMedia.size) return out;
  await resvg();
  const lib = new Map<string, Overlay>();
  for (const o of opts.library) { lib.set(o.id, o); if (!lib.has(o.name.toLowerCase())) lib.set(o.name.toLowerCase(), o); }
  // legacy elements also answer to the file name legacy used ("image/cn_city.yml")
  for (const o of opts.library) if (o.legacy?.file) { const k = `legacy:${legacyRef(o.legacy.file)}`; if (!lib.has(k)) lib.set(k, o); }
  const find = (ref: string): Overlay | null => lib.get(ref) ?? lib.get(ref.toLowerCase()) ?? lib.get(`legacy:${legacyRef(ref)}`)
    ?? (IMAGE_FILE.test(ref) && existsSync(ref) ? adHocOverlay(ref) : null);
  const infoCache = new Map<string, LegacyItemData | null>();
  const info = (p: string) => { if (!infoCache.has(p)) { let d: LegacyItemData | null = null; try { d = itemInfo?.(p) ?? null; } catch { /* no library */ } infoCache.set(p, d); } return infoCache.get(p)!; };
  const ffprobe = opts.ffmpeg ? opts.ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace(/ffmpeg/i, "ffprobe")) : "ffprobe";
  const g = guide.slice().sort((a, b) => a.startMs - b.startMs);
  // guide times keep fractions of a millisecond; item times are written to whole
  // ms, so a show starting as the last one ends can look a hair inside it
  const SLACK_MS = 5;
  const missing = new Set<string>();
  const assets = new Map<string, { data: string; mime: string } | null>();
  if (opts.picturesDir) setOverlayPicturesDir(opts.picturesDir);
  // names `match:` layers looked for and didn't find (reported once, at the end)
  const unmatched = new Set<string>();
  const readAsset = (src: string, quiet = false) => {
    const p = assetPath(src, opts.assetsDir, opts.channelLogo);
    if (!p) {
      if (src.startsWith(MATCH_PREFIX)) { if (!quiet && src.length > MATCH_PREFIX.length) unmatched.add(src.slice(MATCH_PREFIX.length)); }
      else out.problems.push("the channel has no logo file for its logo overlay");
      return null;
    }
    if (!assets.has(p)) {
      try { assets.set(p, { data: readFileSync(p).toString("base64"), mime: MIME[p.split(".").pop()!.toLowerCase()] ?? "image/png" }); }
      catch { assets.set(p, null); out.problems.push(`image ${src} isn't readable`); }
    }
    return assets.get(p)!;
  };
  // rendered stills, by overlay + resolved text (a show's strap renders once per build)
  const stills = new Map<string, Promise<{ file: string; box: Box } | null>>();
  await mkdir(opts.cacheDir, { recursive: true });
  const still = (o: Overlay, v: OverlayVars): Promise<{ file: string; box: Box } | null> => {
    const key = `${JSON.stringify(o.layers)}|${JSON.stringify(drawnKey(o, v))}`;
    const have = stills.get(key);
    if (have) return have;
    const job = renderStill(o, v);
    stills.set(key, job);
    return job;
  };
  const renderStill = async (o: Overlay, v: OverlayVars): Promise<{ file: string; box: Box } | null> => {
    let r: { file: string; box: Box } | null = null;
    const only = o.layers.length === 1 && o.layers[0].type === "image" ? o.layers[0] : null;
    if (only) {
      // a lone image plays straight from its file (keeps animated GIFs moving),
      // scaled down first when it's far bigger than it shows on screen
      const want = resolveSrc(only.src, v), alt = resolveSrc(only.fallback, v);
      let p = assetPath(want, opts.assetsDir, opts.channelLogo);
      if (!p && alt) p = assetPath(alt, opts.assetsDir, opts.channelLogo);
      if (!p && want.startsWith(MATCH_PREFIX)) {
        // nothing picked for this programme: no picture this time (not a problem with the
        // overlay). With a fallback, only the fallback's own trouble is worth saying.
        if (!alt) { if (want.length > MATCH_PREFIX.length) unmatched.add(want.slice(MATCH_PREFIX.length)); }
        else if (alt === CHANNEL_LOGO) out.problems.push("the channel has no logo file for its logo overlay");
      } else if (p && existsSync(p)) {
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
    return r;
  };

  // animated clips: one per distinct drawing, several at once (each encodes in its
  // own ffmpeg), with progress lines while they're made
  const CLIP_JOBS = Math.max(1, Math.min(6, (cpus()?.length ?? 2) - 1));
  let active = 0;
  const waiting: (() => void)[] = [];
  const slot = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= CLIP_JOBS) await new Promise<void>((go) => waiting.push(go));
    active++;
    try { return await fn(); } finally { active--; waiting.shift()?.(); }
  };
  const clips = new Map<string, Promise<{ file: string; origin: { x: number; y: number }; made?: boolean } | null>>();
  let clipsDone = 0, clipsMade = 0, lastReport = 0;
  const t0 = Date.now();
  const progress = () => {
    if (!report) return;
    const now = Date.now();
    if (now - lastReport < 5000 && clipsDone < clips.size) return;
    lastReport = now;
    if (clipsDone < clips.size) report(`overlays: ${clipsDone} of ${clips.size} animated overlay clips ready (${clipsMade} newly drawn, ${CLIP_JOBS} at a time)…`);
  };
  const clipFor = (o: Overlay, v: OverlayVars) => {
    const k = `${o.id}|${JSON.stringify(o.layers)}|${JSON.stringify(drawnKey(o, v))}`;
    let job = clips.get(k);
    if (!job) {
      if (!clips.size) report?.(`overlays: preparing animated overlay clips (${CLIP_JOBS} at a time)…`);
      job = slot(() => animatedClip(o, v, readAsset, opts, out.problems)).then((r) => { clipsDone++; if (r?.made) clipsMade++; progress(); return r; });
      clips.set(k, job);
    }
    return job;
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
  const jobs: Promise<void>[] = [];
  for (const item of items) {
    const path = (item.source as { path?: string } | undefined)?.path;
    const ids = [...(refs.get(item.id) ?? []), ...(path ? byMedia.get(mediaKey(path)) ?? [] : [])];
    if (!ids.length) continue;
    const s = Date.parse(item.start), f = Date.parse(item.finish);
    while (gi < g.length && g[gi].stopMs <= s + SLACK_MS) gi++;
    const cur = gi < g.length && g[gi].startMs <= s + SLACK_MS ? g[gi] : undefined;
    const n0 = cur ? gi + 1 : gi;
    const next = Array.from({ length: UPCOMING_FIELDS }, (_, k) => g[n0 + k]);
    const filler = !!labels[item.id]?.fillerKind;
    jobs.push((async () => {
    const layers: GraphicsLayer[] = [];
    const legacyZ: { z: number; layer: GraphicsLayer }[] = []; // legacy elements, stacked by z_index at the end
    let vars: OverlayVars | null = null;
    for (const ref of [...new Set(ids)]) {
      const o = find(ref);
      if (!o) { missing.add(ref); continue; }
      if (o.timing?.mode === "media") {
        // only over its own file (a channel can list it too; it still waits for the file), filler or not
        if (!path || !o.timing.media?.path || mediaKey(path) !== mediaKey(o.timing.media.path)) continue;
      } else if (filler && !o.duringFiller) continue;
      if (!inSeason(o.season, s, tz)) continue;
      // a legacy graphics element: filled in for this item, as legacy did
      if (o.legacy) {
        const got = await legacyLayers(o.legacy, { path: path ?? "", startMs: s, stopMs: f, tz, info, guide: g, output: opts.output ?? { w: 1920, h: 1080 } },
          { cacheDir: opts.cacheDir, ffprobe, problems: out.problems });
        if (got.length) {
          legacyZ.push(...got);
          const first = got[0].layer.timing;
          note(item.id, o.id, first ? (first.clock === "content" ? first.phase_offset_ms ?? 0 : 0) : 0);
        }
        continue;
      }
      const progSpan = cur ? (span.get(cur) ?? cur) : undefined;
      // drawn live: a PNG per run of layers that share a time on screen, fetched from
      // this scheduler as it airs; next fades each one itself (no pre-render)
      if ((isAnimated(o.layers) || isTimed(o)) && drawsLive(o) && opts.liveBase) {
        const t = overlayTiming(o, s, f, progSpan);
        if (!t) continue;
        if (t.timing) {
          vars ??= overlayVars(cur, next, tz, { name: opts.channelName, number: opts.channelNumber });
          const live = liveLayers(o, vars, t.timing, opts);
          if (live.length) {
            layers.push(...live);
            note(item.id, o.id, t.timing.clock === "content" ? t.timing.phase_offset_ms ?? 0
              : (((t.timing.phase_offset_ms ?? 0) - s) % t.timing.frequency_ms + t.timing.frequency_ms) % t.timing.frequency_ms);
          }
          continue;
        }
      }
      // animated: the transition clip (canvas) + the held still between transitions
      if ((isAnimated(o.layers) || isTimed(o)) && !o.anchor && opts.ffmpeg && opts.output) {
        const plan = animPlan(o, s, f, progSpan);
        if (!plan) continue;
        vars ??= overlayVars(cur, next, tz, { name: opts.channelName, number: opts.channelNumber });
        const clip = await clipFor(o, vars);
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
        const want = resolveSrc(l.src, vars);
        const p = assetPath(want, opts.assetsDir, opts.channelLogo, "video") || assetPath(resolveSrc(l.fallback, vars), opts.assetsDir, opts.channelLogo, "video");
        if (!p && want.startsWith(MATCH_PREFIX)) { if (want.length > MATCH_PREFIX.length) unmatched.add(want.slice(MATCH_PREFIX.length)); continue; }
        if (!existsSync(p)) { out.problems.push(`video ${l.src} isn't on this machine`); continue; }
        layers.push({ source: { source_type: "local", path: p }, ...placement(l), ...common } as GraphicsLayer);
      }
    }
    // next draws later layers on top: legacy elements by z_index, lowest first
    if (legacyZ.length) layers.push(...legacyZ.sort((a, b) => a.z - b.z).map((x) => x.layer));
    if (layers.length) { item.graphics = [...layers, ...(item.graphics ?? [])]; out.items++; }
    })());
  }
  await Promise.all(jobs);
  if (clips.size) report?.(`overlays: ${clips.size} animated overlay clip${clips.size === 1 ? "" : "s"} ready — ${clipsMade} newly drawn, ${clips.size - clipsMade} reused — in ${Math.round((Date.now() - t0) / 100) / 10} s`);
  for (const m of missing) out.problems.push(`overlay "${m}" isn't in the overlay library`);
  if (unmatched.size) {
    const names = [...unmatched].sort((a, b) => a.localeCompare(b));
    out.problems.push(`no picture in the overlay pictures folder matched ${names.slice(0, 8).map((n) => `"${n}"`).join(", ")}${names.length > 8 ? ` and ${names.length - 8} more` : ""} — add pictures with those names (Overlays → Pictures), or give the layer a fallback`);
  }
  out.problems = [...new Set(out.problems)];
  return out;
}
