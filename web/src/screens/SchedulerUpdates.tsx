// Settings → Scheduler updates: pull this app's latest version from git, build it and restart.
import { useEffect, useRef, useState } from "react";
import { api, type AppConfig, type SelfUpdateStatus } from "../api.js";

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString();
};
const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" });

export function SchedulerUpdates({ config, onSaved }: { config: AppConfig | null; onSaved: (c: AppConfig) => void }) {
  const [st, setSt] = useState<SelfUpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState("");
  const [restart, setRestart] = useState<{ boot: string; since: number; down: boolean } | null>(null);
  const restartRef = useRef(restart); restartRef.current = restart;

  const load = (refresh = false) => {
    setChecking(refresh); setErr("");
    return api.selfUpdate(refresh).then((s) => { setSt(s); return s; }).catch((e) => { setErr(String(e.message ?? e)); return null; }).finally(() => setChecking(false));
  };
  useEffect(() => { load(); }, []);

  // follow a running update, then the restart: the server goes away and comes back on the new build
  const running = st?.job?.phase === "running" || st?.job?.phase === "restarting" || !!restart;
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(async () => {
      const r = restartRef.current;
      try {
        const s = await api.selfUpdate();
        if (r && s.bootId !== r.boot) { window.location.reload(); return; } // a new server process: load the new web UI
        setSt(s);
        if (s.job?.phase === "restarting" && !r) setRestart({ boot: s.bootId, since: Date.now(), down: false });
      } catch {
        if (r) setRestart({ ...r, down: true });
      }
    }, 2000);
    return () => clearInterval(t);
  }, [running]);

  const install = async () => {
    setErr("");
    const r = await api.installSelfUpdate();
    if ("error" in r) setErr(r.error); else setSt(r);
  };
  const setMode = async (patch: Partial<AppConfig>) => { const c = await api.setConfig(patch); onSaved(c); };

  const mode = config?.selfUpdate ?? "notify", hour = config?.selfUpdateHour ?? 4;
  const job = st?.job;
  return (
    <div className="meta-card" style={{ marginTop: 18 }}>
      <div style={{ fontWeight: 700, marginBottom: 4, display: "flex", gap: 10, alignItems: "baseline" }}>
        Scheduler updates
        {st?.available && !st.behind && !job && <span className="ok" style={{ fontWeight: 400, fontSize: 13 }}>up to date ✓</span>}
        {st?.available && st.behind > 0 && <span className="pill on" style={{ marginLeft: 0 }}>{st.behind} new</span>}
      </div>
      <p className="muted" style={{ fontSize: 13, margin: "0 0 8px" }}>
        Pulls this app's latest version from git ({st?.upstream || "its remote branch"}), installs any new packages, builds it while the
        current version keeps running, then restarts into it. The restart takes a few seconds and restarts ErsatzTV next too, so viewers see a short interruption.
      </p>

      {st && !st.available && <div className="muted">Updates aren't available here: {st.reason}.</div>}
      {st?.current && (
        <div style={{ fontSize: 13, marginBottom: 6 }}>
          Running <code>{st.current.sha.slice(0, 7)}</code> {st.current.subject} <span className="muted">· {ago(st.current.date)} · branch {st.branch}</span>
        </div>
      )}
      {st && st.commits.length > 0 && (
        <ul style={{ margin: "4px 0 8px", paddingLeft: 18, fontSize: 13 }}>
          {st.commits.map((c) => <li key={c.sha}><code>{c.sha.slice(0, 7)}</code> {c.subject} <span className="muted">· {ago(c.date)}</span></li>)}
        </ul>
      )}
      {st && st.blocked.length > 0 && (
        <div className="verify bad" style={{ margin: "6px 0" }}>
          <div className="status">Local changes stop the update</div>
          <div className="muted" style={{ fontSize: 12 }}>These files were changed on this machine and the update changes them too. Commit and push them from here, or undo them (<code>git checkout -- &lt;file&gt;</code>), then check again:</div>
          <ul style={{ margin: "4px 0 0", fontSize: 12 }}>{st.blocked.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
        </div>
      )}
      {st && st.ahead > 0 && <div className="err" style={{ fontSize: 13 }}>This copy has {st.ahead} commit(s) that aren't on {st.upstream}. Push them first.</div>}
      {st && !st.underLauncher && st.available && (
        <div className="muted" style={{ fontSize: 12, margin: "4px 0" }}>⚠ The scheduler wasn't started with <code>npm run server</code>, so it can't restart itself. An update is built, then switched to the next time you start it with <code>npm run server</code>.</div>
      )}
      {st?.staged && !job && <div className="ok" style={{ fontSize: 13 }}>A built update is waiting. Restart the scheduler with <code>npm run server</code> to switch to it.</div>}

      {(job || restart) && (
        <div style={{ margin: "8px 0" }}>
          <div className={job?.phase === "failed" ? "err" : job?.phase === "staged" ? "ok" : ""}>
            {restart ? (restart.down ? "Restarting… the page reloads when the new version is up." : "Restarting…") : job!.step}
          </div>
          {running && <div className="progress"><div className="bar" style={{ width: "100%", opacity: 0.6 }} /></div>}
          {job && job.log.length > 0 && <pre className="log" style={{ maxHeight: 180, marginTop: 6 }}>{job.log.join("\n")}</pre>}
        </div>
      )}
      {(err || st?.checkError) && <div className="err" style={{ fontSize: 13, margin: "6px 0" }}>{err || `Couldn't check: ${st?.checkError}`}</div>}

      <div className="actions">
        {st?.available && (
          <button className={st.behind ? "primary" : ""} onClick={install} disabled={running || st.blocked.length > 0 || st.ahead > 0}
            title={st.behind ? "Pull, build and restart" : "Rebuild this version and restart (e.g. after pulling by hand)"}>
            {st.behind ? (st.underLauncher ? "Update and restart" : "Update") : (st.underLauncher ? "Rebuild and restart" : "Rebuild")}
          </button>
        )}
        <button onClick={() => load(true)} disabled={checking || running}>{checking ? "Checking…" : "Check now"}</button>
        {st?.checkedAt && <span className="muted" style={{ fontSize: 12 }}>checked {new Date(st.checkedAt).toLocaleTimeString()}</span>}
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <label>Automatic updates
          <select value={mode} onChange={(e) => setMode({ selfUpdate: e.target.value as AppConfig["selfUpdate"] })}>
            <option value="off">Off</option>
            <option value="notify">Check hourly, update when I click</option>
            <option value="install">Install automatically once a day</option>
          </select>
        </label>
        {mode === "install" && (
          <label>At
            <select value={hour} onChange={(e) => setMode({ selfUpdateHour: Number(e.target.value) })}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
          </label>
        )}
      </div>
      {mode === "install" && <p className="muted" style={{ fontSize: 12, margin: "2px 0 0" }}>Pick a quiet hour: the restart briefly interrupts anyone watching. Updates that local changes would block are skipped and shown here.</p>}
    </div>
  );
}
