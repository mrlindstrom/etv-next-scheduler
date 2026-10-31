// Remote stream module — a channel that relays a live stream from somewhere else
// (an IPTV playlist entry or a direct HLS / MPEG-TS URL), like a Weatherscan box.
// It doesn't schedule anything: a build resolves the playlist to its stream URL
// and writes live HTTP items covering the window, which ErsatzTV next pulls and
// re-encodes. The guide is either the stream's own XMLTV (passed through) or a
// repeating block with a title of your choosing.
import type { PlayoutDoc } from "../yaml.js";
import type { SchedulingModule, ModuleSummary, Field } from "./module.js";
import type { GuideEntry } from "../engine.js";
import type { PlayoutItem } from "../model.js";
import { PLAYOUT_VERSION } from "../model.js";
import { writePlayout } from "../emit.js";
import { formatRfc3339, localParts, localToEpoch, nextMinuteBoundary, type Tz } from "../time.js";
import { formatXmltvTime, renderChannelXmltv } from "../xmltv.js";

export interface RemoteConfig {
  playlistUrl: string;
  entry: string;          // which playlist entry (tvg-id or name); "" = the first
  guide: "remote" | "custom";
  guideUrl: string;       // "" = the playlist's x-tvg-url, if any
  title: string;          // custom guide title ("" = the channel's stream name)
  description: string;
  blockMinutes: number;   // custom guide: length of each repeated block
}

export function parseRemote(raw: string): RemoteConfig {
  let c: any = {};
  try { c = JSON.parse(raw || "{}"); } catch { /* treat as empty */ }
  return {
    playlistUrl: String(c.playlistUrl ?? "").trim(),
    entry: String(c.entry ?? "").trim(),
    guide: c.guide === "custom" ? "custom" : "remote",
    guideUrl: String(c.guideUrl ?? "").trim(),
    title: String(c.title ?? "").trim(),
    description: String(c.description ?? "").trim(),
    blockMinutes: Math.max(5, Number(c.blockMinutes) || 60),
  };
}

const FETCH_MS = 10_000;
async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

export interface ResolvedStream {
  streamUrl: string;
  name: string;           // the playlist entry's display name ("" for a direct URL)
  tvgId: string;          // its tvg-id, which picks its channel in the guide
  guideUrl: string;       // the guide to pass through ("" = none)
  entries: { name: string; tvgId: string }[]; // every entry in the playlist
}

/** Turn the configured URL into the stream next should play. An IPTV playlist
 *  (#EXTINF entries) picks its entry; an HLS playlist or anything else is the
 *  stream itself. Relative entry/guide URLs resolve against the playlist. */
export async function resolveStream(cfg: RemoteConfig): Promise<ResolvedStream> {
  if (!cfg.playlistUrl) throw new Error("Add the stream's playlist URL.");
  let base: URL;
  try { base = new URL(cfg.playlistUrl); } catch { throw new Error(`"${cfg.playlistUrl}" isn't a valid URL.`); }
  const guideFrom = (u: string) => (u ? new URL(u, base).href : "");
  // a .ts / .mp4 style URL is a stream already; only playlists are worth reading
  let text = "";
  if (!/\.(ts|mp4|mkv|flv|aac|mp3)(\?|$)/i.test(base.pathname)) {
    try { text = await fetchText(base.href); }
    catch (e) { throw new Error(`Couldn't reach ${base.href} (${(e as Error).message}).`); }
  }
  if (!text.includes("#EXTINF") || text.includes("#EXT-X-")) {
    // HLS (or a raw stream): play it as given
    return { streamUrl: base.href, name: "", tvgId: "", guideUrl: guideFrom(cfg.guideUrl), entries: [] };
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const header = lines.find((l) => l.startsWith("#EXTM3U")) ?? "";
  const attr = (l: string, k: string) => l.match(new RegExp(`${k}="([^"]*)"`))?.[1] ?? "";
  const entries: { name: string; tvgId: string; url: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXTINF")) continue;
    const url = lines.slice(i + 1).find((l) => l && !l.startsWith("#"));
    if (!url) continue;
    const name = lines[i].slice(lines[i].lastIndexOf(",") + 1).trim() || attr(lines[i], "tvg-name");
    entries.push({ name, tvgId: attr(lines[i], "tvg-id"), url: new URL(url, base).href });
  }
  if (!entries.length) throw new Error("The playlist has no streams in it.");
  const want = cfg.entry.toLowerCase();
  const hit = want ? entries.find((e) => e.tvgId.toLowerCase() === want || e.name.toLowerCase() === want) : entries[0];
  if (!hit) throw new Error(`No stream called "${cfg.entry}" in the playlist. It has: ${entries.map((e) => e.name || e.tvgId).join(", ")}.`);
  const tvgUrl = attr(header, "x-tvg-url") || attr(header, "url-tvg");
  return {
    streamUrl: hit.url, name: hit.name, tvgId: hit.tvgId,
    guideUrl: guideFrom(cfg.guideUrl || tvgUrl.split(",")[0].trim()),
    entries: entries.map(({ name, tvgId }) => ({ name, tvgId })),
  };
}

/** An XMLTV time with its own offset ("20261015170000 -0500"), to epoch ms. */
function parseZonedTime(s: string, fallbackTz: Tz): number {
  const m = s.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(?:([+-])(\d{2}):?(\d{2}))?/);
  if (!m) return NaN;
  if (!m[7]) return localToEpoch(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], fallbackTz) + +(m[6] ?? 0) * 1000;
  const off = (m[7] === "-" ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)) - off * 60_000;
}

export interface RemoteGuide { xmltv: string; count: number; firstMs: number; lastMs: number; title: string }

/** The stream's guide for one of its channels: its <programme>s, kept verbatim
 *  (icons, categories…) but re-timed to this server's offset and re-pointed at
 *  `__TVG_ID__` (filled in by the caller). Programmes over 2 hours ago are dropped. */
export async function fetchRemoteGuide(guideUrl: string, tvgId: string, tz: Tz): Promise<RemoteGuide> {
  const text = await fetchText(guideUrl);
  const re = /<programme\b([^>]*)>[\s\S]*?<\/programme>/g;
  const ids = new Set<string>();
  const progs: { ch: string; s: number; e: number; xml: string }[] = [];
  for (const m of text.matchAll(re)) {
    const a = m[1];
    const ch = a.match(/\bchannel="([^"]*)"/)?.[1] ?? "";
    const s = parseZonedTime(a.match(/\bstart="([^"]+)"/)?.[1] ?? "", tz);
    const e = parseZonedTime(a.match(/\bstop="([^"]+)"/)?.[1] ?? "", tz);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    ids.add(ch);
    progs.push({ ch, s, e, xml: m[0] });
  }
  // the playlist entry's tvg-id picks the channel; a single-channel guide needs no match
  const pick = tvgId && ids.has(tvgId) ? tvgId : ids.size === 1 ? [...ids][0] : null;
  if (!pick) throw new Error(ids.size ? `The guide has ${ids.size} channels and none match "${tvgId}". Set "Stream in the playlist" to the right one.` : "The guide has no programmes.");
  const cutoff = Date.now() - 2 * 3_600_000;
  const mine = progs.filter((p) => p.ch === pick && p.e > cutoff).sort((a, b) => a.s - b.s);
  const body = mine.map((p) => "  " + p.xml.replace(/<programme\b[^>]*>/, `<programme channel="__TVG_ID__" start="${formatXmltvTime(p.s, tz)}" stop="${formatXmltvTime(p.e, tz)}">`));
  const title = mine[0]?.xml.match(/<title\b[^>]*>([^<]*)<\/title>/)?.[1] ?? "";
  return {
    xmltv: [`<?xml version="1.0" encoding="UTF-8"?>`, `<tv generator-info-name="tv-next-scheduler">`, ...body, `</tv>`].join("\n"),
    count: mine.length, firstMs: mine[0]?.s ?? NaN, lastMs: mine[mine.length - 1]?.e ?? NaN, title,
  };
}

/** Repeating guide blocks of `blockMinutes`, on the clock (from local midnight). */
export function customGuide(title: string, description: string, blockMinutes: number, startMs: number, finishMs: number, tz: Tz): GuideEntry[] {
  const step = blockMinutes * 60_000;
  const out: GuideEntry[] = [];
  for (let n = 0, t = startMs - (localParts(startMs, tz).msOfDay % step); t < finishMs; n++) {
    const next = nextMinuteBoundary(t, blockMinutes, tz);
    out.push({ startMs: Math.max(t, startMs), stopMs: Math.min(next, finishMs), item: { id: `remote:${n}`, path: "", durationMs: step, chapters: [], kind: "other_video", title, plot: description || undefined } });
    t = next;
  }
  return out;
}

// Each live item reconnects to the stream when it starts, so keep them long:
// one per 6 hours on the clock (a playout window still splits them at its edges).
const ITEM_MS = 6 * 3_600_000;

export interface RemoteBuild { file: string; itemCount: number; guide: GuideEntry[]; xmltv?: string }

export async function buildRemote(raw: string, outputDir: string, startMs: number, finishMs: number, tz: Tz): Promise<RemoteBuild> {
  const cfg = parseRemote(raw);
  const stream = await resolveStream(cfg);
  const items: PlayoutItem[] = [];
  const labels: Record<string, unknown> = {};
  for (let t = startMs, id = 1; t < finishMs; id++) {
    const end = Math.min(nextMinuteBoundary(t, ITEM_MS / 60_000, tz), finishMs);
    items.push({
      id: String(id), start: formatRfc3339(t, tz), finish: formatRfc3339(end, tz),
      source: { source_type: "http", uri: stream.streamUrl, is_live: true, reconnect: true },
    });
    labels[String(id)] = { key: "remote", type: "live" };
    t = end;
  }
  const file = await writePlayout(outputDir, { version: PLAYOUT_VERSION, generated_at: new Date().toISOString(), items }, startMs, finishMs, tz, labels);

  const title = cfg.title || stream.name || "Live";
  if (cfg.guide === "remote" && stream.guideUrl) {
    try {
      const g = await fetchRemoteGuide(stream.guideUrl, stream.tvgId || cfg.entry, tz);
      if (g.count) {
        // past the end of the stream's guide, repeat the title so the guide has no hole
        const tail = customGuide(title, cfg.description, cfg.blockMinutes, g.lastMs, finishMs, tz);
        const extra = tail.length ? renderChannelXmltv("__TVG_ID__", tail, tz).match(/  <programme[\s\S]*<\/programme>/)?.[0] ?? "" : "";
        return { file, itemCount: items.length, guide: [], xmltv: extra ? g.xmltv.replace("</tv>", `${extra}\n</tv>`) : g.xmltv };
      }
    } catch { /* guide unreachable: fall back to the repeating title below */ }
  }
  return { file, itemCount: items.length, guide: customGuide(title, cfg.description, cfg.blockMinutes, startMs, finishMs, tz) };
}

/** What the "Check stream" button shows: where the stream and guide resolve to. */
export async function probeRemote(raw: string, tz: Tz) {
  const cfg = parseRemote(raw);
  const stream = await resolveStream(cfg);
  let guide: { url: string; count?: number; firstMs?: number; lastMs?: number; title?: string; error?: string } | null = null;
  if (cfg.guide === "remote") {
    if (!stream.guideUrl) guide = { url: "", error: "No guide URL, and the playlist doesn't name one. The channel will show your title instead." };
    else {
      try {
        const g = await fetchRemoteGuide(stream.guideUrl, stream.tvgId || cfg.entry, tz);
        guide = { url: stream.guideUrl, count: g.count, firstMs: g.firstMs, lastMs: g.lastMs, title: g.title };
      } catch (e) { guide = { url: stream.guideUrl, error: `${(e as Error).message} The channel will show your title instead.` }; }
    }
  }
  return { streamUrl: stream.streamUrl, name: stream.name, entries: stream.entries, guide };
}

const SCHEMA: Field[] = [
  { type: "text", key: "playlistUrl", label: "Playlist or stream URL", placeholder: "http://192.168.1.50:9798/playlist.m3u", help: "An IPTV playlist (.m3u), or the stream itself (.m3u8 HLS or .ts)." },
  { type: "text", key: "entry", label: "Stream in the playlist", placeholder: "first one", help: "Only for playlists with more than one stream: its tvg-id or name. Leave blank for the first." },
  { type: "select", key: "guide", label: "Guide", default: "remote", options: [
    { value: "remote", label: "Use the stream's guide" },
    { value: "custom", label: "My own title, repeated" },
  ], help: "The stream's guide is copied as-is. If it can't be reached, your title below is used." },
  { type: "text", key: "guideUrl", label: "Guide URL (XMLTV)", placeholder: "from the playlist", help: "Leave blank to use the guide the playlist names (x-tvg-url).", showIf: { key: "guide", equals: ["remote", ""] } },
  { type: "text", key: "title", label: "Title", placeholder: "the stream's name", help: "Shown in the guide for every block." },
  { type: "text", key: "description", label: "Description", showIf: { key: "guide", equals: "custom" } },
  { type: "select", key: "blockMinutes", label: "Repeat every", default: "60", options: [
    { value: "30", label: "30 minutes" }, { value: "60", label: "1 hour" }, { value: "120", label: "2 hours" },
    { value: "180", label: "3 hours" }, { value: "360", label: "6 hours" }, { value: "720", label: "12 hours" }, { value: "1440", label: "24 hours" },
  ], help: "Each guide block's length, on the clock (1 hour = 5:00, 6:00, 7:00…).", showIf: { key: "guide", equals: "custom" } },
];

export const remoteModule: SchedulingModule = {
  id: "remote",
  label: "Remote stream",
  description: "Relays a live stream from another box or service (an IPTV playlist or HLS URL), with its own guide or a title you choose.",
  editor: "form",
  fileExts: [".remote.json"],
  saveExt: ".remote.json",
  defaultConfig: () => JSON.stringify({ playlistUrl: "", guide: "remote", blockMinutes: "60" }, null, 2),
  schema: () => SCHEMA,
  compile(): PlayoutDoc { throw new Error("Remote stream channels relay a live stream; they don't compile a schedule."); },
  summarize(raw): ModuleSummary {
    const c = parseRemote(raw);
    if (!c.playlistUrl) return { valid: false, error: "Add the stream's playlist URL." };
    try { new URL(c.playlistUrl); } catch { return { valid: false, error: `"${c.playlistUrl}" isn't a valid URL.` }; }
    const guide = c.guide === "custom" ? `"${c.title || "stream name"}" every ${c.blockMinutes >= 60 ? `${c.blockMinutes / 60} h` : `${c.blockMinutes} min`}` : "stream's guide";
    return { valid: true, line: `live stream · ${guide}` };
  },
};
