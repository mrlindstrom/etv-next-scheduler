// -----------------------------------------------------------------------------
// Fallback background image (ErsatzTV next 0.2.4+, channel config 0.1.3)
// -----------------------------------------------------------------------------
// When a channel has nothing to play (a gap in the playout) or an item fails,
// next shows `fallback.background_image` instead of black. Each channel picks:
//   ""         → the Streaming page's default
//   "black"    → plain black (next's own fallback)
//   "standby"  → a "We'll be right back" card drawn with the channel's logo/name
//   <a path>   → that image file
// Standby cards are rendered once per look to <runtime>/fallback/<name>-<hash>.png
// (the hash covers everything drawn, so a logo/name/size change makes a new file).

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import type { ChannelMeta, NextConfig } from "./config.js";
import { logoPath, sniffImage, textLogoSvg } from "./channel-logos.js";

/** A path as typed: surrounding quotes (from "Copy as path") and whitespace stripped. */
const cardAudioPath = (raw: string | undefined) => (raw || "").trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
const abs = (root: string, p: string) => (isAbsolute(p) || /^[A-Za-z]:/.test(p) ? p : join(root, p));
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const FONTS = [
  "C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeuib.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
];

export type FallbackChoice = { kind: "black" } | { kind: "standby" } | { kind: "image"; path: string };

/** What a channel's setting (or the default) means. */
export function fallbackChoice(meta: Pick<ChannelMeta, "fallbackImage"> | undefined, cfg: NextConfig): FallbackChoice {
  const own = cardAudioPath(meta?.fallbackImage);
  const v = own || cardAudioPath(cfg.fallbackImage) || "black";
  if (v === "black") return { kind: "black" };
  if (v === "standby") return { kind: "standby" };
  return { kind: "image", path: v };
}

/** Whether any channel ends up with an image (so the configs need next 0.2.4+). */
export function fallbackInUse(metas: Pick<ChannelMeta, "fallbackImage" | "enabled">[], cfg: NextConfig): boolean {
  return metas.some((m) => m.enabled && fallbackChoice(m, cfg).kind !== "black");
}

/** The standby card SVG: dark backdrop, the channel's logo (or its name tile), "We'll be right back". */
function standbySvg(name: string, logo: { data: Buffer; type: string } | null, w: number, h: number): string {
  const u = h / 1080; // design units are for 1080p
  const logoW = 520 * u, logoH = 300 * u, logoY = h * 0.2;
  const img = logo
    ? `<image href="data:${logo.type};base64,${logo.data.toString("base64")}" x="${(w - logoW) / 2}" y="${logoY}" width="${logoW}" height="${logoH}" preserveAspectRatio="xMidYMid meet"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><radialGradient id="bg" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="#1d2a44"/><stop offset="1" stop-color="#070a12"/></radialGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#bg)"/>` +
    img +
    `<g font-family="Arial, 'Segoe UI', 'DejaVu Sans', sans-serif" text-anchor="middle" fill="#fff">` +
    `<text x="${w / 2}" y="${h * 0.66}" font-size="${92 * u}" font-weight="700">We'll be right back</text>` +
    `<rect x="${w / 2 - 160 * u}" y="${h * 0.7}" width="${320 * u}" height="${5 * u}" rx="${2.5 * u}" fill="#4f8cff"/>` +
    `<text x="${w / 2}" y="${h * 0.78}" font-size="${40 * u}" fill="#aeb9cc">${xml(name)} · Please stand by</text>` +
    `</g></svg>`;
}

/** The channel's logo as an embeddable image: its stored file, or the name tile when there's none. */
function logoImage(meta: Pick<ChannelMeta, "name" | "logo">, logosDir: string): { data: Buffer; type: string } | null {
  const p = meta.logo ? logoPath(logosDir, meta.logo) : null;
  if (p && existsSync(p)) {
    try {
      const data = readFileSync(p);
      const k = sniffImage(data);
      if (k && k.ext !== "bmp") return { data, type: k.type }; // resvg can't embed BMP
    } catch { /* fall through to the name tile */ }
  }
  if (meta.logo && !p) return null; // an external URL: just the text
  return { data: Buffer.from(textLogoSvg(meta.name)), type: "image/svg+xml" };
}

/** Renders the standby card to PNG (null if resvg isn't installed). */
export async function renderStandby(meta: Pick<ChannelMeta, "name" | "logo">, logosDir: string, w: number, h: number): Promise<Buffer | null> {
  let Resvg: any;
  try { Resvg = (await import("@resvg/resvg-js")).Resvg; } catch { return null; }
  const svg = standbySvg(meta.name, logoImage(meta, logosDir), w, h);
  const opts = { font: { loadSystemFonts: true, fontFiles: FONTS.filter((f) => existsSync(f)), defaultFontFamily: "Arial" } };
  try { return Buffer.from(new Resvg(svg, opts).render().asPng()); }
  catch { return Buffer.from(new Resvg(standbySvg(meta.name, null, w, h), opts).render().asPng()); } // a logo resvg can't read
}

/**
 * The image path to write into a channel's config, or undefined for black.
 * Standby cards are rendered (once per look) into `fallbackDir`; a custom image
 * that doesn't exist on this machine falls back to black.
 */
export async function fallbackImageFor(meta: ChannelMeta, cfg: NextConfig, root: string, logosDir: string, fallbackDir: string): Promise<string | undefined> {
  const c = fallbackChoice(meta, cfg);
  if (c.kind === "black") return undefined;
  if (c.kind === "image") { const p = abs(root, c.path); return existsSync(p) ? p : undefined; }
  const w = cfg.video.width || 1920, h = cfg.video.height || 1080;
  const key = createHash("sha1").update(JSON.stringify([2, meta.name, meta.logo, w, h])).digest("hex").slice(0, 10);
  const safe = meta.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  const file = join(fallbackDir, `${safe}-${key}.png`);
  if (!existsSync(file)) {
    const png = await renderStandby(meta, logosDir, w, h);
    if (!png) return undefined;
    await mkdir(fallbackDir, { recursive: true });
    await writeFile(file, png);
  }
  return file;
}

/** Deletes standby cards no channel config points at any more. */
export function pruneFallbackDir(fallbackDir: string, inUse: Set<string>): void {
  if (!existsSync(fallbackDir)) return;
  for (const f of readdirSync(fallbackDir)) {
    const p = join(fallbackDir, f);
    if (f.endsWith(".png") && !inUse.has(p)) { try { unlinkSync(p); } catch { /* in use */ } }
  }
}
