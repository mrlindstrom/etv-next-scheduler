// Editors shown inside an open collection on the Collections page:
// - AddItems: search the library and add results to a manual collection, right there
// - MultiMembers: the collections and smart collections a multi-collection is made of
import { useEffect, useState } from "react";
import { api, type CollectionInfo, type MultiMember, type SearchItem } from "../api.js";
import { QueryBox } from "../QueryBox.js";
import { fmtDur } from "./Browse.js";
import { navigate } from "../nav.js";

const label = (s: SearchItem) => {
  const ep = s.season != null && s.episode != null ? `S${String(s.season).padStart(2, "0")}E${String(s.episode).padStart(2, "0")} ` : "";
  return s.showTitle && s.showTitle !== s.title ? `${s.showTitle} · ${ep}${s.title}` : s.title;
};

export function AddItems({ collectionId, collectionName, onAdded }: { collectionId: number; collectionName: string; onAdded: () => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<Set<number>>(new Set());
  const [msg, setMsg] = useState("");

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true); setErr(""); setMsg("");
    const r = await api.browseSearch(q, 0, 100).catch((e) => ({ total: 0, items: [] as SearchItem[], error: String(e), unknownFields: [] as string[] }));
    setResults(r.items ?? []); setTotal(r.total ?? 0); setErr(r.error ?? ""); setBusy(false);
  };
  const add = async (items: SearchItem[]) => {
    const todo = items.filter((s) => !added.has(s.id));
    if (!todo.length) return;
    setBusy(true);
    const done = new Set(added);
    let failed = 0;
    for (let i = 0; i < todo.length; i++) {
      if (todo.length > 1) setMsg(`Adding ${i + 1} of ${todo.length}…`);
      try { const r = await api.addToCollection(collectionId, todo[i].id); if (r.error) throw new Error(r.error); done.add(todo[i].id); } catch { failed++; }
    }
    setAdded(done); setBusy(false);
    setMsg(`Added ${todo.length - failed === 1 && todo.length === 1 ? `"${label(todo[0])}"` : `${todo.length - failed} items`} to ${collectionName}${failed ? ` (${failed} failed)` : ""}`);
    onAdded();
  };

  return (
    <div className="job" style={{ marginBottom: 10 }}>
      <div className="job-head" style={{ marginBottom: 6 }}><b>Add items to {collectionName}</b></div>
      <QueryBox value={q} onChange={setQ} onSubmit={search} submitHint="Enter to search" placeholder={`show_title:"Rugrats" AND season:[1 TO 3]   or just words from a title`} />
      <div className="actions" style={{ marginTop: 8 }}>
        <button className="primary" onClick={search} disabled={busy || !q.trim()}>Search</button>
        {results.length > 0 && <button onClick={() => add(results)} disabled={busy || results.every((s) => added.has(s.id))}>Add all {results.length} shown</button>}
        {msg && <span className="ok" style={{ fontSize: 13 }}>{msg}</span>}
        {err && <span className="err" style={{ fontSize: 13 }}>{err}</span>}
        <span className="muted" style={{ fontSize: 12 }}>To add a whole show or season as one entry, use the <b>+</b> on its poster in <a onClick={() => navigate("browse")}>Browse</a>.</span>
      </div>
      {total != null && !err && (
        <div style={{ marginTop: 8 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            {total === 0 ? "Nothing matches." : `${total.toLocaleString()} match${total === 1 ? "" : "es"}${total > results.length ? ` — showing the first ${results.length}; narrow the search to see the rest` : ""}`}
          </div>
          <div style={{ maxHeight: 280, overflow: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
            {results.map((s) => (
              <div key={s.id} className="coll-menu-item" style={{ cursor: "default" }}>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={label(s)}>{label(s)}</span>
                <span className="muted" style={{ fontSize: 12 }}>{s.type}{s.year ? ` · ${s.year}` : ""}{s.durationMs ? ` · ${fmtDur(s.durationMs)}` : ""}</span>
                {added.has(s.id) ? <span className="ok" style={{ fontSize: 12, width: 56, textAlign: "center" }}>added</span>
                  : <button style={{ fontSize: 12, padding: "2px 8px", width: 56 }} onClick={() => add([s])} disabled={busy}>Add</button>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function MultiMembers({ id, all, onChanged, onOpen }: { id: number; all: CollectionInfo[]; onChanged: () => void; onOpen: (m: MultiMember) => void }) {
  const [members, setMembers] = useState<MultiMember[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const reload = () => api.multiMembers(id).then(setMembers).catch(() => setMembers([]));
  useEffect(() => { setMembers(null); reload(); }, [id]);

  const inIt = new Set((members ?? []).map((m) => `${m.type}-${m.id}`));
  const choices = all.filter((c) => (c.type === "collection" || c.type === "smart") && !inIt.has(`${c.type}-${c.id}`));
  const change = async (fn: () => Promise<{ error?: string } | unknown>) => {
    setBusy(true); setErr("");
    try { const r = await fn() as { error?: string }; if (r?.error) setErr(r.error); } catch (e) { setErr(String(e)); }
    await reload(); setBusy(false); onChanged();
  };

  return (
    <div className="job" style={{ marginBottom: 10 }}>
      <div className="job-head" style={{ marginBottom: 6 }}><b>Made of</b> <span className="muted" style={{ fontSize: 12 }}>— channels using this multi-collection play everything in these, together</span></div>
      {members === null ? <div className="muted">Loading…</div> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {members.length === 0 && <div className="muted" style={{ fontSize: 13 }}>Nothing yet — add a collection or smart collection below.</div>}
          {members.map((m) => (
            <div key={`${m.type}-${m.id}`} className="coll-menu-item" style={{ cursor: "default" }}>
              <span className="muted" style={{ fontSize: 11, width: 100 }}>{m.type === "smart" ? "smart collection" : "collection"}</span>
              <a style={{ flex: 1 }} onClick={() => onOpen(m)} title="Open it">{m.name}</a>
              {m.count != null && <span className="muted" style={{ fontSize: 12 }}>{m.count.toLocaleString()}</span>}
              <button style={{ fontSize: 12, padding: "2px 8px" }} disabled={busy} onClick={() => change(() => api.removeMultiMember(id, m))}>Remove</button>
            </div>
          ))}
        </div>
      )}
      <div className="actions" style={{ marginTop: 8 }}>
        <select value="" style={{ width: "auto" }} disabled={busy || !choices.length}
          onChange={(e) => { const [t, n] = e.target.value.split(":"); e.target.value = ""; if (n) change(() => api.addMultiMember(id, { type: t as "collection" | "smart", id: Number(n) })); }}>
          <option value="">{choices.length ? "+ Add a collection…" : "Every collection is already in it"}</option>
          {choices.some((c) => c.type === "collection") && <optgroup label="Collections">{choices.filter((c) => c.type === "collection").map((c) => <option key={`c${c.id}`} value={`collection:${c.id}`}>{c.name}</option>)}</optgroup>}
          {choices.some((c) => c.type === "smart") && <optgroup label="Smart collections">{choices.filter((c) => c.type === "smart").map((c) => <option key={`s${c.id}`} value={`smart:${c.id}`}>{c.name}</option>)}</optgroup>}
        </select>
        {err && <span className="err" style={{ fontSize: 13 }}>{err}</span>}
      </div>
    </div>
  );
}
