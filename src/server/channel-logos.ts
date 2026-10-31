// -----------------------------------------------------------------------------
// Channel logos (legacy parity: ErsatzTV legacy keeps each channel's logo as an
// Artwork row, kind Logo, pointing at a file in its artwork cache).
//
// Logos are stored once each, named by content hash, in <runtime>/logos/, and a
// channel's `logo` setting is either "logos/<HASH>.<ext>" (a stored file) or an
// external http(s) URL. ErsatzTV next copies the lineup's `logo` verbatim into
// tvg-logo (M3U) and the XMLTV channel <icon>, so the lineup gets a URL clients
// can fetch: this server's /logos/<file>, at the address clients reach it on.
// -----------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { networkInterfaces } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";

export const MAX_LOGO_BYTES = 10 * 1024 * 1024;
const MANAGED = /^logos\/([0-9A-F]{32}\.(png|jpg|gif|webp|svg|bmp))$/;
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp" };

/** What image this is, from its bytes (uploads and legacy cache files have no
 *  trustworthy name/extension). Null if it isn't a supported image. */
export function sniffImage(b: Buffer): { ext: string; type: string } | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, k) => b[i + k] === x);
  let ext: string | null = null;
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) ext = "png";
  else if (at(0, 0xff, 0xd8, 0xff)) ext = "jpg";
  else if (at(0, 0x47, 0x49, 0x46, 0x38)) ext = "gif";
  else if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) ext = "webp";
  else if (at(0, 0x42, 0x4d)) ext = "bmp";
  else {
    const head = b.subarray(0, 1024).toString("utf8").replace(/^﻿/, "").trimStart();
    if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) ext = "svg";
  }
  return ext ? { ext, type: TYPES[ext] } : null;
}

export const isManagedLogo = (v: string | null | undefined): boolean => MANAGED.test(String(v ?? ""));
export const logoContentType = (file: string): string => TYPES[file.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

/** Store an image (deduplicated by content) and return its `logo` setting value. */
export async function saveLogo(dir: string, data: Buffer): Promise<string> {
  if (data.length > MAX_LOGO_BYTES) throw new Error(`The logo is too large (${(data.length / 1048576).toFixed(1)} MB; the limit is 10 MB).`);
  const kind = sniffImage(data);
  if (!kind) throw new Error("That file isn't a supported image (PNG, JPEG, GIF, WebP, SVG or BMP).");
  const file = `${createHash("md5").update(data).digest("hex").toUpperCase()}.${kind.ext}`;
  await mkdir(dir, { recursive: true });
  const dest = join(dir, file);
  if (!existsSync(dest)) await writeFile(dest, data);
  return `logos/${file}`;
}

/** The stored file for a `logos/<file>` value or a bare "<file>" (null if invalid). */
export function logoPath(dir: string, ref: string): string | null {
  const m = MANAGED.exec(ref.startsWith("logos/") ? ref : `logos/${ref}`);
  return m ? join(dir, m[1]) : null;
}

/** Delete stored logos no channel uses any more. */
export function pruneLogos(dir: string, inUse: Iterable<string>): number {
  if (!existsSync(dir)) return 0;
  const keep = new Set([...inUse].filter(isManagedLogo).map((v) => v.slice("logos/".length)));
  let n = 0;
  for (const f of readdirSync(dir)) if (MANAGED.test(`logos/${f}`) && !keep.has(f)) { try { unlinkSync(join(dir, f)); n++; } catch { /* in use */ } }
  return n;
}

/** This machine's LAN address — what other devices on the network reach it at.
 *  Prefers home-network ranges (192.168/10.x) over 172.16–31 (often a virtual
 *  adapter: WSL, Hyper-V, Docker). */
export function lanAddress(): string {
  const cands: string[] = [];
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) cands.push(a.address);
  const rank = (ip: string) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 3 : 2);
  return cands.sort((a, b) => rank(a) - rank(b))[0] ?? "127.0.0.1";
}

/** The address clients use to reach this scheduler: the setting, or the LAN address. */
export function schedulerBaseUrl(publicUrl: string | undefined, port: number): string {
  const set = (publicUrl ?? "").trim().replace(/\/+$/, "");
  if (set) return /^https?:\/\//i.test(set) ? set : `http://${set}`;
  return `http://${lanAddress()}:${port}`;
}

/** A channel's `logo` setting -> what the lineup publishes (tvg-logo / <icon>). */
export function publishedLogoUrl(logo: string | undefined, base: string): string {
  const v = (logo ?? "").trim();
  if (!v) return "";
  return isManagedLogo(v) ? `${base}/${v}` : v;
}

// ---- legacy ----------------------------------------------------------------
/** Legacy's logo cache: <legacy data dir>/cache/artwork/logos/<first 2>/<HASH>. */
export function legacyLogoFile(legacyDbPaths: string[], hash: string): string | null {
  if (!/^[0-9A-Fa-f]{32}$/.test(hash)) return null;
  for (const db of legacyDbPaths) {
    const p = join(dirname(db), "cache", "artwork", "logos", hash.slice(0, 2).toUpperCase(), hash.toUpperCase());
    if (existsSync(p)) return p;
    const lower = join(dirname(db), "cache", "artwork", "logos", hash.slice(0, 2), hash);
    if (existsSync(lower)) return lower;
  }
  return null;
}

/** Copy a legacy cached logo into the store; returns the `logo` value (or null). */
export async function importLegacyLogo(dir: string, file: string): Promise<string | null> {
  try { return await saveLogo(dir, await readFile(file)); } catch { return null; }
}

// ---- generated logos (legacy parity: legacy drew the channel name on a plain
// tile when a channel had no logo) ------------------------------------------
const FONT_CANDIDATES = [
  "C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/segoeuib.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
];
const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Split a name into 1–4 lines (at spaces, or after "-"/"_"), choosing the split
 *  that allows the largest text. */
function layoutName(name: string, box: number): { lines: string[]; size: number } {
  const words = name.trim().split(/\s+|(?<=[-_])(?=.)/).filter(Boolean);
  const CHAR_W = 0.6, LINE_H = 1.15; // bold-sans estimates, slightly generous
  const join = (ws: string[]) => ws.reduce((acc, w) => (acc && !/[-_]$/.test(acc) ? `${acc} ${w}` : acc + w), "");
  const fit = (lines: string[]) => Math.min(box / (Math.max(...lines.map((l) => l.length)) * CHAR_W), box / (lines.length * LINE_H), 170);
  // bigger text wins, but each extra line and any 1–2 character line costs a little
  const score = (lines: string[]) => fit(lines) * (1 - 0.08 * (lines.length - 1)) * (lines.length > 1 && lines.some((l) => l.length <= 2) ? 0.75 : 1);
  let best = { lines: [join(words)], size: fit([join(words)]), score: score([join(words)]) };
  // every way to cut the words into up to 4 lines (channel names are short)
  const cut = (from: number, lines: string[]) => {
    if (from === words.length) { const sc = score(lines); if (sc > best.score) best = { lines, size: fit(lines), score: sc }; return; }
    if (lines.length === 4) return;
    for (let to = from + 1; to <= words.length; to++) cut(to, [...lines, join(words.slice(from, to))]);
  };
  cut(0, []);
  return best;
}

/** The SVG for a channel-name logo: the name in white on a colour picked from the name. */
export function textLogoSvg(name: string): string {
  const S = 512, PAD = 44;
  let h = 0; for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  const hue = h % 360;
  const { lines, size } = layoutName(name || "?", S - PAD * 2);
  const lh = size * 1.15, top = S / 2 - ((lines.length - 1) * lh) / 2;
  const text = lines.map((l, i) => `<text x="${S / 2}" y="${(top + i * lh).toFixed(1)}">${xmlEscape(l)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,38%)"/><stop offset="1" stop-color="hsl(${hue},60%,24%)"/></linearGradient></defs>` +
    `<rect x="8" y="8" width="${S - 16}" height="${S - 16}" rx="56" fill="url(#g)"/>` +
    `<g fill="#fff" font-family="Arial, 'Segoe UI', 'DejaVu Sans', sans-serif" font-weight="700" font-size="${size.toFixed(1)}" text-anchor="middle" dominant-baseline="central">${text}</g></svg>`;
}

/** Render a channel-name logo to PNG (null if the rasteriser isn't installed). */
export async function generateTextLogo(name: string): Promise<Buffer | null> {
  let Resvg: any;
  try { Resvg = (await import("@resvg/resvg-js")).Resvg; } catch { return null; }
  const fontFiles = FONT_CANDIDATES.filter((f) => existsSync(f));
  return Buffer.from(new Resvg(textLogoSvg(name), { font: { loadSystemFonts: true, fontFiles, defaultFontFamily: "Arial" } }).render().asPng());
}

interface LogoStore {
  channelMetas(): { name: string; logo: string; logoGenerated: boolean }[];
  upsertChannelMeta(name: string, patch: { logo: string; logoGenerated: boolean }): unknown;
}

/** A logo that came from you or legacy (generated ones may be replaced freely). */
export const hasRealLogo = (m: { logo?: string; logoGenerated?: boolean } | null | undefined): boolean => !!m?.logo && !m.logoGenerated;

/** Draw and store a channel-name logo for one channel; returns its `logo` value. */
export async function setGeneratedLogo(store: LogoStore, dir: string, name: string): Promise<string | null> {
  const png = await generateTextLogo(name);
  if (!png) return null;
  const logo = await saveLogo(dir, png);
  store.upsertChannelMeta(name, { logo, logoGenerated: true });
  return logo;
}

/** Give every listed channel (default: all) that has no logo a generated one, the
 *  way legacy shows the channel name when no logo is set. Returns the names filled. */
export async function fillMissingLogos(store: LogoStore, dir: string, names?: Iterable<string>): Promise<string[]> {
  const want = names ? new Set(names) : null;
  const done: string[] = [];
  for (const m of store.channelMetas()) {
    if (m.logo || (want && !want.has(m.name))) continue;
    if (await setGeneratedLogo(store, dir, m.name)) done.push(m.name);
  }
  return done;
}
