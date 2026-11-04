// ErsatzTV legacy graphics elements in the Overlays page:
//   - LegacyImport: bring elements in — every one in legacy's graphics-elements
//     folder, uploaded .yml files, or pasted YAML
//   - LegacyDesigner: an imported element — its YAML as written (it's filled in for
//     every item it plays over, like legacy did), a Test that fills it in for a real
//     airing and draws it over that item's own picture, and its channels
// The build side is src/legacy-graphics.ts.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Overlay, type ChannelSummary, type LegacyImported, type LegacyTest, type LegacyElement } from "./api.js";
import { navigate } from "./nav.js";
import { templateSyntaxError } from "../../src/scriban.js";

/** A request's error as a sentence (the server sends { error }). */
const why = (e: unknown) => { const m = (e as Error)?.message ?? String(e); try { return JSON.parse(m).error ?? m; } catch { return m; } };

const KINDS: { id: LegacyElement["kind"]; label: string }[] = [
  { id: "image", label: "Image" }, { id: "text", label: "Text" }, { id: "motion", label: "Motion (video)" },
  { id: "subtitle", label: "Subtitle (not supported yet)" }, { id: "script", label: "Script (not supported yet)" },
];

/** The variables an element can use (as legacy gave them). */
const VARIABLES: [string, string][] = [
  ["MediaItem_Path", "the file playing (e.g. a bumper's path — great for if … string.contains)"],
  ["MediaItem_Title / _Plot / _ReleaseDate", "its title, plot and release date"],
  ["MediaItem_ShowTitle / _ShowYear / _ShowContentRating / _ShowGenres", "the show it's from (episodes)"],
  ["MediaItem_Genres / _Studios / _Directors / _ContentRating", "lists and rating from the library"],
  ["MediaItem_Duration, MediaItem_Resolution", "its length (.TotalSeconds…) and size (.Width / .Height)"],
  ["MediaItem_Start / _Stop", "when it airs (dates: .Hour, .Minute…, or format_datetime)"],
  ["MediaItem_Track / _Album / _Artist / _Artists", "music videos"],
  ["Epg[0], Epg[1], …", "the guide from the item's start: Epg[0] is on now, Epg[1] next — .Title .SubTitle .Description .Categories .Date .Start .Stop (set epg_entries: N)"],
  ["Resolution, FrameRate, Channel_StartTime", "the output size and frame rate"],
  ["string.*  array.*  math.*  date.*  regex.*", "Scriban's functions (contains, replace, strip, upcase, truncate, round, to_string…)"],
  ["format_datetime d \"Eastern Standard Time\" \"h:mm tt\"", "a date in a time zone, .NET format; also convert_timezone, get_directory_name, get_filename_without_extension"],
  ["opacity_expression", "LinearFadePoints(content_seconds, start, full, fading, gone), LinearFadeDuration(t, start, fade, hold); content_seconds, time_of_day_seconds… with % for repeats"],
];

export function LegacyImport({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const [folder, setFolder] = useState("");
  const [found, setFound] = useState<{ folder: string; exists: boolean; files: { file: string; kind: string }[] } | null>(null);
  const [paste, setPaste] = useState("");
  const [pasteFile, setPasteFile] = useState("");
  const [kind, setKind] = useState("");
  const [results, setResults] = useState<LegacyImported[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const look = (f = folder) => api.legacyFolder(f).then((r) => { setFound(r); if (!f) setFolder(r.folder); }).catch((e) => setErr(why(e)));
  useEffect(() => { void look(""); }, []);
  const run = async (p: Promise<{ imported: LegacyImported[] }>) => {
    setBusy(true); setErr("");
    try { setResults((await p).imported); } catch (e) { setErr(why(e)); } finally { setBusy(false); }
  };
  const fromFiles = async (files: FileList) => {
    const items = await Promise.all([...files].map(async (f) => ({ file: kind ? `${kind}/${f.name}` : f.name, text: await f.text(), kind: kind || undefined })));
    await run(api.legacyImport(items));
  };
  const counts = found ? Object.entries(found.files.reduce<Record<string, number>>((a, f) => ({ ...a, [f.kind]: (a[f.kind] ?? 0) + 1 }), {})).map(([k, n]) => `${n} ${k}`).join(", ") : "";
  return (
    <div className="meta-card" style={{ marginBottom: 16 }}>
      <div className="pane-head"><b>Import graphics elements from ErsatzTV legacy</b><button className="ghost" onClick={onClose}>Close</button></div>
      <p className="muted" style={{ fontSize: 13, margin: "2px 0 10px" }}>
        Legacy's graphics elements keep their YAML exactly as written — templates, variables, opacity expressions and all — and are
        filled in for every item they play over, the way legacy did. So one element can still put a different picture at a different
        spot for every bumper. Use them like any overlay: on channels, blocks and grid shows, or in a YAML channel with <code>graphics_on</code>.
      </p>
      <div className="ov-legacy-import">
        <div>
          <b style={{ fontSize: 13 }}>From legacy's folder</b>
          <div className="row" style={{ gap: 6, marginTop: 4 }}>
            <input style={{ flex: 1 }} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="…\ersatztv\templates\graphics-elements" />
            <button onClick={() => look()}>Look</button>
          </div>
          {found && (found.exists
            ? <p className="muted" style={{ fontSize: 12, margin: "4px 0" }}>{found.files.length ? <>Found {counts}: {found.files.slice(0, 12).map((f) => f.file).join(", ")}{found.files.length > 12 ? "…" : ""}</> : "No .yml elements in its image, text, motion, subtitle or script folders."}</p>
            : <p className="warn" style={{ fontSize: 12, margin: "4px 0" }}>That folder isn't on this machine.</p>)}
          <button className="primary" disabled={busy || !found?.files.length} onClick={() => run(api.legacyImportFolder(folder))}>Import all {found?.files.length ? found.files.length : ""}</button>
        </div>
        <div>
          <b style={{ fontSize: 13 }}>Upload .yml files</b>
          <div className="row" style={{ gap: 6, marginTop: 4, alignItems: "center" }}>
            <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: "auto" }}>
              <option value="">Kind: work it out</option>
              {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
            <button disabled={busy} onClick={() => upload.current?.click()}>Choose files…</button>
            <input ref={upload} type="file" accept=".yml,.yaml" multiple hidden onChange={(e) => { if (e.target.files?.length) void fromFiles(e.target.files); e.target.value = ""; }} />
          </div>
          <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>Pick the kind when the files came out of one folder (image, text…); otherwise it's read from what's in them.</p>
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <b style={{ fontSize: 13 }}>Paste an element</b>
          <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={8} spellCheck={false} className="ov-yaml" placeholder={"image: \"C:/…/{{ Epg[1].Title }}.png\"\nlocation: TopRight\n…"} />
          <div className="row" style={{ gap: 6, alignItems: "center" }}>
            <input style={{ flex: 1 }} value={pasteFile} onChange={(e) => setPasteFile(e.target.value)} placeholder="Its file name, as YAML channels name it: e.g. image/cn_city.yml" />
            <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: "auto" }}>
              <option value="">Kind: work it out</option>
              {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
            <button className="primary" disabled={busy || !paste.trim()} onClick={() => run(api.legacyImport([{ file: pasteFile || "pasted.yml", text: paste, kind: kind || undefined }]))}>Import</button>
          </div>
        </div>
      </div>
      {err && <p className="err">{err}</p>}
      {busy && <p className="muted">Importing…</p>}
      {results && (
        <div style={{ marginTop: 10 }}>
          <b style={{ fontSize: 13 }}>{results.length} imported</b>
          {results.map((r) => (
            <div key={r.id} className="ov-legacy-result">
              <span><b>{r.name}</b> <span className="muted">· {r.file}{r.replaced ? " · replaced the earlier copy" : ""}</span></span>
              <button className="ghost" onClick={() => onOpen(r.id)}>Open →</button>
              {r.warnings.map((w, i) => <div key={i} className="warn" style={{ fontSize: 12, gridColumn: "1 / -1" }}>{w}</div>)}
            </div>
          ))}
          <p className="muted" style={{ fontSize: 12 }}>Open one to test it on a real airing and pick its channels.</p>
        </div>
      )}
    </div>
  );
}

export function LegacyDesigner({ initial, channels, usedBy, onClose, onSaved, onChannels }: {
  initial: Overlay; channels: ChannelSummary[]; usedBy: Record<string, string[]>;
  onClose: () => void; onSaved: (o: Overlay) => void; onChannels: () => void;
}) {
  const [ov, setOv] = useState<Overlay>(initial);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const el = ov.legacy!;
  const set = (p: Partial<Overlay>) => { setOv((o) => ({ ...o, ...p })); setDirty(true); };
  const setEl = (p: Partial<LegacyElement>) => set({ legacy: { ...el, ...p } });
  const syntax = useMemo(() => templateSyntaxError(el.yaml), [el.yaml]);
  const on = new Set(usedBy[ov.id] ?? []);
  const [channel, setChannel] = useState(() => usedBy[initial.id]?.[0] ?? channels.find((c) => c.meta?.enabled)?.name ?? "");
  const [match, setMatch] = useState("");
  const [test, setTest] = useState<LegacyTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [testErr, setTestErr] = useState("");

  const save = async () => {
    if (!ov.name.trim()) { setMsg("Give it a name first."); return; }
    setBusy(true); setMsg("");
    try { const r: any = await api.saveOverlay(ov); if (r.error) throw new Error(r.error); setDirty(false); setMsg("Saved. Rebuild the channels it's on to see the change."); onSaved(r); }
    catch (e) { setMsg(why(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete "${ov.name}"? It comes off every channel that shows it.`)) return;
    await api.deleteOverlay(ov.id); onClose();
  };
  const toggleChannel = async (name: string, show: boolean) => {
    const meta = channels.find((c) => c.name === name)?.meta;
    const cur = meta?.overlays ?? [];
    await api.setChannelMeta(name, { overlays: show ? [...cur.filter((x) => x !== ov.id), ov.id] : cur.filter((x) => x !== ov.id) });
    onChannels();
  };
  const runTest = async () => {
    setTesting(true); setTestErr("");
    try { const r = await api.legacyTest(ov, channel, match.trim() || undefined); if (r.error) throw new Error(r.error); setTest(r); }
    catch (e) { setTestErr(why(e)); setTest(null); } finally { setTesting(false); }
  };
  const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit", second: "2-digit" });

  return (
    <div className="screen ov-designer">
      <div className="ov-top">
        <button className="ghost" onClick={() => { if (!dirty || window.confirm("Leave without saving your changes?")) onClose(); }}>← Overlays</button>
        <input className="ov-name" value={ov.name} onChange={(e) => set({ name: e.target.value })} placeholder="Element name" />
        {dirty && <span className="pill off">Unsaved</span>}
        <div className="ov-top-actions">
          {ov.id && <button onClick={remove}>Delete</button>}
          <button className="primary" onClick={save} disabled={busy}>Save</button>
        </div>
      </div>
      {msg && <p className={/saved/i.test(msg) ? "ok" : "err"} style={{ margin: "0 0 8px" }}>{msg}</p>}
      <div className="ov-legacy-layout">
        <div className="meta-card">
          <div className="pane-head"><b>ErsatzTV legacy graphics element</b></div>
          <div className="row" style={{ gap: 8 }}>
            <label>Kind<select value={el.kind} onChange={(e) => setEl({ kind: e.target.value as LegacyElement["kind"] })}>{KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select></label>
            <label style={{ flex: 1 }} title="What a YAML channel's graphics_on uses to switch it on">File name (for graphics_on)<input value={el.file ?? ""} onChange={(e) => setEl({ file: e.target.value })} placeholder="image/cn_city.yml" /></label>
          </div>
          <label>Element (YAML with Scriban templates, as in legacy)
            <textarea className="ov-yaml" value={el.yaml} onChange={(e) => setEl({ yaml: e.target.value })} rows={28} spellCheck={false} />
          </label>
          {syntax ? <p className="err" style={{ fontSize: 12, margin: "2px 0" }}>Template problem: {syntax}</p> : <p className="ok" style={{ fontSize: 12, margin: "2px 0" }}>✓ The template reads fine. Test it to see what it makes.</p>}
          {(el.kind === "subtitle" || el.kind === "script") && <p className="warn" style={{ fontSize: 12 }}>{el.kind === "subtitle" ? "Subtitle" : "Script"} elements aren't supported yet: they're kept, but builds don't draw them.</p>}
          <details>
            <summary className="muted">Variables and functions you can use</summary>
            <table className="history" style={{ fontSize: 12 }}><tbody>{VARIABLES.map(([k, d]) => <tr key={k}><td><code>{k}</code></td><td className="muted">{d}</td></tr>)}</tbody></table>
          </details>
        </div>

        <div>
          <div className="meta-card">
            <div className="pane-head"><b>Test on a real airing</b></div>
            <p className="muted" style={{ fontSize: 12, margin: "2px 0 8px" }}>Fills the element in for an item in a channel's built playout — its file, its guide, its times — and draws what a build would put over that item's own picture. Uses what's typed here, saved or not.</p>
            <div className="row" style={{ gap: 6, alignItems: "center" }}>
              <select value={channel} onChange={(e) => setChannel(e.target.value)} style={{ width: "auto" }}>
                {channels.map((c) => <option key={c.name} value={c.name}>{c.meta?.number ? `${c.meta.number} ` : ""}{c.name}</option>)}
              </select>
              <input style={{ flex: 1 }} value={match} onChange={(e) => setMatch(e.target.value)} placeholder="The next airing of a file named like… (blank: what's on now)" onKeyDown={(e) => { if (e.key === "Enter") void runTest(); }} />
              <button className="primary" onClick={runTest} disabled={testing || !channel || !!syntax}>{testing ? "Testing…" : "Test"}</button>
            </div>
            {testErr && <p className="err" style={{ fontSize: 13 }}>{testErr}</p>}
            {test && (
              <div className="ov-legacy-test">
                <div className="muted" style={{ fontSize: 12 }}><b>{test.item.name}</b> · {when(test.item.start)} – {when(test.item.finish)}</div>
                {test.preview ? <img src={test.preview} alt="What the build draws over this item" style={{ width: "100%", borderRadius: 6, border: "1px solid var(--line2)" }} /> : <p className="muted">Nothing to show.</p>}
                {test.timing && <p style={{ fontSize: 13, margin: "4px 0" }}>When: {test.timing}</p>}
                {!test.guideFound && <p className="warn" style={{ fontSize: 12 }}>This channel has no guide file yet, so Epg[…] is empty — build it first.</p>}
                {test.problems.map((p, i) => <p key={i} className="warn" style={{ fontSize: 12, margin: "2px 0" }}>{p}</p>)}
                {!test.problems.length && test.layers.length === 0 && <p className="muted" style={{ fontSize: 12 }}>It shows nothing on this item (its opacity is 0 here).</p>}
                <details>
                  <summary className="muted">The filled-in element</summary>
                  <pre className="log" style={{ maxHeight: 260 }}>{test.yaml}</pre>
                </details>
                <details>
                  <summary className="muted">Variables it saw ({test.vars.length})</summary>
                  <table className="history" style={{ fontSize: 12 }}><tbody>{test.vars.map(([k, v]) => <tr key={k}><td><code>{k}</code></td><td style={{ wordBreak: "break-all" }}>{v}</td></tr>)}</tbody></table>
                </details>
                <details>
                  <summary className="muted">What the build gives ErsatzTV next ({test.layers.length} layer{test.layers.length === 1 ? "" : "s"})</summary>
                  <pre className="log" style={{ maxHeight: 260 }}>{JSON.stringify(test.layers, null, 2)}</pre>
                </details>
              </div>
            )}
          </div>

          <div className="meta-card">
            <b>Show on channels</b>
            {!ov.id ? <p className="muted">Save it first, then pick its channels here.</p> : (
              <>
                <p className="muted" style={{ margin: "4px 0 8px", fontSize: 12 }}>Filled in for every item on these channels{ov.duringFiller ? ", commercials and bumpers included" : ""}. In a YAML channel, switch it on with <code>graphics_on: "{el.file || "…"}"</code> instead. Rebuild a channel after changing this.</p>
                <label className="ov-inline" style={{ marginBottom: 6 }}><input type="checkbox" checked={!!ov.duringFiller} onChange={(e) => set({ duringFiller: e.target.checked })} /> Also over commercials and bumpers (as legacy did)</label>
                <div className="ov-chans">
                  {channels.map((c) => (
                    <label key={c.name} className="ov-inline"><input type="checkbox" checked={on.has(c.name)} onChange={(e) => toggleChannel(c.name, e.target.checked)} /> {c.meta?.number ? `${c.meta.number} ` : ""}{c.name}</label>
                  ))}
                </div>
                <div className="row" style={{ marginTop: 8, gap: 6 }}>
                  <button onClick={() => navigate("build")}>Go to Build →</button>
                  <button onClick={() => navigate("troubleshoot", { tab: "overlays", overlay: ov.id })} title="Play the moment it appears on a channel, through ErsatzTV next">Test on a channel →</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
