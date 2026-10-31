// -----------------------------------------------------------------------------
// Enriched XMLTV generation
// -----------------------------------------------------------------------------
// Writes a per-channel `{tvg_id}.xml` containing <programme> entries. ErsatzTV
// next's server (ersatztv.exe) reads this file and copies the programmes verbatim
// into the guide it serves at /xmltv.xml (it preserves title, sub-title, desc,
// category, episode-num, icon, rating). next's own generator only writes a title;
// this produces a legacy-quality guide instead.

import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { GuideEntry } from "./engine.js";
import type { ContentResolver } from "./resolver.js";
import { offsetAt, localToEpoch, type Tz } from "./time.js";

/** XMLTV timestamp: "YYYYMMDDHHMMSS ±HHMM" (matches next's format), with the
 *  zone's offset at that instant (so -0500 before a fall-back change, -0600 after). */
export function formatXmltvTime(ms: number, tz: Tz): string {
  const off = offsetAt(ms, tz);
  const d = new Date(ms + off * 60000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const sign = off >= 0 ? "+" : "-";
  const ao = Math.abs(off);
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} ${sign}${p(Math.floor(ao / 60))}${p(ao % 60)}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Render a full <tv> document with one <programme> per guide entry. */
export function renderChannelXmltv(tvgId: string, entries: GuideEntry[], tz: Tz, resolver?: ContentResolver): string {
  const lines: string[] = [`<?xml version="1.0" encoding="UTF-8"?>`, `<tv generator-info-name="tv-next-scheduler">`];
  for (const e of entries) {
    const it = e.item;
    const start = formatXmltvTime(e.startMs, tz);
    const stop = formatXmltvTime(e.stopMs, tz);
    const showTitle = it.showTitle && it.showTitle.trim() ? it.showTitle : (it.title ?? "Program");
    const epTitle = it.showTitle && it.title && it.title !== it.showTitle ? it.title : undefined;
    const extras = resolver?.guideExtras ? resolver.guideExtras(it.id) : { genres: [] as string[] };

    lines.push(`  <programme channel="${esc(tvgId)}" start="${start}" stop="${stop}">`);
    lines.push(`    <title lang="en">${esc(showTitle)}</title>`);
    if (epTitle) lines.push(`    <sub-title lang="en">${esc(epTitle)}</sub-title>`);
    if (it.plot) lines.push(`    <desc lang="en">${esc(it.plot)}</desc>`);
    for (const g of extras.genres ?? []) lines.push(`    <category lang="en">${esc(g)}</category>`);
    if (it.season != null && it.episodeNumber != null) {
      const s = String(it.season).padStart(2, "0"), ep = String(it.episodeNumber).padStart(2, "0");
      lines.push(`    <episode-num system="onscreen">S${s}E${ep}</episode-num>`);
      lines.push(`    <episode-num system="xmltv_ns">${it.season - 1}.${it.episodeNumber - 1}.0/1</episode-num>`);
    }
    if (it.year) lines.push(`    <date>${it.year}</date>`);
    if (extras.icon) lines.push(`    <icon src="${esc(extras.icon)}" />`);
    if (extras.contentRating) lines.push(`    <rating><value>${esc(extras.contentRating)}</value></rating>`);
    lines.push(`  </programme>`);
  }
  lines.push(`</tv>`);
  return lines.join("\n");
}

// Programme posters. The resolver gives a token-free "art://{sourceId}/{type}/{key}"
// ref, which only this app understands. ErsatzTV next serves these files to TV
// apps as-is, so the published guide must say where to fetch each image: the
// scheduler's /art/{sourceId}/{type}/{key} route, at the address TV apps reach it
// on (`artBase`). A URL written with an older address is re-pointed as well.
const ART_SRC_RE = /src="(?:art:\/\/|https?:\/\/[^"\s]*?\/art\/)(\d+)\/(plex|jellyfin|emby)\/([A-Za-z0-9_-]+)"/g;
export function publicizeArtRefs(xml: string, artBase?: string): string {
  if (!artBase) return xml;
  const base = artBase.replace(/\/+$/, "");
  return xml.replace(ART_SRC_RE, (_m, sid, type, key) => `src="${esc(`${base}/art/${sid}/${type}/${key}`)}"`);
}
/** An /art/{sourceId}/{type}/{key} URL (any host) back to its art:// ref. */
export function artRefFromUrl(url: string): string | undefined {
  const m = /^https?:\/\/[^\s]*?\/art\/(\d+)\/(plex|jellyfin|emby)\/([A-Za-z0-9_-]+)$/.exec(url);
  return m ? `art://${m[1]}/${m[2]}/${m[3]}` : undefined;
}
/** Re-point every guide file in a folder at `artBase` (e.g. after it changes). */
export async function publicizeXmltvDir(xmltvDir: string, artBase: string): Promise<number> {
  let n = 0;
  let files: string[] = [];
  try { files = (await readdir(xmltvDir)).filter((f) => f.endsWith(".xml")); } catch { return 0; }
  for (const f of files) {
    const p = join(xmltvDir, f);
    try {
      const xml = await readFile(p, "utf8");
      const out = publicizeArtRefs(xml, artBase);
      if (out !== xml) { await writeFile(p, out, "utf8"); n++; }
    } catch { /* skip unreadable */ }
  }
  return n;
}

/** Write `{xmltvDir}/{tvgId}.xml`. Returns the path written. */
export async function writeChannelXmltv(
  xmltvDir: string, tvgId: string, entries: GuideEntry[], tz: Tz, resolver?: ContentResolver, artBase?: string,
): Promise<string> {
  await mkdir(xmltvDir, { recursive: true });
  const file = join(xmltvDir, `${tvgId}.xml`);
  await writeFile(file, publicizeArtRefs(renderChannelXmltv(tvgId, entries, tz, resolver), artBase), "utf8");
  return file;
}

/** Parse an XMLTV "YYYYMMDDHHMMSS ±HHMM" timestamp back to epoch ms. Its own
 *  offset wins (it pins down the repeated fall-back hour); `tz` is only for
 *  timestamps without one. */
export function parseXmltvTime(s: string, tz: Tz): number {
  const y = +s.slice(0, 4), mo = +s.slice(4, 6), d = +s.slice(6, 8);
  const h = +s.slice(8, 10), mi = +s.slice(10, 12), se = +s.slice(12, 14);
  const m = s.slice(14).match(/^\s*([+-])(\d{2}):?(\d{2})/);
  if (m) return Date.UTC(y, mo - 1, d, h, mi, se) - (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000;
  return localToEpoch(y, mo - 1, d, h, mi, tz) + se * 1000;
}

const PROGRAMME_RE = /<programme\b[^>]*?\bstart="([^"]+)"[^>]*?\bstop="([^"]+)"[^>]*?>[\s\S]*?<\/programme>/g;

/**
 * Write `{xmltvDir}/{tvgId}.xml` for an *incremental* build. The scheduler only
 * builds the newly-uncovered window, so `newEntries` covers just that segment.
 * To keep the guide complete we merge: retain existing programmes that start
 * before the new window and haven't finished before `nowMs` (prune the past),
 * then append the freshly rendered new programmes. Returns the path written.
 */
export async function mergeChannelXmltv(
  xmltvDir: string, tvgId: string, newEntries: GuideEntry[], tz: Tz,
  nowMs: number, resolver?: ContentResolver, artBase?: string,
): Promise<string> {
  await mkdir(xmltvDir, { recursive: true });
  const file = join(xmltvDir, `${tvgId}.xml`);
  const firstNewStart = newEntries.length ? Math.min(...newEntries.map((e) => e.startMs)) : Infinity;

  // Carry forward still-relevant programme blocks from the existing file.
  let kept: string[] = [];
  try {
    const prev = await readFile(file, "utf8");
    for (const m of prev.matchAll(PROGRAMME_RE)) {
      const startMs = parseXmltvTime(m[1], tz);
      const stopMs = parseXmltvTime(m[2], tz);
      if (startMs < firstNewStart && stopMs > nowMs) kept.push(m[0]);
    }
  } catch { /* no existing file — first build for this channel */ }

  const rendered = renderChannelXmltv(tvgId, newEntries, tz, resolver);
  let out: string;
  if (kept.length) {
    // Splice kept blocks in ahead of the newly rendered programmes.
    out = rendered.replace(/(<tv\b[^>]*>\n)/, (_m, open) => open + kept.join("\n") + "\n");
  } else {
    out = rendered;
  }
  await writeFile(file, publicizeArtRefs(out, artBase), "utf8");
  return file;
}
