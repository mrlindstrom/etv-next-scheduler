// Weekly grid editor (Channels "grid" mode): a palette of shows, a Mon–Sun ×
// half-hour grid you paint or drag them onto, seasonal lineups with date ranges,
// one-off events that pre-empt the grid, and the channel's break/filler setup.
import { OverlayPicker } from "../OverlayPicker.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import { SchemaForm, CollectionField } from "../SchemaForm.js";
import { QueryBox } from "../QueryBox.js";

type Source = "show" | "search" | "collection";
interface Program { id: string; title: string; source: Source; value: string; order?: string; breaks?: "default" | "off"; color?: string; overlays?: string[] }
interface Cell { day: number; start: number; span: number; program: string }
interface Season { id: string; name: string; from?: string; to?: string; cells: Cell[]; fallback?: string }
interface GridEvent { id: string; name: string; dateFrom?: string; dateTo?: string; holiday?: string; days?: number; from?: string; to?: string; program: string }
interface Config {
  programs: Program[]; seasons: Season[]; events: GridEvent[];
  breaks?: { enabled?: boolean; mode?: string; breaks?: number; interval?: number; target?: number };
  fillerLibraries?: string[]; fillerCollection?: string; fallback?: string;
  matchEra?: boolean; stationIdSource?: string; stationId?: string;
}

const SLOT = 30;
const ROW_PX = 30;
const DAYS = [1, 2, 3, 4, 5, 6, 0]; // Monday first
const DAY_NAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const COLORS = ["#3b82f6", "#a855f7", "#ec4899", "#f97316", "#14b8a6", "#eab308", "#22c55e", "#ef4444", "#6366f1", "#06b6d4", "#84cc16", "#f43f5e"];
const SPANS = [30, 60, 90, 120, 150, 180, 240];
// holidays an event can recur on every year (the engine resolves moving ones like Thanksgiving)
const HOLIDAYS: [string, string][] = [
  ["new_years_day", "New Year's Day"], ["mlk_day", "MLK Day"], ["valentines", "Valentine's Day"], ["presidents_day", "Presidents' Day"],
  ["st_patricks", "St. Patrick's Day"], ["april_fools", "April Fools' Day"], ["easter", "Easter"], ["mothers_day", "Mother's Day"],
  ["memorial_day", "Memorial Day"], ["fathers_day", "Father's Day"], ["independence_day", "Fourth of July"], ["labor_day", "Labor Day"],
  ["halloween", "Halloween"], ["veterans_day", "Veterans Day"], ["thanksgiving", "Thanksgiving"], ["black_friday", "Black Friday"],
  ["hanukkah", "Hanukkah (first night)"], ["christmas_eve", "Christmas Eve"], ["christmas", "Christmas Day"], ["new_years_eve", "New Year's Eve"],
];
const ORDERS = [["chronological", "Next episode (in order)"], ["shuffle", "Shuffle"], ["random", "Random"], ["season_episode", "Season / episode"], ["shuffle_in_order", "Shuffle, keep order"]] as const;

const clock = (min: number) => { const h = Math.floor(min / 60) % 24, m = min % 60; return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h < 12 ? "a" : "p"}`; };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "show";
const uid = () => Math.random().toString(36).slice(2, 8);

function normalize(v: any): Config {
  return {
    programs: v?.programs ?? [], events: v?.events ?? [],
    seasons: v?.seasons?.length ? v.seasons : [{ id: "default", name: "Regular schedule", cells: [] }],
    breaks: v?.breaks ?? { enabled: true, mode: "count", breaks: 2, target: 2 },
    fillerLibraries: v?.fillerLibraries, fillerCollection: v?.fillerCollection, fallback: v?.fallback,
    matchEra: v?.matchEra, stationIdSource: v?.stationIdSource, stationId: v?.stationId,
  };
}

export function GridScheduler({ value, onChange }: { value: any; onChange: (v: any) => void }) {
  const cfg = normalize(value);
  const set = (patch: Partial<Config>) => onChange({ ...cfg, ...patch });
  const [view, setView] = useState<"grid" | "events" | "breaks">("grid");
  // open on the lineup that applies today (a dated one in range, else the regular one)
  const [seasonId, setSeasonId] = useState(() => {
    const d = new Date(), md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const inRange = (s: Season) => !!s.from && !!s.to && (s.from <= s.to ? md >= s.from && md <= s.to : md >= s.from || md <= s.to);
    return (cfg.seasons.find(inRange) ?? cfg.seasons.find((s) => !s.from || !s.to) ?? cfg.seasons[0]).id;
  });
  const season = cfg.seasons.find((s) => s.id === seasonId) ?? cfg.seasons[0];
  const isDefault = season === cfg.seasons.find((s) => !s.from || !s.to);
  const setSeason = (patch: Partial<Season>) => set({ seasons: cfg.seasons.map((s) => (s.id === season.id ? { ...s, ...patch } : s)) });
  const colorOf = (pid: string) => { const i = cfg.programs.findIndex((p) => p.id === pid); return cfg.programs[i]?.color ?? COLORS[Math.max(0, i) % COLORS.length]; };
  const prog = (pid: string) => cfg.programs.find((p) => p.id === pid);

  // --- palette ---
  const [armed, setArmed] = useState<string | null>(null); // program to paint with
  const [find, setFind] = useState("");
  const [editing, setEditing] = useState<Program | null>(null);
  const saveProgram = (p: Program) => {
    const exists = cfg.programs.some((x) => x.id === p.id);
    set({ programs: exists ? cfg.programs.map((x) => (x.id === p.id ? p : x)) : [...cfg.programs, p] });
    setEditing(null);
  };
  const removeProgram = (pid: string) => {
    const used = cfg.seasons.some((s) => s.cells.some((c) => c.program === pid)) || cfg.events.some((e) => e.program === pid);
    if (used && !confirm(`"${prog(pid)?.title}" is on the grid. Remove it and its slots?`)) return;
    set({
      programs: cfg.programs.filter((p) => p.id !== pid),
      seasons: cfg.seasons.map((s) => ({ ...s, cells: s.cells.filter((c) => c.program !== pid), fallback: s.fallback === pid ? undefined : s.fallback })),
      events: cfg.events.filter((e) => e.program !== pid),
      fallback: cfg.fallback === pid ? undefined : cfg.fallback,
    });
    if (armed === pid) setArmed(null);
    setEditing(null);
  };

  // --- grid cells ---
  const [sel, setSel] = useState<{ day: number; start: number } | null>(null);
  const cellAt = (day: number, min: number) => season.cells.find((c) => c.day === day && min >= c.start && min < c.start + c.span);
  // longest span that fits at (day,start) without running into the next show
  const room = (day: number, start: number, ignore?: Cell) => {
    const next = season.cells.filter((c) => c !== ignore && c.day === day && c.start > start).sort((a, b) => a.start - b.start)[0];
    return (next ? next.start : 1440) - start;
  };
  const place = (day: number, start: number, pid: string) => {
    if (cellAt(day, start)) return;
    const span = Math.min(SLOT, room(day, start));
    setSeason({ cells: [...season.cells, { day, start, span, program: pid }] });
    setSel({ day, start });
  };
  const selected = sel ? season.cells.find((c) => c.day === sel.day && c.start === sel.start) : undefined;
  const updateCell = (c: Cell, patch: Partial<Cell>) => setSeason({ cells: season.cells.map((x) => (x === c ? { ...x, ...patch } : x)) });
  const removeCell = (c: Cell) => { setSeason({ cells: season.cells.filter((x) => x !== c) }); setSel(null); };
  const copyTo = (c: Cell, days: number[]) => {
    let cells = season.cells.filter((x) => !(days.includes(x.day) && x !== c && x.start < c.start + c.span && x.start + x.span > c.start)); // replace overlaps
    for (const d of days) if (d !== c.day) cells.push({ ...c, day: d });
    setSeason({ cells });
  };

  // drag a palette show (or an existing slot) onto the grid
  const drag = useRef<{ pid: string; from?: Cell } | null>(null);
  const drop = (day: number, start: number) => {
    const d = drag.current; drag.current = null;
    if (!d) return;
    if (d.from) {
      const others = season.cells.filter((x) => x !== d.from);
      const clash = others.some((x) => x.day === day && start < x.start + x.span && start + d.from!.span > x.start);
      if (clash || start + d.from.span > 1440) return;
      setSeason({ cells: [...others, { ...d.from, day, start }] });
      setSel({ day, start });
    } else place(day, start, d.pid);
  };

  // open the grid at the lineup's first show (or 6 AM when it's empty)
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!scroller.current) return;
    const first = season.cells.length ? Math.min(...season.cells.map((c) => c.start)) : 6 * 60;
    scroller.current.scrollTop = Math.max(0, first / SLOT - 1) * ROW_PX;
  }, [view, season.id]);

  const rows = useMemo(() => Array.from({ length: 1440 / SLOT }, (_, i) => i * SLOT), []);

  return (
    <div className="grid-sched">
      <div className="subtabs" style={{ marginBottom: 12 }}>
        <button className={view === "grid" ? "active" : ""} onClick={() => setView("grid")}>Weekly grid</button>
        <button className={view === "events" ? "active" : ""} onClick={() => setView("events")}>Events{cfg.events.length ? ` (${cfg.events.length})` : ""}</button>
        <button className={view === "breaks" ? "active" : ""} onClick={() => setView("breaks")}>Breaks &amp; filler</button>
      </div>

      {view === "grid" && (
        <div className="gs-layout">
          <aside className="gs-palette">
            <div className="pane-head" style={{ marginBottom: 6 }}><b>Shows</b><button onClick={() => setEditing({ id: "", title: "", source: "show", value: "" })}>+ Add</button></div>
            {cfg.programs.length === 0 && <p className="muted" style={{ fontSize: 12 }}>Add the shows this channel airs, then paint them onto the grid.</p>}
            {cfg.programs.length > 10 && <input className="gs-find" type="search" placeholder={`Filter ${cfg.programs.length} shows…`} value={find} onChange={(e) => setFind(e.target.value)} />}
            <div className="gs-prog-list">
            {cfg.programs.filter((p) => !find || (p.title || p.value).toLowerCase().includes(find.toLowerCase())).map((p) => (
              <div key={p.id} className={`gs-prog ${armed === p.id ? "armed" : ""}`} draggable
                onDragStart={() => { drag.current = { pid: p.id }; }}
                onClick={() => setArmed(armed === p.id ? null : p.id)}
                title="Click to paint it onto empty slots, or drag it onto the grid">
                <i style={{ background: colorOf(p.id) }} />
                <span className="gs-prog-name">{p.title || p.value}</span>
                <button className="ghost" onClick={(e) => { e.stopPropagation(); setEditing(p); }} title="Edit">✎</button>
              </div>
            ))}
            </div>
            {armed && <p className="gs-hint">Painting <b>{prog(armed)?.title}</b>: click empty slots. Click the show again to stop.</p>}
            {!armed && cfg.programs.length > 0 && <p className="muted" style={{ fontSize: 11 }}>Click a show to paint with it, or drag it onto a slot.</p>}
          </aside>

          <div className="gs-main">
            <div className="gs-seasons">
              {cfg.seasons.map((s) => (
                <button key={s.id} className={s.id === season.id ? "active" : ""} onClick={() => { setSeasonId(s.id); setSel(null); }}>
                  {s.name}{s.from && s.to ? <span className="muted"> · {s.from} → {s.to}</span> : null}
                </button>
              ))}
              <button className="ghost" onClick={() => {
                const id = uid();
                set({ seasons: [{ id, name: "Summer", from: "06-01", to: "08-31", cells: season.cells.map((c) => ({ ...c })) }, ...cfg.seasons] });
                setSeasonId(id);
              }} title="Add a lineup for part of the year (starts as a copy of this one)">+ Season</button>
            </div>

            <div className="gs-season-bar">
              <label>Lineup name<input value={season.name} onChange={(e) => setSeason({ name: e.target.value })} /></label>
              {!isDefault && <>
                <label>From (MM-DD)<input value={season.from ?? ""} placeholder="09-01" onChange={(e) => setSeason({ from: e.target.value })} /></label>
                <label>To (MM-DD)<input value={season.to ?? ""} placeholder="05-31" onChange={(e) => setSeason({ to: e.target.value })} /></label>
              </>}
              <label>Empty slots play
                <select value={(isDefault ? cfg.fallback : season.fallback ?? cfg.fallback) ?? ""} onChange={(e) => isDefault ? set({ fallback: e.target.value || undefined }) : setSeason({ fallback: e.target.value || undefined })}>
                  <option value="">Nothing (off air)</option>
                  {cfg.programs.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                </select>
              </label>
              {!isDefault && <button className="danger" style={{ alignSelf: "flex-end" }} onClick={() => { if (confirm(`Delete the "${season.name}" lineup?`)) { set({ seasons: cfg.seasons.filter((s) => s.id !== season.id) }); setSeasonId(cfg.seasons[0].id); } }}>Delete lineup</button>}
            </div>
            <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
              {isDefault ? "The regular lineup: used whenever no dated lineup or event applies." : `Used every year from ${season.from || "?"} to ${season.to || "?"}, instead of the regular lineup.`}
            </p>

            {!selected && (
              <div className="gs-inspector idle">
                {armed ? <>Painting <b>{prog(armed)?.title}</b>: click empty slots to place it. Click the show in the list again to stop.</>
                  : <>Click a slot to change its show or length, or copy it to other days. Click a show in the list to paint it onto empty slots, or drag it.</>}
              </div>
            )}
            {selected && (
              <div className="gs-inspector">
                <i style={{ background: colorOf(selected.program) }} />
                <b>{DAY_NAME[selected.day]} {clock(selected.start)}</b>
                <select value={selected.program} onChange={(e) => updateCell(selected, { program: e.target.value })}>
                  {cfg.programs.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                </select>
                <select value={selected.span} onChange={(e) => updateCell(selected, { span: Number(e.target.value) })} title="How long this slot runs">
                  {SPANS.filter((s) => s <= room(selected.day, selected.start, selected)).map((s) => <option key={s} value={s}>{s < 60 ? `${s} min` : `${s / 60} hr${s > 60 ? "s" : ""}`}</option>)}
                </select>
                <button onClick={() => copyTo(selected, [1, 2, 3, 4, 5])} title="Same show, same time, Monday to Friday">Copy to Mon–Fri</button>
                <button onClick={() => copyTo(selected, [0, 1, 2, 3, 4, 5, 6])}>Copy to every day</button>
                <button className="danger" onClick={() => removeCell(selected)}>Remove</button>
                <button className="ghost" onClick={() => setSel(null)}>✕</button>
              </div>
            )}

            <div className="gs-grid-wrap" ref={scroller}>
              <div className="gs-grid" style={{ gridTemplateRows: `32px repeat(${rows.length}, ${ROW_PX}px)` }}>
                <div className="gs-corner" />
                {DAYS.map((d, i) => <div key={d} className="gs-dayhead" style={{ gridColumn: i + 2 }}>{DAY_NAME[d]}</div>)}
                {rows.map((m, r) => (
                  <div key={m} className={`gs-time ${m % 60 === 0 ? "hour" : ""}`} style={{ gridRow: r + 2 }}>{clock(m)}</div>
                ))}
                {DAYS.map((d, ci) => rows.map((m, r) => cellAt(d, m) ? null : (
                  <div key={`${d}-${m}`} className={`gs-empty ${m % 60 === 0 ? "hour" : ""} ${armed ? "paint" : ""}`} style={{ gridColumn: ci + 2, gridRow: r + 2 }}
                    onClick={() => (armed ? place(d, m, armed) : setSel(null))}
                    onDragOver={(e) => e.preventDefault()} onDrop={() => drop(d, m)} />
                )))}
                {DAYS.map((d, ci) => season.cells.filter((c) => c.day === d).map((c) => {
                  const p = prog(c.program);
                  return (
                    <div key={`${d}-${c.start}`} className={`gs-cell ${selected === c ? "sel" : ""}`} draggable
                      onDragStart={() => { drag.current = { pid: c.program, from: c }; }}
                      onClick={() => setSel({ day: c.day, start: c.start })}
                      style={{ gridColumn: ci + 2, gridRow: `${c.start / SLOT + 2} / span ${c.span / SLOT}`, background: colorOf(c.program) }}
                      title={`${p?.title ?? c.program}\n${DAY_NAME[d]} ${clock(c.start)}–${clock(c.start + c.span)}`}>
                      <span className="gs-cell-title">{p?.title ?? "?"}</span>
                      {c.span >= 60 && <span className="gs-cell-time">{clock(c.start)}–{clock(c.start + c.span)}</span>}
                    </div>
                  );
                }))}
              </div>
            </div>
          </div>
        </div>
      )}

      {view === "events" && (
        <div>
          <p className="muted" style={{ marginTop: 0 }}>Events pre-empt the grid on their dates: marathons, holiday specials, premieres. Each runs between its times on every day in its date range; leave "Ends" blank to run until midnight.</p>
          {cfg.events.length > 0 && (
            <table className="gs-events">
              <thead><tr><th>Event</th><th>When</th><th>Dates / days</th><th>Starts</th><th>Ends</th><th>Show</th><th /></tr></thead>
              <tbody>{cfg.events.map((e, i) => {
                const upd = (patch: Partial<GridEvent>) => set({ events: cfg.events.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                return (
                  <tr key={e.id}>
                    <td><input value={e.name} onChange={(ev) => upd({ name: ev.target.value })} /></td>
                    <td>
                      <select value={e.holiday ?? ""} onChange={(ev) => upd(ev.target.value ? { holiday: ev.target.value, days: e.days ?? 1, dateFrom: undefined, dateTo: undefined } : { holiday: undefined, days: undefined, dateFrom: new Date().toISOString().slice(0, 10) })}>
                        <option value="">On specific dates</option>
                        <optgroup label="Every year on">{HOLIDAYS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</optgroup>
                      </select>
                    </td>
                    <td>{e.holiday
                      ? <label className="gs-days"><input type="number" min={1} max={14} value={e.days ?? 1} onChange={(ev) => upd({ days: Math.max(1, Number(ev.target.value) || 1) })} /> day{(e.days ?? 1) === 1 ? "" : "s"}</label>
                      : <span className="gs-dates"><input type="date" value={e.dateFrom ?? ""} onChange={(ev) => upd({ dateFrom: ev.target.value })} /><input type="date" value={e.dateTo ?? ""} onChange={(ev) => upd({ dateTo: ev.target.value || undefined })} title="Last day (blank = one day)" /></span>}
                    </td>
                    <td><input type="time" value={e.from ?? "00:00"} onChange={(ev) => upd({ from: ev.target.value })} /></td>
                    <td><input type="time" value={e.to === "24:00" ? "" : e.to ?? ""} onChange={(ev) => upd({ to: ev.target.value || "24:00" })} placeholder="end of day" /></td>
                    <td><select value={e.program} onChange={(ev) => upd({ program: ev.target.value })}>{cfg.programs.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></td>
                    <td><button className="danger" onClick={() => set({ events: cfg.events.filter((_, j) => j !== i) })}>✕</button></td>
                  </tr>
                );
              })}</tbody>
            </table>
          )}
          {cfg.programs.length === 0
            ? <p className="muted">Add a show to the palette on the Weekly grid tab first.</p>
            : <button style={{ marginTop: 10 }} onClick={() => {
                const today = new Date().toISOString().slice(0, 10);
                set({ events: [...cfg.events, { id: uid(), name: "Marathon", dateFrom: today, from: "00:00", to: "24:00", program: cfg.programs[0].id }] });
              }}>+ Add event</button>}
        </div>
      )}

      {view === "breaks" && (
        <SchemaForm
          fields={[
            { type: "libraries", key: "fillerLibraries", label: "Filler libraries", help: "Commercials, bumpers and promos: used for ad breaks and to pad each show to the next :00 / :30." },
            { type: "collection", key: "fillerCollection", label: "Or a filler collection (overrides the libraries)" },
            { type: "checkbox", key: "enabled", label: "Insert mid-roll ad breaks", default: true },
            { type: "select", key: "mode", label: "Break spacing", options: [{ value: "count", label: "N breaks per half hour of show" }, { value: "interval", label: "Every N minutes" }, { value: "chapters", label: "At chapter marks" }], default: "count" },
            { type: "number", key: "breaks", label: "Breaks per half hour", default: 2, min: 1, showIf: { key: "mode", equals: "count" } },
            { type: "number", key: "interval", label: "Minutes between breaks", default: 8, min: 1, showIf: { key: "mode", equals: "interval" } },
            { type: "number", key: "target", label: "Break length (minutes)", default: 2, min: 1 },
            { type: "tags", key: "adTags", label: "Only break filler with these tags (optional)", libraries: "fillerLibraries", collection: "fillerCollection", showIf: { key: "enabled", equals: [true as any, ""] },
              help: "The filler's tags, laid out like its folders. Tick a tag to play what's tagged with it (PSA); untick one under it to leave that out (PSA AND NOT Christmas); tick several and breaks mix them. Nothing ticked = any filler. Padding to the half hour still uses all of it." },
            { type: "checkbox", key: "matchEra", label: "Match commercials to the show's era", help: "Breaks use commercials from within a few years of the show (by year in the file name or metadata), so 90s shows get 90s ads." },
            { type: "select", key: "stationIdSource", label: "Station ID before the top of the hour", options: [{ value: "collection", label: "From a collection" }, { value: "search", label: "From a search query" }], default: "collection" },
            { type: "collection", key: "stationId", label: "Station ID collection (blank = none)", help: "A short ident (under a minute) that ends exactly on the hour.", showIf: { key: "stationIdSource", equals: "collection" } },
            { type: "query", key: "stationId", label: "Station ID search (blank = none)", placeholder: 'library_name:"Station IDs"', showIf: { key: "stationIdSource", equals: "search" } },
          ]}
          value={{ ...cfg.breaks, fillerLibraries: cfg.fillerLibraries ?? [], fillerCollection: cfg.fillerCollection ?? "", matchEra: cfg.matchEra, stationIdSource: cfg.stationIdSource ?? "collection", stationId: cfg.stationId ?? "" }}
          onChange={(v) => {
            const { fillerLibraries, fillerCollection, matchEra, stationIdSource, stationId, ...breaks } = v;
            set({ breaks, fillerLibraries, fillerCollection: fillerCollection || undefined, matchEra: matchEra || undefined, stationIdSource, stationId: stationId || undefined });
          }}
        />
      )}

      {editing && <ProgramEditor program={editing} taken={cfg.programs.map((p) => p.id)} onSave={saveProgram} onCancel={() => setEditing(null)} onRemove={editing.id ? () => removeProgram(editing.id) : undefined} />}
    </div>
  );
}

function ProgramEditor({ program, taken, onSave, onCancel, onRemove }: { program: Program; taken: string[]; onSave: (p: Program) => void; onCancel: () => void; onRemove?: () => void }) {
  const [p, setP] = useState<Program>(program);
  const [sugs, setSugs] = useState<string[]>([]);
  useEffect(() => {
    if (p.source !== "show" || p.value.length < 2) { setSugs([]); return; }
    const t = setTimeout(() => api.showSuggest(p.value).then(setSugs).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [p.value, p.source]);
  const save = () => {
    let id = p.id;
    if (!id) { const base = slug(p.title || p.value); id = base; let n = 2; while (taken.includes(id)) id = `${base}-${n++}`; }
    onSave({ ...p, id, title: p.title || p.value });
  };
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="pane-head"><h2 style={{ margin: 0 }}>{program.id ? "Edit show" : "Add a show"}</h2><button onClick={onCancel}>✕</button></div>
        <div className="form" style={{ marginTop: 8 }}>
          <label>What it plays
            <select value={p.source} onChange={(e) => setP({ ...p, source: e.target.value as Source, value: "" })}>
              <option value="show">A TV show</option><option value="collection">A collection</option><option value="search">A search query</option>
            </select>
          </label>
          {p.source === "show" && (
            <label>Show title
              <input list="gs-show-sugs" value={p.value} onChange={(e) => setP({ ...p, value: e.target.value })} placeholder="The Simpsons" autoFocus />
              <datalist id="gs-show-sugs">{sugs.map((s) => <option key={s} value={s} />)}</datalist>
            </label>
          )}
          {p.source === "collection" && <CollectionField f={{ label: "Collection" }} value={p.value} onChange={(v) => setP({ ...p, value: v })} />}
          {p.source === "search" && <label>Search query<QueryBox value={p.value} onChange={(v: string) => setP({ ...p, value: v })} rows={2} submitHint="Shift+Enter for a new line" /></label>}
          <div className="row">
            <label>Name on the grid<input value={p.title} onChange={(e) => setP({ ...p, title: e.target.value })} placeholder={p.value.split("::").pop() || "e.g. Prime-time movie"} /></label>
            <label>Episode order
              <select value={p.order ?? (p.source === "show" ? "chronological" : "shuffle")} onChange={(e) => setP({ ...p, order: e.target.value })}>
                {ORDERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          </div>
          <label className="switch"><input type="checkbox" checked={p.breaks !== "off"} onChange={(e) => setP({ ...p, breaks: e.target.checked ? "default" : "off" })} /> Ad breaks during this show</label>
          <label>Overlays during this show<OverlayPicker value={p.overlays ?? []} onChange={(v) => setP({ ...p, overlays: v })} empty="Just the channel's own" /></label>
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>"Next episode" picks up where the show left off, so a show stripped across weekdays plays episodes in order day to day.</p>
          <div className="actions">
            <button className="primary" onClick={save} disabled={!p.value.trim()}>{program.id ? "Save" : "Add show"}</button>
            <button onClick={onCancel}>Cancel</button>
            {onRemove && <button className="danger" style={{ marginLeft: "auto" }} onClick={onRemove}>Remove show</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
