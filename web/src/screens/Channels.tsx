import { useEffect, useMemo, useRef, useState } from "react";
import { api, logoSrc, type ChannelSummary, type ChannelMeta, type SchemaField, type SchedulingModuleInfo, type RemoteProbe } from "../api.js";
import { SchemaForm } from "../SchemaForm.js";
import { FallbackPicker } from "../FallbackPicker.js";
import { PodScheduler } from "./PodScheduler.js";
import { GridScheduler } from "./GridScheduler.js";
import { LegacyImport } from "./LegacyImport.js";
import { compareChannelNumbers, normalizeChannelNumber } from "../channelNumbers.js";
import { navigate } from "../nav.js";
import { OverlayPicker } from "../OverlayPicker.js";

// Common audio/subtitle languages (ISO 639-2 codes, matching ErsatzTV).
const LANGS: { code: string; label: string }[] = [
  { code: "eng", label: "English" }, { code: "spa", label: "Spanish" },
  { code: "fre", label: "French" }, { code: "ger", label: "German" },
  { code: "ita", label: "Italian" }, { code: "por", label: "Portuguese" },
  { code: "rus", label: "Russian" }, { code: "jpn", label: "Japanese" },
  { code: "kor", label: "Korean" }, { code: "chi", label: "Chinese" },
  { code: "dut", label: "Dutch" },
];

// Fallback "coming up next" designs if the server theme list can't be fetched
// (the live list comes from /api/upnext/themes, i.e. the runtime/upnext-themes folder).
const UPNEXT_THEMES_FALLBACK: { id: string; label: string }[] = [
  { id: "splat", label: "Splat Orange" },
  { id: "slime", label: "Slime Night" },
  { id: "clock", label: "Big Clock" },
  { id: "chips", label: "Chip Stack" },
];

type ChannelSort = "number" | "name";
const SORT_KEY = "channels.sort";
const readSort = (): ChannelSort => { try { return localStorage.getItem(SORT_KEY) === "name" ? "name" : "number"; } catch { return "number"; } };

export function Channels({ onNavigate }: { onNavigate?: (tab: string) => void } = {}) {
  const [list, setList] = useState<ChannelSummary[]>([]);
  const [modules, setModules] = useState<SchedulingModuleInfo[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [editor, setEditor] = useState<"yaml" | "form" | "pods" | "grid">("yaml");
  const [schema, setSchema] = useState<SchemaField[] | null>(null);
  const [text, setText] = useState("");        // yaml editor
  const [form, setForm] = useState<any>(null);  // form editor value
  const [summary, setSummary] = useState<any>(null);
  const [meta, setMeta] = useState<ChannelMeta | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [legacyImport, setLegacyImport] = useState(true); // Connect tab switch
  useEffect(() => { api.getConfig().then((c) => setLegacyImport(c.legacyImport !== false)).catch(() => {}); }, []);
  const [needsPublish, setNeedsPublish] = useState(false);
  const [publishMsg, setPublishMsg] = useState("");
  const publish = async () => {
    setPublishMsg("Publishing…");
    try {
      await api.applyNext();
      const st = await api.nextRunner().catch(() => null);
      if (st && (st.phase === "running" || st.stale)) { await api.nextRestart(); setPublishMsg("Published and ErsatzTV next restarted ✓"); }
      else setPublishMsg("Published ✓");
      setNeedsPublish(false);
    } catch (e) { setPublishMsg(`Publish failed: ${String(e)}`); }
  };
  const [newCh, setNewCh] = useState({ name: "", mode: "schedule" });
  const [msg, setMsg] = useState("");
  const [pane, setPane] = useState<"schedule" | "settings" | "logo">("schedule");
  const [filter, setFilter] = useState("");
  const [building, setBuilding] = useState(false);
  const [renaming, setRenaming] = useState<{ to: string; keepGuideId: boolean; busy: boolean; error: string } | null>(null);
  const doRename = async () => {
    if (!sel || !renaming) return;
    const to = renaming.to.trim();
    if (!to || to === sel) { setRenaming(null); return; }
    setRenaming({ ...renaming, busy: true, error: "" });
    const r: Awaited<ReturnType<typeof api.renameChannel>> = await api.renameChannel(sel, to, renaming.keepGuideId).catch((e) => ({ error: String(e) }));
    if (r.error || !r.name) { setRenaming({ ...renaming, busy: false, error: r.error ?? "Rename failed." }); return; }
    setRenaming(null);
    open(r.name, await refresh());
    setNeedsPublish(true);
    flash(`Renamed to ${r.name} ✓${r.timeshiftUpdated?.length ? ` (also updated ${r.timeshiftUpdated.join(", ")})` : ""}`);
  };
  const [upNextThemes, setUpNextThemes] = useState<{ id: string; label: string }[]>([]);

  const [sortBy, setSortBy] = useState<ChannelSort>(readSort);
  const changeSort = (s: ChannelSort) => { setSortBy(s); try { localStorage.setItem(SORT_KEY, s); } catch { /* storage unavailable */ } };
  const byName = (a: ChannelSummary, b: ChannelSummary) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const sorted = useMemo(() => [...list].sort(sortBy === "name" ? byName : (a, b) => compareChannelNumbers(a.meta?.number ?? "", b.meta?.number ?? "") || byName(a, b)), [list, sortBy]);
  // channel numbers used by more than one channel: normalized number -> names
  const shared = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const c of list) { const k = normalizeChannelNumber(c.meta?.number); if (k) by.set(k, [...(by.get(k) ?? []), c.name]); }
    return new Map([...by].filter(([, names]) => names.length > 1));
  }, [list]);
  const sharedWith = (c: ChannelSummary) => (shared.get(normalizeChannelNumber(c.meta?.number)) ?? []).filter((n) => n !== c.name);

  // returns the fresh list too: callers that open a channel right after must read
  // its settings from this, not from `list` (state still holds the old list then)
  const refresh = (): Promise<ChannelSummary[]> => api.channels().then((l) => { setList(l); return l; }).catch(() => { setList([]); return []; });
  useEffect(() => {
    refresh();
    api.schedulingModules().then(setModules).catch(() => {});
    api.upNextThemes().then(setUpNextThemes).catch(() => {});
  }, []);

  const open = async (name: string, fresh?: ChannelSummary[]) => {
    setSel(name); setMsg("");
    window.history.replaceState({}, "", `/channels?c=${encodeURIComponent(name)}`);
    const c = await api.channel(name);
    setEditor(c.editor); setSchema(c.schema); setSummary(c.summary);
    if (c.editor === "form" || c.editor === "pods" || c.editor === "grid") { try { setForm(JSON.parse(c.config || "{}")); } catch { setForm({}); } setText(""); }
    else { setText(c.config); setForm(null); }
    setMeta((fresh ?? list).find((x) => x.name === name)?.meta ?? null);
  };
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current || !list.length) return;
    deepLinked.current = true;
    const c = new URLSearchParams(window.location.search).get("c");
    if (c && list.some((x) => x.name === c)) open(c);
  }, [list]);
  const buildNow = async () => {
    if (!sel || building) return;
    setBuilding(true); setMsg("Building…");
    try {
      const { jobId } = await api.build(sel);
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const j = await api.job(jobId);
        if (j.status === "done" || j.status === "error") {
          const err = j.results.find((r) => r.error)?.error;
          flash(err ? `Error: ${err}` : `Built ✓ ${j.results[0]?.itemCount ?? ""} items`.trim());
          break;
        }
      }
    } catch (e) { setMsg(`Error: ${errText(e)}`); }
    finally { setBuilding(false); }
  };
  const configString = () => (editor === "form" || editor === "pods" || editor === "grid" ? JSON.stringify(form ?? {}, null, 2) : text);
  const save = async () => {
    if (!sel) return;
    try { const r = await api.saveChannel(sel, configString()); if ((r as any).summary && !(r as any).summary.valid) { setSummary((r as any).summary); flash("Invalid: " + (r as any).summary.error); return; } setSummary((r as any).summary); flash("Saved ✓ Use Build now to put the changes on air."); refresh(); }
    catch (e) { flash("Error: " + String(e)); }
  };
  const saveMeta = async () => {
    if (!sel || !meta) return;
    try {
      const before = list.find((c) => c.name === sel)?.meta;
      const m = await api.setChannelMeta(sel, meta); setMeta(m); flash("Channel settings saved ✓"); refresh();
      // lineup-visible settings only reach ErsatzTV next when the lineup is published
      if (before && (before.number !== m.number || before.enabled !== m.enabled || before.tvgId !== m.tvgId || before.logo !== m.logo || before.group !== m.group)) setNeedsPublish(true);
    }
    catch (e) { let t = String((e as Error).message ?? e); try { t = JSON.parse(t).error ?? t; } catch { /* plain text */ } setMsg(`Error: ${t}`); }
  };
  const del = async () => { if (!sel) return; if (!confirm(`Delete channel "${sel}"? This removes its config and guide.`)) return; await api.deleteChannel(sel); setSel(null); setMeta(null); refresh(); };
  const create = async () => {
    if (!newCh.name) return;
    await api.createChannel(newCh.name, newCh.mode);
    setCreating(false); setNewCh({ name: "", mode: "schedule" }); open(newCh.name, await refresh());
  };
  // logos are saved as soon as they're uploaded/removed (not with "Save channel settings")
  const [logoBusy, setLogoBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const logoInput = useRef<HTMLInputElement>(null);
  const logoChanged = (m: ChannelMeta, text: string) => {
    setMeta((cur) => (cur ? { ...cur, logo: m.logo, logoGenerated: m.logoGenerated } : m));
    setList((l) => l.map((c) => (c.name === m.name && c.meta ? { ...c, meta: { ...c.meta, logo: m.logo, logoGenerated: m.logoGenerated } } : c)));
    setNeedsPublish(true); flash(text);
  };
  const errText = (e: unknown) => { let t = String((e as Error).message ?? e); try { t = JSON.parse(t).error ?? t; } catch { /* plain text */ } return t; };
  const uploadLogo = async (f: File) => {
    if (!sel) return;
    if (f.size > 10 * 1024 * 1024) { setMsg("Error: that image is over 10 MB."); return; }
    setLogoBusy(true);
    try { logoChanged(await api.uploadChannelLogo(sel, f), "Logo saved ✓"); }
    catch (e) { setMsg(`Error: ${errText(e)}`); }
    finally { setLogoBusy(false); }
  };
  // removing a logo switches back to one drawn from the channel name (as legacy does)
  const useNameLogo = async (ask: boolean) => {
    if (!sel || (ask && !confirm(`Replace ${sel}'s logo with one showing the channel name?`))) return;
    setLogoBusy(true);
    try { const m = await api.removeChannelLogo(sel); logoChanged(m, m.logo ? "Using the channel-name logo ✓" : "Logo removed ✓"); }
    catch (e) { setMsg(`Error: ${errText(e)}`); }
    finally { setLogoBusy(false); }
  };
  // mass renumber: preview first, then apply (keeps the current number order)
  type RenumberPlan = Awaited<ReturnType<typeof api.renumberChannels>>;
  const [renumber, setRenumber] = useState<RenumberPlan | null>(null);
  const [renumberBusy, setRenumberBusy] = useState(false);
  const previewRenumber = async (start: number) => {
    try { setRenumber(await api.renumberChannels(false, start)); } catch (e) { setMsg(`Error: ${errText(e)}`); }
  };
  const applyRenumber = async () => {
    if (!renumber) return;
    setRenumberBusy(true);
    try {
      const r = await api.renumberChannels(true, renumber.start);
      await refresh();
      if (sel) { const m = r.plan.find((p) => p.name === sel); if (m) setMeta((cur) => (cur ? { ...cur, number: m.to } : cur)); }
      setRenumber(null); setNeedsPublish(true);
      flash(`Renumbered ${r.changed} channel${r.changed === 1 ? "" : "s"} ✓`);
    } catch (e) { setMsg(`Error: ${errText(e)}`); }
    finally { setRenumberBusy(false); }
  };
  const noLogo = list.filter((c) => c.meta && !c.meta.logo);
  const generateLogos = async () => {
    setLogoBusy(true);
    try {
      const r = await api.generateMissingLogos();
      const fresh = await refresh();
      if (sel && r.generated.includes(sel)) open(sel, fresh);
      if (r.generated.length) { setNeedsPublish(true); flash(`Generated ${r.generated.length} logo${r.generated.length === 1 ? "" : "s"} ✓`); }
      else setMsg("Error: no logos could be generated.");
    } catch (e) { setMsg(`Error: ${errText(e)}`); }
    finally { setLogoBusy(false); }
  };
  const resetProgress = async () => { if (!sel) return; if (!confirm(`Reset "${sel}" playout progress?`)) return; await api.resetChannelProgress(sel); flash("Playout progress reset ✓"); };
  const flash = (t: string) => { setMsg(t); setTimeout(() => setMsg(""), 2500); };
  const updMeta = (k: keyof ChannelMeta) => (e: React.ChangeEvent<HTMLInputElement>) => setMeta((m) => m ? { ...m, [k]: k === "enabled" ? e.target.checked : e.target.value } : m);
  const updMetaVal = (k: keyof ChannelMeta) => (v: string | string[]) => setMeta((m) => m ? { ...m, [k]: v } : m);
  // the card music must exist on this machine, or the card airs silent
  const [audioMissing, setAudioMissing] = useState(false);
  // the Streaming page's fallback, named in the channel's "Default (…)" choice
  const [fallbackDefault, setFallbackDefault] = useState("black");
  useEffect(() => { api.getNextConfig().then((c) => setFallbackDefault(c.fallbackImage || "black")).catch(() => {}); }, []);
  const audioPath = meta?.upNextAudio?.trim() ?? "";
  useEffect(() => {
    if (!audioPath) { setAudioMissing(false); return; }
    const t = window.setTimeout(() => api.fileExists(audioPath).then((r) => setAudioMissing(!r.exists)).catch(() => {}), 400);
    return () => clearTimeout(t);
  }, [audioPath]);

  const summaryLine = (s: any, mode?: string) => {
    if (!s?.valid) return <span className="err">{s?.error ?? "invalid"}</span>;
    if (s.line) return <span className="ok">valid · {s.line}</span>;
    if (mode === "grid") return <span className="ok">valid · {s.programs} show{s.programs === 1 ? "" : "s"} · {s.cells} slot{s.cells === 1 ? "" : "s"}{s.seasons > 1 ? ` · ${s.seasons} lineups` : ""}{s.events ? ` · ${s.events} event${s.events === 1 ? "" : "s"}` : ""}</span>;
    if (mode === "schedule" || s.blocks != null && s.contentDefs == null) return <span className="ok">valid · {s.blocks} block{s.blocks === 1 ? "" : "s"}{s.ads ? ` · ${s.ads} with ads` : ""}</span>;
    return <span className="ok">valid · {s.dayparts ? `${s.dayparts} dayparts` : `${s.blocks} blocks`} · {s.sequences} sequences{s.pods ? ` · ${s.pods} pods` : ""}</span>;
  };
  const selMode = list.find((c) => c.name === sel)?.mode;

  return (
    <section className="screen split">
      <div className="list-pane">
        <div className="pane-head"><h2>Channels</h2><div>{legacyImport && <><button onClick={() => { setImporting((v) => !v); setSel(null); }} title="Import channels and their Classic, Block and YAML schedules from ErsatzTV legacy">{importing ? "Close import" : "Import…"}</button> </>}<button onClick={() => setCreating((v) => !v)}>{creating ? "Cancel" : "+ New"}</button></div></div>
        {creating && (
          <div className="meta-card" style={{ marginBottom: 10 }}>
            <label>Name<input value={newCh.name} onChange={(e) => setNewCh({ ...newCh, name: e.target.value })} placeholder="Saturday Mornings" /></label>
            <label>Scheduling mode
              <select value={newCh.mode} onChange={(e) => setNewCh({ ...newCh, mode: e.target.value })}>
                {modules.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
            <p className="muted" style={{ fontSize: 12 }}>{modules.find((m) => m.id === newCh.mode)?.description}</p>
            <div className="actions"><button className="primary" onClick={create} disabled={!newCh.name}>Create</button></div>
          </div>
        )}
        {list.length === 0 && !creating && <p className="muted">No channels yet. {legacyImport ? <><button onClick={() => { setImporting(true); setSel(null); }}>Import from ErsatzTV legacy…</button> or create</> : "Create"} one with + New.</p>}
        {needsPublish && (
          <div className="meta-card" style={{ fontSize: 12, marginBottom: 8 }}>
            Channel number/lineup changes reach ErsatzTV next when the lineup is published (the guide lists channels in number order).
            <div className="actions" style={{ marginTop: 6 }}><button className="primary" onClick={publish}>Publish lineup now</button><button onClick={() => setNeedsPublish(false)}>Later</button></div>
          </div>
        )}
        {noLogo.length > 0 && (
          <div className="meta-card" style={{ fontSize: 12, marginBottom: 8 }}>
            {noLogo.length} channel{noLogo.length === 1 ? " has" : "s have"} no logo, so TV apps show a blank icon. Generate logos that show each channel's name; you can upload a real one any time.
            <div className="actions" style={{ marginTop: 6 }}><button className="primary" onClick={generateLogos} disabled={logoBusy}>Generate name logos</button></div>
          </div>
        )}
        {publishMsg && !needsPublish && <div className={publishMsg.startsWith("Publish failed") ? "err" : "ok"} style={{ fontSize: 12, marginBottom: 8 }}>{publishMsg}</div>}
        {shared.size > 0 && (
          <div className="err" style={{ fontSize: 12, marginBottom: 8 }}>
            ⚠ {shared.size} channel number{shared.size === 1 ? " is" : "s are"} used by more than one channel ({[...shared.keys()].sort(compareChannelNumbers).join(", ")}). Channel numbers must be unique — open one of each pair and change its Channel #.
          </div>
        )}
        {list.length > 1 && (
          <div className="muted" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 6 }}>
            Sort by
            {(["number", "name"] as const).map((s) => (
              <button key={s} onClick={() => changeSort(s)} aria-pressed={sortBy === s} className={sortBy === s ? "primary" : ""} style={{ padding: "2px 10px", fontSize: 12 }}>
                {s === "number" ? "#" : "Name"}
              </button>
            ))}
            <button onClick={() => (renumber ? setRenumber(null) : previewRenumber(1))} style={{ padding: "2px 10px", fontSize: 12, marginLeft: "auto" }}
              title="Renumber every channel 1, 2, 3… in its current order">{renumber ? "Cancel renumber" : "Renumber…"}</button>
          </div>
        )}
        {renumber && (
          <div className="meta-card" style={{ fontSize: 12, marginBottom: 8 }}>
            <b>Renumber all channels</b> in whole numbers, keeping their current order (10.10, 10.11, 10.12 become consecutive numbers).
            <label style={{ display: "flex", alignItems: "center", gap: 6, margin: "6px 0" }}>Start at
              <input type="number" min={1} value={renumber.start} style={{ width: 80 }} onChange={(e) => previewRenumber(Number(e.target.value) || 1)} />
            </label>
            <div style={{ maxHeight: 240, overflowY: "auto", border: "1px solid var(--border, #3334)", borderRadius: 6, padding: "4px 8px" }}>
              {renumber.plan.map((p) => {
                const same = normalizeChannelNumber(p.from) === p.to;
                return (
                  <div key={p.name} style={{ display: "flex", gap: 8, opacity: same ? 0.55 : 1 }}>
                    <span style={{ width: 54, textAlign: "right" }}>{p.from || "—"}</span>
                    <span>→</span>
                    <span style={{ width: 34, fontWeight: same ? 400 : 700 }}>{p.to}</span>
                    <span>{p.name}{p.enabled ? "" : " (disabled)"}</span>
                  </div>
                );
              })}
            </div>
            <p className="muted" style={{ margin: "6px 0 0" }}>
              {renumber.changed} of {renumber.plan.length} channels change number. Afterwards, publish the lineup; TV apps may need their channel list refreshed, and favourites saved by number can move.
            </p>
            <div className="actions" style={{ marginTop: 6 }}>
              <button className="primary" onClick={applyRenumber} disabled={renumberBusy || renumber.changed === 0}>{renumberBusy ? "Renumbering…" : `Renumber ${renumber.changed} channel${renumber.changed === 1 ? "" : "s"}`}</button>
              <button onClick={() => setRenumber(null)}>Cancel</button>
            </div>
          </div>
        )}
        {list.length > 8 && <input className="list-filter" type="search" placeholder={`Filter ${list.length} channels…`} value={filter} onChange={(e) => setFilter(e.target.value)} />}
        <ul className="channel-list">
          {sorted.filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()) || (c.meta?.number ?? "").startsWith(filter)).map((c) => (
            <li key={c.name} className={sel === c.name ? "active" : ""} onClick={() => { setImporting(false); open(c.name); }}>
              <span className={`dot ${c.valid ? "ok" : "err"}`} />
              <span className="chnum" style={sharedWith(c).length ? { color: "var(--err, #ef4444)", fontWeight: 700 } : undefined} title={sharedWith(c).length ? `Also used by ${sharedWith(c).join(", ")}` : undefined}>{c.meta?.number}{sharedWith(c).length ? " ⚠" : ""}</span>
              <span style={{ width: 22, height: 22, flex: "0 0 22px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                {logoSrc(c.meta?.logo) && <img src={logoSrc(c.meta?.logo)} alt="" loading="lazy" style={{ maxWidth: 22, maxHeight: 22, objectFit: "contain" }} />}
              </span>
              <span className="name">{c.name}</span>
              <span className="meta">{c.mode === "schedule" ? "blocks" : c.mode}</span>
              {c.meta && !c.meta.enabled && <span className="meta">disabled</span>}
            </li>
          ))}
        </ul>
      </div>
      <div className="edit-pane">
        {importing && legacyImport && (
          <>
            <div className="pane-head"><h2>Import from ErsatzTV legacy</h2></div>
            <LegacyImport onImported={() => refresh()} onNavigate={(t) => onNavigate?.(t)} onOpenChannel={(name) => { setImporting(false); open(name); }} />
          </>
        )}
        {!sel && !importing && (
          <div className="empty-state">
            <div className="empty-icon">☰</div>
            <h2>Pick a channel</h2>
            <p className="muted">Choose a channel on the left to edit its schedule, settings and logo, or create a new one.</p>
            <button className="primary" onClick={() => setCreating(true)}>+ New channel</button>
          </div>
        )}
        {sel && (
          <>
            <div className="editor-head">
              <div className="editor-title">
                {logoSrc(meta?.logo) && <img src={logoSrc(meta?.logo)} alt="" />}
                <div>
                  <h1>{sel}</h1>
                  <div className="muted editor-sub">#{meta?.number} · {modules.find((m) => m.id === selMode)?.label ?? selMode}{meta && !meta.enabled ? " · disabled" : ""}</div>
                </div>
              </div>
              <div className="actions" style={{ marginTop: 0 }}>
                <button onClick={buildNow} disabled={building} title="Build this channel's schedule now">{building ? <><span className="spinner" /> Building…</> : "Build now"}</button>
                <button onClick={() => navigate("preview", { channel: sel })}>Preview</button>
                {meta?.enabled && meta.number && <button onClick={() => navigate("troubleshoot", { tab: "live", channel: meta.number })} title="Watch this channel live from ErsatzTV next">Watch</button>}
                <button onClick={() => setRenaming({ to: sel, keepGuideId: false, busy: false, error: "" })}>Rename</button>
                <button onClick={del} className="danger">Delete</button>
              </div>
            </div>
            {renaming && (
              <div className="modal-overlay" onClick={() => !renaming.busy && setRenaming(null)}>
                <div className="modal" style={{ width: "min(480px, 100%)" }} onClick={(e) => e.stopPropagation()}>
                  <div className="pane-head"><h2 style={{ margin: 0 }}>Rename {sel}</h2><button onClick={() => setRenaming(null)} disabled={renaming.busy}>✕</button></div>
                  <div className="form" style={{ marginTop: 8 }}>
                    <label>New name<input autoFocus value={renaming.to} onChange={(e) => setRenaming({ ...renaming, to: e.target.value, error: "" })} onKeyDown={(e) => { if (e.key === "Enter") doRename(); }} /></label>
                    {(!meta?.tvgId || meta.tvgId === sel) && (
                      <label className="switch"><input type="checkbox" checked={renaming.keepGuideId} onChange={(e) => setRenaming({ ...renaming, keepGuideId: e.target.checked })} /> Keep the current guide id ("{sel}")</label>
                    )}
                    <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                      Its schedule, episode progress, number and settings all move to the new name.
                      {(!meta?.tvgId || meta.tvgId === sel) && (renaming.keepGuideId ? " TV apps keep treating it as the same channel." : " Its guide id becomes the new name, so TV apps may list it as a new channel; tick the box to avoid that.")}
                      {" "}Publish the lineup afterwards (and restart ErsatzTV next) for TV apps to see the change.
                    </p>
                    {renaming.error && <p className="err" style={{ margin: 0 }}>{renaming.error}</p>}
                    <div className="actions">
                      <button className="primary" onClick={doRename} disabled={renaming.busy || !renaming.to.trim() || renaming.to.trim() === sel}>{renaming.busy ? "Renaming…" : "Rename"}</button>
                      <button onClick={() => setRenaming(null)} disabled={renaming.busy}>Cancel</button>
                    </div>
                  </div>
                </div>
              </div>
            )}
            <div className="subtabs">
              {([["schedule", "Schedule"], ["settings", "Channel settings"], ["logo", "Logo"]] as const).map(([id, label]) => (
                <button key={id} className={pane === id ? "active" : ""} onClick={() => setPane(id)}>{label}</button>
              ))}
              {msg && <span className={`subtabs-msg ${msg.startsWith("Error") || msg.startsWith("Invalid") ? "err" : "ok"}`}>{msg}</span>}
            </div>

            {pane === "settings" && meta && (
              <div className="meta-card">
                <div className="row">
                  <label>Channel #<input value={meta.number} onChange={updMeta("number")} /></label>
                  <label>XMLTV id (tvg_id)<input value={meta.tvgId} onChange={updMeta("tvgId")} /></label>
                  <label>Group<input value={meta.group} onChange={updMeta("group")} /></label>
                </div>
                <div className="row">
                  <label>Preferred audio language
                    <select value={meta.audioLang ?? ""} onChange={(e) => updMetaVal("audioLang")(e.target.value)}>
                      <option value="">Default (server picks)</option>
                      {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                    </select>
                  </label>
                  <label>Subtitles
                    <select value={meta.subtitles || "off"} onChange={(e) => updMetaVal("subtitles")(e.target.value)}>
                      <option value="off">Off</option>
                      <option value="on">On (English, whole programme)</option>
                      <option value="forced">Foreign dialogue only</option>
                    </select>
                  </label>
                </div>
                <p className="muted" style={{ fontSize: 12, margin: "2px 0 6px" }}>
                  {meta.subtitles === "on" ? "English subtitles are shown for everything on this channel that has them."
                    : meta.subtitles === "forced" ? "Subtitles appear only when characters speak a language other than English (the file's forced English track). Programmes whose audio isn't English get full English subtitles."
                    : "No subtitles on this channel."}
                  {" "}Subtitles are burned into the picture. Save, then rebuild the channel for it to take effect.
                </p>
                <div className="row">
                  <label>Encoding
                    <select value={meta.encoding ?? ""} onChange={(e) => updMetaVal("encoding")(e.target.value)}>
                      <option value="">Default ({selMode === "remote" ? "pass through when possible" : "always re-encode"})</option>
                      <option value="transcode">Always re-encode</option>
                      <option value="copy">Pass through when possible</option>
                    </select>
                  </label>
                </div>
                <p className="muted" style={{ fontSize: 12, margin: "2px 0 6px" }}>
                  {meta.encoding === "copy" || (meta.encoding !== "transcode" && selMode === "remote")
                    ? "Video and audio that ErsatzTV next can use as they are (H.264 or HEVC, with AAC, AC-3 or MP3) go out untouched, which saves most of the CPU. They keep their own resolution, so mixed sources can look uneven, and some players stutter when the format changes between items. Everything else, including up-next cards and anything with subtitles, is re-encoded. Loudness normalization is off for this channel, since ErsatzTV next can't level audio it passes through."
                    : "Everything is re-encoded to the Video & audio settings on the Streaming page, so every item looks the same."}
                  {" "}Save, then restart ErsatzTV next on the Streaming page for it to take effect.
                </p>
                <div className="meta-subhead" style={{ margin: "10px 2px 2px", fontSize: 11, fontWeight: 700, letterSpacing: 1, opacity: 0.6, textTransform: "uppercase" }}>“Coming up next” card</div>
                <div className="row">
                  <label>Theme
                    <select value={meta.upNextTheme ?? "splat"} onChange={(e) => updMetaVal("upNextTheme")(e.target.value)}>
                      <option value="off">Off (no card)</option>
                      {(upNextThemes.length ? upNextThemes : UPNEXT_THEMES_FALLBACK).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                  </label>
                  <label>Text
                    <select value={meta.upNextText ?? "image"} onChange={(e) => updMetaVal("upNextText")(e.target.value)}>
                      <option value="image">Image (rendered PNG)</option>
                      <option value="subtitles">Subtitles (libass · burn)</option>
                    </select>
                  </label>
                  <label style={{ flex: 2 }}>Background audio
                    <input value={meta.upNextAudio ?? ""} onChange={updMeta("upNextAudio")} placeholder={"C:\\Media\\bumper.mp3 — blank = silent"} />
                    {audioMissing && <span className="err" style={{ fontSize: 12 }}>⚠ Not found on this machine, so the card plays silent. Fix the path, save, then rebuild the channel.</span>}
                  </label>
                  <button style={{ alignSelf: "flex-end" }} onClick={() => navigate("troubleshoot", { tab: "cards", channel: meta.name })} title="See this channel's card for any time, and try other themes">Preview card</button>
                </div>
                <div className="meta-subhead" style={{ margin: "10px 2px 2px", fontSize: 11, fontWeight: 700, letterSpacing: 1, opacity: 0.6, textTransform: "uppercase" }}>Overlays (watermark, lower thirds…)</div>
                <OverlayPicker value={meta.overlays ?? []} onChange={updMetaVal("overlays")} empty="No overlays on this channel" />
                <p className="muted" style={{ fontSize: 12, margin: "4px 0 6px" }}>Drawn over every programme. Save, then rebuild the channel to see them.</p>
                <div className="meta-subhead" style={{ margin: "10px 2px 2px", fontSize: 11, fontWeight: 700, letterSpacing: 1, opacity: 0.6, textTransform: "uppercase" }}>Fallback picture</div>
                <FallbackPicker key={meta.name} value={meta.fallbackImage ?? ""} onChange={updMetaVal("fallbackImage")} channel={meta.name}
                  defaultLabel={fallbackDefault === "black" ? "black screen" : fallbackDefault === "standby" ? "“We'll be right back” card" : "image from the Streaming page"} />
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, width: "auto", margin: "10px 0 2px" }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={meta.enabled} onChange={updMeta("enabled")} /> Enabled (part of the lineup)
                </label>
                <div className="actions"><button className="primary" onClick={saveMeta}>Save channel settings</button><button onClick={resetProgress}>Reset playout progress</button></div>
              </div>
            )}

            {pane === "logo" && meta && (
              <div className="meta-card">
                <div className="row" style={{ alignItems: "flex-start", gap: 14 }}>
                  <div
                    onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) uploadLogo(f); }}
                    title="Drop an image here to use it as the logo"
                    style={{ width: 112, height: 112, flex: "0 0 112px", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
                      border: `2px dashed ${dragging ? "var(--accent, #3b82f6)" : "var(--border, #3334)"}`, background: "repeating-conic-gradient(#8881 0% 25%, transparent 0% 50%) 50% / 16px 16px" }}>
                    {logoSrc(meta.logo)
                      ? <img src={logoSrc(meta.logo)} alt={`${sel} logo`} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
                      : <span className="muted" style={{ fontSize: 11, textAlign: "center", padding: 6 }}>{logoBusy ? "Uploading…" : "No logo — drop an image here"}</span>}
                  </div>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div className="actions" style={{ marginTop: 0 }}>
                      <button onClick={() => logoInput.current?.click()} disabled={logoBusy}>{meta.logo ? "Replace logo…" : "Upload logo…"}</button>
                      {meta.logo && !meta.logoGenerated && <button onClick={() => useNameLogo(true)} disabled={logoBusy}>Use channel-name logo</button>}
                      {!meta.logo && <button onClick={() => useNameLogo(false)} disabled={logoBusy}>Generate from name</button>}
                      <input ref={logoInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/bmp" style={{ display: "none" }}
                        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) uploadLogo(f); }} />
                    </div>
                    <p className="muted" style={{ fontSize: 12, margin: "6px 0" }}>
                      {meta.logoGenerated && <><b>This logo shows the channel name</b> because the channel has no logo of its own. Upload one to replace it. </>}
                      Shown next to the channel in TV apps' channel lists and guides. A square PNG with a transparent background looks best.
                      Uploading saves right away; publish the lineup for TV apps to pick it up.
                    </p>
                    <details>
                      <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>Use a web address instead</summary>
                      <label style={{ marginTop: 6 }}>Logo URL
                        <input value={/^https?:\/\//i.test(meta.logo) ? meta.logo : ""} onChange={updMeta("logo")} placeholder="https://…/logo.png — then Save channel settings" />
                      </label>
                    </details>
                  </div>
                </div>
              </div>
            )}

            {pane === "schedule" && (<>

            <div className="pane-head">
              <h3 style={{ margin: 0 }}>{editor === "pods" ? "Pod scheduler" : editor === "grid" ? "Weekly grid" : editor === "form" ? "Schedule" : "Playout YAML"}</h3>
              <div>{summaryLine(summary, selMode)}</div>
            </div>

            {editor === "pods"
              ? <PodScheduler value={form ?? {}} onChange={setForm} />
              : editor === "grid"
              ? <GridScheduler key={sel} value={form ?? {}} onChange={setForm} />
              : editor === "form" && schema
              ? <>
                  <SchemaForm fields={schema} value={form ?? {}} onChange={setForm} />
                  {selMode === "remote" && <RemoteCheck config={form ?? {}} />}
                </>
              : <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />}

            <div className="actions sticky-actions"><button className="primary" onClick={save}>Save &amp; validate</button>{msg && <span className={msg.startsWith("Error") || msg.startsWith("Invalid") ? "err" : "ok"}>{msg}</span>}</div>
            </>)}
          </>
        )}
      </div>
    </section>
  );
}

/** Remote stream channels: try the playlist + guide before building, and say what's next. */
function RemoteCheck({ config }: { config: any }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<RemoteProbe | null>(null);
  const check = async () => {
    setBusy(true); setRes(null);
    try { setRes(await api.probeRemote(JSON.stringify(config))); } catch (e) { setRes({ error: (e as Error).message }); }
    setBusy(false);
  };
  const time = (ms?: number) => (ms ? new Date(ms).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "");
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="actions" style={{ marginTop: 0 }}>
        <button onClick={check} disabled={busy || !config.playlistUrl}>{busy ? <><span className="spinner" /> Checking…</> : "Check stream"}</button>
        <span className="muted" style={{ fontSize: 12 }}>Then Save, and use Build now to put it on air. Rebuild if the stream's address changes.</span>
      </div>
      {res?.error && <p className="err">{res.error}</p>}
      {res && !res.error && (
        <div style={{ fontSize: 13, marginTop: 8 }}>
          <div><span className="ok">✓ Stream</span>{res.name ? ` "${res.name}"` : ""}: <code>{res.streamUrl}</code></div>
          {(res.entries?.length ?? 0) > 1 && <div className="muted">The playlist has {res.entries!.length} streams: {res.entries!.map((e) => e.tvgId || e.name).join(", ")}</div>}
          {res.guide && (res.guide.error
            ? <div className="err">Guide: {res.guide.error}</div>
            : <div><span className="ok">✓ Guide</span>: {res.guide.count} programme{res.guide.count === 1 ? "" : "s"}, {time(res.guide.firstMs)} to {time(res.guide.lastMs)}{res.guide.title ? ` (first: "${res.guide.title}")` : ""} <span className="muted">from <code>{res.guide.url}</code></span></div>)}
        </div>
      )}
    </div>
  );
}
