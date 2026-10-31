// Home page: what state everything is in, and what to do next.
import { useEffect, useState } from "react";
import { api, logoSrc, type AppConfig, type ChannelSummary, type LibraryStatus, type NextRunnerStatus, type SchedulerStatus } from "../api.js";
import { navigate, type Page } from "../nav.js";

type Step = { tone: "warn" | "err" | "info"; text: string; action: string; page: Page };

export function Dashboard({ config }: { config: AppConfig | null }) {
  const [channels, setChannels] = useState<ChannelSummary[] | null>(null);
  const [coverage, setCoverage] = useState<Record<string, string | null> | null>(null); // null = unknown (older server)
  const [runner, setRunner] = useState<NextRunnerStatus | null>(null);
  const [sched, setSched] = useState<SchedulerStatus | null>(null);
  const [lib, setLib] = useState<LibraryStatus | null>(null);
  const [builds, setBuilds] = useState<any[]>([]);

  useEffect(() => {
    const load = () => {
      api.channels().then(setChannels).catch(() => setChannels([]));
      api.coverage().then(setCoverage).catch(() => setCoverage(null));
      api.nextRunner().then(setRunner).catch(() => {});
      api.scheduler().then(setSched).catch(() => {});
      api.builds().then(setBuilds).catch(() => {});
    };
    load();
    api.libraryStatus().then(setLib).catch(() => {});
    const t = window.setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const now = Date.now();
  const days = config?.days ?? 3;
  const list = channels ?? [];
  const enabled = list.filter((c) => c.meta?.enabled !== false);
  const invalid = list.filter((c) => !c.valid);
  const known = coverage != null;
  // playout folders can differ in case from the channel name (Windows folders ignore case)
  const coverageByName = new Map(Object.entries(coverage ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const hoursLeft = (c: ChannelSummary) => { const f = coverageByName.get(c.name.toLowerCase()); return f ? (Date.parse(f) - now) / 3_600_000 : -1; };
  const unbuilt = known ? enabled.filter((c) => c.valid && hoursLeft(c) <= 0) : [];
  const short = !known ? [] : enabled.filter((c) => c.valid && hoursLeft(c) > 0 && hoursLeft(c) < 24);

  const steps: Step[] = [];
  if (runner && !runner.binaryFound) steps.push({ tone: "warn", text: "ErsatzTV next isn't installed yet. It's what streams your channels.", action: "Install it", page: "streaming" });
  const emptyLibrary = !!lib && !lib.imported && !lib.stats;
  if (emptyLibrary) steps.push({ tone: "warn", text: "Your media library is empty. Add a Plex, Jellyfin or Emby server, or a local folder, and scan it.", action: "Open library", page: "library" });
  if (emptyLibrary && config && config.legacyImport !== false && !config.etvDbPath) steps.push({ tone: "info", text: "Coming from ErsatzTV legacy? Point Settings at its database to import your library and channels.", action: "Open settings", page: "settings" });
  if (channels && list.length === 0) steps.push({ tone: "info", text: "No channels yet. Create your first one.", action: "Create a channel", page: "channels" });
  if (invalid.length) steps.push({ tone: "err", text: `${plural(invalid.length, "channel")} ha${invalid.length === 1 ? "s" : "ve"} a config error: ${names(invalid)}.`, action: "Fix channels", page: "channels" });
  if (unbuilt.length) steps.push({ tone: "warn", text: `${plural(unbuilt.length, "channel")} ha${unbuilt.length === 1 ? "s" : "ve"} nothing scheduled right now: ${names(unbuilt)}.`, action: "Build", page: "build" });
  if (short.length) steps.push({ tone: "info", text: `${plural(short.length, "channel")} ha${short.length === 1 ? "s" : "ve"} less than a day scheduled: ${names(short)}.`, action: "Build", page: "build" });
  if (sched && !sched.enabled && list.length) steps.push({ tone: "info", text: `Auto-build is off, so schedules won't extend past ${days} days on their own.`, action: "Turn on auto-build", page: "build" });
  if (runner && runner.stale && runner.phase === "running") steps.push({ tone: "warn", text: "ErsatzTV next is running with an old lineup. Restart it to pick up changes.", action: "Open streaming", page: "streaming" });
  if (runner && runner.enabled && runner.phase !== "running" && runner.phase !== "starting") steps.push({ tone: "err", text: `ErsatzTV next is ${runner.phase}${runner.detail ? `: ${runner.detail}` : ""}.`, action: "Open streaming", page: "streaming" });

  const runnerTone = !runner ? "" : runner.phase === "running" ? (runner.stale ? "warn" : "ok") : runner.phase === "starting" || runner.phase === "waiting" ? "warn" : "err";

  return (
    <section className="screen">
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">How your channels, library and stream server are doing.</p>
        </div>
      </div>

      <div className="tiles">
        <Tile label="Channels" value={channels ? String(enabled.length) : "…"} sub={channels ? `${list.length - enabled.length} disabled${invalid.length ? ` · ${invalid.length} with errors` : ""}` : ""} onClick={() => navigate("channels")} tone={invalid.length ? "err" : ""} />
        <Tile label="Scheduled ahead" value={!channels ? "…" : known ? `${enabled.length - unbuilt.length}/${enabled.length}` : "–"} sub={!known ? (channels ? "restart the scheduler to see this" : "") : unbuilt.length ? `${unbuilt.length} with nothing on now` : "every channel is on air"} onClick={() => navigate("build")} tone={!known ? "" : unbuilt.length ? "warn" : "ok"} />
        <Tile label="Stream server" value={runner ? cap(runner.phase) : "…"} sub={runner ? (runner.phase === "running" ? `up ${uptime(runner.uptimeSec)}${runner.stale ? " · restart needed" : ""}` : runner.detail || "") : ""} onClick={() => navigate("streaming")} tone={runnerTone} />
        <Tile label="Auto-build" value={sched ? (sched.enabled ? "On" : "Off") : "…"} sub={sched?.lastTick ? `checked ${new Date(sched.lastTick).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : `keeps ${days} days ahead`} onClick={() => navigate("build")} tone={sched?.enabled ? "ok" : ""} />
        <Tile label="Media items" value={lib?.stats ? lib.stats.mediaItems.toLocaleString() : lib ? "0" : "…"} sub={lib?.stats ? `${lib.stats.shows.toLocaleString()} shows · ${lib.stats.episodes.toLocaleString()} episodes` : lib ? "nothing scanned yet" : ""} onClick={() => navigate("library")} />
      </div>

      <div className="dash-grid">
        <div className="card">
          <div className="card-head"><h2>Next steps</h2></div>
          {steps.length === 0
            ? <p className="muted empty-note">✓ Nothing needs attention{known ? ". Every channel is built and the stream server is up." : "."}</p>
            : <ul className="steps">{steps.map((s, i) => (
                <li key={i} className={`step ${s.tone}`}>
                  <span className="step-text">{s.text}</span>
                  <button onClick={() => navigate(s.page)}>{s.action} →</button>
                </li>
              ))}</ul>}
        </div>

        <div className="card">
          <div className="card-head"><h2>Recent builds</h2><button className="ghost" onClick={() => navigate("build")}>All builds →</button></div>
          {builds.length === 0 ? <p className="muted empty-note">No builds yet.</p> : (
            <table className="compact">
              <tbody>{builds.slice(0, 8).map((b) => (
                <tr key={b.id}>
                  <td><span className={`dot ${b.status === "error" ? "err" : b.status === "done" ? "ok" : "warn"}`} /> {b.channel}</td>
                  <td className="muted num">{b.item_count ?? "–"} items</td>
                  <td className="muted num">{ago(b.started_at)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </div>

      {list.length > 0 && (
        <div className="card">
          <div className="card-head"><h2>Channels</h2><button className="ghost" onClick={() => navigate("channels")}>Manage →</button></div>
          <div className="chan-grid">
            {[...list].sort((a, b) => Number(a.meta?.number ?? 0) - Number(b.meta?.number ?? 0)).map((c) => {
              const h = hoursLeft(c), off = c.meta?.enabled === false;
              const state = !c.valid ? "err" : off ? "off" : !known ? "" : h <= 0 ? "warn" : h < 24 ? "info" : "ok";
              const label = !c.valid ? "config error" : off ? "disabled" : !known ? (c.mode ?? "") : h <= 0 ? "not built" : `${h >= 48 ? `${Math.floor(h / 24)} days` : `${Math.floor(h)} h`} ahead`;
              const src = logoSrc(c.meta?.logo);
              return (
                <button key={c.name} className={`chan-tile ${state}`} onClick={() => navigate("channels", { c: c.name })} title={c.name}>
                  <div className="chan-logo">{src ? <img src={src} alt="" loading="lazy" /> : <span>{c.name.slice(0, 3)}</span>}</div>
                  <div className="chan-info">
                    <div className="chan-name"><span className="chnum">{c.meta?.number}</span> {c.name}</div>
                    <div className={`chan-state ${state}`}>{label}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function Tile({ label, value, sub, onClick, tone = "" }: { label: string; value: string; sub?: string; onClick?: () => void; tone?: string }) {
  return (
    <button className={`tile ${tone}`} onClick={onClick}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </button>
  );
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const names = (cs: ChannelSummary[]) => cs.slice(0, 4).map((c) => c.name).join(", ") + (cs.length > 4 ? ` and ${cs.length - 4} more` : "");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const uptime = (sec: number) => sec < 3600 ? `${Math.max(1, Math.round(sec / 60))} min` : sec < 172800 ? `${Math.round(sec / 3600)} h` : `${Math.round(sec / 86400)} days`;
function ago(iso?: string) {
  if (!iso) return "";
  const t = Date.parse(iso.includes("Z") || /[+-]\d\d:?\d\d$/.test(iso) ? iso : iso.replace(" ", "T") + "Z");
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}
