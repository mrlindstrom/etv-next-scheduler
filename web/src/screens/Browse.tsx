import { useEffect, useRef, useState } from "react";
import { api, type BrowseCard, type BrowseDetail, type SearchItem, type DeepScanJob } from "../api.js";
import { CollectionMenu } from "./CollectionMenu.js";
import { QueryBox } from "../QueryBox.js";
import { navigate } from "../nav.js";

type View =
  | { mode: "grid"; kind: string; label: string }
  | { mode: "seasons"; showId: number; showTitle: string }
  | { mode: "episodes"; seasonId: number; title: string; showTitle: string; showId: number | null }
  | { mode: "search" };

const ALPHABET = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

export const fmtDur = (ms?: number) => { if (!ms) return ""; const s = Math.round(ms / 1000); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };
const TYPE_LABEL: Record<string, string> = { movie: "Movie", episode: "Episode", show: "Show", season: "Season", other_video: "Other", music_video: "Music Video", song: "Song", image: "Image" };

export function Poster({ type, id, variant }: { type: string; id: number; variant?: "poster" | "thumb" | "row" }) {
  const [err, setErr] = useState(false);
  return (
    <div className={`poster ${variant ?? "poster"}`}>
      {err
        ? <div className="poster-fallback">{TYPE_LABEL[type] ?? "Media"}</div>
        : <img src={`/api/artwork/${type}/${id}`} loading="lazy" onError={() => setErr(true)} alt="" />}
    </div>
  );
}

export function Browse() {
  const [kinds, setKinds] = useState<{ kind: string; label: string; count: number }[]>([]);
  const [view, setView] = useState<View | null>(null);
  const [cards, setCards] = useState<BrowseCard[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<BrowseDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [deep, setDeep] = useState<DeepScanJob | null>(null);
  const [letters, setLetters] = useState<Record<string, number>>({}); // where each letter starts in the grid
  const deepPoll = useRef<number | null>(null);

  // search
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [searchInfo, setSearchInfo] = useState<{ total: number; unknownFields: string[]; error?: string } | null>(null);
  const PAGE = 60;

  // making a collection from the search (collections are managed on their own page)
  const [makeMsg, setMakeMsg] = useState("");

  useEffect(() => {
    // ?open=show&id=12 (from the Collections page): drill into that show/season, or show the item's details
    const p = new URLSearchParams(window.location.search);
    const openType = p.get("open"), openId = Number(p.get("id"));
    api.browseKinds().then((k) => {
      setKinds(k);
      if (openType && openId) {
        if (openType === "show") showById(openId, "");
        else if (openType === "season") seasonById(openId, "", "");
        else { if (k[0]) selectKind(k[0].kind, k[0].label); openDetail(openType, openId); }
      } else if (k[0]) selectKind(k[0].kind, k[0].label);
    }).catch(() => {});
    loadDeep();
    return () => { if (deepPoll.current) clearInterval(deepPoll.current); };
  }, []);

  const loadDeep = () => api.deepScanStatus().then((s) => {
    setDeep(s.type ? s : null);
    if (s.running && !deepPoll.current) deepPoll.current = window.setInterval(loadDeep, 1000);
    if (!s.running && deepPoll.current) { clearInterval(deepPoll.current); deepPoll.current = null; if (detail) openDetail(detail.type, detail.id); }
  }).catch(() => {});
  const runDeep = async (type: string, id: number) => {
    const r = await api.deepScan(type, id);
    if (!("running" in r)) return;
    setDeep(r); if (!deepPoll.current) deepPoll.current = window.setInterval(loadDeep, 1000);
  };
  const deepBusy = (type: string, id: number) => !!deep?.running && deep.type === type && deep.id === id;

  const selectKind = async (kind: string, label: string) => {
    setView({ mode: "grid", kind, label }); setOffset(0); setBusy(true); setLetters({});
    api.browseLetters(kind).then(setLetters).catch(() => {});
    const r = await api.browseList(kind, 0, PAGE).catch(() => ({ total: 0, cards: [] }));
    setCards(r.cards); setTotal(r.total); setBusy(false);
  };
  const page = async (kind: string, off: number) => { setBusy(true); setOffset(off); const r = await api.browseList(kind, off, PAGE); setCards(r.cards); setTotal(r.total); setBusy(false); };
  const showById = async (id: number, fallbackTitle: string) => { setBusy(true); const r = await api.browseSeasons(id); setView({ mode: "seasons", showId: id, showTitle: r.show?.title ?? fallbackTitle }); setCards(r.seasons); setTotal(r.seasons.length); setBusy(false); };
  const seasonById = async (id: number, fallbackTitle: string, showTitle: string) => { setBusy(true); const r = await api.browseEpisodes(id); setView({ mode: "episodes", seasonId: id, title: r.season?.title ?? fallbackTitle, showTitle: r.season?.showTitle ?? showTitle, showId: r.season?.showId ?? null }); setCards(r.episodes); setTotal(r.episodes.length); setBusy(false); };
  const openShow = (c: BrowseCard) => showById(c.id, c.title);
  const openSeason = (c: BrowseCard, showTitle: string) => seasonById(c.id, c.title, showTitle);
  const clickResult = (r: SearchItem) => {
    if (r.type === "show") return showById(r.id, r.title);
    if (r.type === "season") return seasonById(r.id, r.title, r.showTitle);
    return openDetail(r.type, r.id);
  };
  const openDetail = async (type: string, id: number) => { const d = await api.browseDetail(type, id); setDetail(d); };

  const runSearch = async () => {
    setView({ mode: "search" }); setBusy(true);
    const r = await api.browseSearch(q, 0, 200);
    setResults(r.items); setSearchInfo({ total: r.total, unknownFields: r.unknownFields, error: (r as any).error }); setBusy(false);
  };

  // the search as a smart collection (it keeps matching as the library changes)
  const saveSmart = async () => {
    const name = prompt("Name for the new smart collection:");
    if (!name) return;
    const r = await api.createCollection({ type: "smart", name, query: q });
    if ("error" in r) { alert(r.error); return; }
    navigate("collections", { type: "smart", id: String(r.id) });
  };
  // a regular collection holding exactly the results shown
  const collectFromResults = async () => {
    const more = (searchInfo?.total ?? 0) > results.length ? ` (the first ${results.length} of ${searchInfo!.total.toLocaleString()} matches)` : "";
    const name = prompt(`Name for a new collection with these ${results.length} results${more}:`);
    if (!name) return;
    const r = await api.createCollection({ type: "collection", name });
    if ("error" in r) { alert(r.error); return; }
    for (let i = 0; i < results.length; i++) {
      setMakeMsg(`Adding ${i + 1} of ${results.length}…`);
      await api.addToCollection(r.id, results[i].id).catch(() => {});
    }
    setMakeMsg("");
    navigate("collections", { type: "collection", id: String(r.id) });
  };
  // add the results shown to a collection that already exists
  const [manual, setManual] = useState<{ id: number; name: string }[]>([]);
  useEffect(() => { if (view?.mode === "search") api.collections().then((cs) => setManual(cs.filter((c) => c.type === "collection"))).catch(() => {}); }, [view?.mode]);
  const addResultsTo = async (id: number) => {
    const target = manual.find((c) => c.id === id);
    if (!target) return;
    const more = (searchInfo?.total ?? 0) > results.length ? ` (the first ${results.length} of ${searchInfo!.total.toLocaleString()} matches)` : "";
    if (!confirm(`Add these ${results.length} results${more} to "${target.name}"? Items already in it are skipped.`)) return;
    for (let i = 0; i < results.length; i++) {
      setMakeMsg(`Adding ${i + 1} of ${results.length}…`);
      await api.addToCollection(id, results[i].id).catch(() => {});
    }
    setMakeMsg("");
    navigate("collections", { type: "collection", id: String(id) });
  };

  const clickCard = (c: BrowseCard) => {
    if (c.type === "show") return openShow(c);
    if (c.type === "season" && view?.mode === "seasons") return openSeason(c, view.showTitle);
    return openDetail(c.type, c.id);
  };

  return (
    <section className="screen browse">
      <div className="browse-side">
        <h2>Library</h2>
        <ul className="kind-list">
          {kinds.map((k) => (
            <li key={k.kind} className={view?.mode === "grid" && (view as any).kind === k.kind ? "active" : ""} onClick={() => selectKind(k.kind, k.label)}>
              <span>{k.label}</span><span className="count">{k.count.toLocaleString()}</span>
            </li>
          ))}
        </ul>
        <h2 style={{ marginTop: 18 }}>Search</h2>
        <p className="muted" style={{ fontSize: 12 }}>Type words to find titles, or build a query from fields — suggestions appear as you type. It's the same search channels and smart collections use — save a search as a collection from its results.</p>
        <QueryBox value={q} onChange={setQ} onSubmit={runSearch} rows={4} />
        <button className="primary" onClick={runSearch} style={{ width: "100%" }}>Run search</button>

      </div>

      <div className="browse-main">
        {/* breadcrumb */}
        <div className="crumbs">
          {view?.mode === "grid" && <b>{view.label}</b>}
          {view?.mode === "seasons" && <><a onClick={() => selectKind("show", "Shows")}>Shows</a> <span>›</span> <b>{view.showTitle}</b></>}
          {view?.mode === "episodes" && <><a onClick={() => selectKind("show", "Shows")}>Shows</a> <span>›</span> <a onClick={() => view.showId != null ? showById(view.showId, view.showTitle) : selectKind("show", "Shows")}>{view.showTitle}</a> <span>›</span> <b>{view.title}</b></>}
          {view?.mode === "search" && <b>Search results{searchInfo ? ` — ${searchInfo.total.toLocaleString()} match${searchInfo.total === 1 ? "" : "es"}` : ""}</b>}
          {busy && <span className="muted"> · loading…</span>}
          {view?.mode === "seasons" && <button style={{ marginLeft: 12 }} onClick={() => runDeep("show", view.showId)} disabled={deepBusy("show", view.showId)}>{deepBusy("show", view.showId) ? "Deep scanning…" : "Deep scan show"}</button>}
          {view?.mode === "episodes" && <button style={{ marginLeft: 12 }} onClick={() => runDeep("season", view.seasonId)} disabled={deepBusy("season", view.seasonId)}>{deepBusy("season", view.seasonId) ? "Deep scanning…" : "Deep scan season"}</button>}
          {view?.mode === "search" && searchInfo && searchInfo.total > 0 && !searchInfo.error && <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
            {makeMsg && <span className="muted" style={{ fontSize: 12 }}>{makeMsg}</span>}
            <button onClick={saveSmart} title="A smart collection keeps matching this search as your library changes">Save as smart collection</button>
            <button onClick={collectFromResults} title="A regular collection with exactly these items">New collection from these results</button>
            {manual.length > 0 && <select value="" style={{ width: "auto" }} title="Add these results to a collection you already have"
              onChange={(e) => { const id = Number(e.target.value); e.target.value = ""; if (id) addResultsTo(id); }}>
              <option value="">Add to a collection…</option>
              {manual.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>}
          </span>}
        </div>

        {deep && (deep.running || deep.result || deep.error) && (
          <div className="job" style={{ marginBottom: 10 }}>
            <div className="job-head">
              {deep.running
                ? <><span className="spinner" /> Deep scanning {deep.type} — {deep.total ? `${deep.done_}/${deep.total}` : "…"} {deep.current}</>
                : deep.error ? <span className="err">Deep scan failed: {deep.error.slice(0, 160)}</span>
                : deep.result ? <span className="ok">Deep scan complete — refreshed {deep.result.refreshed} of {deep.result.targets}, {deep.result.chapters} chapters{deep.result.failed ? `, ${deep.result.failed} failed` : ""}.</span>
                : null}
            </div>
          </div>
        )}

        {view?.mode === "grid" && Object.keys(letters).length > 1 && (() => {
          // the letter being shown: the last one starting at or before this page
          const here = ALPHABET.filter((l) => letters[l] != null && letters[l] <= offset).pop();
          return (
            <div className="alpha-bar">
              {ALPHABET.map((l) => (
                <button key={l} className={l === here ? "active" : ""} disabled={letters[l] == null || busy}
                  title={letters[l] == null ? `Nothing starts with ${l}` : l === "#" ? "Titles starting with a number or symbol" : `Titles starting with ${l}`}
                  onClick={() => page(view.kind, letters[l])}>{l}</button>
              ))}
            </div>
          );
        })()}

        {view?.mode === "search" ? (
          <>
            {searchInfo?.error && <p className="err">{searchInfo.error}</p>}
            {searchInfo && searchInfo.unknownFields.length > 0 && <p className="err">Unknown field(s): {searchInfo.unknownFields.join(", ")} — these are ignored by the engine.</p>}
            <table className="history">
              <thead><tr><th></th><th>Title</th><th>Show</th><th>Type</th><th>Duration</th><th></th></tr></thead>
              <tbody>{results.map((r) => (
                <tr key={`${r.type}-${r.id}`} className="clickable" onClick={() => clickResult(r)}>
                  <td style={{ width: 40 }}><Poster type={r.type} id={r.id} variant="row" /></td>
                  <td>{r.title}{r.type === "episode" && r.episode != null ? <span className="muted"> · S{r.season}E{r.episode}</span> : null}</td>
                  <td className="muted">{r.showTitle || "—"}</td>
                  <td><span className="badge">{TYPE_LABEL[r.type] ?? r.type}</span></td>
                  <td className="muted">{fmtDur(r.durationMs)}</td>
                  <td style={{ width: 40 }} onClick={(e) => e.stopPropagation()}><CollectionMenu itemId={r.id} type={r.type} title={r.title} variant="inline" /></td>
                </tr>
              ))}</tbody>
            </table>
            {searchInfo && searchInfo.total > results.length && <p className="muted">Showing first {results.length} of {searchInfo.total.toLocaleString()}.</p>}
            {searchInfo && searchInfo.total === 0 && !searchInfo.error && <p className="muted">No matches.</p>}
          </>
        ) : (
          <>
            <div className="card-grid">
              {cards.map((c) => (
                <div key={`${c.type}-${c.id}`} className="media-card" onClick={() => clickCard(c)}>
                  <Poster type={c.type} id={c.id} variant={c.type === "episode" ? "thumb" : "poster"} />
                  <CollectionMenu itemId={c.id} type={c.type} title={c.title} />
                  <div className="mc-title" title={c.title}>
                    {c.type === "episode" && c.subtitle ? <><span className="epcode">{c.subtitle}</span> {c.title}</> : c.title}
                  </div>
                  <div className="mc-sub">{c.year ?? ""}{c.episodes != null ? `${c.year ? " · " : ""}${c.episodes} ep` : ""}{c.type !== "episode" && c.subtitle ? ` ${c.subtitle}` : ""}{c.durationMs ? `${(c.year || c.episodes) ? " · " : ""}${fmtDur(c.durationMs)}` : ""}</div>
                </div>
              ))}
            </div>
            {view?.mode === "grid" && total > PAGE && (
              <div className="actions" style={{ marginTop: 12 }}>
                <button disabled={offset === 0 || busy} onClick={() => page(view.kind, Math.max(0, offset - PAGE))}>← Prev</button>
                <span className="muted">{offset + 1}–{Math.min(offset + PAGE, total)} of {total.toLocaleString()}</span>
                <button disabled={offset + PAGE >= total || busy} onClick={() => page(view.kind, offset + PAGE)}>Next →</button>
              </div>
            )}
            {cards.length === 0 && !busy && <p className="muted">Nothing here.</p>}
          </>
        )}
      </div>

      {detail && (
        <div className="modal-overlay" onClick={() => setDetail(null)}>
          <div className="modal detail" onClick={(e) => e.stopPropagation()}>
            <div className="pane-head"><h2 style={{ margin: 0 }}>{detail.title}</h2>
              <div>
                <span style={{ display: "inline-block", marginRight: 6 }}><CollectionMenu itemId={detail.id} type={detail.type} title={detail.title} variant="inline" /></span>
                {detail.path && <button style={{ marginRight: 6 }} onClick={() => navigate("troubleshoot", { tab: "play", type: detail.type, id: String(detail.id) })} title="Play part of it through ErsatzTV next and see what viewers would get">Test play</button>}
                <button onClick={() => runDeep(detail.type, detail.id)} disabled={deepBusy(detail.type, detail.id)} title="Force a full metadata + chapter/stream refresh for this item">{deepBusy(detail.type, detail.id) ? "Deep scanning…" : "Deep scan"}</button>
                <button style={{ marginLeft: 6 }} onClick={() => setDetail(null)}>✕</button>
              </div>
            </div>
            <div className="detail-body">
              <Poster type={detail.type} id={detail.id} />
              <div className="detail-meta">
                {detail.showTitle && <div className="muted">{detail.showTitle}{detail.season != null ? ` · S${detail.season}E${detail.episode}` : ""}</div>}
                <div className="detail-facts">
                  {detail.year && <span>{detail.year}</span>}
                  <span>{fmtDur(detail.durationMs)}</span>
                  <span className="badge">{TYPE_LABEL[detail.type] ?? detail.type}</span>
                  {detail.library && <span className="muted">{detail.library}</span>}
                  {detail.chapters > 0 && <span className="muted">{detail.chapters} chapters</span>}
                </div>
                {detail.plot && <p className="plot">{detail.plot}</p>}
                {detail.genres.length > 0 && <div className="chips"><b>Genres:</b> {detail.genres.map((g) => <span key={g} className="chip">{g}</span>)}</div>}
                {detail.tags.length > 0 && <div className="chips"><b>Tags:</b> {detail.tags.map((t) => <span key={t} className="chip">{t}</span>)}</div>}
                {detail.studios.length > 0 && <div className="chips"><b>Studios:</b> {detail.studios.join(", ")}</div>}
                {detail.streams.length > 0 && <div className="chips"><b>Streams:</b> {detail.streams.map((s, i) => <span key={i} className="chip">{s.kind}{s.codec ? ` ${s.codec}` : ""}{s.language ? ` (${s.language})` : ""}</span>)}</div>}
                {detail.guids.length > 0 && <div className="chips muted" style={{ fontSize: 11 }}>{detail.guids.join("  ")}</div>}
                {detail.path && <div className="muted mono" style={{ fontSize: 11, marginTop: 6, wordBreak: "break-all" }}>{detail.path}</div>}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
