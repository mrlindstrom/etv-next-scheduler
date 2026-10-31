// Playlist editor (Browse): a playlist is an ordered list of entries that plays
// top to bottom and loops, ErsatzTV-legacy style. Each entry (a collection, a
// show/season, or one movie/episode) takes its turn for one item, N items, or
// all of them, in its own play order. Drag rows (or use the arrows) to reorder.
import { useEffect, useRef, useState } from "react";
import { api, type CollectionInfo, type PlaylistDetail, type PlaylistEntryInfo } from "../api.js";

const ORDERS: [string, string][] = [["chronological", "In order"], ["shuffle", "Shuffle"], ["random", "Random"], ["season_episode", "Season / episode"], ["shuffle_in_order", "Shuffle, keep order"]];
const KIND: Record<string, string> = { collection: "collection", smart: "smart", multi: "multi", item: "item" };
const fmt = (ms: number) => { const s = Math.round(ms / 1000), m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s % 60).padStart(2, "0")}`; };

export function PlaylistEditor({ id, onChanged }: { id: number; onChanged?: () => void }) {
  const [pl, setPl] = useState<PlaylistDetail | null>(null);
  const [err, setErr] = useState("");
  const [colls, setColls] = useState<CollectionInfo[]>([]);
  const [pick, setPick] = useState("");
  const [preview, setPreview] = useState<{ title: string; entry: string; durationMs: number; inGuide: boolean }[] | null>(null);
  const drag = useRef<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  const load = async () => {
    const r = await api.playlist(id);
    if ("error" in r) { setErr(r.error); return; }
    setErr(""); setPl(r);
    api.playlistPreview(id, 24).then((p) => setPreview(p.items)).catch(() => setPreview(null));
  };
  useEffect(() => { setPl(null); setPreview(null); load(); api.collections().then((c) => setColls(c.filter((x) => x.type !== "playlist"))).catch(() => {}); }, [id]);

  const changed = () => { load(); onChanged?.(); };
  const update = async (e: PlaylistEntryInfo, patch: Partial<PlaylistEntryInfo>) => {
    setPl((p) => p && { ...p, entries: p.entries.map((x) => (x.id === e.id ? { ...x, ...patch } : x)) }); // instant feedback
    await api.updatePlaylistEntry(id, e.id, patch);
    api.playlistPreview(id, 24).then((p) => setPreview(p.items)).catch(() => {});
  };
  const reorder = async (ids: number[]) => {
    setPl((p) => p && { ...p, entries: ids.map((i) => p.entries.find((x) => x.id === i)!).filter(Boolean) });
    await api.reorderPlaylist(id, ids);
    changed();
  };
  const move = (from: number, to: number) => {
    if (!pl || to < 0 || to >= pl.entries.length || from === to) return;
    const ids = pl.entries.map((e) => e.id);
    const [m] = ids.splice(from, 1); ids.splice(to, 0, m);
    reorder(ids);
  };
  const remove = async (e: PlaylistEntryInfo) => { await api.removePlaylistEntry(id, e.id); changed(); };
  const add = async () => {
    const [type, cid] = pick.split(":");
    if (!type || !cid) return;
    const r = await api.addPlaylistEntry(id, { type: type as any, id: Number(cid) });
    if (r.error) { setErr(r.error); return; }
    setPick(""); changed();
  };

  if (err) return <p className="err">{err}</p>;
  if (!pl) return <p className="muted">Loading…</p>;

  return (
    <div className="pl-editor">
      <p className="muted" style={{ marginTop: 0 }}>
        Plays top to bottom, then starts over. Each entry takes its turn for one item, a set number, or all of them,
        in its own order, and picks up where it left off next time. Use the playlist as content in any channel.
      </p>

      {pl.entries.length === 0
        ? <div className="empty-state" style={{ padding: "32px 16px" }}><p className="muted" style={{ margin: 0 }}>This playlist is empty. Add a collection below, or use the + on any show, season, movie or episode poster.</p></div>
        : (
          <ol className="pl-list">
            {pl.entries.map((e, i) => (
              <li key={e.id} className={`pl-row ${over === i ? "over" : ""}`} draggable
                onDragStart={() => { drag.current = i; }} onDragOver={(ev) => { ev.preventDefault(); setOver(i); }}
                onDragLeave={() => setOver((o) => (o === i ? null : o))} onDrop={() => { setOver(null); if (drag.current != null) move(drag.current, i); drag.current = null; }}>
                <span className="pl-grip" title="Drag to reorder">⋮⋮</span>
                <span className="pl-num">{i + 1}</span>
                <div className="pl-what">
                  <div className="pl-label" title={e.label}>{e.label}</div>
                  <div className="pl-sub"><span className="badge">{KIND[e.ref.type]}</span> {e.items.toLocaleString()} item{e.items === 1 ? "" : "s"}</div>
                </div>
                <label className="pl-field">Order
                  <select value={e.order} onChange={(ev) => update(e, { order: ev.target.value })}>{ORDERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                </label>
                <label className="pl-field">Each turn
                  <select value={e.playAll ? "all" : (e.count ?? 1) > 1 ? "n" : "1"} onChange={(ev) => update(e, ev.target.value === "all" ? { playAll: true, count: null } : ev.target.value === "n" ? { playAll: false, count: Math.max(2, e.count ?? 2) } : { playAll: false, count: null })}>
                    <option value="1">1 item</option><option value="n">Several</option><option value="all">All of them</option>
                  </select>
                </label>
                {!e.playAll && (e.count ?? 1) > 1 && (
                  <label className="pl-field pl-count">How many<input type="number" min={2} value={e.count ?? 2} onChange={(ev) => update(e, { count: Math.max(2, Number(ev.target.value) || 2) })} /></label>
                )}
                <label className="pl-guide" title="Off: these play like filler, without their own guide listing"><input type="checkbox" checked={e.inGuide} onChange={(ev) => update(e, { inGuide: ev.target.checked })} /> In guide</label>
                <span className="pl-btns">
                  <button className="ghost" onClick={() => move(i, i - 1)} disabled={i === 0} title="Move up">↑</button>
                  <button className="ghost" onClick={() => move(i, i + 1)} disabled={i === pl.entries.length - 1} title="Move down">↓</button>
                  <button className="ghost pl-x" onClick={() => remove(e)} title="Remove from playlist">✕</button>
                </span>
              </li>
            ))}
          </ol>
        )}

      <div className="pl-add">
        <select value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">Add a collection…</option>
          {(["collection", "smart", "multi"] as const).map((t) => {
            const items = colls.filter((c) => c.type === t);
            return items.length ? <optgroup key={t} label={t === "collection" ? "Collections" : t === "smart" ? "Smart collections" : "Multi-collections"}>{items.map((c) => <option key={c.id} value={`${t}:${c.id}`}>{c.name}</option>)}</optgroup> : null;
          })}
        </select>
        <button className="primary" onClick={add} disabled={!pick}>Add to the end</button>
        <span className="muted" style={{ fontSize: 12 }}>Shows, seasons, movies and episodes: use the + on their poster.</span>
      </div>

      {preview && preview.length > 0 && (
        <div className="card" style={{ marginTop: 18 }}>
          <div className="card-head"><h2>Plays in this order</h2><span className="muted" style={{ fontSize: 12 }}>first {preview.length} items, as a new channel would start</span></div>
          <ol className="pl-preview">
            {preview.map((p, i) => (
              <li key={i} className={p.inGuide ? "" : "filler"}>
                <span className="pl-ptitle">{p.title}</span>
                <span className="muted">{p.entry}</span>
                <span className="muted num">{fmt(p.durationMs)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
