// Time-shift module — a channel that airs another channel's schedule later (or
// earlier), like an East/West coast feed or a "+1" channel. It doesn't schedule
// anything itself: a build copies the source channel's built playout windows,
// moved by the offset, and shifts the source's guide the same way. Build the
// source first (builds and auto-build top-ups order time-shift channels last).
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { PlayoutDoc } from "../yaml.js";
import type { SchedulingModule, ModuleSummary, Field } from "./module.js";
import { formatXmltvTime, parseXmltvTime } from "../xmltv.js";
import { writePlayout } from "../emit.js";
import type { Tz } from "../time.js";

export interface TimeshiftConfig { source: string; offsetMinutes: number }

export function parseTimeshift(raw: string): TimeshiftConfig {
  try { const c = JSON.parse(raw || "{}"); return { source: String(c.source ?? ""), offsetMinutes: Number(c.offsetMinutes ?? 0) || 0 }; }
  catch { return { source: "", offsetMinutes: 0 }; }
}

/** Where a channel's playout folder is, matching the name without regard to case
 *  (Windows folders ignore case, so an old folder may differ from the name). */
async function findDir(base: string, name: string): Promise<string> {
  try {
    const hit = (await readdir(base, { withFileTypes: true })).find((d) => d.isDirectory() && d.name.toLowerCase() === name.toLowerCase());
    if (hit) return join(base, hit.name);
  } catch { /* no base dir */ }
  return join(base, name);
}

export interface TimeshiftBuild { file: string; itemCount: number; xmltv?: string }

/** A clock label ("6:00 PM") moved by `minutes`. */
function shiftClock(label: string, minutes: number): string {
  const m = label.match(/^(\d{1,2}):(\d{2}) (AM|PM)$/);
  if (!m) return label;
  const t = ((((Number(m[1]) % 12) + (m[3] === "PM" ? 12 : 0)) * 60 + Number(m[2]) + minutes) % 1440 + 1440) % 1440;
  const hh = Math.floor(t / 60);
  return `${hh % 12 === 0 ? 12 : hh % 12}:${String(t % 60).padStart(2, "0")} ${hh >= 12 ? "PM" : "AM"}`;
}

/** Point a copied up-next card at this channel's own guide and times: its layer
 *  URLs carry the channel and the moment the list starts from, and a subtitles-mode
 *  card has its times written into an .ass file. */
async function retargetCard(item: any, shift: number, outputDir: string, channel: { name: string; number?: string }): Promise<void> {
  for (const layer of item.graphics ?? []) {
    const uri: string | undefined = layer?.source?.uri;
    if (!uri || !uri.includes("/graphics/upnext.png?")) continue;
    const [path, query] = uri.split("?");
    const p = new URLSearchParams(query);
    const at = Number(p.get("at"));
    if (Number.isFinite(at) && at > 0) p.set("at", String(Math.round(at + shift)));
    p.set("c", channel.name);
    if (channel.number) p.set("ch", channel.number); else p.delete("ch");
    layer.source = { ...layer.source, uri: `${path}?${p.toString()}` };
  }
  const ass: string | undefined = item.tracks?.subtitle?.source?.path;
  if (ass && /[\\/]ass[\\/][^\\/]+\.ass$/.test(ass)) {
    try {
      const text = (await readFile(ass, "utf8")).replace(/\b\d{1,2}:\d{2} (?:AM|PM)\b/g, (t) => shiftClock(t, Math.round(shift / 60_000)));
      const dir = join(outputDir, "ass");
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${item.id}.ass`);
      await writeFile(file, text, "utf8");
      item.tracks = { ...item.tracks, subtitle: { ...item.tracks.subtitle, source: { ...item.tracks.subtitle.source, path: file } } };
    } catch { /* the source's card text is gone: keep the copy as it is */ }
  }
}

/** Copy the source channel's playout into [startMs, finishMs), moved by the offset. */
export async function buildTimeshift(raw: string, outputDir: string, startMs: number, finishMs: number, tz: Tz, sourceXmltv?: string, channel?: { name?: string; number?: string }): Promise<TimeshiftBuild> {
  const cfg = parseTimeshift(raw);
  if (!cfg.source) throw new Error("Pick the channel this one time-shifts.");
  const shift = cfg.offsetMinutes * 60_000;
  const srcDir = await findDir(dirname(outputDir), cfg.source);
  let files: string[] = [];
  try { files = (await readdir(srcDir)).filter((f) => f.endsWith(".json") && !f.endsWith(".labels.json")).sort(); } catch { /* none */ }
  if (!files.length) throw new Error(`"${cfg.source}" hasn't been built yet. Build it first.`);

  let version = "";
  const picked: { item: any; label: unknown }[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const doc = JSON.parse(await readFile(join(srcDir, f), "utf8"));
    let lab: Record<string, unknown> = {};
    try { lab = JSON.parse(await readFile(join(srcDir, f.replace(/\.json$/, ".labels.json")), "utf8")); } catch { /* no labels */ }
    if (doc.version > version) version = doc.version;
    for (const it of doc.items ?? []) {
      const s = Date.parse(it.start) + shift;
      if (s < startMs || s >= finishMs) continue;
      const key = `${s}|${it.source?.path ?? it.id}`;
      if (seen.has(key)) continue; // overlapping windows
      seen.add(key);
      const moved = { ...it, start: new Date(s).toISOString(), finish: new Date(Date.parse(it.finish) + shift).toISOString() };
      picked.push({ item: moved, label: lab[it.id] });
    }
  }
  picked.sort((a, b) => Date.parse(a.item.start) - Date.parse(b.item.start));
  if (!picked.length) throw new Error(`"${cfg.source}" has nothing scheduled for this time yet. Build it further ahead first.`);
  // Each source window numbers its items from 1, so give the copy its own ids
  // (the labels are keyed by id), and point up-next cards at this channel.
  const me = { name: channel?.name || basename(outputDir), number: channel?.number };
  const items: any[] = [];
  const labels: Record<string, unknown> = {};
  for (const [i, p] of picked.entries()) {
    const item = structuredClone(p.item);
    item.id = String(i + 1);
    if (p.label) labels[item.id] = p.label;
    await retargetCard(item, shift, outputDir, me);
    items.push(item);
  }
  const file = await writePlayout(outputDir, { version: version || "0.0.1", generated_at: new Date().toISOString(), items } as any, startMs, finishMs, tz, labels);

  // guide: the source's programmes, moved by the offset (channel id filled in by the caller)
  let xmltv: string | undefined;
  if (sourceXmltv) {
    try {
      const text = await readFile(sourceXmltv, "utf8");
      xmltv = text.replace(/<programme channel="[^"]*" start="([^"]+)" stop="([^"]+)">/g, (_m, a: string, b: string) =>
        `<programme channel="__TVG_ID__" start="${formatXmltvTime(parseXmltvTime(a, tz) + shift, tz)}" stop="${formatXmltvTime(parseXmltvTime(b, tz) + shift, tz)}">`);
    } catch { /* source has no guide yet */ }
  }
  return { file, itemCount: items.length, xmltv };
}

const SCHEMA: Field[] = [
  { type: "channel", key: "source", label: "Time-shift this channel", help: "The channel whose schedule this one repeats." },
  { type: "number", key: "offsetMinutes", label: "Offset (minutes)", default: 180, help: "How much later this channel airs it: 180 = a West Coast feed 3 hours behind, 60 = a \"+1\" channel. Negative airs it earlier." },
];

export const timeshiftModule: SchedulingModule = {
  id: "timeshift",
  label: "Time-shift feed",
  description: "Repeats another channel's schedule a set time later (or earlier), like a West Coast feed or a +1 channel. Build the source channel first.",
  editor: "form",
  fileExts: [".timeshift.json"],
  saveExt: ".timeshift.json",
  defaultConfig: () => JSON.stringify({ source: "", offsetMinutes: 180 }, null, 2),
  schema: () => SCHEMA,
  compile(): PlayoutDoc { throw new Error("Time-shift channels copy another channel's playout; they don't compile a schedule."); },
  summarize(raw): ModuleSummary {
    const c = parseTimeshift(raw);
    if (!c.source) return { valid: false, error: "Pick the channel to time-shift." };
    if (!c.offsetMinutes) return { valid: false, error: "Set an offset in minutes (e.g. 180)." };
    return { valid: true, source: c.source, offsetMinutes: c.offsetMinutes };
  },
};
