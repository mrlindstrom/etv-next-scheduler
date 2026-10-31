// Public API: build a channel's playout for a time window from its config file.
// The config file's extension selects the scheduling module, which compiles it
// into the engine's PlayoutDoc.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SchedulingEngine, type BuildOptions } from "./engine.js";
import { buildUpNextAss, formatClock, DEFAULT_ASS_LAYOUT } from "./upnext-ass.js";
import type { ContentResolver } from "./resolver.js";
import { writePlayout } from "./emit.js";
import { applyLanguageTracks } from "./lang.js";
import { moduleForFile } from "./scheduling/registry.js";
import { buildTimeshift, parseTimeshift } from "./scheduling/timeshift-module.js";
import { buildRemote } from "./scheduling/remote-module.js";

export * from "./model.js";
export * from "./yaml.js";
export * from "./resolver.js";
export * from "./engine.js";
export * from "./expr.js";
export * from "./emit.js";
export * from "./lang.js";
export * from "./xmltv.js";
export * from "./holidays.js";
export * from "./scheduling/module.js";
export * from "./scheduling/registry.js";

export interface ChannelBuildRequest {
  /** Path to the channel's config file (.yml, .schedule.json, …). */
  configPath: string;
  resolver: ContentResolver;
  outputDir: string;
  options: BuildOptions;
  /** Time-shift channels: the source channel's guide file, to shift into this one's. */
  sourceXmltv?: string;
}

export async function buildChannel(req: ChannelBuildRequest): Promise<{ file: string; itemCount: number; guide: import("./engine.js").GuideEntry[]; progress: Record<string, number>; xmltv?: string }> {
  const src = await readFile(req.configPath, "utf8");
  const mod = moduleForFile(req.configPath);
  // a time-shift channel copies its source's playout instead of scheduling
  if (mod.id === "timeshift") {
    const r = await buildTimeshift(src, req.outputDir, req.options.startMs, req.options.finishMs, req.options.tz, req.sourceXmltv);
    return { file: r.file, itemCount: r.itemCount, guide: [], progress: {}, xmltv: r.xmltv };
  }
  // a remote stream channel relays a live stream (guide passed through or repeated)
  if (mod.id === "remote") {
    const r = await buildRemote(src, req.outputDir, req.options.startMs, req.options.finishMs, req.options.tz);
    return { file: r.file, itemCount: r.itemCount, guide: r.guide, progress: {}, xmltv: r.xmltv };
  }
  const doc = mod.compile(src);
  const engine = new SchedulingEngine(doc, req.resolver, req.options);
  const items = await engine.build();
  const playout = engine.toPlayout();
  // Stamp preferred audio/subtitle stream indices onto items whose file has a
  // matching-language track (channel default language, e.g. English).
  applyLanguageTracks(playout, req.resolver, {
    audio: req.options.preferredAudioLang, subtitles: req.options.subtitles,
  });
  // Subtitles-mode up-next cards: now that the whole guide is known, write each
  // card's .ass (next few programmes after the card, time-only) and attach it as
  // the item's burned subtitle track.
  const cards = engine.getUpNextCards();
  const u = req.options.upNext;
  if (cards.length && u) {
    const layout = { ...DEFAULT_ASS_LAYOUT, ...(u.assLayout ?? {}) };
    const guide = engine.getGuide().slice().sort((a, b) => a.startMs - b.startMs);
    const assDir = join(req.outputDir, "ass");
    await mkdir(assDir, { recursive: true });
    for (const card of cards) {
      const rows = guide.filter((g) => g.startMs >= card.anchorMs - 1000).slice(0, card.count)
        .map((g) => ({ label: formatClock(g.startMs, req.options.tz), title: g.item.showTitle || g.item.title || "" }));
      const ass = buildUpNextAss(rows, u.width, u.height, card.durationMs, layout);
      const assFile = join(assDir, `${card.id}.ass`);
      await writeFile(assFile, ass, "utf8");
      const item = (playout.items as any[]).find((it) => it.id === card.id);
      if (item) item.tracks = { ...(item.tracks ?? {}), subtitle: { source: { source_type: "local", path: assFile } } };
    }
  }
  const file = await writePlayout(
    req.outputDir, playout, req.options.startMs, req.options.finishMs, req.options.tz, engine.getLabels(),
  );
  return { file, itemCount: items.length, guide: engine.getGuide(), progress: engine.getProgress() };
}

/** Write a time-shift channel's shifted guide as its own XMLTV file. */
export async function writeShiftedXmltv(xmltvDir: string, tvgId: string, xmltv: string): Promise<void> {
  await mkdir(xmltvDir, { recursive: true });
  const id = tvgId.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  await writeFile(join(xmltvDir, `${tvgId}.xml`), xmltv.replaceAll("__TVG_ID__", id), "utf8");
}

/** The channel a time-shift config copies ("" for any other mode). */
export async function timeshiftSource(configPath: string): Promise<string> {
  if (moduleForFile(configPath).id !== "timeshift") return "";
  try { return parseTimeshift(await readFile(configPath, "utf8")).source; } catch { return ""; }
}
