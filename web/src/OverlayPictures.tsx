// Pictures picked by the schedule: an overlay image layer whose source is
// `match:<name>` (e.g. `match:{{next_show}}`) shows the picture in the pictures
// folder whose file name matches — so "Hey Dude" coming up shows "hey dude.png".
//   - PicturesCard: the folder's pictures (upload, delete, where the folder is)
//   - MatchProps:   a match layer's settings in the designer (name, fallback, check)
//   - MatchImage:   the layer drawn on the canvas with sample values
import { useEffect, useRef, useState } from "react";
import { api, overlayAssetSrc, resolveMatch, MATCH_PREFIX, CHANNEL_LOGO, type OverlayField, type OverlayPictures } from "./api.js";

const pictureUrl = (name: string) => `/overlay-pictures/file?name=${encodeURIComponent(name)}`;
const isVideo = (name: string) => /\.(mp4|mov|webm|mkv|m4v)$/i.test(name);

/** The pictures folder: what's in it, uploading (names kept: they're the match), deleting. */
export function PicturesCard({ onChange }: { onChange?: () => void }) {
  const [p, setP] = useState<OverlayPictures | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [filter, setFilter] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [drop, setDrop] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const load = () => api.overlayPictures().then(setP).catch((e) => setMsg(String(e.message ?? e)));
  useEffect(() => { void load(); }, []);

  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    if (!list.length) return;
    let done = 0; const bad: string[] = [];
    for (const f of list) {
      setBusy(`Uploading ${done + 1} of ${list.length}…`);
      try { await api.uploadOverlayPicture(f); done++; } catch (e) { bad.push(`${f.name}: ${(e as Error).message}`); }
    }
    setBusy(""); setMsg(bad.length ? bad.join(" · ") : `Added ${done} picture${done === 1 ? "" : "s"} ✓`);
    await load(); onChange?.();
  };
  const remove = async (name: string) => {
    if (!window.confirm(`Delete ${name} from the pictures folder?`)) return;
    await api.deleteOverlayPicture(name).catch(() => {});
    await load(); onChange?.();
  };
  const saveFolder = async () => {
    await api.setConfig({ overlayPicturesDir: (folder ?? "").trim() });
    setFolder(null); await load(); onChange?.();
  };

  const shown = (p?.files ?? []).filter((f) => !filter || f.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="meta-card" onDragOver={(e) => { e.preventDefault(); setDrop(true); }} onDragLeave={() => setDrop(false)}
      onDrop={(e) => { e.preventDefault(); setDrop(false); if (e.dataTransfer.files?.length) void upload(e.dataTransfer.files); }}
      style={drop ? { outline: "2px dashed var(--accent, #4f8cff)" } : undefined}>
      <div className="pane-head"><b>Pictures picked by the schedule</b><span className="muted" style={{ fontSize: 12 }}>{p ? `${p.files.length} in the folder` : ""}</span></div>
      <p className="muted" style={{ margin: "2px 0 8px", fontSize: 13 }}>
        Add a <b>Picture by show</b> layer to an overlay and it shows the picture here whose name matches what's on, what's next,
        or any other show detail. Name each file after the show: <code>Rugrats.jpg</code>, <code>hey dude.png</code>.
        Capitals, punctuation, spaces and the file type don't matter. Sub-folders work too, e.g. <code>logos/Rugrats.png</code> for a
        layer named <code>{"logos/{{next_show}}"}</code>.
      </p>
      <div className="actions" style={{ margin: "0 0 8px" }}>
        <button className="primary" onClick={() => input.current?.click()} disabled={!!busy}>Add pictures…</button>
        <input ref={input} type="file" multiple accept="image/*,video/*" hidden onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ""; }} />
        <span className="muted" style={{ fontSize: 12 }}>or drop files here</span>
        {busy && <span className="muted">{busy}</span>}
        {msg && !busy && <span className={/✓/.test(msg) ? "ok" : "err"}>{msg}</span>}
      </div>
      {p && (folder == null ? (
        <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
          Folder: <code>{p.dir}</code>{p.isDefault ? " (the default; it isn't part of the scheduler's code, so updates leave it alone)" : ""}.
          You can also copy pictures into it directly. <a href="#" onClick={(e) => { e.preventDefault(); setFolder(p.isDefault ? "" : p.dir); }}>Use a different folder</a>
        </p>
      ) : (
        <div className="row" style={{ gap: 6, margin: "0 0 8px", alignItems: "center" }}>
          <input style={{ flex: 1 }} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="e.g. D:\TV\show-logos (blank = the default folder)" />
          <button onClick={saveFolder}>Save</button><button className="ghost" onClick={() => setFolder(null)}>Cancel</button>
        </div>
      ))}
      {!!p?.files.length && <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a picture…" style={{ marginBottom: 8 }} />}
      {p && !p.files.length && <p className="muted" style={{ fontSize: 13 }}>No pictures yet.</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8, maxHeight: 360, overflowY: "auto" }}>
        {shown.slice(0, 300).map((f) => (
          <div key={f.name} style={{ border: "1px solid var(--border, #334155)", borderRadius: 8, padding: 4, fontSize: 11, position: "relative" }} title={f.name}>
            <div style={{ height: 68, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.25)", borderRadius: 6, overflow: "hidden" }}>
              {isVideo(f.name) ? <span className="muted">▶ video</span> : <img src={pictureUrl(f.name)} alt="" loading="lazy" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />}
            </div>
            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 3 }}>{f.name}</div>
            <button className="ghost" title="Delete" onClick={() => remove(f.name)} style={{ position: "absolute", top: 2, right: 2, padding: "0 5px" }}>✕</button>
          </div>
        ))}
      </div>
      {shown.length > 300 && <p className="muted" style={{ fontSize: 12 }}>Showing 300 of {shown.length}; type to find one.</p>}
      {p?.truncated && <p className="muted" style={{ fontSize: 12 }}>The folder has more files than this list shows; they still match.</p>}
    </div>
  );
}

/** A match layer on the canvas: the picture the sample values pick, else its
 *  fallback, else a placeholder naming what it looks for. */
export function MatchImage({ src, fallback, vars, style, video }: { src: string; fallback?: string; vars: Record<string, string>; style: React.CSSProperties; video?: boolean }) {
  const want = resolveMatch(src, vars), alt = fallback ? resolveMatch(fallback, vars) : "";
  const [stage, setStage] = useState(0); // 0: the match, 1: the fallback, 2: placeholder
  useEffect(() => setStage(0), [want, alt]);
  const url = (s: string) => overlayAssetSrc(s) + (video && s.startsWith(MATCH_PREFIX) ? "&kind=video" : "");
  const cur = stage === 0 && want.length > MATCH_PREFIX.length ? want : stage <= 1 && alt && alt !== MATCH_PREFIX ? alt : "";
  if (!cur) {
    const label = src.slice(MATCH_PREFIX.length) || "picture";
    return (
      <div style={{ ...style, border: "2px dashed rgba(79,140,255,.8)", background: "rgba(79,140,255,.15)", display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", color: "#fff", fontSize: 12, overflow: "hidden" }}>
        <span>🖼 {label}</span>
      </div>
    );
  }
  const next = () => setStage(cur === want ? 1 : 2);
  return video
    ? <video key={cur} src={url(cur)} muted loop autoPlay playsInline style={{ ...style, objectFit: "contain" }} onError={next} />
    : <img key={cur} src={url(cur)} draggable={false} alt="" style={{ ...style, objectFit: "contain" }} onError={next} />;
}

/** A match layer's settings: which detail names the picture, what to show when
 *  none matches, and what the sample values find. */
export function MatchProps({ src, fallback, kind, fields, slots, vars, set }: {
  src: string; fallback?: string; kind: "image" | "video"; fields: OverlayField[]; slots: string[]; vars: Record<string, string>;
  set: (p: { src?: string; fallback?: string }) => void;
}) {
  const name = src.slice(MATCH_PREFIX.length);
  const [hit, setHit] = useState<{ looked: string; file: string | null } | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState("");
  const up = useRef<HTMLInputElement>(null);
  const looked = resolveMatch(src, vars).slice(MATCH_PREFIX.length);
  const check = () => {
    if (!looked) { setHit({ looked, file: null }); return; }
    api.matchOverlayPicture(looked, kind).then((r) => setHit({ looked, file: r.file })).catch(() => setHit(null));
  };
  useEffect(() => { const t = setTimeout(check, 250); return () => clearTimeout(t); }, [looked, kind]);
  useEffect(() => { api.overlayPictures().then((p) => setCount(p.files.length)).catch(() => {}); }, []);
  const fbKind = !fallback ? "none" : fallback === CHANNEL_LOGO ? "logo" : "name";
  const quick = fields.filter((f) => f.slot != null && /(^|_)show$/.test(f.key));
  const upload = async (files: FileList) => {
    let n = 0;
    for (const f of [...files]) { setBusy(`Uploading ${n + 1} of ${files.length}…`); try { await api.uploadOverlayPicture(f); n++; } catch { /* reported below */ } }
    setBusy(n === files.length ? `Added ${n} ✓` : `Added ${n} of ${files.length}`);
    api.overlayPictures().then((p) => setCount(p.files.length)).catch(() => {});
    check();
  };
  return (
    <>
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>Shows the picture whose file name matches, from the pictures folder ({count ?? "…"} picture{count === 1 ? "" : "s"} there). Each show fills in its own.</p>
      <label>Picture name
        <input value={name} onChange={(e) => set({ src: MATCH_PREFIX + e.target.value })} placeholder="{{next_show}}" />
      </label>
      <div className="ov-seg" style={{ flexWrap: "wrap" }}>
        {quick.map((f) => <button key={f.key} className={name === `{{${f.key}}}` ? "active" : ""} onClick={() => set({ src: `${MATCH_PREFIX}{{${f.key}}}` })} title={`{{${f.key}}}`}>{slots[f.slot!] ?? f.label}</button>)}
      </div>
      <p className="muted" style={{ fontSize: 11, margin: 0 }}>Any show detail works (click one in “Show details you can use” to add it), and so do words around it, e.g. <code>{"{{next_show}} logo"}</code> or <code>{"logos/{{show}}"}</code>.</p>
      <div className={`verify ${hit?.file ? "" : "bad"}`} style={{ margin: "2px 0" }}>
        <div className="muted" style={{ fontSize: 12 }}>
          {!hit ? "Checking…" : !hit.looked ? "With the sample values this names no picture."
            : hit.file ? <>With the sample values it looks for “{hit.looked}” and finds <code>{hit.file}</code> ✓</>
            : <>With the sample values it looks for “{hit.looked}”; no picture has that name yet.</>}
        </div>
      </div>
      <label>If no picture matches
        <select value={fbKind} onChange={(e) => set({ fallback: e.target.value === "logo" ? CHANNEL_LOGO : e.target.value === "name" ? `${MATCH_PREFIX}default` : undefined })}>
          <option value="none">Show nothing</option>
          <option value="logo">Show the channel's logo</option>
          <option value="name">Show another picture from the folder</option>
        </select>
      </label>
      {fbKind === "name" && <label>That picture's name<input value={fallback!.slice(MATCH_PREFIX.length)} onChange={(e) => set({ fallback: MATCH_PREFIX + e.target.value })} placeholder="default" /></label>}
      <div className="actions" style={{ margin: 0 }}>
        <button onClick={() => up.current?.click()}>Add pictures…</button>
        <input ref={up} type="file" multiple accept={kind === "video" ? "video/*" : "image/*"} hidden onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); e.target.value = ""; }} />
        {busy && <span className="muted" style={{ fontSize: 12 }}>{busy}</span>}
      </div>
      <p className="muted" style={{ fontSize: 11, margin: 0 }}>Name files after the shows. All the pictures are on the Overlays page, under <b>Pictures picked by the schedule</b>.</p>
    </>
  );
}
