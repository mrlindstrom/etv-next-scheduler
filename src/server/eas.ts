// -----------------------------------------------------------------------------
// Emergency alerts (Output → Emergency alerts): polls the National Weather Service
// for active alerts at the chosen location, writes what should be on screen to
// <runtime>/eas/state.json, and keeps the alert stream process (eas-stream.ts)
// running. Alert-enabled channels carry a graphics layer that reads that stream,
// so an alert appears over whatever is playing without rebuilding anything.
// -----------------------------------------------------------------------------
import type { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigStore } from "./config.js";
import type { GraphicsLayer } from "../model.js";
import { localParts } from "../time.js";
import { formatClock } from "../upnext-ass.js";
import { rasterize, loadRasterizer } from "../overlays.js";
import { appLog } from "./app-log.js";
import {
  EAS_DEFAULTS, SEVERITIES, severityRank, passesSeverity, alertCardSvg, bannerHeight, cycleOn, streamVersion, testCard,
  type AlertCard, type EasConfig, type EasState,
} from "./eas-alerts.js";

const NWS = "https://api.weather.gov";
const STREAM_JS = fileURLToPath(new URL("./eas-stream.js", import.meta.url));
const AHEAD_SEC = 30;

export interface EasStatus {
  poll: { at: number | null; ok: boolean; error: string | null; found: number; shown: number };
  stream: { running: boolean; port: number; version: string | null; current: boolean; clients: number; error: string | null; log: string[] };
  alerts: AlertCard[];
  testUntil: number | null;
}

/** NWS alert properties (the parts used). */
interface NwsAlert {
  id: string; areaDesc?: string; status?: string; messageType?: string; severity?: string; event?: string;
  headline?: string; description?: string; instruction?: string; sent?: string; expires?: string; ends?: string | null;
  parameters?: { NWSheadline?: string[] };
}

export class EasService {
  private alerts: AlertCard[] = [];
  private testUntil: number | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private superviseTimer: NodeJS.Timeout | null = null;
  private lastSpawn = 0;
  private lastStateJson = "";
  /** when the newest alert came in: the on/off cycle counts from here */
  private cycleStart = 0;
  status: EasStatus;

  constructor(private store: ConfigStore, private root: string, private serverPort: number) {
    this.status = {
      poll: { at: null, ok: true, error: null, found: 0, shown: 0 },
      stream: { running: false, port: this.streamPort(), version: null, current: false, clients: 0, error: null, log: [] },
      alerts: [], testUntil: null,
    };
    // carry on from before a restart: the same alerts stay up, in the same cycle
    try {
      const prev = JSON.parse(readFileSync(this.stateFile(), "utf8")) as EasState;
      if (this.config().enabled) this.alerts = (prev.alerts ?? []).filter((a) => !a.test);
      this.cycleStart = Number(prev.cycleStart) || 0;
    } catch { /* first run */ }
  }

  config(): EasConfig { return { ...EAS_DEFAULTS, ...this.store.getEasConfig() }; }
  streamPort(): number { return this.config().streamPort || this.serverPort + 5; }
  private dir(): string {
    const rt = this.store.getNextConfig().runtimeDir || "runtime";
    return join(isAbsolute(rt) || /^[A-Za-z]:/.test(rt) ? rt : join(this.root, rt), "eas");
  }
  private stateFile = () => join(this.dir(), "state.json");
  private logFile = () => join(this.dir(), "stream.log");

  /** Save settings: checks them, then polls and (re)starts the stream as needed. */
  save(patch: Partial<EasConfig>): EasConfig {
    const cur = this.config();
    const next: EasConfig = { ...cur, ...patch };
    const num = (v: unknown) => (v === null || v === "" || v === undefined ? null : Number(v));
    next.lat = num(next.lat); next.lon = num(next.lon);
    if (next.lat !== null && (!Number.isFinite(next.lat) || Math.abs(next.lat) > 90)) throw new Error("Latitude must be a number between -90 and 90.");
    if (next.lon !== null && (!Number.isFinite(next.lon) || Math.abs(next.lon) > 180)) throw new Error("Longitude must be a number between -180 and 180.");
    if (next.enabled && (next.lat === null || next.lon === null)) throw new Error("Set the location first: alerts are looked up for a point (latitude and longitude).");
    if (!SEVERITIES.includes(next.minSeverity)) next.minSeverity = "Severe";
    next.pollSec = Math.min(600, Math.max(30, Number(next.pollSec) || 60));
    next.rotateSec = Math.min(60, Math.max(5, Number(next.rotateSec) || 12));
    next.showSec = Math.min(600, Math.max(10, Number(next.showSec) || 60));
    next.hideSec = Math.min(3600, Math.max(0, Number.isFinite(Number(next.hideSec)) ? Number(next.hideSec) : 300));
    next.position = next.position === "top" ? "top" : "bottom";
    next.streamPort = Math.max(0, Math.min(65535, Number(next.streamPort) || 0));
    next.contact = String(next.contact ?? "").trim().slice(0, 200);
    // once alerts are on, built playouts point at the stream: it keeps running until it's stopped on purpose
    if (next.enabled) next.keepStream = true;
    const portChanged = this.streamPort() !== (next.streamPort || this.serverPort + 5);
    if (portChanged && this.status.stream.running) void this.quitStream();
    this.store.setEasConfig(next);
    this.status.stream.port = this.streamPort();
    this.schedulePoll(next.pollSec * 1000); // (the route checks right away)
    return next;
  }

  start(): void {
    this.writeState(); // so a stream started before the first poll has something to read
    this.schedulePoll(0);
    const loop = async () => { await this.supervise().catch(() => {}); this.superviseTimer = setTimeout(loop, 15_000); };
    void loop();
  }
  dispose(): void { if (this.pollTimer) clearTimeout(this.pollTimer); if (this.superviseTimer) clearTimeout(this.superviseTimer); }

  // ---- National Weather Service
  private schedulePoll(delayMs: number): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      await this.poll().catch(() => {});
      this.schedulePoll(this.config().pollSec * 1000);
    }, delayMs);
  }

  private userAgent(): string {
    const c = this.config().contact;
    return `tv-next-scheduler emergency alert overlay${c ? ` (${c})` : ""}`;
  }

  private async nws(path: string): Promise<any> {
    const r = await fetch(`${NWS}${path}`, { headers: { "User-Agent": this.userAgent(), Accept: "application/geo+json" }, signal: AbortSignal.timeout(15_000) });
    const body = await r.json().catch(() => null);
    // 5xx/429 come from their CDN as HTML (an outage on their side), not from the API
    if (r.status >= 500 || r.status === 429) throw new Error(`The National Weather Service isn't answering right now (error ${r.status}). That's on their side; ${path.startsWith("/alerts") ? "the scheduler keeps checking, and any alert already on screen stays up" : "try again in a few minutes"}.`);
    if (!r.ok) throw new Error(body?.detail || body?.title || `The National Weather Service answered ${r.status}.`);
    return body;
  }

  async poll(): Promise<void> {
    const cfg = this.config();
    if (!cfg.enabled || cfg.lat === null || cfg.lon === null) { this.alerts = []; this.writeState(); return; }
    try {
      const body = await this.nws(`/alerts/active?point=${cfg.lat.toFixed(4)},${cfg.lon.toFixed(4)}`);
      const all: NwsAlert[] = (body?.features ?? []).map((f: any) => f?.properties).filter(Boolean);
      const now = Date.now();
      const tz = this.store.get().tz;
      const shown = all
        .filter((a) => a.status === "Actual" && a.messageType !== "Cancel")
        .filter((a) => passesSeverity(a.event ?? "", a.severity ?? "", cfg.minSeverity))
        .filter((a) => { const end = Date.parse(a.ends ?? a.expires ?? ""); return !Number.isFinite(end) || end > now; })
        .sort((a, b) => severityRank(a.severity ?? "") - severityRank(b.severity ?? "") || Date.parse(b.sent ?? "") - Date.parse(a.sent ?? ""));
      const before = new Set(this.alerts.map((a) => a.id));
      this.alerts = shown.map((a) => toCard(a, tz));
      // a new alert goes on screen straight away: the on/off cycle starts again
      if (this.alerts.some((a) => !before.has(a.id))) this.cycleStart = now;
      for (const a of this.alerts) if (!before.has(a.id)) appLog("alerts", `on screen: ${a.event} (${a.severity}) for ${a.area} ${a.until}`.trim());
      for (const id of before) if (!this.alerts.some((a) => a.id === id) && id !== "test") appLog("alerts", "an alert ended or was cancelled; taken off screen");
      this.status.poll = { at: now, ok: true, error: null, found: all.length, shown: this.alerts.length };
    } catch (e) {
      // keep showing what was there: an alert shouldn't vanish because one check failed
      this.status.poll = { ...this.status.poll, at: Date.now(), ok: false, error: (e as Error).message };
    }
    this.writeState();
  }

  /** The place NWS knows a point as ("near Denton, TX"), to confirm the location. */
  async lookupPlace(lat: number, lon: number): Promise<string> {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Enter a latitude and longitude.");
    try {
      const p = await this.nws(`/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
      const rel = p?.properties?.relativeLocation?.properties;
      const county = await this.nws(new URL(p?.properties?.county).pathname).then((c) => c?.properties?.name as string).catch(() => "");
      return [rel ? `near ${rel.city}, ${rel.state}` : "", county ? `${county} County` : ""].filter(Boolean).join(" · ") || "found";
    } catch (e) {
      const m = (e as Error).message;
      if (/unavailable|unable to provide|not found|404/i.test(m)) throw new Error("The National Weather Service has no data for that point. It covers the United States and its territories.");
      throw e;
    }
  }

  // ---- the test alert
  test(minutes: number): void {
    this.testUntil = Date.now() + Math.min(30, Math.max(1, minutes)) * 60_000;
    this.cycleStart = Date.now(); // on straight away, then the on/off cycle, like a real alert
    appLog("alerts", `test alert shown for ${minutes} minute(s)`);
    this.writeState();
    setTimeout(() => { if (this.testUntil && Date.now() >= this.testUntil) { this.testUntil = null; this.writeState(); } }, this.testUntil - Date.now() + 500);
  }
  clearTest(): void { this.testUntil = null; this.writeState(); }

  /** Where real alerts are in their on/off cycle: on now or not, and when that changes
   *  (null: no alerts, or on the whole time). TVs follow about half a minute later. */
  cycle(): { on: boolean; changesAt: number | null } {
    const cfg = this.config(), now = Date.now(), n = this.shown().length;
    if (!n || cfg.hideSec <= 0) return { on: n > 0, changesAt: null };
    const s = { showSec: cfg.showSec, hideSec: cfg.hideSec, cycleStart: this.cycleStart };
    const period = (cfg.showSec + cfg.hideSec) * 1000, into = (now - this.cycleStart) % period;
    const on = cycleOn(s, now);
    return { on, changesAt: now - into + (on ? cfg.showSec * 1000 : period) };
  }

  /** What's on screen right now (alerts, plus the test while it runs). */
  shown(): AlertCard[] {
    if (this.testUntil && Date.now() >= this.testUntil) this.testUntil = null;
    const tz = this.store.get().tz;
    return [...(this.testUntil ? [testCard(`until ${formatClock(this.testUntil, tz)}`)] : []), ...this.alerts];
  }

  private writeState(): void {
    const cfg = this.config();
    const state: EasState = { alerts: this.shown(), position: cfg.position, rotateSec: cfg.rotateSec,
      showSec: cfg.showSec, hideSec: cfg.hideSec, cycleStart: this.cycleStart, updatedAt: 0 };
    const json = JSON.stringify(state);
    this.status.alerts = state.alerts;
    this.status.testUntil = this.testUntil;
    if (json === this.lastStateJson && existsSync(this.stateFile())) return;
    this.lastStateJson = json;
    try {
      mkdirSync(this.dir(), { recursive: true });
      const tmp = `${this.stateFile()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2), "utf8");
      renameSync(tmp, this.stateFile());
    } catch (e) { appLog("alerts", `couldn't write the alert state: ${(e as Error).message}`); }
  }

  // ---- the alert stream process
  private async health(): Promise<{ version: string; clients: number } | null> {
    try {
      const r = await fetch(`http://127.0.0.1:${this.streamPort()}/health`, { signal: AbortSignal.timeout(1500) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }
  private async quitStream(): Promise<void> {
    await fetch(`http://127.0.0.1:${this.streamPort()}/quit`, { method: "POST", signal: AbortSignal.timeout(1500) }).catch(() => {});
  }

  /** Keep the stream running (and current) while alerts are on, or built channels still use it. */
  async supervise(): Promise<void> {
    const cfg = this.config();
    const want = cfg.enabled || cfg.keepStream;
    let h = await this.health();
    const version = streamVersion();
    if (h && !want) { await this.quitStream(); appLog("alerts", "alert stream stopped"); h = null; }
    else if (h && h.version !== version) {
      appLog("alerts", `alert stream is from older code (${h.version}); replacing it with ${version}`);
      await this.quitStream();
      await new Promise((r) => setTimeout(r, 700));
      h = null;
    }
    if (!h && want && Date.now() - this.lastSpawn > 10_000) {
      this.spawnStream();
      for (let i = 0; i < 10 && !h; i++) { await new Promise((r) => setTimeout(r, 500)); h = await this.health(); }
    }
    const log = this.logTail();
    this.status.stream = {
      running: !!h, port: this.streamPort(), version: h?.version ?? null, current: h?.version === version, clients: h?.clients ?? 0,
      error: want && !h ? (log.filter((l) => /can't|error|failed/i.test(l)).pop() ?? "The alert stream isn't answering.") : null,
      log,
    };
  }

  private spawnStream(): void {
    this.lastSpawn = Date.now();
    try {
      mkdirSync(this.dir(), { recursive: true });
      const logPath = this.logFile();
      if (existsSync(logPath) && statSync(logPath).size > 512 * 1024) truncateSync(logPath, 0);
      const fd = openSync(logPath, "a");
      // detached: it must outlive scheduler restarts (channels stall while it's gone)
      const child = spawn(process.execPath, [STREAM_JS, "--port", String(this.streamPort()), "--state", this.stateFile(), "--ahead", String(AHEAD_SEC)], {
        cwd: this.root, detached: true, stdio: ["ignore", fd, fd], windowsHide: true,
      });
      child.unref();
      closeSync(fd);
      appLog("alerts", `started the alert stream on port ${this.streamPort()} (pid ${child.pid})`);
    } catch (e) { appLog("alerts", `couldn't start the alert stream: ${(e as Error).message}`); }
  }
  private logTail(): string[] {
    try { return readFileSync(this.logFile(), "utf8").trim().split(/\r?\n/).slice(-12); } catch { return []; }
  }

  async stopStream(): Promise<void> {
    this.store.setEasConfig({ ...this.config(), keepStream: false });
    await this.supervise();
  }

  /** The graphics layer an alert-enabled channel's items carry (undefined: none). */
  layerFor(channelName: string, w: number, h: number): GraphicsLayer | undefined {
    const cfg = this.config();
    if (!cfg.enabled || this.store.channelMeta(channelName)?.eas === false) return undefined;
    const bh = bannerHeight(h);
    const top = cfg.position === "top";
    return {
      kind: "media", location: "top_left",
      horizontal_margin_percent: 0, width_percent: 100,
      vertical_margin_percent: top ? 0 : Math.round(((h - bh) / h) * 10000) / 100,
      source: {
        source_type: "http", uri: `http://127.0.0.1:${this.streamPort()}/eas.stream?w=${w}&h=${h}`, reconnect: true, is_live: true,
        probe_hint: { format_name: "png_pipe", video: [{ stream_index: 0, codec: "png", width: w, height: bh, pix_fmt: "rgba" }] },
      },
    } as GraphicsLayer;
  }

  /** A card as a PNG (the page's preview). */
  async preview(which: "test" | "current", w: number, h: number): Promise<Buffer | null> {
    await loadRasterizer();
    const cards = which === "current" ? this.shown() : [];
    const card = cards[0] ?? testCard(`until ${formatClock(Date.now() + 5 * 60_000, this.store.get().tz)}`);
    return rasterize(alertCardSvg(card, w, h, 0, Math.max(1, cards.length)));
  }
}

/** An NWS alert as the card shows it. */
function toCard(a: NwsAlert, tz: import("../time.js").Tz): AlertCard {
  const end = Date.parse(a.ends ?? a.expires ?? "");
  let until = "";
  if (Number.isFinite(end)) {
    const same = localParts(end, tz).da === localParts(Date.now(), tz).da;
    const day = same ? "" : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dayOfWeek(end, tz)]} `;
    until = `until ${day}${formatClock(end, tz)}`;
  }
  const nwsHeadline = a.parameters?.NWSheadline?.[0];
  const text = (nwsHeadline ? sentenceCase(nwsHeadline) : cleanDescription(a.description ?? "")) || a.headline || "";
  // what to do, briefly: the instruction's first two sentences (the rest is usually boilerplate)
  const todo = (cleanDescription(a.instruction ?? "").match(/[^.!?]+[.!?]+/g) ?? []).slice(0, 2).map((s) => s.trim()).join(" ");
  const area = (a.areaDesc ?? "").split(/;\s*/).filter(Boolean);
  return {
    id: a.id, event: a.event ?? "Alert", severity: a.severity ?? "Unknown",
    area: area.length > 4 ? `${area.slice(0, 4).join("; ")} and ${area.length - 4} more` : area.join("; "),
    until, headline: [sentence(text), todo].filter(Boolean).join(" "),
  };
}
/** End with a full stop (headlines often have none). */
const sentence = (s: string) => (s && !/[.!?]$/.test(s.trim()) ? `${s.trim()}.` : s.trim());
const PROPER = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|national weather service)\b/g;
const dayOfWeek = (ms: number, tz: import("../time.js").Tz) => { const p = localParts(ms, tz); return new Date(Date.UTC(p.y, p.mo, p.da)).getUTCDay(); };
/** NWS headlines are often in capitals. */
const sentenceCase = (s: string) => (s === s.toUpperCase()
  ? s.toLowerCase().replace(PROPER, (w) => w.replace(/\b[a-z]/g, (c) => c.toUpperCase())).replace(/(^|[.!?]\s+)([a-z])/g, (_m, p, c) => p + c.toUpperCase())
  : s);
/** Descriptions come with "..." markers, "* " bullets and hard line breaks. */
const cleanDescription = (s: string) => s.replace(/\.\.\./g, " ").replace(/^\s*\*\s*/gm, "").replace(/\s+/g, " ").trim();

export function registerEasRoutes(app: FastifyInstance, eas: EasService): void {
  app.get("/api/eas", async () => ({ config: eas.config(), status: { ...eas.status, cycle: eas.cycle() }, severities: SEVERITIES }));
  app.put("/api/eas", async (req, reply) => {
    try { const config = eas.save((req.body ?? {}) as Partial<EasConfig>); await eas.poll(); await eas.supervise(); return { config, status: eas.status }; }
    catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });
  app.post("/api/eas/check", async () => { await eas.poll(); await eas.supervise(); return { status: eas.status }; });
  app.post("/api/eas/place", async (req, reply) => {
    const b = (req.body ?? {}) as { lat?: number; lon?: number };
    try { return { place: await eas.lookupPlace(Number(b.lat), Number(b.lon)) }; }
    catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });
  app.post("/api/eas/test", async (req) => { eas.test(Number((req.body as any)?.minutes) || 2); return { status: eas.status }; });
  app.delete("/api/eas/test", async () => { eas.clearTest(); return { status: eas.status }; });
  app.post("/api/eas/stop-stream", async () => { await eas.stopStream(); return { config: eas.config(), status: eas.status }; });
  app.get("/api/eas/preview.png", async (req, reply) => {
    const q = req.query as { which?: string; w?: string; h?: string };
    const png = await eas.preview(q.which === "current" ? "current" : "test", Math.min(3840, Number(q.w) || 1920), Math.min(2160, Number(q.h) || 1080));
    if (!png) { reply.code(500); return { error: "The image renderer isn't available." }; }
    reply.header("Cache-Control", "no-store").type("image/png");
    return png;
  });
}

/** The one service, for builds (overlay-library.ts) and the routes. */
let instance: EasService | null = null;
export const easService = () => instance;
export function initEas(store: ConfigStore, root: string, serverPort: number): EasService {
  instance = new EasService(store, root, serverPort);
  return instance;
}
