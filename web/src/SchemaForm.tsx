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
    // unset shows the default (what the build uses), e.g. "keep breaks inside the slot" = on
    return <label className="switch"><input type="checkbox" checked={value ?? f.default ?? false} onChange={(e) => onChange(e.target.checked)} /> {f.label}{f.help && <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>{f.help}</span>}</label>;
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

// The filler's tags, laid out like its folders on disk (each folder is a tag, so the
// folders at the library's root come first) — the filler its sibling fields pick (the
// collection, else the libraries). Ticking a tag picks everything tagged with it and
// the tags above it (PSA › Christmas = PSA AND Christmas); what's under it shows ticked
// too, and unticking one of those adds a NOT (PSA AND NOT Christmas). Several ticked
// tags mix. Older picks (plain tags, folders) still show and still work.
type FolderCount = { library: string; dir: string; count: number };
type TagSource = { items: number; tags: { tag: string; count: number }[]; combos?: { tags: string[]; count: number }[]; folders?: FolderCount[]; error?: string };
type SetRule = { tags: string[]; except?: string[][] };
type RuleV = string | string[] | { library?: string; folder: string } | SetRule;
const TAG_CACHE = new Map<string, Promise<TagSource>>();
const isSetV = (r: RuleV): r is SetRule => !!r && typeof r === "object" && !Array.isArray(r) && Array.isArray((r as any).tags);
const isFolderV = (r: RuleV): r is { library?: string; folder: string } => !!r && typeof r === "object" && !Array.isArray(r) && typeof (r as any).folder === "string";
const lc = (s: string) => s.toLowerCase();
const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => lc(t) === lc(b[i]));
const isPrefix = (a: string[], b: string[]) => a.length <= b.length && a.every((t, i) => lc(t) === lc(b[i]));

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

  // the tree's shape: the folders (each one a tag), per library
  type FNode = { library: string; path: string[]; name: string; kids: Map<string, FNode> };
  const libsSeen = new Map<string, FNode>();
  for (const fc of res?.folders ?? []) {
    let node = libsSeen.get(lc(fc.library));
    if (!node) { node = { library: fc.library, path: [], name: fc.library, kids: new Map() }; libsSeen.set(lc(fc.library), node); }
    const segs = fc.dir ? fc.dir.split("/") : [];
    segs.forEach((s, i) => {
      let k = node!.kids.get(lc(s));
      if (!k) { k = { library: fc.library, path: segs.slice(0, i + 1), name: s, kids: new Map() }; node!.kids.set(lc(s), k); }
      node = k;
    });
  }
  const sorted = (m: Map<string, FNode>) => [...m.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const libNodes = sorted(libsSeen);
  const multiLib = libNodes.length > 1;

  // counts come from the tags (what the build will match), not the folders
  const combos = (res?.combos ?? []).map((c) => ({ set: new Set(c.tags.map(lc)), count: c.count }));
  const withAll = (tags: string[]) => combos.reduce((n, c) => (tags.every((t) => c.set.has(lc(t))) ? n + c.count : n), 0);
  const matchesSet = (have: Set<string>, r: SetRule) => r.tags.length > 0 && r.tags.every((t) => have.has(lc(t))) && !(r.except ?? []).some((e) => e.length > 0 && e.every((t) => have.has(lc(t))));
  const matchesOld = (have: Set<string>, r: RuleV) => !isSetV(r) && !isFolderV(r) && (Array.isArray(r) ? r : [r]).filter(Boolean).every((t) => have.has(lc(t)));

  const sets = value.filter(isSetV);
  // the ticked rule covering a path: its own, or the nearest one above it
  const ownRule = (p: string[]) => sets.find((r) => samePath(r.tags, p));
  const aboveRule = (p: string[]) => sets.filter((r) => r.tags.length < p.length && isPrefix(r.tags, p)).sort((a, b) => b.tags.length - a.tags.length)[0];
  // is p left out by a NOT of the rule above it? (returns that NOT's path relative to the rule)
  const notOf = (r: SetRule, p: string[]) => (r.except ?? []).find((e) => isPrefix([...r.tags, ...e], p));
  const stateOf = (p: string[]): "own" | "in" | "not" | "off" => {
    if (ownRule(p)) return "own";
    const up = aboveRule(p);
    if (!up) return "off";
    return notOf(up, p) ? "not" : "in";
  };
  const replace = (from: SetRule, to: SetRule | null) => onChange(to ? value.map((r) => (r === from ? to : r)) : value.filter((r) => r !== from));
  const click = (p: string[]) => {
    const own = ownRule(p);
    if (own) { replace(own, null); return; }
    const up = aboveRule(p);
    const rel = up ? p.slice(up.tags.length) : [];
    if (up && !notOf(up, p)) { replace(up, { ...up, except: [...(up.except ?? []).filter((e) => !isPrefix(rel, e)), rel] }); return; } // untick: add a NOT
    if (up) { const e = notOf(up, p)!; if (samePath(e, rel)) { const ex = (up.except ?? []).filter((x) => x !== e); replace(up, ex.length ? { ...up, except: ex } : { tags: up.tags }); return; } }
    // tick: a rule of its own (rules underneath it are covered now)
    onChange([...value.filter((r) => !(isSetV(r) && r.tags.length > p.length && isPrefix(p, r.tags))), { tags: p }]);
  };
  const flip = (id: string) => setOpenIds((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const matched = combos.reduce((n, c) => (value.some((r) => (isSetV(r) ? matchesSet(c.set, r) : matchesOld(c.set, r))) ? n + c.count : n), 0)
    + (res?.folders ?? []).reduce((n, fc) => (value.some((r) => isFolderV(r) && (!r.library || lc(r.library) === lc(fc.library)) && (lc(fc.dir) === lc(r.folder) || lc(fc.dir).startsWith(lc(r.folder) + "/"))) ? n + fc.count : n), 0);
  const ruleLabel = (r: RuleV) => isSetV(r)
    ? [r.tags.join(" AND "), ...(r.except ?? []).map((e) => `NOT ${e.join(" AND ")}`)].join(" AND ")
    : isFolderV(r) ? `folder ${r.folder.split("/").join(" › ")}` : (Array.isArray(r) ? r : [r]).join(" AND ");
  const ruleEmpty = (r: RuleV) => !!res && !res.error && (isSetV(r) ? !combos.some((c) => matchesSet(c.set, r)) : isFolderV(r) ? false : !combos.some((c) => matchesOld(c.set, r)));

  const Node = ({ n, depth, label }: { n: FNode; depth: number; label?: string }) => {
    const id = `${lc(n.library)}\u0001${n.path.map(lc).join("\u0001")}`;
    const isLib = n.path.length === 0;
    const open = openIds.has(id);
    const kids = sorted(n.kids);
    const st = isLib ? "off" : stateOf(n.path);
    const count = isLib ? 0 : withAll(n.path);
    const partly = (st === "own" || st === "in") && (() => { const r = st === "own" ? ownRule(n.path)! : aboveRule(n.path)!; return (r.except ?? []).some((e) => isPrefix(n.path, [...r.tags, ...e]) && !samePath([...r.tags, ...e], n.path)); })();
    return (
      <div>
        <div className="tag-node" style={{ paddingLeft: depth * 18 }}>
          <button type="button" className="tag-twisty" onClick={() => flip(id)} disabled={!kids.length} aria-label={open ? "Close" : "Open"}>{kids.length ? (open ? "▾" : "▸") : ""}</button>
          {isLib
            ? <span><b>{n.name}</b> <span className="muted" style={{ fontSize: 11 }}>library</span></span>
            : <label className="switch" title={st === "in" ? "Included by the tag above it — untick to leave it out (adds a NOT)" : st === "not" ? "Left out (NOT) — tick to include it again" : undefined}>
                <input type="checkbox" checked={st === "own" || st === "in"} onChange={() => click(n.path)} />
                <span style={st === "not" ? { textDecoration: "line-through", opacity: 0.6 } : undefined}>{label ?? n.name}</span>
                <span className="muted" style={{ fontSize: 11 }}>{count ? `(${count.toLocaleString()})` : "(no items tagged)"}{partly ? " · some left out" : ""}</span>
              </label>}
        </div>
        {open && kids.map((k) => <Node key={k.path.join("/")} n={k} depth={depth + 1} />)}
      </div>
    );
  };
  const q = filter.trim().toLowerCase();
  const all: FNode[] = [];
  const walk = (n: FNode) => { for (const k of n.kids.values()) { all.push(k); walk(k); } };
  libNodes.forEach(walk);
  const matches = q ? all.filter((n) => lc(n.name).includes(q)).sort((a, b) => a.path.join("/").localeCompare(b.path.join("/"))) : [];

  return (
    <div className="lib-field">
      <div>{f.label}</div>
      {f.help && <p className="muted" style={{ fontSize: 11, margin: "2px 0 4px" }}>{f.help}</p>}
      {value.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, margin: "2px 0 6px" }}>
          {value.map((r, i) => (
            <button key={i} type="button" className={ruleEmpty(r) ? "danger" : ""} style={{ fontSize: 12, padding: "2px 8px" }}
              title={ruleEmpty(r) ? "Nothing in this filler matches — click to remove" : "Click to remove"} onClick={() => onChange(value.filter((x) => x !== r))}>{ruleLabel(r)} ✕</button>
          ))}
        </div>
      )}
      {!src ? <span className="muted" style={{ fontSize: 12 }}>Pick filler libraries or a filler collection above to see their tags.</span>
        : !res ? <span className="muted" style={{ fontSize: 12 }}>Looking up tags…</span>
        : res.error ? <span className="err" style={{ fontSize: 12 }}>{res.error}</span>
        : !res.folders ? <span className="muted" style={{ fontSize: 12 }}>Restart the scheduler to see the tag tree.</span>
        : all.length === 0 ? <span className="muted" style={{ fontSize: 12 }}>The {res.items.toLocaleString()} filler items aren't in subfolders, so there are no tags to narrow by.</span>
        : <>
          {all.length > 12 && <input placeholder="Find a tag…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 240, fontSize: 12, marginBottom: 4 }} />}
          <div className="tag-tree">
            {q ? (matches.length ? matches.map((n) => <Node key={`${n.library}/${n.path.join("/")}`} n={n} depth={0} label={`${multiLib ? `${n.library} › ` : ""}${n.path.join(" › ")}`} />)
                  : <span className="muted" style={{ fontSize: 12 }}>No tag matches “{filter}”.</span>)
              : multiLib ? libNodes.map((l) => <Node key={l.library} n={l} depth={0} />)
              : sorted(libNodes[0].kids).map((k) => <Node key={k.path.join("/")} n={k} depth={0} />)}
          </div>
          <span className="muted" style={{ fontSize: 11 }}>
            {value.length ? `Breaks draw from ${matched.toLocaleString()} of ${res.items.toLocaleString()} filler items.` : `${res.items.toLocaleString()} filler items.`}
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
