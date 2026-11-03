import { useEffect, useRef, useState } from "react";
import { compareChannelNumbers } from "../channelNumbers.js";
import { FallbackPicker } from "../FallbackPicker.js";
import { navigate } from "../nav.js";
import { api, logoSrc, type NextConfig, type ChannelSummary, type ApplyResult, type NextRunnerStatus, type UpdateStatus, type HdhrStatus, type HdhrTest } from "../api.js";

const PHASE_COLOR: Record<string, string> = { running: "#22c55e", waiting: "#f59e0b", starting: "#f59e0b", crashed: "#ef4444", stopped: "#64748b" };
const compareChannelNumbersOf = (a: ChannelSummary, b: ChannelSummary) => compareChannelNumbers(a.meta?.number ?? "", b.meta?.number ?? "");
const fmtUptime =(s: number) => { if (!s) return ""; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`; };

type LineupSort = "number" | "name" | "tvgId" | "group" | "enabled";

const mb = (n: number) => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;

/** ErsatzTV next and ErsatzTV's ffmpeg: what's installed in bin vs. the latest GitHub release, with one-click updates. */
function ProgramsCard({ onInstalled }: { onInstalled: () => void }) {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState("");
  const running = !!st?.job && ["downloading", "extracting", "installing"].includes(st.job.phase);

  const check = (refresh: boolean) => {
    setChecking(true); setErr("");
    api.updates(refresh ? "refresh" : undefined).then(setSt).catch((e) => setErr(String(e.message ?? e))).finally(() => setChecking(false));
  };
  useEffect(() => { check(false); }, []);
  // follow an install's progress
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => api.updates("cached").then((s) => {
      setSt(s);
      if (s.job && (s.job.phase === "done" || s.job.phase === "failed")) onInstalled();
    }).catch(() => {}), 1000);
    return () => clearInterval(t);
  }, [running]);

  const install = async (ids: ("next" | "ffmpeg")[]) => {
    setErr("");
    const r = await api.installUpdates(ids);
    if ("error" in r) setErr(r.error); else setSt(r);
  };

  const pending = st?.components.filter((c) => c.updateAvailable) ?? [];
  const job = st?.job;
  const ffmpeg = st?.components.find((c) => c.id === "ffmpeg");
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="job-head">
        Programs
        {st && !running && pending.length === 0 && !st.checkError && st.checkedAt && <span className="ok" style={{ fontWeight: 400 }}>all up to date ✓</span>}
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        ErsatzTV next and ErsatzTV's own ffmpeg, kept in <code>{st?.binDir ?? "bin"}</code>. <b>Update</b> downloads the latest
        release from GitHub and swaps it in. Channels keep playing while it downloads; if ErsatzTV next is running it restarts at the end,
        which briefly interrupts viewers.
      </p>
      {st && (
        <table className="history" style={{ marginTop: 4 }}>
          <thead><tr><th>Program</th><th>Installed</th><th>Latest release</th><th /></tr></thead>
          <tbody>
            {st.components.map((c) => (
              <tr key={c.id}>
                <td>{c.label}</td>
                <td>{c.installed ? <code>{c.installed}</code> : <span className={c.found ? "muted" : "err"}>{c.found ? "unknown version" : "not installed"}</span>}
                  {c.note && c.installed && <span className="muted"> · {c.note}</span>}</td>
                <td>{c.latest ? <><a href={c.latest.pageUrl} target="_blank" rel="noreferrer">{c.latest.tag}</a> <span className="muted">· {new Date(c.latest.publishedAt).toLocaleDateString()}{c.latest.size ? ` · ${mb(c.latest.size)}` : ""}</span></> : <span className="muted">—</span>}</td>
                <td style={{ textAlign: "right" }}>
                  {c.updateAvailable
                    ? <button onClick={() => install([c.id])} disabled={running}>{c.found ? "Update" : "Install"}</button>
                    : c.latest && <span className="ok">up to date</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {st?.ffmpegRequired && ffmpeg?.updateAvailable && (
        <p className="muted" style={{ fontSize: 12 }}>ErsatzTV next's latest release notes ask for ErsatzTV-ffmpeg <code>{st.ffmpegRequired}</code> or newer.</p>
      )}
      {job && (
        <div style={{ margin: "8px 0" }}>
          <div className={job.phase === "failed" ? "err" : job.phase === "done" ? "ok" : "muted"}>
            {job.phase === "failed" ? `Update failed: ${job.message}` : job.message}
            {job.phase === "downloading" && job.total > 0 && ` ${mb(job.received)} of ${mb(job.total)}`}
          </div>
          {running && <div className="progress"><div className="bar" style={{ width: `${job.phase === "downloading" && job.total ? Math.round((job.received / job.total) * 100) : 100}%` }} /></div>}
          {job.phase === "done" && <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>Next: turn on <b>Keep ErsatzTV next running</b> above if it's off, then play a channel. <b>Troubleshooting → Hardware encoders</b> re-checks your GPU encoder with the new ffmpeg.</p>}
        </div>
      )}
      {(err || st?.checkError) && <div className="err" style={{ margin: "6px 0" }}>{err || `Couldn't check for updates: ${st?.checkError}`}</div>}
      <div className="actions">
        {pending.length > 1 && <button className="primary" onClick={() => install(pending.map((c) => c.id))} disabled={running}>Update both</button>}
        <button onClick={() => check(true)} disabled={checking || running}>{checking ? "Checking…" : "Check for updates"}</button>
        {st?.checkedAt && <span className="muted">checked {new Date(st.checkedAt).toLocaleTimeString()}</span>}
      </div>
    </div>
  );
}

export function Streaming() {
  const [lineupSort, setLineupSort] = useState<{ key: LineupSort; dir: "asc" | "desc" }>({ key: "number", dir: "asc" });
  const [tab, setTab] = useState<"server" | "av" | "upnext" | "guide" | "plex" | "lineup">("server");
  const [cfg, setCfg] = useState<NextConfig | null>(null);
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [runner, setRunner] = useState<NextRunnerStatus | null>(null);
  const [msg, setMsg] = useState("");
  const [guideThemes, setGuideThemes] = useState<{ id: string; label: string }[]>([]);
  const [logoAddr, setLogoAddr] = useState<{ auto: string } | null>(null);
  const [guideCheck, setGuideCheck] = useState<{ ffmpeg: string; found: boolean; drawtext: boolean } | null>(null);
  useEffect(() => { if (tab === "guide") api.guideCheck().then(setGuideCheck).catch(() => setGuideCheck(null)); }, [tab]);
  // the guide channel's logo saves on upload/remove (only that field is taken back, so unsaved edits stay)
  const [guideLogoBusy, setGuideLogoBusy] = useState(false);
  const guideLogoInput = useRef<HTMLInputElement>(null);
  const takeGuideLogo = (c: NextConfig) => setCfg((old) => old && { ...old, guide: { ...old.guide, logo: c.guide.logo } });
  const uploadGuideLogo = async (f: File) => {
    setGuideLogoBusy(true);
    try { takeGuideLogo(await api.uploadGuideLogo(f)); flash("Logo saved ✓ — Apply to publish it"); }
    catch (e) { setMsg(`Error: ${(e as Error).message}`); }
    finally { setGuideLogoBusy(false); }
  };
  const removeGuideLogo = async () => {
    setGuideLogoBusy(true);
    try { takeGuideLogo(await api.removeGuideLogo()); flash("Logo removed ✓"); } finally { setGuideLogoBusy(false); }
  };
  const [hdhr, setHdhr] = useState<HdhrStatus | null>(null);
  const [tuneCh, setTuneCh] = useState("");
  const [tuneTest, setTuneTest] = useState<HdhrTest | "running" | null>(null);
  useEffect(() => {
    if (tab !== "plex") return;
    const load = () => api.hdhr().then(setHdhr).catch(() => {});
    load(); const t = window.setInterval(load, 3000); return () => clearInterval(t);
  }, [tab]);

  useEffect(() => {
    api.getNextConfig().then(setCfg).catch(() => {});
    api.logoAddress().then(setLogoAddr).catch(() => {});
    api.channels().then(setChannels).catch(() => {});
    api.guideThemes().then(setGuideThemes).catch(() => {});
    const load = () => api.nextRunner().then(setRunner).catch(() => {});
    load(); const t = window.setInterval(load, 2500); return () => clearInterval(t);
  }, []);

  const toggleKeep = async (v: boolean) => { await api.setConfig({ keepNextRunning: v }); api.nextRunner().then(setRunner).catch(() => {}); };
  const runnerAct = async (fn: () => Promise<NextRunnerStatus>) => { const s = await fn(); setRunner(s); };

  if (!cfg) return <section className="screen"><h1>Streaming</h1><p className="muted">Loading…</p></section>;

  const set = (patch: Partial<NextConfig>) => setCfg({ ...cfg, ...patch });
  const setV = (patch: Partial<NextConfig["video"]>) => setCfg({ ...cfg, video: { ...cfg.video, ...patch } });
  const setA = (patch: Partial<NextConfig["audio"]>) => setCfg({ ...cfg, audio: { ...cfg.audio, ...patch } });
  const setU = (patch: Partial<NextConfig["upNext"]>) => setCfg({ ...cfg, upNext: { ...cfg.upNext, ...patch } });
  const setG = (patch: Partial<NextConfig["guide"]>) => setCfg({ ...cfg, guide: { ...cfg.guide, ...patch } });
  const num = (e: React.ChangeEvent<HTMLInputElement>) => Number(e.target.value);

  const save = async () => { const c = await api.setNextConfig(cfg); setCfg(c); flash("Saved ✓"); api.hdhr().then(setHdhr).catch(() => {}); };
  const setH = (patch: Partial<NextConfig["hdhr"]>) => setCfg({ ...cfg, hdhr: { ...cfg.hdhr, ...patch } });
  const runTuneTest = async () => {
    setTuneTest("running");
    try { setTuneTest(await api.hdhrTest(tuneCh || enabled.slice().sort(compareChannelNumbersOf)[0]?.meta?.number || "1")); }
    catch (e) { setTuneTest({ ok: false, firstByteSec: null, seconds: 0, mb: 0, video: "", audio: "", problem: (e as Error).message, advice: "" }); }
  };
  const copy = (s: string) => { void navigator.clipboard?.writeText(s).then(() => flash("Copied ✓")).catch(() => {}); };
  const apply = async () => {
    await api.setNextConfig(cfg);
    const r = await api.applyNext(); setResult(r); flash(`Wrote lineup + ${r.channels.length} channel config(s) ✓`);
  };
  const flash = (t: string) => { setMsg(t); setTimeout(() => setMsg(""), 2500); };

  const enabled = channels.filter((c) => c.meta?.enabled);
  // lineup table sorting: click a header to sort, click again to reverse
  const text = (v?: string) => (v ?? "").toLowerCase();
  const LINEUP_COLS: { key: LineupSort; label: string; cmp: (a: ChannelSummary, b: ChannelSummary) => number }[] = [
    { key: "number", label: "#", cmp: (a, b) => compareChannelNumbers(a.meta?.number ?? "", b.meta?.number ?? "") },
    { key: "name", label: "Channel", cmp: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) },
    { key: "tvgId", label: "tvg_id", cmp: (a, b) => text(a.meta?.tvgId).localeCompare(text(b.meta?.tvgId), undefined, { numeric: true }) },
    { key: "group", label: "Group", cmp: (a, b) => text(a.meta?.group).localeCompare(text(b.meta?.group), undefined, { numeric: true }) },
    { key: "enabled", label: "Enabled", cmp: (a, b) => Number(!!b.meta?.enabled) - Number(!!a.meta?.enabled) },
  ];
  const byNumber = LINEUP_COLS[0].cmp;
  const sortCol = LINEUP_COLS.find((c) => c.key === lineupSort.key) ?? LINEUP_COLS[0];
  const lineupRows = [...channels].sort((a, b) => (sortCol.cmp(a, b) || byNumber(a, b)) * (lineupSort.dir === "asc" ? 1 : -1));
  const sortBy = (key: LineupSort) => setLineupSort((s) => ({ key, dir: s.key === key && s.dir === "asc" ? "desc" : "asc" }));
  const TABS = [["server", "Server"], ["av", "Video & audio"], ["upnext", "Up-next cards"], ["guide", "Guide channel"], ["plex", "Plex (HDHomeRun)"], ["lineup", `Lineup (${enabled.length})`]] as const;

  return (
    <section className="screen">
      <h1>Streaming</h1>
      <p className="muted">The ErsatzTV next server that streams your channels. Settings here are written to <code>lineup.json</code> and each
        channel's <code>config.json</code> when you <b>Apply</b>; restart the server afterwards to load them.</p>

      {/* --- managed ErsatzTV next process --- */}
      {runner && (
        <div className="card">
          <div className="job-head">
            <label className="switch"><input type="checkbox" checked={runner.enabled} onChange={(e) => toggleKeep(e.target.checked)} /> Keep ErsatzTV next running</label>
            <span className="pill" style={{ background: PHASE_COLOR[runner.phase] ?? "#64748b", color: "#fff" }}>{runner.phase}</span>
            {runner.phase === "running" && <span className="muted">pid {runner.pid} · up {fmtUptime(runner.uptimeSec)} · port {runner.port}{runner.restarts ? ` · ${runner.restarts} restarts` : ""}</span>}
            {runner.phase !== "running" && runner.detail && !runner.problem && <span className="muted">{runner.detail}</span>}
            {runner.problem && <span className="err">Can't start: {runner.problem}</span>}
            {runner.version && <span className="muted">version {runner.version}</span>}
          </div>
          {runner.versionWarning && <div className="verify bad" style={{ margin: "6px 0" }}><div className="status">⚠ Update ErsatzTV next</div><div className="muted">{runner.versionWarning}</div></div>}
          <p className="muted">When on, the server keeps an ErsatzTV next instance alive as long as there's a built playout, restarting it automatically if it crashes. Playout top-ups are picked up from the folder; new channels or streaming-setting changes need a restart (below).</p>

          {runner.stale && (
            <div className="verify bad" style={{ margin: "6px 0" }}>
              <div className="status">⚠ The running instance is out of date</div>
              <div className="muted" style={{ margin: "4px 0 8px" }}>Channels or streaming settings changed since it started. Restart to load them (this briefly interrupts all channels).</div>
              <button className="primary" onClick={() => runnerAct(api.nextRestart)}>Restart to apply changes</button>
            </div>
          )}

          <div className="actions">
            <button onClick={() => runnerAct(api.nextStart)} disabled={runner.phase === "running" || runner.phase === "starting"}>Start</button>
            <button onClick={() => runnerAct(api.nextStop)} disabled={runner.phase === "stopped" || runner.phase === "waiting"}>Stop</button>
            <button onClick={() => runnerAct(api.nextRestart)}>Restart</button>
            {!runner.binaryFound && <span className="err">binary not found: <code>{runner.binaryPath}</code>. Install it under Programs below.</span>}
            {runner.binaryFound && !runner.hasPlayouts && <span className="muted">no built playout yet — build a channel first</span>}
          </div>
          {runner.log.length > 0 && <pre className="log" style={{ maxHeight: 160 }}>{runner.log.slice(-25).join("\n")}</pre>}
        </div>
      )}

      {/* an install can repoint the ffmpeg paths, so reload the settings too (Save would otherwise put the old ones back) */}
      <ProgramsCard onInstalled={() => { api.nextRunner().then(setRunner).catch(() => {}); api.getNextConfig().then((c) => setCfg((old) => old && { ...old, ffmpegPath: c.ffmpegPath, ffprobePath: c.ffprobePath, ...{ binaryPath: (c as { binaryPath?: string }).binaryPath } })).catch(() => {}); }} />

      <div className="subtabs" style={{ marginTop: 22 }}>
        {TABS.map(([id, label]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>)}
      </div>

      {tab === "server" && <>
      <div className="form" style={{ marginTop: 0 }}>
        <div className="row">
          <label>Bind address<input value={cfg.bindAddress} onChange={(e) => set({ bindAddress: e.target.value })} /></label>
          <label>Port<input type="number" value={cfg.port} onChange={(e) => set({ port: num(e) })} /></label>
          <label>Runtime folder<input value={cfg.runtimeDir} onChange={(e) => set({ runtimeDir: e.target.value })} /></label>
        </div>
        <div className="row">
          <label style={{ flex: 1 }}>Segment output folder<input value={cfg.outputFolder} onChange={(e) => set({ outputFolder: e.target.value })} placeholder="./output or a ramdisk e.g. /dev/shm/etv" /></label>
        </div>
        <div className="row">
          <label style={{ flex: 1 }}>Address TV apps use to reach this scheduler (channel logos, guide posters)
            <input value={cfg.publicUrl ?? ""} onChange={(e) => set({ publicUrl: e.target.value })} placeholder={logoAddr ? `${logoAddr.auto} (automatic)` : "automatic"} />
          </label>
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 2 }}>
          Channel logos and the guide's programme posters are served by this scheduler, and the M3U/guide tell TV apps where to fetch them.
          Leave blank to use this machine's network address{logoAddr ? <> (<code>{logoAddr.auto}</code>)</> : null}.
          Behind a reverse proxy, enter the public address (e.g. <code>https://tv.example.com</code>) and have the proxy forward
          only <code>/logos/</code> and <code>/art/</code> on it to this scheduler — not the whole app, which has no login. Apply after changing.
        </p>
        <p className="muted" style={{ fontSize: 12, marginTop: 2 }}>Where next writes transcoded HLS segments. Use an absolute path to a ramdisk (e.g. <code>/dev/shm/etv</code> on Linux, or a RAM-disk drive on Windows) to avoid churning your NVMe. Relative paths resolve under the runtime folder. Click Apply after changing.</p>
      </div>

      <h2>FFmpeg</h2>
      <div className="form" style={{ marginTop: 0 }}>
        <div className="row">
          <label>ffmpeg path<input value={cfg.ffmpegPath} onChange={(e) => set({ ffmpegPath: e.target.value })} placeholder="C:\\…\\ffmpeg.exe" /></label>
          <label>ffprobe path<input value={cfg.ffprobePath} onChange={(e) => set({ ffprobePath: e.target.value })} placeholder="C:\\…\\ffprobe.exe" /></label>
        </div>
      </div>

      </>}

      {tab === "av" && <>
      <div className="form" style={{ marginTop: 0 }}>
        <div className="row">
          <label>Width<input type="number" value={cfg.video.width} onChange={(e) => setV({ width: num(e) })} /></label>
          <label>Height<input type="number" value={cfg.video.height} onChange={(e) => setV({ height: num(e) })} /></label>
          <label>Video codec<input value={cfg.video.codec} onChange={(e) => setV({ codec: e.target.value })} /></label>
          <label>Video kbps<input type="number" value={cfg.video.bitrateKbps} onChange={(e) => setV({ bitrateKbps: num(e) })} /></label>
        </div>
        <div className="row">
          <label>Hardware acceleration
            <select value={cfg.video.accel} onChange={(e) => setV({ accel: e.target.value })}>
              <option value="">Software (none)</option>
              <option value="cuda">NVIDIA (CUDA/NVENC)</option>
              <option value="qsv">Intel Quick Sync (QSV)</option>
              <option value="vaapi">VAAPI (Linux)</option>
              <option value="amf">AMD (AMF)</option>
              <option value="videotoolbox">VideoToolbox (macOS)</option>
              <option value="vulkan">Vulkan</option>
              <option value="rkmpp">Rockchip (RKMPP)</option>
            </select>
          </label>
          <label title="Used by software, NVIDIA, Vulkan and VAAPI encoding. Quick Sync tone-maps on its own. Software has no bt2390 and uses ErsatzTV next's default instead.">HDR→SDR tonemap
            <select value={cfg.video.tonemapAlgorithm} onChange={(e) => setV({ tonemapAlgorithm: e.target.value })}>
              <option value="linear">linear</option><option value="mobius">mobius</option><option value="hable">hable</option><option value="reinhard">reinhard</option><option value="bt2390">bt2390</option>
            </select>
          </label>
        </div>
        <div className="row">
          <label>Audio codec<input value={cfg.audio.codec} onChange={(e) => setA({ codec: e.target.value })} /></label>
          <label>Audio kbps<input type="number" value={cfg.audio.bitrateKbps} onChange={(e) => setA({ bitrateKbps: num(e) })} /></label>
          <label>Channels<input type="number" value={cfg.audio.channels} onChange={(e) => setA({ channels: num(e) })} /></label>
          <label className="switch" style={{ alignSelf: "end", paddingBottom: 8 }}>
            <input type="checkbox" checked={cfg.audio.normalizeLoudness} onChange={(e) => setA({ normalizeLoudness: e.target.checked })} /> Normalize loudness
          </label>
        </div>
      </div>
      <h2>Fallback picture</h2>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>The default for every channel; a channel can pick its own under Channels → Channel settings.</p>
      <div className="form" style={{ marginTop: 0 }}>
        <FallbackPicker value={cfg.fallbackImage ?? "black"} onChange={(v) => set({ fallbackImage: v })} channel="" />
      </div>
      </>}

      {tab === "upnext" && <>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        Master switch for the animated “coming up next” card shown at the start of each final break, using
        next’s graphics engine (a live canvas overlay). It lists the next {cfg.upNext.count} programme{cfg.upNext.count === 1 ? "" : "s"} with
        time-only stamps from that channel’s guide. Each element is a separate graphics layer that next fades in one at
        a time (native timing), then all fade out. Pick the <b>design per channel</b> (or turn it off) on the Channels
        screen. Rebuild playouts after enabling. Needs an ErsatzTV next build with multi-layer graphics (schema 0.0.3+);
        card art is rendered to PNG layers via <code>@resvg/resvg-js</code>.
      </p>
      <div className="form">
        <div className="row">
          <label className="switch" style={{ alignSelf: "end", paddingBottom: 8 }}>
            <input type="checkbox" checked={cfg.upNext.enabled} onChange={(e) => setU({ enabled: e.target.checked })} /> Show “coming up next” cards
          </label>
          <label>Shows to list<input type="number" min={1} max={6} value={cfg.upNext.count} onChange={(e) => setU({ count: Math.max(1, Math.min(6, num(e))) })} disabled={!cfg.upNext.enabled} /></label>
          <label>Card length (seconds)<input type="number" min={3} max={60} value={Math.round(cfg.upNext.durationMs / 1000)} onChange={(e) => setU({ durationMs: Math.max(3, Math.min(60, num(e))) * 1000 })} disabled={!cfg.upNext.enabled} /></label>
        </div>
        <div className="row">
          <label style={{ flex: 1 }}>Font file (TTF for the card text)<input value={cfg.upNext.fontFile} onChange={(e) => setU({ fontFile: e.target.value })} placeholder="C:/Windows/Fonts/arialbd.ttf" disabled={!cfg.upNext.enabled} /></label>
        </div>
      </div>
      </>}

      {tab === "guide" && <>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        Adds a scrolling TV guide as its own channel, like the old cable preview channels: your channels down the side,
        half-hour columns across, a clock at the top and background music. It's drawn live from every channel's guide.
        To set it up, tick <b>Enable guide channel</b>, click <b>Apply</b> to add it to the lineup, then build playouts.
        {" "}<button className="ghost" onClick={() => navigate("troubleshoot", { tab: "play", guide: "1" })} title="Play the guide in a temporary ErsatzTV next, with these settings (save them first)">Test the guide →</button>
      </p>
      {guideCheck && (guideCheck.drawtext
        ? <p className="muted" style={{ fontSize: 12 }}>✓ Your ffmpeg can draw the guide.</p>
        : <p className="warn" style={{ fontSize: 12 }}>
            {guideCheck.found
              ? <>Your ffmpeg (<code>{guideCheck.ffmpeg}</code>) can't draw text, so the guide channel would stay blank. </>
              : <>The scheduler couldn't run ffmpeg (<code>{guideCheck.ffmpeg}</code>), so the guide channel can't play. </>}
            Install the ErsatzTV ffmpeg under <b>Programs</b> at the top of this page, or set <b>ffmpeg path</b> on the Server tab to a full ffmpeg build.
          </p>)}
      <div className="form">
        <div className="row">
          <label className="switch" style={{ alignSelf: "end", paddingBottom: 8 }}>
            <input type="checkbox" checked={cfg.guide.enabled} onChange={(e) => setG({ enabled: e.target.checked })} /> Enable guide channel
          </label>
          <label>Channel #<input value={cfg.guide.number} onChange={(e) => setG({ number: e.target.value })} disabled={!cfg.guide.enabled} /></label>
          <label>Name<input value={cfg.guide.name} onChange={(e) => setG({ name: e.target.value })} disabled={!cfg.guide.enabled} /></label>
          <label>Group<input value={cfg.guide.group} onChange={(e) => setG({ group: e.target.value })} disabled={!cfg.guide.enabled} /></label>
        </div>
        <div className="row">
          <label>Columns (half-hours)<input type="number" min={1} max={5} value={cfg.guide.columns} onChange={(e) => setG({ columns: Math.max(1, Math.min(5, num(e))) })} disabled={!cfg.guide.enabled} /></label>
          <label>Scroll speed (px/sec)<input type="number" min={10} max={300} value={cfg.guide.scrollSpeed} onChange={(e) => setG({ scrollSpeed: Math.max(10, Math.min(300, num(e))) })} disabled={!cfg.guide.enabled} /></label>
          <label>Refresh (minutes)<input type="number" min={5} max={120} value={cfg.guide.refreshMin} onChange={(e) => setG({ refreshMin: Math.max(5, Math.min(120, num(e))) })} disabled={!cfg.guide.enabled} /></label>
          <label>Featured rotate (sec)<input type="number" min={5} max={600} value={cfg.guide.promoRotateSec ?? 30} onChange={(e) => setG({ promoRotateSec: Math.max(5, Math.min(600, num(e))) })} disabled={!cfg.guide.enabled} /></label>
          <label>Theme
            <select value={cfg.guide.theme ?? "classic"} onChange={(e) => setG({ theme: e.target.value })} disabled={!cfg.guide.enabled}>
              {(guideThemes.length ? guideThemes : [{ id: "classic", label: "Classic" }]).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>
        </div>
        <div className="row">
          <label style={{ flex: 2 }}>Background music folder<input value={cfg.guide.musicFolder} onChange={(e) => setG({ musicFolder: e.target.value })} placeholder="C:\\Media\\guide-music (random track each refresh; blank = silent)" disabled={!cfg.guide.enabled} /></label>
        </div>
        <div className="row">
          <label style={{ flex: 2 }}>Promo/trailer clips folder<input value={cfg.guide.promoFolder} onChange={(e) => setG({ promoFolder: e.target.value })} placeholder="C:\\Media\\guide-promos (random clip in the corner window; blank = placeholder)" disabled={!cfg.guide.enabled} /></label>
        </div>
      </div>
      <h2>Logo</h2>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>The guide channel's icon in TV apps' channel lists and guides, like any channel's logo. Uploads save right away; click <b>Apply</b> and restart next for TV apps to pick it up.</p>
      <div className="row" style={{ alignItems: "center", gap: 14 }}>
        <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void uploadGuideLogo(f); }}
          title="Drop an image here to use it as the logo"
          style={{ width: 120, height: 80, border: "1px dashed var(--border, #475569)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          {logoSrc(cfg.guide.logo)
            ? <img src={logoSrc(cfg.guide.logo)} alt="Guide channel logo" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
            : <span className="muted" style={{ fontSize: 11, textAlign: "center", padding: 6 }}>{guideLogoBusy ? "Uploading…" : "No logo — drop an image here"}</span>}
        </div>
        <div className="actions" style={{ margin: 0 }}>
          <button onClick={() => guideLogoInput.current?.click()} disabled={guideLogoBusy}>{cfg.guide.logo ? "Replace logo…" : "Upload logo…"}</button>
          {cfg.guide.logo && <button onClick={removeGuideLogo} disabled={guideLogoBusy}>Remove</button>}
          <input ref={guideLogoInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/bmp" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadGuideLogo(f); }} />
        </div>
      </div>
      <div className="form">
        <div className="row">
          <label style={{ flex: 2 }}>Or a web address<input value={/^https?:\/\//i.test(cfg.guide.logo) ? cfg.guide.logo : ""} onChange={(e) => setG({ logo: e.target.value })} placeholder="https://…/logo.png — then Save settings" /></label>
        </div>
      </div>
      </>}

      {tab === "plex" && <>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        Plex's Live TV &amp; DVR only works with HDHomeRun tuners, so the scheduler can pretend to be one. Plex tunes a channel,
        the scheduler asks ErsatzTV next for it and passes it on as the plain video stream a tuner sends (no re-encoding).
        It runs on its own port, so Plex never needs the dashboard. Jellyfin, Emby and Channels DVR can use it too, though they
        also take next's M3U directly.
      </p>
      <div className="form">
        <div className="row">
          <label className="switch" style={{ alignSelf: "end", paddingBottom: 8 }}>
            <input type="checkbox" checked={cfg.hdhr.enabled} onChange={(e) => setH({ enabled: e.target.checked })} /> Act as an HDHomeRun tuner
          </label>
          <label>Port<input type="number" min={1} max={65535} value={cfg.hdhr.port} onChange={(e) => setH({ port: num(e) })} /></label>
          <label title="How many channels can play or record at once. Each one is a channel next is streaming.">Tuners<input type="number" min={1} max={32} value={cfg.hdhr.tuners} onChange={(e) => setH({ tuners: Math.max(1, Math.min(32, num(e))) })} /></label>
          <label>Name in Plex<input value={cfg.hdhr.name} onChange={(e) => setH({ name: e.target.value })} /></label>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>Click <b>Save settings</b> below to turn it on or off; no restart needed.</p>

      {hdhr && (hdhr.error
        ? <p className="warn" style={{ fontSize: 12 }}>The tuner couldn't start: {hdhr.error}</p>
        : hdhr.listening
          ? <div className="card">
              <div className="ok" style={{ marginBottom: 6 }}>✓ Tuner running at <code>{hdhr.address}</code> · {hdhr.tuners} tuner{hdhr.tuners === 1 ? "" : "s"}</div>
              <h3 style={{ margin: "8px 0 4px" }}>Add it to Plex</h3>
              <ol style={{ margin: "0 0 0 18px", padding: 0, fontSize: 13, lineHeight: 1.7 }}>
                <li>In Plex, open <b>Settings → Live TV &amp; DVR → Set up Plex DVR</b>.</li>
                <li>If Plex doesn't find it on its own, choose <b>Don't see your HDHomeRun device? Enter its network address manually</b> and
                  type <code>{hdhr.address}</code> <button className="ghost" onClick={() => copy(hdhr.address)}>Copy</button></li>
                <li>Plex lists your channels. Keep them all, or untick the ones you don't want.</li>
                <li>For the guide, choose <b>Have an XMLTV guide on your server? Click here to use that instead</b> and enter
                  {" "}<code>{hdhr.guideUrl}</code> <button className="ghost" onClick={() => copy(hdhr.guideUrl)}>Copy</button></li>
                <li>Plex matches guide channels by number. Check the list and finish.</li>
              </ol>
              <p className="muted" style={{ fontSize: 12 }}>
                ErsatzTV next must be running (top of this page). After adding or renumbering channels, click <b>Apply</b>, restart next,
                then in Plex use <b>Scan channels</b> and refresh the guide.
              </p>
            </div>
          : cfg.hdhr.enabled ? <p className="muted" style={{ fontSize: 12 }}>Save settings to start the tuner.</p> : null)}

      {hdhr?.listening && <>
        <h2>Test a tune</h2>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Tunes a channel through the tuner just as Plex would, keeps about 12 seconds, and checks how long it took to start and what Plex receives.</p>
        <div className="actions">
          <select value={tuneCh} onChange={(e) => setTuneCh(e.target.value)} style={{ width: "auto" }}>
            {enabled.slice().sort(compareChannelNumbersOf).map((c) => <option key={c.name} value={c.meta?.number}>{c.meta?.number} · {c.name}</option>)}
          </select>
          <button className="primary" onClick={runTuneTest} disabled={tuneTest === "running"}>{tuneTest === "running" ? "Tuning… (up to a minute)" : "Test tune"}</button>
        </div>
        {tuneTest && tuneTest !== "running" && (
          <div className={`verify ${tuneTest.ok ? "" : "bad"}`} style={{ margin: "6px 0" }}>
            <div className="status">{tuneTest.ok ? "✓ Plex would get a picture" : "✗ The tune didn't work"}</div>
            {tuneTest.ok && <div className="muted">Started in {tuneTest.firstByteSec} s · {tuneTest.seconds} s captured ({tuneTest.mb} MB) · video {tuneTest.video} · audio {tuneTest.audio || "none"}</div>}
            {tuneTest.problem && <div className="muted">{tuneTest.problem}</div>}
            {tuneTest.advice && <div className="warn" style={{ marginTop: 4 }}>{tuneTest.advice}</div>}
          </div>
        )}
        {hdhr.inUse.length > 0 && <>
          <h2>In use</h2>
          <table className="history">
            <thead><tr><th>Channel</th><th>Watching</th><th>For</th><th>Sent</th></tr></thead>
            <tbody>{hdhr.inUse.map((t, i) => <tr key={i}><td>{t.channel} · {t.name}</td><td>{t.client}</td><td>{fmtUptime(t.sinceSec)}</td><td>{t.mb} MB</td></tr>)}</tbody>
          </table>
        </>}
      </>}
      </>}

      {tab === "lineup" && <>
      <p className="muted" style={{ marginTop: 0 }}>Enabled channels go into the lineup in number order. Change numbers, groups and ids on each channel's settings.</p>
      <table className="history">
        <thead><tr>{LINEUP_COLS.map((c) => (
          <th key={c.key} className="sortable" aria-sort={lineupSort.key === c.key ? (lineupSort.dir === "asc" ? "ascending" : "descending") : "none"} onClick={() => sortBy(c.key)}>
            {c.label}<span className="sort-mark">{lineupSort.key === c.key ? (lineupSort.dir === "asc" ? " ▲" : " ▼") : ""}</span>
          </th>
        ))}</tr></thead>
        <tbody>
          {lineupRows.map((c) => (
            <tr key={c.name}>
              <td>{c.meta?.number}</td><td>{c.name}</td><td>{c.meta?.tvgId}</td><td>{c.meta?.group}</td>
              <td className={c.meta?.enabled ? "ok" : "muted"}>{c.meta?.enabled ? "yes" : "no"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </>}

      <div className="actions sticky-actions">
        <button className="primary" onClick={apply} title="Save, then write lineup.json and every channel's config.json">Apply (write lineup + configs)</button>
        <button onClick={save}>Save settings</button>
        {msg && <span className="ok">{msg}</span>}
      </div>
      {result && <p className="muted">Wrote <code>{result.lineup}</code>{result.skipped.length ? ` · removed ${result.skipped.length} stale config(s)` : ""}. If “Keep ErsatzTV next running” is on, use the <b>Restart</b> button above to load the new lineup.</p>}
    </section>
  );
}
