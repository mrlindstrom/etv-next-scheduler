import { useEffect, useState } from "react";
import { navigate } from "../nav.js";
import { compareChannelNumbers } from "../channelNumbers.js";
import { api, errText, type ChannelSummary, type EasConfig, type EasStatus } from "../api.js";

const SEVERITY_CHOICES: [EasConfig["minSeverity"], string][] = [
  ["Extreme", "Extreme only (e.g. tornado warnings with a confirmed tornado)"],
  ["Severe", "Severe and up: warnings (tornado, severe thunderstorm, flash flood…)"],
  ["Moderate", "Moderate and up: adds watches and many advisories"],
  ["Minor", "Everything, including minor advisories"],
];

const ago = (ms: number | null) => { if (!ms) return "never"; const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`; };

/** Output → Emergency alerts: NWS alerts drawn over alert-enabled channels. */
export function Alerts() {
  const [cfg, setCfg] = useState<EasConfig | null>(null);
  const [saved, setSaved] = useState<EasConfig | null>(null);
  const [st, setSt] = useState<EasStatus | null>(null);
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [previewKey, setPreviewKey] = useState(0);
  const [needsRebuild, setNeedsRebuild] = useState(false);
  const [testMin, setTestMin] = useState(2);

  const load = () => api.eas().then((r) => { setCfg((c) => c ?? r.config); setSaved(r.config); setSt(r.status); }).catch((e) => setErr(errText(e)));
  useEffect(() => {
    load();
    api.channels().then((cs) => setChannels(cs.filter((c) => c.mode !== "remote").sort((a, b) => compareChannelNumbers(a.meta?.number ?? "", b.meta?.number ?? "")))).catch(() => {});
    const t = window.setInterval(() => api.eas().then((r) => { setSt(r.status); setSaved(r.config); }).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, []);

  if (!cfg || !saved) return <section className="screen"><h1>Emergency alerts</h1><p className="muted">{err || "Loading…"}</p></section>;
  const set = (p: Partial<EasConfig>) => { setCfg({ ...cfg, ...p }); setMsg(""); setErr(""); };
  const dirty = JSON.stringify(cfg) !== JSON.stringify(saved);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setErr(""); setMsg("");
    try { await fn(); } catch (e) { setErr(errText(e)); } finally { setBusy(""); }
  };
  const save = () => run("save", async () => {
    const turnedOn = cfg.enabled && !saved.enabled;
    const r = await api.saveEas(cfg);
    setCfg(r.config); setSaved(r.config); setSt(r.status); setPreviewKey((k) => k + 1);
    if (turnedOn || cfg.position !== saved.position || cfg.streamPort !== saved.streamPort) setNeedsRebuild(true);
    setMsg("Saved.");
  });
  const findPlace = (lat = cfg.lat, lon = cfg.lon) => run("place", async () => {
    if (lat === null || lon === null) throw new Error("Enter a latitude and longitude first.");
    const r = await api.easPlace(lat, lon);
    setCfg((c) => c && { ...c, lat, lon, place: r.place });
  });
  const useDevice = () => {
    setErr("");
    if (!navigator.geolocation) { setErr("This browser can't share its location."); return; }
    setBusy("locate");
    navigator.geolocation.getCurrentPosition(
      (p) => { setBusy(""); const lat = Math.round(p.coords.latitude * 10000) / 10000, lon = Math.round(p.coords.longitude * 10000) / 10000; void findPlace(lat, lon); },
      (e) => { setBusy(""); setErr(`Couldn't get this device's location: ${e.message}`); },
      { timeout: 15000 },
    );
  };
  const setChannel = async (name: string, on: boolean) => {
    setChannels((cs) => cs.map((c) => (c.name === name && c.meta ? { ...c, meta: { ...c.meta, eas: on } } : c)));
    try { await api.setChannelMeta(name, { eas: on }); setNeedsRebuild(true); } catch (e) { setErr(errText(e)); }
  };
  const setAll = async (on: boolean) => {
    for (const c of channels) if ((c.meta?.eas !== false) !== on) await setChannel(c.name, on);
  };

  const testing = !!st?.testUntil && st.testUntil > Date.now();
  const onChannels = channels.filter((c) => c.meta?.eas !== false).length;
  const streamOrphaned = !saved.enabled && saved.keepStream && st?.stream.running;

  return (
    <section className="screen">
      <h1>Emergency alerts</h1>
      <p className="muted">
        Checks the National Weather Service for alerts at your location and shows them as a banner over whatever is playing on your
        channels. Nothing is rebuilt when an alert comes in: alert-enabled channels carry an alert layer that's see-through until
        there's something to show. Expect about a minute from the alert being issued to it appearing on a TV, because ErsatzTV next
        prepares video ahead of what viewers see. United States only. The banner has no sound.
      </p>

      {err && <p className="err">⚠ {err}</p>}
      {needsRebuild && saved.enabled && (
        <div className="card" style={{ marginBottom: 16, borderColor: "#f59e0b" }}>
          <b>Rebuild your channels</b> so their playouts carry (or drop) the alert layer. Until then, channels keep what they were built with.
          <div className="actions" style={{ marginTop: 8 }}><button className="primary" onClick={() => navigate("build")}>Go to Build</button></div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Settings</h2>
          <span className={`pill ${saved.enabled ? "on" : "off"}`}>{saved.enabled ? "On" : "Off"}</span>
        </div>
        <div className="form" style={{ marginTop: 0 }}>
          <label className="switch"><input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Show emergency alerts on channels</label>

          <div className="row">
            <label>Latitude<input type="number" step="0.0001" value={cfg.lat ?? ""} placeholder="33.2148" onChange={(e) => set({ lat: e.target.value === "" ? null : Number(e.target.value), place: "" })} /></label>
            <label>Longitude<input type="number" step="0.0001" value={cfg.lon ?? ""} placeholder="-97.1331" onChange={(e) => set({ lon: e.target.value === "" ? null : Number(e.target.value), place: "" })} /></label>
          </div>
          <div className="actions" style={{ marginTop: -4 }}>
            <button onClick={() => findPlace()} disabled={!!busy || cfg.lat === null || cfg.lon === null}>{busy === "place" ? "Checking…" : "Check this location"}</button>
            <button onClick={useDevice} disabled={!!busy || !window.isSecureContext} title={window.isSecureContext ? "" : "Browsers only share location with https:// or localhost pages"}>
              {busy === "locate" ? "Locating…" : "Use this device's location"}
            </button>
            {cfg.place && <span className="ok">✓ {cfg.place}</span>}
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>
            Alerts are looked up for this point, so it gets every alert for the zone and county it's in. To find your coordinates, right-click
            your home in Google Maps and click the numbers at the top of the menu to copy them.
            {!window.isSecureContext && <> (“Use this device's location” only works when this page is opened as <code>localhost</code> or over https.)</>}
          </p>

          <label>Alerts to show
            <select value={cfg.minSeverity} onChange={(e) => set({ minSeverity: e.target.value as EasConfig["minSeverity"] })}>
              {SEVERITY_CHOICES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            Civil alerts that officials send through the Weather Service (AMBER alerts, evacuations, shelter in place,
            law enforcement and hazardous materials warnings) always show, whatever this is set to.
          </p>
          <div className="row">
            <label>Banner position
              <select value={cfg.position} onChange={(e) => set({ position: e.target.value as EasConfig["position"] })}>
                <option value="bottom">Bottom of the screen</option>
                <option value="top">Top of the screen</option>
              </select>
            </label>
            <label>Seconds per alert when several are active<input type="number" min={5} max={60} value={cfg.rotateSec} onChange={(e) => set({ rotateSec: Number(e.target.value) })} /></label>
          </div>
          <div className="row">
            <label>Show the banner for (seconds)<input type="number" min={10} max={600} value={cfg.showSec} onChange={(e) => set({ showSec: Number(e.target.value) })} /></label>
            <label>Then hide it for (minutes)<input type="number" min={0} max={60} step={0.5} value={cfg.hideSec / 60} onChange={(e) => set({ hideSec: Math.round(Number(e.target.value) * 60) })} /></label>
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            Like a weather crawl: an alert goes on screen as soon as it comes in, comes off for a while, then comes back,
            until it ends or is cancelled. A new alert starts it over. Hide for 0 minutes to keep alerts on screen the whole time.
          </p>
          <details>
            <summary className="muted" style={{ cursor: "pointer" }}>More settings</summary>
            <div className="form">
              <div className="row">
                <label>Check every (seconds)<input type="number" min={30} max={600} value={cfg.pollSec} onChange={(e) => set({ pollSec: Number(e.target.value) })} /></label>
                <label>Alert stream port<input type="number" value={cfg.streamPort || ""} placeholder={`${st?.stream.port ?? ""} (automatic)`} onChange={(e) => set({ streamPort: Number(e.target.value) || 0 })} /></label>
              </div>
              <label>Contact for the National Weather Service (optional)
                <input value={cfg.contact} placeholder="an email address or website" onChange={(e) => set({ contact: e.target.value })} />
              </label>
              <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>
                The Weather Service asks programs that use its data to say how to reach their owner, in case something goes wrong. It's sent
                with each check, and only to them. Changing the port needs a rebuild of your channels.
              </p>
            </div>
          </details>
          <div className="actions">
            <button className="primary" onClick={save} disabled={!!busy || !dirty}>{busy === "save" ? "Saving…" : "Save"}</button>
            {msg && <span className="ok">{msg}</span>}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><h2>Status</h2></div>
        {st && <>
          <p style={{ margin: "4px 0" }}>
            <b>Weather Service:</b>{" "}
            {!saved.enabled ? <span className="muted">not checked while alerts are off</span>
              : st.poll.ok ? <>checked {ago(st.poll.at)}; {st.poll.found} active alert{st.poll.found === 1 ? "" : "s"} for this point, {st.poll.shown} on screen</>
              : <span className="err">⚠ the last check failed ({ago(st.poll.at)}): {st.poll.error}. What was on screen stays up.</span>}
          </p>
          <p style={{ margin: "4px 0" }}>
            <b>Alert stream:</b>{" "}
            {st.stream.running
              ? <>running on port {st.stream.port}; {st.stream.clients} channel stream{st.stream.clients === 1 ? "" : "s"} reading it now{!st.stream.current && " (restarting with newer code)"}</>
              : saved.enabled ? <span className="err">⚠ not running. {st.stream.error}</span> : <span className="muted">stopped</span>}
          </p>
          {streamOrphaned && (
            <p className="muted" style={{ fontSize: 13 }}>
              Alerts are off, but the alert stream keeps running because channels built with alerts still read it, and they'd freeze without it.
              Rebuild your channels first, then <button onClick={() => run("stop", async () => { const r = await api.easStopStream(); setSaved(r.config); setSt(r.status); })} disabled={!!busy}>Stop the alert stream</button>
            </p>
          )}
          {saved.enabled && !st.stream.running && st.stream.log.length > 0 && (
            <details><summary className="muted" style={{ cursor: "pointer" }}>Alert stream log</summary><pre className="log">{st.stream.log.join("\n")}</pre></details>
          )}

          <h3 style={{ marginBottom: 6 }}>On screen now</h3>
          {st.alerts.length === 0 ? <p className="muted" style={{ marginTop: 0 }}>Nothing. Channels show their programmes as usual.</p> : (
            <ul style={{ marginTop: 0 }}>
              {st.alerts.map((a) => <li key={a.id}><b>{a.event}</b> <span className="muted">({a.test ? "test" : a.severity})</span> {a.area} {a.until}</li>)}
            </ul>
          )}
          {st.cycle?.changesAt && st.alerts.length > 0 && (
            <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
              {st.cycle.on ? "Showing now" : "Hidden for now"}; {st.cycle.on ? "comes off" : "back on"} at about{" "}
              {new Date(st.cycle.changesAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })} (TVs follow about half a minute later).
            </p>
          )}
          <div className="actions">
            <button onClick={() => run("check", async () => { const r = await api.checkEas(); setSt(r.status); setPreviewKey((k) => k + 1); })} disabled={!!busy || !saved.enabled}>{busy === "check" ? "Checking…" : "Check now"}</button>
            {testing
              ? <>
                  <button onClick={() => run("test", async () => { const r = await api.easStopTest(); setSt(r.status); setPreviewKey((k) => k + 1); })} disabled={!!busy}>End the test alert</button>
                  <span className="ok">Test alert on, {Math.max(1, Math.ceil((st.testUntil! - Date.now()) / 60_000))} min left</span>
                </>
              : <>
                  <button onClick={() => run("test", async () => { const r = await api.easTest(testMin); setSt(r.status); setPreviewKey((k) => k + 1); })} disabled={!!busy || !saved.enabled}>Show a test alert</button>
                  <select value={testMin} onChange={(e) => setTestMin(Number(e.target.value))} disabled={!saved.enabled} aria-label="How long the test alert stays up">
                    {[2, 5, 15, 30].map((m) => <option key={m} value={m}>for {m} minutes</option>)}
                  </select>
                </>}
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            {saved.enabled
              ? "The test alert goes on every alert-enabled channel and comes and goes like a real one (pick a length longer than the show + hide times to see it come back). It shows on TVs within about a minute. End it any time."
              : "Turn on \"Show emergency alerts on channels\" and save to use the test alert. It doesn't need the Weather Service, so it works even while their feed is down."}
          </p>
          <h3 style={{ marginBottom: 6 }}>How the banner looks</h3>
          <img key={previewKey} src={`/api/eas/preview.png?which=current&w=1280&h=720&k=${previewKey}`} alt="Alert banner preview"
            style={{ width: "100%", maxWidth: 720, borderRadius: 6, border: "1px solid var(--line)", display: "block" }} />
          <p className="muted" style={{ fontSize: 12 }}>{st.alerts.length ? "The first alert on screen now." : "A sample (nothing is on screen now)."} It covers the {saved.position} part of the picture.</p>
        </>}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2>Channels</h2>
          <span className="muted" style={{ marginLeft: "auto" }}>{onChannels} of {channels.length} show alerts</span>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          Which channels show alerts. Changes take effect when a channel is rebuilt. Remote-stream channels aren't listed: they relay
          another service's stream as it is.
        </p>
        <div className="actions" style={{ marginBottom: 8 }}>
          <button onClick={() => setAll(true)}>All on</button>
          <button onClick={() => setAll(false)}>All off</button>
        </div>
        <div style={{ columns: "260px", columnGap: 18 }}>
          {channels.map((c) => (
            <label key={c.name} className="switch" style={{ display: "flex", fontWeight: 400, padding: "3px 0", breakInside: "avoid" }}>
              <input type="checkbox" checked={c.meta?.eas !== false} onChange={(e) => setChannel(c.name, e.target.checked)} />
              <span className="muted" style={{ minWidth: 34 }}>{c.meta?.number}</span> {c.name}
            </label>
          ))}
        </div>
      </div>
    </section>
  );
}
