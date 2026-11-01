// -----------------------------------------------------------------------------
// Troubleshooting: system info, a hardware-encoder check, up-next card previews,
// and test plays.
// -----------------------------------------------------------------------------
// A test play runs a throwaway ErsatzTV next (its own lineup, port and folder
// under runtime/troubleshoot/) with a one-item playout, asks for the stream like
// a player would, and keeps the segments. So what you watch, and the ffmpeg
// command it reports, is exactly what a viewer's stream would get.
//
// next starts on a black placeholder. Once it answers, the real playout is written
// with the item placed so the wanted moment airs right now (black before and after,
// so nothing overlaps; the playout format has no in-point), and the stream is
// requested straight away. ErsatzTV next stamps each segment with its wall-clock
// time, so anything before the wanted moment is dropped by time.

import type { FastifyInstance } from "fastify";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { cpus, totalmem, release, platform, arch } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import type { ConfigStore, NextConfig } from "./config.js";
import type { NextRunner } from "./next-runner.js";
import { channelConfigJson, upNextOptionsFor } from "./nextgen.js";
import { upcoming } from "./graphics.js";
import { loadTheme } from "./upnext-themes.js";
import { itemDetail } from "./library-browse.js";
import { getResolver } from "./resolverCache.js";
import { upNextItem, type UpNextOptions } from "../engine.js";
import { applyLanguageTracks } from "../lang.js";
import { applyOverlays } from "../overlays.js";
import { overlayOptionsFor, overlayLibrary } from "./overlay-library.js";
import { inSeason } from "../overlays.js";
import { holidayDate } from "../holidays.js";
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
import { buildUpNextAss, DEFAULT_ASS_LAYOUT } from "../upnext-ass.js";
import { formatRfc3339 } from "../time.js";
import { PLAYOUT_VERSION_GRAPHICS, PLAYOUT_VERSION_LAYOUT, type GraphicsLayer, type PlayoutItem } from "../model.js";
import { parseWindowRange, playoutFilename } from "../emit.js";
import { playoutBaseDir } from "./nextgen.js";

const absUnder = (root: string, p: string) => (isAbsolute(p) || /^[A-Za-z]:/.test(p) ? p : join(root, p));
const LEAD_MS = 1500;         // black before an item played from its start (covers the request)
const WINDOW_MS = 12 * 3600000; // the test playout spans now ± 12 h
const KEEP_RUNS = 5;          // test folders kept on disk

// ---- small process helpers ---------------------------------------------------
function run(cmd: string, args: string[], timeoutMs = 20000, cwd?: string): Promise<{ ok: boolean; out: string; err: string; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, cwd }, (e, out, err) =>
      resolve({ ok: !e, out: String(out ?? ""), err: String(err ?? "") || (e ? e.message : ""), ms: Date.now() - t0 }));
  });
}

/** Stop a process and the ffmpeg processes it started. */
function killTree(child: ChildProcess): void {
  if (child.exitCode != null || !child.pid) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  else { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => { const a = srv.address(); srv.close(() => resolve(typeof a === "object" && a ? a.port : 0)); });
  });
}

// ---- ffprobe summary -----------------------------------------------------------
export interface ProbeSummary {
  file: string; container?: string; durationSec?: number; sizeBytes?: number; bitrateKbps?: number; chapters: number;
  streams: { index: number; kind: string; codec: string; profile?: string; detail: string; language?: string; title?: string; default: boolean; forced: boolean }[];
  error?: string;
}

async function probe(ffprobe: string, file: string): Promise<ProbeSummary> {
  const r = await run(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", file], 30000);
  if (!r.ok) return { file, chapters: 0, streams: [], error: r.err.trim() || "ffprobe failed" };
  try {
    const j = JSON.parse(r.out);
    const f = j.format ?? {};
    return {
      file, container: f.format_long_name || f.format_name, durationSec: f.duration ? Number(f.duration) : undefined,
      sizeBytes: f.size ? Number(f.size) : undefined, bitrateKbps: f.bit_rate ? Math.round(Number(f.bit_rate) / 1000) : undefined,
      chapters: (j.chapters ?? []).length,
      streams: (j.streams ?? []).map((s: any) => {
        const kind = s.codec_type ?? "data";
        let detail = "";
        if (kind === "video") {
          const fps = s.avg_frame_rate && s.avg_frame_rate !== "0/0" ? (() => { const [a, b] = s.avg_frame_rate.split("/").map(Number); return b ? Math.round((a / b) * 100) / 100 : a; })() : undefined;
          const hdr = /smpte2084|arib-std-b67/.test(s.color_transfer ?? "") ? (s.color_transfer === "arib-std-b67" ? "HDR (HLG)" : "HDR (PQ)") : "";
          detail = [`${s.width}×${s.height}`, fps ? `${fps} fps` : "", s.pix_fmt, s.field_order && s.field_order !== "progressive" && s.field_order !== "unknown" ? "interlaced" : "", hdr].filter(Boolean).join(", ");
        } else if (kind === "audio") {
          detail = [s.channel_layout || (s.channels ? `${s.channels} ch` : ""), s.sample_rate ? `${Math.round(Number(s.sample_rate) / 100) / 10} kHz` : ""].filter(Boolean).join(", ");
        }
        return {
          index: s.index, kind, codec: s.codec_name ?? "?", profile: s.profile, detail,
          language: s.tags?.language, title: s.tags?.title, default: !!s.disposition?.default, forced: !!s.disposition?.forced,
        };
      }),
    };
  } catch (e) { return { file, chapters: 0, streams: [], error: (e as Error).message }; }
}

// ---- hardware encoders -------------------------------------------------------
const ACCEL_SUFFIX: Record<string, string> = { cuda: "nvenc", qsv: "qsv", vaapi: "vaapi", amf: "amf", videotoolbox: "videotoolbox", vulkan: "vulkan", rkmpp: "rkmpp" };
const ACCEL_LABEL: Record<string, string> = { "": "Software", cuda: "NVIDIA (NVENC)", qsv: "Intel Quick Sync", vaapi: "VAAPI", amf: "AMD (AMF)", videotoolbox: "VideoToolbox", vulkan: "Vulkan", rkmpp: "Rockchip" };
const encoderFor = (codec: string, accel: string) => {
  const c = codec === "hevc" || codec === "h265" ? "hevc" : codec === "av1" ? "av1" : "h264";
  if (!accel) return c === "hevc" ? "libx265" : c === "av1" ? "libsvtav1" : "libx264";
  return `${c}_${ACCEL_SUFFIX[accel] ?? accel}`;
};

// ---- test plays ----------------------------------------------------------------
export interface TestRequest {
  kind: "item" | "upnext" | "playout";
  file?: string; itemId?: string;                    // kind "playout": a channel's built playout file + item id
  forceOverlay?: string; lead?: number;              // kind "playout": preview this overlay on the item, `lead` s after the start point
  type?: string; id?: number; startSec?: number;   // kind "item"
  at?: number; theme?: string;                      // kind "upnext" (the card lists from `at`)
  channel?: string;    // item: whose audio/subtitle settings (and overlays) to use; upnext: the channel
  overlays?: boolean;  // item: draw the channel's overlays (default true)
  durationSec?: number;
  accel?: string;      // "default" (the streaming setting) or an accel id ("none" = software)
}

interface Segment { name: string; startMs: number; durSec: number; arrivedMs: number; workAhead: boolean }

export interface TestRun {
  id: string; label: string; status: "starting" | "running" | "finishing" | "done" | "failed" | "stopped";
  message: string; startedAt: number; finishedAt?: number;
  request: TestRequest; accel: string; encoder: string; port: number;
  targetSec: number; capturedSec: number; firstSegmentSec?: number; speed?: number;
  pipelines: string[]; problems: string[]; log: string[];
  source?: ProbeSummary; output?: ProbeSummary; video: boolean;
}

export function registerTroubleshootRoutes(app: FastifyInstance, ctx: { store: ConfigStore; root: string; libDb: () => string; disabled: () => Iterable<number>; nextRunner?: NextRunner }): void {
  const { store, root } = ctx;
  const nc = () => store.getNextConfig();
  const runtimeDir = () => absUnder(root, nc().runtimeDir);
  const testsDir = () => join(runtimeDir(), "troubleshoot");
  const nextBinary = () => absUnder(root, nc().binaryPath || "bin/ersatztv.exe");
  const ffmpeg = () => nc().ffmpegPath || "ffmpeg";
  const ffprobe = () => nc().ffprobePath || "ffprobe";

  // ---- system ----------------------------------------------------------------
  app.get("/api/troubleshoot/system", async () => {
    const cfg = nc();
    const first = (s: string) => s.split(/\r?\n/).find((l) => l.trim()) ?? "";
    const [ffv, fpv, hw, enc, etv] = await Promise.all([
      run(ffmpeg(), ["-hide_banner", "-version"]), run(ffprobe(), ["-hide_banner", "-version"]),
      run(ffmpeg(), ["-hide_banner", "-hwaccels"]), run(ffmpeg(), ["-hide_banner", "-encoders"]),
      existsSync(nextBinary()) ? run(nextBinary(), ["--version"]) : Promise.resolve({ ok: false, out: "", err: "not found", ms: 0 }),
    ]);
    const encoders = enc.out.split(/\r?\n/).map((l) => l.match(/^\s*V\S*\s+(\S+)/)?.[1]).filter((n): n is string => !!n && /^(h264|hevc|av1)_|^lib(x264|x265|svtav1)$/.test(n));
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8").catch(() => "{}"));
    const runner = ctx.nextRunner?.status();
    return {
      scheduler: { version: pkg.version ?? "?", node: process.version, os: `${platform()} ${release()} (${arch()})`, cpu: cpus()[0]?.model ?? "?", cores: cpus().length, memoryGb: Math.round(totalmem() / 1e9) },
      ffmpeg: { path: ffmpeg(), ok: ffv.ok, version: ffv.ok ? first(ffv.out) : ffv.err.trim(), hwaccels: hw.out.split(/\r?\n/).slice(1).map((s) => s.trim()).filter(Boolean), encoders },
      ffprobe: { path: ffprobe(), ok: fpv.ok, version: fpv.ok ? first(fpv.out) : fpv.err.trim() },
      next: { path: nextBinary(), found: existsSync(nextBinary()), version: etv.ok ? first(etv.out) : "", phase: runner?.phase ?? "stopped", detail: runner?.detail ?? "", port: cfg.port, outputFolder: absUnder(runtimeDir(), cfg.outputFolder || "./output") },
      streaming: { codec: cfg.video.codec, accel: cfg.video.accel ?? "", accelLabel: ACCEL_LABEL[cfg.video.accel ?? ""] ?? cfg.video.accel, encoder: encoderFor(cfg.video.codec, cfg.video.accel ?? ""), size: `${cfg.video.width}×${cfg.video.height}`, bitrateKbps: cfg.video.bitrateKbps, audio: `${cfg.audio.codec} ${cfg.audio.bitrateKbps} kbps, ${cfg.audio.channels} ch${cfg.audio.normalizeLoudness ? ", loudness normalized" : ""}` },
    };
  });

  // Encode a short test pattern with each hardware encoder ffmpeg has, so you can
  // see which acceleration settings actually work on this machine.
  app.post("/api/troubleshoot/hwtest", async () => {
    const cfg = nc();
    const enc = await run(ffmpeg(), ["-hide_banner", "-encoders"]);
    const have = new Set(enc.out.split(/\r?\n/).map((l) => l.match(/^\s*V\S*\s+(\S+)/)?.[1]).filter(Boolean) as string[]);
    const codecs = [...new Set([cfg.video.codec === "hevc" ? "hevc" : "h264", "h264", "hevc"])];
    const results: { accel: string; label: string; codec: string; encoder: string; ok: boolean; ms: number; error?: string; current: boolean }[] = [];
    // accelerations that only exist on one platform
    const skip = new Set([...(process.platform === "linux" ? [] : ["vaapi"]), ...(process.platform === "darwin" ? [] : ["videotoolbox"])]);
    for (const accel of ["", ...Object.keys(ACCEL_SUFFIX)].filter((a) => !skip.has(a))) for (const codec of codecs) {
      const encoder = encoderFor(codec, accel);
      if (!have.has(encoder)) continue;
      // VAAPI and Vulkan encode from GPU frames, so upload the test pattern first
      const pre = accel === "vaapi" ? ["-vaapi_device", "/dev/dri/renderD128"] : accel === "vulkan" ? ["-init_hw_device", "vulkan=vk", "-filter_hw_device", "vk"] : [];
      const vf = accel === "vaapi" || accel === "vulkan" ? ["-vf", "format=nv12,hwupload"] : accel === "qsv" || accel === "amf" ? ["-pix_fmt", "nv12"] : ["-pix_fmt", "yuv420p"];
      const r = await run(ffmpeg(), ["-hide_banner", "-loglevel", "error", ...pre, "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30", "-t", "3", ...vf, "-c:v", encoder, "-f", "null", "-"], 30000);
      results.push({ accel, label: ACCEL_LABEL[accel] ?? accel, codec, encoder, ok: r.ok, ms: r.ms, error: r.ok ? undefined : r.err.trim().split(/\r?\n/).slice(-3).join("\n"), current: accel === (cfg.video.accel ?? "") && encoder === encoderFor(cfg.video.codec, cfg.video.accel ?? "") });
    }
    return { results };
  });

  // File details for a library item, before (or without) a test play.
  app.get("/api/troubleshoot/probe", async (req, reply) => {
    const q = req.query as { type?: string; id?: string };
    const d = itemDetail(ctx.libDb(), String(q.type), Number(q.id));
    if (!d?.path) { reply.code(404); return { error: "That item isn't in the library." }; }
    return { item: { title: d.showTitle ? `${d.showTitle} — ${d.title}` : d.title, durationMs: d.durationMs, path: d.path, library: d.library }, probe: await probe(ffprobe(), d.path) };
  });

  // ---- up-next cards ---------------------------------------------------------
  const cardOptions = async (channel: string, theme?: string) => upNextOptionsFor(store, channel, root, { theme: theme || undefined });
  const xmltvFor = (channel: string) => { const m = store.channelMeta(channel); return join(runtimeDir(), "xmltv", `${m?.tvgId || channel}.xml`); };

  /** The card's layers for the browser preview: relative image URLs + timing. */
  const previewLayers = (item: PlayoutItem) => (item.graphics ?? []).map((g: GraphicsLayer) => {
    const uri = (g as any).source?.uri as string;
    const t = (g as any).timing ?? {};
    return { url: uri.replace(/^https?:\/\/[^/]+/, ""), phaseMs: t.phase_offset_ms ?? 0, fadeMs: t.fade_ms ?? 0, holdMs: t.hold_ms ?? 0 };
  });

  // Card slots in a channel's built schedule between `from` and `to`.
  app.get("/api/troubleshoot/upnext/slots", async (req, reply) => {
    const q = req.query as { channel?: string; from?: string; to?: string };
    const channel = String(q.channel ?? ""), from = Number(q.from) || Date.now(), to = Number(q.to) || from + 86400000;
    if (!store.channelMeta(channel)) { reply.code(404); return { error: "Unknown channel." }; }
    const dir = join(runtimeDir(), "playouts", channel);
    const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json") && !f.endsWith(".labels.json"))
      .filter((f) => { const r = parseWindowRange(f); return !r || (r.finishMs > from && r.startMs < to); });
    const slots: { startMs: number; finishMs: number; anchorMs: number; next: string; nextAt: string }[] = [];
    for (const f of files) {
      try {
        const pl = JSON.parse(await readFile(join(dir, f), "utf8"));
        for (const it of pl.items ?? []) {
          const uri: string = it.graphics?.[0]?.source?.uri ?? it.tracks?.video?.source?.uri ?? "";
          if (!uri.includes("/graphics/upnext.png")) continue;
          const s = Date.parse(it.start), e = Date.parse(it.finish);
          if (e <= from || s >= to) continue;
          slots.push({ startMs: s, finishMs: e, anchorMs: Number(new URL(uri).searchParams.get("at")) || e, next: "", nextAt: "" });
        }
      } catch { /* skip an unreadable window */ }
    }
    slots.sort((a, b) => a.startMs - b.startMs);
    if (slots.length) {
      const guide = await upcoming(xmltvFor(channel), store.get().tz, slots[0].anchorMs, 5000);
      for (const s of slots) { const g = guide.find((r) => r.epochMs >= s.anchorMs - 1000); if (g) { s.next = g.title; s.nextAt = g.label; } }
    }
    return { slots, built: files.length > 0 };
  });

  // One card, laid out exactly as the engine would emit it.
  app.get("/api/troubleshoot/upnext/card", async (req, reply) => {
    const q = req.query as { channel?: string; at?: string; theme?: string; durationMs?: string };
    const channel = String(q.channel ?? "");
    const u = await cardOptions(channel, q.theme);
    if (!u) { reply.code(404); return { error: "That channel needs a channel number before it can show up-next cards." }; }
    const at = Number(q.at) || Date.now();
    const D = Math.max(3000, Number(q.durationMs) || u.durationMs);
    // the browser always previews the image version (subtitles mode draws the text on air)
    const item = upNextItem({ ...u, textMode: "image" }, "1", 0, D, at, store.get().tz);
    const rows = await upcoming(xmltvFor(channel), store.get().tz, at, u.count);
    const meta = store.channelMeta(channel);
    return {
      channel, theme: u.theme, count: u.count, durationMs: D, textMode: u.textMode ?? "image",
      width: u.width, height: u.height, layers: previewLayers(item), rows,
      audio: !!u.audioPath && existsSync(u.audioPath), audioName: u.audioPath ? basename(u.audioPath) : "",
      enabled: !!nc().upNext?.enabled && (meta?.upNextTheme || "splat") !== "off",
    };
  });

  // The channel's card music, for the preview.
  app.get("/api/troubleshoot/upnext/audio", async (req, reply) => {
    const u = await cardOptions(String((req.query as any).channel ?? ""));
    if (!u?.audioPath || !existsSync(u.audioPath)) { reply.code(404); return { error: "No card music for that channel." }; }
    const types: Record<string, string> = { ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac" };
    return sendFile(reply, req.headers.range, u.audioPath, types[extname(u.audioPath).toLowerCase()] ?? "application/octet-stream");
  });

  // ---- test play -------------------------------------------------------------
  let current: { run: TestRun; dir: string; child?: ChildProcess; stop: (why: TestRun["status"], msg: string) => void } | null = null;
  const runs = new Map<string, { run: TestRun; dir: string }>();

  app.post("/api/troubleshoot/play", async (req, reply) => {
    if (current && ["starting", "running", "finishing"].includes(current.run.status)) { reply.code(409); return { error: "A test is already running. Stop it first." }; }
    const body = (req.body ?? {}) as TestRequest;
    try { const r = await startTest(body); return r; }
    catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });
  app.get("/api/troubleshoot/play", async () => (current ? publicRun(current.run) : null));
  // when a channel's overlays next appear, from its built playout (for the Overlays tab)
  const HOLIDAY_NAMES: Record<string, string> = { new_years: "New Year's Day", new_years_eve: "New Year's Eve", valentines: "Valentine's Day", st_patricks: "St. Patrick's Day", july_fourth: "the Fourth of July", fourth_of_july: "the Fourth of July", mothers_day: "Mother's Day", fathers_day: "Father's Day", christmas_eve: "Christmas Eve", april_fools: "April Fools' Day" };
  const holidayName = (h: string) => HOLIDAY_NAMES[h] ?? h.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const seasonText = (se: { holiday?: string; before?: number; after?: number; from?: string; to?: string }, now: number): string => {
    if (se.holiday) {
      for (const y of [new Date(now).getFullYear(), new Date(now).getFullYear() + 1]) {
        const h = holidayDate(se.holiday, y);
        if (!h) break;
        const at = Date.UTC(y, h.month - 1, h.day);
        const a = new Date(at - (se.before ?? 0) * 86_400_000), b = new Date(at + (se.after ?? 0) * 86_400_000);
        if (b.getTime() + 86_400_000 < now) continue;
        const d = (x: Date) => x.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
        return `around ${holidayName(se.holiday)} (${d(a)} – ${d(b)})`;
      }
      return `around ${holidayName(se.holiday)}`;
    }
    return `between ${se.from} and ${se.to} each year`;
  };
  app.get("/api/troubleshoot/overlay-moments", async (req) => {
    const q = req.query as { channel?: string; overlay?: string };
    const channel = String(q.channel ?? "");
    const dir = join(playoutBaseDir(store, root), channel);
    if (!channel || !existsSync(dir)) return { moments: [], note: "This channel hasn't been built yet — build it on the Build page first." };
    const now = Date.now();
    const files = (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.endsWith(".labels.json")).sort();
    const moments: { file: string; itemId: string; itemStart: number; at: number; overlay: string; path: string; filler: boolean }[] = [];
    const programmes: { file: string; itemId: string; itemStart: number; path: string }[] = [];
    let tagged = 0, builtUntil = 0;
    for (const name of files) {
      const w = parseWindowRange(name);
      if (w && w.finishMs < now) continue;
      let labels: Record<string, any> = {};
      try { labels = JSON.parse(await readFile(join(dir, name.replace(/\.json$/, ".labels.json")), "utf8")); } catch { /* none */ }
      const pl = JSON.parse(await readFile(join(dir, name), "utf8"));
      for (const it of pl.items ?? []) {
        const marks: { id: string; at: number }[] = labels[it.id]?.overlays ?? [];
        if (marks.length) tagged++;
        const start = Date.parse(it.start), finish = Date.parse(it.finish);
        builtUntil = Math.max(builtUntil, finish);
        if (!labels[it.id]?.fillerKind && finish > now + 60_000 && programmes.length < 12 && it.source?.path) programmes.push({ file: name, itemId: it.id, itemStart: start, path: it.source.path });
        for (const m of marks) {
          if (q.overlay && m.id !== q.overlay) continue;
          const at = start + m.at;
          if (at < now - 30_000 || at >= finish) continue;
          moments.push({ file: name, itemId: it.id, itemStart: start, at, overlay: m.id, path: it.source?.path ?? "", filler: !!labels[it.id]?.fillerKind });
        }
      }
      if (moments.length >= 40) break;
    }
    moments.sort((a, b) => a.at - b.at);
    if (moments.length) return { moments: moments.slice(0, 20), note: "" };
    // nothing found: say why (a holiday window is the usual reason), and offer to preview it anyway
    const tz = store.get().tz;
    const lib = new Map(overlayLibrary(store).map((o) => [o.id, o]));
    const ids = q.overlay ? [q.overlay] : (store.channelMeta(channel)?.overlays ?? []);
    const outOfSeason: { id: string; name: string; when: string }[] = [];
    for (const id of ids) {
      const o = lib.get(id);
      if (!o?.season) continue;
      let any = false;
      for (let t = now; t <= Math.max(now, builtUntil) && !any; t += 6 * 3_600_000) any = inSeason(o.season, t, tz);
      if (!any) outOfSeason.push({ id, name: o.name, when: seasonText(o.season, now) });
    }
    const until = builtUntil ? new Date(builtUntil).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
    const note = outOfSeason.length
      ? `${outOfSeason.map((x) => `"${x.name}" only shows ${x.when}`).join("; ")}. What's built for this channel (through ${until}) is outside that, so it isn't in the playout yet — that's expected. You can still preview it on one of the shows below.`
      : tagged ? "It doesn't appear in what's built for this channel — check its timing (\"When it shows\"). You can preview it on one of the shows below."
      : "No overlays are in this channel's built playout yet — rebuild the channel after giving it overlays, or preview one on the shows below.";
    return { moments: [], note, outOfSeason, programmes };
  });
  app.get("/api/troubleshoot/play/:id", async (req, reply) => {
    const r = runs.get((req.params as any).id);
    if (!r) { reply.code(404); return { error: "That test isn't available any more." }; }
    return publicRun(r.run);
  });
  app.post("/api/troubleshoot/play/:id/stop", async (req) => {
    if (current && current.run.id === (req.params as any).id) current.stop("stopped", "Stopped.");
    return current ? publicRun(current.run) : null;
  });
  app.get("/api/troubleshoot/play/:id/video.mp4", async (req, reply) => {
    const r = runs.get((req.params as any).id);
    const file = r && join(r.dir, "result.mp4");
    if (!file || !existsSync(file)) { reply.code(404); return { error: "No video for that test." }; }
    if ((req.query as any).download) attachment(reply, `${downloadName(r.run)}.mp4`);
    return sendFile(reply, req.headers.range, file, "video/mp4");
  });
  // A copy that plays anywhere (Discord, phones, editors): H.264 + AAC, made on first ask.
  const converting = new Map<string, Promise<{ sizeBytes: number; error?: string }>>();
  app.post("/api/troubleshoot/play/:id/shareable", async (req, reply) => {
    const id = (req.params as any).id, r = runs.get(id);
    if (!r || !existsSync(join(r.dir, "result.mp4"))) { reply.code(404); return { error: "No video for that test." }; }
    if (!converting.has(id)) converting.set(id, makeShareable(ffmpeg(), r.dir, r.run.output?.durationSec).finally(() => setTimeout(() => converting.delete(id), 1000)));
    const res = await converting.get(id)!;
    if (res.error) { reply.code(500); return res; }
    return res;
  });
  app.get("/api/troubleshoot/play/:id/shareable.mp4", async (req, reply) => {
    const r = runs.get((req.params as any).id);
    const file = r && join(r.dir, "shareable.mp4");
    if (!file || !existsSync(file)) { reply.code(404); return { error: "Make the shareable copy first." }; }
    attachment(reply, `${downloadName(r.run)} (H.264).mp4`);
    return sendFile(reply, req.headers.range, file, "video/mp4");
  });
  app.get("/api/troubleshoot/play/:id/report.txt", async (req, reply) => {
    const r = runs.get((req.params as any).id);
    if (!r) { reply.code(404); return { error: "That test isn't available any more." }; }
    reply.header("content-type", "text/plain; charset=utf-8").header("content-disposition", `attachment; filename="test-play-${r.run.id}.txt"`);
    return reportText(r.run);
  });

  const publicRun = (r: TestRun) => ({ ...r, log: r.log.slice(-200) });

  async function startTest(req: TestRequest): Promise<TestRun> {
    const cfg = nc();
    if (!existsSync(nextBinary())) throw new Error(`ErsatzTV next wasn't found at ${nextBinary()}. Set its path on the Streaming page.`);
    const tz = store.get().tz;
    const accel = !req.accel || req.accel === "default" ? cfg.video.accel ?? "" : req.accel === "none" ? "" : req.accel;
    // the item, placed at a start time decided once next is up
    let overlayNote = "";
    let mkItem: (startMs: number) => PlayoutItem, label: string, targetSec: number, startSec = 0, sourcePath: string | undefined;
    const files: { path: string; text: string }[] = [];

    if (req.kind === "upnext") {
      const channel = String(req.channel ?? "");
      const u = await cardOptions(channel, req.theme);
      if (!u) throw new Error("That channel needs a channel number before it can show up-next cards.");
      const at = Number(req.at) || Date.now();
      const D = Math.max(3000, Number(req.durationSec) * 1000 || u.durationMs);
      let ass: PlayoutItem["tracks"] | undefined;
      if (u.textMode === "subtitles") {
        // same as a build: the next few shows, drawn as a burned subtitle track
        const def = await loadTheme(join(runtimeDir(), "upnext-themes"), u.theme);
        const rows = (await upcoming(xmltvFor(channel), tz, at, u.count)).map((r) => ({ label: r.label, title: r.title }));
        files.push({ path: "card.ass", text: buildUpNextAss(rows, u.width, u.height, D, { ...DEFAULT_ASS_LAYOUT, ...((def as any).ass ?? {}) }) });
        ass = { subtitle: { source: { source_type: "local", path: "__DIR__/card.ass" } } };
      }
      mkItem = (t) => { const it = upNextItem(u, "2", t, t + D, at, tz); if (ass) it.tracks = { ...(it.tracks ?? {}), ...ass }; return it; };
      label = `Up-next card · ${channel} · ${u.theme}`;
      targetSec = D / 1000;
    } else if (req.kind === "playout") {
      // an item exactly as the channel's build made it (overlays included)
      const dir = join(playoutBaseDir(store, root), String(req.channel ?? ""));
      const file = basename(String(req.file ?? ""));
      if (!req.channel || !file.endsWith(".json") || !existsSync(join(dir, file))) throw new Error("That playout window isn't there any more — rebuild the channel and pick again.");
      const pl = JSON.parse(await readFile(join(dir, file), "utf8"));
      const src = (pl.items ?? []).find((i: PlayoutItem) => i.id === String(req.itemId));
      if (!src) throw new Error("That playout item isn't there any more — rebuild the channel and pick again.");
      const lenSec = Math.max(1, (Date.parse(src.finish) - Date.parse(src.start)) / 1000);
      startSec = Math.min(Math.max(0, Number(req.startSec) || 0), Math.max(0, lenSec - 2));
      targetSec = Math.min(Math.max(5, Number(req.durationSec) || 30), 300, lenSec - startSec);
      const path = (src.source as any)?.path as string | undefined;
      if (path && !existsSync(path)) throw new Error(`The file isn't reachable from this machine: ${path}`);
      if (req.forceOverlay) {
        // preview: this one overlay on this show, whatever its holiday window, coming on a few seconds in
        const o = overlayLibrary(store).find((x) => x.id === req.forceOverlay);
        if (!o) throw new Error("That overlay isn't in the library any more.");
        const lead = Math.max(0, Number(req.lead ?? 4));
        const show = o.timing?.mode === "always" || !o.timing?.mode ? 10 : Math.max(1, Number(o.timing.showSeconds ?? 10));
        const preview = { ...clone(o), id: "__preview", season: undefined, timing: { mode: "start" as const, offsetSeconds: startSec + lead, showSeconds: show } };
        const s0 = Date.parse(src.start), s1 = Date.parse(src.finish);
        const rows = await upcoming(xmltvFor(String(req.channel)), tz, s0 - 12 * 3_600_000, 600);
        const ci = rows.reduce((k, r, i) => (r.epochMs <= s0 + 1000 ? i : k), -1);
        const cur = ci >= 0 ? rows[ci] : undefined, nxt = rows[ci + 1];
        const guide = [{ startMs: s0, stopMs: s1, item: { id: "0", path: path ?? "", durationMs: s1 - s0, chapters: [], title: "", showTitle: cur?.title ?? "" } as any },
          ...(nxt ? [{ startMs: nxt.epochMs, stopMs: nxt.epochMs + 1800_000, item: { id: "1", path: "", durationMs: 1800_000, chapters: [], title: "", showTitle: nxt.title } as any }] : [])];
        const probe: PlayoutItem = { id: "2", start: src.start, finish: src.finish, source: src.source };
        const r = await applyOverlays([probe], new Map([["2", ["__preview"]]]), {}, guide, tz, { ...overlayOptionsFor(store, String(req.channel), root), library: [preview as any] });
        if (!probe.graphics?.length) throw new Error(`The overlay couldn't be drawn${r.problems.length ? `: ${r.problems.join("; ")}` : ""}.`);
        src.graphics = [...probe.graphics, ...(src.graphics ?? [])];
        overlayNote = `previewing "${o.name}"`;
      }
      mkItem = (t) => ({ ...clone(src), id: "2", start: formatRfc3339(t, tz), finish: formatRfc3339(t + lenSec * 1000, tz) });
      label = `${req.channel} · ${path ? basename(path).replace(/\.[^.]+$/, "") : "item"}${overlayNote ? ` · ${overlayNote}` : ""}`;
      sourcePath = path;
    } else {
      const d = itemDetail(ctx.libDb(), String(req.type), Number(req.id));
      if (!d?.path) throw new Error("Pick an item from the library first.");
      if (!existsSync(d.path)) throw new Error(`The file isn't reachable from this machine: ${d.path}`);
      const lenSec = Math.max(1, d.durationMs / 1000);
      startSec = Math.min(Math.max(0, Number(req.startSec) || 0), Math.max(0, lenSec - 2));
      targetSec = Math.min(Math.max(5, Number(req.durationSec) || 30), 300, lenSec - startSec);
      // the channel's audio language + subtitles setting, as a build would apply them
      const meta = req.channel ? store.channelMeta(req.channel) : undefined;
      const path = d.path;
      // the channel's overlays, as a build of this item as a programme would draw them
      // (worked out once against the item's own start; timings are relative to it)
      let overlayLayers: GraphicsLayer[] = [];
      if (meta && req.overlays !== false && (meta.overlays ?? []).length) {
        const probe: PlayoutItem = { id: "2", start: formatRfc3339(0, tz), finish: formatRfc3339(d.durationMs, tz), source: { source_type: "local", path } };
        const item = { id: String(d.id), path, durationMs: d.durationMs, chapters: [], title: d.title, showTitle: d.showTitle, season: d.season, episodeNumber: d.episode, year: d.year ?? undefined, kind: d.type } as any;
        const r = await applyOverlays([probe], new Map([["2", meta.overlays]]), {}, [{ startMs: 0, stopMs: d.durationMs, item }], tz, overlayOptionsFor(store, meta.name, root));
        overlayLayers = probe.graphics ?? [];
        if (r.problems.length) overlayNote = `Overlays: ${r.problems.join("; ")}`;
      }
      mkItem = (t) => {
        const it: PlayoutItem = { id: "2", start: formatRfc3339(t, tz), finish: formatRfc3339(t + d.durationMs, tz), source: { source_type: "local", path } };
        if (overlayLayers.length) it.graphics = clone(overlayLayers);
        if (meta) {
          const r = getResolver(ctx.libDb()); r.setDisabledLibraries(ctx.disabled());
          applyLanguageTracks({ version: "", items: [it] } as any, r, { audio: meta.audioLang, subtitles: meta.subtitles });
        }
        return it;
      };
      label = d.showTitle ? `${d.showTitle} — ${d.title}` : d.title;
      if (overlayLayers.length) label += ` · with ${overlayLayers.length} overlay${overlayLayers.length === 1 ? "" : "s"}`;
      if (overlayNote) label += ` (${overlayNote})`;
      sourcePath = d.path;
    }

    // ---- folder, lineup, channel config, playout
    await mkdir(testsDir(), { recursive: true });
    const old = (await readdir(testsDir()).catch(() => [] as string[])).filter((f) => f.startsWith("test-")).sort();
    for (const f of old.slice(0, Math.max(0, old.length - (KEEP_RUNS - 1)))) { await rm(join(testsDir(), f), { recursive: true, force: true }).catch(() => {}); runs.delete(f.slice(5)); }
    const id = new Date().toISOString().replace(/[-:T]/g, "").replace(/\..*/, "");
    const dir = join(testsDir(), `test-${id}`);
    const port = await freePort();
    await mkdir(join(dir, "channels"), { recursive: true });
    await mkdir(join(dir, "playouts", "test"), { recursive: true });
    await mkdir(join(dir, "kept"), { recursive: true });
    for (const f of files) await writeFile(join(dir, f.path), f.text, "utf8");
    const json = (o: unknown) => JSON.stringify(o, null, 2).replaceAll("__DIR__", dir.replace(/\\/g, "\\\\"));
    const chCfg: NextConfig = { ...cfg, video: { ...cfg.video, accel } };
    await writeFile(join(dir, "channels", "test.config.json"), json(channelConfigJson("test", chCfg)), "utf8");
    await writeFile(join(dir, "lineup.json"), json({
      server: { bind_address: "127.0.0.1", port }, output: { folder: join(dir, "output") }, xmltv: { folder: "./xmltv" },
      channels: [{ number: "1", name: "Test play", config: "./channels/test.config.json", tvg_id: "test-play", logo: "", group: "" }],
    }), "utf8");
    const black = (s: number, e: number, n: string): PlayoutItem => ({
      id: n, start: formatRfc3339(s, tz), finish: formatRfc3339(e, tz),
      tracks: { video: { source: { source_type: "lavfi", params: `color=c=black:s=${cfg.video.width}x${cfg.video.height}:r=24` } }, audio: { source: { source_type: "lavfi", params: "anullsrc=channel_layout=stereo:sample_rate=48000" } } },
    });
    // (black always starts just before now: next makes lavfi sources by seeking, so
    // a long-running black item would stall it)
    const playoutDir = join(dir, "playouts", "test");
    const t = Date.now() - 1000;
    let playoutFile = join(playoutDir, playoutFilename(t, t + WINDOW_MS, tz));
    await writeFile(playoutFile, json({ version: PLAYOUT_VERSION_GRAPHICS, items: [black(t, t + WINDOW_MS, "1")] }), "utf8");
    /** Write the real playout so the wanted moment airs now; returns that moment. */
    const placeItem = async (): Promise<number> => {
      const now = Date.now();
      const wanted = startSec > 0 ? now : now + LEAD_MS;
      const it = mkItem(wanted - startSec * 1000);
      const s = Date.parse(it.start), e = Date.parse(it.finish);
      const items = [...(startSec > 0 ? [] : [black(now - 1000, s, "1")]), it, black(e, e + WINDOW_MS, "3")];
      const first = Date.parse(items[0].start), last = e + WINDOW_MS;
      await rm(playoutFile, { force: true });
      playoutFile = join(playoutDir, playoutFilename(first, last, tz));
      await writeFile(playoutFile + ".tmp", json({ version: items.some((i: PlayoutItem) => i.graphics?.some((g) => g.layout)) ? PLAYOUT_VERSION_LAYOUT : PLAYOUT_VERSION_GRAPHICS, items }), "utf8");
      await rename(playoutFile + ".tmp", playoutFile);
      return wanted;
    };

    const runRec: TestRun = {
      id, label, status: "starting", message: "Starting ErsatzTV next…", startedAt: Date.now(), request: req, accel,
      encoder: encoderFor(cfg.video.codec, accel), port, targetSec, capturedSec: 0, pipelines: [], problems: [], log: [], video: false,
    };
    runs.set(id, { run: runRec, dir });
    const state = { run: runRec, dir, child: undefined as ChildProcess | undefined, stop: (_w: TestRun["status"], _m: string) => {} };
    current = state;
    void execute(state, placeItem, sourcePath);
    return publicRun(runRec);
  }

  async function execute(state: NonNullable<typeof current>, placeItem: () => Promise<number>, sourcePath?: string): Promise<void> {
    const { run: r, dir } = state;
    const note = (line: string) => { r.log.push(line); if (r.log.length > 2000) r.log.splice(0, r.log.length - 2000); };
    const segs = new Map<string, Segment>();
    let sessionState = "", firstRequest = 0, stopped = false, T0 = Infinity;
    let finish: (why: TestRun["status"], msg: string) => void = () => {};
    const done = new Promise<void>((resolve) => { finish = (why, msg) => { if (stopped) return; stopped = true; r.status = why === "done" ? "finishing" : why; r.message = msg; resolve(); }; });
    state.stop = (why, msg) => finish(why, msg);

    const child = spawn(nextBinary(), ["lineup.json"], { cwd: dir, windowsHide: true, detached: process.platform !== "win32" });
    state.child = child;
    let buf = "";
    const onData = (d: Buffer) => {
      buf += String(d);
      const lines = buf.split(/\r?\n/); buf = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.replace(/^\[\S+\s+/, "[");
        note(line);
        const p = raw.match(/optimized pipeline: (.*)$/); if (p) r.pipelines.push(`"${ffmpeg()}" ${p[1]}`);
        const s = raw.match(/channel session state: (\S+)/); if (s) sessionState = s[1];
        // (once the test is over, errors are just from shutting next down mid-write)
        if (!stopped && (/\b(ERROR|WARN)\b/.test(raw) || /^\s*(\[[a-z0-9_]* ?@ [0-9a-fx]+\]|Error|error)/i.test(raw))) r.problems.push(line);
      }
    };
    child.stdout?.on("data", onData); child.stderr?.on("data", onData);
    child.on("error", (e) => { note(`could not start: ${e.message}`); finish("failed", `Couldn't start ErsatzTV next: ${e.message}`); });
    child.on("exit", (code) => { note(`ErsatzTV next exited (code ${code})`); finish(r.capturedSec > 0 ? "done" : "failed", r.capturedSec > 0 ? "Finished." : "ErsatzTV next stopped before producing any video. See the log below."); });

    const base = `http://127.0.0.1:${r.port}`;
    const timeout = setTimeout(() => finish(r.capturedSec > 0 ? "done" : "failed", r.capturedSec > 0 ? "Timed out; showing what was captured." : "Timed out waiting for video. See the log below."), (r.targetSec * 2 + 60) * 1000);
    const poll = setInterval(async () => {
      if (stopped) return;
      try {
        // keep the session alive like a player, and copy each new segment as it lands
        if (r.status === "starting") {
          const ok = await fetch(`${base}/channels.m3u`, { signal: AbortSignal.timeout(1500) }).then((x) => x.ok).catch(() => false);
          if (!ok) return;
          T0 = await placeItem();
          r.status = "running"; r.message = "Streaming…"; firstRequest = Date.now();
        }
        void fetch(`${base}/channel/1.m3u8`, { signal: AbortSignal.timeout(8000) }).then((x) => x.text()).catch(() => "");
        const outDir = join(dir, "output", "1");
        const pl = await readFile(join(outDir, "ffmpeg.m3u8"), "utf8").catch(() => "");
        let dur = 0, pdt = 0;
        for (const line of pl.split(/\r?\n/)) {
          const inf = line.match(/^#EXTINF:([\d.]+)/); if (inf) { dur = Number(inf[1]); continue; }
          const t = line.match(/^#EXT-X-PROGRAM-DATE-TIME:(.+)$/); if (t) { pdt = Date.parse(t[1].replace(/([+-]\d{2})(\d{2})$/, "$1:$2")); continue; }
          if (/^live\d+\.ts$/.test(line.trim()) && !segs.has(line.trim()) && dur) {
            const name = line.trim();
            // only segments of the test item (the lead-in is dropped by time)
            if (pdt >= T0 - 100 && pdt < T0 + r.targetSec * 1000) {
              await copyFile(join(outDir, name), join(dir, "kept", name)).catch(() => {});
              if (existsSync(join(dir, "kept", name))) {
                segs.set(name, { name, startMs: pdt, durSec: dur, arrivedMs: Date.now(), workAhead: /WorkAhead/.test(sessionState) });
                if (r.firstSegmentSec == null) r.firstSegmentSec = Math.round((Date.now() - firstRequest) / 100) / 10;
              }
            } else segs.set(name, { name, startMs: pdt, durSec: 0, arrivedMs: Date.now(), workAhead: false }); // seen, not kept
            dur = 0;
          }
        }
        r.capturedSec = Math.round([...segs.values()].reduce((a, s) => a + s.durSec, 0) * 10) / 10;
        if (r.capturedSec >= r.targetSec - 0.5) finish("done", "Finished.");
      } catch (e) { note(`poll: ${(e as Error).message}`); }
    }, 700);

    await done;
    clearInterval(poll); clearTimeout(timeout);
    killTree(child);

    // ---- stitch the kept segments into one playable file
    const kept = [...segs.values()].filter((s) => s.durSec > 0).sort((a, b) => a.startMs - b.startMs);
    const wa = kept.filter((s) => s.workAhead);
    if (wa.length >= 2) { const span = (wa[wa.length - 1].arrivedMs - wa[0].arrivedMs) / 1000; if (span > 0) r.speed = Math.round((wa.slice(1).reduce((a, s) => a + s.durSec, 0) / span) * 10) / 10; }
    if (kept.length) {
      r.message = r.status === "finishing" ? "Putting the video together…" : r.message;
      const first = await probe(ffprobe(), join(dir, "kept", kept[0].name));
      const hevc = first.streams.some((s) => s.kind === "video" && s.codec === "hevc");
      // segment names are relative to the kept folder, which the join runs in
      const m = await run(ffmpeg(), ["-hide_banner", "-loglevel", "error", "-y", "-i", `concat:${kept.map((s) => s.name).join("|")}`, "-c", "copy", ...(hevc ? ["-tag:v", "hvc1"] : []), "-movflags", "+faststart", join(dir, "result.mp4")], 120000, join(dir, "kept"));
      if (!m.ok) note(`combining segments failed: ${m.err.trim()}`);
      r.video = existsSync(join(dir, "result.mp4"));
      if (r.video) r.output = await probe(ffprobe(), join(dir, "result.mp4"));
    }
    if (sourcePath) r.source = await probe(ffprobe(), sourcePath);
    if (r.status === "finishing") { r.status = "done"; r.message = r.video ? "Finished." : "Finished, but the video couldn't be put together. See the log below."; }
    r.finishedAt = Date.now();
    await rm(join(dir, "output"), { recursive: true, force: true }).catch(() => {});
    await rm(join(dir, "kept"), { recursive: true, force: true }).catch(() => {});
    await writeFile(join(dir, "report.txt"), reportText(r), "utf8").catch(() => {});
  }
}

/** Tell the browser to save the response as `name` (non-ASCII kept via filename*). */
function attachment(reply: any, name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  reply.header("content-disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`);
}

/** "Up-next card - Halloween Movies - halloween - 2026-10-31 2000": the card's
 *  time slot (or when the test ran), safe as a file name. */
function downloadName(r: TestRun): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = new Date(r.request.kind === "upnext" && r.request.at ? r.request.at : r.startedAt);
  const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${r.label.replace(/ · /g, " - ")} - ${when}`.replace(/[\\/:*?"<>|\x00-\x1f]/g, "").replace(/\s+/g, " ").trim().slice(0, 150);
}

const DISCORD_LIMIT = 10 * 1024 * 1024; // Discord's free upload limit

/** Re-encode a test's video as H.264 High + AAC stereo in a fast-start MP4: the
 *  format Discord, browsers and phones all play inline. If it comes out over
 *  Discord's 10 MB limit it's redone at a bitrate aimed at ~9.5 MB (720p when
 *  that bitrate is too thin for 1080p). */
async function makeShareable(ffmpeg: string, dir: string, durationSec?: number): Promise<{ sizeBytes: number; error?: string }> {
  const src = join(dir, "result.mp4"), out = join(dir, "shareable.mp4"), tmp = join(dir, "shareable.part.mp4");
  if (existsSync(out)) return { sizeBytes: statSync(out).size };
  const encode = (video: string[], height: number) => run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", `scale=-2:'min(${height},ih)',format=yuv420p`,
    "-c:v", "libx264", "-preset", "medium", "-profile:v", "high", "-level:v", "4.1", ...video,
    "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000", "-movflags", "+faststart", "-f", "mp4", tmp,
  ], 10 * 60_000);
  let res = await encode(["-crf", "23", "-maxrate", "6M", "-bufsize", "12M"], 1080);
  if (res.ok && statSync(tmp).size > DISCORD_LIMIT && durationSec) {
    const kbps = Math.floor((9.5 * 8 * 1024 * 1024) / durationSec / 1000) - 128;
    if (kbps >= 300) res = await encode(["-b:v", `${kbps}k`, "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`], kbps < 2500 ? 720 : 1080);
  }
  if (!res.ok) { await rm(tmp, { force: true }).catch(() => {}); return { sizeBytes: 0, error: `Converting the video failed: ${res.err.trim().split("\n").pop() ?? "unknown error"}` }; }
  await rename(tmp, out);
  return { sizeBytes: statSync(out).size };
}

/** Serve a file with byte-range support (the video player seeks with ranges). */
function sendFile(reply: any, range: string | undefined, file: string, type: string) {
  const size = statSync(file).size;
  const m = range?.match(/bytes=(\d*)-(\d*)/);
  reply.header("accept-ranges", "bytes").header("content-type", type).header("cache-control", "no-store");
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
    reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", end - start + 1);
    return reply.send(createReadStream(file, { start, end }));
  }
  reply.header("content-length", size);
  return reply.send(createReadStream(file));
}

function reportText(r: TestRun): string {
  const probeText = (p?: ProbeSummary) => !p ? "  (none)" : p.error ? `  ${p.error}` : [
    `  ${p.file}`, `  ${p.container ?? "?"}, ${p.durationSec ? `${Math.round(p.durationSec)} s` : "?"}, ${p.bitrateKbps ?? "?"} kbps, ${p.chapters} chapters`,
    ...p.streams.map((s) => `  #${s.index} ${s.kind}: ${s.codec}${s.profile ? ` (${s.profile})` : ""} ${s.detail}${s.language ? ` [${s.language}]` : ""}${s.title ? ` "${s.title}"` : ""}${s.default ? " default" : ""}${s.forced ? " forced" : ""}`),
  ].join("\n");
  return [
    `Test play: ${r.label}`, `Started: ${new Date(r.startedAt).toString()}`, `Result: ${r.status} - ${r.message}`,
    `Acceleration: ${ACCEL_LABEL[r.accel] ?? r.accel} (${r.encoder})`, `Captured: ${r.capturedSec} of ${r.targetSec} s`,
    r.firstSegmentSec != null ? `First video after: ${r.firstSegmentSec} s` : "", r.speed ? `Encoding speed while working ahead: ${r.speed}x realtime` : "",
    "", "Source:", probeText(r.source), "", "Result:", probeText(r.output),
    "", "ffmpeg commands run by ErsatzTV next:", ...r.pipelines.map((p) => `  ${p}`),
    "", "Problems:", ...(r.problems.length ? r.problems.map((p) => `  ${p}`) : ["  (none)"]),
    "", "Log:", ...r.log.map((l) => `  ${l}`), "",
  ].filter((l) => l !== "").join("\n").replace(/\nSource:/, "\n\nSource:");
}
