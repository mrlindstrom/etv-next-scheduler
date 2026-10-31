// Troubleshooting: test-play anything through ErsatzTV next (exactly what viewers
// get), preview up-next cards for any channel and time, and check the system
// (versions, settings, which hardware encoders work).
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type CardPreview, type CardSlot, type ChannelSummary, type HwTestResult, type ProbeSummary, type SearchItem, type TestRequest, type TestRun, type TroubleSystem } from "../api.js";
import { navigate } from "../nav.js";
import { LiveViewer } from "./LiveViewer.js";

type Tab = "live" | "play" | "cards" | "system";
const TABS: [Tab, string][] = [["live", "Watch live"], ["play", "Playback test"], ["cards", "Up-next cards"], ["system", "System"]];
const ACCELS: [string, string][] = [["default", "Streaming setting"], ["none", "Software (none)"], ["qsv", "Intel Quick Sync"], ["cuda", "NVIDIA (NVENC)"], ["amf", "AMD (AMF)"], ["vaapi", "VAAPI (Linux)"], ["videotoolbox", "VideoToolbox (macOS)"], ["vulkan", "Vulkan"]];
const param = (k: string) => new URLSearchParams(window.location.search).get(k) ?? "";
const fmtDur = (ms: number) => { const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`; };
const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
/** "1:30", "90" or "1:02:03" -> seconds */
const parseTime = (s: string) => s.trim().split(":").reduce((a, p) => a * 60 + (Number(p) || 0), 0);

export function Troubleshoot() {
  const [tab, setTab] = useState<Tab>(() => (TABS.some(([t]) => t === param("tab")) ? param("tab") as Tab : "live"));
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  useEffect(() => { api.channels().then((c) => setChannels(c.filter((x) => x.meta?.number).sort((a, b) => Number(a.meta!.number) - Number(b.meta!.number)))).catch(() => {}); }, []);
  const pick = (t: Tab) => { setTab(t); window.history.replaceState({}, "", `/troubleshoot?tab=${t}`); };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Troubleshooting</h1>
          <p className="muted" style={{ marginTop: 0 }}>Test-play files and up-next cards through ErsatzTV next, and check what this machine can do.</p>
        </div>
      </div>
      <div className="subtabs">
        {TABS.map(([id, label]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => pick(id)}>{label}</button>)}
      </div>
      {tab === "live" && <LiveViewer channels={channels} />}
      {tab === "play" && <PlaybackTest channels={channels} />}
      {tab === "cards" && <CardTester channels={channels} />}
      {tab === "system" && <SystemInfo />}
    </div>
  );
}

// ---- running a test (shared by playback + cards) ----------------------------
function useTestRun() {
  const [run, setRun] = useState<TestRun | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { api.currentTest().then((r) => { if (r && ["starting", "running", "finishing"].includes(r.status)) setRun(r); }).catch(() => {}); }, []);
  useEffect(() => {
    if (!run || !["starting", "running", "finishing"].includes(run.status)) return;
    const t = setTimeout(() => api.testRun(run.id).then(setRun).catch((e) => setErr((e as Error).message)), 1000);
    return () => clearTimeout(t);
  }, [run]);
  const start = async (r: TestRequest) => { setErr(""); try { setRun(await api.startTest(r)); } catch (e) { setErr((e as Error).message); } };
  const stop = () => run && api.stopTest(run.id).then((r) => r && setRun(r));
  const busy = !!run && ["starting", "running", "finishing"].includes(run.status);
  return { run, err, start, stop, busy, clear: () => setRun(null) };
}

function RunView({ run, onStop }: { run: TestRun; onStop: () => void }) {
  const busy = ["starting", "running", "finishing"].includes(run.status);
  const pct = Math.min(100, Math.round((run.capturedSec / Math.max(1, run.targetSec)) * 100));
  const [showLog, setShowLog] = useState(false);
  const copy = (s: string) => navigator.clipboard?.writeText(s).catch(() => {});
  return (
    <div className="card ts-run">
      <div className="card-head">
        <h2>{run.label}</h2>
        <span className={`pill ${run.status === "done" ? "on" : "off"}`} style={run.status === "failed" ? { color: "var(--err)" } : undefined}>{run.status}</span>
      </div>
      <p className={run.status === "failed" ? "err" : "muted"} style={{ marginTop: 0 }}>{run.message}</p>
      {busy && (
        <div className="row" style={{ alignItems: "center" }}>
          <div className="ts-bar"><div style={{ width: `${pct}%` }} /></div>
          <span className="muted num" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{run.capturedSec} / {run.targetSec} s</span>
          <button onClick={onStop}>Stop</button>
        </div>
      )}
      {run.video && <video className="ts-video" src={`/api/troubleshoot/play/${run.id}/video.mp4?t=${run.finishedAt ?? ""}`} controls autoPlay />}

      <div className="ts-facts">
        <div><span className="muted">Encoder</span>{run.encoder}</div>
        <div><span className="muted">Captured</span>{run.capturedSec} of {run.targetSec} s</div>
        {run.firstSegmentSec != null && <div><span className="muted">First video after</span>{run.firstSegmentSec} s</div>}
        {run.speed != null && <div title="How fast ErsatzTV next encoded while building up its buffer"><span className="muted">Encoding speed</span>{run.speed}× realtime</div>}
      </div>

      {(run.source || run.output) && (
        <div className="ts-probes">
          {run.source && <ProbeTable title="Source file" p={run.source} />}
          {run.output && <ProbeTable title="What viewers get" p={run.output} />}
        </div>
      )}

      {run.pipelines.length > 0 && (
        <>
          <h3>ffmpeg commands ErsatzTV next ran</h3>
          {run.pipelines.map((p, i) => (
            <div key={i} className="ts-cmd"><code>{p}</code><button className="ghost" onClick={() => copy(p)} title="Copy">Copy</button></div>
          ))}
        </>
      )}
      {run.problems.length > 0 && (
        <>
          <h3 className="err">Problems</h3>
          <pre className="ts-log err">{run.problems.join("\n")}</pre>
        </>
      )}
      <div className="row" style={{ alignItems: "center", marginTop: 10 }}>
        <button className="ghost" onClick={() => setShowLog((v) => !v)}>{showLog ? "Hide log" : `Show log (${run.log.length} lines)`}</button>
        {!busy && <a className="btn" href={`/api/troubleshoot/play/${run.id}/report.txt`}>Download report</a>}
        {!busy && run.video && <a className="btn" href={`/api/troubleshoot/play/${run.id}/video.mp4?download=1`} title="Exactly what ErsatzTV next sent viewers">Download video</a>}
        {!busy && run.video && <ShareableDownload runId={run.id} />}
      </div>
      {showLog && <pre className="ts-log">{run.log.join("\n")}</pre>}
    </div>
  );
}

const DISCORD_LIMIT = 10 * 1024 * 1024;

/** Converts the test's video to H.264 + AAC (plays inline on Discord, phones and
 *  in editors), then downloads it. */
function ShareableDownload({ runId }: { runId: string }) {
  const [state, setState] = useState<{ busy?: boolean; size?: number; err?: string }>({});
  useEffect(() => setState({}), [runId]);
  const go = async () => {
    setState({ busy: true });
    try {
      const { sizeBytes } = await api.makeShareable(runId);
      setState({ size: sizeBytes });
      window.location.href = `/api/troubleshoot/play/${runId}/shareable.mp4`;
    } catch (e) { setState({ err: (e as Error).message }); }
  };
  const mb = state.size != null ? (state.size / 1024 / 1024).toFixed(1) : "";
  return (
    <>
      <button disabled={state.busy} onClick={go} title="H.264 + AAC MP4, made to play right in Discord">{state.busy ? "Converting…" : "Download for Discord (H.264)"}</button>
      {state.size != null && (
        <span className={state.size > DISCORD_LIMIT ? "err" : "muted"} style={{ fontSize: 12 }}>
          {state.size > DISCORD_LIMIT ? `${mb} MB: over Discord's 10 MB free upload limit (fine with Nitro). A shorter test makes a smaller file.` : `${mb} MB, fits Discord's 10 MB limit.`}
        </span>
      )}
      {state.err && <span className="err" style={{ fontSize: 12 }}>{state.err}</span>}
    </>
  );
}

function ProbeTable({ title, p }: { title: string; p: ProbeSummary }) {
  return (
    <div className="ts-probe">
      <h3>{title}</h3>
      {p.error ? <p className="err">{p.error}</p> : (
        <>
          <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
            {[p.container, p.durationSec ? fmtDur(p.durationSec * 1000) : "", p.bitrateKbps ? `${p.bitrateKbps.toLocaleString()} kbps` : "", p.chapters ? `${p.chapters} chapters` : ""].filter(Boolean).join(" · ")}
          </p>
          <table className="ts-table">
            <tbody>
              {p.streams.map((s) => (
                <tr key={s.index}>
                  <td className="muted num">#{s.index}</td>
                  <td>{s.kind}</td>
                  <td><b>{s.codec}</b>{s.profile ? <span className="muted"> {s.profile}</span> : null}</td>
                  <td>{s.detail}</td>
                  <td className="muted">{[s.language, s.title && `“${s.title}”`, s.default && "default", s.forced && "forced"].filter(Boolean).join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ---- playback test -------------------------------------------------------------
function PlaybackTest({ channels }: { channels: ChannelSummary[] }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [item, setItem] = useState<{ type: string; id: number; title: string; durationMs: number } | null>(null);
  const [probe, setProbe] = useState<{ path: string; library?: string; probe: ProbeSummary } | null>(null);
  const [start, setStart] = useState("0:00");
  const [length, setLength] = useState(30);
  const [channel, setChannel] = useState("");
  const [accel, setAccel] = useState("default");
  const t = useTestRun();

  // arrived from Browse with an item picked
  useEffect(() => {
    const type = param("type"), id = Number(param("id"));
    if (type && id) choose({ type, id, title: "", durationMs: 0 });
  }, []);

  const search = async () => {
    if (!q.trim()) return;
    setSearching(true);
    try { setResults((await api.browseSearch(q, 0, 25)).items); } catch { setResults([]); }
    setSearching(false);
  };
  const choose = async (it: { type: string; id: number; title: string; durationMs: number }) => {
    setItem(it); setProbe(null); setResults([]);
    try { const r = await api.troubleProbe(it.type, it.id); setItem({ ...it, title: r.item.title, durationMs: r.item.durationMs }); setProbe({ path: r.item.path, library: r.item.library, probe: r.probe }); }
    catch (e) { setProbe({ path: "", probe: { file: "", chapters: 0, streams: [], error: (e as Error).message } }); }
  };

  return (
    <>
      <div className="card">
        <div className="card-head"><h2>1. Pick something to play</h2></div>
        <div className="row">
          <input style={{ flex: 1 }} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder='A title, or a search like show_title:"Hey Dude"' />
          <button className="primary" onClick={search} disabled={searching || !q.trim()}>{searching ? "Searching…" : "Search"}</button>
        </div>
        {results.length > 0 && (
          <ul className="ts-results">
            {results.map((r) => (
              <li key={`${r.type}:${r.id}`}>
                <button className="ghost" onClick={() => choose({ type: r.type, id: r.id, title: r.showTitle ? `${r.showTitle} — ${r.title}` : r.title, durationMs: r.durationMs })}>
                  <span>{r.showTitle ? <><b>{r.showTitle}</b> {r.season != null && `S${r.season}E${r.episode} · `}</> : null}{r.title}{r.year ? ` (${r.year})` : ""}</span>
                  <span className="muted num">{fmtDur(r.durationMs)} · {r.type.replace("_", " ")}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {item && (
          <div className="ts-picked">
            <div><b>{item.title || "Loading…"}</b> {item.durationMs > 0 && <span className="muted">· {fmtDur(item.durationMs)}</span>}</div>
            {probe?.path && <div className="muted mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{probe.path}</div>}
            {probe && <ProbeTable title="File details" p={probe.probe} />}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head"><h2>2. Choose how to play it</h2></div>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <label>Start at<input value={start} onChange={(e) => setStart(e.target.value)} placeholder="0:00" style={{ width: 90 }} /></label>
          <label>Play for
            <select value={length} onChange={(e) => setLength(Number(e.target.value))}>
              {[15, 30, 60, 120, 300].map((n) => <option key={n} value={n}>{n < 60 ? `${n} seconds` : `${n / 60} minute${n > 60 ? "s" : ""}`}</option>)}
            </select>
          </label>
          <label title="Uses that channel's audio language and subtitles settings">Audio and subtitles like
            <select value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="">No channel (file defaults)</option>
              {channels.map((c) => <option key={c.name} value={c.name}>{c.meta!.number} · {c.name}</option>)}
            </select>
          </label>
          <label>Hardware acceleration
            <select value={accel} onChange={(e) => setAccel(e.target.value)}>{ACCELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          This starts a separate, temporary ErsatzTV next on its own port, with your streaming settings, and plays just this item. Your channels keep running.
        </p>
        <div className="row" style={{ alignItems: "center" }}>
          <button className="primary" disabled={!item || t.busy} onClick={() => item && t.start({ kind: "item", type: item.type, id: item.id, startSec: parseTime(start), durationSec: length, channel: channel || undefined, accel })}>
            {t.busy ? "Testing…" : "Start test"}
          </button>
          {!item && <span className="muted">Pick something above first.</span>}
          {t.err && <span className="err">{t.err}</span>}
        </div>
      </div>

      {t.run && <RunView run={t.run} onStop={t.stop} />}
    </>
  );
}

// ---- up-next card tester ---------------------------------------------------------
function CardTester({ channels }: { channels: ChannelSummary[] }) {
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const [channel, setChannel] = useState(param("channel"));
  const [themes, setThemes] = useState<{ id: string; label: string }[]>([]);
  const [theme, setTheme] = useState("");
  const [day, setDay] = useState(today());
  const [time, setTime] = useState(() => { const d = new Date(); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; });
  const [slots, setSlots] = useState<CardSlot[] | null>(null);
  const [built, setBuilt] = useState(true);
  const [anchor, setAnchor] = useState<{ at: number; durationMs?: number; label: string } | null>(null);
  const [card, setCard] = useState<CardPreview | null>(null);
  const [err, setErr] = useState("");
  const t = useTestRun();

  useEffect(() => { api.upNextThemes().then(setThemes).catch(() => {}); }, []);
  useEffect(() => { if (!channel && channels.length) setChannel(channels[0].name); }, [channels]);
  const meta = channels.find((c) => c.name === channel)?.meta;
  const chosenMs = useMemo(() => new Date(`${day}T${time || "00:00"}`).getTime(), [day, time]);

  // the day's card slots from the built schedule; select the one nearest the chosen time
  useEffect(() => {
    if (!channel) return;
    const from = new Date(`${day}T00:00`).getTime();
    setSlots(null);
    api.cardSlots(channel, from, from + 86400000).then((r) => {
      setSlots(r.slots); setBuilt(r.built);
      const near = r.slots.find((s) => s.finishMs >= chosenMs) ?? r.slots[r.slots.length - 1];
      setAnchor(near ? { at: near.anchorMs, durationMs: near.finishMs - near.startMs, label: `the ${fmtClock(near.startMs)} card` } : { at: chosenMs, label: fmtClock(chosenMs) });
    }).catch((e) => { setSlots([]); setErr((e as Error).message); });
  }, [channel, day]);

  useEffect(() => {
    if (!channel || !anchor) return;
    setErr("");
    api.cardPreview(channel, anchor.at, theme || undefined, anchor.durationMs).then(setCard).catch((e) => { setCard(null); setErr((e as Error).message); });
  }, [channel, anchor, theme]);

  const nearest = slots && anchor ? slots.find((s) => s.anchorMs === anchor.at && s.finishMs - s.startMs === anchor.durationMs) : undefined;

  return (
    <>
      <div className="card">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <label>Channel
            <select value={channel} onChange={(e) => setChannel(e.target.value)}>
              {channels.map((c) => <option key={c.name} value={c.name}>{c.meta!.number} · {c.name}</option>)}
            </select>
          </label>
          <label>Theme
            <select value={theme} onChange={(e) => setTheme(e.target.value)}>
              <option value="">Channel's theme ({themes.find((x) => x.id === (meta?.upNextTheme || "splat"))?.label ?? meta?.upNextTheme ?? "Splat Orange"})</option>
              {themes.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </label>
          <label>Day<input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></label>
          <label>Time<input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
          <button style={{ alignSelf: "flex-end" }} onClick={() => setAnchor({ at: chosenMs, label: fmtClock(chosenMs) })} title="Show what a card at exactly this time would list">Card at this time</button>
        </div>
        {meta && meta.upNextTheme === "off" && <p className="muted" style={{ fontSize: 12 }}>This channel's up-next cards are turned off; the preview shows how it would look. Turn them on in the channel's settings.</p>}

        {slots && slots.length > 0 && (
          <div className="ts-slots">
            <span className="muted" style={{ fontSize: 12 }}>Cards in the schedule that day:</span>
            {slots.map((s) => (
              <button key={s.startMs} className={nearest === s ? "active" : ""} onClick={() => setAnchor({ at: s.anchorMs, durationMs: s.finishMs - s.startMs, label: `the ${fmtClock(s.startMs)} card` })}
                title={s.next ? `Then ${s.next} at ${s.nextAt}` : undefined}>
                {fmtClock(s.startMs)}
              </button>
            ))}
          </div>
        )}
        {slots && slots.length === 0 && (
          <p className="muted" style={{ fontSize: 12 }}>
            {built ? "No up-next cards in this channel's schedule that day." : "This channel hasn't been built for that day yet."} The preview uses the time you picked.
            {!built && <> <a href="/build" onClick={(e) => { e.preventDefault(); navigate("build"); }}>Build it</a> to see its real card slots.</>}
          </p>
        )}
      </div>

      {err && <p className="err">{err}</p>}
      {card && (
        <div className="card">
          <div className="card-head">
            <h2>Preview: {anchor?.label}</h2>
            <span className="muted" style={{ fontSize: 12 }}>{Math.round(card.durationMs / 100) / 10} s · {card.count} shows · {themes.find((x) => x.id === card.theme)?.label ?? card.theme}</span>
          </div>
          <CardStage card={card} channel={channel} />
          {nearest?.next && <p className="muted" style={{ fontSize: 12 }}>Airs before <b>{nearest.next}</b> at {nearest.nextAt}.</p>}
          {card.textMode === "subtitles" && <p className="muted" style={{ fontSize: 12 }}>On air this channel draws the card's text as subtitles; the preview shows the picture version. Render it to see the exact on-air look.</p>}
          {!card.enabled && <p className="muted" style={{ fontSize: 12 }}>Up-next cards are off {meta?.upNextTheme === "off" ? "for this channel" : "on the Streaming page"}, so this card won't air yet.</p>}
          <div className="row" style={{ alignItems: "center", marginTop: 8 }}>
            <button className="primary" disabled={t.busy || !anchor} onClick={() => anchor && t.start({ kind: "upnext", channel, at: anchor.at, theme: theme || undefined, durationSec: card.durationMs / 1000 })}>
              {t.busy ? "Rendering…" : "Render through ErsatzTV next"}
            </button>
            <span className="muted" style={{ fontSize: 12 }}>Plays the card through a temporary ErsatzTV next, with its music, exactly as it airs.</span>
            {t.err && <span className="err">{t.err}</span>}
          </div>
        </div>
      )}
      {t.run && <RunView run={t.run} onStop={t.stop} />}
    </>
  );
}

/** The card's layers stacked and faded with the engine's own timings. */
function CardStage({ card, channel }: { card: CardPreview; channel: string }) {
  const imgs = useRef<(HTMLImageElement | null)[]>([]);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [withMusic, setWithMusic] = useState(true);
  const raf = useRef(0);

  const opacityAt = (l: CardPreview["layers"][number], t: number) => {
    const a = l.phaseMs, b = a + l.fadeMs, c = b + l.holdMs, d = c + l.fadeMs;
    if (t < a || t > d) return 0;
    if (t < b) return (t - a) / Math.max(1, l.fadeMs);
    if (t <= c) return 1;
    return 1 - (t - c) / Math.max(1, l.fadeMs);
  };
  const paint = (t: number) => card.layers.forEach((l, i) => { const el = imgs.current[i]; if (el) el.style.opacity = String(opacityAt(l, t)); });
  const play = () => {
    cancelAnimationFrame(raf.current);
    const t0 = performance.now();
    setPlaying(true);
    if (audio.current && withMusic && card.audio) { audio.current.currentTime = 0; audio.current.play().catch(() => {}); }
    const tick = () => {
      const t = performance.now() - t0;
      paint(t);
      if (t < card.durationMs) raf.current = requestAnimationFrame(tick);
      else { setPlaying(false); audio.current?.pause(); paint(Math.min(card.durationMs * 0.7, card.durationMs - 1)); }
    };
    tick();
  };
  // show the fully revealed card until played
  useEffect(() => { paint(card.durationMs * 0.7); return () => cancelAnimationFrame(raf.current); }, [card]);
  useEffect(() => () => audio.current?.pause(), []);

  return (
    <>
      <div className="ts-stage" style={{ aspectRatio: `${card.width} / ${card.height}` }} onClick={play}>
        {card.layers.map((l, i) => <img key={l.url} ref={(el) => { imgs.current[i] = el; }} src={l.url} alt="" />)}
        {!playing && <span className="ts-play">▶ Play</span>}
      </div>
      <div className="row" style={{ alignItems: "center", marginTop: 8 }}>
        <button onClick={play}>{playing ? "Replay" : "Play"}</button>
        {card.audio
          ? <label><input type="checkbox" checked={withMusic} onChange={(e) => setWithMusic(e.target.checked)} /> With music <span className="muted">({card.audioName})</span></label>
          : <span className="muted" style={{ fontSize: 12 }}>No card music set for this channel.</span>}
        {card.audio && <audio ref={audio} src={`/api/troubleshoot/upnext/audio?channel=${encodeURIComponent(channel)}`} preload="auto" />}
      </div>
    </>
  );
}

// ---- system ----------------------------------------------------------------------
function SystemInfo() {
  const [sys, setSys] = useState<TroubleSystem | null>(null);
  const [err, setErr] = useState("");
  const [hw, setHw] = useState<HwTestResult[] | null>(null);
  const [testing, setTesting] = useState(false);
  useEffect(() => { api.troubleSystem().then(setSys).catch((e) => setErr((e as Error).message)); }, []);
  const runHw = async () => { setTesting(true); try { setHw((await api.hwTest()).results); } catch (e) { setErr((e as Error).message); } setTesting(false); };
  if (err) return <p className="err">{err}</p>;
  if (!sys) return <p className="muted">Checking…</p>;
  const Row = ({ k, v, bad }: { k: string; v: React.ReactNode; bad?: boolean }) => <div><span className="muted">{k}</span><span className={bad ? "err" : ""}>{v}</span></div>;
  return (
    <>
      <div className="ts-sys">
        <div className="card">
          <h2>Streaming settings</h2>
          <div className="ts-kv">
            <Row k="Video" v={`${sys.streaming.codec}, ${sys.streaming.size}, ${sys.streaming.bitrateKbps.toLocaleString()} kbps`} />
            <Row k="Acceleration" v={`${sys.streaming.accelLabel} (${sys.streaming.encoder})`} />
            <Row k="Audio" v={sys.streaming.audio} />
          </div>
          <a href="/streaming" onClick={(e) => { e.preventDefault(); navigate("streaming"); }} style={{ fontSize: 13 }}>Change on the Streaming page</a>
        </div>
        <div className="card">
          <h2>ErsatzTV next</h2>
          <div className="ts-kv">
            <Row k="Version" v={sys.next.found ? sys.next.version || "?" : "not found"} bad={!sys.next.found} />
            <Row k="Status" v={`${sys.next.phase}${sys.next.detail ? ` · ${sys.next.detail}` : ""}`} />
            <Row k="Program" v={<span className="mono">{sys.next.path}</span>} />
            <Row k="Segments folder" v={<span className="mono">{sys.next.outputFolder}</span>} />
          </div>
        </div>
        <div className="card">
          <h2>ffmpeg</h2>
          <div className="ts-kv">
            <Row k="ffmpeg" v={sys.ffmpeg.version} bad={!sys.ffmpeg.ok} />
            <Row k="ffprobe" v={sys.ffprobe.version} bad={!sys.ffprobe.ok} />
            <Row k="Path" v={<span className="mono">{sys.ffmpeg.path}</span>} />
            <Row k="Hardware decoders" v={sys.ffmpeg.hwaccels.join(", ") || "none"} />
          </div>
        </div>
        <div className="card">
          <h2>This computer</h2>
          <div className="ts-kv">
            <Row k="Scheduler" v={`${sys.scheduler.version} · Node ${sys.scheduler.node}`} />
            <Row k="System" v={sys.scheduler.os} />
            <Row k="Processor" v={`${sys.scheduler.cpu} (${sys.scheduler.cores} threads)`} />
            <Row k="Memory" v={`${sys.scheduler.memoryGb} GB`} />
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>Hardware encoders</h2>
          <button className="primary" onClick={runHw} disabled={testing}>{testing ? "Testing…" : hw ? "Test again" : "Test encoders"}</button>
        </div>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>Encodes a few seconds of test pattern with every encoder ffmpeg has, to show which acceleration settings work on this machine.</p>
        {hw && (
          <table className="ts-table">
            <thead><tr><th>Acceleration</th><th>Codec</th><th>Encoder</th><th>Result</th><th></th></tr></thead>
            <tbody>
              {hw.map((r) => (
                <tr key={r.encoder}>
                  <td>{r.label}{r.current && <span className="badge local" style={{ marginLeft: 6 }}>in use</span>}</td>
                  <td>{r.codec}</td>
                  <td className="mono">{r.encoder}</td>
                  <td className={r.ok ? "ok" : "err"}>{r.ok ? `Works (${(r.ms / 1000).toFixed(1)} s)` : "Doesn't work"}</td>
                  <td className="muted mono" style={{ fontSize: 11, maxWidth: 420, whiteSpace: "pre-wrap" }}>{r.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
