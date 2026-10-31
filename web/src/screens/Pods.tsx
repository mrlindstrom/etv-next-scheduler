import { useEffect, useMemo, useRef, useState } from "react";
import { api, category, CATEGORY_COLORS, type Pod, type PodType, type ContentSource, type LibraryInfo, type PodPreview } from "../api.js";
import { CollectionField } from "../SchemaForm.js";

const nameOf = (p: string) => p.split(/[\\/]/).pop() ?? p;
const slug = (s: string) => s.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const ALIGN = [0, 60, 30, 15, 10, 5];

const emptySource = (): ContentSource => ({ kind: "query", query: "", order: "shuffle" });
const bumperSource = (phrase: string): ContentSource => ({ kind: "show_bumper", phrase, type: "other_video", order: "shuffle" });
function defaultConfig(type: PodType): any {
  if (type === "break") return {
    leadIn: bumperSource("be right back"),
    body: { kind: "query", query: "", order: "shuffle" }, bodyCount: 4,
    leadOut: bumperSource("back to"),
  };
  if (type === "filler") return { content: emptySource(), align: 30, fillerKind: "postroll", trim: true };
  return { show: { kind: "show", value: "", type: "episode", minMinutes: 1, maxMinutes: 31, order: "chronological" },
    preroll: [], postroll: [], align: 30, trimTail: true, epgGroup: true };
}

// Typeahead over library show titles (native datalist).
function ShowInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [opts, setOpts] = useState<string[]>([]);
  const timer = useRef<number | undefined>(undefined);
  const listId = useRef("shows_" + Math.random().toString(36).slice(2)).current;
  const query = (s: string) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { if (s.trim()) api.showSuggest(s).then(setOpts).catch(() => {}); }, 160);
  };
  useEffect(() => { if (value) api.showSuggest(value).then(setOpts).catch(() => {}); }, []);
  return (
    <>
      <input value={value} list={listId} placeholder="start typing a show…" spellCheck={false}
        onChange={(e) => { onChange(e.target.value); query(e.target.value); }} />
      <datalist id={listId}>{opts.map((o) => <option key={o} value={o} />)}</datalist>
    </>
  );
}

// --- reusable content-source editor -----------------------------------------
// role: "generic", "show" (typeahead + duration), "bumper" (lead-in/out), "upnext".
function SourceEditor({ value, onChange, libraries, role = "generic", defaultPhrase }:
  { value: ContentSource; onChange: (v: ContentSource) => void; libraries: LibraryInfo[]; role?: "generic" | "show" | "bumper" | "upnext"; defaultPhrase?: string }) {
  const set = (patch: Partial<ContentSource>) => onChange({ ...value, ...patch });
  const changeKind = (kind: ContentSource["kind"]) =>
    set(kind === "show_bumper" || kind === "next_bumper" ? { kind, phrase: value.phrase ?? defaultPhrase ?? (kind === "next_bumper" ? "up next" : "be right back") } : { kind });
  const kinds: ContentSource["kind"][] = role === "bumper"
    ? ["show_bumper", "query", "library", "collection"]
    : role === "upnext" ? ["next_bumper", "query"]
    : role === "show" ? ["show", "collection", "library", "query"]
    : ["query", "show", "library", "collection"];
  const showMinMax = role === "generic" || role === "show";
  const kindLabel = (k: ContentSource["kind"]) =>
    k === "show_bumper" ? "From scheduled show" : k === "next_bumper" ? "Auto (next scheduled show)" : k[0].toUpperCase() + k.slice(1);
  const isBumper = value.kind === "show_bumper" || value.kind === "next_bumper";
  return (
    <div className="src-editor">
      <div className="row">
        <label>Source
          <select value={value.kind} onChange={(e) => changeKind(e.target.value as ContentSource["kind"])}>
            {kinds.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
          </select>
        </label>
        <label>Order
          <select value={value.order ?? "shuffle"} onChange={(e) => set({ order: e.target.value as any })}>
            <option value="shuffle">Shuffle</option>
            <option value="chronological">Chronological</option>
          </select>
        </label>
      </div>
      {isBumper && (
        <div>
          <div className="row">
            <label style={{ flex: 2 }}>{value.kind === "next_bumper" ? "“Up next” phrase" : "Bumper phrase"}
              <input value={value.phrase ?? ""} list="bumper-phrases" placeholder={defaultPhrase ?? (value.kind === "next_bumper" ? "up next" : "be right back")}
                onChange={(e) => set({ phrase: e.target.value })} />
              <datalist id="bumper-phrases"><option value="be right back" /><option value="back to" /><option value="up next" /><option value="then" /></datalist>
            </label>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
            {value.kind === "next_bumper"
              ? <>Matches items whose name contains this phrase <b>and the next scheduled show's title</b> (filled in by the scheduler when this show pod is placed in a lineup — e.g. before Full House → “Up Next - … Full House”). Standalone preview matches the phrase only.</>
              : <>Matches library items whose name contains this phrase <b>and the scheduled show's title</b> (e.g. a Rugrats break → “Be Right Back - Rugrats”). Standalone preview matches the phrase only.</>}
          </p>
        </div>
      )}
      {value.kind === "query" && (
        <textarea className="src-query" value={value.query ?? ""}
          placeholder={role === "bumper"
            ? `type:other_video AND title:"be right back" AND title:"Rugrats"`
            : role === "upnext" ? `library_name:static AND title:"Rugrats then Full House"`
            : `type:other_video AND title:commercial* AND seconds:[1 TO 31]`}
          onChange={(e) => set({ query: e.target.value })} spellCheck={false} />
      )}
      {value.kind === "show" && (
        <div className="row">
          <label style={{ flex: 2 }}>Show title<ShowInput value={value.value ?? ""} onChange={(v) => set({ value: v })} /></label>
          {showMinMax && <label>Min min<input type="number" value={value.minMinutes ?? ""} onChange={(e) => set({ minMinutes: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>}
          {showMinMax && <label>Max min<input type="number" value={value.maxMinutes ?? ""} onChange={(e) => set({ maxMinutes: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>}
        </div>
      )}
      {value.kind === "library" && (
        <div className="row">
          <label style={{ flex: 2 }}>Library
            <select value={value.value ?? ""} onChange={(e) => set({ value: e.target.value })}>
              <option value="">— pick —</option>
              {libraries.map((l) => <option key={l.id} value={l.name}>{l.name}</option>)}
            </select>
          </label>
          <label>Type
            <select value={value.type ?? ""} onChange={(e) => set({ type: e.target.value || undefined })}>
              <option value="">any</option><option value="other_video">other_video</option>
              <option value="episode">episode</option><option value="movie">movie</option>
            </select>
          </label>
          {showMinMax && <label>Max min<input type="number" value={value.maxMinutes ?? ""} onChange={(e) => set({ maxMinutes: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>}
        </div>
      )}
      {value.kind === "collection" && (
        <CollectionField f={{ label: "Collection", help: "The tag shows its type (manual / smart / multi / playlist)." }} value={value.value ?? ""} onChange={(v) => set({ value: v })} />
      )}
    </div>
  );
}

function SourceList({ label, items, onChange, libraries, note }: { label: string; items: ContentSource[]; onChange: (v: ContentSource[]) => void; libraries: LibraryInfo[]; note?: string }) {
  return (
    <div className="pod-field">
      <div className="pod-field-head"><b>{label}</b><button onClick={() => onChange([...items, emptySource()])}>+ add</button></div>
      {note && <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>{note}</p>}
      {items.length === 0 && <p className="muted" style={{ margin: "2px 0" }}>none</p>}
      {items.map((s, i) => (
        <div key={i} className="src-row">
          <div style={{ flex: 1 }}>
            <SourceEditor value={s} libraries={libraries} onChange={(v) => onChange(items.map((x, j) => j === i ? v : x))} />
            <label className="src-count">Play<input type="number" min={1} value={s.count ?? 1}
              onChange={(e) => onChange(items.map((x, j) => j === i ? { ...x, count: Math.max(1, Number(e.target.value) || 1) } : x))} />per block</label>
          </div>
          <button className="src-del" title="remove" onClick={() => onChange(items.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
    </div>
  );
}

const TYPE_LABEL: Record<PodType, string> = { show: "Show pods", break: "Break pods", filler: "Filler pods" };

export function Pods() {
  const [pods, setPods] = useState<Pod[]>([]);
  const [libraries, setLibraries] = useState<LibraryInfo[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Pod | null>(null);
  const [preview, setPreview] = useState<PodPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [showYaml, setShowYaml] = useState(false);
  const dirty = useRef(false);

  const load = () => api.pods().then(setPods).catch(() => {});
  useEffect(() => { load(); api.mediaLibraries().then(setLibraries).catch(() => {}); }, []);

  const select = (p: Pod) => { setSel(p.id); setDraft(JSON.parse(JSON.stringify(p))); setPreview(null); dirty.current = false; };
  const create = (type: PodType) => {
    const d: Pod = { id: "", name: "", type, config: defaultConfig(type) };
    setSel("__new__"); setDraft(d); setPreview(null); dirty.current = true;
  };
  const patch = (p: Partial<Pod>) => { setDraft((d) => d ? { ...d, ...p } : d); dirty.current = true; };
  const patchCfg = (c: any) => { setDraft((d) => d ? { ...d, config: { ...d.config, ...c } } : d); dirty.current = true; };

  const save = async () => {
    if (!draft) return;
    const id = slug(draft.id || draft.name);
    if (!id) return;
    setBusy(true);
    const saved = await api.savePod({ ...draft, id });
    setBusy(false);
    if ((saved as any).error) return;
    await load(); dirty.current = false; select(saved as Pod);
  };
  const remove = async () => {
    if (!draft || sel === "__new__") { setDraft(null); setSel(null); return; }
    if (!confirm(`Delete pod "${draft.name}"?`)) return;
    await api.deletePod(draft.id); setDraft(null); setSel(null); load();
  };
  const duplicate = async () => {
    if (!draft) return;
    const name = prompt("Name for the duplicate:", `${draft.name || draft.id || "pod"} copy`);
    if (!name || !name.trim()) return;
    const existing = new Set(pods.map((p) => p.id));
    let id = slug(name), n = 2;
    while (existing.has(id)) { id = slug(`${name} ${n}`); n++; }
    setBusy(true);
    const saved = await api.savePod({ id, name: name.trim(), type: draft.type, config: JSON.parse(JSON.stringify(draft.config ?? {})) });
    setBusy(false);
    if ((saved as any).error) { alert((saved as any).error); return; }
    await load(); select(saved as Pod);
  };
  const runPreview = async () => {
    if (!draft) return;
    setBusy(true); setPreview(null);
    const id = slug(draft.id || draft.name);
    const others = pods.filter((p) => p.id !== id);
    const r = await api.podPreview({ pods: [...others, { ...draft, id }], entryId: id, hours: 4 });
    setPreview(r); setBusy(false);
  };

  const grouped = useMemo(() => {
    const g: Record<PodType, Pod[]> = { show: [], break: [], filler: [] };
    for (const p of pods) (g[p.type] ?? (g[p.type] = [])).push(p);
    return g;
  }, [pods]);

  const breakPods = grouped.break, fillerPods = grouped.filler;

  return (
    <section className="screen pods">
      <div className="pods-side list-pane">
        <div className="pane-head"><h2>Pods</h2></div>
        <p className="muted" style={{ fontSize: 12, margin: "0 0 4px" }}>Reusable building blocks. Make Break and Filler pods, then build Show pods from them and drag those onto a Pods-mode channel.</p>
        {(["show", "break", "filler"] as PodType[]).map((t) => (
          <div key={t}>
            <div className="pods-side-head"><h2>{TYPE_LABEL[t]}</h2><button onClick={() => create(t)}>+ New</button></div>
            <ul className="pod-list">
              {grouped[t].map((p) => (
                <li key={p.id} className={sel === p.id ? "active" : ""} onClick={() => select(p)}>{p.name || p.id}</li>
              ))}
              {grouped[t].length === 0 && <li className="muted empty">none yet</li>}
            </ul>
          </div>
        ))}
      </div>

      <div className="pods-main">
        {!draft && (
          <div className="empty-state">
            <div className="empty-icon">◫</div>
            <h2>Pick a pod</h2>
            <p className="muted"><b>Break</b> pods are commercial breaks, <b>Filler</b> pods pad to the clock, and <b>Show</b> pods wrap a show with its breaks, bumpers and promos.</p>
            <div className="actions" style={{ justifyContent: "center" }}>
              <button className="primary" onClick={() => create("show")}>+ Show pod</button>
              <button onClick={() => create("break")}>+ Break pod</button>
              <button onClick={() => create("filler")}>+ Filler pod</button>
            </div>
          </div>
        )}
        {draft && (
          <>
            <div className="editor-head">
              <div className="editor-title">
                <div>
                  <h1>{draft.name || (sel === "__new__" ? `New ${draft.type} pod` : draft.id)}</h1>
                  <div className="muted editor-sub">{TYPE_LABEL[draft.type]?.replace(/s$/, "") ?? draft.type}{sel === "__new__" ? " · not saved yet" : ""}</div>
                </div>
              </div>
              <div className="actions" style={{ marginTop: 0 }}>
                <button onClick={runPreview} disabled={busy}>{busy ? "Working…" : "Preview"}</button>
                <button onClick={duplicate} disabled={busy || sel === "__new__"} title="Save a copy of this pod">Duplicate</button>
                <button className="danger" onClick={remove}>Delete</button>
              </div>
            </div>
            <div className="row">
              <label style={{ flex: 2 }}>Name<input value={draft.name} placeholder="Rugrats (show)" onChange={(e) => patch(sel === "__new__" ? { name: e.target.value, id: slug(e.target.value) } : { name: e.target.value })} /></label>
              <label>Key<input value={slug(draft.id || draft.name)} readOnly className="mono" title="Stable internal id — set once, referenced by channels/pods. Renaming won't change it." /></label>
            </div>

            {draft.type === "break" && (
              <div className="pod-editor">
                <div className="pod-field"><b>Lead-in bumper (“be right back”)</b><SourceEditor role="bumper" defaultPhrase="be right back" value={draft.config.leadIn ?? bumperSource("be right back")} libraries={libraries} onChange={(v) => patchCfg({ leadIn: v })} /></div>
                <div className="pod-field"><b>Commercials</b><SourceEditor value={draft.config.body ?? emptySource()} libraries={libraries} onChange={(v) => patchCfg({ body: v })} /></div>
                <div className="row">
                  <label>Fill mode
                    <select value={draft.config.target ? "target" : "count"} onChange={(e) => patchCfg(e.target.value === "target" ? { target: draft.config.target || "2 minutes", bodyCount: undefined } : { target: undefined, bodyCount: draft.config.bodyCount ?? 4 })}>
                      <option value="count">Fixed count</option><option value="target">Fill to length</option>
                    </select>
                  </label>
                  {draft.config.target
                    ? <label>Target length<input value={draft.config.target} onChange={(e) => patchCfg({ target: e.target.value })} placeholder="2 minutes" /></label>
                    : <label>Commercials<input type="number" value={draft.config.bodyCount ?? 4} onChange={(e) => patchCfg({ bodyCount: Number(e.target.value) })} /></label>}
                  <label>No-repeat within<input value={draft.config.noRepeat ?? ""} placeholder="30 minutes" onChange={(e) => patchCfg({ noRepeat: e.target.value || undefined })} /></label>
                </div>
                <div className="pod-field"><b>Lead-out bumper (“back to”)</b><SourceEditor role="bumper" defaultPhrase="back to" value={draft.config.leadOut ?? bumperSource("back to")} libraries={libraries} onChange={(v) => patchCfg({ leadOut: v })} /></div>
              </div>
            )}

            {draft.type === "filler" && (
              <div className="pod-editor">
                <div className="pod-field"><b>Filler content (promos / bumpers)</b><SourceEditor value={draft.config.content ?? emptySource()} libraries={libraries} onChange={(v) => patchCfg({ content: v })} /></div>
                <div className="row">
                  <label>Align to
                    <select value={draft.config.align ?? 0} onChange={(e) => patchCfg({ align: Number(e.target.value) })}>
                      {ALIGN.map((a) => <option key={a} value={a}>{a === 0 ? "no padding" : `:${String(a).padStart(2, "0")} min`}</option>)}
                    </select>
                  </label>
                  <label>Role
                    <select value={draft.config.fillerKind ?? "postroll"} onChange={(e) => patchCfg({ fillerKind: e.target.value })}>
                      <option value="postroll">postroll</option><option value="preroll">preroll</option><option value="midroll">midroll</option>
                    </select>
                  </label>
                  <label className="switch" style={{ alignSelf: "flex-end" }}><input type="checkbox" checked={draft.config.trim ?? true} onChange={(e) => patchCfg({ trim: e.target.checked })} /> trim to boundary</label>
                </div>
              </div>
            )}

            {draft.type === "show" && (
              <div className="pod-editor">
                <div className="pod-field"><b>Show</b><SourceEditor role="show" value={draft.config.show ?? emptySource()} libraries={libraries} onChange={(v) => patchCfg({ show: v })} /></div>
                <SourceList label="Pre-roll bumpers" items={draft.config.preroll ?? []} libraries={libraries} onChange={(v) => patchCfg({ preroll: v })}
                  note="Each row plays its “Play N per block” items (default 1) before the show, drawn from the query in the chosen order — the cursor advances every block, so items don’t repeat until the pool is exhausted. Add more rows to sequence different sources." />
                <div className="pod-field">
                  <div className="pod-field-head"><b>Mid-roll commercial break</b>
                    <label className="switch"><input type="checkbox" checked={!!draft.config.midRoll} onChange={(e) => patchCfg({ midRoll: e.target.checked ? { breakPodId: breakPods[0]?.id ?? "", mode: "interval", interval: "8 minutes", breaks: 2, minSegment: "5 minutes" } : undefined })} /> enabled</label>
                  </div>
                  {draft.config.midRoll && (
                    <div className="row">
                      <label>Break pod
                        <select value={draft.config.midRoll.breakPodId ?? ""} onChange={(e) => patchCfg({ midRoll: { ...draft.config.midRoll, breakPodId: e.target.value } })}>
                          <option value="">— pick a break pod —</option>
                          {breakPods.map((b) => <option key={b.id} value={b.id}>{b.name || b.id}</option>)}
                        </select>
                      </label>
                      <label>When
                        <select value={draft.config.midRoll.mode} onChange={(e) => patchCfg({ midRoll: { ...draft.config.midRoll, mode: e.target.value } })}>
                          <option value="interval">Every N minutes</option><option value="chapters">At chapters</option><option value="count">N breaks per half hour</option>
                        </select>
                      </label>
                      {draft.config.midRoll.mode === "interval" && <label>Interval<input value={draft.config.midRoll.interval ?? ""} placeholder="8 minutes" onChange={(e) => patchCfg({ midRoll: { ...draft.config.midRoll, interval: e.target.value } })} /></label>}
                      <label>Max breaks<input type="number" value={draft.config.midRoll.breaks ?? ""} onChange={(e) => patchCfg({ midRoll: { ...draft.config.midRoll, breaks: e.target.value === "" ? undefined : Number(e.target.value) } })} /></label>
                    </div>
                  )}
                </div>
                <SourceList label="Post-roll (promos)" items={draft.config.postroll ?? []} libraries={libraries} onChange={(v) => patchCfg({ postroll: v })}
                  note="Each row plays its “Play N per block” items (default 1) after the show. Same draw behavior as pre-roll." />
                <div className="pod-field">
                  <div className="pod-field-head"><b>“Up next” bumper</b>
                    <label className="switch"><input type="checkbox" checked={!!draft.config.upNext} onChange={(e) => patchCfg({ upNext: e.target.checked ? { kind: "next_bumper", phrase: "up next", type: "other_video", order: "shuffle" } : undefined })} /> enabled</label>
                  </div>
                  {draft.config.upNext && <SourceEditor role="upnext" defaultPhrase="up next" value={draft.config.upNext} libraries={libraries} onChange={(v) => patchCfg({ upNext: v })} />}
                </div>
                <div className="pod-field"><b>Tail filler (pads to the clock boundary)</b>
                  <div className="row">
                    <label>Align block to
                      <select value={draft.config.align ?? 0} onChange={(e) => patchCfg({ align: Number(e.target.value) })}>
                        {ALIGN.map((a) => <option key={a} value={a}>{a === 0 ? "no alignment" : `:${String(a).padStart(2, "0")} min`}</option>)}
                      </select>
                    </label>
                    <label>Use filler pod
                      <select value={draft.config.tailFillerPodId ?? ""} onChange={(e) => patchCfg({ tailFillerPodId: e.target.value || undefined, tailFiller: undefined })}>
                        <option value="">— ad-hoc below —</option>
                        {fillerPods.map((f) => <option key={f.id} value={f.id}>{f.name || f.id}</option>)}
                      </select>
                    </label>
                  </div>
                  {!draft.config.tailFillerPodId && <SourceEditor value={draft.config.tailFiller ?? emptySource()} libraries={libraries} onChange={(v) => patchCfg({ tailFiller: v })} />}
                </div>
              </div>
            )}

            <div className="actions sticky-actions">
              <button className="primary" onClick={save} disabled={busy || !(draft.name || draft.id)}>Save pod</button>
              <button onClick={runPreview} disabled={busy}>{busy ? "Working…" : "Preview 4 hours"}</button>
              <button className="ghost" onClick={() => setShowYaml((s) => !s)} disabled={!preview?.yaml}>{showYaml ? "Hide YAML" : "Show YAML"}</button>
            </div>

            {preview?.error && <p className="err">{preview.error}</p>}
            {preview?.warning && <p className="muted">{preview.warning}</p>}
            {showYaml && preview?.yaml && <pre className="log yaml">{preview.yaml}</pre>}
            {preview?.items && preview.items.length > 0 && (
              <div className="pod-preview">
                <div className="legend">
                  {["Program", "Commercial", "Bumper", "Promo", "Up Next", "Break bumper", "Transition"].map((l) =>
                    <span key={l} className="chip"><i style={{ background: CATEGORY_COLORS[l] ?? CATEGORY_COLORS.Filler }} />{l}</span>)}
                </div>
                <div className="tl-bar pod-tl">
                  {preview.items.map((it) => {
                    const dur = Date.parse(it.finish) - Date.parse(it.start);
                    const disp = nameOf(it.source?.path ?? "");
                    const { cat, color } = category(preview.labels?.[it.id], disp);
                    return <div key={it.id} className="seg" style={{ flexGrow: Math.max(dur, 4000), background: color }}
                      title={`${it.start.slice(11, 19)}  ${cat}\n${disp}`}>
                      {dur > 90000 ? disp.slice(0, 20) : ""}
                    </div>;
                  })}
                </div>
                <p className="muted" style={{ fontSize: 12 }}>{preview.items.length} items over a 4-hour test build (starts at local midnight).</p>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
