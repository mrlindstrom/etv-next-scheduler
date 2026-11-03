// -----------------------------------------------------------------------------
// HDHomeRun tuner emulation (Streaming → Plex / HDHomeRun)
// -----------------------------------------------------------------------------
// Plex's Live TV & DVR only takes HDHomeRun tuners, and those stream one plain
// MPEG-TS per channel. ErsatzTV next serves HLS only, so this runs a small
// HDHomeRun-shaped server on its own port (the dashboard, which has no login,
// stays off it):
//   /discover.json, /lineup_status.json, /lineup.json, /device.xml   what Plex reads
//   /auto/v<number>      the channel as one continuous MPEG-TS
//   /xmltv.xml           next's guide, with each channel's number added so Plex matches it
// A tune runs one ffmpeg that reads the channel's HLS playlist from next and
// copies it, without re-encoding, into a TS stream — the same way ErsatzTV itself
// feeds Plex. So everything still plays through next; this only repackages it.
// The lineup is next's own lineup.json, so Plex sees exactly what next serves.

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ConfigStore, NextConfig } from "./config.js";
import { lanAddress } from "./channel-logos.js";
import { appLog } from "./app-log.js";

interface Tune { id: number; channel: string; name: string; client: string; startedMs: number; bytes: number; proc: ChildProcess }

export interface HdhrStatus {
  enabled: boolean; listening: boolean; port: number; error: string;
  address: string;          // what to type into Plex
  guideUrl: string;         // the XMLTV address for Plex's guide step
  tuners: number; deviceId: string; name: string;
  inUse: { channel: string; name: string; client: string; sinceSec: number; mb: number }[];
}

export class HdhrTuner {
  private app: FastifyInstance | null = null;
  private listeningOn = 0;
  private error = "";
  private tunes = new Map<number, Tune>();
  private nextId = 1;

  constructor(private store: ConfigStore, private root: string) {}

  private cfg() { return this.store.getNextConfig(); }
  private abs(p: string) { return isAbsolute(p) || /^[A-Za-z]:/.test(p) ? p : join(this.root, p); }

  /** A stable 8-hex device id, made once (Plex remembers tuners by it). */
  private deviceId(): string {
    const h = this.cfg().hdhr;
    if (/^[0-9A-F]{8}$/.test(h.deviceId)) return h.deviceId;
    const id = randomBytes(4).toString("hex").toUpperCase();
    this.store.setNextConfig({ hdhr: { ...h, deviceId: id } } as Partial<NextConfig>);
    return id;
  }

  /** Start, stop or move the listener to match the saved settings. */
  async reconfigure(): Promise<void> {
    const h = this.cfg().hdhr;
    const want = h.enabled ? h.port : 0;
    if (want === this.listeningOn && (want === 0 || this.app)) return;
    if (this.app) { const a = this.app; this.app = null; this.listeningOn = 0; this.stopAll(); await a.close().catch(() => {}); }
    this.error = "";
    if (!want) return;
    this.deviceId();
    const app = Fastify({ logger: false, exposeHeadRoutes: false });
    this.routes(app);
    try {
      await app.listen({ port: want, host: "0.0.0.0" });
      this.app = app; this.listeningOn = want;
      appLog("hdhr", `HDHomeRun tuner listening on port ${want}`);
    } catch (e) {
      this.error = (e as NodeJS.ErrnoException).code === "EADDRINUSE"
        ? `Port ${want} is already in use by another program. Pick a different port.`
        : (e as Error).message;
      appLog("hdhr", `HDHomeRun tuner couldn't start: ${this.error}`);
      await app.close().catch(() => {});
    }
  }

  status(): HdhrStatus {
    const h = this.cfg().hdhr;
    const addr = `${lanAddress()}:${h.port}`;
    return {
      enabled: h.enabled, listening: !!this.app, port: h.port, error: this.error,
      address: addr, guideUrl: `http://${addr}/xmltv.xml`, tuners: h.tuners, deviceId: h.deviceId, name: h.name,
      inUse: [...this.tunes.values()].map((t) => ({ channel: t.channel, name: t.name, client: t.client, sinceSec: Math.round((Date.now() - t.startedMs) / 1000), mb: Math.round(t.bytes / 1e5) / 10 })),
    };
  }

  stopAll() { for (const t of this.tunes.values()) t.proc.kill(); this.tunes.clear(); }

  /** next's own lineup: number + name per channel, in its order. */
  private async lineup(): Promise<{ number: string; name: string }[]> {
    try {
      const j = JSON.parse(await readFile(join(this.abs(this.cfg().runtimeDir), "lineup.json"), "utf8"));
      return (j.channels ?? []).map((c: any) => ({ number: String(c.number), name: String(c.name) }));
    } catch { return []; }
  }

  private nextBase() {
    const nc = this.cfg();
    const host = !nc.bindAddress || nc.bindAddress === "0.0.0.0" || nc.bindAddress === "::" ? "127.0.0.1" : nc.bindAddress;
    return `http://${host}:${nc.port}`;
  }

  private routes(app: FastifyInstance) {
    // the address Plex used to reach us, so the URLs we hand back work from its side
    const base = (req: FastifyRequest) => `http://${String(req.headers.host ?? `${lanAddress()}:${this.listeningOn}`)}`;
    const discover = (req: FastifyRequest) => {
      const h = this.cfg().hdhr, b = base(req);
      return {
        FriendlyName: h.name || "tv-next-scheduler", Manufacturer: "Silicondust", ModelNumber: "HDTC-2US",
        FirmwareName: "hdhomeruntc_atsc", FirmwareVersion: "20200101", DeviceID: this.deviceId(), DeviceAuth: "tvnext",
        BaseURL: b, LineupURL: `${b}/lineup.json`, TunerCount: h.tuners,
      };
    };
    app.get("/", async (req) => discover(req));
    app.get("/discover.json", async (req) => discover(req));
    app.get("/lineup_status.json", async () => ({ ScanInProgress: 0, ScanPossible: 1, Source: "Cable", SourceList: ["Cable"] }));
    app.get("/lineup.json", async (req) => {
      const b = base(req);
      return (await this.lineup()).map((c) => ({ GuideNumber: c.number, GuideName: c.name, URL: `${b}/auto/v${c.number}` }));
    });
    app.post("/lineup.post", async () => ""); // "scan" button on some clients: nothing to scan
    app.get("/device.xml", async (req, reply) => {
      const d = discover(req), esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      reply.type("application/xml");
      return `<?xml version="1.0" encoding="UTF-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <URLBase>${esc(d.BaseURL)}</URLBase>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>${esc(d.FriendlyName)}</friendlyName>
    <manufacturer>Silicondust</manufacturer>
    <modelName>HDTC-2US</modelName>
    <modelNumber>HDTC-2US</modelNumber>
    <serialNumber></serialNumber>
    <UDN>uuid:${d.DeviceID}</UDN>
  </device>
</root>`;
    });

    // next's guide, on the tuner's address so Plex needs only the one (next
    // already names each channel by number too, which is how Plex matches them)
    app.get("/xmltv.xml", async (_req, reply) => {
      try {
        const r = await fetch(`${this.nextBase()}/xmltv.xml`, { signal: AbortSignal.timeout(20_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        reply.type("application/xml");
        return await r.text();
      } catch (e) { return reply.code(502).send(`ErsatzTV next isn't answering (${(e as Error).message}). Start it on the Streaming page.`); }
    });

    const stream = async (req: FastifyRequest<{ Params: { num: string } }>, reply: FastifyReply) => {
      const num = req.params.num.replace(/\.ts$/, "");
      const ch = (await this.lineup()).find((c) => c.number === num);
      if (!ch) return reply.code(404).send("No such channel");
      if (req.method === "HEAD") return reply.type("video/mp2t").send();
      const h = this.cfg().hdhr;
      if (this.tunes.size >= h.tuners) {
        appLog("hdhr", `tune ${num} refused: all ${h.tuners} tuners busy`);
        return reply.code(503).header("X-HDHomeRun-Error", "805 All Tuners In Use").send("All tuners in use");
      }
      const ffmpeg = this.cfg().ffmpegPath ? this.abs(this.cfg().ffmpegPath) : "ffmpeg";
      const args = [
        "-nostdin", "-threads", "1", "-hide_banner", "-loglevel", "error", "-nostats",
        // a short burst fills the client's buffer straight away, then real time; it
        // must stay below how far next publishes ahead of the clock (about 12 s)
        "-readrate", "1.0", "-readrate_initial_burst", "6",
        "-i", `${this.nextBase()}/channel/${encodeURIComponent(num)}.m3u8`,
        "-map", "0", "-c", "copy",
        "-metadata", `service_provider=${h.name || "tv-next-scheduler"}`, "-metadata", `service_name=${ch.name}`,
        "-f", "mpegts", "pipe:1",
      ];
      const proc = spawn(ffmpeg, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const t: Tune = { id: this.nextId++, channel: num, name: ch.name, client: req.ip, startedMs: Date.now(), bytes: 0, proc };
      this.tunes.set(t.id, t);
      appLog("hdhr", `tune ${num} (${ch.name}) for ${req.ip} — ${this.tunes.size}/${h.tuners} tuners in use`);
      let err = "";
      proc.stderr!.on("data", (d) => { err = (err + d).slice(-2000); });
      proc.stdout!.on("data", (d: Buffer) => { t.bytes += d.length; });
      const end = (why: string) => {
        if (!this.tunes.delete(t.id)) return;
        proc.kill();
        appLog("hdhr", `tune ${num} ended (${why}) after ${Math.round((Date.now() - t.startedMs) / 1000)} s${err.trim() ? `: ${err.trim().split("\n").pop()}` : ""}`);
      };
      proc.on("error", (e) => { err += e.message; end("ffmpeg couldn't start"); });
      proc.on("close", (code) => end(code ? `ffmpeg exited ${code}` : "stream finished"));
      req.raw.on("close", () => end("client disconnected"));
      reply.raw.writeHead(200, { "Content-Type": "video/mp2t", "Cache-Control": "no-store", Connection: "close" });
      proc.stdout!.pipe(reply.raw);
      return reply.hijack();
    };
    for (const p of ["/auto/v:num", "/channel/:num", "/tuner:n/v:num"]) { app.get(p, stream as any); app.head(p, stream as any); }
  }
}

export interface HdhrTest { ok: boolean; firstByteSec: number | null; seconds: number; mb: number; video: string; audio: string; problem: string; advice: string }

/** Tune a channel through the tuner exactly as Plex would, keep ~12 s, and say
 *  how long the first picture took and what codecs Plex will get. */
export async function testTune(store: ConfigStore, root: string, tuner: HdhrTuner, channel: string): Promise<HdhrTest> {
  const st = tuner.status();
  const res: HdhrTest = { ok: false, firstByteSec: null, seconds: 0, mb: 0, video: "", audio: "", problem: "", advice: "" };
  if (!st.listening) { res.problem = st.error || "The tuner is off. Turn it on and save first."; return res; }
  const t0 = Date.now(), chunks: Buffer[] = [];
  const ctl = new AbortController();
  const stopAt = setTimeout(() => ctl.abort(), 60_000);
  try {
    const r = await fetch(`http://127.0.0.1:${st.port}/auto/v${encodeURIComponent(channel)}`, { signal: ctl.signal });
    if (!r.ok) { res.problem = `The tuner answered ${r.status}: ${await r.text()}`; return res; }
    const reader = r.body!.getReader();
    let firstAt = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!firstAt) { firstAt = Date.now(); res.firstByteSec = Math.round((firstAt - t0) / 100) / 10; clearTimeout(stopAt); setTimeout(() => ctl.abort(), 12_000); }
      chunks.push(Buffer.from(value));
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") { res.problem = (e as Error).message; return res; }
  } finally { clearTimeout(stopAt); }
  const buf = Buffer.concat(chunks);
  res.mb = Math.round(buf.length / 1e5) / 10;
  if (!buf.length) {
    res.problem = "Nothing came through in 60 seconds. Is ErsatzTV next running, with this channel built? Check the Logs page for lines starting with “hdhr”.";
    return res;
  }
  // what's in it: ffprobe the captured bytes
  const { writeFile, rm, mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "tvn-hdhr-"));
  const file = join(dir, "tune.ts");
  await writeFile(file, buf);
  const nc = store.getNextConfig();
  const ffprobe = nc.ffprobePath ? (isAbsolute(nc.ffprobePath) || /^[A-Za-z]:/.test(nc.ffprobePath) ? nc.ffprobePath : join(root, nc.ffprobePath)) : "ffprobe";
  const probe = await new Promise<any>((done) => {
    const p = spawn(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", file], { windowsHide: true });
    let out = ""; p.stdout.on("data", (d) => { out += d; });
    p.on("error", () => done(null)); p.on("close", () => { try { done(JSON.parse(out)); } catch { done(null); } });
  });
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  const streams: any[] = probe?.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video"), a = streams.find((s) => s.codec_type === "audio");
  res.video = v ? `${v.codec_name} ${v.width}×${v.height}` : "";
  res.audio = a ? String(a.codec_name) : "";
  res.seconds = Math.round(Number(probe?.format?.duration ?? 0) * 10) / 10;
  res.ok = !!v;
  if (!v) res.problem = "The stream had no video Plex could read.";
  const notes: string[] = [];
  if ((res.firstByteSec ?? 0) > 15) notes.push(`The picture took ${res.firstByteSec} s to start. Plex may give up on a channel that slow to tune; try again now that it's warm, or check the channel's encoding speed.`);
  if (v && !/^(h264|mpeg2video)$/.test(v.codec_name)) notes.push(`This channel's video is ${v.codec_name}. Plex records it, but some Plex apps play it poorly; H.264 is safest (Streaming → Video & audio, or the channel's own Encoding setting).`);
  if (a && !/^(aac|ac3|eac3|mp2)$/.test(a.codec_name)) notes.push(`This channel's audio is ${a.codec_name}; Plex is happiest with AAC or AC3.`);
  res.advice = notes.join(" ");
  return res;
}

export function registerHdhrRoutes(app: FastifyInstance, tuner: HdhrTuner, store: ConfigStore, root: string) {
  app.get("/api/hdhr", async () => tuner.status());
  app.post("/api/hdhr/test", async (req) => testTune(store, root, tuner, String((req.body as any)?.channel ?? "")));
  // Settings are saved with the rest of the streaming settings; follow them.
  app.addHook("onResponse", async (req) => {
    if (req.method === "PUT" && req.url.startsWith("/api/next-config")) await tuner.reconfigure();
  });
}
