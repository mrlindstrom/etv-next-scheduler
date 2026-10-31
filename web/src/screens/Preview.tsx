import { useEffect, useMemo, useState } from "react";
import { api, category, CATEGORY_COLORS, type PlayoutWindow, type PlayoutView, type ChannelSummary } from "../api.js";

export function Preview() {
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [channel, setChannel] = useState(() => new URLSearchParams(window.location.search).get("channel") ?? "");
  const [windows, setWindows] = useState<PlayoutWindow[]>([]);
  const [file, setFile] = useState("");
  const [view, setView] = useState<PlayoutView | null>(null);

  useEffect(() => { api.channels().then(setChannels).catch(() => {}); }, []);
  useEffect(() => { if (channel) api.playouts(channel).then((w) => { setWindows(w); setFile(w[0]?.file ?? ""); }); }, [channel]);
  useEffect(() => { if (channel && file) api.playout(channel, file).then(setView); else setView(null); }, [channel, file]);

  const items = view?.playout.items ?? [];
  const t0 = items[0] ? Date.parse(items[0].start) : 0;
  const t1 = items.length ? Date.parse(items[items.length - 1].finish) : 0;
  const totalMs = Math.max(1, t1 - t0);

  // group into ~30-min rows for a readable timeline
  const rows = useMemo(() => {
    const out: { hour: string; items: typeof items }[] = [];
    let cur: { hour: string; items: typeof items } | null = null;
    for (const it of items) {
      const hh = it.start.slice(11, 16);
      const bucket = it.start.slice(0, 13); // per hour
      if (!cur || cur.items[0].start.slice(0, 13) !== bucket) { cur = { hour: hh, items: [] }; out.push(cur); }
      cur.items.push(it);
    }
    return out;
  }, [items]);

  const legend = ["Program", "Commercial", "Bumper", "Promo", "Up Next", "Break bumper", "Transition"];

  return (
    <section className="screen">
      <h1>Preview</h1>
      <p className="muted">What a channel will actually air, hour by hour, from its built playout. Hover a block for details.</p>
      <div className="row card" style={{ alignItems: "flex-end" }}>
        <label>Channel<select value={channel} onChange={(e) => setChannel(e.target.value)}><option value="">— select —</option>{channels.map((c) => <option key={c.name}>{c.name}</option>)}</select></label>
        <label>Window<select value={file} onChange={(e) => setFile(e.target.value)}>{windows.map((w) => <option key={w.file} value={w.file}>{w.start?.slice(0, 16).replace("T", " ")} → {w.finish?.slice(0, 16).replace("T", " ")}</option>)}</select></label>
      </div>

      {view && (
        <>
          <div className="legend">{legend.map((l) => <span key={l} className="chip"><i style={{ background: CATEGORY_COLORS[l] ?? CATEGORY_COLORS.Filler }} />{l}</span>)}</div>
          <div className="summary-line">{items.length} items · {rows.length} hours · {Math.round(totalMs / 3600000)}h window · {items.filter((i) => (i.source as any)?.in_point_ms != null || (i.source as any)?.out_point_ms != null).length} mid-roll segments</div>
          <div className="timeline">
            {rows.map((r, i) => (<div key={i}>
              {(i === 0 || rows[i - 1].items[0].start.slice(0, 10) !== r.items[0].start.slice(0, 10)) &&
                <div className="tl-day">{new Date(`${r.items[0].start.slice(0, 10)}T12:00:00`).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}</div>}
              <div className="tl-row">
                <div className="tl-hour">{r.hour}</div>
                <div className="tl-bar">
                  {r.items.map((it) => {
                    const dur = Date.parse(it.finish) - Date.parse(it.start);
                    const src = it.source as any;
                    const isUpNext = (view.labels[it.id] as any)?.type === "upnext";
                    const disp = isUpNext ? "Up Next" : name(src?.path ?? "");
                    const { cat, color } = category(view.labels[it.id], disp);
                    const split = src?.in_point_ms != null || src?.out_point_ms != null;
                    return <div key={it.id} className="seg" style={{ flexGrow: Math.max(dur, 4000), background: color }}
                      title={`${it.start.slice(11, 19)}  ${cat}\n${disp}${split ? "  (mid-roll segment)" : ""}`}>
                      {dur > 120000 ? disp.slice(0, 22) : ""}
                    </div>;
                  })}
                </div>
              </div>
            </div>))}
          </div>
        </>
      )}
      {!view && channel && <p className="muted">No built windows for this channel yet — build it on the Build page.</p>}
    </section>
  );
}

function name(p: string) { return p.split(/[\\/]/).pop() ?? p; }
