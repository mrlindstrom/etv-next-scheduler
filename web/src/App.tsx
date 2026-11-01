import { useEffect, useState } from "react";
import { Connect } from "./screens/Connect.js";
import { Library } from "./screens/Library.js";
import { Browse } from "./screens/Browse.js";
import { Collections } from "./screens/Collections.js";
import { Channels } from "./screens/Channels.js";
import { Pods } from "./screens/Pods.js";
import { Overlays } from "./screens/Overlays.js";
import { BuildScreen } from "./screens/Build.js";
import { Preview } from "./screens/Preview.js";
import { Streaming } from "./screens/Streaming.js";
import { Logs } from "./screens/Logs.js";
import { Dashboard } from "./screens/Dashboard.js";
import { Troubleshoot } from "./screens/Troubleshoot.js";
import { api, type AppConfig } from "./api.js";
import { NAV_GROUPS, PAGES, PAGE_ALIASES, navigate, type Page } from "./nav.js";

const DEFAULT_PAGE: Page = "dashboard";
const toPage = (s: string): Page | null => {
  const p = s.replace(/^\/+|\/+$/g, "").toLowerCase();
  return PAGES.includes(p as Page) ? (p as Page) : PAGE_ALIASES[p] ?? null;
};
const pageFromPath = (): Page => toPage(window.location.pathname) ?? DEFAULT_PAGE;

export function App() {
  const [page, setPage] = useState<Page>(pageFromPath);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [visit, setVisit] = useState(0);

  // keep the URL in sync with the active page (so refresh / deep-link works)
  const go = (p: Page, search = "") => {
    setPage(p); setNavOpen(false);
    if (window.location.pathname !== `/${p}` || window.location.search !== search) window.history.pushState({}, "", `/${p}${search}`);
    setVisit((v) => v + 1); // remount the page so it picks up the new query
    window.scrollTo(0, 0);
  };
  useEffect(() => {
    const onPop = () => setPage(pageFromPath());
    const onNav = (e: Event) => { const d = (e as CustomEvent).detail; const p = toPage(String(d.page)); if (p) go(p, d.search ?? ""); };
    window.addEventListener("popstate", onPop);
    window.addEventListener("tvn:navigate", onNav);
    // normalize the initial URL (e.g. "/" -> "/dashboard") without adding history
    window.history.replaceState({}, "", `/${pageFromPath()}${window.location.search}`);
    return () => { window.removeEventListener("popstate", onPop); window.removeEventListener("tvn:navigate", onNav); };
  }, []);

  useEffect(() => { api.getConfig().then(setConfig).catch(() => {}); }, []);
  const [ver, setVer] = useState<Awaited<ReturnType<typeof api.version>> | null>(null);
  useEffect(() => {
    const load = () => api.version().then(setVer).catch(() => {});
    load(); const t = window.setInterval(load, 10 * 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className={`app ${navOpen ? "nav-open" : ""}`}>
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">TV</span><span>Next Scheduler</span></div>
        <nav>
          {NAV_GROUPS.map((g) => (
            <div className="nav-group" key={g.label || "home"}>
              {g.label && <div className="nav-label">{g.label}</div>}
              {g.items.map((i) => (
                <a key={i.id} href={`/${i.id}`} className={`nav-item ${page === i.id ? "active" : ""}`}
                  onClick={(e) => { if (e.ctrlKey || e.metaKey || e.shiftKey) return; e.preventDefault(); go(i.id); }}>
                  <span className="nav-icon" aria-hidden>{i.icon}</span>{i.label}
                </a>
              ))}
            </div>
          ))}
        </nav>
        {config?.legacyImport !== false && config?.etvDbPath && (
          <div className="sidebar-foot">
            <span className="dot ok" />
            <span title={config.etvDbPath}>{basename(config.etvDbPath)}</span>
          </div>
        )}
        <a className={`sidebar-foot sidebar-version${config?.legacyImport !== false && config?.etvDbPath ? " tight" : ""}`} href="/settings"
          onClick={(e) => { if (e.ctrlKey || e.metaKey || e.shiftKey) return; e.preventDefault(); go("settings"); }}
          title={ver?.commit ? `${ver.commit.subject}\n${new Date(ver.commit.date).toLocaleString()}\nSettings → Scheduler updates` : "Settings → Scheduler updates"}>
          <span>{ver?.version ? `v${ver.version}` : "tv-next-scheduler"}{ver?.commit && <> · <code>{ver.commit.sha.slice(0, 7)}</code></>}</span>
          {!!ver?.behind && <span className="pill on" style={{ marginLeft: "auto" }}>{ver.behind} new</span>}
        </a>
      </aside>
      <div className="topbar">
        <button className="nav-toggle" onClick={() => setNavOpen((v) => !v)} aria-label="Menu">☰</button>
        <div className="brand"><span className="brand-mark">TV</span><span>Next Scheduler</span></div>
      </div>
      <div className="nav-scrim" onClick={() => setNavOpen(false)} />
      <main key={`${page}:${visit}`}>
        {page === "dashboard" && <Dashboard config={config} />}
        {page === "settings" && <Connect config={config} onSaved={setConfig} />}
        {page === "library" && <Library />}
        {page === "browse" && <Browse />}
        {page === "collections" && <Collections />}
        {page === "pods" && <Pods />}
        {page === "overlays" && <Overlays />}
        {page === "channels" && <Channels onNavigate={(t) => navigate(t)} />}
        {page === "streaming" && <Streaming />}
        {page === "build" && <BuildScreen config={config} />}
        {page === "preview" && <Preview />}
        {page === "logs" && <Logs />}
        {page === "troubleshoot" && <Troubleshoot />}
      </main>
    </div>
  );
}

function basename(p: string) { return p.split(/[\\/]/).pop() ?? p; }
