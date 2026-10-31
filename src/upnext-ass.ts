// -----------------------------------------------------------------------------
// "Coming up next" text as a burned ASS subtitle (libass).
// -----------------------------------------------------------------------------
// When a channel's up-next text renderer is "subtitles", the card's background
// art is still a graphics layer (PNG), but the times/titles are written to an
// ASS document that next burns via libass. ASS gives us native \pos placement
// and \fad fades, with each line revealed on its own schedule — so the text is
// rendered by next, not rasterized by us. The ASS coordinate space is the output
// resolution (PlayResX/Y), matching the SVG art's viewBox.

import { localParts, type Tz } from "./time.js";

export interface AssLayout {
  font: string;
  labelX: number;      // x of the time column
  titleX: number;      // x of the title column
  startY: number;      // vertical center of the first row
  stepY: number;       // vertical spacing between rows
  labelSize: number;
  titleSize: number;
  labelColor: string;  // #RRGGBB
  titleColor: string;  // #RRGGBB
  align: number;       // ASS \an alignment (1-9 numpad); 4 = left-middle
  fadeMs: number;
  titleWrap: number;   // wrap the title to this many characters per line (0 = no wrap)
}

export const DEFAULT_ASS_LAYOUT: AssLayout = {
  font: "Roboto",
  labelX: 154, titleX: 600,
  startY: 470, stepY: 165,
  labelSize: 56, titleSize: 72,
  labelColor: "#FFFFFF", titleColor: "#FFFFFF",
  align: 4, fadeMs: 600, titleWrap: 24,
};

/** Greedy word-wrap into lines of ~`max` chars; joined later with ASS "\\N". */
function wrapText(text: string, max: number): string[] {
  if (!max) return [text];
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines: string[] = []; let cur = "";
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > max) { lines.push(cur); cur = w; }
    else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [text];
}

export interface AssRow { label: string; title: string }

/** Format an epoch-ms instant as a friendly 12-hour local time, e.g. "8:00 PM". */
export function formatClock(ms: number, tz: Tz): string {
  const p = localParts(ms, tz);
  const hh = Math.floor(p.msOfDay / 3_600_000);
  const mm = Math.floor((p.msOfDay % 3_600_000) / 60_000);
  const ampm = hh >= 12 ? "PM" : "AM";
  let h = hh % 12; if (h === 0) h = 12;
  return `${h}:${String(mm).padStart(2, "0")} ${ampm}`;
}

/** #RRGGBB -> ASS &HBBGGRR (ASS colors are BGR). */
function assColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "&HFFFFFF";
  const rr = m[1].slice(0, 2), gg = m[1].slice(2, 4), bb = m[1].slice(4, 6);
  return `&H${bb}${gg}${rr}`.toUpperCase();
}

/** Escape text for an ASS Dialogue field (braces start override blocks). */
function assText(s: string): string {
  return String(s ?? "").replace(/[{}]/g, "").replace(/\r?\n/g, "\\N");
}

/** ASS timestamp h:mm:ss.cs from milliseconds. */
function assTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const cs = Math.floor((t % 1000) / 10);
  const s = Math.floor(t / 1000) % 60;
  const m = Math.floor(t / 60000) % 60;
  const h = Math.floor(t / 3_600_000);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${h}:${p2(m)}:${p2(s)}.${p2(cs)}`;
}

/**
 * Build an ASS document that reveals each row (time + title) on its own
 * schedule and fades them all out near the end. `durationMs` is the card length.
 */
export function buildUpNextAss(
  rows: AssRow[], width: number, height: number, durationMs: number, layout: AssLayout,
): string {
  const F = layout.fadeMs;
  const outEnd = Math.max(2 * F + 50, durationMs - 100);
  const t0 = F;
  let revealEnd = Math.min(durationMs * 0.62, outEnd - 2 * F - 200);
  if (revealEnd < t0) revealEnd = t0;
  const step = rows.length > 1 ? (revealEnd - t0) / (rows.length - 1) : 0;

  const dialogues: string[] = [];
  const emit = (startMs: number, x: number, y: number, size: number, color: string, text: string) => {
    const tags = `\\an${layout.align}\\pos(${Math.round(x)},${Math.round(y)})\\fs${size}\\c${assColor(color)}\\fad(${F},${F})`;
    dialogues.push(`Dialogue: 0,${assTime(startMs)},${assTime(outEnd)},Default,,0,0,0,,{${tags}}${assText(text)}`);
  };
  rows.forEach((r, i) => {
    const start = t0 + i * step;
    const y = layout.startY + i * layout.stepY;
    if (r.label) emit(start, layout.labelX, y, layout.labelSize, layout.labelColor, r.label);
    const title = wrapText(r.title, layout.titleWrap).join("\\N");
    emit(start, r.label ? layout.titleX : layout.labelX, y, layout.titleSize, layout.titleColor, title);
  });

  return `[Script Info]
ScriptType: v4.00+
WrapStyle: 2
ScaledBorderAndShadow: yes
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BorderStyle, Outline, Shadow, Alignment, Encoding
Style: Default,${layout.font},${layout.titleSize},&HFFFFFF,&H000000,1,2,0,${layout.align},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${dialogues.join("\n")}
`;
}
