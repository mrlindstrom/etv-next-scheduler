// Troubleshooting → Watch live: plays a channel from the running ErsatzTV next,
// exactly what TV apps get, through this server's /channel + /session proxy.
import { useEffect, useRef, useState } from "react";
import type HlsType from "hls.js";
import { api, logoSrc, type ChannelSummary, type NextRunnerStatus } from "../api.js";
import { navigate } from "../nav.js";

interface Stats { res: string; kbps: number; buffer: number; latency: number | null; dropped: number; frames: number }
const now = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

export function LiveViewer({ channels }: { channels: ChannelSummary[] }) {
  const lineup = channels.filter((c) => c.meta?.enabled);
  const [num, setNum] = useState(() => new URLSearchParams(window.location.search).get("channel") ?? "");
  const [playing, setPlaying] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [runner, setRunner] = useState<NextRunnerStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const hls = useRef<HlsType | null>(null);

  useEffect(() => {
    const load = () => api.nextRunner().then(setRunner).catch(() => {});
    load(); const t = window.setInterval(load, 5000); return () => clearInterval(t);
  }, []);
  useEffect(() => { if (!num && lineup.length) setNum(lineup[0].meta!.number); }, [lineup.length]);
  useEffect(() => () => stop(), []);

  const note = (s: string) => setLog((l) => [...l.slice(-40), `${now()} ${s}`]);
  const url = (n: string) => `/channel/${encodeURIComponent(n)}.m3u8`;

  function stop() {
    hls.current?.destroy(); hls.current = null;
    const v = video.current;
    if (v) { v.pause(); v.removeAttribute("src"); v.load(); }
    setPlaying(null); setStats(null); setStatus("");
  }

  async function play(n: string) {
    stop();
    const v = video.current;
    if (!v || !n) return;
    const ch = lineup.find((c) => c.meta?.number === n);
    setPlaying(n); setNum(n); setLog([]);
    window.history.replaceState({}, "", `/troubleshoot?tab=live&channel=${encodeURIComponent(n)}`);
    setStatus("Tuning… a channel nobody is watching takes a few seconds (up to 30) to start.");
    note(`tuning ${n}${ch ? ` (${ch.name})` : ""}`);
    // hls.js is big, so it's loaded the first time something plays
    const Hls = (await import("hls.js")).default;
    if (hls.current || video.current !== v) return; // stopped or switched while loading
    if (Hls.isSupported()) {
      const h = new Hls({ liveSyncDurationCount: 3, manifestLoadingTimeOut: 45_000, manifestLoadingMaxRetry: 2 });
      hls.current = h;
      h.on(Hls.Events.MANIFEST_PARSED, () => { note("playlist loaded"); v.play().catch(() => setStatus("Press play on the video to start (the browser blocked autoplay).")); });
      h.on(Hls.Events.LEVEL_LOADED, (_e, d) => { if (d.details.live === false) note("note: the playlist isn't marked live"); });
      h.on(Hls.Events.ERROR, (_e, d) => {
        note(`${d.fatal ? "FATAL " : ""}${d.type}: ${d.details}${d.response?.code ? ` (HTTP ${d.response.code})` : ""}`);
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR) { note("recovering from a media error…"); h.recoverMediaError(); }
        else if (d.type === Hls.ErrorTypes.NETWORK_ERROR && d.details !== Hls.ErrorDetails.MANIFEST_LOAD_ERROR) { note("retrying…"); h.startLoad(); }
        else setStatus(d.response?.code === 502 ? "ErsatzTV next isn't running. Start it on the Streaming page." : d.response?.code === 404 ? `ErsatzTV next doesn't have channel ${n}. Apply the lineup and restart it on the Streaming page.` : `Couldn't play: ${d.details}. See the log below.`);
      });
      h.loadSource(url(n));
      h.attachMedia(v);
    } else if (v.canPlayType("application/vnd.apple.mpegurl")) { // Safari plays HLS natively
      v.src = url(n); v.play().catch(() => {});
    } else setStatus("This browser can't play HLS.");
  }

  // live stats while playing
  useEffect(() => {
    if (!playing) return;
    const v = video.current!;
    const onPlaying = () => { setStatus(""); note("playing"); };
    const onWaiting = () => note("buffering…");
    v.addEventListener("playing", onPlaying); v.addEventListener("waiting", onWaiting);
    const t = window.setInterval(() => {
      const h = hls.current;
      const end = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : v.currentTime;
      const q = v.getVideoPlaybackQuality?.();
      const lvl = h && h.currentLevel >= 0 ? h.levels[h.currentLevel] : h?.levels[0];
      setStats({
        res: v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : "—",
        kbps: Math.round((lvl?.bitrate ?? 0) / 1000), buffer: Math.max(0, end - v.currentTime),
        latency: h?.latency ?? null, dropped: q?.droppedVideoFrames ?? 0, frames: q?.totalVideoFrames ?? 0,
      });
    }, 1000);
    return () => { clearInterval(t); v.removeEventListener("playing", onPlaying); v.removeEventListener("waiting", onWaiting); };
  }, [playing]);

  const idx = lineup.findIndex((c) => c.meta?.number === (playing ?? num));
  const surf = (d: number) => { if (!lineup.length) return; const c = lineup[(idx + d + lineup.length) % lineup.length]; play(c.meta!.number); };
  const cur = lineup[idx];
  const streamUrl = `${window.location.origin}${url(playing ?? num)}`;
  const nextDown = runner && runner.phase !== "running";

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <p className="muted" style={{ marginTop: 0 }}>
        Watch a channel live from the running ErsatzTV next, exactly as TV apps get it. Starting a channel nobody is watching starts its
        transcode, just like a viewer tuning in; it stops a little while after you stop watching.
      </p>
      {nextDown && (
        <div className="verify bad" style={{ margin: "6px 0 12px" }}>
          <div className="status">ErsatzTV next isn't running ({runner!.phase})</div>
          <div className="muted" style={{ marginBottom: 8 }}>Start it (or turn on “Keep ErsatzTV next running”) on the Streaming page, then come back.</div>
          <button onClick={() => navigate("streaming")}>Open Streaming</button>
        </div>
      )}
      <div className="actions" style={{ marginTop: 0, flexWrap: "wrap" }}>
        <select value={num} onChange={(e) => { setNum(e.target.value); if (playing) play(e.target.value); }} style={{ minWidth: 260 }}>
          {lineup.map((c) => <option key={c.name} value={c.meta!.number}>{c.meta!.number} · {c.name}</option>)}
        </select>
        <button onClick={() => surf(-1)} title="Previous channel" disabled={!lineup.length}>◀ Ch −</button>
        <button onClick={() => surf(1)} title="Next channel" disabled={!lineup.length}>Ch + ▶</button>
        {playing ? <button onClick={stop}>Stop</button> : <button className="primary" onClick={() => play(num)} disabled={!num}>Watch</button>}
        {cur && <button onClick={() => navigate("preview", { channel: cur.name })} title="See what's scheduled on this channel">Schedule</button>}
      </div>

      <div style={{ position: "relative", background: "#000", borderRadius: 8, overflow: "hidden", aspectRatio: "16 / 9", maxWidth: 960, marginTop: 10 }}>
        <video ref={video} controls playsInline style={{ width: "100%", height: "100%", display: "block", background: "#000" }} />
        {playing && cur && (
          <div style={{ position: "absolute", top: 10, left: 12, display: "flex", alignItems: "center", gap: 8, background: "#0009", padding: "4px 10px", borderRadius: 6, pointerEvents: "none" }}>
            {logoSrc(cur.meta?.logo) && <img src={logoSrc(cur.meta?.logo)} alt="" style={{ height: 22 }} />}
            <span style={{ fontWeight: 600 }}>{cur.meta?.number} · {cur.name}</span>
          </div>
        )}
        {status && <div style={{ position: "absolute", inset: "auto 0 48px 0", textAlign: "center", padding: "0 16px" }}><span style={{ background: "#000b", padding: "6px 12px", borderRadius: 6 }}>{status}</span></div>}
      </div>

      {stats && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8, display: "flex", gap: 16, flexWrap: "wrap" }}>
          <span>picture {stats.res}</span>
          {stats.kbps > 0 && <span>stream {stats.kbps.toLocaleString()} kbps</span>}
          <span>buffer {stats.buffer.toFixed(1)} s</span>
          {stats.latency != null && <span>behind live {stats.latency.toFixed(1)} s</span>}
          <span>dropped frames {stats.dropped}{stats.frames ? ` of ${stats.frames.toLocaleString()}` : ""}</span>
        </div>
      )}
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Stream URL for VLC or other players: <code>{streamUrl}</code>{" "}
        <button className="link" style={{ fontSize: 12, padding: "0 4px" }} onClick={() => { navigator.clipboard?.writeText(streamUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? "copied ✓" : "copy"}</button>
      </div>
      {log.length > 0 && <pre className="log" style={{ maxHeight: 140, marginTop: 8 }}>{log.join("\n")}</pre>}
    </div>
  );
}
