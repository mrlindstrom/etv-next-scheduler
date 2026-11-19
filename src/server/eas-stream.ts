// -----------------------------------------------------------------------------
// The alert stream: a small process of its own that every alert-enabled channel's
// playout points a graphics layer at. It sends an endless run of PNG frames
// (png_pipe) at the channel's frame rate: a transparent banner almost always, the
// alert card while an alert is active (several rotate).
//
// Why a process of its own: next's ffmpeg reads this layer for the whole item and
// stalls the channel while it can't, so it mustn't stop when the scheduler restarts
// or updates. The scheduler starts it detached and replaces it when its code changes
// (eas.ts). It only reads the state file the scheduler writes.
//
// Frames are sent up to AHEAD seconds before they're shown, so next can render
// ahead of its viewers as usual; an alert reaches the screen that much later
// (measured: ~18 s with 30 s ahead, plus next's own buffer).
//
//   node dist/server/eas-stream.js --port 8735 --state runtime/eas/state.json
// -----------------------------------------------------------------------------
import http from "node:http";
import { readFileSync, watchFile } from "node:fs";
import { rasterize, loadRasterizer } from "../overlays.js";
import { alertCardSvg, bannerHeight, cycleOn, streamVersion, type EasState } from "./eas-alerts.js";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg("port", "8735"));
const STATE = arg("state", "runtime/eas/state.json");
const AHEAD_SEC = Number(arg("ahead", "30"));
const VERSION = streamVersion();
const started = Date.now();
const log = (m: string) => console.log(`${new Date().toISOString()} [eas-stream] ${m}`);

// ---- state: re-read when the file changes (polled; fs.watch misses renames on some systems)
let state: EasState = { alerts: [], position: "bottom", rotateSec: 12, updatedAt: 0 };
let stateKey = "";
const readState = () => {
  try {
    const s = JSON.parse(readFileSync(STATE, "utf8")) as EasState;
    const key = JSON.stringify(s.alerts);
    state = { ...state, ...s, alerts: Array.isArray(s.alerts) ? s.alerts : [] };
    if (key !== stateKey) { stateKey = key; frames.clear(); log(`${state.alerts.length} alert(s) active${state.alerts.length ? `: ${state.alerts.map((a) => a.event).join(", ")}` : ""}`); }
  } catch { /* not written yet, or mid-write: keep what we have */ }
};

// ---- frames per size: the transparent one, and one per active alert
interface Frames { clear: Buffer; cards: (Buffer | null)[]; }
const frames = new Map<string, Promise<Frames>>();
const clearPng = (w: number, h: number) => rasterize(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"></svg>`);
function framesFor(w: number, h: number): Promise<Frames> {
  const key = `${w}x${h}`;
  let f = frames.get(key);
  if (!f) {
    const alerts = state.alerts;
    f = (async () => ({
      clear: (await clearPng(w, bannerHeight(h)))!,
      cards: await Promise.all(alerts.map((a, i) => rasterize(alertCardSvg(a, w, h, i, alerts.length)).catch(() => null))),
    }))();
    frames.set(key, f);
  }
  return f;
}
/** The frame for time `at`: alerts in the "on" part of their cycle (like a weather
 *  crawl; the test alert too, so the cycle can be tried), rotating when there are several. */
async function frameAt(w: number, h: number, at: number): Promise<Buffer> {
  const f = await framesFor(w, h);
  const cards = cycleOn(state, at) ? f.cards.filter((c): c is Buffer => !!c) : [];
  if (!cards.length) return f.clear;
  const i = Math.floor(at / 1000 / Math.max(3, state.rotateSec || 12)) % cards.length;
  return cards[i];
}

let clients = 0;
const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  if (u.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: VERSION, pid: process.pid, clients, alerts: state.alerts.length, startedAt: started, aheadSec: AHEAD_SEC }));
    return;
  }
  if (u.pathname === "/quit" && req.method === "POST") { res.end("bye"); log("asked to quit (replaced by a newer version)"); setTimeout(() => process.exit(0), 100); return; }
  if (u.pathname === "/frame.png") { // one frame, for checking by eye
    const w = Number(u.searchParams.get("w")) || 1920, h = Number(u.searchParams.get("h")) || 1080;
    void frameAt(w, h, Date.now()).then((b) => { res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" }); res.end(b); });
    return;
  }
  if (u.pathname !== "/eas.stream") { res.writeHead(404); res.end(); return; }
  // only ffmpeg ("Lavf/…") reads the stream. next 0.2.6+ first downloads a PNG layer
  // to pre-scale it as a still; this stream never ends, so that waited out next's 30 s
  // timeout before every segment. Turned away, next plays the live stream straight off.
  if (!/^Lavf\//i.test(String(req.headers["user-agent"] ?? ""))) { res.writeHead(415, { "Content-Type": "text/plain" }); res.end("a live stream: read it with ffmpeg"); return; }

  const w = Math.min(7680, Number(u.searchParams.get("w")) || 1920), h = Math.min(4320, Number(u.searchParams.get("h")) || 1080);
  const fps = Math.min(60, Math.max(1, Number(u.searchParams.get("fps")) || 30));
  res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
  clients++;
  const t0 = Date.now();
  let sent = 0, busy = false;
  // keep AHEAD_SEC of frames in front of the reader, never more (that would only add delay).
  // Each frame is timed as if sent AHEAD_SEC before it airs, like the steady stream of every
  // other channel, so all channels turn the banner on and off together (and a channel's
  // first burst doesn't show 30 s of one moment).
  const tick = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const due = Math.floor(((Date.now() - t0) / 1000 + AHEAD_SEC) * fps);
      while (sent < due && res.writableLength < 256 * 1024 && !res.destroyed) {
        res.write(await frameAt(w, h, t0 + (sent / fps - AHEAD_SEC) * 1000)); sent++;
      }
    } catch (e) { log(`frame failed: ${(e as Error).message}`); }
    busy = false;
  }, 20);
  res.on("close", () => { clearInterval(tick); clients--; });
});

await loadRasterizer();
readState();
watchFile(STATE, { interval: 1000 }, readState);
server.on("error", (e) => { log(`can't listen on port ${PORT}: ${(e as Error).message}`); process.exit(1); });
server.listen(PORT, "127.0.0.1", () => log(`listening on 127.0.0.1:${PORT} (version ${VERSION}, ${AHEAD_SEC}s ahead)`));
