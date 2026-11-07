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

// A tree of the filler's folders, as they are on disk (the folders at each library's
// root first) — the filler its sibling fields pick (the collection, else the
// libraries). Ticking a folder takes everything in it and below it; several ticked
// folders mix. Rules saved as tags (older configs) still show and still work.
type FolderCount = { library: string; dir: string; count: number };
type TagSource = { items: number; tags: { tag: string; count: number }[]; combos?: { tags: string[]; count: number }[]; folders?: FolderCount[]; error?: string };
type FolderRuleV = { library?: string; folder: string };
type RuleV = string | string[] | FolderRuleV;
const TAG_CACHE = new Map<string, Promise<TagSource>>();
const isFolderV = (r: RuleV): r is FolderRuleV => !!r && typeof r === "object" && !Array.isArray(r) && typeof (r as any).folder === "string";
const lc = (s: string) => s.toLowerCase();
const folderKey = (library: string | undefined, dir: string) => `${lc(library ?? "")}\u0001${lc(dir)}`;
const tagRuleOf = (r: string | string[]): string[] => (Array.isArray(r) ? r : [r]).filter(Boolean);

function TagsField({ f, value, group, onChange }: { f: Extract<SchemaField, { type: "tags" }>; value: RuleV[]; group?: any; onChange: (v: RuleV[]) => void }) {
  const collection: string = (f.collection && group?.[f.collection]) || "";
  const libraries: string[] = collection ? [] : ((f.libraries && Array.isArray(group?.[f.libraries]) ? group[f.libraries] : []) as string[]).filter(Boolean);
  const src = collection ? `c:${collection}` : libraries.length ? `l:${[...libraries].sort().join("|")}` : "";
  const [res, setRes] = useState<TagSource | null>(null);
  const [filter, setFilter] = useState("");
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!src) { setRes(null); return; }
    let live = true;
    setRes(null);
    if (!TAG_CACHE.has(src)) TAG_CACHE.set(src, api.fillerTags(collection ? { collection } : { libraries }).catch((e) => { TAG_CACHE.delete(src); return { items: 0, tags: [], error: String(e) }; }));
    TAG_CACHE.get(src)!.then((r) => { if (live) setRes(r); });
    return () => { live = false; };
  }, [src]);

  // the folder tree: every folder with how many items are in it and below it
  type FNode = { library: string; dir: string; name: string; count: number; kids: Map<string, FNode> };
  const libsSeen = new Map<string, FNode>();
  for (const fc of res?.folders ?? []) {
    let lib = libsSeen.get(lc(fc.library));
    if (!lib) { lib = { library: fc.library, dir: "", name: fc.library, count: 0, kids: new Map() }; libsSeen.set(lc(fc.library), lib); }
    lib.count += fc.count;
    let node = lib;
    const segs = fc.dir ? fc.dir.split("/") : [];
    segs.forEach((s, i) => {
      let k = node.kids.get(lc(s));
      if (!k) { k = { library: fc.library, dir: segs.slice(0, i + 1).join("/"), name: s, count: 0, kids: new Map() }; node.kids.set(lc(s), k); }
      k.count += fc.count;
      node = k;
    });
  }
  const sorted = (m: Map<string, FNode>) => [...m.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const libNodes = sorted(libsSeen);
  const multiLib = libNodes.length > 1;

  const folderRules = value.filter(isFolderV);
  const tagRules = value.filter((r) => !isFolderV(r)).map((r) => tagRuleOf(r as string | string[])).filter((r) => r.length);
  const ticked = new Set(folderRules.map((r) => folderKey(r.library, r.folder)));
  // a folder is covered when it, or a folder above it, is ticked
  const coveredBy = (library: string, dir: string): FolderRuleV | undefined => folderRules.find((r) =>
    (!r.library || lc(r.library) === lc(library)) && (lc(dir) === lc(r.folder) || lc(dir).startsWith(lc(r.folder) + "/")));
  const toggleFolder = (n: FNode) => {
    const k = folderKey(n.library, n.dir);
    if (ticked.has(k)) onChange(value.filter((r) => !(isFolderV(r) && folderKey(r.library, r.folder) === k)));
    // ticking a folder replaces any ticked folders inside it (they'd be covered anyway)
    else onChange([...value.filter((r) => !(isFolderV(r) && (!r.library || lc(r.library) === lc(n.library)) && lc(r.folder).startsWith(lc(n.dir) + "/"))), { library: n.library, folder: n.dir }]);
  };
  const removeRule = (rule: RuleV) => onChange(value.filter((r) => r !== rule));
  const flip = (id: string) => setOpenIds((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // exact count for folder rules; tag rules (older configs) add their own matches
  const folderMatched = (res?.folders ?? []).reduce((n, fc) => (coveredBy(fc.library, fc.dir) ? n + fc.count : n), 0);
  const combos = (res?.combos ?? []).map((c) => ({ set: new Set(c.tags.map(lc)), count: c.count }));
  const tagMatched = combos.reduce((n, c) => (tagRules.some((r) => r.every((t) => c.set.has(lc(t)))) ? n + c.count : n), 0);
  const folderExists = (r: FolderRuleV) => (res?.folders ?? []).some((fc) => (!r.library || lc(r.library) === lc(fc.library)) && (lc(fc.dir) === lc(r.folder) || lc(fc.dir).startsWith(lc(r.folder) + "/")));
  const ruleLabel = (r: RuleV) => isFolderV(r)
    ? `${multiLib && r.library ? `${r.library} › ` : ""}${r.folder.split("/").join(" › ")}`
    : `tags: ${tagRuleOf(r as string | string[]).join(" + ")}`;

  const Node = ({ n, depth, label }: { n: FNode; depth: number; label?: string }) => {
    const id = folderKey(n.library, n.dir) + (n.dir ? "" : "\u0002lib");
    const isLib = !n.dir;
    const open = openIds.has(id);
    const kids = sorted(n.kids);
    const parentRule = !isLib ? coveredBy(n.library, n.dir) : undefined;
    const own = !isLib && ticked.has(folderKey(n.library, n.dir));
    const inherited = !!parentRule && !own;
    return (
      <div>
        <div className="tag-node" style={{ paddingLeft: depth * 18 }}>
          <button type="button" className="tag-twisty" onClick={() => flip(id)} disabled={!kids.length} aria-label={open ? "Close" : "Open"}>{kids.length ? (open ? "▾" : "▸") : ""}</button>
          {isLib
            ? <span><b>{n.name}</b> <span className="muted" style={{ fontSize: 11 }}>({n.count.toLocaleString()}) library</span></span>
            : <label className="switch" title={inherited ? "Included: a folder above it is ticked" : undefined}>
                <input type="checkbox" checked={own || inherited} disabled={inherited} onChange={() => toggleFolder(n)} /> 📁 {label ?? n.name} <span className="muted" style={{ fontSize: 11 }}>({n.count.toLocaleString()})</span>
              </label>}
        </div>
        {open && kids.map((k) => <Node key={k.dir} n={k} depth={depth + 1} />)}
      </div>
    );
  };
  // top level: the folders at the library's root (or the libraries, when there are several)
  const q = filter.trim().toLowerCase();
  const allFolders: FNode[] = [];
  const walk = (n: FNode) => { for (const k of n.kids.values()) { allFolders.push(k); walk(k); } };
  libNodes.forEach(walk);
  const matches = q ? allFolders.filter((n) => lc(n.name).includes(q)).sort((a, b) => a.dir.localeCompare(b.dir)) : [];
  const rootFiles = libNodes.reduce((n, l) => n + l.count - [...l.kids.values()].reduce((m, k) => m + k.count, 0), 0);

  return (
    <div className="lib-field">
      <div>{f.label}</div>
      {f.help && <p className="muted" style={{ fontSize: 11, margin: "2px 0 4px" }}>{f.help}</p>}
      {value.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, margin: "2px 0 6px" }}>
          {value.map((r, i) => {
            const missing = !!res && !res.error && (isFolderV(r) ? !folderExists(r) : !combos.some((c) => tagRuleOf(r as string | string[]).every((t) => c.set.has(lc(t)))));
            return (
              <button key={i} type="button" className={missing ? "danger" : ""} style={{ fontSize: 12, padding: "2px 8px" }}
                title={missing ? "Nothing in this filler matches — click to remove" : "Click to remove"} onClick={() => removeRule(r)}>{isFolderV(r) ? "📁 " : ""}{ruleLabel(r)} ✕</button>
            );
          })}
        </div>
      )}
      {!src ? <span className="muted" style={{ fontSize: 12 }}>Pick filler libraries or a filler collection above to see their folders.</span>
        : !res ? <span className="muted" style={{ fontSize: 12 }}>Looking up folders…</span>
        : res.error ? <span className="err" style={{ fontSize: 12 }}>{res.error}</span>
        : !res.folders ? <span className="muted" style={{ fontSize: 12 }}>Restart the scheduler to see the folder tree.</span>
        : allFolders.length === 0 ? <span className="muted" style={{ fontSize: 12 }}>The {res.items.toLocaleString()} filler items aren't in subfolders, so there's nothing to narrow by.</span>
        : <>
          {allFolders.length > 12 && <input placeholder="Find a folder…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 240, fontSize: 12, marginBottom: 4 }} />}
          <div className="tag-tree">
            {q ? (matches.length ? matches.map((n) => <Node key={`${n.library}/${n.dir}`} n={n} depth={0} label={`${multiLib ? `${n.library} › ` : ""}${n.dir.split("/").join(" › ")}`} />)
                  : <span className="muted" style={{ fontSize: 12 }}>No folder matches “{filter}”.</span>)
              : multiLib ? libNodes.map((l) => <Node key={l.library} n={l} depth={0} />)
              : sorted(libNodes[0].kids).map((k) => <Node key={k.dir} n={k} depth={0} />)}
          </div>
          <span className="muted" style={{ fontSize: 11 }}>
            {value.length
              ? `Breaks draw from ${(folderMatched + tagMatched).toLocaleString()} of ${res.items.toLocaleString()} filler items.`
              : `${res.items.toLocaleString()} filler items in ${allFolders.length.toLocaleString()} folders.`}
            {rootFiles > 0 && ` ${rootFiles.toLocaleString()} sit directly in the library's top folder.`}
          </span>
        </>}
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
