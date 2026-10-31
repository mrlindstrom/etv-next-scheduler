import { useEffect, useRef, useState } from "react";
import { SearchIndexCard } from "./SearchIndexCard.js";
import { api, type LibraryStatus, type SourceInfo, type LibraryInfo, type TrashItem, type ScanJob, type SourceConnection, type LibraryPath, type PathReplacement } from "../api.js";

export function Library() {
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  const [legacyImport, setLegacyImport] = useState(true); // Connect tab switch
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [libraries, setLibraries] = useState<LibraryInfo[]>([]);
  const [trash, setTrash] = useState<{ total: number; items: TrashItem[] }>({ total: 0, items: [] });
  const [manageSource, setManageSource] = useState<number | null>(null);
  const [conn, setConn] = useState<SourceConnection | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [addrInput, setAddrInput] = useState("");
  const [showManualToken, setShowManualToken] = useState(false);
  const [plexAuthing, setPlexAuthing] = useState(false);
  const [loginUser, setLoginUser] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const plexPoll = useRef<number | null>(null);
  const [scan, setScan] = useState<ScanJob | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newLib, setNewLib] = useState({ name: "", kind: 4, path: "" });
  const [addSrc, setAddSrc] = useState(false);
  const [srcForm, setSrcForm] = useState({ type: "local", serverName: "", address: "", token: "" });
  const [foldersLib, setFoldersLib] = useState<LibraryInfo | null>(null);
  const [folders, setFolders] = useState<LibraryPath[]>([]);
  const [newFolder, setNewFolder] = useState("");
  const [msg, setMsg] = useState("");
  const poll = useRef<number | null>(null);
  const scanPoll = useRef<number | null>(null);

  const loadMedia = () => {
    api.mediaSources().then(setSources).catch(() => {});
    api.mediaLibraries().then(setLibraries).catch(() => {});
    api.mediaTrash().then(setTrash).catch(() => {});
  };
  const load = () => api.libraryStatus().then((s) => {
    setStatus(s);
    if (s.job?.running && !poll.current) poll.current = window.setInterval(load, 1200);
    if (!s.job?.running && poll.current) { clearInterval(poll.current); poll.current = null; loadMedia(); }
    if (s.imported && !s.job?.running) loadMedia();
  }).catch(() => {});

  const loadScan = () => api.scanStatus().then((s) => {
    setScan(s.libraryId != null ? s : null);
    if (s.running && !scanPoll.current) scanPoll.current = window.setInterval(loadScan, 1000);
    if (!s.running && scanPoll.current) { clearInterval(scanPoll.current); scanPoll.current = null; loadMedia(); }
  }).catch(() => {});

  useEffect(() => { api.getConfig().then((c) => setLegacyImport(c.legacyImport !== false)).catch(() => {}); }, []);
  useEffect(() => { load(); loadScan(); return () => { if (poll.current) clearInterval(poll.current); if (scanPoll.current) clearInterval(scanPoll.current); if (plexPoll.current) clearInterval(plexPoll.current); }; }, []);

  const runScan = async (id: number) => {
    setMsg("");
    try {
      const r = await api.scanLibrary(id);
      if (!("running" in r)) { setMsg((r as { error: string }).error); return; }
      setScan(r); if (!scanPoll.current) scanPoll.current = window.setInterval(loadScan, 1000);
    } catch (e) { setMsg(`Scan failed (${String(e)})`); }
  };

  // load connection details when a remote source's modal opens
  const openSource = (id: number) => {
    setManageSource(id); setConn(null); setTokenInput(""); setShowManualToken(false); setLoginUser(""); setLoginPass(""); setPlexAuthing(false);
    if (plexPoll.current) { clearInterval(plexPoll.current); plexPoll.current = null; }
    const src = sources.find((s) => s.id === id);
    if (src && ["plex", "jellyfin", "emby"].includes(src.type)) {
      api.sourceConnection(id).then((c) => { setConn(c); setAddrInput(c.address ?? ""); }).catch(() => {});
    }
  };
  const refreshConn = (id: number) => api.sourceConnection(id).then(setConn).catch(() => {});

  // Plex native sign-in: open Plex's auth page, then poll until it hands us a token
  const plexSignIn = async (id: number) => {
    setMsg(""); setPlexAuthing(true);
    const r = await api.plexAuthStart(id);
    if (r.error || !r.authUrl) { setMsg(r.error ?? "Could not start Plex sign-in"); setPlexAuthing(false); return; }
    window.open(r.authUrl, "_blank", "noopener,noreferrer,width=800,height=720");
    let tries = 0;
    plexPoll.current = window.setInterval(async () => {
      tries++;
      const p = await api.plexAuthPoll(id).catch(() => ({ authorized: false }));
      if (p.authorized) { clearInterval(plexPoll.current!); plexPoll.current = null; setPlexAuthing(false); setMsg("Connected to Plex ✓"); refreshConn(id); setTimeout(() => setMsg(""), 2500); }
      else if (tries > 90) { clearInterval(plexPoll.current!); plexPoll.current = null; setPlexAuthing(false); setMsg("Plex sign-in timed out — try again."); }
    }, 2000);
  };
  const cancelPlex = () => { if (plexPoll.current) { clearInterval(plexPoll.current); plexPoll.current = null; } setPlexAuthing(false); };

  const remoteLogin = async (id: number) => {
    setMsg("");
    const r = await api.remoteLogin(id, { username: loginUser, password: loginPass, address: addrInput || undefined });
    if (r.error) { setMsg(r.error); return; }
    setLoginPass(""); setMsg("Signed in ✓"); refreshConn(id); setTimeout(() => setMsg(""), 2500);
  };
  const saveToken = async (id: number) => {
    await api.setSourceConnection(id, { token: tokenInput || undefined, address: addrInput || null });
    setTokenInput(""); setMsg("Connection saved ✓"); setTimeout(() => setMsg(""), 2000);
    api.sourceConnection(id).then(setConn).catch(() => {});
  };
  const runSourceScan = async (id: number, refresh = false) => {
    setMsg("");
    try {
      const r = await api.scanSource(id, refresh);
      if (!("running" in r)) { setMsg((r as { error: string }).error); return; }
      setScan(r); if (!scanPoll.current) scanPoll.current = window.setInterval(loadScan, 1000);
    } catch (e) { setMsg(`Scan failed (${String(e)})`); }
  };

  const runImport = async () => {
    if (status?.imported && !confirm(
      "Re-import from ErsatzTV legacy?\n\nThis REPLACES this app's library database with a fresh copy of the legacy one — " +
      "collections you created or changed here, scan results and metadata refreshes are lost.")) return;
    setMsg("");
    try {
      const r = await api.libraryImport();
      if (!("running" in r)) { setMsg((r as { error: string }).error); return; }
      if (!poll.current) poll.current = window.setInterval(load, 1200);
      load();
    } catch (e) {
      // the server refuses (409) while legacy import is switched off
      let text = String((e as Error).message ?? e);
      try { const j = JSON.parse(text); if (j.error) { setMsg(j.error); setLegacyImport(false); return; } } catch { /* not JSON */ }
      setMsg(`Import request failed (${text}). Rebuild + restart the server: npm run ui`);
    }
  };
  const toggleLibrary = async (id: number, enabled: boolean) => {
    setLibraries((ls) => ls.map((l) => l.id === id ? { ...l, enabled } : l)); // optimistic
    try { await api.setLibraryEnabled(id, enabled); } catch { loadMedia(); }
  };
  const createLib = async () => {
    setMsg("");
    const r = await api.createLibrary({ name: newLib.name, kind: newLib.kind, paths: [newLib.path] });
    if ("error" in r) { setMsg(r.error); return; }
    setShowAdd(false); setNewLib({ name: "", kind: 4, path: "" }); setMsg(`Added "${r.name}" ✓`);
    loadMedia(); setTimeout(() => setMsg(""), 2500);
  };
  const deleteLib = async (l: LibraryInfo) => {
    const extra = l.sourceType === "local" ? "" : " (a re-import would bring it back)";
    if (!confirm(`Remove library "${l.name}" and its ${(l.present + l.missing + l.remote).toLocaleString()} item(s) from this app's database?${extra} This does not touch your files or the ErsatzTV database.`)) return false;
    const r = await api.deleteLibrary(l.id);
    setMsg(`Removed "${l.name}" (${r.deleted} item(s)) ✓`);
    if (manageSource != null) api.mediaSource(manageSource).catch(() => {});
    loadMedia(); setTimeout(() => setMsg(""), 2500);
    return true;
  };
  const addSource = async () => {
    setMsg("");
    if (srcForm.type === "local") {
      const r = await api.createLibrary({ name: newLib.name, kind: newLib.kind, paths: [newLib.path] });
      if ("error" in r) { setMsg(r.error); return; }
      setAddSrc(false); setNewLib({ name: "", kind: 4, path: "" });
      setMsg(`Added "${r.name}" — click it below and hit Scan to index its files.`); loadMedia(); setTimeout(() => setMsg(""), 4000);
      return;
    }
    const r = await api.addSource(srcForm);
    if (r.error) { setMsg(r.error); return; }
    setAddSrc(false); setSrcForm({ type: "local", serverName: "", address: "", token: "" });
    setMsg("Source added — click it below to sign in, then Discover libraries."); loadMedia(); setTimeout(() => setMsg(""), 4000);
  };
  const discover = async (id: number) => {
    setMsg("Discovering libraries…");
    const r = await api.discoverSource(id);
    if (r.error) { setMsg(r.error); return; }
    setMsg(`Discovered ${r.discovered ?? 0}, added ${r.added ?? 0} new librar${r.added === 1 ? "y" : "ies"}.`);
    loadMedia(); if (manageSource != null) api.sourceConnection(manageSource).then(setConn).catch(() => {}); setTimeout(() => setMsg(""), 4000);
  };
  const deleteSource = async (id: number) => {
    const src = sources.find((s) => s.id === id);
    if (!confirm(`Delete the source "${src?.name ?? id}" and all ${src?.libraries ?? 0} of its libraries (and their items) from this app's database? Your files and the ErsatzTV database are untouched.`)) return;
    const r = await api.deleteSource(id);
    setManageSource(null);
    setMsg(`Removed source — ${r.deletedLibraries} librar${r.deletedLibraries === 1 ? "y" : "ies"}, ${r.deletedItems} item(s).`);
    loadMedia(); setTimeout(() => setMsg(""), 3500);
  };
  const openFolders = async (l: LibraryInfo) => { setFoldersLib(l); setNewFolder(""); setFolders(await api.libraryPaths(l.id).catch(() => [])); };
  const reloadFolders = async () => { if (foldersLib) setFolders(await api.libraryPaths(foldersLib.id).catch(() => [])); };
  const addFolder = async () => {
    if (!foldersLib) return;
    const r = await api.addLibraryPath(foldersLib.id, newFolder);
    if ("error" in r) { setMsg(r.error); return; }
    setNewFolder(""); reloadFolders(); loadMedia();
  };
  const editFolder = async (pid: number, cur: string) => {
    const np = prompt("Update folder path:", cur);
    if (np == null || np.trim() === cur) return;
    const r = await api.updateLibraryPath(pid, np.trim());
    if (r.error) { setMsg(r.error); return; }
    reloadFolders(); loadMedia();
  };
  const removeFolder = async (pid: number) => {
    if (!confirm("Remove this folder and its items from the library? Files on disk are untouched.")) return;
    const r = await api.removeLibraryPath(pid);
    if (r.error) { setMsg(r.error); return; }
    reloadFolders(); loadMedia();
  };
  const doEmptyTrash = async () => {
    if (!confirm(`Permanently delete ${trash.total} trashed item(s) and their metadata? This cannot be undone.`)) return;
    const r = await api.mediaTrashEmpty();
    setMsg(`Emptied trash — removed ${r.deleted} item(s).`);
    loadMedia(); setTimeout(() => setMsg(""), 3000);
  };

  const job = status?.job;
  const [tab, setTab] = useState<"libraries" | "sources" | "index" | "trash">("libraries");
  const pct = job && job.total ? Math.round((job.index / job.total) * 100) : 0;
  const scanPct = scan && scan.total ? Math.round((scan.done_ / scan.total) * 100) : 0;
  const scanningId = scan?.running ? scan.libraryId : null;
  // Each local library is its own folder source; the "Local" container behind them isn't shown
  const localLibs = libraries.filter((l) => l.sourceType === "local");
  const remoteSources = sources.filter((s) => s.type !== "local");
  const sourceRows = remoteSources.length + localLibs.length;

  return (
    <section className="screen">
      <h1>Library</h1>
      <p className="muted">
        Your media, kept in this app's own <code>library.sqlite</code>. Local folders stay current with <b>Scan</b>; Plex, Jellyfin
        and Emby libraries sync from their source. New and changed files are added; missing files are flagged, never auto-deleted.
      </p>

      <div className="card">
        <div className="stats">
          <Stat label="Status" text={status?.imported ? "Imported ✓" : "Not imported"} ok={status?.imported} />
          {status?.stats && <>
            <Stat label="media items" text={status.stats.mediaItems.toLocaleString()} />
            <Stat label="episodes" text={status.stats.episodes.toLocaleString()} />
            <Stat label="shows" text={status.stats.shows.toLocaleString()} />
            <Stat label="with chapters" text={status.stats.chapters.toLocaleString()} />
          </>}
        </div>
      </div>
      {!legacyImport && !job?.running && (
        <p className="muted" style={{ marginTop: 14, fontSize: 13 }}>ErsatzTV legacy import is turned off (migration finished). Turn it back on on the Settings page if you need to re-import.</p>
      )}
      {(legacyImport || job?.running) && <div className="actions" style={{ marginTop: 14 }}>
        <button className="primary" onClick={runImport} disabled={job?.running || !status?.source}>
          {job?.running ? "Importing…" : status?.imported ? "Re-import from ErsatzTV" : "Import from ErsatzTV"}
        </button>
        {!status?.source && <span className="muted">Set the ErsatzTV DB path on the Settings page first.</span>}
        {msg && <span className={msg.startsWith("Import request failed") ? "err" : "ok"}>{msg}</span>}
      </div>}
      {job?.running && (
        <div className="job" style={{ marginTop: 12 }}>
          <div className="job-head">Importing {job.index}/{job.total}: <b>{job.table}</b> — {pct}%</div>
          <div className="progress"><div className="bar" style={{ width: `${pct}%` }} /></div>
        </div>
      )}

      {scan && (
        <div className="job" style={{ marginTop: 12 }}>
          <div className="job-head">
            {scan.running
              ? scan.scope === "remote"
                ? <>Scanning <b>{sources.find((s) => s.id === scan.sourceId)?.name ?? `source ${scan.sourceId}`}</b> — {scan.current || "connecting…"} ({scan.done_}/{scan.total} libraries) — +{scan.added} added, ~{scan.updated} updated</>
                : <>Scanning <b>{libraries.find((l) => l.id === scan.libraryId)?.name ?? `library ${scan.libraryId}`}</b> {scan.total ? `${scan.done_}/${scan.total} (${scanPct}%)` : "…"} — +{scan.added} added, ~{scan.updated} updated</>
              : scan.error
                ? <span className="err">Scan failed: {scan.error.slice(0, 200)}</span>
                : scan.result
                  ? <>
                      <span className="ok">Scan complete — {scan.result.added} added, {scan.result.updated} updated, {scan.result.missing} newly missing, {scan.result.unchanged} unchanged{scan.result.errors ? `, ${scan.result.errors} errors` : ""}.</span>
                      {scan.warning && <div className="err" style={{ marginTop: 4 }}>⚠ {scan.warning}</div>}
                      {scan.note && <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>{scan.note}</div>}
                    </>
                  : null}
          </div>
          {scan.running && <><div className="progress"><div className="bar" style={{ width: `${scanPct}%` }} /></div>{scan.current && <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>{scan.current}</div>}</>}
        </div>
      )}

      {status?.imported && (
        <>
          <div className="subtabs" style={{ marginTop: 18 }}>
            {([["libraries", `Libraries (${libraries.filter((l) => l.enabled).length})`], ["sources", `Sources (${sourceRows})`], ["index", "Search index"], ["trash", `Trash${trash.total ? ` (${trash.total})` : ""}`]] as const).map(([id, label]) => (
              <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>

          {tab === "index" && <SearchIndexCard />}

          {tab === "sources" && <>
          <div className="pane-head"><p className="muted" style={{ margin: 0 }}>Click a source to manage it: sign in and pick libraries for a server, or edit folders and scan a local folder.</p><button onClick={() => setAddSrc((v) => !v)}>{addSrc ? "Cancel" : "+ Add media source"}</button></div>
          {addSrc && (
            <div className="meta-card" style={{ marginBottom: 12 }}>
              <label style={{ maxWidth: 260 }}>Type
                <select value={srcForm.type} onChange={(e) => setSrcForm({ ...srcForm, type: e.target.value })}>
                  <option value="local">Local folder</option><option value="plex">Plex</option><option value="jellyfin">Jellyfin</option><option value="emby">Emby</option>
                </select>
              </label>
              {srcForm.type === "local" ? <>
                <p className="muted">Point at a folder on this machine. After adding, open it below and hit <b>Scan</b> to index the files.</p>
                <div className="row">
                  <label style={{ flex: 2 }}>Name<input value={newLib.name} onChange={(e) => setNewLib({ ...newLib, name: e.target.value })} placeholder="e.g. Commercials" /></label>
                  <label style={{ flex: 1 }}>Media type
                    <select value={newLib.kind} onChange={(e) => setNewLib({ ...newLib, kind: Number(e.target.value) })}>
                      <option value={1}>Movies</option><option value={2}>Shows</option><option value={3}>Music Videos</option>
                      <option value={4}>Other Videos</option><option value={5}>Songs</option><option value={6}>Images</option>
                    </select>
                  </label>
                </div>
                <label>Folder path<input value={newLib.path} onChange={(e) => setNewLib({ ...newLib, path: e.target.value })} placeholder="X:\Commercials  or  /media/commercials" /></label>
                <div className="actions"><button className="primary" onClick={addSource} disabled={!newLib.name || !newLib.path}>Add folder</button></div>
              </> : <>
                <p className="muted">Connect a Plex, Jellyfin, or Emby server. After it's added, open it below to sign in, then <b>Discover libraries</b>.</p>
                <div className="row">
                  <label style={{ flex: 1 }}>Server name<input value={srcForm.serverName} onChange={(e) => setSrcForm({ ...srcForm, serverName: e.target.value })} placeholder="My Plex" /></label>
                  <label style={{ flex: 2 }}>Server address<input value={srcForm.address} onChange={(e) => setSrcForm({ ...srcForm, address: e.target.value })} placeholder="http://10.0.0.5:32400" /></label>
                </div>
                {srcForm.type !== "plex" && <label>API key (optional now — you can sign in after)<input type="password" value={srcForm.token} onChange={(e) => setSrcForm({ ...srcForm, token: e.target.value })} /></label>}
                <div className="actions"><button className="primary" onClick={addSource} disabled={!srcForm.address}>Add source</button></div>
              </>}
            </div>
          )}
          <table className="history">
            <thead><tr><th>Type</th><th>Name</th><th>Libraries / folders</th><th>Items</th></tr></thead>
            <tbody>
              {remoteSources.map((s) => {
                const on = libraries.filter((l) => l.sourceId === s.id && l.enabled).length;
                const total = libraries.filter((l) => l.sourceId === s.id).length;
                return (
                  <tr key={`s${s.id}`} className="clickable" onClick={() => openSource(s.id)}>
                    <td><span className={`badge ${s.type}`}>{s.type}</span></td><td>{s.name}</td>
                    <td>{on} / {total} libraries{on < total && <span className="muted"> · {total - on} off</span>}</td><td>{s.items.toLocaleString()}</td>
                  </tr>
                );
              })}
              {localLibs.map((l) => (
                <tr key={`l${l.id}`} className={`clickable${l.enabled ? "" : " row-off"}`} onClick={() => openFolders(l)}>
                  <td><span className="badge local">local</span></td><td>{l.name}{!l.enabled && <span className="muted"> · off</span>}</td>
                  <td className="mono muted" style={{ wordBreak: "break-all" }}>{l.paths[0] ?? "no folders"}{l.paths.length > 1 && ` + ${l.paths.length - 1} more`}</td>
                  <td>{l.present.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </>}

          {tab === "libraries" && <>
          <div className="pane-head">
            <p className="muted" style={{ margin: 0 }}>Libraries in use for scheduling. Turn libraries on or off from their source on the Sources tab.</p>
            <button onClick={() => setShowAdd((v) => !v)}>{showAdd ? "Cancel" : "+ Add local library"}</button>
          </div>

          {showAdd && (
            <div className="meta-card" style={{ marginBottom: 12 }}>
              <p className="muted" style={{ marginTop: 0 }}>Point at a folder on this machine. After adding, use its <b>Scan</b> button to index the files.</p>
              <div className="row">
                <label style={{ flex: 2 }}>Name<input value={newLib.name} onChange={(e) => setNewLib({ ...newLib, name: e.target.value })} placeholder="e.g. Commercials" /></label>
                <label style={{ flex: 1 }}>Type
                  <select value={newLib.kind} onChange={(e) => setNewLib({ ...newLib, kind: Number(e.target.value) })}>
                    <option value={1}>Movies</option><option value={2}>Shows</option><option value={3}>Music Videos</option>
                    <option value={4}>Other Videos</option><option value={5}>Songs</option><option value={6}>Images</option>
                  </select>
                </label>
              </div>
              <label>Folder path<input value={newLib.path} onChange={(e) => setNewLib({ ...newLib, path: e.target.value })} placeholder="X:\Commercials  or  /media/commercials" /></label>
              <div className="actions"><button className="primary" onClick={createLib} disabled={!newLib.name || !newLib.path}>Add library</button></div>
            </div>
          )}

          <table className="history">
            <thead><tr><th>Library</th><th>Kind</th><th>Source</th><th>Present</th><th>Missing</th><th>Remote</th><th>Last scan</th><th></th></tr></thead>
            <tbody>{libraries.filter((l) => l.enabled).map((l) => (
              <tr key={l.id}>
                <td>{l.name}</td><td>{l.kind}</td><td><span className={`badge ${l.sourceType}`}>{l.sourceType}</span> {l.sourceName}</td>
                <td>{l.present.toLocaleString()}</td>
                <td className={l.missing ? "err" : "muted"}>{l.missing || "–"}</td>
                <td className="muted">{l.remote ? l.remote.toLocaleString() : "–"}</td>
                <td className="muted">{l.lastScan ? new Date(l.lastScan).toLocaleDateString() : "never"}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {scan?.running && scan.libraryId === l.id ? (
                    <span className="scanning-inline">
                      <span className="spinner" />
                      {scan.total > 1
                        ? <><span className="pct">{scanPct}%</span><span className="muted">{scan.done_.toLocaleString()}/{scan.total.toLocaleString()}</span></>
                        : <span className="muted">scanning… {scan.added ? `+${scan.added}` : ""}</span>}
                    </span>
                  ) : l.sourceType !== "local" && l.hasToken === false ? (
                    <button onClick={() => openSource(l.sourceId)} title={`Sign in to ${l.sourceName} to enable scanning`}>Sign in to scan</button>
                  ) : (
                    <button onClick={() => runScan(l.id)} disabled={!!scan?.running} title={l.sourceType === "local" ? "Scan this folder" : `Rescan this ${l.sourceType} library`}>Scan</button>
                  )}
                  {l.sourceType === "local" && <button style={{ marginLeft: 6 }} onClick={() => openFolders(l)} title="View / edit this library's folders">Folders ({l.paths.length})</button>}
                  <button className="danger" style={{ marginLeft: 6 }} onClick={() => deleteLib(l)} disabled={!!scan?.running && scan.libraryId === l.id}>Remove</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
          </>}

          {manageSource != null && (
            <div className="modal-overlay" onClick={() => setManageSource(null)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="pane-head">
                  <h2 style={{ margin: 0 }}>{sources.find((s) => s.id === manageSource)?.name} — libraries</h2>
                  <div>
                    <button className="danger" onClick={() => deleteSource(manageSource!)}>Delete source</button>
                    <button style={{ marginLeft: 6 }} onClick={() => setManageSource(null)}>✕</button>
                  </div>
                </div>
                <p className="muted">Turn a library off to stop syncing it and exclude its items from scheduling (survives re-import).</p>

                {conn && conn.type && (
                  <div className="meta-card" style={{ marginBottom: 14 }}>
                    <div className="job-head" style={{ textTransform: "capitalize" }}>{conn.type} connection {conn.hasToken && <span className="ok" style={{ fontSize: 12 }}>· signed in ✓</span>}</div>

                    {conn.type === "plex" ? (
                      <>
                        <p className="muted" style={{ marginTop: 4 }}>Sign in with your Plex account — a Plex window opens, you approve, and the token is captured automatically. Nothing is typed here.</p>
                        <div className="actions">
                          {!plexAuthing
                            ? <button className="primary" onClick={() => plexSignIn(manageSource!)}>{conn.hasToken ? "Re-authorize with Plex" : "Sign in with Plex"}</button>
                            : <><span className="muted">Waiting for Plex approval… (a Plex tab opened)</span><button onClick={cancelPlex}>Cancel</button></>}
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="muted" style={{ marginTop: 4 }}>Sign in with your {conn.type} username and password — the app exchanges them for an access token and stores only the token.</p>
                        <div className="row">
                          <label style={{ flex: 2 }}>Server address<input value={addrInput} onChange={(e) => setAddrInput(e.target.value)} placeholder={conn.importedAddress ?? "http://host:port"} /></label>
                          <label style={{ flex: 1 }}>Username<input value={loginUser} onChange={(e) => setLoginUser(e.target.value)} /></label>
                          <label style={{ flex: 1 }}>Password<input type="password" value={loginPass} onChange={(e) => setLoginPass(e.target.value)} /></label>
                        </div>
                        <div className="actions"><button className="primary" onClick={() => remoteLogin(manageSource!)}>Sign in</button></div>
                      </>
                    )}

                    <div className="actions" style={{ marginTop: 8 }}>
                      <button onClick={() => runSourceScan(manageSource!)} disabled={!!scan?.running || !conn.hasToken}>{scan?.running && scan.sourceId === manageSource ? "Scanning…" : "Scan source"}</button>
                      <button onClick={() => runSourceScan(manageSource!, true)} disabled={!!scan?.running || !conn.hasToken} title="Scan and re-fetch full metadata for every item and show (cast, crew, ratings, guids, networks) — slower; use once to backfill">Refresh metadata</button>
                      <button onClick={() => discover(manageSource!)} disabled={!conn.hasToken} title="Fetch this server's library list and add any new ones">Discover libraries</button>
                      <span className="muted">{conn.libraries.length} scannable librar{conn.libraries.length === 1 ? "y" : "ies"}</span>
                      {!showManualToken && <button onClick={() => setShowManualToken(true)} style={{ background: "none", border: "none", color: "#3b82f6", cursor: "pointer", padding: 0, textDecoration: "underline", fontSize: 12 }}>paste a token manually</button>}
                    </div>

                    {showManualToken && (
                      <div className="row" style={{ marginTop: 8 }}>
                        <label style={{ flex: 2 }}>Server address<input value={addrInput} onChange={(e) => setAddrInput(e.target.value)} placeholder={conn.importedAddress ?? "http://host:port"} /></label>
                        <label style={{ flex: 2 }}>{conn.type === "plex" ? "X-Plex-Token" : "API key / token"}
                          <input type="password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} placeholder={conn.hasToken ? "•••••• (leave blank to keep)" : "paste token"} />
                        </label>
                        <button className="primary" style={{ alignSelf: "end" }} onClick={() => saveToken(manageSource!)}>Save</button>
                      </div>
                    )}
                  </div>
                )}

                {conn && conn.type && <PathReplacementsEditor sourceId={manageSource!} />}

                <table className="history">
                  <thead><tr><th>On</th><th>Library</th><th>Kind</th><th>Items</th></tr></thead>
                  <tbody>{libraries.filter((l) => l.sourceId === manageSource).map((l) => (
                    <tr key={l.id} className={l.enabled ? "" : "row-off"}>
                      <td><label className="switch"><input type="checkbox" checked={l.enabled} onChange={(e) => toggleLibrary(l.id, e.target.checked)} /></label></td>
                      <td>{l.name}</td><td>{l.kind}</td><td>{(l.present + l.remote).toLocaleString()}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </div>
          )}

          {tab === "trash" && <>
          <p className="muted">Items whose files are gone are flagged, never auto-deleted (matching ErsatzTV). Review, then empty manually.</p>
          {trash.total > 0 && (
            <>
              <div className="actions"><button className="danger" onClick={doEmptyTrash}>Empty trash ({trash.total})</button></div>
              <pre className="log" style={{ maxHeight: 220, marginTop: 10 }}>{trash.items.map((t) => `[${t.stateName}] ${t.path ?? "(no file)"}`).join("\n")}</pre>
            </>
          )}
          {trash.total === 0 && <p className="ok">No missing files. ✓</p>}
          </>}
        </>
      )}

      {foldersLib && (
        <div className="modal-overlay" onClick={() => setFoldersLib(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="pane-head">
              <h2 style={{ margin: 0 }}>{foldersLib.name} — folders</h2>
              <div style={{ whiteSpace: "nowrap" }}>
                <button className="danger" onClick={async () => { if (await deleteLib(foldersLib)) setFoldersLib(null); }} disabled={!!scan?.running && scan.libraryId === foldersLib.id}>Remove</button>
                <button style={{ marginLeft: 6 }} onClick={() => setFoldersLib(null)}>✕</button>
              </div>
            </div>
            {(() => {
              const live = libraries.find((l) => l.id === foldersLib.id) ?? foldersLib;
              return (
                <div className="actions">
                  <label className="switch" title="Off: skip it when scanning and leave its items out of scheduling"><input type="checkbox" checked={live.enabled} onChange={(e) => toggleLibrary(live.id, e.target.checked)} /></label>
                  <span>{live.enabled ? "On" : "Off"}</span>
                  <button onClick={() => runScan(live.id)} disabled={!!scan?.running}>{scan?.running && scan.libraryId === live.id ? `Scanning… ${scanPct}%` : "Scan"}</button>
                  <span className="muted">{live.kind} · {live.present.toLocaleString()} items · last scan {live.lastScan ? new Date(live.lastScan).toLocaleDateString() : "never"}</span>
                </div>
              );
            })()}
            <p className="muted">Folders this local library scans. Add more, edit a path, or remove one. Removing a folder deletes its items from the library (not the files on disk); a rescan re-indexes. <b>Remove</b> at the top removes just this library.</p>
            <table className="history">
              <thead><tr><th>Folder</th><th>Present</th><th>Missing</th><th></th></tr></thead>
              <tbody>{folders.map((p) => (
                <tr key={p.id}>
                  <td className="mono" style={{ wordBreak: "break-all" }}>{p.path}</td>
                  <td>{p.present.toLocaleString()}</td>
                  <td className={p.missing ? "err" : "muted"}>{p.missing || "–"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button onClick={() => editFolder(p.id, p.path)}>Edit</button>
                    <button className="danger" style={{ marginLeft: 6 }} onClick={() => removeFolder(p.id)}>Remove</button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
            <div className="row" style={{ marginTop: 10 }}>
              <label style={{ flex: 3 }}>Add a folder<input value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="X:\More Commercials  or  /media/more" /></label>
              <button className="primary" style={{ alignSelf: "end" }} onClick={addFolder} disabled={!newFolder}>Add folder</button>
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>After changing folders, hit <b>Scan</b> on the library to index them.</p>
          </div>
        </div>
      )}
    </section>
  );
}

function Stat({ label, text, ok }: { label: string; text?: string; ok?: boolean }) {
  return <div className="stat"><div className="num" style={ok ? { color: "#22c55e" } : undefined}>{text}</div><div className="lbl">{label}</div></div>;
}

// Map a remote source's media paths to paths this app can read on disk. Needed so
// the app can open the actual files (e.g. to ffprobe embedded chapters / HDR).
function PathReplacementsEditor({ sourceId }: { sourceId: number }) {
  const [reps, setReps] = useState<PathReplacement[]>([]);
  const [sourceType, setSourceType] = useState("");
  const [draftRemote, setDraftRemote] = useState("");
  const [draftLocal, setDraftLocal] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api.pathReplacements(sourceId).then((r) => { setReps(r.replacements); setSourceType(r.sourceType); }).catch(() => {});
  useEffect(() => { load(); }, [sourceId]);

  const add = async () => {
    if (!draftRemote.trim() || !draftLocal.trim()) return;
    setBusy(true); await api.addPathReplacement(sourceId, draftRemote.trim(), draftLocal.trim());
    setDraftRemote(""); setDraftLocal(""); await load(); setBusy(false);
  };
  const patch = (id: number, k: "remote" | "local", v: string) => setReps((rs) => rs.map((r) => r.id === id ? { ...r, [k]: v } : r));
  const save = async (r: PathReplacement) => { await api.updatePathReplacement(sourceId, r.id, r.remote, r.local); load(); };
  const del = async (id: number) => { await api.removePathReplacement(sourceId, id); load(); };

  return (
    <div className="job" style={{ marginTop: 10 }}>
      <div className="job-head">Path replacements</div>
      <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        Map the path this {sourceType || "server"} reports for a file to a path this app can read on disk, so it can open the
        actual media (e.g. to ffprobe embedded chapters and HDR). Same idea as ErsatzTV's path replacements —
        replace the leading portion of the path.
      </p>
      <table className="history">
        <thead><tr><th>Server path (starts with)</th><th></th><th>Local path</th><th></th></tr></thead>
        <tbody>
          {reps.map((r) => (
            <tr key={r.id}>
              <td><input value={r.remote} onChange={(e) => patch(r.id, "remote", e.target.value)} placeholder="C:\\Media" /></td>
              <td className="muted">→</td>
              <td><input value={r.local} onChange={(e) => patch(r.id, "local", e.target.value)} placeholder="/mnt/media" /></td>
              <td style={{ whiteSpace: "nowrap" }}>
                <button onClick={() => save(r)}>Save</button>
                <button className="danger" style={{ marginLeft: 6 }} onClick={() => del(r.id)}>✕</button>
              </td>
            </tr>
          ))}
          <tr>
            <td><input value={draftRemote} onChange={(e) => setDraftRemote(e.target.value)} placeholder="C:\\Media" /></td>
            <td className="muted">→</td>
            <td><input value={draftLocal} onChange={(e) => setDraftLocal(e.target.value)} placeholder="/mnt/media" /></td>
            <td><button className="primary" onClick={add} disabled={busy || !draftRemote.trim() || !draftLocal.trim()}>Add</button></td>
          </tr>
        </tbody>
      </table>
      {reps.length === 0 && <p className="muted" style={{ fontSize: 12 }}>No path replacements — if this server reports the same paths the app can already read (e.g. it runs on this machine), you may not need any.</p>}
    </div>
  );
}
