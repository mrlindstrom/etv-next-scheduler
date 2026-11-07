// Generic form renderer for a scheduling module's declared option schema.
// Supports text / textarea / query / number / select / checkbox / libraries, and
// repeatable `list` groups (e.g. the schedule's blocks). Any module that declares
// a schema gets a form for free.
import { OverlayPicker } from "./OverlayPicker.js";
import { useEffect, useState } from "react";
import { api, type SchemaField, type LibraryInfo, type CollectionInfo } from "./api.js";
import { QueryBox } from "./QueryBox.js";

function visible(f: SchemaField, value: any): boolean {
  const s = (f as any).showIf as { key: string; equals: string | string[] } | undefined;
  if (!s) return true;
  const cur = value?.[s.key] ?? ""; // unset matches ""
  return Array.isArray(s.equals) ? s.equals.includes(cur) : cur === s.equals;
}

export function SchemaForm({ fields, value, onChange }: { fields: SchemaField[]; value: any; onChange: (v: any) => void }) {
  const set = (k: string, v: any) => onChange({ ...value, [k]: v });
  return (
    <div className="form">
      {fields.map((f, i) => visible(f, value) ? <FieldView key={i} f={f} value={value?.[f.key]} group={value} onChange={(v) => set(f.key, v)} /> : null)}
    </div>
  );
}

function FieldView({ f, value, group, onChange }: { f: SchemaField; value: any; group?: any; onChange: (v: any) => void }) {
  if (f.type === "list") return <ListField f={f} value={Array.isArray(value) ? value : []} onChange={onChange} />;
  if (f.type === "tags") return <TagsField f={f} value={Array.isArray(value) ? value : []} group={group} onChange={onChange} />;
  if (f.type === "libraries") return <LibrariesField f={f} value={Array.isArray(value) ? value : []} onChange={onChange} />;
  if (f.type === "collection") return <CollectionField f={f} value={value} onChange={onChange} />;
  if (f.type === "channel") return <ChannelField f={f} value={value} onChange={onChange} />;
  if (f.type === "overlays") return <label>{f.label}<OverlayPicker value={Array.isArray(value) ? value : []} onChange={onChange} />{f.help && <span className="muted" style={{ fontSize: 12 }}>{f.help}</span>}</label>;
  if (f.type === "checkbox")
    return <label className="switch"><input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> {f.label}{f.help && <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>{f.help}</span>}</label>;
  if (f.type === "select")
    return <label>{f.label}<select value={value ?? f.default ?? ""} onChange={(e) => onChange(e.target.value)}>{f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>{f.help && <span className="muted" style={{ fontSize: 11 }}>{f.help}</span>}</label>;
  if (f.type === "number")
    return <label>{f.label}<input type="number" value={value ?? f.default ?? ""} min={f.min} max={f.max} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />{f.help && <span className="muted" style={{ fontSize: 11 }}>{f.help}</span>}</label>;
  if (f.type === "query")
    return <label>{f.label}<QueryBox value={value ?? f.default ?? ""} onChange={(v: string) => onChange(v)} placeholder={f.placeholder} rows={1} submitHint="Shift+Enter for a new line" />{f.help && <span className="muted" style={{ fontSize: 11 }}>{f.help}</span>}</label>;
  if (f.type === "textarea")
    return <label>{f.label}<textarea value={value ?? f.default ?? ""} placeholder={f.placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)} />{f.help && <span className="muted" style={{ fontSize: 11 }}>{f.help}</span>}</label>;
  return <label>{f.label}<input value={value ?? f.default ?? ""} placeholder={(f as any).placeholder} onChange={(e) => onChange(e.target.value)} />{f.help && <span className="muted" style={{ fontSize: 11 }}>{f.help}</span>}</label>;
}

// cache the local-library list across every LibrariesField instance
let LIB_CACHE: LibraryInfo[] | null = null;
function LibrariesField({ f, value, onChange }: { f: Extract<SchemaField, { type: "libraries" }>; value: string[]; onChange: (v: string[]) => void }) {
  const [libs, setLibs] = useState<LibraryInfo[]>(LIB_CACHE ?? []);
  useEffect(() => {
    if (LIB_CACHE) return;
    api.mediaLibraries().then((l) => { LIB_CACHE = l.filter((x) => x.sourceType === "local"); setLibs(LIB_CACHE); }).catch(() => {});
  }, []);
  const local = libs.filter((l) => l.sourceType === "local");
  const sel = new Set(value);
  const toggle = (name: string) => { const s = new Set(value); s.has(name) ? s.delete(name) : s.add(name); onChange([...s]); };
  return (
    <div className="lib-field">
      <div>{f.label}</div>
      {f.help && <p className="muted" style={{ fontSize: 11, margin: "2px 0 4px" }}>{f.help}</p>}
      {local.length === 0 && <span className="muted">No local libraries — add one on the Library page.</span>}
      <div className="lib-checks">
        {local.map((l) => (
          <label key={l.id} className="switch"><input type="checkbox" checked={sel.has(l.name)} onChange={() => toggle(l.name)} /> {l.name} <span className="muted" style={{ fontSize: 11 }}>({l.kind})</span></label>
        ))}
      </div>
    </div>
  );
}

// Tick-boxes of the tags on the filler its sibling fields pick (the collection, else the
// libraries), with how many items carry each. Ticked tags that no longer appear stay listed.
const TAG_CACHE = new Map<string, Promise<{ items: number; tags: { tag: string; count: number }[]; error?: string }>>();
function TagsField({ f, value, group, onChange }: { f: Extract<SchemaField, { type: "tags" }>; value: string[]; group?: any; onChange: (v: string[]) => void }) {
  const collection: string = (f.collection && group?.[f.collection]) || "";
  const libraries: string[] = collection ? [] : ((f.libraries && Array.isArray(group?.[f.libraries]) ? group[f.libraries] : []) as string[]).filter(Boolean);
  const src = collection ? `c:${collection}` : libraries.length ? `l:${[...libraries].sort().join("|")}` : "";
  const [res, setRes] = useState<{ items: number; tags: { tag: string; count: number }[]; error?: string } | null>(null);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    if (!src) { setRes(null); return; }
    let live = true;
    setRes(null);
    if (!TAG_CACHE.has(src)) TAG_CACHE.set(src, api.fillerTags(collection ? { collection } : { libraries }).catch((e) => { TAG_CACHE.delete(src); return { items: 0, tags: [], error: String(e) }; }));
    TAG_CACHE.get(src)!.then((r) => { if (live) setRes(r); });
    return () => { live = false; };
  }, [src]);
  const sel = new Set(value.map((t) => t.toLowerCase()));
  const toggle = (t: string) => onChange(sel.has(t.toLowerCase()) ? value.filter((x) => x.toLowerCase() !== t.toLowerCase()) : [...value, t]);
  const found = res?.tags ?? [];
  const missing = value.filter((t) => !found.some((x) => x.tag.toLowerCase() === t.toLowerCase()));
  const q = filter.trim().toLowerCase();
  const shown = found.filter((t) => !q || t.tag.toLowerCase().includes(q));
  const picked = found.filter((t) => sel.has(t.tag.toLowerCase())).reduce((n, t) => n + t.count, 0);
  return (
    <div className="lib-field">
      <div>{f.label}</div>
      {f.help && <p className="muted" style={{ fontSize: 11, margin: "2px 0 4px" }}>{f.help}</p>}
      {!src ? <span className="muted" style={{ fontSize: 12 }}>Pick filler libraries or a filler collection above to see their tags.</span>
        : !res ? <span className="muted" style={{ fontSize: 12 }}>Looking up tags…</span>
        : res.error ? <span className="err" style={{ fontSize: 12 }}>{res.error}</span>
        : found.length === 0 ? <span className="muted" style={{ fontSize: 12 }}>None of the {res.items.toLocaleString()} filler items have tags. Add tags to them (in the files' metadata, then rescan) to use this.</span>
        : <>
          {found.length > 12 && <input placeholder="Filter tags…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 240, fontSize: 12, marginBottom: 4 }} />}
          <div className="lib-checks" style={{ maxHeight: 180, overflow: "auto" }}>
            {shown.map((t) => (
              <label key={t.tag} className="switch"><input type="checkbox" checked={sel.has(t.tag.toLowerCase())} onChange={() => toggle(t.tag)} /> {t.tag} <span className="muted" style={{ fontSize: 11 }}>({t.count.toLocaleString()})</span></label>
            ))}
          </div>
          <span className="muted" style={{ fontSize: 11 }}>
            {value.length ? `Breaks draw from up to ${picked.toLocaleString()} of ${res.items.toLocaleString()} filler items.` : `${res.items.toLocaleString()} filler items, ${found.length} tags.`}
          </span>
        </>}
      {res && !res.error && missing.length > 0 && (
        <div style={{ fontSize: 12, marginTop: 4 }}>
          <span className="err">Not on any of this filler: </span>
          {missing.map((t) => <button key={t} type="button" style={{ fontSize: 11, padding: "1px 6px", marginLeft: 4 }} title="Remove" onClick={() => toggle(t)}>{t} ✕</button>)}
        </div>
      )}
    </div>
  );
}

// A dropdown of the channels (for modes that build on another channel).
function ChannelField({ f, value, onChange }: { f: { label: string; help?: string }; value: string; onChange: (v: string) => void }) {
  const [chs, setChs] = useState<{ name: string; number?: string; mode?: string }[]>([]);
  useEffect(() => { api.channels().then((l) => setChs(l.filter((c) => c.mode !== "timeshift" && c.mode !== "remote").map((c) => ({ name: c.name, number: c.meta?.number, mode: c.mode })))).catch(() => {}); }, []);
  return (
    <label>{f.label}
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">— pick a channel —</option>
        {value && !chs.some((c) => c.name === value) && <option value={value}>{value}{chs.length ? " · not found" : ""}</option>}
        {chs.map((c) => <option key={c.name} value={c.name}>{c.number ? `${c.number} · ` : ""}{c.name}</option>)}
      </select>
      {f.help && <span className="muted" style={{ fontSize: 11 }}>{f.help}</span>}
    </label>
  );
}

// A dropdown of every collection, tagged by type. Value is "<type>::<name>".
const COLL_LABEL: Record<string, string> = { collection: "manual", smart: "smart", multi: "multi", playlist: "playlist" };
// The last list shows instantly; it's re-fetched whenever a form opens so new
// collections appear (fields mounting together share one request).
let COLL_CACHE: CollectionInfo[] | null = null;
let COLL_LOADING: Promise<CollectionInfo[]> | null = null;
const loadCollections = () => (COLL_LOADING ??= api.collections().then((c) => (COLL_CACHE = c)).finally(() => { COLL_LOADING = null; }));
export function CollectionField({ f, value, onChange }: { f: { label: string; help?: string }; value: string; onChange: (v: string) => void }) {
  const [colls, setColls] = useState<CollectionInfo[] | null>(COLL_CACHE);
  useEffect(() => { let live = true; loadCollections().then((c) => { if (live) setColls(c); }).catch(() => {}); return () => { live = false; }; }, []);
  // keep a saved pick visible: as-is while loading, flagged if the collection
  // was since renamed or deleted
  const missing = value && !(colls ?? []).some((c) => `${c.type}::${c.name}` === value) ? value : "";
  const missingLabel = missing.split("::").slice(1).join("::") + (colls ? " · not found" : "");
  return (
    <label>{f.label}
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">— pick a collection —</option>
        {missing && <option value={missing}>{missingLabel}</option>}
        {(["collection", "smart", "multi", "playlist"] as const).map((t) => {
          const items = (colls ?? []).filter((c) => c.type === t);
          if (!items.length) return null;
          return (
            <optgroup key={t} label={`${COLL_LABEL[t]} collections`}>
              {items.map((c) => <option key={`${t}-${c.id}`} value={`${t}::${c.name}`}>{c.name} · {COLL_LABEL[t]}</option>)}
            </optgroup>
          );
        })}
      </select>
      {f.help && <span className="muted" style={{ fontSize: 11 }}>{f.help}</span>}
    </label>
  );
}

function defaults(fields: SchemaField[]): any {
  const o: any = {};
  for (const f of fields) if (f.type !== "list" && "default" in f && f.default !== undefined) o[f.key] = f.default;
  return o;
}

function ListField({ f, value, onChange }: { f: Extract<SchemaField, { type: "list" }>; value: any[]; onChange: (v: any[]) => void }) {
  const update = (i: number, item: any) => onChange(value.map((v, j) => (j === i ? item : v)));
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i));
  const add = () => onChange([...value, defaults(f.fields)]);
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= value.length) return; const a = [...value]; [a[i], a[j]] = [a[j], a[i]]; onChange(a); };
  return (
    <div className="list-field">
      <div className="pane-head" style={{ margin: "4px 0" }}><b>{f.label}</b><button type="button" onClick={add}>{f.addLabel ?? "+ Add"}</button></div>
      {f.help && <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>{f.help}</p>}
      {value.length === 0 && <p className="muted">None yet — click {f.addLabel ?? "Add"}.</p>}
      {value.map((item, i) => (
        <div key={i} className="meta-card" style={{ marginBottom: 10 }}>
          <div className="pane-head" style={{ margin: 0 }}>
            <b>{i + 1}. {f.itemTitle && item[f.itemTitle] ? String(item[f.itemTitle]).slice(0, 60) : "block"}</b>
            <span>
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === value.length - 1} style={{ marginLeft: 4 }}>↓</button>
              <button type="button" className="danger" onClick={() => remove(i)} style={{ marginLeft: 6 }}>Remove</button>
            </span>
          </div>
          <SchemaForm fields={f.fields} value={item} onChange={(v) => update(i, v)} />
        </div>
      ))}
    </div>
  );
}
