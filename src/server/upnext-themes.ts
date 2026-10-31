// -----------------------------------------------------------------------------
// "Coming up next" card themes — file-based, editable templates.
// -----------------------------------------------------------------------------
// Each theme is a JSON file in {runtimeDir}/upnext-themes/<id>.json describing an
// SVG card (authored at `width`x`height`) as editable templates:
//   - `base`     : SVG drawn once (background, chrome, heading). Token:
//                  {{channel}} (the channel's name; add `|case=upper` for capitals).
//   - `row`      : SVG for one upcoming show, drawn once per row; coordinates are
//                  ROW-LOCAL (0,0 = the row's top) — the renderer translates each
//                  row down by `rowStart + index*rowStep`. Tokens: {{label}}
//                  (e.g. "12:30 PM"), {{title}}, {{time}} (label without AM/PM),
//                  {{ampm}}, {{channel}}.
//   - `firstRow` : optional distinct layer for the FIRST show (absolute coords,
//                  no translate) — used by the "clock" theme's big time block.
//   - `empty`    : optional layer shown when the guide has no upcoming shows.
// Defaults are seeded to disk on first run; edit the files (no rebuild needed) or
// drop in a new <id>.json to add a theme (it appears in the channel dropdown).
// The renderer turns each into separate PNG layers so next fades them natively.

import { mkdir, readFile, readdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface UpNextRow { label: string; title: string }

export interface ThemeDef {
  label: string;
  width: number;
  height: number;
  rowStart: number;
  rowStep: number;
  maxRows?: number;
  base: string;
  row: string;
  firstRow?: string;
  empty?: string;
}

const F = `font-family="Arial, Helvetica, sans-serif"`;
// The channel's name, as a theme shows it in its corner (shrinks to fit 900 px).
const CHANNEL = `{{channel|case=upper|w=900}}`;

// Explicit checkerboard band: `rows` rows of `s`x`s` squares across `cols`
// columns starting at (0, y0). Drawn as literal white squares (on a dark bg) so
// every cell is exactly square and grid-aligned — no pattern tiling that could
// clip a partial square. 1920 / 80 = 24 columns tile the full width exactly.
function checkerBand(y0: number, rows: number, s: number, cols: number): string {
  let out = "";
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if ((r + c) % 2 === 0) out += `<rect x="${c * s}" y="${y0 + r * s}" width="${s}" height="${s}" fill="#ffffff"/>`;
  return out;
}

// --- holiday shapes (plain SVG, so the theme files stay hand-editable) -------
// A unit heart (1x1, point at the bottom), drawn centred on (cx, cy).
const HEART = "M0.5,0.95 C0.2,0.72 0,0.52 0,0.3 C0,0.12 0.14,0 0.28,0 C0.38,0 0.46,0.06 0.5,0.15 C0.54,0.06 0.62,0 0.72,0 C0.86,0 1,0.12 1,0.3 C1,0.52 0.8,0.72 0.5,0.95 Z";
function heart(cx: number, cy: number, size: number, rot = 0): string {
  return `<path transform="translate(${cx} ${cy}) rotate(${rot}) scale(${size}) translate(-0.5 -0.5)" d="${HEART}"/>`;
}
// A four-point twinkle star.
function sparkle(cx: number, cy: number, r: number, color: string): string {
  return `<path d="M${cx},${cy - r} Q${cx},${cy} ${cx + r},${cy} Q${cx},${cy} ${cx},${cy + r} Q${cx},${cy} ${cx - r},${cy} Q${cx},${cy} ${cx},${cy - r} Z" fill="${color}"/>`;
}
// A puffy cloud centred on (cx, cy).
function cloud(cx: number, cy: number, s: number): string {
  const r = (n: number) => Math.round(n * s);
  return `<g fill="#ffffff"><circle cx="${cx - r(0.5)}" cy="${cy + r(0.1)}" r="${r(0.38)}"/><circle cx="${cx}" cy="${cy - r(0.15)}" r="${r(0.5)}"/><circle cx="${cx + r(0.5)}" cy="${cy + r(0.1)}" r="${r(0.38)}"/><rect x="${cx - r(0.5)}" y="${cy + r(0.05)}" width="${r(1)}" height="${r(0.43)}"/></g>`;
}
// Three heart leaves meeting at (cx, cy), plus a curled stem.
function shamrock(cx: number, cy: number, s: number, color: string, rot = 0): string {
  const leaf = (a: number) => `<path transform="rotate(${a}) scale(${s}) translate(-0.5 -0.95)" d="${HEART}"/>`;
  return `<g transform="translate(${cx} ${cy}) rotate(${rot})" fill="${color}">${leaf(0)}${leaf(120)}${leaf(240)}` +
    `<path d="M0,0 Q${s * 0.12},${s * 0.75} ${s * 0.5},${s * 1.15}" fill="none" stroke="${color}" stroke-width="${Math.round(s * 0.12)}" stroke-linecap="round"/></g>`;
}
function star(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI / 5) * i - Math.PI / 2, d = i % 2 ? r * 0.42 : r;
    pts.push(`${Math.round(cx + d * Math.cos(a))},${Math.round(cy + d * Math.sin(a))}`);
  }
  return `<polygon points="${pts.join(" ")}"/>`;
}
// A firework: `n` rays from a hollow centre, each tipped with a dot.
function burst(cx: number, cy: number, r: number, n: number, color: string): string {
  let out = `<g stroke="${color}" fill="${color}" stroke-width="${Math.max(3, Math.round(r / 22))}" stroke-linecap="round">`;
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n, c = Math.cos(a), s = Math.sin(a);
    out += `<line x1="${Math.round(cx + c * r * 0.3)}" y1="${Math.round(cy + s * r * 0.3)}" x2="${Math.round(cx + c * r * 0.8)}" y2="${Math.round(cy + s * r * 0.8)}"/>` +
      `<circle cx="${Math.round(cx + c * r)}" cy="${Math.round(cy + s * r)}" r="${Math.max(4, Math.round(r / 16))}" stroke="none"/>`;
  }
  return out + `</g>`;
}
function snowflake(cx: number, cy: number, r: number): string {
  let out = `<g transform="translate(${cx} ${cy})" stroke="#ffffff" stroke-width="${Math.max(3, Math.round(r / 9))}" stroke-linecap="round" fill="none">`;
  for (let a = 0; a < 360; a += 60)
    out += `<g transform="rotate(${a})"><line x1="0" y1="0" x2="0" y2="${-r}"/><polyline points="${-r * 0.3},${-r * 0.82} 0,${-r * 0.55} ${r * 0.3},${-r * 0.82}"/></g>`;
  return out + `</g>`;
}
// Half a bat (right wing); the left is the same path mirrored.
const BAT = "M0,-0.12 L0.08,-0.32 L0.13,-0.14 C0.35,-0.5 0.72,-0.56 1,-0.3 C0.86,-0.12 0.84,0.06 0.86,0.24 C0.72,0.08 0.58,0.12 0.52,0.3 C0.44,0.12 0.3,0.16 0.22,0.32 C0.16,0.16 0.08,0.16 0,0.36 Z";
function bat(cx: number, cy: number, s: number, rot = 0): string {
  return `<g transform="translate(${cx} ${cy}) rotate(${rot}) scale(${s})"><path d="${BAT}"/><path transform="scale(-1 1)" d="${BAT}"/></g>`;
}
function pumpkin(cx: number, cy: number, s: number): string {
  const r = (n: number) => Math.round(n * s);
  return `<rect x="${cx - r(0.06)}" y="${cy - r(0.58)}" width="${r(0.12)}" height="${r(0.22)}" rx="${r(0.04)}" fill="#4F7A2A"/>` +
    `<ellipse cx="${cx - r(0.27)}" cy="${cy}" rx="${r(0.32)}" ry="${r(0.4)}" fill="#E0620C"/>` +
    `<ellipse cx="${cx + r(0.27)}" cy="${cy}" rx="${r(0.32)}" ry="${r(0.4)}" fill="#E0620C"/>` +
    `<ellipse cx="${cx}" cy="${cy}" rx="${r(0.3)}" ry="${r(0.42)}" fill="#FF7A1A"/>`;
}
// A pointed leaf with a centre vein.
function leaf(cx: number, cy: number, s: number, rot: number, color: string): string {
  return `<g transform="translate(${cx} ${cy}) rotate(${rot}) scale(${s})"><path d="M0,-1 C0.62,-0.55 0.62,0.45 0,1 C-0.62,0.45 -0.62,-0.55 0,-1 Z" fill="${color}"/>` +
    `<line x1="0" y1="-0.8" x2="0" y2="1.25" stroke="#2E1A0E" stroke-opacity="0.35" stroke-width="0.06"/></g>`;
}
// An egg with a white zigzag band and dots.
function egg(cx: number, cy: number, s: number, color: string): string {
  const r = (n: number) => Math.round(n * s);
  let zig = "";
  for (let i = 0; i <= 8; i++) zig += `${cx - r(0.3) + Math.round((i * r(0.6)) / 8)},${cy + (i % 2 ? -r(0.05) : r(0.05))} `;
  return `<ellipse cx="${cx}" cy="${cy}" rx="${r(0.36)}" ry="${r(0.48)}" fill="${color}"/>` +
    `<polyline points="${zig.trim()}" fill="none" stroke="#ffffff" stroke-width="${r(0.045)}" stroke-linejoin="round"/>` +
    `<g fill="#ffffff" opacity="0.85"><circle cx="${cx - r(0.12)}" cy="${cy - r(0.22)}" r="${r(0.035)}"/><circle cx="${cx + r(0.1)}" cy="${cy - r(0.27)}" r="${r(0.035)}"/><circle cx="${cx}" cy="${cy + r(0.22)}" r="${r(0.035)}"/></g>`;
}
// Shared list layout for the holiday themes: a greeting over COMING UP NEXT, then
// a time + title per row.
const greeting = (text: string, color: string) => `<text x="180" y="140" font-size="44" font-weight="800" letter-spacing="8" fill="${color}" ${F}>${text}</text>`;
const heading = (color: string, rule: string) =>
  `<text x="180" y="260" font-size="110" font-weight="900" fill="${color}" ${F}>COMING UP NEXT</text>` +
  `<rect x="186" y="290" width="470" height="14" rx="7" fill="${rule}"/>`;
const gradient = (id: string, top: string, bottom: string) =>
  `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>` +
  `<rect width="1920" height="1080" fill="url(#${id})"/>`;
const listEmpty = (fill: string) => `<text x="180" y="520" font-size="72" font-weight="800" fill="${fill}" ${F}>{{title|x=180|w=1560|lines=2|lh=80}}</text>`;

// --- built-in defaults (seeded to disk; also the fallback if a file is bad) ---
export const DEFAULT_THEMES: Record<string, ThemeDef> = {
  splat: {
    label: "Splat Orange", width: 1920, height: 1080, rowStart: 430, rowStep: 165, maxRows: 4,
    base:
      `<rect width="1920" height="1080" fill="#F5790B"/>` +
      `<g fill="#ffffff" opacity="0.12"><circle cx="1700" cy="250" r="210"/><circle cx="1900" cy="120" r="120"/><circle cx="1830" cy="470" r="95"/><circle cx="1560" cy="150" r="80"/></g>` +
      `<text x="180" y="250" font-size="120" font-weight="900" fill="#ffffff" ${F}>COMING UP NEXT</text>` +
      `<rect x="186" y="280" width="470" height="22" rx="11" fill="#ffffff"/>` +
      `<text x="1740" y="1030" font-size="40" font-weight="800" fill="#ffffff" opacity="0.85" text-anchor="end" letter-spacing="4" ${F}>${CHANNEL}</text>`,
    row:
      `<rect x="180" y="0" width="360" height="112" rx="56" fill="#ffffff"/>` +
      `<text x="360" y="74" font-size="56" font-weight="800" fill="#F5790B" text-anchor="middle" ${F}>{{label}}</text>` +
      `<text x="580" y="78" font-size="72" font-weight="800" fill="#ffffff" ${F}>{{title|w=1160}}</text>`,
    empty: `<text x="180" y="500" font-size="72" font-weight="800" fill="#ffffff" ${F}>{{title|x=180|w=1560|lines=2|lh=80}}</text>`,
  },
  slime: {
    label: "Slime Night", width: 1920, height: 1080, rowStart: 380, rowStep: 190, maxRows: 4,
    base:
      `<rect width="1920" height="1080" fill="#161619"/>` +
      `<rect width="1920" height="200" fill="#F5790B"/>` +
      `<text x="180" y="138" font-size="92" font-weight="900" fill="#ffffff" ${F}>COMING UP NEXT</text>` +
      // slime dripping off the header
      `<g fill="#C6E82B"><rect x="1470" y="184" width="310" height="34" rx="17"/><rect x="1508" y="196" width="34" height="62" rx="17"/><circle cx="1525" cy="262" r="21"/><rect x="1598" y="196" width="26" height="30" rx="13"/><circle cx="1611" cy="232" r="15"/><rect x="1690" y="196" width="38" height="74" rx="19"/><circle cx="1709" cy="276" r="24"/></g>` +
      `<text x="1740" y="1030" font-size="34" font-weight="800" fill="#6a6a70" text-anchor="end" letter-spacing="4" ${F}>${CHANNEL}</text>`,
    row:
      `<text x="180" y="0" font-size="64" font-weight="800" fill="#F5A24B" ${F}>{{label}}</text>` +
      `<text x="560" y="0" font-size="70" font-weight="800" fill="#ffffff" ${F}>{{title|w=1180}}</text>` +
      `<line x1="180" y1="44" x2="1740" y2="44" stroke="#2c2c31" stroke-width="4"/>`,
    empty: `<text x="180" y="480" font-size="70" font-weight="800" fill="#ffffff" ${F}>{{title|x=180|w=1560|lines=2|lh=78}}</text>`,
  },
  clock: {
    label: "Big Clock", width: 1920, height: 1080, rowStart: 140, rowStep: 260, maxRows: 3,
    base:
      `<rect width="1920" height="1080" fill="#12151C"/>` +
      `<rect width="760" height="1080" fill="#1E4FC2"/>` +
      `<g fill="#ffffff" opacity="0.12"><circle cx="110" cy="1070" r="130"/><circle cx="280" cy="1095" r="80"/></g>` +
      `<text x="150" y="210" font-size="54" font-weight="900" letter-spacing="8" fill="#ffffff" opacity="0.9" ${F}>UP NEXT</text>` +
      `<text x="820" y="210" font-size="54" font-weight="900" letter-spacing="8" fill="#8EB8FF" ${F}>LATER</text>`,
    firstRow:
      `<text x="145" y="470" font-size="220" font-weight="900" fill="#ffffff" ${F}>{{time|fit=560|size=220}}</text>` +
      `<text x="150" y="545" font-size="60" font-weight="800" fill="#ffffff" opacity="0.9" ${F}>{{ampm}}</text>` +
      `<text x="150" y="660" font-size="72" font-weight="800" fill="#ffffff" ${F}>{{title|x=150|w=560|lines=3|lh=80}}</text>`,
    row:
      `<text x="820" y="0" font-size="60" font-weight="800" fill="#8EB8FF" ${F}>{{label}}</text>` +
      `<text x="820" y="74" font-size="66" font-weight="800" fill="#ffffff" ${F}>{{title|w=960}}</text>` +
      `<line x1="820" y1="120" x2="1780" y2="120" stroke="#262B36" stroke-width="4"/>`,
    empty: `<text x="150" y="470" font-size="96" font-weight="900" fill="#ffffff" ${F}>{{title|x=150|w=560|lines=2|lh=104}}</text>`,
  },
  chips: {
    label: "Chip Stack", width: 1920, height: 1080, rowStart: 300, rowStep: 230, maxRows: 3,
    base:
      `<rect width="1920" height="1080" fill="#0E7C80"/>` +
      `<text x="180" y="210" font-size="104" font-weight="900" fill="#ffffff" ${F}>COMING UP NEXT</text>`,
    row:
      `<rect x="180" y="0" width="1560" height="190" rx="44" fill="#ffffff"/>` +
      `<rect x="215" y="40" width="330" height="110" rx="55" fill="#0E7C80"/>` +
      `<text x="380" y="112" font-size="54" font-weight="800" fill="#ffffff" text-anchor="middle" ${F}>{{label}}</text>` +
      `<text x="600" y="115" font-size="72" font-weight="800" fill="#0F1618" ${F}>{{title|w=1100}}</text>`,
    empty:
      `<rect x="180" y="420" width="1560" height="190" rx="44" fill="#ffffff"/>` +
      `<text x="230" y="535" font-size="72" font-weight="800" fill="#0F1618" ${F}>{{title|w=1460}}</text>`,
  },
  "cn-checker": {
    label: "CN Checker", width: 1920, height: 1080, rowStart: 380, rowStep: 150, maxRows: 4,
    base:
      `<rect width="1920" height="1080" fill="#000000"/>` +
      checkerBand(0, 1, 80, 24) +        // one 80px row across the top
      checkerBand(920, 2, 80, 24) +      // two 80px rows flush to the bottom (920..1080)
      `<text x="140" y="250" font-size="92" font-weight="900" fill="#ffffff" letter-spacing="8" ${F}>COMING UP NEXT</text>`,
    row:
      `<text x="140" y="0" font-size="52" font-weight="800" fill="#b8b8b8" ${F}>{{label}}</text>` +
      `<text x="470" y="0" font-size="64" font-weight="900" fill="#ffffff" ${F}>{{title|w=1310}}</text>` +
      `<line x1="140" y1="34" x2="1780" y2="34" stroke="#3a3a3a" stroke-width="3"/>`,
    empty: `<text x="140" y="470" font-size="70" font-weight="900" fill="#ffffff" ${F}>{{title|w=1640}}</text>`,
  },
  "cn-powerhouse": {
    label: "CN Powerhouse", width: 1920, height: 1080, rowStart: 380, rowStep: 180, maxRows: 4,
    base:
      `<rect width="1920" height="1080" fill="#FFCE00"/>` +
      `<rect x="0" y="0" width="1920" height="196" fill="#111111"/>` +
      `<text x="140" y="132" font-size="92" font-weight="900" fill="#ffffff" letter-spacing="4" ${F}>COMING UP NEXT</text>` +
      `<g><rect x="1620" y="760" width="120" height="120" fill="#111111"/><rect x="1620" y="900" width="120" height="120" fill="#E4002B"/><rect x="1760" y="900" width="120" height="120" fill="#0A7CFF"/></g>`,
    row:
      `<text x="140" y="0" font-size="60" font-weight="900" fill="#E4002B" ${F}>{{label}}</text>` +
      `<text x="470" y="0" font-size="70" font-weight="900" fill="#111111" ${F}>{{title|w=1090}}</text>` +
      `<line x1="140" y1="40" x2="1560" y2="40" stroke="#111111" stroke-opacity="0.25" stroke-width="4"/>`,
    empty: `<text x="140" y="470" font-size="76" font-weight="900" fill="#111111" ${F}>{{title|x=140|w=1420|lines=2|lh=82}}</text>`,
  },
  toonami: {
    label: "Toonami", width: 1920, height: 1080, rowStart: 140, rowStep: 260, maxRows: 3,
    base:
      `<rect width="1920" height="1080" fill="#04060F"/>` +
      // starfield across the whole frame (denser toward the right)
      `<g fill="#ffffff" opacity="0.55"><circle cx="1050" cy="150" r="3"/><circle cx="1320" cy="300" r="2"/><circle cx="1600" cy="210" r="3"/><circle cx="1790" cy="430" r="2"/><circle cx="1180" cy="520" r="2"/><circle cx="1500" cy="640" r="3"/><circle cx="1710" cy="800" r="2"/><circle cx="1240" cy="850" r="2"/><circle cx="1420" cy="970" r="3"/><circle cx="980" cy="700" r="2"/><circle cx="1650" cy="520" r="2"/><circle cx="1120" cy="300" r="2"/><circle cx="1850" cy="640" r="3"/></g>` +
      // left panel: deep navy with a bright cyan top edge + a glowing seam
      `<rect width="760" height="1080" fill="#0A1636"/>` +
      `<rect x="0" y="0" width="760" height="12" fill="#4DE1FF"/>` +
      `<rect x="748" y="0" width="4" height="1080" fill="#4DE1FF" opacity="0.35"/>` +
      `<rect x="754" y="0" width="10" height="1080" fill="#4DE1FF" opacity="0.15"/>` +
      // sci-fi reticle flourish, lower-left of the panel
      `<g fill="none" stroke="#4DE1FF" stroke-opacity="0.22" stroke-width="3"><circle cx="150" cy="930" r="74"/><circle cx="150" cy="930" r="44"/><line x1="46" y1="930" x2="254" y2="930"/><line x1="150" y1="826" x2="150" y2="1034"/></g>` +
      `<text x="150" y="210" font-size="54" font-weight="900" letter-spacing="10" fill="#4DE1FF" ${F}>UP NEXT</text>` +
      `<rect x="152" y="238" width="150" height="6" fill="#4DE1FF"/>` +
      `<text x="820" y="210" font-size="54" font-weight="900" letter-spacing="10" fill="#B14DFF" ${F}>LATER</text>` +
      `<rect x="822" y="238" width="104" height="6" fill="#B14DFF"/>`,
    firstRow:
      `<text x="145" y="470" font-size="220" font-weight="900" fill="#ffffff" ${F}>{{time|fit=560|size=220}}</text>` +
      `<text x="150" y="545" font-size="60" font-weight="800" fill="#4DE1FF" ${F}>{{ampm}}</text>` +
      `<text x="150" y="660" font-size="72" font-weight="800" fill="#ffffff" ${F}>{{title|x=150|w=560|lines=3|lh=80}}</text>`,
    row:
      `<text x="820" y="0" font-size="60" font-weight="800" fill="#4DE1FF" ${F}>{{label}}</text>` +
      `<text x="820" y="74" font-size="66" font-weight="800" fill="#ffffff" ${F}>{{title|w=960}}</text>` +
      `<line x1="820" y1="120" x2="1780" y2="120" stroke="#26407a" stroke-width="4"/>`,
    empty: `<text x="150" y="470" font-size="96" font-weight="900" fill="#ffffff" ${F}>{{title|x=150|w=560|lines=2|lh=104}}</text>`,
  },
  // --- genre / network looks ---
  primetime: {
    label: "Prime Time", width: 1920, height: 1080, rowStart: 490, rowStep: 150, maxRows: 3,
    base:
      gradient("bg", "#0E1A3D", "#03060E") +
      `<polygon points="1100,0 1520,0 900,1080 480,1080" fill="#ffffff" opacity="0.035"/><polygon points="1600,0 1700,0 1080,1080 980,1080" fill="#ffffff" opacity="0.03"/>` +
      `<text x="180" y="200" font-size="44" font-weight="800" letter-spacing="10" fill="#D8B85A" ${F}>COMING UP NEXT</text>` +
      `<rect x="180" y="228" width="1560" height="3" fill="#D8B85A" opacity="0.7"/>` +
      `<text x="1740" y="1030" font-size="34" font-weight="800" fill="#D8B85A" opacity="0.75" text-anchor="end" letter-spacing="4" ${F}>${CHANNEL}</text>`,
    firstRow:
      `<text x="180" y="330" font-size="58" font-weight="800" fill="#D8B85A" ${F}>{{label}}</text>` +
      `<text x="180" y="450" font-size="104" font-weight="900" fill="#ffffff" ${F}>{{title|w=1560}}</text>`,
    row:
      `<line x1="180" y1="-62" x2="1740" y2="-62" stroke="#24305A" stroke-width="3"/>` +
      `<text x="180" y="0" font-size="52" font-weight="800" fill="#B8A267" ${F}>{{label}}</text>` +
      `<text x="480" y="0" font-size="62" font-weight="800" fill="#E6E9F2" ${F}>{{title|w=1260}}</text>`,
    empty: `<text x="180" y="450" font-size="96" font-weight="900" fill="#ffffff" ${F}>{{title|x=180|w=1560|lines=2|lh=104}}</text>`,
  },
  memphis: {
    label: "90s Memphis", width: 1920, height: 1080, rowStart: 450, rowStep: 150, maxRows: 4,
    base:
      `<rect width="1920" height="1080" fill="#FFF4E0"/>` +
      `<polygon points="1500,70 1650,320 1350,320" fill="#19B5B0"/>` +
      `<circle cx="1745" cy="170" r="92" fill="#FF3E8A"/>` +
      `<polyline points="1300,370 1350,330 1400,370 1450,330 1500,370 1550,330 1600,370" fill="none" stroke="#FFC93C" stroke-width="14" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<path d="M1660,330 q30,-40 60,0 t60,0 t60,0" fill="none" stroke="#1A1A2E" stroke-width="10" stroke-linecap="round"/>` +
      `<g fill="#1A1A2E">${Array.from({ length: 20 }, (_, i) => `<circle cx="${50 + (i % 4) * 30}" cy="${880 + Math.floor(i / 4) * 30}" r="6"/>`).join("")}</g>` +
      `<polygon points="100,60 140,130 60,130" fill="none" stroke="#FF3E8A" stroke-width="8" stroke-linejoin="round"/>` +
      `<text x="187" y="267" font-size="110" font-weight="900" fill="#FF3E8A" ${F}>COMING UP NEXT</text>` +
      `<text x="180" y="260" font-size="110" font-weight="900" fill="#1A1A2E" ${F}>COMING UP NEXT</text>` +
      `<text x="1740" y="1030" font-size="34" font-weight="800" fill="#1A1A2E" text-anchor="end" letter-spacing="4" ${F}>${CHANNEL}</text>`,
    row:
      `<rect x="186" y="-70" width="340" height="104" rx="18" fill="#1A1A2E"/>` +
      `<rect x="180" y="-76" width="340" height="104" rx="18" fill="#19B5B0"/>` +
      `<text x="350" y="0" font-size="54" font-weight="800" fill="#ffffff" text-anchor="middle" ${F}>{{label}}</text>` +
      `<text x="570" y="2" font-size="70" font-weight="900" fill="#1A1A2E" ${F}>{{title|w=1170}}</text>`,
    empty: listEmpty("#1A1A2E"),
  },
  retro: {
    label: "Retro 70s", width: 1920, height: 1080, rowStart: 450, rowStep: 140, maxRows: 4,
    base:
      `<rect width="1920" height="1080" fill="#F3E3C3"/>` +
      // rainbow stripes along the bottom, curving up the right edge
      ["#F6C445", "#F08A24", "#E0552B", "#6B3E26"].map((c, i) => {
        const r = 380 + i * 40;
        return `<path d="M0,${560 + r} H1500 A${r},${r} 0 0 0 ${1500 + r},560 V0" fill="none" stroke="${c}" stroke-width="41"/>`;
      }).join("") +
      `<text x="1740" y="140" font-size="34" font-weight="800" fill="#6B3E26" text-anchor="end" letter-spacing="4" ${F}>${CHANNEL}</text>` +
      `<text x="180" y="260" font-size="110" font-weight="900" fill="#4A2A17" ${F}>COMING UP NEXT</text>` +
      `<rect x="186" y="290" width="470" height="14" rx="7" fill="#E0552B"/>`,
    row:
      `<text x="180" y="0" font-size="64" font-weight="800" fill="#D9481F" ${F}>{{label}}</text>` +
      `<text x="560" y="0" font-size="70" font-weight="800" fill="#3B2414" ${F}>{{title|w=1160}}</text>` +
      `<line x1="180" y1="44" x2="1700" y2="44" stroke="#DCC59A" stroke-width="4"/>`,
    empty: listEmpty("#3B2414"),
  },
  casefile: {
    label: "Case File", width: 1920, height: 1080, rowStart: 460, rowStep: 160, maxRows: 3,
    base:
      `<rect width="1920" height="1080" fill="#15181D"/>` +
      `<g transform="translate(1500 950) rotate(-12)"><rect x="-760" y="-40" width="1700" height="80" fill="#F4C430"/>` +
      `<text x="-720" y="16" font-size="40" font-weight="900" letter-spacing="6" fill="#15181D" ${F}>POLICE LINE  ·  DO NOT CROSS  ·  POLICE LINE  ·  DO NOT CROSS</text></g>` +
      `<text x="180" y="140" font-size="44" font-weight="800" letter-spacing="10" fill="#F4C430" ${F}>CASE FILE</text>` +
      `<text x="180" y="260" font-size="110" font-weight="900" fill="#ffffff" ${F}>COMING UP NEXT</text>` +
      `<rect x="186" y="290" width="470" height="14" fill="#F4C430"/>` +
      `<text x="1740" y="140" font-size="34" font-weight="800" fill="#7A808C" text-anchor="end" letter-spacing="4" ${F}>${CHANNEL}</text>`,
    row:
      `<text x="180" y="0" font-size="64" font-weight="800" fill="#F4C430" ${F}>{{label}}</text>` +
      `<text x="560" y="0" font-size="70" font-weight="800" fill="#ffffff" ${F}>{{title|w=1180}}</text>` +
      `<line x1="180" y1="48" x2="1740" y2="48" stroke="#2A2F38" stroke-width="4"/>`,
    empty: listEmpty("#ffffff"),
  },
  lofi: {
    label: "Lo-fi Sunset", width: 1920, height: 1080, rowStart: 430, rowStep: 130, maxRows: 4,
    base:
      `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1E1636"/><stop offset="0.6" stop-color="#4E3266"/><stop offset="1" stop-color="#B9636F"/></linearGradient><clipPath id="sun"><circle cx="1620" cy="1045" r="165"/></clipPath></defs>` +
      `<rect width="1920" height="1080" fill="url(#bg)"/>` +
      `<g fill="#ffffff" opacity="0.6"><circle cx="1300" cy="120" r="3"/><circle cx="1480" cy="210" r="2"/><circle cx="1700" cy="90" r="3"/><circle cx="1840" cy="260" r="2"/><circle cx="1560" cy="340" r="2"/><circle cx="1150" cy="250" r="2"/></g>` +
      `<circle cx="1620" cy="1045" r="165" fill="#FFB38A"/>` +
      `<g fill="#B0606E" clip-path="url(#sun)"><rect x="1440" y="930" width="360" height="8"/><rect x="1440" y="958" width="360" height="11"/><rect x="1440" y="988" width="360" height="14"/></g>` +
      `<path d="M0,1020 Q320,965 640,1005 T1280,1010 T1920,1000 V1080 H0 Z" fill="#2E1E46"/>` +
      `<text x="180" y="250" font-size="104" font-weight="800" fill="#ffffff" ${F}>coming up next</text>` +
      `<text x="1740" y="140" font-size="36" font-weight="700" fill="#E9C7D8" text-anchor="end" letter-spacing="3" ${F}>{{channel|case=lower|w=900}}</text>`,
    row:
      `<text x="180" y="0" font-size="60" font-weight="700" fill="#FFC9A8" ${F}>{{label|case=lower}}</text>` +
      `<text x="540" y="0" font-size="68" font-weight="700" fill="#ffffff" ${F}>{{title|w=1200}}</text>` +
      `<line x1="180" y1="42" x2="1740" y2="42" stroke="#ffffff" stroke-opacity="0.14" stroke-width="3" stroke-linecap="round"/>`,
    empty: `<text x="180" y="520" font-size="72" font-weight="700" fill="#ffffff" ${F}>{{title|x=180|w=1560|lines=2|lh=80}}</text>`,
  },
  latenight: {
    label: "Late Night", width: 1920, height: 1080, rowStart: 440, rowStep: 130, maxRows: 4,
    base:
      `<rect width="1920" height="1080" fill="#000000"/>` +
      `<text x="180" y="260" font-size="72" font-weight="700" fill="#ffffff" ${F}>coming up</text>` +
      `<text x="180" y="1030" font-size="32" font-weight="700" fill="#5A5A5A" ${F}>{{channel|case=lower|w=1200}}</text>`,
    row:
      `<text x="180" y="0" font-size="48" font-weight="700" fill="#8A8A8A" ${F}>{{label|case=lower}}</text>` +
      `<text x="470" y="0" font-size="64" font-weight="700" fill="#ffffff" ${F}>{{title|w=1270}}</text>`,
    empty: `<text x="180" y="500" font-size="64" font-weight="700" fill="#ffffff" ${F}>{{title|x=180|w=1560|lines=2|lh=74}}</text>`,
  },
  sparkle: {
    label: "Sparkle Party", width: 1920, height: 1080, rowStart: 335, rowStep: 172, maxRows: 4,
    base:
      `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7B3FE4"/><stop offset="1" stop-color="#E84FB0"/></linearGradient></defs>` +
      `<rect width="1920" height="1080" fill="url(#bg)"/>` +
      // rainbow + clouds, top right
      ["#FF5FA8", "#FFA24C", "#FFE45C", "#7DF3D3", "#6EC8FF"].map((c, i) => {
        const r = 250 - i * 24;
        return `<path d="M${1690 - r},300 A${r},${r} 0 0 1 ${1690 + r},300" fill="none" stroke="${c}" stroke-width="25"/>`;
      }).join("") +
      cloud(1460, 290, 120) + cloud(1910, 290, 120) +
      sparkle(1240, 80, 26, "#ffffff") + sparkle(1110, 190, 16, "#FFE45C") + sparkle(1330, 200, 14, "#7DF3D3") +
      sparkle(95, 430, 28, "#FFE45C") + sparkle(120, 700, 18, "#ffffff") + sparkle(80, 900, 22, "#7DF3D3") +
      sparkle(1835, 560, 24, "#7DF3D3") + sparkle(1850, 800, 18, "#ffffff") + sparkle(1820, 1000, 26, "#FFE45C") +
      `<g fill="#FFC2E2" opacity="0.8">${heart(1880, 680, 44, 14)}${heart(70, 1020, 40, -12)}</g>` +
      `<text x="180" y="130" font-size="50" font-weight="900" letter-spacing="6" fill="#FFE45C" ${F}>{{channel|case=upper|w=1000}}</text>` +
      `<text x="186" y="256" font-size="104" font-weight="900" fill="#4B1F8F" opacity="0.55" ${F}>COMING UP NEXT</text>` +
      `<text x="180" y="250" font-size="104" font-weight="900" fill="#ffffff" ${F}>COMING UP NEXT</text>`,
    row:
      `<rect x="186" y="8" width="1560" height="148" rx="74" fill="#4B1F8F" opacity="0.35"/>` +
      `<rect x="180" y="0" width="1560" height="148" rx="74" fill="#ffffff"/>` +
      `<rect x="200" y="19" width="320" height="110" rx="55" fill="#FF4FA3"/>` +
      `<text x="360" y="93" font-size="52" font-weight="800" fill="#ffffff" text-anchor="middle" ${F}>{{label}}</text>` +
      `<text x="560" y="96" font-size="64" font-weight="800" fill="#4B1F8F" ${F}>{{title|w=1140}}</text>`,
    empty:
      `<rect x="180" y="420" width="1560" height="148" rx="74" fill="#ffffff"/>` +
      `<text x="240" y="516" font-size="64" font-weight="800" fill="#4B1F8F" ${F}>{{title|w=1440}}</text>`,
  },
  // --- holidays ---
  newyear: {
    label: "New Year's Eve", width: 1920, height: 1080, rowStart: 450, rowStep: 150, maxRows: 4,
    base:
      `<rect width="1920" height="1080" fill="#0B0E1F"/>` +
      burst(1590, 200, 140, 16, "#E8C35A") + burst(1840, 120, 62, 12, "#C9CED9") + burst(1360, 110, 56, 10, "#F28DB2") +
      `<g opacity="0.8"><rect x="1240" y="300" width="14" height="26" rx="3" fill="#E8C35A" transform="rotate(25 1247 313)"/><rect x="1420" y="380" width="14" height="26" rx="3" fill="#F28DB2" transform="rotate(-30 1427 393)"/><rect x="1700" y="60" width="14" height="26" rx="3" fill="#C9CED9" transform="rotate(40 1707 73)"/><rect x="1860" y="180" width="14" height="26" rx="3" fill="#E8C35A" transform="rotate(-15 1867 193)"/><circle cx="1500" cy="420" r="7" fill="#E8C35A"/><circle cx="1880" cy="60" r="6" fill="#F28DB2"/><circle cx="1230" cy="200" r="6" fill="#C9CED9"/></g>` +
      greeting("HAPPY NEW YEAR", "#E8C35A") + heading("#ffffff", "#E8C35A") +
      `<text x="1740" y="1030" font-size="34" font-weight="800" fill="#E8C35A" opacity="0.8" text-anchor="end" letter-spacing="4" ${F}>${CHANNEL}</text>`,
    row:
      `<text x="180" y="0" font-size="64" font-weight="800" fill="#E8C35A" ${F}>{{label}}</text>` +
      `<text x="560" y="0" font-size="70" font-weight="800" fill="#ffffff" ${F}>{{title|w=1180}}</text>` +
      `<line x1="180" y1="44" x2="1740" y2="44" stroke="#262A44" stroke-width="4"/>`,
    empty: listEmpty("#ffffff"),
  },
  valentine: {
    label: "Valentine's Day", width: 1920, height: 1080, rowStart: 450, rowStep: 150, maxRows: 4,
    base:
      gradient("bg", "#E0245E", "#9E1035") +
      `<g fill="#ffffff" opacity="0.14">${heart(1680, 230, 280, -12)}${heart(1870, 110, 120, 16)}${heart(1850, 520, 110, 10)}${heart(1430, 110, 80, -22)}${heart(1820, 900, 90, -8)}</g>` +
      greeting("HAPPY VALENTINE'S DAY", "#FFD1DE") + heading("#ffffff", "#ffffff") +
      `<text x="1740" y="1030" font-size="34" font-weight="800" fill="#ffffff" opacity="0.8" text-anchor="end" letter-spacing="4" ${F}>${CHANNEL}</text>`,
    row:
      `<rect x="180" y="-76" width="340" height="104" rx="52" fill="#ffffff"/>` +
      `<text x="350" y="0" font-size="54" font-weight="800" fill="#C8174B" text-anchor="middle" ${F}>{{label}}</text>` +
      `<text x="560" y="2" font-size="70" font-weight="800" fill="#ffffff" ${F}>{{title|w=1180}}</text>`,
    empty: listEmpty("#ffffff"),
  },
  stpatricks: {
    label: "St. Patrick's Day", width: 1920, height: 1080, rowStart: 450, rowStep: 150, maxRows: 4,
    base:
      gradient("bg", "#0E7A40", "#06492A") +
      `<g opacity="0.16">${shamrock(1660, 200, 120, "#ffffff", 12)}${shamrock(1860, 420, 60, "#ffffff", -18)}${shamrock(1430, 110, 44, "#ffffff", 30)}${shamrock(1830, 900, 56, "#ffffff", 8)}</g>` +
      greeting("HAPPY ST. PATRICK'S DAY", "#FFD45C") + heading("#ffffff", "#FFD45C") +
      `<text x="1740" y="1030" font-size="34" font-weight="800" fill="#ffffff" opacity="0.75" text-anchor="end" letter-spacing="4" ${F}>${CHANNEL}</text>`,
    row:
      `<text x="180" y="0" font-size="64" font-weight="800" fill="#FFD45C" ${F}>{{label}}</text>` +
      `<text x="560" y="0" font-size="70" font-weight="800" fill="#ffffff" ${F}>{{title|w=1180}}</text>` +
      `<line x1="180" y1="44" x2="1740" y2="44" stroke="#ffffff" stroke-opacity="0.18" stroke-width="4"/>`,
    empty: listEmpty("#ffffff"),
  },
  easter: {
    label: "Easter", width: 1920, height: 1080, rowStart: 330, rowStep: 230, maxRows: 3,
    base:
      `<rect width="1920" height="1080" fill="#F3EEFC"/>` +
      egg(1490, 170, 170, "#F7A8C2") + egg(1640, 150, 210, "#8FCDEB") + egg(1790, 175, 165, "#F5CF5C") +
      `<text x="180" y="120" font-size="44" font-weight="800" letter-spacing="8" fill="#9B7FD1" ${F}>HAPPY EASTER</text>` +
      `<text x="180" y="230" font-size="104" font-weight="900" fill="#4A3570" ${F}>COMING UP NEXT</text>`,
    row:
      `<rect x="186" y="8" width="1560" height="190" rx="44" fill="#E2D6F5"/>` +
      `<rect x="180" y="0" width="1560" height="190" rx="44" fill="#ffffff"/>` +
      `<rect x="215" y="40" width="330" height="110" rx="55" fill="#9B7FD1"/>` +
      `<text x="380" y="112" font-size="54" font-weight="800" fill="#ffffff" text-anchor="middle" ${F}>{{label}}</text>` +
      `<text x="600" y="115" font-size="72" font-weight="800" fill="#3B2E5A" ${F}>{{title|w=1100}}</text>`,
    empty:
      `<rect x="180" y="420" width="1560" height="190" rx="44" fill="#ffffff"/>` +
      `<text x="230" y="535" font-size="72" font-weight="800" fill="#3B2E5A" ${F}>{{title|w=1460}}</text>`,
  },
  july4: {
    label: "Fourth of July", width: 1920, height: 1080, rowStart: 430, rowStep: 140, maxRows: 4,
    base:
      `<rect width="1920" height="1080" fill="#0B1E45"/>` +
      burst(1600, 210, 150, 16, "#E8384F") + burst(1840, 120, 66, 12, "#ffffff") + burst(1370, 120, 60, 10, "#7FB2FF") +
      `<g fill="#ffffff" opacity="0.85">${star(1240, 330, 14)}${star(1860, 300, 12)}${star(1460, 420, 10)}${star(1720, 560, 12)}</g>` +
      // flag stripes along the bottom
      `<rect y="940" width="1920" height="140" fill="#ffffff"/>` +
      `<g fill="#C8102E"><rect y="940" width="1920" height="20"/><rect y="980" width="1920" height="20"/><rect y="1020" width="1920" height="20"/><rect y="1060" width="1920" height="20"/></g>` +
      greeting("HAPPY 4TH OF JULY", "#E8384F") + heading("#ffffff", "#C8102E"),
    row:
      `<rect x="180" y="-76" width="340" height="104" rx="52" fill="#ffffff"/>` +
      `<text x="350" y="0" font-size="54" font-weight="800" fill="#0B1E45" text-anchor="middle" ${F}>{{label}}</text>` +
      `<text x="560" y="2" font-size="70" font-weight="800" fill="#ffffff" ${F}>{{title|w=1180}}</text>`,
    empty: listEmpty("#ffffff"),
  },
  halloween: {
    label: "Halloween", width: 1920, height: 1080, rowStart: 450, rowStep: 150, maxRows: 4,
    base:
      gradient("bg", "#2A1244", "#120A1E") +
      `<circle cx="1640" cy="210" r="130" fill="#FFE9A8"/>` +
      `<g fill="#E8D08A" opacity="0.6"><circle cx="1600" cy="180" r="22"/><circle cx="1680" cy="250" r="14"/><circle cx="1690" cy="160" r="10"/></g>` +
      `<g fill="#0B0612">${bat(1430, 170, 120, -10)}${bat(1810, 340, 80, 12)}${bat(1500, 330, 64, -4)}</g>` +
      pumpkin(1680, 1020, 104) + pumpkin(1820, 1030, 82) +
      greeting("HAPPY HALLOWEEN", "#FF8A2A") + heading("#ffffff", "#FF8A2A") +
      `<text x="180" y="1030" font-size="34" font-weight="800" fill="#B79BD6" letter-spacing="4" ${F}>{{channel|case=upper|w=1200}}</text>`,
    row:
      `<text x="180" y="0" font-size="64" font-weight="800" fill="#FF8A2A" ${F}>{{label}}</text>` +
      `<text x="560" y="0" font-size="70" font-weight="800" fill="#ffffff" ${F}>{{title|w=1180}}</text>` +
      `<line x1="180" y1="44" x2="1740" y2="44" stroke="#3E2860" stroke-width="4"/>`,
    empty: listEmpty("#ffffff"),
  },
  thanksgiving: {
    label: "Thanksgiving", width: 1920, height: 1080, rowStart: 330, rowStep: 230, maxRows: 3,
    base:
      gradient("bg", "#4A2C17", "#2B180C") +
      leaf(1480, 150, 70, -35, "#C1440E") + leaf(1620, 120, 86, 20, "#E0A526") + leaf(1770, 170, 74, 60, "#8C1C13") +
      leaf(1860, 70, 50, -10, "#D9731A") + leaf(1360, 70, 44, 50, "#E0A526") +
      `<text x="180" y="120" font-size="44" font-weight="800" letter-spacing="8" fill="#E0A526" ${F}>HAPPY THANKSGIVING</text>` +
      `<text x="180" y="230" font-size="104" font-weight="900" fill="#F7ECD9" ${F}>COMING UP NEXT</text>`,
    row:
      `<rect x="180" y="0" width="1560" height="190" rx="44" fill="#F7ECD9"/>` +
      `<rect x="215" y="40" width="330" height="110" rx="55" fill="#B5471B"/>` +
      `<text x="380" y="112" font-size="54" font-weight="800" fill="#ffffff" text-anchor="middle" ${F}>{{label}}</text>` +
      `<text x="600" y="115" font-size="72" font-weight="800" fill="#3B2414" ${F}>{{title|w=1100}}</text>`,
    empty:
      `<rect x="180" y="420" width="1560" height="190" rx="44" fill="#F7ECD9"/>` +
      `<text x="230" y="535" font-size="72" font-weight="800" fill="#3B2414" ${F}>{{title|w=1460}}</text>`,
  },
  christmas: {
    label: "Christmas", width: 1920, height: 1080, rowStart: 440, rowStep: 140, maxRows: 4,
    base:
      gradient("bg", "#14603A", "#0A3A22") +
      `<g opacity="0.3">${snowflake(1620, 200, 110)}${snowflake(1830, 380, 60)}${snowflake(1400, 110, 44)}${snowflake(1860, 110, 34)}${snowflake(1480, 360, 30)}</g>` +
      `<g fill="#ffffff"><ellipse cx="380" cy="1130" rx="760" ry="150"/><ellipse cx="1520" cy="1140" rx="820" ry="170"/></g>` +
      greeting("MERRY CHRISTMAS", "#F2C94C") + heading("#ffffff", "#D7263D") +
      `<text x="1740" y="1045" font-size="34" font-weight="800" fill="#14603A" text-anchor="end" letter-spacing="4" ${F}>${CHANNEL}</text>`,
    row:
      `<rect x="180" y="-76" width="340" height="104" rx="52" fill="#C8102E"/>` +
      `<text x="350" y="0" font-size="54" font-weight="800" fill="#ffffff" text-anchor="middle" ${F}>{{label}}</text>` +
      `<text x="560" y="2" font-size="70" font-weight="800" fill="#ffffff" ${F}>{{title|w=1180}}</text>`,
    empty: listEmpty("#ffffff"),
  },
};

function esc(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Greedy word-wrap into at most `maxLines` lines of ~`max` characters. */
function wrapLines(text: string, max: number, maxLines: number): string[] {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > max) {
      lines.push(cur); cur = w;
      if (maxLines && lines.length >= maxLines) { cur = ""; break; }
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur && (!maxLines || lines.length < maxLines)) lines.push(cur);
  return lines.length ? lines : [String(text)];
}

// Advance widths of Arial Bold (what the cards render with), per 1000 em, so text
// can be sized to the space it has. Anything not listed counts as 600 (722 for
// other capitals). The renderer draws weights above 700 heavier: measured about
// 14.5% wider (WEIGHT_SCALE, which also leaves ~1.5% slack).
const ARIAL_BOLD: Record<string, number> = {
  " ": 278, "!": 333, '"': 474, "#": 556, $: 556, "%": 889, "&": 722, "'": 238, "’": 278, "(": 333, ")": 333, "*": 389, "+": 584,
  ",": 278, "-": 333, ".": 278, "/": 278, ":": 333, ";": 333, "?": 611, "@": 975, "…": 1000,
  0: 556, 1: 556, 2: 556, 3: 556, 4: 556, 5: 556, 6: 556, 7: 556, 8: 556, 9: 556,
  A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556, K: 722, L: 611, M: 833,
  N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278, k: 556, l: 278, m: 889,
  n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333, u: 611, v: 556, w: 778, x: 556, y: 556, z: 500,
};
const WEIGHT_SCALE = (weight: number) => (weight > 700 ? 1.16 : 1.02);
function textWidth(s: string, size: number, spacing = 0, weight = 800): number {
  let u = 0, n = 0;
  for (const c of s) { u += ARIAL_BOLD[c] ?? (/\p{Lu}/u.test(c) ? 722 : 600); n++; }
  return (u / 1000) * size * WEIGHT_SCALE(weight) + spacing * Math.max(0, n - 1);
}

/** Split words into `n` lines whose widest line is as narrow as possible (no
 *  lone short word on a line of its own). */
function balanceLines(words: string[], n: number, width: (s: string) => number): string[] {
  let best: string[] = [words.join(" ")], bestW = Infinity;
  const go = (from: number, left: number, acc: string[]) => {
    if (left === 1) {
      const lines = [...acc, words.slice(from).join(" ")];
      const w = Math.max(...lines.map(width));
      if (w < bestW) { bestW = w; best = lines; }
      return;
    }
    for (let i = from + 1; i <= words.length - (left - 1); i++) go(i, left - 1, [...acc, words.slice(from, i).join(" ")]);
  };
  if (words.length >= n) go(0, n, []);
  return best;
}

/** Text sized to `w` px (see TOKEN): one line, shrunk if needed; or, with
 *  lines>1, balanced lines when one line would shrink too far. `el` is the
 *  enclosing <text>'s size, weight and letter-spacing (the token can override). */
function fitText(s: string, opts: Record<string, string>, el: { size: number; weight: number; ls: number }): string {
  const w = Number(opts.w), size = Number(opts.size) || el.size, min = Number(opts.min) || 0.6, ls = opts.ls != null ? Number(opts.ls) : el.ls;
  const maxLines = Math.max(1, Number(opts.lines) || 1), lh = Number(opts.lh) || Math.round(size * 1.1), x = opts.x ?? "0";
  const width = (t: string, k = 1) => textWidth(t, size * k, ls * k, el.weight);
  const sized = (k: number, inner: string) => (k >= 0.999 ? inner : `<tspan font-size="${Math.round(size * k * 10) / 10}">${inner}</tspan>`);
  const cut = (t: string, k: number) => { // shorten with an ellipsis to fit at scale k
    let out = t;
    while (out.length > 1 && width(out + "…", k) > w) out = out.slice(0, -1);
    return out === t ? t : out.replace(/[\s,:;–-]+$/, "") + "…";
  };
  const words = s.split(/\s+/).filter(Boolean);
  const oneK = Math.min(1, w / Math.max(1, width(s)));
  // a single line reads best: keep it unless it would shrink well below full size
  if (oneK >= 0.999 || maxLines === 1 || words.length < 2 || oneK >= 0.85) {
    const k = Math.max(min, oneK), t = oneK >= min ? s : cut(s, min);
    if (k >= 0.999) return esc(t);
    // smaller text rises to keep the same visual middle (capitals are ~0.72 em tall)
    return `<tspan font-size="${Math.round(size * k * 10) / 10}" dy="${-Math.round(size * (1 - k) * 0.36 * 10) / 10}">${esc(t)}</tspan>`;
  }
  // balanced lines: pick the line count that keeps the text largest
  let pick = { lines: [s], k: oneK };
  for (let n = 2; n <= Math.min(maxLines, words.length); n++) {
    const lines = balanceLines(words, n, (t) => width(t));
    const k = Math.min(1, w / Math.max(...lines.map((t) => width(t))));
    if (k > pick.k + 0.02) pick = { lines, k };
  }
  const k = Math.max(min, pick.k);
  const lines = pick.k >= min ? pick.lines : [...pick.lines.slice(0, -1), cut(pick.lines[pick.lines.length - 1], min)];
  return sized(k, lines.map((ln, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : Math.round(lh * k)}">${esc(ln)}</tspan>`).join(""));
}

// Tokens: {{title}} (plain), or sized to a column:
//   {{title|w=1100}}                    one line, shrunk to fit (down to min=0.6, then
//                                       cut short with "…")
//   {{title|x=150|w=560|lines=3|lh=80}} balanced lines when one line would shrink too
//                                       far; tspans re-anchored at x
//   The font size, weight and letter-spacing are read from the enclosing <text>
//   (size= / ls= override). case=upper|lower changes case first.
// Older themes may use {{title|x=150|lh=82|max=12|lines=3}} (wrap at `max` chars)
// or fit=WIDTH|size=N (squeeze the glyphs); both still work.
const TOKEN = /\{\{(label|title|time|ampm|channel)((?:\|[a-z]+=[^|}]*)*)\}\}/g;

type Fields = { label: string; title: string; time: string; ampm: string; channel: string };

/** Size, weight and letter-spacing of the <text> element a token sits in. */
function textStyleAt(tpl: string, offset: number): { size: number; weight: number; ls: number } {
  const start = tpl.lastIndexOf("<text", offset);
  const tag = start >= 0 ? tpl.slice(start, tpl.indexOf(">", start) + 1) : "";
  const attr = (n: string) => Number(tag.match(new RegExp(`\\b${n}="([\\d.]+)"`))?.[1]);
  return { size: attr("font-size") || 72, weight: attr("font-weight") || 400, ls: attr("letter-spacing") || 0 };
}

function fill(tpl: string, t: Fields): string {
  return tpl.replace(TOKEN, (_m, name: keyof Fields, optStr: string, offset: number) => {
    const opts: Record<string, string> = {};
    for (const kv of optStr.split("|")) { if (!kv) continue; const i = kv.indexOf("="); if (i > 0) opts[kv.slice(0, i)] = kv.slice(i + 1); }
    let val = t[name] ?? "";
    if (opts.case === "upper") val = val.toUpperCase();
    else if (opts.case === "lower") val = val.toLowerCase();
    if (opts.w) return fitText(String(val).trim(), opts, textStyleAt(tpl, offset));
    // fit=WIDTH (with size=FONTSIZE): shrink the text horizontally to fit WIDTH px
    // ONLY when it would be wider (so short values like "2:00" stay full size).
    const fit = opts.fit ? parseInt(opts.fit, 10) : 0;
    if (fit) {
      const size = opts.size ? parseInt(opts.size, 10) : 100;
      // rough advance width: digits/letters ~0.6em, ":" / space ~0.32em.
      let em = 0; for (const c of String(val)) em += /[:\s.]/.test(c) ? 0.32 : 0.6;
      return em * size > fit ? `<tspan textLength="${fit}" lengthAdjust="spacingAndGlyphs">${esc(val)}</tspan>` : esc(val);
    }
    const max = opts.max ? parseInt(opts.max, 10) : 0;
    if (!max) return esc(val);
    const x = opts.x ?? "0";
    const lh = opts.lh ? parseInt(opts.lh, 10) : 0;
    const maxLines = opts.lines ? parseInt(opts.lines, 10) : 2;
    // lines=1: keep it on a single line, clipping with an ellipsis if too long.
    if (maxLines <= 1) {
      const s = String(val);
      return esc(s.length > max ? `${s.slice(0, Math.max(1, max - 1)).replace(/\s+$/, "")}…` : s);
    }
    return wrapLines(val, max, maxLines).map((ln, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : lh}">${esc(ln)}</tspan>`).join("");
  });
}

function envelope(width: number, height: number, def: ThemeDef, inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${def.width} ${def.height}" preserveAspectRatio="none">${inner}</svg>`;
}

/** How a card shows a channel name: slug-style names ("cartoon-network") get
 *  spaces; names that already have spaces are kept as typed. */
export function channelDisplayName(name: string): string {
  const n = String(name ?? "").trim();
  return /\s/.test(n) ? n : n.replace(/[-_]+/g, " ");
}

/** Build the base + per-row inner SVG fragments for a theme. */
function buildInners(def: ThemeDef, rowsIn: UpNextRow[], channelName = ""): { baseInner: string; layerInners: string[] } {
  const rows = rowsIn.slice(0, def.maxRows ?? 6);
  const channel = channelDisplayName(channelName);
  const baseInner = fill(def.base, { label: "", title: "", time: "", ampm: "", channel });
  const layerInners: string[] = [];
  if (!rows.length) {
    layerInners.push(fill(def.empty ?? def.row, { label: "", title: "Stay tuned", time: "", ampm: "", channel }));
    return { baseInner, layerInners };
  }
  rows.forEach((r, i) => {
    const ampm = (r.label.match(/(AM|PM)$/i)?.[0] ?? "").toUpperCase();
    const t = { label: r.label, title: r.title, ampm, time: r.label.replace(/\s*(AM|PM)$/i, ""), channel };
    if (i === 0 && def.firstRow) layerInners.push(fill(def.firstRow, t));            // absolute coords
    else layerInners.push(`<g transform="translate(0 ${def.rowStart + i * def.rowStep})">${fill(def.row, t)}</g>`);
  });
  return { baseInner, layerInners };
}

/** Card as separate SVG layers (base + one per row) for native-fade animation. */
export function renderCardLayers(def: ThemeDef, opts: { width: number; height: number; rows: UpNextRow[]; channelName?: string }): { base: string; layers: string[] } {
  const { baseInner, layerInners } = buildInners(def, opts.rows, opts.channelName);
  return {
    base: envelope(opts.width, opts.height, def, baseInner),
    layers: layerInners.map((inner) => envelope(opts.width, opts.height, def, inner)),
  };
}

/** Whole card as one flat SVG (base + all rows), e.g. for previews. */
export function renderCardSvg(def: ThemeDef, opts: { width: number; height: number; rows: UpNextRow[]; channelName?: string }): string {
  const { baseInner, layerInners } = buildInners(def, opts.rows, opts.channelName);
  return envelope(opts.width, opts.height, def, baseInner + layerInners.join(""));
}

// --- file storage ------------------------------------------------------------
async function exists(p: string): Promise<boolean> { try { await access(p); return true; } catch { return false; } }

// Older seeded files printed "NICKELODEON" in the corner; they now show the
// channel's own name. Only that exact text is swapped, so edits are kept.
const OLD_CHANNEL_TEXT = ">NICKELODEON</text>";
const OLD_CHANNEL_TOKEN = ">{{channel|case=upper|max=30|lines=1}}</text>";

// Fingerprints (sha256) of earlier stock theme files. A file that still matches
// one was never edited, so it's replaced with the current design; edited files
// are left alone.
const STOCK_VERSIONS: Record<string, string[]> = {
  splat: ["82fc1aaa23e4c68a840ad27b7837b2d6fb89acbb7f1e4459deaed88af74bdaca"],
  slime: ["cc21a3d2b2b6027421ef1502e689d656c86d58e7ed6f30cf267cb7dad3b02eb1"],
  clock: ["2b0b28f3c1df63f10b8d2a87aef16ff80dce1a1a1ea633266fa2023b55aa7286", "4870135270d3d0c2f0642bba078719dcbc86eda65bd98d38b1c478bfb08410c7"],
  chips: ["6aace5de7e6d33af0946a6e5eee503c07917818374fdbc06c1f2d1768a5d3f40", "19cfe48a4fcace3cf52c3e04ea981aa57df267a6d9e9a7a355300ed2de5bbb5b"],
  "cn-checker": ["861f6fc987b5ce0ff795128c4859ff24839d2d42909840e0ba010908f7d0809f"],
  "cn-powerhouse": ["483e7928443cc05eba857dea4d1e55f1c6b06b215cab5deb4aacb7c12e4a100b"],
  toonami: ["b3eac3121e94d77ef6945f5e16f61f9b5ed906566fbb9a158ee93d63040fa010"],
};

/** Write the built-in default theme files into `dir` (only those not present),
 *  and bring unedited older ones up to the current design. */
export async function seedThemeFiles(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [id, def] of Object.entries(DEFAULT_THEMES)) {
    const p = join(dir, `${id}.json`);
    const stock = JSON.stringify(def, null, 2);
    if (!(await exists(p))) { await writeFile(p, stock, "utf8"); continue; }
    try {
      let raw = await readFile(p, "utf8");
      if (raw.includes(OLD_CHANNEL_TEXT)) {
        const theme = JSON.parse(raw);
        if (typeof theme.base !== "string") continue;
        theme.base = theme.base.split(OLD_CHANNEL_TEXT).join(OLD_CHANNEL_TOKEN);
        raw = JSON.stringify(theme, null, 2);
        await writeFile(p, raw, "utf8");
      }
      // (line endings don't count: git on Windows checks these files out as CRLF)
      const lf = raw.replace(/\r\n/g, "\n");
      if (lf !== stock && STOCK_VERSIONS[id]?.includes(createHash("sha256").update(lf).digest("hex"))) await writeFile(p, stock, "utf8");
    } catch { /* leave a file we can't read alone */ }
  }
}

/** Load a theme by id from `dir`, falling back to a built-in default. */
export async function loadTheme(dir: string, id: string): Promise<ThemeDef> {
  try {
    const raw = JSON.parse(await readFile(join(dir, `${id}.json`), "utf8"));
    // Merge over the matching default (or splat) so partial files still work.
    const base = DEFAULT_THEMES[id] ?? DEFAULT_THEMES.splat;
    return { ...base, ...raw };
  } catch {
    return DEFAULT_THEMES[id] ?? DEFAULT_THEMES.splat;
  }
}

/** List available themes (id + label) from the folder, seeding defaults first. */
export async function listThemes(dir: string): Promise<{ id: string; label: string }[]> {
  await seedThemeFiles(dir).catch(() => {});
  const out: { id: string; label: string }[] = [];
  try {
    for (const f of (await readdir(dir)).sort()) {
      if (!f.endsWith(".json")) continue;
      const id = f.replace(/\.json$/, "");
      let label = id;
      try { label = JSON.parse(await readFile(join(dir, f), "utf8")).label || id; } catch { /* keep id */ }
      out.push({ id, label });
    }
  } catch { /* fall through to defaults */ }
  if (!out.length) for (const [id, def] of Object.entries(DEFAULT_THEMES)) out.push({ id, label: def.label });
  return out;
}
