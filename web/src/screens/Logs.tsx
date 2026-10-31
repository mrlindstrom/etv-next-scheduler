import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";

// Every line is "<ISO timestamp> [source] message". Sources: server (the
// scheduler's own console, incl. startup), scheduler (automation), next
// (ErsatzTV next), scan / deep-scan / import (library jobs), build, guide /
// ffmpeg (guide-stream), sqlite, search … — whatever tag the line carries.
const TAG = /^\[([^\]]{1,32})\]/;
const sourceOf = (rest: string) => TAG.exec(rest)?.[1] ?? "other";
const isProblem = (l: string) => /\b(error|failed|failure|exception|warn(ing)?|not found|missing|crash(ed)?|unreachable)\b|⚠/i.test(l);

// Colour a line by its source; problems override.
const SOURCE_COLOR: Record<string, string> = {
  server: "#cfd8dc", scheduler: "#b39ddb", next: "#80cbc4", scan: "#90caf9", "deep-scan": "#90caf9",
  import: "#90caf9", build: "#80d8ff", guide: "#c5e1a5", ffmpeg: "#ff8a80", sqlite: "#a5d6a7",
};
const colorFor = (line: string, source: string) => (isProblem(line) ? "#ffb74d" : SOURCE_COLOR[source] ?? "#cfd8dc");

export function Logs() {
  const [lines, setLines] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [source, setSource] = useState("all");
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [live, setLive] = useState(true);
  const [err, setErr] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const load = async () => {
    try { const r = await api.logs(3000); setLines(r.lines); setErr(""); }
    catch (e) { setErr((e as Error).message); }
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [live]);

  // keep pinned to the bottom while the user is already at the bottom
  useEffect(() => {
    const el = boxRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [lines, source, filter, problemsOnly]);

  const onScroll = () => {
    const el = boxRef.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const parsed = useMemo(() => lines.map((l) => {
    const sp = l.indexOf(" ");
    const ts = sp > 0 ? l.slice(0, sp) : "";
    const rest = sp > 0 ? l.slice(sp + 1) : l;
    return { l, ts, rest, src: sourceOf(rest) };
  }), [lines]);
  const sources = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of parsed) counts.set(p.src, (counts.get(p.src) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [parsed]);

  const q = filter.toLowerCase();
  const shown = parsed.filter((p) => (source === "all" || p.src === source) && (!problemsOnly || isProblem(p.rest)) && (!q || p.l.toLowerCase().includes(q)));

  return (
    <section className="screen">
      <h1>Logs</h1>
      <p className="muted">Everything the scheduler and ErsatzTV next log: startup, automation, scans, builds, ErsatzTV next, and the guide channel. Newest at the bottom.</p>
      <div className="row" style={{ alignItems: "center", gap: 12 }}>
        <label style={{ flex: 2 }}>Filter<input value={filter} placeholder="e.g. poster, ffmpeg, Nick" onChange={(e) => setFilter(e.target.value)} /></label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 18 }}>
          <input type="checkbox" checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} style={{ width: "auto" }} /> Errors &amp; warnings only
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 18 }}>
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} style={{ width: "auto" }} /> Live (3s)
        </label>
        <button style={{ marginTop: 14 }} onClick={load}>Refresh</button>
        <button style={{ marginTop: 14 }} onClick={async () => { await api.clearLogs().catch(() => {}); load(); }}>Clear</button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10, fontSize: 12 }}>
        {[["all", parsed.length] as [string, number], ...sources].map(([s, n]) => (
          <button key={s} onClick={() => setSource(s)} aria-pressed={source === s} className={source === s ? "primary" : ""}
            style={{ padding: "2px 10px", fontSize: 12, borderLeft: s !== "all" ? `3px solid ${SOURCE_COLOR[s] ?? "#cfd8dc"}` : undefined }}>
            {s} <span className="muted">{n}</span>
          </button>
        ))}
      </div>
      {err && <p className="muted" style={{ color: "#ff8a80" }}>Couldn't load logs: {err}</p>}
      <div
        ref={boxRef}
        onScroll={onScroll}
        style={{
          marginTop: 12, height: "62vh", overflow: "auto", background: "#0b0f17",
          border: "1px solid #223", borderRadius: 8, padding: "10px 12px",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: 12.5, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}
      >
        {shown.length === 0 && <div className="muted">{lines.length ? "No lines match the current filters." : "No log lines yet."}</div>}
        {shown.map((p, i) => {
          const t = p.ts.match(/T(\d{2}:\d{2}:\d{2})/); // HH:MM:SS (UTC) from the ISO stamp
          const local = t ? new Date(p.ts).toLocaleTimeString([], { hour12: false }) : p.ts;
          return (
            <div key={i} style={{ color: colorFor(p.rest, p.src) }}>
              <span style={{ color: "#5c6b7a" }} title={p.ts}>{local}</span>  {p.rest}
            </div>
          );
        })}
      </div>
    </section>
  );
}
