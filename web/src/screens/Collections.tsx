// Collections page: every kind of collection (manual, smart, multi, playlists) in
// one place — open one to see its items, edit a smart query or a playlist, rename
// or delete. New ones can be made here or from a search on the Browse page.
import { useEffect, useState } from "react";
import { api, type BrowseCard, type CollectionInfo } from "../api.js";
import { CollectionMenu } from "./CollectionMenu.js";
import { PlaylistEditor } from "./PlaylistEditor.js";
import { QueryBox } from "../QueryBox.js";
import { Poster, fmtDur } from "./Browse.js";
import { navigate } from "../nav.js";

export const COLL_GROUPS: { type: CollectionInfo["type"]; label: string; noun: string }[] = [
  { type: "collection", label: "Collections", noun: "collection" },
  { type: "smart", label: "Smart Collections", noun: "smart collection" },
  { type: "multi", label: "Multi-Collections", noun: "multi-collection" },
  { type: "playlist", label: "Playlists", noun: "playlist" },
];

type Open = { type: CollectionInfo["type"]; id: number; name: string; query?: string };

export function Collections() {
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [open, setOpen] = useState<Open | null>(null);
  const [cards, setCards] = useState<BrowseCard[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [queryDraft, setQueryDraft] = useState("");
  const [msg, setMsg] = useState("");

  const load = () => api.collections().then((cs) => { setCollections(cs); return cs; }).catch(() => [] as CollectionInfo[]);
  useEffect(() => {
    // ?type=smart&id=12 opens that collection (e.g. right after Browse made it)
    const p = new URLSearchParams(window.location.search);
    load().then((cs) => {
      const hit = cs.find((c) => c.type === p.get("type") && c.id === Number(p.get("id")));
      if (hit) openColl(hit);
    });
  }, []);

  const openColl = async (c: Open & { count?: number | null }) => {
    setOpen({ type: c.type, id: c.id, name: c.name, query: c.query }); setMsg(""); setQueryDraft(c.query ?? "");
    if (c.type === "playlist") { setCards([]); setTotal(c.count ?? 0); return; } // edited as an ordered list
    setBusy(true);
    const r = await api.collectionItems(c.type, c.id).catch(() => ({ name: c.name, type: c.type, total: 0, cards: [] as BrowseCard[], query: c.query }));
    setCards(r.cards); setTotal(r.total); setQueryDraft(r.query ?? c.query ?? ""); setBusy(false);
  };
  // after adding/removing an item: refresh counts, and the open manual collection's items
  const membershipChanged = () => { load(); if (open?.type === "collection") openColl(open); };

  const add = async (type: CollectionInfo["type"]) => {
    const noun = COLL_GROUPS.find((g) => g.type === type)?.noun ?? "collection";
    const name = prompt(`New ${noun} name:`);
    if (!name) return;
    const query = type === "smart" ? (prompt("Smart collection query:", 'library_name:"Commercials"') ?? "") : undefined;
    const r = await api.createCollection({ type, name, query });
    if ("error" in r) { alert(r.error); return; }
    await load();
    openColl({ type, id: r.id, name, query });
  };
  const saveQuery = async () => {
    if (!open) return;
    setMsg("Saving…");
    await api.updateCollection(open.type, open.id, { query: queryDraft });
    await load();
    const r = await api.collectionItems(open.type, open.id);
    setCards(r.cards); setTotal(r.total); setMsg(`Saved — ${r.total} items`);
    setOpen({ ...open, query: queryDraft });
    setTimeout(() => setMsg(""), 2500);
  };
  const rename = async () => {
    if (!open) return;
    const name = prompt("Rename collection:", open.name);
    if (!name || name === open.name) return;
    await api.updateCollection(open.type, open.id, { name });
    await load(); setOpen({ ...open, name });
  };
  const remove = async () => {
    if (!open) return;
    if (!confirm(`Delete ${open.type} "${open.name}"? This won't touch your media files.`)) return;
    await api.deleteCollection(open.type, open.id);
    await load(); setCards([]); setOpen(null);
  };
  // cards open in Browse (shows drill into seasons, everything else shows its details)
  const clickCard = (c: BrowseCard) => navigate("browse", { open: c.type, id: String(c.id) });

  const group = open ? COLL_GROUPS.find((g) => g.type === open.type) : undefined;
  return (
    <section className="screen browse">
      <div className="browse-side">
        {COLL_GROUPS.map((g) => {
          const items = collections.filter((c) => c.type === g.type);
          return (
            <div key={g.type} className="coll-group">
              <div className="coll-group-head">
                <span>{g.label}</span>
                <button title={`New ${g.noun}`} onClick={() => add(g.type)}>+</button>
              </div>
              <ul className="kind-list coll-list">
                {items.map((c) => (
                  <li key={`${c.type}-${c.id}`} className={open?.type === c.type && open.id === c.id ? "active" : ""} onClick={() => openColl(c)}>
                    <span title={c.name}>{c.name}</span>
                    {c.count != null && <span className="count">{c.count.toLocaleString()}</span>}
                  </li>
                ))}
                {items.length === 0 && <li className="muted empty" style={{ cursor: "default" }}>none</li>}
              </ul>
            </div>
          );
        })}
        <p className="muted" style={{ fontSize: 12, marginTop: 14 }}>
          Tip: search on the <a onClick={() => navigate("browse")}>Browse</a> page, then save the search as a smart collection or make a collection from the results.
        </p>
      </div>

      <div className="browse-main">
        {!open ? (
          <div className="empty-state">
            <h2 style={{ marginTop: 0 }}>Collections</h2>
            <p className="muted">Pick a collection on the left to see what's in it, or make a new one with <b>+</b>.</p>
            <p className="muted">To add a movie, show or episode to a collection, use the <b>+</b> on its poster in <a onClick={() => navigate("browse")}>Browse</a>.</p>
          </div>
        ) : (<>
          <div className="crumbs">
            <span className="muted">{group?.label}</span> <span>›</span> <b>{open.name}</b>{" "}
            <span className="muted">· {total.toLocaleString()} {open.type === "playlist" ? `entr${total === 1 ? "y" : "ies"}` : `item${total === 1 ? "" : "s"}`}</span>
            {busy && <span className="muted"> · loading…</span>}
            <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button onClick={rename}>Rename</button>
              <button className="danger" onClick={remove}>Delete</button>
            </span>
          </div>

          {open.type === "smart" && (
            <div className="job" style={{ marginBottom: 10 }}>
              <div className="job-head" style={{ marginBottom: 6 }}><b>Smart collection query</b></div>
              <QueryBox value={queryDraft} onChange={setQueryDraft} onSubmit={saveQuery} submitHint="Enter to save" placeholder={`library_name:"Commercials" AND seconds:[1 TO 45]`} />
              <div className="actions" style={{ marginTop: 8 }}>
                <button className="primary" onClick={saveQuery} disabled={queryDraft === (open.query ?? "")}>Save query</button>
                {msg && <span className="ok">{msg}</span>}
                <span className="muted" style={{ fontSize: 12 }}>Enter to save · Shift+Enter for a new line · items refresh on save</span>
              </div>
            </div>
          )}

          {open.type === "playlist" ? (
            <PlaylistEditor id={open.id} onChanged={() => load().then((cs) => { const me = cs.find((c) => c.type === "playlist" && c.id === open.id); if (me) setTotal(me.count ?? 0); })} />
          ) : (<>
            <div className="card-grid">
              {cards.map((c) => (
                <div key={`${c.type}-${c.id}`} className="media-card" onClick={() => clickCard(c)}>
                  <Poster type={c.type} id={c.id} variant={c.type === "episode" ? "thumb" : "poster"} />
                  <CollectionMenu itemId={c.id} type={c.type} title={c.title} onChanged={membershipChanged} />
                  <div className="mc-title" title={c.title}>
                    {c.type === "episode" && c.subtitle ? <><span className="epcode">{c.subtitle}</span> {c.title}</> : c.title}
                  </div>
                  <div className="mc-sub">{c.year ?? ""}{c.episodes != null ? `${c.year ? " · " : ""}${c.episodes} ep` : ""}{c.type !== "episode" && c.subtitle ? ` ${c.subtitle}` : ""}{c.durationMs ? `${(c.year || c.episodes) ? " · " : ""}${fmtDur(c.durationMs)}` : ""}</div>
                </div>
              ))}
            </div>
            {total > cards.length && <p className="muted">Showing the first {cards.length} of {total.toLocaleString()}.</p>}
            {cards.length === 0 && !busy && <p className="muted">{open.type === "collection" ? "Nothing in this collection yet. Use the + on a poster in Browse to add things." : "Nothing matches yet."}</p>}
          </>)}
        </>)}
      </div>
    </section>
  );
}
