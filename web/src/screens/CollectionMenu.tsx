// "Add to collection" menu for one media item (movie, show, season, episode…):
// tick/untick the manual collections it belongs to, or create a new collection
// with it in one step. Used on Browse cards (hover), search rows and the detail panel.
import { useEffect, useRef, useState } from "react";
import { api, type CollectionInfo } from "../api.js";

const TYPE_NOUN: Record<string, string> = { movie: "movie", show: "show", season: "season", episode: "episode", other_video: "video", music_video: "music video", song: "song", image: "image" };

export function CollectionMenu({ itemId, type, title, variant = "overlay", onChanged }: {
  itemId: number; type: string; title: string;
  variant?: "overlay" | "inline";           // overlay: the "+" on a poster; inline: a normal button
  onChanged?: () => void;                   // membership changed (refresh counts / the open collection)
}) {
  const [open, setOpen] = useState(false);
  const [collections, setCollections] = useState<CollectionInfo[] | null>(null);
  const [playlists, setPlaylists] = useState<CollectionInfo[]>([]);
  const [inPlaylist, setInPlaylist] = useState<Set<number>>(new Set());
  const [member, setMember] = useState<Set<number>>(new Set());
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<number | "new" | null>(null);
  const [msg, setMsg] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setMsg("");
    Promise.all([api.collections(), api.collectionMembership(itemId), api.playlistMembership(itemId).catch(() => [])])
      .then(([all, mine, pls]) => {
        setCollections(all.filter((c) => c.type === "collection")); setMember(new Set(mine.map((m) => m.id)));
        setPlaylists(all.filter((c) => c.type === "playlist")); setInPlaylist(new Set(pls.map((p) => p.id)));
      })
      .catch((e) => setMsg(String(e)));
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open, itemId]);

  const toggle = async (c: CollectionInfo) => {
    setBusy(c.id); setMsg("");
    try {
      if (member.has(c.id)) { await api.removeFromCollection(c.id, itemId); member.delete(c.id); setMsg(`Removed from ${c.name}`); }
      else { const r = await api.addToCollection(c.id, itemId); if (r.error) throw new Error(r.error); member.add(c.id); setMsg(`Added to ${c.name}`); }
      setMember(new Set(member)); onChanged?.();
    } catch (e) { setMsg(String((e as Error).message ?? e)); } finally { setBusy(null); }
  };
  // playlists are ordered lists: adding appends an entry (a show or season plays its episodes)
  const addToPlaylist = async (p: CollectionInfo) => {
    setBusy(p.id); setMsg("");
    try {
      const r = await api.addPlaylistEntry(p.id, { type: "item", id: itemId });
      if (r.error) throw new Error(r.error);
      setInPlaylist((s) => new Set(s).add(p.id)); setMsg(`Added to the end of ${p.name}`); onChanged?.();
    } catch (e) { setMsg(String((e as Error).message ?? e)); } finally { setBusy(null); }
  };
  const create = async () => {
    const n = name.trim(); if (!n) return;
    setBusy("new"); setMsg("");
    try {
      const r = await api.createCollection({ type: "collection", name: n });
      if ("error" in r) throw new Error(r.error);
      await api.addToCollection(r.id, itemId);
      setCollections((cs) => [...(cs ?? []), { type: "collection", id: r.id, name: n, count: 1 } as CollectionInfo].sort((a, b) => a.name.localeCompare(b.name)));
      setMember((m) => new Set(m).add(r.id)); setName(""); setMsg(`Created ${n} and added this ${TYPE_NOUN[type] ?? "item"}`); onChanged?.();
    } catch (e) { setMsg(String((e as Error).message ?? e)); } finally { setBusy(null); }
  };

  const stop = (e: React.SyntheticEvent) => e.stopPropagation(); // don't open the card underneath
  return (
    <div ref={ref} className={`coll-menu-wrap ${variant} ${open ? "open" : ""}`} onClick={stop} onMouseDown={stop}>
      <button className={variant === "overlay" ? "mc-add" : ""} title={`Add this ${TYPE_NOUN[type] ?? "item"} to a collection`} aria-label="Add to collection"
        aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {variant === "overlay" ? "+" : "Add to collection"}
      </button>
      {open && (
        <div className="coll-menu" role="menu">
          <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>Collections with <b>{title}</b></div>
          {collections === null ? <div className="muted">Loading…</div>
            : collections.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>No collections yet — create one below.</div>
            : <div className="coll-menu-list">
                {collections.map((c) => (
                  <label key={c.id} className="coll-menu-item">
                    <input type="checkbox" checked={member.has(c.id)} disabled={busy !== null} onChange={() => toggle(c)} />
                    <span>{c.name}</span>
                  </label>
                ))}
              </div>}
          {playlists.length > 0 && <>
            <div className="muted" style={{ fontSize: 11, margin: "10px 0 4px" }}>Add to the end of a playlist</div>
            <div className="coll-menu-list">
              {playlists.map((p) => (
                <button key={p.id} className="coll-menu-item pl-menu-item" disabled={busy !== null} onClick={() => addToPlaylist(p)}>
                  <span>{p.name}</span>{inPlaylist.has(p.id) && <span className="muted" style={{ marginLeft: "auto", fontSize: 11 }}>in it</span>}
                </button>
              ))}
            </div>
          </>}
          <div className="coll-menu-new">
            <input value={name} placeholder="New collection…" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") create(); }} />
            <button className="primary" onClick={create} disabled={!name.trim() || busy !== null}>{busy === "new" ? "…" : "Create & add"}</button>
          </div>
          {msg && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>{msg}</div>}
        </div>
      )}
    </div>
  );
}
