// -----------------------------------------------------------------------------
// Generate ErsatzTV next config from the channel registry + streaming settings.
// Writes {runtime}/lineup.json and {runtime}/channels/<name>.config.json.
// -----------------------------------------------------------------------------
import { mkdir, writeFile, readdir, readFile, unlink } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { ConfigStore, NextConfig, ChannelMeta } from "./config.js";
import type { UpNextOptions } from "../engine.js";
import type { PlayoutItem, Playout } from "../model.js";
import { PLAYOUT_VERSION } from "../model.js";
import { writePlayout } from "../emit.js";
import { formatRfc3339, floorLocalMidnight, ceilLocalMidnight, type Tz } from "../time.js";
import { loadTheme } from "./upnext-themes.js";
import { DEFAULT_ASS_LAYOUT } from "../upnext-ass.js";
import { loadGuideTheme } from "../guide.js";
import { readSourceInfo } from "./scanner-remote.js";
import { compareChannelNumbers } from "../channel-numbers.js";
import { publishedLogoUrl, schedulerBaseUrl } from "./channel-logos.js";
import { publicizeXmltvDir } from "../xmltv.js";
import { fallbackImageFor, pruneFallbackDir } from "./fallback-image.js";

const absPath = (root: string, p: string) => (isAbsolute(p) || /^[A-Za-z]:/.test(p) ? p : join(root, p));

/** A channel's card music path as typed: a raw Windows path is fine; only
 *  surrounding quotes (from "Copy as path") and whitespace are stripped. */
export function cardAudioPath(raw: string | undefined): string {
  return (raw || "").trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

/** Build the per-channel "up next" options, or undefined when disabled / the
 *  channel has no lineup number / the channel's card is set to "off". The card
 *  art is served by THIS scheduler server (main.ts PORT, default 8730).
 *  `preview` (the card tester) skips the on/off checks and can swap the theme. */
export async function upNextOptionsFor(store: ConfigStore, channelName: string, root: string, preview?: { theme?: string }): Promise<UpNextOptions | undefined> {
  const cfg = store.getNextConfig();
  const un = cfg.upNext;
  if (!un?.enabled && !preview) return undefined;
  const meta = store.channelMeta(channelName);
  if (!meta?.number) return undefined;
  // Per-channel theme selects the card design; "off" disables the card here.
  let theme = meta.upNextTheme || "splat";
  if (preview) theme = preview.theme || (theme === "off" ? "splat" : theme);
  if (theme === "off") return undefined;
  const apiPort = Number(process.env.PORT ?? 8730);
  // For subtitles text mode, pull the theme's optional `ass` layout block.
  const themeDef = await loadTheme(join(absPath(root, cfg.runtimeDir), "upnext-themes"), theme);
  const assLayout = { ...DEFAULT_ASS_LAYOUT, ...((themeDef as any).ass ?? {}) };
  return {
    baseUrl: `http://127.0.0.1:${apiPort}`,
    channelNumber: meta.number,
    channelName: meta.name,
    count: un.count ?? 3,
    durationMs: un.durationMs ?? 12000,
    width: cfg.video.width,
    height: cfg.video.height,
    theme,
    // A music file missing on this machine would fail the whole card in next
    // (black and silent), so the card goes silent instead.
    audioPath: cardAudioPath(meta.upNextAudio) && existsSync(cardAudioPath(meta.upNextAudio)) ? cardAudioPath(meta.upNextAudio) : undefined,
    textMode: meta.upNextText === "subtitles" ? "subtitles" : "image",
    assLayout,
    fps: "24",
  };
}

const abs = (root: string, p: string) => (isAbsolute(p) || /^[A-Za-z]:/.test(p) ? p : join(root, p));

/** The single playout directory both the web builds AND ErsatzTV next use, so
 *  next serves exactly what the scheduler/manual build produces. This is
 *  `<runtimeDir>/playouts` — the same folder the channel configs point at. */
export function playoutBaseDir(store: ConfigStore, root: string): string {
  return join(abs(root, store.getNextConfig().runtimeDir), "playouts");
}

/** Channel config schema we write; next 0.2.0+ refuses configs without one. */
export const CHANNEL_CONFIG_VERSION = "https://ersatztv.org/channel/version/0.1.0";

/** The HDR→SDR setting, as each tonemap filter next may pick spells it. Quick Sync
 *  tonemaps on its own; software `tonemap` has no bt2390, so next's default is used. */
function tonemapFilters(algo: string) {
  const a = algo || "linear";
  return {
    ...(a === "bt2390" ? {} : { tonemap: { tonemap: a } }),
    tonemap_opencl: { tonemap: a },
    libplacebo: { tonemapping: a === "bt2390" ? "bt.2390" : a },
  };
}

/** Whether a channel uses next's copy mode: items already in a format next can copy
 *  (h264/hevc, aac/ac3/eac3/mp3, matching frame rate, no cards or burned subtitles)
 *  pass through untouched, at their own resolution; the rest are transcoded.
 *  Loudness normalization is switched off for these channels. */
export function passesThrough(meta: ChannelMeta, moduleId: string | undefined): boolean {
  return meta.encoding === "copy" || (meta.encoding !== "transcode" && moduleId === "remote");
}

/** The schema that adds `fallback.background_image` (next 0.2.4+); only written when a channel uses one,
 *  so older next builds keep accepting every other channel. */
export const CHANNEL_CONFIG_VERSION_FALLBACK_IMAGE = "https://ersatztv.org/channel/version/0.1.3";

export function channelConfigJson(name: string, cfg: NextConfig, copy = false, backgroundImage?: string) {
  const mode = copy ? { mode: "copy" } : {};
  return {
    version: backgroundImage ? CHANNEL_CONFIG_VERSION_FALLBACK_IMAGE : CHANNEL_CONFIG_VERSION,
    ...(backgroundImage ? { fallback: { background_image: backgroundImage } } : {}),
    playout: { folder: `../playouts/${name}` },
    ffmpeg: { ffmpeg_path: cfg.ffmpegPath, ffprobe_path: cfg.ffprobePath, disabled_filters: [] },
    normalization: {
      audio: {
        ...mode,
        format: cfg.audio.codec, bitrate_kbps: cfg.audio.bitrateKbps, buffer_kbps: cfg.audio.bufferKbps,
        channels: cfg.audio.channels, sample_rate_hz: cfg.audio.sampleRateHz,
        // next refuses copy mode with loudness normalization on
        normalize_loudness: cfg.audio.normalizeLoudness && !copy,
        loudness: { integrated_target: -16, range_target: 11, true_peak: -1.5 },
      },
      video: {
        ...mode,
        format: cfg.video.codec, bit_depth: cfg.video.bitDepth, width: cfg.video.width, height: cfg.video.height,
        bitrate_kbps: cfg.video.bitrateKbps, buffer_kbps: cfg.video.bufferKbps, accel: cfg.video.accel ?? "",
        filters: tonemapFilters(cfg.video.tonemapAlgorithm),
      },
      // subtitles are always burned in: TV apps won't show forced-only tracks on
      // their own, and the channel's on/off/forced setting picks the track
      subtitle: { mode: "burn" },
    },
  };
}

/** If ffmpeg paths aren't set yet, seed them from an existing channel config so
 *  we don't clobber a working setup on the first "Apply". */
export async function seedNextConfig(store: ConfigStore, root: string): Promise<void> {
  const cfg = store.getNextConfig();
  if (cfg.ffmpegPath) return;
  const dir = join(abs(root, cfg.runtimeDir), "channels");
  try {
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".config.json")) continue;
      const j = JSON.parse(await readFile(join(dir, f), "utf8"));
      if (j?.ffmpeg?.ffmpeg_path) {
        store.setNextConfig({ ffmpegPath: j.ffmpeg.ffmpeg_path, ffprobePath: j.ffmpeg.ffprobe_path ?? "" });
        return;
      }
    }
  } catch { /* nothing to seed from */ }
}

export interface ApplyResult { lineup: string; channels: { name: string; config: string }[]; skipped: string[]; }

/** Write lineup.json + per-channel config.json for all enabled channels. */
export async function generateNext(store: ConfigStore, root: string): Promise<ApplyResult> {
  const cfg = store.getNextConfig();
  const runtimeDir = abs(root, cfg.runtimeDir);
  const channelsDir = join(runtimeDir, "channels");
  await mkdir(channelsDir, { recursive: true });
  for (const d of ["playouts", "xmltv"]) await mkdir(join(runtimeDir, d), { recursive: true });
  // Transcoded HLS segments live here — configurable so it can point at a ramdisk
  // (e.g. /dev/shm/etv) instead of churning the NVMe. Absolute paths are used as
  // written; relative paths resolve under runtimeDir (both here and in next).
  const outputFolder = cfg.outputFolder || "./output";
  try { await mkdir(abs(runtimeDir, outputFolder), { recursive: true }); } catch { /* e.g. ramdisk not mounted yet — next will create/use it */ }
  const logoBase = schedulerBaseUrl(cfg.publicUrl, Number(process.env.PORT ?? 8730));
  // guide files: programme posters point at this scheduler too (and follow an address change)
  try { await publicizeXmltvDir(join(runtimeDir, "xmltv"), logoBase); } catch { /* best effort */ }

  // Only channels that still have a config file — a registry row whose file was
  // removed outside the UI would otherwise publish an empty, unplayable channel.
  const { listChannelFiles } = await import("../scheduling/registry.js");
  const moduleOf = new Map((await listChannelFiles(abs(root, store.get().channelsDir))).map((c) => [c.name, c.module.id]));
  const withFile = new Set(moduleOf.keys());
  const enabled = store.channelMetas().filter((c) => c.enabled);
  const missingFile = enabled.filter((c) => !withFile.has(c.name)).map((c) => `${c.name} (no channel config file)`);
  // Names that differ only in capitalization map to the SAME config file and
  // playout folder on case-insensitive file systems (Windows), so the channels
  // would overwrite each other's schedules. Publish the first; skip the rest.
  const seenLower = new Map<string, string>();
  const metas: ChannelMeta[] = [];
  for (const c of enabled.filter((c) => withFile.has(c.name))) {
    const prior = seenLower.get(c.name.toLowerCase());
    if (prior) { missingFile.push(`${c.name} (same name as "${prior}" ignoring capitalization — rename one)`); continue; }
    seenLower.set(c.name.toLowerCase(), c.name);
    metas.push(c);
  }

  const lineup = {
    server: { bind_address: cfg.bindAddress, port: cfg.port },
    output: { folder: outputFolder },
    xmltv: { folder: "./xmltv" },
    channels: metas.map((m) => ({
      number: m.number, name: m.name, config: `./channels/${m.name}.config.json`,
      // next copies `logo` verbatim into tvg-logo and the guide's <icon>, so a
      // stored logo becomes this scheduler's URL for it (reachable by TV apps)
      tvg_id: m.tvgId || m.name, logo: publishedLogoUrl(m.logo, logoBase), group: m.group || "",
    })),
  };
  // Append the synthetic TV-guide scroller channel (its own config + playout).
  if (cfg.guide.enabled) {
    lineup.channels.push({
      number: cfg.guide.number, name: cfg.guide.name, config: `./channels/guide.config.json`,
      tvg_id: cfg.guide.tvgId || "guide", logo: "", group: cfg.guide.group || "",
    });
  }
  // ErsatzTV next serves the M3U and XMLTV guide in lineup order (it doesn't
  // re-sort), so write the lineup in channel-number order: 1, 1.2, 2, … 10, 10.10.
  lineup.channels.sort((a, b) => compareChannelNumbers(a.number, b.number) || a.name.localeCompare(b.name));
  const lineupPath = join(runtimeDir, "lineup.json");
  await writeFile(lineupPath, JSON.stringify(lineup, null, 2), "utf8");

  const written: { name: string; config: string }[] = [];
  const keep = new Set(metas.map((m) => `${m.name}.config.json`));
  // fallback images: standby cards are drawn into <runtime>/fallback, custom images used as they are
  const logosDir = join(runtimeDir, "logos"), fallbackDir = join(runtimeDir, "fallback");
  const cards = new Set<string>();
  for (const m of metas) {
    const p = join(channelsDir, `${m.name}.config.json`);
    let image: string | undefined;
    try { image = await fallbackImageFor(m, cfg, root, logosDir, fallbackDir); } catch { /* black */ }
    if (image) cards.add(image);
    await writeFile(p, JSON.stringify(channelConfigJson(m.name, cfg, passesThrough(m, moduleOf.get(m.name)), image), null, 2), "utf8");
    written.push({ name: m.name, config: p });
  }
  pruneFallbackDir(fallbackDir, cards);
  // guide channel config (playout folder ../playouts/guide) + an initial playout
  // so the channel is playable right after Apply (Build/scheduler keep it fresh).
  if (cfg.guide.enabled) {
    const p = join(channelsDir, "guide.config.json");
    await writeFile(p, JSON.stringify(channelConfigJson("guide", cfg), null, 2), "utf8");
    keep.add("guide.config.json");
    written.push({ name: cfg.guide.name, config: p });
    const app = store.get();
    const now = Date.now();
    try {
      await writeGuidePlayout(store, root, floorLocalMidnight(now, app.tz), ceilLocalMidnight(now + app.days * 86_400_000, app.tz), app.tz);
    } catch { /* build/scheduler will write it */ }
  }
  // remove config files for channels no longer enabled/registered
  const skipped: string[] = [...missingFile];
  try {
    for (const f of await readdir(channelsDir)) {
      if (f.endsWith(".config.json") && !keep.has(f)) { try { await unlink(join(channelsDir, f)); skipped.push(f); } catch {} }
    }
  } catch {}

  return { lineup: lineupPath, channels: written, skipped };
}

/** Write the guide channel's playout: repeating `script`-source items (each a
 *  `guide-stream` CLI invocation) across [startMs, finishMs]. Each item renders
 *  the guide fresh at spawn time, so the grid stays current every `refreshMin`. */
export async function writeGuidePlayout(store: ConfigStore, root: string, startMs: number, finishMs: number, tz: Tz): Promise<string | null> {
  const cfg = store.getNextConfig();
  const g = cfg.guide;
  if (!g.enabled) return null;
  const runtimeDir = abs(root, cfg.runtimeDir);
  const dir = join(runtimeDir, "playouts", "guide");
  const stepMs = Math.max(1, g.refreshMin || 30) * 60_000;
  const guideConfigPath = await writeGuideConfig(store, root, tz);
  const items: PlayoutItem[] = [];
  let id = 1;
  for (let t = startMs; t < finishMs; t += stepMs) {
    const end = Math.min(t + stepMs, finishMs);
    items.push({ id: String(id++), start: formatRfc3339(t, tz), finish: formatRfc3339(end, tz), source: guideSource(store, root, guideConfigPath) });
  }
  const playout: Playout = { version: PLAYOUT_VERSION, generated_at: new Date().toISOString(), items };
  return writePlayout(dir, playout, startMs, finishMs, tz);
}

/** The CLI that streams the guide: dist/cli.js, next to this module's folder. */
export const GUIDE_CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

/** The `script` source that streams the guide (a `guide-stream` CLI run). */
export function guideSource(store: ConfigStore, root: string, guideConfigPath: string): PlayoutItem["source"] {
  const cfg = store.getNextConfig();
  return {
    source_type: "script",
    command: process.execPath,
    args: [GUIDE_CLI, "guide-stream", "--config", guideConfigPath],
    is_live: true,
    probe_hint: {
      format_name: "mpegts",
      video: [{ stream_index: 0, codec: "h264", width: cfg.video.width, height: cfg.video.height, pix_fmt: "yuv420p" }],
      audio: [{ stream_index: 1, codec: "aac", channels: 2 }],
    },
  } as PlayoutItem["source"];
}

/** Write the guide-stream's config snapshot (by default runtime/guide-config.json;
 *  Troubleshooting writes its own copy with its own log file). */
export async function writeGuideConfig(store: ConfigStore, root: string, tz: Tz, at?: { configPath: string; logFile: string }): Promise<string> {
  const cfg = store.getNextConfig();
  const g = cfg.guide;
  const runtimeDir = abs(root, cfg.runtimeDir);

  // Snapshot everything the spawned guide-stream needs, so it never opens
  // app.sqlite (avoids a second DB handle while the server holds it open).
  const channels = store.channelMetas().filter((m) => m.enabled)
    .sort((a, b) => (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0))
    .map((m) => ({ number: m.number, name: m.name, tvgId: m.tvgId || m.name }));
  const theme = await loadGuideTheme(join(runtimeDir, "guide-themes"), g.theme || "classic");
  // Per-source live-fetch map (address + token) for resolving art:// poster refs.
  // Kept only in this local snapshot — never written into the served XMLTV.
  const libDbPath = absPath(root, store.get().libraryDbPath);
  const sources: Record<string, { address: string; token: string }> = {};
  try {
    for (const s of store.listSourceSecrets()) {
      if (!s.token) continue;
      let address: string | null = s.address;
      if (!address) { try { address = readSourceInfo(libDbPath, s.sourceId)?.address ?? null; } catch { address = null; } }
      if (address) sources[String(s.sourceId)] = { address: address.replace(/\/+$/, ""), token: s.token };
    }
  } catch { /* no remote sources */ }
  const guideConfigPath = at?.configPath ?? join(runtimeDir, "guide-config.json");
  await writeFile(guideConfigPath, JSON.stringify({
    channels, xmltvDir: join(runtimeDir, "xmltv"), tz,
    width: cfg.video.width, height: cfg.video.height, fps: "24",
    columns: g.columns, scrollSpeed: g.scrollSpeed, promoRotateSec: g.promoRotateSec,
    // (absolute: the stream runs in whatever folder next was started from)
    ffmpegPath: cfg.ffmpegPath ? abs(root, cfg.ffmpegPath) : "", ffprobePath: cfg.ffprobePath ? abs(root, cfg.ffprobePath) : "", fontFile: cfg.upNext.fontFile, musicFolder: g.musicFolder,
    promoFolder: g.promoFolder, sources,
    // themeId + dir so the stream reloads the theme file live (edits apply without
    // a full rebuild); `theme` is the snapshot fallback if the file is unreadable.
    themeId: g.theme || "classic", guideThemesDir: join(runtimeDir, "guide-themes"),
    logFile: at?.logFile ?? join(runtimeDir, "guide.log"),
    theme,
  }, null, 2), "utf8");
  return guideConfigPath;
}
