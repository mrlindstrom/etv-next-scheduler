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
import { AddItems, MultiMembers } from "./CollectionEditors.js";

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
  // posters picked with their select circle (manual collections), keyed type-id
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState(false);
  const [adding, setAdding] = useState(false); // the "Add items" search panel (manual collections)
  const keyOf = (c: BrowseCard) => `${c.type}-${c.id}`;

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
    setOpen({ type: c.type, id: c.id, name: c.name, query: c.query }); setMsg(""); setQueryDraft(c.query ?? ""); setSelected(new Set()); setAdding(false);
    if (c.type === "playlist") { setCards([]); setTotal(c.count ?? 0); return; } // edited as an ordered list
    setBusy(true);
    const r = await api.collectionItems(c.type, c.id).catch(() => ({ name: c.name, type: c.type, total: 0, cards: [] as BrowseCard[], query: c.query }));
    setCards(r.cards); setTotal(r.total); setQueryDraft(r.query ?? c.query ?? ""); setBusy(false);
  };
  // after adding/removing an item or member: refresh counts, and the open collection's items
  // (keeping the "Add items" panel and any message as they are)
  const membershipChanged = async () => {
    load();
    if (!open || (open.type !== "collection" && open.type !== "multi")) return;
    const r = await api.collectionItems(open.type, open.id).catch(() => null);
    if (r) { setCards(r.cards); setTotal(r.total); }
  };

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
    const name = prompt("Rename collection:", open.name)?.trim();
    if (!name || name === open.name) return;
    if (collections.some((c) => c.type === open.type && c.id !== open.id && c.name === name)) { alert(`There's already a ${group?.noun ?? "collection"} called "${name}".`); return; }
    const r = await api.updateCollection(open.type, open.id, { name });
    await load(); setOpen({ ...open, name });
    const ch = r.channels ?? [];
    setMsg(ch.length ? `Renamed — updated ${ch.length} channel${ch.length === 1 ? "" : "s"} that use it (${ch.join(", ")}); rebuild them to pick it up` : "Renamed");
  };
  const remove = async () => {
    if (!open) return;
    const u = await api.collectionUsage(open.type, open.id).catch(() => ({ channels: [] as string[], library: [] as string[] }));
    const uses = [
      u.channels.length ? `\n\nChannels that use it (they'll have nothing to play from it until you change them):\n• ${u.channels.join("\n• ")}` : "",
      u.library.length ? `\n\nIt's also part of (it'll be taken out of these):\n• ${u.library.join("\n• ")}` : "",
    ].join("");
    if (!confirm(`Delete ${group?.noun ?? open.type} "${open.name}"? This won't touch your media files.${uses}`)) return;
    await api.deleteCollection(open.type, open.id);
    await load(); setCards([]); setOpen(null);
  };
  // the other manual collections, for copy / move
  const others = collections.filter((c) => c.type === "collection" && c.id !== open?.id);
  const copySelected = async (targetId: number, move: boolean) => {
    if (!open || !selected.size) return;
    const target = others.find((c) => c.id === targetId);
    if (!target) return;
    const picked = cards.filter((c) => selected.has(keyOf(c)));
    const what = picked.length === 1 ? `"${picked[0].title}"` : `${picked.length} items`;
    if (move && !confirm(`Move ${what} from "${open.name}" to "${target.name}"?`)) return;
    setRemoving(true);
    let failed = 0;
    for (const c of picked) {
      try {
        const r = await api.addToCollection(targetId, c.id);
        if (r.error) throw new Error(r.error);
        if (move) await api.removeFromCollection(open.id, c.id);
      } catch { failed++; }
    }
    setRemoving(false);
    setSelected(new Set()); await membershipChanged();
    setMsg(`${move ? "Moved" : "Copied"} ${picked.length - failed === 1 && picked.length === 1 ? what : `${picked.length - failed} items`} to "${target.name}"${failed ? ` (${failed} failed)` : ""}`);
  };
  const toggle = (c: BrowseCard) => setSelected((s) => { const n = new Set(s); n.has(keyOf(c)) ? n.delete(keyOf(c)) : n.add(keyOf(c)); return n; });
  // take the selected items out of this collection (the items themselves stay in the library)
  const removeSelected = async () => {
    if (!open || open.type !== "collection" || !selected.size) return;
    const picked = cards.filter((c) => selected.has(keyOf(c)));
    const what = picked.length === 1 ? `"${picked[0].title}"` : `${picked.length} items`;
    if (!confirm(`Remove ${what} from "${open.name}"? Only the collection changes; nothing is deleted from your library.`)) return;
    setRemoving(true);
    let failed = 0;
    for (const c of picked) { try { await api.removeFromCollection(open.id, c.id); } catch { failed++; } }
    setRemoving(false);
    setSelected(new Set()); await membershipChanged();
    setMsg(failed ? `Removed ${picked.length - failed}; ${failed} couldn't be removed` : `Removed ${what} — rebuild the channels that use this collection to drop them from their schedules`);
  };
  // cards open in Browse (shows drill into seasons, everything else shows its details);
  // while picking items, a click on a card toggles it instead
  const clickCard = (c: BrowseCard) => selected.size ? toggle(c) : navigate("browse", { open: c.type, id: String(c.id) });
  const canSelect = open?.type === "collection";

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
            <p className="muted">To add a movie, show or episode to a collection, open the collection and use <b>+ Add items</b>, or the <b>+</b> on its poster in <a onClick={() => navigate("browse")}>Browse</a>. To take things out, tick the circle on their posters.</p>
          </div>
        ) : (<>
          <div className="crumbs">
            <span className="muted">{group?.label}</span> <span>›</span> <b>{open.name}</b>{" "}
            <span className="muted">· {total.toLocaleString()} {open.type === "playlist" ? `entr${total === 1 ? "y" : "ies"}` : `item${total === 1 ? "" : "s"}`}</span>
            {busy && <span className="muted"> · loading…</span>}
            {msg && open.type !== "smart" && <span className="ok" style={{ fontSize: 13, marginLeft: 10 }}>{msg}</span>}
            <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              {open.type === "collection" && <button className={adding ? "primary" : ""} onClick={() => setAdding(!adding)}>{adding ? "Done adding" : "+ Add items"}</button>}
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

          {open.type === "collection" && adding && (
            <AddItems collectionId={open.id} collectionName={open.name} onAdded={membershipChanged} />
          )}
          {open.type === "multi" && (
            <MultiMembers id={open.id} all={collections} onChanged={membershipChanged}
              onOpen={(m) => { const c = collections.find((x) => x.type === m.type && x.id === m.id); if (c) openColl(c); }} />
          )}

          {open.type === "playlist" ? (
            <PlaylistEditor id={open.id} onChanged={() => load().then((cs) => { const me = cs.find((c) => c.type === "playlist" && c.id === open.id); if (me) setTotal(me.count ?? 0); })} />
          ) : (<>
            {canSelect && cards.length > 0 && (
              <div className="select-bar">
                {selected.size === 0 ? (
                  <span className="muted" style={{ fontSize: 13 }}>Tick the circle on a poster to pick items to remove from this collection.</span>
                ) : (<>
                  <b>{selected.size} selected</b>
                  <button className="primary" onClick={removeSelected} disabled={removing}>{removing ? "Working…" : "Remove from collection"}</button>
                  {others.length > 0 && <>
                    <select value="" style={{ width: "auto" }} disabled={removing} title="Put the selected items in another collection too"
                      onChange={(e) => { const id = Number(e.target.value); e.target.value = ""; if (id) copySelected(id, false); }}>
                      <option value="">Copy to…</option>
                      {others.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <select value="" style={{ width: "auto" }} disabled={removing} title="Put the selected items in another collection and take them out of this one"
                      onChange={(e) => { const id = Number(e.target.value); e.target.value = ""; if (id) copySelected(id, true); }}>
                      <option value="">Move to…</option>
                      {others.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </>}
                  <button onClick={() => setSelected(new Set())} disabled={removing}>Clear</button>
                </>)}
                {selected.size < cards.length && <button onClick={() => setSelected(new Set(cards.map(keyOf)))} disabled={removing}>Select all{total > cards.length ? ` ${cards.length} shown` : ""}</button>}
              </div>
            )}
            <div className={`card-grid ${selected.size ? "selecting" : ""}`}>
              {cards.map((c) => (
                <div key={`${c.type}-${c.id}`} className={`media-card ${selected.has(keyOf(c)) ? "selected" : ""}`} onClick={() => clickCard(c)}>
                  <Poster type={c.type} id={c.id} variant={c.type === "episode" ? "thumb" : "poster"} />
                  {canSelect && (
                    <button className={`mc-select ${selected.has(keyOf(c)) ? "on" : ""}`} title={selected.has(keyOf(c)) ? "Unselect" : "Select"} aria-label={`Select ${c.title}`} aria-pressed={selected.has(keyOf(c))}
                      onClick={(e) => { e.stopPropagation(); toggle(c); }}>✓</button>
                  )}
                  <CollectionMenu itemId={c.id} type={c.type} title={c.title} onChanged={membershipChanged} />
                  <div className="mc-title" title={c.title}>
                    {c.type === "episode" && c.subtitle ? <><span className="epcode">{c.subtitle}</span> {c.title}</> : c.title}
                  </div>
                  <div className="mc-sub">{c.year ?? ""}{c.episodes != null ? `${c.year ? " · " : ""}${c.episodes} ep` : ""}{c.type !== "episode" && c.subtitle ? ` ${c.subtitle}` : ""}{c.durationMs ? `${(c.year || c.episodes) ? " · " : ""}${fmtDur(c.durationMs)}` : ""}</div>
                </div>
              ))}
            </div>
            {total > cards.length && <p className="muted">Showing the first {cards.length} of {total.toLocaleString()}.</p>}
            {cards.length === 0 && !busy && <p className="muted">{open.type === "collection" ? <>Nothing in this collection yet. Use <b>+ Add items</b> above, or the <b>+</b> on a poster in <a onClick={() => navigate("browse")}>Browse</a>.</> : open.type === "multi" ? "Nothing in it yet — add a collection above." : "Nothing matches yet."}</p>}
          </>)}
        </>)}
      </div>
    </section>
  );
}
