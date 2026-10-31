// Library tab: the search index's state (ready / rebuilding / updating), size,
// last activity, and a Rebuild button. Polls quickly while it's busy.
import { useEffect, useRef, useState } from "react";
import { api, type IndexStatus } from "../api.js";

const ago = (iso?: string) => {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleString();
};

export function SearchIndexCard() {
  const [st, setSt] = useState<IndexStatus | null>(null);
  const [asked, setAsked] = useState(false);
  const timer = useRef<number | null>(null);
  const busy = !!st && ["checking", "rebuilding", "updating"].includes(st.phase);

  const load = () => api.indexStatus().then(setSt).catch(() => {});
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = window.setInterval(load, busy ? 1500 : 10000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [busy]);

  const rebuild = async () => {
    if (!confirm("Rebuild the search index from scratch?\n\nSearches and builds keep working meanwhile (using the current index); it takes about 15–30 seconds.")) return;
    setAsked(true); setSt(await api.rebuildIndex()); setTimeout(load, 500);
  };

  if (!st) return null;
  const label = st.phase === "off" ? "Not built (no library yet)"
    : st.phase === "checking" ? "Checking…"
    : st.phase === "rebuilding" ? `Rebuilding…${st.detail ? ` (${st.detail})` : ""}`
    : st.phase === "updating" ? `Updating ${st.detail ?? ""}…`
    : st.phase === "error" ? "Error"
    : "Ready";
  const elapsed = busy && st.since ? ` — ${Math.round((Date.now() - st.since) / 1000)}s` : "";
  return (
    <div className="meta-card">
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <b>Search index</b>
        <span className={st.phase === "error" ? "err" : busy ? "" : "ok"}>{busy && <span className="spinner" />} {label}{elapsed}</span>
        {st.docs != null && st.phase !== "off" && <span className="muted">{st.docs.toLocaleString()} documents</span>}
        {st.updatedAt && <span className="muted">· updated {ago(st.updatedAt)}</span>}
        <span style={{ marginLeft: "auto" }}><button onClick={rebuild} disabled={busy || st.phase === "off"}>Rebuild search index</button></span>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
        What searches, smart collections and channel builds read. It's checked when the server starts (and rebuilt if it's missing,
        damaged or out of date) and updated automatically after scans and library changes — rebuild it by hand only if results look wrong.
        {st.last && <> Last {st.last.kind === "rebuild" ? "rebuild" : "update"}: {st.last.docs.toLocaleString()} document{st.last.docs === 1 ? "" : "s"}{st.last.removed ? `, ${st.last.removed} removed` : ""} in {st.last.ms < 1000 ? `${st.last.ms}ms` : `${(st.last.ms / 1000).toFixed(1)}s`}, {ago(st.last.at)}.</>}
      </p>
      {st.phase === "error" && <p className="err" style={{ fontSize: 12, margin: "4px 0 0" }}>{st.error} — see the Logs page ([index]).</p>}
      {asked && !busy && st.last?.kind === "rebuild" && <p className="ok" style={{ fontSize: 12, margin: "4px 0 0" }}>Rebuilt ✓</p>}
    </div>
  );
}
