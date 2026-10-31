// -----------------------------------------------------------------------------
// TV-guide "scroller" channel — data + themed SVG rendering.
// -----------------------------------------------------------------------------
// Reads every channel's XMLTV guide (the files the scheduler writes to
// {runtime}/xmltv/<tvgId>.xml) and lays out a classic scrolling grid: channels
// down the side, a continuous half-hour timeline across. Each programme is one
// block sized by its real duration (so a two-hour movie is one wide block, not
// four separate half-hour cells) with continuation chevrons when it runs off the
// left/right edge — exactly like a 1990s cable listings channel. Movies get a
// taller block with the rating, year and synopsis. The CLI (`guide-stream`)
// rasterizes these SVGs to PNGs and has ffmpeg scroll the tall grid under a fixed
// header (a rotating "featured" panel, a promo/trailer window, a live clock and
// the time bar) with background music. Themes are JSON files in
// {runtime}/guide-themes/<id>.json (seeded with the built-ins below), so the look
// is editable and extensible without a rebuild.

import { readFile, readdir, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { parseXmltvTime } from "./xmltv.js";
import { localParts, localWeekday, type Tz } from "./time.js";

export interface GuideChannel { number: string; name: string; tvgId: string }

/** One programme, with the extra metadata we pull from the enriched XMLTV. */
export interface GuideProgram {
  startMs: number; stopMs: number; title: string;
  category?: string; rating?: string; year?: string; desc?: string;
  cast?: string; subTitle?: string; icon?: string;
}
export interface GuideRow { number: string; name: string; programs: GuideProgram[] }

/** Buckets used for classic color-coding, matched from XMLTV <category> text. */
export type CategoryKey = "movie" | "sports" | "news" | "kids" | "default";
export function categoryKey(cat: string | undefined): CategoryKey {
  const c = String(cat ?? "").toLowerCase();
  if (!c) return "default";
  if (/(movie|film|feature)/.test(c)) return "movie";
  if (/(sport|football|baseball|basketball|hockey|soccer|wrestl|boxing|racing)/.test(c)) return "sports";
  if (/(news|weather)/.test(c)) return "news";
  if (/(child|kids|family|cartoon|animation|animated)/.test(c)) return "kids";
  return "default";
}

/** Fixed render geometry (from config); the theme controls sizes + colors. */
export interface GuideLayout { width: number; height: number; columns: number; slotMinutes: number }
export const DEFAULT_GUIDE_LAYOUT: Omit<GuideLayout, "columns"> = { width: 1920, height: 1080, slotMinutes: 30 };

export interface GuideTheme {
  label: string;
  rowHeight: number; headerHeight: number; leftWidth: number;
  bg: string; header: string; headerText: string; accent: string;
  rowA: string; rowB: string; grid: string;
  chan: string; chNum: string; title: string; empty: string;
  clockColor: string; dateColor: string;
  fontFile?: string; // optional per-theme TTF (e.g. a pixel font); falls back to the global font
  categoryColors?: Record<CategoryKey, string>; // cell background per category ("" = use row bg)
  // realistic "cable guide" layout: a top promo/info area + a time bar above the grid
  promoHeight?: number;    // height of the top promo/info area (px)
  timeBarHeight?: number;  // height of the time-column bar (px)
  promoBg?: string;        // video/promo box fill
  promoText?: string;      // dummy promo text color
  infoText?: string;       // info-panel text color
  timeCell?: string;       // time-bar cell base color
  bevel?: number;          // bevel edge thickness in px (0 = flat)
  movieRowHeight?: number; // taller row height used when a row is showing a movie
}

/** Resolve the fixed top area heights (promo + time bar) for a theme/frame. */
export function guidePromoHeight(theme: GuideTheme, frameHeight: number): number {
  return theme.promoHeight ?? Math.round(frameHeight * 0.46);
}
export function guideTimeBarHeight(theme: GuideTheme): number { return theme.timeBarHeight ?? 70; }
export function guideHeaderHeight(theme: GuideTheme, frameHeight: number): number {
  return guidePromoHeight(theme, frameHeight) + guideTimeBarHeight(theme);
}
/** Screen rectangle of the promo/trailer window (top-right, ~4:3). Shared by the
 *  header SVG (which draws the frame) and the CLI (which overlays a video here). */
export function guidePromoBox(layout: GuideLayout, theme: GuideTheme): { x: number; y: number; w: number; h: number } {
  const promoH = guidePromoHeight(theme, layout.height);
  const pad = 60;
  const h = promoH - pad * 2;
  const w = Math.round((h * 4) / 3);
  return { x: layout.width - pad - w, y: pad, w, h };
}

/** Mix a #rrggbb color toward white (f>0) or black (f<0) by fraction |f|. */
function shade(hex: string, f: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return hex;
  let r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
  const t = f < 0 ? 0 : 255, a = Math.abs(f);
  r = Math.round(r + (t - r) * a); g = Math.round(g + (t - g) * a); b = Math.round(b + (t - b) * a);
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** A beveled ("outset") box: fill + light top/left edge + dark bottom/right edge. */
function bevel(x: number, y: number, w: number, h: number, fill: string, t: number): string {
  const light = shade(fill, 0.42), dark = shade(fill, -0.5);
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
  if (t > 0) {
    s += `<path d="M${x} ${y + h} L${x} ${y} L${x + w} ${y}" stroke="${light}" stroke-width="${t}" fill="none"/>`;
    s += `<path d="M${x + w} ${y} L${x + w} ${y + h} L${x} ${y + h}" stroke="${dark}" stroke-width="${t}" fill="none"/>`;
  }
  return s;
}

/** One or more ">"/"<" continuation chevrons, centered at (x,cy). */
function chevrons(x: number, cy: number, size: number, dir: "left" | "right", count: number, color: string): string {
  let s = "";
  const sw = Math.max(3, Math.round(size / 4));
  for (let i = 0; i < count; i++) {
    const bx = x + (dir === "right" ? i * size * 0.7 : -i * size * 0.7);
    const tip = dir === "right" ? bx + size / 2 : bx - size / 2;
    const back = dir === "right" ? bx - size / 2 : bx + size / 2;
    s += `<path d="M${back} ${cy - size} L${tip} ${cy} L${back} ${cy + size}" ` +
      `stroke="${color}" stroke-width="${sw}" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  return s;
}

/** A small MPAA/TV-style rating chip drawn to the right of a title. */
function ratingChip(x: number, cy: number, text: string, color: string, font: string): string {
  const t = String(text).toUpperCase();
  const w = 22 + t.length * 17, h = 34;
  const y = cy - h / 2;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="none" stroke="${color}" stroke-width="2.5"/>` +
    `<text x="${x + w / 2}" y="${y + h / 2 + 9}" font-size="24" font-weight="900" fill="${color}" text-anchor="middle" ${font}>${esc(t)}</text>`;
}

// --- built-in themes (seeded to disk; also the fallback if a file is bad) -----
export const DEFAULT_GUIDE_THEMES: Record<string, GuideTheme> = {
  classic: {
    label: "Classic (dark blue)",
    rowHeight: 108, headerHeight: 150, leftWidth: 420,
    bg: "#04070F", header: "#0A2A6B", headerText: "#DCE8FF", accent: "#F5A524",
    rowA: "#0E1524", rowB: "#131C30", grid: "#22304F",
    chan: "#FFFFFF", chNum: "#8FB6FF", title: "#EAF1FF", empty: "#5A6B8C",
    clockColor: "#FFFFFF", dateColor: "#B6C8F0",
    categoryColors: { movie: "#243B8C", sports: "#1E6B3A", news: "#8A2B2B", kids: "#6E2E86", default: "" },
  },
  // Evocation of a 1990s cable listings channel: royal-blue field, chunky rows,
  // yellow channel numbers + clock, white titles, teal time bar.
  cable: {
    label: "Retro Cable (blue/yellow)",
    rowHeight: 118, headerHeight: 630, leftWidth: 300,
    bg: "#0A1560", header: "#101C86", headerText: "#FFE24D", accent: "#FFD400",
    rowA: "#1B2A9E", rowB: "#152386", grid: "#3B4CC8",
    chan: "#FFFFFF", chNum: "#FFE24D", title: "#FFFFFF", empty: "#9AA6E0",
    clockColor: "#FFE24D", dateColor: "#FFFFFF",
    // Point fontFile at a pixel/bitmap TTF for the authentic old-guide text.
    fontFile: "",
    categoryColors: { movie: "#0E7C86", sports: "#1E7A3A", news: "#B0431F", kids: "#8A2E86", default: "" },
    promoHeight: 560, timeBarHeight: 70, bevel: 4, movieRowHeight: 250,
    promoBg: "#04093A", promoText: "#AEBCF0", infoText: "#FFFFFF", timeCell: "#1E8FA8",
  },
  // High-contrast neutral (accessible / minimalist).
  mono: {
    label: "Mono (high contrast)",
    rowHeight: 110, headerHeight: 150, leftWidth: 420,
    bg: "#000000", header: "#111111", headerText: "#FFFFFF", accent: "#FFFFFF",
    rowA: "#0B0B0B", rowB: "#151515", grid: "#333333",
    chan: "#FFFFFF", chNum: "#BBBBBB", title: "#FFFFFF", empty: "#666666",
    clockColor: "#FFFFFF", dateColor: "#BBBBBB",
    categoryColors: { movie: "#2A2A2A", sports: "#1E1E1E", news: "#333333", kids: "#262626", default: "" },
  },
  // Bright/light listings look.
  light: {
    label: "Light",
    rowHeight: 108, headerHeight: 150, leftWidth: 420,
    bg: "#EEF2F8", header: "#274690", headerText: "#FFFFFF", accent: "#E4572E",
    rowA: "#FFFFFF", rowB: "#E7ECF5", grid: "#C4CEE0",
    chan: "#12203A", chNum: "#274690", title: "#12203A", empty: "#8A97AE",
    clockColor: "#FFFFFF", dateColor: "#DCE4F5",
    categoryColors: { movie: "#DCE6FF", sports: "#DDF3E1", news: "#FBE3DA", kids: "#F3DEF0", default: "" },
  },
};

function esc(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function clip(s: string, max: number): string {
  const t = String(s ?? "");
  return t.length > max ? `${t.slice(0, Math.max(1, max - 1)).replace(/\s+$/, "")}…` : t;
}
/** Greedy word-wrap into at most `maxLines` lines of ~`maxChars` each (last line ellipsized). */
function wrapLines(s: string, maxChars: number, maxLines: number): string[] {
  const words = String(s ?? "").trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) { cur = w; continue; }
    if (cur.length + 1 + w.length <= maxChars) cur += " " + w;
    else { lines.push(cur); cur = w; if (lines.length === maxLines - 1) break; }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  // if we truncated, ellipsize the final line
  const usedWords = lines.join(" ").split(/\s+/).length;
  if (usedWords < words.length && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = clip(last + " …", maxChars);
  }
  return lines;
}

const DOW = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
function weekday(ms: number, tz: Tz): string { return DOW[localWeekday(ms, tz)]; }
function monthDay(ms: number, tz: Tz): string {
  const p = localParts(ms, tz);
  return `${MON[p.mo]} ${p.da}`;
}

/** 12-hour label for a column boundary, e.g. "1:30 PM". */
export function slotLabel(ms: number, tz: Tz): string {
  const p = localParts(ms, tz);
  const hh = Math.floor(p.msOfDay / 3_600_000);
  const mm = Math.floor((p.msOfDay % 3_600_000) / 60_000);
  const ap = hh >= 12 ? "PM" : "AM";
  let h = hh % 12; if (h === 0) h = 12;
  return `${h}:${String(mm).padStart(2, "0")} ${ap}`;
}
/** Compact 12-hour label without AM/PM, e.g. "8:05" (used inside movie blocks). */
function shortTime(ms: number, tz: Tz): string {
  const p = localParts(ms, tz);
  const hh = Math.floor(p.msOfDay / 3_600_000);
  const mm = Math.floor((p.msOfDay % 3_600_000) / 60_000);
  let h = hh % 12; if (h === 0) h = 12;
  return `${h}:${String(mm).padStart(2, "0")}`;
}
/** Floor an instant to the current slot boundary (in local time). */
export function slotFloor(nowMs: number, slotMinutes: number, tz: Tz): number {
  const slot = slotMinutes * 60_000;
  return nowMs - (localParts(nowMs, tz).msOfDay % slot);
}

const PROG_RE = /<programme\b[^>]*\bstart="(\d{14}[^"]*)"[^>]*\bstop="(\d{14}[^"]*)"[^>]*>([\s\S]*?)<\/programme>/g;
function decode(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function tag(inner: string, name: string): string | undefined {
  const m = inner.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`));
  return m ? decode(m[1]).trim() : undefined;
}
function parseProgramme(startStamp: string, stopStamp: string, inner: string, tz: Tz): GuideProgram {
  const rating = inner.match(/<rating\b[^>]*>[\s\S]*?<value\b[^>]*>([\s\S]*?)<\/value>/);
  const date = inner.match(/<date\b[^>]*>(\d{4})/);
  const iconM = inner.match(/<icon\b[^>]*\bsrc="([^"]+)"/);
  const actors = [...inner.matchAll(/<actor\b[^>]*>([\s\S]*?)<\/actor>/g)].map((m) => decode(m[1]).trim()).filter(Boolean);
  return {
    startMs: parseXmltvTime(startStamp, tz),
    stopMs: parseXmltvTime(stopStamp, tz),
    title: tag(inner, "title") ?? "",
    subTitle: tag(inner, "sub-title"),
    category: tag(inner, "category"),
    desc: tag(inner, "desc"),
    rating: rating ? decode(rating[1]).trim() : undefined,
    year: date ? date[1] : undefined,
    icon: iconM ? decode(iconM[1]).trim() : undefined,
    cast: actors.length ? actors.slice(0, 3).join(", ") : undefined,
  };
}
async function readProgrammes(xmltvPath: string, tz: Tz): Promise<GuideProgram[]> {
  let xml = "";
  try { xml = await readFile(xmltvPath, "utf8"); } catch { return []; }
  const out: GuideProgram[] = [];
  for (const m of xml.matchAll(PROG_RE)) out.push(parseProgramme(m[1], m[2], m[3], tz));
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

/** Build one grid row per channel: every programme overlapping the visible window. */
export async function readGuideRows(
  xmltvDir: string, channels: GuideChannel[], nowMs: number, columns: number, slotMinutes: number, tz: Tz,
): Promise<{ rows: GuideRow[]; colTimes: number[]; windowStart: number; windowEnd: number }> {
  const slot = slotMinutes * 60_000;
  const windowStart = slotFloor(nowMs, slotMinutes, tz);
  const windowEnd = windowStart + columns * slot;
  const colTimes = Array.from({ length: columns }, (_, c) => windowStart + c * slot);
  const rows: GuideRow[] = [];
  for (const ch of channels) {
    const progs = await readProgrammes(join(xmltvDir, `${ch.tvgId}.xml`), tz);
    const programs = progs.filter((p) => p.stopMs > windowStart && p.startMs < windowEnd);
    rows.push({ number: ch.number, name: ch.name, programs });
  }
  return { rows, colTimes, windowStart, windowEnd };
}

/** Read every channel's whole guide (not just the window) — used to pick random
 *  "featured" programmes for the rotating header panel. */
export async function readAllProgrammes(
  xmltvDir: string, channels: GuideChannel[], tz: Tz,
): Promise<{ channel: GuideChannel; prog: GuideProgram }[]> {
  const out: { channel: GuideChannel; prog: GuideProgram }[] = [];
  for (const ch of channels) {
    for (const prog of await readProgrammes(join(xmltvDir, `${ch.tvgId}.xml`), tz)) {
      if (prog.title) out.push({ channel: ch, prog });
    }
  }
  return out;
}

export interface FeaturedPick {
  title: string; channelNumber: string; channelName: string;
  day: string; time: string; category?: string; subTitle?: string;
  iconPath?: string;  // raw artwork ref from the guide (url or local path)
  iconData?: string;  // resolved data: URL (filled by the CLI) for the logo box
}
/** Pick up to `count` distinct featured programmes at/after `nowMs` (random). */
export function pickFeatured(
  all: { channel: GuideChannel; prog: GuideProgram }[], count: number, nowMs: number, tz: Tz,
): FeaturedPick[] {
  const future = all.filter((x) => x.prog.stopMs > nowMs);
  const pool = future.length ? future : all;
  // Fisher–Yates shuffle a shallow copy, then take the first `count` unique titles.
  const arr = pool.slice();
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  const picks: FeaturedPick[] = [];
  const seen = new Set<string>();
  for (const x of arr) {
    const key = `${x.channel.number}|${x.prog.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push({
      title: x.prog.title, channelNumber: x.channel.number, channelName: x.channel.name,
      day: weekday(x.prog.startMs, tz), time: slotLabel(x.prog.startMs, tz),
      category: x.prog.category, subTitle: x.prog.subTitle, iconPath: x.prog.icon,
    });
    if (picks.length >= count) break;
  }
  return picks;
}

const GRID_FONT = `font-family="Arial, Helvetica, sans-serif"`;

/** The programme airing at the window's left edge (or the first visible one). */
function currentProgram(row: GuideRow, windowStart: number): GuideProgram | undefined {
  return row.programs.find((p) => p.startMs <= windowStart && p.stopMs > windowStart) ?? row.programs[0];
}
/** Height of a single channel row — taller when the *current* programme is a
 *  movie (which gets an expanded block with year, cast and synopsis). */
function rowHeightOf(row: GuideRow, theme: GuideTheme, windowStart: number): number {
  const cur = currentProgram(row, windowStart);
  const movie = cur ? categoryKey(cur.category) === "movie" : false;
  return movie ? (theme.movieRowHeight ?? Math.round(theme.rowHeight * 2.1)) : theme.rowHeight;
}
/** Total pixel height of the scrolling grid for a set of rows. */
export function guideGridHeight(rows: GuideRow[], theme: GuideTheme, windowStart: number): number {
  const h = rows.reduce((sum, r) => sum + rowHeightOf(r, theme, windowStart), 0);
  return Math.max(theme.rowHeight, h);
}

/** Tall SVG of the scrolling grid: channels down the side, a continuous timeline
 *  across. Each programme is one block sized by its real duration. */
export function renderGridSvg(
  rows: GuideRow[], layout: GuideLayout, theme: GuideTheme, windowStart: number, windowEnd: number, tz: Tz,
): string {
  const { width: W } = layout;
  const LW = theme.leftWidth;
  const GH = guideGridHeight(rows, theme, windowStart);
  const gridW = W - LW;
  const span = Math.max(1, windowEnd - windowStart);
  const pxPerMs = gridW / span;
  const bv = theme.bevel ?? 3;
  const gap = 3;
  const arrowCol = theme.headerText;
  const CHAR_W = 18; // rough px/char at 34px — only used to pick an ellipsis point

  let body = "";
  let defs = "";
  let clipSeq = 0;
  // Emit text hard-clipped to a rect, so it can never spill past a block edge
  // (into the rating chip or the next cell) regardless of the font's real width.
  const clipped = (cx: number, cyTop: number, cw: number, ch: number, inner: string): string => {
    const id = `gc${clipSeq++}`;
    defs += `<clipPath id="${id}"><rect x="${cx}" y="${cyTop}" width="${Math.max(1, cw)}" height="${ch}"/></clipPath>`;
    return `<g clip-path="url(#${id})">${inner}</g>`;
  };

  let y = 0;
  rows.forEach((row, i) => {
    const RH = rowHeightOf(row, theme, windowStart);
    const isMovieRow = RH > theme.rowHeight;
    const rowBg = (i % 2) ? theme.rowB : theme.rowA;

    // channel number / callsign cell (beveled), full row height
    body += bevel(0, y, LW - gap, RH - gap, rowBg, bv);
    body += `<text x="24" y="${y + 48}" font-size="34" font-weight="900" fill="${theme.chNum}" ${GRID_FONT}>${esc(row.number)}</text>`;
    body += `<text x="24" y="${y + 88}" font-size="26" font-weight="700" fill="${theme.chan}" ${GRID_FONT}>${esc(clip(row.name, 18))}</text>`;

    if (!row.programs.length) {
      body += bevel(LW, y, gridW - gap, RH - gap, rowBg, bv);
      body += `<text x="${LW + 22}" y="${y + RH / 2 + 12}" font-size="34" font-weight="700" fill="${theme.empty}" ${GRID_FONT}>—</text>`;
    }

    for (const p of row.programs) {
      const l = Math.max(windowStart, p.startMs), r = Math.min(windowEnd, p.stopMs);
      const x0 = LW + (l - windowStart) * pxPerMs;
      const x1 = LW + (r - windowStart) * pxPerMs;
      const w = Math.max(24, x1 - x0 - gap);
      const cont = { left: p.startMs < windowStart, right: p.stopMs > windowEnd };
      const overL = windowStart - p.startMs, overR = p.stopMs - windowEnd;
      const slotMs = layout.slotMinutes * 60_000;

      const key = categoryKey(p.category);
      const fill = (theme.categoryColors?.[key] || "") || rowBg;
      body += bevel(x0, y, w, RH - gap, fill, bv);

      const padL = cont.left ? 56 : 22;   // leave room for a left chevron
      const padR = cont.right ? 56 : 14;
      const tx = x0 + padL;
      const innerW = Math.max(20, w - padL - padR);
      const chars = Math.max(4, Math.floor(innerW / CHAR_W));

      if (isMovieRow && key === "movie") {
        // Movie block: [start] "Title" (year) / <rating> cast / synopsis.
        let head = `[${shortTime(p.startMs, tz)}] "${clip(p.title, Math.max(6, chars - 8))}"`;
        if (p.year) head += `  (${p.year})`;
        const chipW = p.rating ? 22 + String(p.rating).length * 17 : 0;
        const textInner =
          `<text x="${tx}" y="${y + 52}" font-size="34" font-weight="900" fill="${theme.title}" ${GRID_FONT}>${esc(head)}</text>` +
          (p.rating ? ratingChip(tx, y + 92, p.rating, theme.title, GRID_FONT) : "") +
          (p.cast ? `<text x="${p.rating ? tx + chipW + 20 : tx}" y="${y + 102}" font-size="27" font-weight="700" fill="${shade(theme.title, -0.12)}" ${GRID_FONT}>${esc(p.cast)}</text>` : "");
        let syn = "";
        const synY = y + (p.cast || p.rating ? 138 : 96);
        const maxLines = Math.max(1, Math.floor((RH - (synY - y) - 16) / 34));
        wrapLines(p.desc ?? "", chars, maxLines).forEach((line, li) => {
          syn += `<text x="${tx}" y="${synY + li * 34}" font-size="27" font-weight="600" fill="${shade(theme.title, -0.18)}" ${GRID_FONT}>${esc(line)}</text>`;
        });
        body += clipped(tx, y, innerW, RH - gap, textInner + syn);
      } else {
        // Regular block: title (movies add the year), rating chip right-aligned.
        const cy = y + RH / 2;
        const chipW = p.rating ? 22 + String(p.rating).length * 17 : 0;
        const chipReserve = p.rating ? chipW + 24 : 0;
        const showChip = !!p.rating && innerW - chipReserve > 40;
        const titleW = showChip ? innerW - chipReserve : innerW;
        let base = p.title || "—";
        if (key === "movie" && p.year) base += ` (${p.year})`;
        const t = p.title ? clip(base, Math.max(3, Math.floor(titleW / CHAR_W))) : "—";
        // hard-clip the title to its own region; the chip sits outside that clip
        body += clipped(tx, y, titleW, RH - gap,
          `<text x="${tx}" y="${cy + 12}" font-size="34" font-weight="700" fill="${p.title ? theme.title : theme.empty}" ${GRID_FONT}>${esc(t)}</text>`);
        if (showChip) body += ratingChip(x0 + w - padR - chipW, cy, p.rating!, theme.title, GRID_FONT);
      }

      // continuation chevrons
      if (cont.left) body += chevrons(x0 + 30, y + RH / 2, 16, "left", overL > slotMs ? 2 : 1, arrowCol);
      if (cont.right) body += chevrons(x0 + w - 30, y + RH / 2, 16, "right", overR > slotMs ? 2 : 1, arrowCol);
    }
    y += RH;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${GH}" viewBox="0 0 ${W} ${GH}"><defs>${defs}</defs>${body}</svg>`;
}

/** Fixed top chrome: gradient background, LOGO box, promo/trailer window and the
 *  beveled time bar. The rotating "featured" text is a separate overlay strip
 *  (renderFeaturedStripSvg) and the live clock is drawn by ffmpeg over the time
 *  bar's first cell. Height = promo + time bar. */
export function renderHeaderSvg(colTimes: number[], layout: GuideLayout, tz: Tz, theme: GuideTheme): string {
  const { width: W, height: FH, columns } = layout;
  const promoH = guidePromoHeight(theme, FH);
  const tbH = guideTimeBarHeight(theme);
  const HH = promoH + tbH;
  const LW = theme.leftWidth;
  const CW = (W - LW) / columns;
  const bv = theme.bevel ?? 3;
  const gap = 3;
  const promoText = theme.promoText || theme.headerText;
  const timeCell = theme.timeCell || theme.header;
  const promoBg = theme.promoBg || "#000010";

  const g1 = shade(theme.header, 0.12), g2 = shade(theme.header, -0.35);
  let body = `<defs><linearGradient id="hg" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${g1}"/><stop offset="1" stop-color="${g2}"/></linearGradient></defs>`;
  body += `<rect x="0" y="0" width="${W}" height="${HH}" fill="url(#hg)"/>`;

  // promo / trailer window (top-right), sized ~4:3. The CLI overlays a video clip
  // inside this same rectangle; when no clip is configured the placeholder shows.
  const pb = guidePromoBox(layout, theme);
  body += bevel(pb.x, pb.y, pb.w, pb.h, promoBg, bv);
  body += `<text x="${pb.x + pb.w / 2}" y="${pb.y + pb.h / 2 - 6}" font-size="40" font-weight="900" fill="${promoText}" text-anchor="middle" ${GRID_FONT}>PROMO / TRAILER</text>`;
  body += `<text x="${pb.x + pb.w / 2}" y="${pb.y + pb.h / 2 + 40}" font-size="26" font-weight="700" fill="${shade(promoText, -0.25)}" text-anchor="middle" ${GRID_FONT}>(video plays here)</text>`;

  // time bar (beveled cells); first cell holds the ffmpeg live clock
  body += bevel(0, promoH, LW - gap, tbH - gap, timeCell, bv);
  colTimes.forEach((t, c) => {
    const x = LW + c * CW;
    body += bevel(x, promoH, CW - gap, tbH - gap, timeCell, bv);
    body += `<text x="${x + 24}" y="${promoH + tbH / 2 + 14}" font-size="40" font-weight="900" fill="${theme.headerText}" ${GRID_FONT}>${esc(slotLabel(t, tz))}</text>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${HH}" viewBox="0 0 ${W} ${HH}">${body}</svg>`;
}

/** Geometry of the featured overlay strip: one FULL-FRAME-HEIGHT band per pick,
 *  stacked vertically (so only the active band is ever on-screen — the others
 *  sit entirely above/below the frame). ffmpeg overlays it at y = -bandH*index,
 *  stepping index every `rotateSec` so the featured panel cycles. */
export function guideFeaturedBandHeight(theme: GuideTheme, frameHeight: number): number {
  return frameHeight;
}
/** One transparent band per featured pick, drawn in the left info area. */
export function renderFeaturedStripSvg(picks: FeaturedPick[], layout: GuideLayout, theme: GuideTheme): string {
  const { width: W, height: FH } = layout;
  const bandH = guideFeaturedBandHeight(theme, FH);
  const list = picks.length ? picks : [{ title: "", channelNumber: "", channelName: "", day: "", time: "" }];
  const infoText = theme.infoText || theme.headerText;
  const promoBg = theme.promoBg || "#000010";
  const promoText = theme.promoText || theme.headerText;
  const bv = theme.bevel ?? 3;
  const pad = 60;
  // Portrait box (~2:3) so a movie poster fills it; a landscape logo just letterboxes.
  const logoW = 210, logoH = 300;

  let body = "";
  list.forEach((p, i) => {
    const y0 = i * bandH;
    // LOGO box: the featured programme's poster when resolved, else a placeholder.
    body += bevel(pad, y0 + pad, logoW, logoH, promoBg, bv);
    if (p.iconData) {
      body += `<image x="${pad}" y="${y0 + pad}" width="${logoW}" height="${logoH}" ` +
        `preserveAspectRatio="xMidYMid meet" href="${p.iconData}"/>`;
    } else {
      body += `<text x="${pad + logoW / 2}" y="${y0 + pad + logoH / 2 + 12}" font-size="34" font-weight="900" fill="${promoText}" text-anchor="middle" ${GRID_FONT}>LOGO</text>`;
    }
    const tx = pad + logoW + 44;
    body += `<text x="${tx}" y="${y0 + pad + 58}" font-size="34" font-weight="900" fill="${theme.accent}" ${GRID_FONT}>${esc(p.day)}</text>`;
    body += `<text x="${tx}" y="${y0 + pad + 130}" font-size="58" font-weight="900" fill="${infoText}" ${GRID_FONT}>${esc(clip(p.title, 30))}</text>`;
    if (p.subTitle) body += `<text x="${tx}" y="${y0 + pad + 186}" font-size="34" font-weight="700" fill="${shade(infoText, -0.15)}" ${GRID_FONT}>${esc(clip(p.subTitle, 40))}</text>`;
    const chan = p.channelNumber ? `CH ${p.channelNumber}  ${p.channelName}` : "";
    body += `<text x="${tx}" y="${y0 + pad + 258}" font-size="40" font-weight="900" fill="${infoText}" ${GRID_FONT}>${esc(chan)}</text>`;
    if (p.time) body += `<text x="${tx}" y="${y0 + pad + 312}" font-size="36" font-weight="700" fill="${shade(infoText, -0.1)}" ${GRID_FONT}>${esc(p.time)}</text>`;
  });
  const H = list.length * bandH;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
}

// --- theme file storage (seed / load / list) --------------------------------
async function exists(p: string): Promise<boolean> { try { await access(p); return true; } catch { return false; } }

export async function seedGuideThemes(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [id, def] of Object.entries(DEFAULT_GUIDE_THEMES)) {
    const p = join(dir, `${id}.json`);
    if (!(await exists(p))) await writeFile(p, JSON.stringify(def, null, 2), "utf8");
  }
}
export async function loadGuideTheme(dir: string, id: string): Promise<GuideTheme> {
  try {
    const raw = JSON.parse(await readFile(join(dir, `${id}.json`), "utf8"));
    return { ...(DEFAULT_GUIDE_THEMES[id] ?? DEFAULT_GUIDE_THEMES.classic), ...raw };
  } catch { return DEFAULT_GUIDE_THEMES[id] ?? DEFAULT_GUIDE_THEMES.classic; }
}
export async function listGuideThemes(dir: string): Promise<{ id: string; label: string }[]> {
  await seedGuideThemes(dir).catch(() => {});
  const out: { id: string; label: string }[] = [];
  try {
    for (const f of (await readdir(dir)).sort()) {
      if (!f.endsWith(".json")) continue;
      const id = f.replace(/\.json$/, "");
      let label = id;
      try { label = JSON.parse(await readFile(join(dir, f), "utf8")).label || id; } catch { /* keep id */ }
      out.push({ id, label });
    }
  } catch { /* defaults below */ }
  if (!out.length) for (const [id, def] of Object.entries(DEFAULT_GUIDE_THEMES)) out.push({ id, label: def.label });
  return out;
}
