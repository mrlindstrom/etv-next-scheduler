// A guided search-query box: autocomplete for fields, values (from the library)
// and AND/OR/NOT with Tab; a hint for the field being typed; a live plain-English
// reading of the query with its match count; "did you mean" fixes for unknown
// fields; clickable examples; and a field reference. Plain words search titles.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type SearchField } from "./api.js";

type Suggestion = { kind: "field" | "value" | "op" | "range"; label: string; insert: string; detail?: string };
type Ctx =
  | { mode: "field"; start: number; partial: string }                    // typing a field name / bare word
  | { mode: "value"; start: number; partial: string; field: string };    // typing a value for field

const OPS = ["AND", "OR", "NOT"];
const EXAMPLES = [
  "christmas story",
  "type:episode AND show_network:Nickelodeon",
  "type:movie AND genre:comedy AND minutes:[80 TO 120]",
  'type:other_video AND tag:"Back To" AND seconds:[1 TO 45]',
  "type:episode AND show_title:\"The Simpsons\" AND season_number:[1 TO 8]",
];
const RANGE_HINTS: Record<string, string[]> = {
  int: ["[1 TO 30]", "[30 TO *]"],
  date: ["[1980* TO 1990*]", "2024*"],
  reldate: ['"1 week"', '"6 months"', '"1 year"'],
};

let fieldsCache: Promise<SearchField[]> | null = null;
const loadFields = () => (fieldsCache ??= api.searchFields().catch(() => { fieldsCache = null; return []; }));

/** Where the caret is: in a field's value, or typing a field/bare word. */
function contextAt(text: string, caret: number): Ctx {
  const before = text.slice(0, caret);
  // inside field:( … ) — the nearest unclosed "field:(" applies to every value in the group
  let depth = 0, groupField: string | null = null;
  for (let i = before.length - 1; i >= 0; i--) {
    const c = before[i];
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth === 0) { const m = /([A-Za-z_]+):\s*$/.exec(before.slice(0, i)); groupField = m ? m[1].toLowerCase() : null; break; }
      depth--;
    }
  }
  // the token being typed (an open quote extends it across spaces)
  const quotes = (before.match(/"/g) ?? []).length;
  let start = caret;
  if (quotes % 2 === 1) start = before.lastIndexOf('"');
  else while (start > 0 && !/[\s()]/.test(before[start - 1])) start--;
  const token = before.slice(start);
  const fv = /^([A-Za-z_]+):(.*)$/.exec(token);
  if (fv) return { mode: "value", field: fv[1].toLowerCase(), start: start + fv[1].length + 1, partial: fv[2] };
  if (quotes % 2 === 1) {
    // an open quote right after "field:" (start points at the quote)
    const m = /([A-Za-z_]+):$/.exec(before.slice(0, start));
    if (m) return { mode: "value", field: m[1].toLowerCase(), start, partial: token };
  }
  if (groupField) return { mode: "value", field: groupField, start, partial: token };
  return { mode: "field", start, partial: token };
}

const quoteIfNeeded = (v: string) => (/[\s():"\[\]]/.test(v) || /^(and|or|not)$/i.test(v) ? `"${v.replace(/"/g, "")}"` : v);

export function QueryBox({ value, onChange, onSubmit, placeholder, rows = 2, preview = true, submitHint = "Enter to search" }: {
  value: string; onChange: (v: string) => void; onSubmit?: () => void;
  placeholder?: string; rows?: number;
  preview?: boolean;        // live "this finds …" line with a match count
  submitHint?: string;
}) {
  const [fields, setFields] = useState<SearchField[]>([]);
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [info, setInfo] = useState<{ explain?: string; total?: number; didYouMean?: Record<string, string>; error?: string } | null>(null);
  const [showRef, setShowRef] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { loadFields().then(setFields); }, []);

  const byName = useMemo(() => new Map(fields.map((f) => [f.name, f])), [fields]);
  const ctx = useMemo(() => contextAt(value, caret), [value, caret]);
  const ctxField = ctx.mode === "value" ? byName.get(ctx.field) : byName.get(ctx.partial.toLowerCase().replace(/:$/, ""));

  // build suggestions for the caret's context (values come from the library, debounced).
  // Stale suggestions are dropped right away so Tab can never accept one meant for a
  // different spot (e.g. a field suggestion while that field's values are loading).
  const ctxKey = `${ctx.mode}|${ctx.start}|${(ctx as any).field ?? ""}`;
  const [sugKey, setSugKey] = useState("");
  const [loadingValues, setLoadingValues] = useState(false);
  useEffect(() => {
    setLoadingValues(false);
    if (!focused || dismissed) { setSugs([]); return; }
    if (sugKey !== ctxKey) setSugs([]);
    let cancelled = false;
    const setFor = (s: Suggestion[]) => { if (!cancelled) { setSugs(s); setSugKey(ctxKey); setActive(0); setLoadingValues(false); } };
    const run = async () => {
      if (ctx.mode === "field") {
        const p = ctx.partial.toLowerCase();
        const out: Suggestion[] = [];
        if (p) for (const op of OPS) if (op.toLowerCase().startsWith(p) && op.toLowerCase() !== p) out.push({ kind: "op", label: op, insert: `${op} `, detail: op === "NOT" ? "exclude what follows" : op === "OR" ? "either side matches" : "both sides must match" });
        const matches = fields.filter((f) => !p || f.name.includes(p))
          .sort((a, b) => Number(b.name.startsWith(p)) - Number(a.name.startsWith(p)) || a.name.length - b.name.length);
        for (const f of matches.slice(0, p ? 8 : 0)) out.push({ kind: "field", label: `${f.name}:`, insert: `${f.name}:`, detail: f.desc });
        if (!p && value.trim()) for (const op of OPS) out.push({ kind: "op", label: op, insert: `${op} `, detail: op === "NOT" ? "exclude what follows" : op === "OR" ? "either side matches" : "both sides must match" });
        setFor(out);
        return;
      }
      const f = byName.get(ctx.field);
      if (!f) { setFor([]); return; }
      const partial = ctx.partial.replace(/^["(]+/, "").replace(/"$/, "");
      if (f.kind === "int" || f.kind === "date" || f.kind === "reldate") {
        const hints = RANGE_HINTS[f.kind] ?? [];
        setFor(partial ? [] : hints.map((h) => ({ kind: "range", label: h, insert: `${h} `, detail: f.example })));
        return;
      }
      if (!f.values) { setFor([]); return; }
      if (!cancelled) setLoadingValues(true);
      const vals = await api.searchValues(f.name, partial).catch(() => []);
      setFor(vals.filter((v) => v.value.toLowerCase() !== partial.toLowerCase()).map((v) => ({ kind: "value", label: v.value, insert: `${quoteIfNeeded(v.value)} `, detail: v.count ? `${v.count.toLocaleString()} item${v.count === 1 ? "" : "s"}` : undefined })));
    };
    const t = setTimeout(run, ctx.mode === "value" ? 150 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [ctxKey, ctx.partial, focused, dismissed, fields]);
  // only suggestions built for where the caret is now can be shown or accepted
  const liveSugs = sugKey === ctxKey ? sugs : [];

  // live reading of the whole query + match count
  useEffect(() => {
    if (!preview) return;
    if (!value.trim()) { setInfo(null); return; }
    const t = setTimeout(() => {
      api.browseSearch(value, 0, 1).then((r) => setInfo({ explain: r.explain, total: r.total, didYouMean: r.didYouMean, error: r.error })).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [value, preview]);

  const accept = (s: Suggestion) => {
    const end = caret;
    // replace the partial being typed (for a value: everything after "field:" up to the caret)
    let from = ctx.start;
    if (ctx.mode === "value" && ctx.partial.startsWith("(")) from = ctx.start + 1;
    const next = value.slice(0, from) + s.insert + value.slice(end);
    const pos = from + s.insert.length;
    onChange(next); setDismissed(false);
    requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(pos, pos); setCaret(pos); } });
  };
  const insertAtEnd = (text: string) => {
    const next = value.trim() ? `${value.trim()} ${text}` : text;
    onChange(next);
    requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(next.length, next.length); setCaret(next.length); } });
  };
  const fixField = (wrong: string, right: string) => onChange(value.replace(new RegExp(`\\b${wrong}:`, "gi"), `${right}:`));

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const open = liveSugs.length > 0;
    if (open && e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % liveSugs.length); return; }
    if (open && e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + liveSugs.length) % liveSugs.length); return; }
    if (open && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey))) { e.preventDefault(); accept(liveSugs[Math.min(active, liveSugs.length - 1)]); return; }
    if (e.key === "Tab" && loadingValues) { e.preventDefault(); return; } // values still loading: don't leave the box
    if (e.key === "Escape") { setDismissed(true); return; }
    if (e.key === " " && e.ctrlKey) { e.preventDefault(); setDismissed(false); return; }
    if (e.key === "Enter" && !e.shiftKey && onSubmit) { e.preventDefault(); setDismissed(true); onSubmit(); }
  };
  const track = (e: React.SyntheticEvent<HTMLTextAreaElement>) => setCaret(e.currentTarget.selectionStart ?? 0);

  const hint = ctx.mode === "value" && ctxField
    ? <><b>{ctxField.name}</b> — {ctxField.desc}. e.g. <code>{ctxField.example}</code></>
    : ctxField
      ? <><b>{ctxField.name}</b> — {ctxField.desc}. e.g. <code>{ctxField.example}</code></>
      : <>Type words to search titles, or a field like <code>type:</code> <code>show_network:</code> <code>genre:</code> — <b>Tab</b> completes, <b>↑↓</b> choose, {submitHint}.</>;

  return (
    <div className="qbox">
      <div className="qbox-input">
        <textarea ref={ta} className="search-box" rows={rows} value={value} placeholder={placeholder ?? 'christmas story   ·   type:episode AND show_network:Nickelodeon'} spellCheck={false}
          onChange={(e) => { onChange(e.target.value); setCaret(e.target.selectionStart ?? 0); setDismissed(false); }}
          onKeyDown={onKeyDown} onKeyUp={track} onClick={track} onSelect={track}
          onFocus={(e) => { setFocused(true); track(e); }} onBlur={() => setTimeout(() => setFocused(false), 150)} />
        {(liveSugs.length > 0 || (loadingValues && focused)) && (
          <ul className="qbox-sugs" role="listbox">
            {liveSugs.length === 0 && <li className="muted">Loading values from your library…</li>}
            {liveSugs.map((s, i) => (
              <li key={`${s.kind}-${s.label}`} role="option" aria-selected={i === active} className={i === active ? "active" : ""}
                onMouseDown={(e) => { e.preventDefault(); accept(s); }} onMouseEnter={() => setActive(i)}>
                <span className={`qbox-kind ${s.kind}`}>{s.kind === "op" ? "op" : s.kind === "field" ? "field" : s.kind === "range" ? "range" : "value"}</span>
                <span className="qbox-label">{s.label}</span>
                {s.detail && <span className="qbox-detail">{s.detail}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="qbox-hint">{hint} <button className="qbox-link" onClick={() => setShowRef((v) => !v)}>{showRef ? "hide fields" : "all fields"}</button></div>
      {preview && info && value.trim() && (
        <div className="qbox-explain">
          {info.error ? <span className="err">{info.error}</span> : <>
            <span className="muted">Finds:</span> {info.explain} <span className={info.total ? "ok" : "err"}>— {info.total?.toLocaleString() ?? 0} match{info.total === 1 ? "" : "es"}</span>
          </>}
          {info.didYouMean && Object.entries(info.didYouMean).map(([w, r]) => (
            <div key={w} className="err">Unknown field <code>{w}:</code> — did you mean <button className="qbox-link" onClick={() => fixField(w, r)}>{r}:</button>?</div>
          ))}
        </div>
      )}
      {!value.trim() && (
        <div className="qbox-examples">
          <span className="muted">Try:</span>
          {EXAMPLES.map((x) => <button key={x} className="qbox-chip" onClick={() => onChange(x)}>{x}</button>)}
        </div>
      )}
      {showRef && (
        <div className="qbox-ref">
          {[...new Set(fields.map((f) => f.group))].map((g) => (
            <div key={g}>
              <div className="qbox-ref-group">{g}</div>
              {fields.filter((f) => f.group === g).map((f) => (
                <div key={f.name} className="qbox-ref-row">
                  <button className="qbox-link" title="Insert this field" onClick={() => insertAtEnd(`${f.name}:`)}>{f.name}:</button>
                  <span className="muted">{f.desc}</span> <code>{f.example}</code>
                </div>
              ))}
            </div>
          ))}
          <div className="qbox-ref-group">Combining</div>
          <div className="qbox-ref-row muted"><code>AND</code> both · <code>OR</code> either · <code>NOT</code> exclude · <code>( … )</code> group · <code>"two words"</code> phrase · <code>word*</code> starts with · <code>field:[lo TO hi]</code> range (<code>*</code> = open)</div>
        </div>
      )}
    </div>
  );
}
