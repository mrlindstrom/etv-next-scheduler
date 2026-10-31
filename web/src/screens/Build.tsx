import { useEffect, useRef, useState } from "react";
import { api, type AppConfig, type ChannelSummary, type BuildJob, type SchedulerStatus } from "../api.js";

export function BuildScreen({ config }: { config: AppConfig | null }) {
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [channel, setChannel] = useState("__all__");
  const [days, setDays] = useState(config?.days ?? 3);
  const [job, setJob] = useState<BuildJob | null>(null);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const poll = useRef<number | null>(null);

  // automation
  const [auto, setAuto] = useState(config?.autoBuild ?? false);
  const [interval, setIntervalMin] = useState(config?.buildIntervalMin ?? 60);
  const [threshold, setThreshold] = useState(config?.refreshThresholdHours ?? 24);
  const [scanHours, setScanHours] = useState(config?.autoScanHours ?? 0);
  const [sched, setSched] = useState<SchedulerStatus | null>(null);
  const [autoMsg, setAutoMsg] = useState("");

  useEffect(() => { api.channels().then(setChannels).catch(() => {}); api.builds().then(setHistory).catch(() => {}); }, []);
  useEffect(() => { if (config) { setAuto(config.autoBuild); setIntervalMin(config.buildIntervalMin); setThreshold(config.refreshThresholdHours); setScanHours(config.autoScanHours); } }, [config]);
  useEffect(() => {
    const load = () => api.scheduler().then(setSched).catch(() => {});
    load(); const t = window.setInterval(load, 5000); return () => clearInterval(t);
  }, []);
  useEffect(() => () => { if (poll.current) clearInterval(poll.current); }, []);

  const run = async (rebuild = false) => {
    if (running) return;
    setRunning(true);       // immediate feedback — before the network round-trip
    setJob(null);
    try {
      const { jobId } = await api.build(channel, days, rebuild);
      if (poll.current) clearInterval(poll.current);
      poll.current = window.setInterval(async () => {
        const j = await api.job(jobId); setJob(j);
        if (j.status === "done" || j.status === "error") { clearInterval(poll.current!); setRunning(false); api.builds().then(setHistory); }
      }, 1000);
    } catch (e) {
      setRunning(false);
      setJob({ id: "-", status: "error", log: [`Failed to start build: ${(e as Error).message}`], results: [] } as any);
    }
  };

  const saveAuto = async () => {
    await api.setConfig({ autoBuild: auto, buildIntervalMin: interval, refreshThresholdHours: threshold, autoScanHours: scanHours });
    setAutoMsg("Saved ✓"); setTimeout(() => setAutoMsg(""), 1500);
    api.scheduler().then(setSched).catch(() => {});
  };
  const topUpNow = async () => { setAutoMsg("Running…"); const s = await api.schedulerRun(); setSched(s); setAutoMsg("Top-up ran ✓"); api.builds().then(setHistory); setTimeout(() => setAutoMsg(""), 2000); };

  return (
    <section className="screen">
      <h1>Build</h1>
      <p className="muted">Turn channel schedules into playouts ErsatzTV next can stream. Auto-build keeps every channel {days} days ahead on its own; build by hand after changing a channel.</p>
      {!config?.etvDbPath && <p className="bad">No database configured. Set it on the Settings page first.</p>}

      <div className="card">
        <div className="card-head"><h2>Build now</h2></div>
        <div className="row">
          <label style={{ flex: 2 }}>Channel
            <select value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="__all__">All channels</option>
              {channels.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          </label>
          <label>Days ahead<input type="number" value={days} onChange={(e) => setDays(Number(e.target.value))} /></label>
        </div>
        <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>Times follow <b>{String(config?.tz ?? "this machine's time zone")}</b>, daylight saving included. Change it on the Settings page.</p>
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="primary" onClick={() => run(false)} disabled={!config?.etvDbPath || running}>
            {running ? <><span className="spinner" style={{ marginRight: 6 }} />Building…</> : "Build"}
          </button>
          <button onClick={() => run(true)} disabled={!config?.etvDbPath || running}
            title="Delete this channel's existing playout windows and regenerate them all from scratch">
            Rebuild from scratch
          </button>
        </div>
        {running && !job && <p className="muted" style={{ marginBottom: 0 }}><span className="spinner" style={{ marginRight: 6 }} />Starting build…</p>}
        {job && (
          <div style={{ marginTop: 14 }}>
            <div className="job-head"><span className={`dot ${job.status === "error" ? "err" : job.status === "done" ? "ok" : "warn"}`} />Job {job.id}: {job.status}</div>
            <pre className="log">{job.log.join("\n")}</pre>
            {job.results.length > 0 && (
              <table>
                <thead><tr><th>Channel</th><th>Items</th><th>Result</th></tr></thead>
                <tbody>{job.results.map((r, i) => <tr key={i}><td>{r.channel}</td><td className="num">{r.itemCount ?? "–"}</td><td className={r.error ? "err" : "ok"}>{r.error ?? "done"}</td></tr>)}</tbody>
              </table>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <label className="switch"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-build (keep {days} days ahead)</label>
          <span className={`pill ${sched?.enabled ? "on" : "off"}`}>{sched?.enabled ? "running" : "off"}</span>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>Checks each channel's coverage on a timer and adds a new window when it runs short. It never rewrites what's airing now.</p>
        <div className="row">
          <label>Check every (min)<input type="number" value={interval} onChange={(e) => setIntervalMin(Number(e.target.value))} /></label>
          <label>Top up when short by (hours)<input type="number" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} /></label>
          <label>Rescan libraries every (hours, 0 = off)<input type="number" value={scanHours} onChange={(e) => setScanHours(Number(e.target.value))} /></label>
        </div>
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="primary" onClick={saveAuto}>Save automation</button>
          <button onClick={topUpNow} disabled={!config?.etvDbPath}>Run top-up now</button>
          {autoMsg && <span className="ok">{autoMsg}</span>}
          {sched?.lastTick && <span className="muted">last check {new Date(sched.lastTick).toLocaleTimeString()}{sched.nextTickAt ? ` · next ${new Date(sched.nextTickAt).toLocaleTimeString()}` : ""}</span>}
        </div>
        {sched?.log && sched.log.length > 0 && (
          <details style={{ marginTop: 12 }}>
            <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>Auto-build log ({sched.log.length} lines)</summary>
            <pre className="log" style={{ marginTop: 8 }}>{sched.log.join("\n")}</pre>
          </details>
        )}
      </div>

      <div className="card">
        <div className="card-head"><h2>Recent builds</h2></div>
        {history.length === 0 ? <p className="muted empty-note">No builds yet.</p> : (
          <table className="history">
            <thead><tr><th>Channel</th><th>Status</th><th className="num">Items</th><th>Started</th></tr></thead>
            <tbody>{history.map((b) => <tr key={b.id}><td>{b.channel}</td><td><span className={`dot ${b.status === "error" ? "err" : b.status === "done" ? "ok" : "warn"}`} /> <span className={b.status === "error" ? "err" : ""}>{b.status}</span></td><td className="num">{b.item_count ?? "–"}</td><td className="muted num">{b.started_at ? new Date(b.started_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}</td></tr>)}</tbody>
          </table>
        )}
      </div>
    </section>
  );
}
