// -----------------------------------------------------------------------------
// Live "coming up next" graphics-canvas endpoint.
// -----------------------------------------------------------------------------
// ErsatzTV next's graphics engine (schema 0.0.4) lets a playout item carry a
// `graphics` layer of `kind: "canvas"` — a full-frame RGBA layer composited over
// the primary content. When that layer's source is HTTP, next streams it live
// and injects timing headers (x-etv-channel, x-etv-offset-ms, x-etv-duration-ms,
// x-etv-frame-rate).
//
// The scheduler emits one such card at the end of every break (see
// engine.emitUpNextCard) with a URL that encodes the channel number and the
// anchor time (= the next show's start). This endpoint reads that channel's
// XMLTV guide, finds the next few programmes at/after the anchor, and renders a
// full-screen "COMING UP NEXT" card listing them with time-only stamps (no date,
// no timezone). The card is streamed as an ffv1/bgra NUT stream, which is exactly
// what next's canvas path consumes.

import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import type { ConfigStore } from "./config.js";
import { parseXmltvTime } from "../xmltv.js";
import { renderCardLayers, renderCardSvg, loadTheme, listThemes, seedThemeFiles } from "./upnext-themes.js";
import { seedGuideThemes, listGuideThemes } from "../guide.js";
import { localParts, type Tz } from "../time.js";

// 1x1 transparent PNG — served if the SVG rasterizer isn't installed, so a
// missing dependency degrades to "no card" rather than breaking the playout item.
const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64");

interface UpNextRow { epochMs: number; label: string; title: string }

// Lazy, cached resolver for the SVG rasterizer. `undefined` = not tried yet,
// `null` = tried and unavailable (falls back to a transparent PNG).
let ResvgCtor: any = undefined;
async function getResvg(): Promise<any | null> {
  if (ResvgCtor !== undefined) return ResvgCtor;
  try { ResvgCtor = (await import("@resvg/resvg-js")).Resvg; }
  catch { ResvgCtor = null; }
  return ResvgCtor;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** Format a wall-clock HH/MM (already channel-local, taken straight from the
 *  XMLTV timestamp) as a friendly 12-hour time, e.g. "8:00 PM". */
function twelveHour(hh: number, mm: number): string {
  const ampm = hh >= 12 ? "PM" : "AM";
  let h = hh % 12; if (h === 0) h = 12;
  return `${h}:${String(mm).padStart(2, "0")} ${ampm}`;
}

/** Parse a channel's XMLTV and return the next `count` programmes at/after
 *  `anchorMs`. Labels are local time in `tz` (a passed-through remote guide may
 *  be stamped in UTC or another zone). */
export async function upcoming(xmltvPath: string, tz: Tz, anchorMs: number, count: number): Promise<(UpNextRow & { epochMs: number })[]> {
  let xml = "";
  try { xml = await readFile(xmltvPath, "utf8"); } catch { return []; }
  const rows: (UpNextRow & { epochMs: number })[] = [];
  const re = /<programme\b[^>]*\bstart="(\d{14}[^"]*)"[^>]*>([\s\S]*?)<\/programme>/g;
  for (const m of xml.matchAll(re)) {
    const stamp = m[1];
    const epochMs = parseXmltvTime(stamp, tz);
    if (!Number.isFinite(epochMs)) continue;
    // 1s of slack so the immediate next show (whose start == anchor) is included.
    if (epochMs < anchorMs - 1000) continue;
    const tm = m[2].match(/<title\b[^>]*>([\s\S]*?)<\/title>/);
    const title = tm ? decodeEntities(tm[1]).trim() : "";
    if (!title) continue;
    const lp = localParts(epochMs, tz);
    rows.push({ epochMs, label: twelveHour(lp.h, lp.mi), title });
  }
  rows.sort((a, b) => a.epochMs - b.epochMs);
  // de-duplicate consecutive identical (title,time) rows (guide merges can double up)
  const out: (UpNextRow & { epochMs: number })[] = [];
  for (const r of rows) {
    const prev = out[out.length - 1];
    if (prev && prev.title === r.title && prev.label === r.label) continue;
    out.push(r);
    if (out.length >= count) break;
  }
  return out;
}

/** Candidate fonts for the card text; the first that exists on disk is used. */
function resolveFont(preferred: string): string | undefined {
  const candidates = [
    preferred,
    "C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/segoeui.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  ].filter(Boolean) as string[];
  for (const c of candidates) { try { if (existsSync(c)) return c; } catch { /* skip */ } }
  return undefined;
}

export function registerGraphicsRoutes(app: FastifyInstance, store: ConfigStore, root: string): void {
  const absUnder = (p: string) => (isAbsolute(p) || /^[A-Za-z]:/.test(p) ? p : join(root, p));
  const themesDir = () => join(absUnder(store.getNextConfig().runtimeDir), "upnext-themes");

  const guideThemesDir = () => join(absUnder(store.getNextConfig().runtimeDir), "guide-themes");

  // Seed the editable default theme files on startup (only those missing).
  seedThemeFiles(themesDir()).catch(() => {});
  seedGuideThemes(guideThemesDir()).catch(() => {});

  // Theme lists for the dropdowns — read the folders, so custom themes appear.
  app.get("/api/upnext/themes", async () => listThemes(themesDir()));
  app.get("/api/guide/themes", async () => listGuideThemes(guideThemesDir()));

  // Serve one PNG layer of the card. next fetches these as `media` graphics
  // layers and fades them natively via each layer's timing. `layer` selects the
  // element: "base" (background + heading), an integer row index, or "all" (the
  // whole flattened card — handy for previewing a theme in a browser).
  app.get("/graphics/upnext.png", async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string>;
    const h = req.headers as Record<string, string | undefined>;
    const cfg = store.getNextConfig();
    const app_ = store.get();
    const debug = q.debug === "1" || q.debug === "true";

    const ch = String(q.ch ?? h["x-etv-channel"] ?? "").trim();
    const theme = String(q.theme || "splat");
    const count = Math.max(1, Math.min(6, Number(q.n) || cfg.upNext.count || 3));
    const width = Math.max(16, Number(q.w) || cfg.video.width || 1920);
    const height = Math.max(16, Number(q.h) || cfg.video.height || 1080);
    const anchorMs = Number(q.at) || Date.now();
    const layerParam = String(q.layer ?? "all");

    // by name first (stable), then by number (cards built before names were sent;
    // a renumber can point an old number at a different channel)
    const byName = String(q.c ?? "").trim().toLowerCase();
    const metas = store.channelMetas();
    const meta = (byName && metas.find((c) => c.name.toLowerCase() === byName)) || metas.find((c) => c.number === ch);
    const tvgId = meta?.tvgId || meta?.name || ch;
    const xmltvPath = join(absUnder(cfg.runtimeDir), "xmltv", `${tvgId}.xml`);
    const rows = await upcoming(xmltvPath, app_.tz, anchorMs, count);
    const fontPath = resolveFont(cfg.upNext.fontFile);

    // Pick the SVG for the requested layer (null => an out-of-range row => blank).
    const def = await loadTheme(themesDir(), theme);
    const channelName = meta?.name ?? String(q.c ?? "").trim();
    const { base, layers } = renderCardLayers(def, { width, height, rows, channelName });
    let svg: string | null;
    if (layerParam === "all") svg = renderCardSvg(def, { width, height, rows, channelName });
    else if (layerParam === "base") svg = base;
    else { const k = Number(layerParam); svg = Number.isInteger(k) && k >= 0 && k < layers.length ? layers[k] : null; }

    const Resvg = await getResvg();
    let png: Buffer | null = null;
    let renderErr = "";
    if (Resvg && svg) {
      try {
        const r = new Resvg(svg, { font: { loadSystemFonts: true, ...(fontPath ? { fontFiles: [fontPath] } : {}) } });
        png = Buffer.from(r.render().asPng());
      } catch (e) { renderErr = (e as Error).message; req.log.warn(`upnext png render failed: ${renderErr}`); }
    }

    if (debug) {
      return reply.header("content-type", "application/json").send({
        ok: png != null, resvgAvailable: Resvg != null, theme, layer: layerParam,
        layerCount: layers.length, outputBytes: png ? png.length : 0,
        fontResolved: fontPath ?? null, channel: ch, tvgId, xmltvPath,
        xmltvExists: existsSync(xmltvPath), anchorMs, rows, renderErr,
        hint: Resvg == null ? "Install @resvg/resvg-js (npm install) for themed cards." : undefined,
      });
    }

    reply.header("cache-control", "no-store");
    reply.header("content-type", "image/png");
    // If the rasterizer is missing or the row is out of range, return a 1x1
    // transparent PNG so the graphics layer simply shows nothing (no broken item).
    return reply.send(png ?? TRANSPARENT_PNG);
  });
}
