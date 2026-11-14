// Overlays page: a library of timed graphics drawn over programmes, and a
// drag-and-drop designer for them.
//   - the canvas is a 1920x1080 artboard: drag layers to move them, drag the
//     handles to resize, drop image / video files on it to add them; layers snap
//     to the edges, the centre, the safe area and each other (hold Alt to stop)
//   - text can use show fields ({{show}}, {{next_start_time}}…) — click a field
//     to insert it; the canvas shows sample values
//   - a "Picture by show" layer picks a picture from the pictures folder by a
//     show detail (match:{{next_show}}) — see OverlayPictures.tsx
//   - a reference picture or video frame can sit behind the canvas to line things
//     up against (only in this browser tab: never uploaded, saved or shown on air)
//   - "When it shows" sets the timing in plain words; "Show on channels" puts it
//     on channels right here
// Builds render each overlay per programme (see src/overlays.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, overlayAssetSrc, referenceFrameUrl, CHANNEL_LOGO, MATCH_PREFIX, type OverlayMedia, type SearchItem, type Overlay, type OverlayLayer, type OverlayField, type ChannelSummary, type LayerAnim, type OverlayFonts } from "../api.js";
import { PicturesCard, MatchImage, MatchProps } from "../OverlayPictures.js";
import { LegacyImport, LegacyDesigner } from "../LegacyElements.js";
import { navigate } from "../nav.js";
import { ANIM_TYPES, EASES, ANIM_STYLES, applyAnimStyle, layerState, layerStateAt, layerWindow, hasLayerTiming, fadeAt, animLengths, isAnimated, drawsLive, onlyFades, asFades, FULL, type AnimStep, type LayerState } from "../../../src/overlay-anim.js";

const HOLIDAYS: [string, string][] = [
  ["christmas", "Christmas"], ["christmas_eve", "Christmas Eve"], ["halloween", "Halloween"], ["thanksgiving", "Thanksgiving"],
  ["new_years", "New Year's Day"], ["new_years_eve", "New Year's Eve"], ["valentines", "Valentine's Day"], ["st_patricks", "St. Patrick's Day"],
  ["easter", "Easter"], ["july_fourth", "Fourth of July"], ["hanukkah", "Hanukkah"], ["mothers_day", "Mother's Day"], ["fathers_day", "Father's Day"],
  ["memorial_day", "Memorial Day"], ["labor_day", "Labor Day"], ["veterans_day", "Veterans Day"], ["april_fools", "April Fools' Day"], ["black_friday", "Black Friday"],
];
const HIDDEN: LayerState = { ...FULL, opacity: 0 };

const AW = 1920, AH = 1080;
const SAFE = 0.05; // title-safe margin
const FONTS = ["Arial", "Arial Black", "Impact", "Segoe UI", "Verdana", "Tahoma", "Trebuchet MS", "Georgia", "Times New Roman", "Courier New", "Comic Sans MS"];
type Layer = OverlayLayer;
type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

const uid = () => Math.random().toString(36).slice(2, 9);
// The designer's reference picture / video, kept while this tab is open so it
// stays put across overlays. A local file shown from the browser's memory.
// `lib`: a library file, shown a frame at a time by the server (any format).
type RefBg = { url: string; name: string; video: boolean; t: number; dim: number; lib?: { path: string; durationMs: number } };
let lastRef: RefBg | null = null;
const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const fill = (t: string, v: Record<string, string>) => t.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (m, k: string) => v[k.toLowerCase()] ?? m);
const LAYER_LABEL: Record<Layer["type"], string> = { text: "Text", image: "Image", box: "Box", video: "Video" };
const LAYER_ICON: Record<Layer["type"], string> = { text: "T", image: "▣", box: "■", video: "▶" };

// ---- presets ------------------------------------------------------------------
const PRESETS: { id: string; label: string; desc: string; make: () => Omit<Overlay, "id"> }[] = [
  { id: "blank", label: "Blank", desc: "Start from nothing", make: () => ({ name: "New overlay", layers: [], timing: { mode: "always" } }) },
  {
    id: "bug", label: "Corner bug", desc: "Channel name in the corner, always on",
    make: () => ({ name: "Corner bug", opacity: 80, timing: { mode: "always" }, layers: [
      { type: "text", x: 1500, y: 950, w: 330, h: 70, text: "{{channel}}", size: 44, bold: true, color: "#ffffff", align: "right", valign: "middle", outlineWidth: 3, outline: "#000000" },
    ] }),
  },
  {
    id: "lower", label: "Lower third", desc: "Show and episode, a minute into each show",
    make: () => ({ name: "Lower third", fadeSeconds: 1, timing: { mode: "start", offsetSeconds: 60, showSeconds: 10 }, layers: [
      { type: "box", x: 96, y: 846, w: 960, h: 150, color: "#1d4ed8", radius: 14, opacity: 92 },
      { type: "box", x: 96, y: 846, w: 14, h: 150, color: "#fbbf24" },
      { type: "text", x: 140, y: 862, w: 890, h: 64, text: "{{show}}", size: 52, bold: true, color: "#ffffff" },
      { type: "text", x: 140, y: 930, w: 890, h: 50, text: "{{episode_code}}  {{title}}", size: 32, color: "#dbeafe" },
    ] }),
  },
  {
    id: "upnext", label: "Up next strap", desc: "What's on next, 2 minutes before each show ends",
    make: () => ({ name: "Up next strap", fadeSeconds: 1, timing: { mode: "end", offsetSeconds: 120, showSeconds: 12 }, layers: [
      { type: "box", x: 1150, y: 860, w: 674, h: 130, color: "#111827", radius: 14, opacity: 88 },
      { type: "text", x: 1180, y: 872, w: 620, h: 40, text: "UP NEXT AT {{next_start_time}}", size: 28, bold: true, color: "#fbbf24" },
      { type: "text", x: 1180, y: 916, w: 620, h: 60, text: "{{next_show}}", size: 46, bold: true, color: "#ffffff" },
    ] }),
  },
  {
    id: "title", label: "Show title card", desc: "Big centred title as each show starts",
    make: () => ({ name: "Show title card", fadeSeconds: 1, timing: { mode: "start", offsetSeconds: 3, showSeconds: 6 }, layers: [
      { type: "text", x: 260, y: 400, w: 1400, h: 140, text: "{{show}}", size: 110, bold: true, color: "#ffffff", align: "center", valign: "middle", shadow: true },
      { type: "text", x: 260, y: 545, w: 1400, h: 70, text: "{{title}}", size: 48, color: "#e5e7eb", align: "center", shadow: true },
    ] }),
  },
];

function timingText(o: Overlay): string {
  const t = o.timing ?? { mode: "always" };
  if (t.mode === "every") return `${t.showSeconds ?? 10}s every ${t.everyMinutes ?? 15} min`;
  if (t.mode === "start") return `${t.showSeconds ?? 10}s, ${t.offsetSeconds ?? 0}s into each show`;
  if (t.mode === "end") return `${t.showSeconds ?? 10}s, ${t.offsetSeconds ?? 0}s before each show ends`;
  if (t.mode === "media") return t.media ? `Over “${t.media.title || t.media.path.split(/[\\/]/).pop()}”, whenever it airs` : "When a video plays (none picked yet)";
  return "Always on";
}

/** A single-image overlay anchored like a legacy watermark -> a box on the artboard. */
function anchorBox(o: Overlay, nw: number, nh: number) {
  const a = o.anchor!;
  const w = a.widthPercent ? (a.widthPercent / 100) * AW : nw;
  const h = nw ? (w * nh) / nw : w;
  const hm = (a.hMargin / 100) * AW, vm = (a.vMargin / 100) * AH;
  const x = a.location.endsWith("left") ? hm : a.location.endsWith("right") ? AW - w - hm : (AW - w) / 2;
  const y = a.location.startsWith("top") ? vm : a.location.startsWith("bottom") ? AH - h - vm : (AH - h) / 2;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

const mediaSize = (src: string, video: boolean): Promise<{ w: number; h: number }> => new Promise((res) => {
  if (video) {
    const v = document.createElement("video");
    v.onloadedmetadata = () => res({ w: v.videoWidth || 640, h: v.videoHeight || 360 });
    v.onerror = () => res({ w: 640, h: 360 });
    v.src = src;
  } else {
    const i = new Image();
    i.onload = () => res({ w: i.naturalWidth || 400, h: i.naturalHeight || 400 });
    i.onerror = () => res({ w: 400, h: 400 });
    i.src = src;
  }
});

// ---- page ---------------------------------------------------------------------
export function Overlays() {
  const [list, setList] = useState<Overlay[] | null>(null);
  const [fields, setFields] = useState<OverlayField[]>([]);
  const [slots, setSlots] = useState<string[]>(["Now", "Next", "After next", "Third"]);
  const [usedBy, setUsedBy] = useState<Record<string, string[]>>({});
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [editing, setEditing] = useState<Overlay | null>(null);
  const [error, setError] = useState("");
  const [picking, setPicking] = useState(false);
  const [importing, setImporting] = useState(false);
  // open an overlay by id (after an import), from a fresh list
  const openId = async (id: string) => { const r = await api.overlays(); setList(r.overlays); const o = r.overlays.find((x) => x.id === id); if (o) setEditing(clone(o)); };
  const [examples, setExamples] = useState<Overlay[]>([]);
  const [exErr, setExErr] = useState("");
  useEffect(() => {
    api.overlayExamples().then((x) => { if (Array.isArray(x)) { setExamples(x); setExErr(x.length ? "" : "No examples were found in the examples/overlays folder."); } else throw new Error(); })
      .catch(() => setExErr("The examples didn't load — the scheduler is probably still running the code from before the update. Close and start the scheduler again, then refresh this page."));
  }, []);
  // an empty library opens straight onto the examples
  const showGallery = picking || (list !== null && list.length === 0);
  const sample = Object.fromEntries(fields.map((f) => [f.key, f.sample]));
  const ORDER = ["Up next", "Lower thirds", "Schedules", "Bumpers", "Bugs", "Title cards", "Retro", "Holidays"];
  const groups = [...new Set(examples.map((e) => e.category || "More"))].sort((x, y) => (ORDER.indexOf(x) + 1 || 99) - (ORDER.indexOf(y) + 1 || 99));

  const load = useCallback(async () => {
    try {
      const r = await api.overlays();
      setList(r.overlays); setFields(r.fields); setUsedBy(r.usedBy); if (r.slots?.length) setSlots(r.slots);
      api.channels().then(setChannels).catch(() => {});
    } catch (e) { setError(String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (editing?.legacy) return <LegacyDesigner key={editing.id} initial={editing} channels={channels} usedBy={usedBy}
    onClose={() => { setEditing(null); load(); }} onSaved={(o) => { setEditing(o); load(); }} onChannels={load} />;
  if (editing) return <Designer key={editing.id || "new"} initial={editing} fields={fields} slots={slots} channels={channels} usedBy={usedBy}
    onClose={() => { setEditing(null); load(); }} onSaved={(o) => { setEditing(o); load(); }} onChannels={load} />;

  return (
    <div className="screen">
      <div className="page-head">
        <div>
          <h1>Overlays</h1>
          <p className="muted">Graphics drawn over your channels: watermarks and bugs, lower thirds, "up next" straps. Each one can show your show's details — its name, episode, times, and what's on next — and appear always, every few minutes, or at a set point in each show.</p>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button onClick={() => setImporting((v) => !v)} title="Bring in ErsatzTV legacy graphics elements (image / text / motion YAML files)">Import from legacy…</button>
          <button className="primary" onClick={() => setPicking(true)}>+ New overlay</button>
        </div>
      </div>
      {error && <p className="err">{error}</p>}
      {importing && <LegacyImport onClose={() => { setImporting(false); load(); }} onOpen={(id) => { setImporting(false); void openId(id); }} />}
      {showGallery && (
        <div className="meta-card ov-presets">
          <div className="pane-head"><b>{list?.length ? "Start from…" : "No overlays yet — start from one of these"}</b>{picking && !!list?.length && <button className="ghost" onClick={() => setPicking(false)}>Cancel</button>}</div>
          <p className="muted" style={{ margin: "2px 0 10px", fontSize: 13 }}>Every example is animated and fills in each show's details. Pick one and make it yours — colours, words, timing — or start blank.</p>
          <div className="ov-preset-grid">
            <button className="ov-preset" onClick={() => { setPicking(false); setEditing({ id: "", ...PRESETS[0].make() }); }}>
              <b>Blank</b><span className="muted">Start from nothing</span>
            </button>
          </div>
          {!examples.length && (exErr ? <p className="err">{exErr}</p> : <p className="muted">Loading examples…</p>)}
          {groups.map((g) => (
            <div key={g}>
              <div className="ov-group-head">{g}</div>
              <div className="ov-example-grid">
                {examples.filter((e) => (e.category || "More") === g).map((e) => (
                  <button key={e.id} className="ov-card" onClick={() => { setPicking(false); const { id: _id, category: _c, ...rest } = clone(e); setEditing({ id: "", ...rest }); }}>
                    <Thumb o={e} vars={{ ...sample, channel: "Retro TV", number: "21" }} />
                    <div className="ov-card-body"><b>{e.name}</b><span className="muted">{e.description}</span></div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {!list ? <p className="muted">Loading…</p> : list.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>Coming from ErsatzTV legacy? Its channel watermarks come over from <a href="#" onClick={(e) => { e.preventDefault(); navigate("channels"); }}>Channels → Import…</a>.</p>
      ) : (
        <div className="ov-cards">
          {list.map((o) => (
            <button key={o.id} className="ov-card" onClick={() => setEditing(clone(o))}>
              {o.legacy
                ? <div className="ov-thumb ov-legacy-thumb"><span>Legacy {o.legacy.kind} element</span><code>{o.legacy.file}</code></div>
                : <Thumb o={o} vars={Object.fromEntries(fields.map((f) => [f.key, f.sample]))} />}
              <div className="ov-card-body">
                <b>{o.name}</b>
                <span className="muted">{o.legacy ? "Filled in for each item, as in legacy" : timingText(o)}</span>
                <span className="muted">{usedBy[o.id]?.length ? `On ${usedBy[o.id].length} channel${usedBy[o.id].length === 1 ? "" : "s"}` : "Not on any channel yet"}</span>
              </div>
            </button>
          ))}
        </div>
      )}
      {list && <div style={{ marginTop: 18 }}><PicturesCard /></div>}
    </div>
  );
}

/** A small static preview of an overlay (sample values). */
function Thumb({ o, vars }: { o: Overlay; vars: Record<string, string> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.12);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  useEffect(() => { if (ref.current) setScale(ref.current.clientWidth / AW); }, []);
  useEffect(() => {
    const l = o.layers[0];
    if (o.anchor && o.layers.length === 1 && l?.type === "image") mediaSize(overlayAssetSrc(l.src), false).then((s) => setBox(anchorBox(o, s.w, s.h)));
  }, [o]);
  // layers on their own times: show the late part of the appearance, as it airs
  const showMs = Math.max(1, Number(o.timing?.showSeconds ?? 10) || 10) * 1000;
  const late = (o.timing?.mode ?? "always") !== "always" && hasLayerTiming(o.layers) ? Math.max(0, showMs - 1600) : null;
  const layers = box ? [{ ...o.layers[0], ...box }] : late == null ? o.layers : o.layers.filter((l) => { const w = layerWindow(l, showMs); return late >= w.start && late < w.end; });
  return (
    <div ref={ref} className="ov-thumb">
      {layers.map((l, i) => <LayerView key={i} l={l} scale={scale} vars={vars} />)}
    </div>
  );
}

// ---- designer -----------------------------------------------------------------
function Designer({ initial, fields, slots, channels, usedBy, onClose, onSaved, onChannels }: {
  initial: Overlay; fields: OverlayField[]; slots: string[]; channels: ChannelSummary[]; usedBy: Record<string, string[]>;
  onClose: () => void; onSaved: (o: Overlay) => void; onChannels: () => void;
}) {
  const [ov, setOv] = useState<Overlay>(initial);
  const [sel, setSel] = useState<number | null>(initial.layers.length ? initial.layers.length - 1 : null);
  const [dirty, setDirty] = useState(!initial.id);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [showSamples, setShowSamples] = useState(true);
  const [bg, setBg] = useState<"dark" | "light" | "check">("dark");
  const [exact, setExact] = useState<{ png: string; box: { x: number; y: number; w: number; h: number } } | null>(null);
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const [dropHint, setDropHint] = useState(false);
  // animation preview: in, hold, out, a pause — looping until stopped. With layers
  // on their own times it plays the whole appearance as it airs ("tl", ms into it).
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState<{ phase: "in" | "out" | "tl"; t: number } | "hidden" | null>(null);
  const timedMode = (ov.timing?.mode ?? "always") !== "always";
  const showMs = Math.max(1, Number(ov.timing?.showSeconds ?? 10) || 10) * 1000;
  const timed = timedMode && hasLayerTiming(ov.layers);
  // drawn live: the preview shows it as it airs — every animation a fade
  const live = drawsLive(ov) && (isAnimated(ov.layers) || timed);
  const motionLayers = useMemo(() => (live ? asFades(ov.layers, ov.fadeSeconds) : ov.layers), [live, ov.layers, ov.fadeSeconds]);
  const M = (l: Layer): Layer => (live ? motionLayers[ov.layers.indexOf(l)] ?? l : l);
  useEffect(() => {
    if (!playing) { setFrame(null); return; }
    const { inMs, outMs } = animLengths(motionLayers);
    if (timed) {
      const t0 = performance.now(), cycle = showMs + 900;
      let raf = 0;
      const tick = () => { const e = (performance.now() - t0) % cycle; setFrame(e < showMs ? { phase: "tl", t: e } : "hidden"); raf = requestAnimationFrame(tick); };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }
    const HOLD = 1500, GAP = 700, cycle = inMs + HOLD + outMs + GAP;
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      const e = (performance.now() - t0) % cycle;
      setFrame(e < inMs ? { phase: "in", t: e } : e < inMs + HOLD ? null : e < inMs + HOLD + outMs ? { phase: "out", t: e - inMs - HOLD } : "hidden");
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, motionLayers, timed, showMs]);
  const tlState = (l: Layer, tt: number): LayerState => {
    const s = layerStateAt(M(l), tt, showMs, animLengths(motionLayers).outMs);
    const env = isAnimated(motionLayers) ? 1 : fadeAt(tt, showMs, ov.fadeSeconds);
    return env < 1 ? { ...s, opacity: s.opacity * env } : s;
  };
  // "when a video plays", with that video as the reference: where the slider is in
  // the overlay's appearance (ms), so scrubbing shows which layers are up
  const linkedMs = (): number | null => {
    const tm = ov.timing;
    if (tm?.mode !== "media" || !tm.media || !ref?.lib || ref.lib.path !== tm.media.path) return null;
    const tt = (ref.t - (tm.offsetSeconds ?? 0)) * 1000;
    return tt >= 0 && tt < showMs ? tt : null;
  };
  const stateOf = (l: Layer): LayerState => {
    if (frame === "hidden") return HIDDEN;
    if (frame) return frame.phase === "tl" ? tlState(l, frame.t) : layerState(M(l), frame.phase, frame.t);
    const lm = linkedMs();
    return lm != null ? tlState(l, lm) : FULL;
  };
  const history = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.4);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const vars = useMemo(() => Object.fromEntries(fields.map((f) => [f.key, f.sample])), [fields]);
  const [fieldSlot, setFieldSlot] = useState(1); // the show details list: which programme (0 = now, 1 = next…)
  // reference behind the canvas (see lastRef)
  const [ref, setRefState] = useState<RefBg | null>(lastRef);
  const setRef = (r: RefBg | null) => { lastRef = r; setRefState(r); };
  const [refDur, setRefDur] = useState(0);
  const [refErr, setRefErr] = useState("");
  const refInput = useRef<HTMLInputElement>(null);
  const refVideo = useRef<HTMLVideoElement>(null);
  const pickRef = (f: File) => {
    if (lastRef) URL.revokeObjectURL(lastRef.url);
    setRefErr(""); setRefDur(0);
    setRef({ url: URL.createObjectURL(f), name: f.name, video: f.type.startsWith("video/") || /\.(mp4|mov|webm|mkv|m4v|avi|ts)$/i.test(f.name), t: 0, dim: 0 });
  };
  // the frame slider moves the (paused) video
  useEffect(() => { const v = refVideo.current; if (v && ref?.video && Math.abs(v.currentTime - ref.t) > 0.005) v.currentTime = ref.t; }, [ref?.t, ref?.url]);
  const refDurS = ref?.lib ? ref.lib.durationMs / 1000 : refDur;
  const seekRef = (t: number) => ref && setRef({ ...ref, t: Math.max(0, Math.min(refDurS || t, t)) });
  // a library reference asks the server for a frame once the slider settles
  const [libT, setLibT] = useState(lastRef?.t ?? 0);
  useEffect(() => { if (!ref?.lib) return; const h = setTimeout(() => setLibT(ref.t), 150); return () => clearTimeout(h); }, [ref?.t, ref?.lib?.path]);
  const loadMediaRef = (m: OverlayMedia, at = 0) => {
    if (lastRef?.url) URL.revokeObjectURL(lastRef.url);
    setRefErr(""); setRefDur(0); setLibT(at);
    setRef({ url: "", name: m.title || m.path.split(/[\\/]/).pop() || "video", video: false, t: at, dim: lastRef?.dim ?? 0, lib: { path: m.path, durationMs: m.durationMs ?? 0 } });
  };
  // opening a "when a video plays" overlay brings its video up as the reference
  useEffect(() => {
    const m = initial.timing?.mode === "media" ? initial.timing.media : undefined;
    if (m && lastRef?.lib?.path !== m.path) loadMediaRef(m, initial.timing.offsetSeconds ?? 0);
  }, []);
  const [pickMedia, setPickMedia] = useState(false);

  // stage scale follows its width
  useEffect(() => {
    const el = stageRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / AW));
    ro.observe(el); setScale(el.clientWidth / AW);
    return () => ro.disconnect();
  }, []);

  // an imported watermark (anchored by corner + margins): place it on the artboard
  useEffect(() => {
    const l = ov.layers[0];
    if (ov.anchor && ov.layers.length === 1 && l?.type === "image" && !l.w) {
      mediaSize(overlayAssetSrc(l.src), false).then((s) => setOv((o) => ({ ...o, layers: [{ ...o.layers[0], ...anchorBox(o, s.w, s.h) }] })));
    }
  }, []);

  /** Apply a change (undoable). */
  const change = (fn: (o: Overlay) => Overlay, opts: { keepAnchor?: boolean } = {}) => {
    setOv((cur) => {
      history.current.push(JSON.stringify(cur)); if (history.current.length > 100) history.current.shift();
      future.current = [];
      const next = fn(clone(cur));
      if (!opts.keepAnchor && next.anchor && JSON.stringify(next.layers.map((l) => [l.x, l.y, l.w, l.h])) !== JSON.stringify(cur.layers.map((l) => [l.x, l.y, l.w, l.h]))) delete next.anchor;
      if (next.anchor && next.layers.length !== 1) delete next.anchor;
      // an animated overlay is placed by its x / y (an imported watermark's anchor can't animate)
      if (next.anchor && isAnimated(next.layers) && next.layers[0]?.w) delete next.anchor;
      return next;
    });
    setDirty(true); setExact(null);
  };
  const undo = () => { const p = history.current.pop(); if (p) { future.current.push(JSON.stringify(ov)); setOv(JSON.parse(p)); setDirty(true); setExact(null); } };
  const redo = () => { const n = future.current.pop(); if (n) { history.current.push(JSON.stringify(ov)); setOv(JSON.parse(n)); setDirty(true); setExact(null); } };
  const setLayer = (i: number, patch: Partial<Layer>) => change((o) => { o.layers[i] = { ...o.layers[i], ...patch } as Layer; return o; }, { keepAnchor: !("x" in patch || "y" in patch || "w" in patch || "h" in patch) });
  const addLayer = (l: Layer) => { change((o) => { o.layers.push(l); return o; }); setSel(ov.layers.length); };
  const removeLayer = (i: number) => { change((o) => { o.layers.splice(i, 1); return o; }); setSel(null); };
  const moveLayer = (from: number, to: number) => {
    if (to < 0 || to >= ov.layers.length || from === to) return;
    change((o) => { const [l] = o.layers.splice(from, 1); o.layers.splice(to, 0, l); return o; }, { keepAnchor: true });
    setSel(to);
  };
  const duplicate = (i: number) => { const l = clone(ov.layers[i]); l.x += 20; l.y += 20; addLayer(l); };

  // ---- adding things ----
  const addText = (text = "Your text — click a field on the right to add show details") =>
    addLayer({ type: "text", x: 160, y: 820, w: 900, h: 70, text, size: 48, bold: true, color: "#ffffff", shadow: true });
  const addBox = () => addLayer({ type: "box", x: 120, y: 820, w: 900, h: 160, color: "#111827", radius: 12, opacity: 85 });
  const addFile = async (file: File, at?: { x: number; y: number }) => {
    setBusy(true); setMsg("Uploading…");
    try {
      const r = await api.uploadOverlayAsset(file);
      if (r.error) throw new Error(r.error);
      const video = r.kind === "video";
      const s = await mediaSize(overlayAssetSrc(r.src), video);
      const w = Math.min(s.w, video ? 640 : 480), h = Math.round((w * s.h) / s.w);
      const x = Math.round(Math.max(0, Math.min(AW - w, (at?.x ?? AW / 2) - w / 2))), y = Math.round(Math.max(0, Math.min(AH - h, (at?.y ?? AH / 2) - h / 2)));
      addLayer(video ? { type: "video", src: r.src, x, y, w, h } : { type: "image", src: r.src, x, y, w, h });
      setMsg("");
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const replaceFile = async (i: number, file: File) => {
    setBusy(true);
    try {
      const r = await api.uploadOverlayAsset(file);
      if (r.error) throw new Error(r.error);
      const s = await mediaSize(overlayAssetSrc(r.src), r.kind === "video");
      const l = ov.layers[i];
      setLayer(i, { src: r.src, h: Math.round((l.w * s.h) / s.w) } as Partial<Layer>);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  /** Insert a {{field}} into the selected text layer at the cursor (or a new text layer). */
  const insertField = (key: string) => {
    const token = `{{${key}}}`;
    const cur = sel != null ? ov.layers[sel] : null;
    if (cur && (cur.type === "image" || cur.type === "video") && cur.src.startsWith(MATCH_PREFIX)) {
      const name = cur.src.slice(MATCH_PREFIX.length);
      setLayer(sel!, { src: MATCH_PREFIX + (name && !/\s$/.test(name) ? `${name} ` : name) + token } as Partial<Layer>);
      return;
    }
    if (sel == null || ov.layers[sel]?.type !== "text") { addText(token); return; }
    const l = ov.layers[sel] as Extract<Layer, { type: "text" }>;
    const ta = textRef.current;
    const at = ta && document.activeElement === ta ? ta.selectionStart : l.text.length;
    const end = ta && document.activeElement === ta ? ta.selectionEnd : at;
    const sep = at > 0 && !/\s$/.test(l.text.slice(0, at)) ? " " : "";
    setLayer(sel, { text: l.text.slice(0, at) + sep + token + l.text.slice(end) } as Partial<Layer>);
    requestAnimationFrame(() => { if (ta) { ta.focus(); const p = at + sep.length + token.length; ta.setSelectionRange(p, p); } });
  };

  // ---- dragging / resizing with snapping ----
  const drag = useRef<{ i: number; handle: Handle | null; sx: number; sy: number; orig: Layer; moved: boolean } | null>(null);
  const snapTargets = (skip: number) => {
    const xs = [0, AW / 2, AW, AW * SAFE, AW * (1 - SAFE)], ys = [0, AH / 2, AH, AH * SAFE, AH * (1 - SAFE)];
    ov.layers.forEach((l, k) => { if (k !== skip) { xs.push(l.x, l.x + l.w / 2, l.x + l.w); ys.push(l.y, l.y + l.h / 2, l.y + l.h); } });
    return { xs, ys };
  };
  const snap = (vals: number[], targets: number[], tol: number): { d: number; at: number | null } => {
    let best = { d: 0, at: null as number | null, dist: tol + 1 };
    for (const v of vals) for (const t of targets) { const dist = Math.abs(t - v); if (dist < best.dist) best = { d: t - v, at: t, dist }; }
    return best.at == null ? { d: 0, at: null } : { d: best.d, at: best.at };
  };
  const onPointerDown = (e: React.PointerEvent, i: number, handle: Handle | null) => {
    e.stopPropagation(); e.preventDefault();
    setSel(i);
    drag.current = { i, handle, sx: e.clientX, sy: e.clientY, orig: clone(ov.layers[i]), moved: false };
    history.current.push(JSON.stringify(ov)); future.current = [];
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = (e.clientX - d.sx) / scale, dy = (e.clientY - d.sy) / scale;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 2) return;
    d.moved = true;
    const o = d.orig; let { x, y, w, h } = o;
    const tol = 7 / scale;
    const { xs, ys } = e.altKey ? { xs: [], ys: [] } : snapTargets(d.i);
    const gx: number[] = [], gy: number[] = [];
    if (!d.handle) {
      x = o.x + dx; y = o.y + dy;
      const sx = snap([x, x + w / 2, x + w], xs, tol), sy = snap([y, y + h / 2, y + h], ys, tol);
      x += sx.d; y += sy.d; if (sx.at != null) gx.push(sx.at); if (sy.at != null) gy.push(sy.at);
    } else {
      const hd = d.handle;
      const keep = (o.type === "image" || o.type === "video") !== e.shiftKey; // media keeps its shape (Shift to stretch)
      if (hd.includes("e")) { w = o.w + dx; const s = snap([x + w], xs, tol); w += s.d; if (s.at != null) gx.push(s.at); }
      if (hd.includes("w")) { const nx = o.x + dx; const s = snap([nx], xs, tol); x = nx + s.d; w = o.w + (o.x - x); if (s.at != null) gx.push(s.at); }
      if (hd.includes("s")) { h = o.h + dy; const s = snap([y + h], ys, tol); h += s.d; if (s.at != null) gy.push(s.at); }
      if (hd.includes("n")) { const ny = o.y + dy; const s = snap([ny], ys, tol); y = ny + s.d; h = o.h + (o.y - y); if (s.at != null) gy.push(s.at); }
      w = Math.max(8, w); h = Math.max(8, h);
      if (keep && o.w && o.h) {
        const ratio = o.h / o.w;
        if (hd === "n" || hd === "s") w = h / ratio; else h = w * ratio;
        if (hd.includes("n")) y = o.y + o.h - h;
        if (hd.includes("w")) x = o.x + o.w - w;
      }
    }
    setGuides({ x: gx, y: gy });
    setOv((cur) => {
      const next = clone(cur);
      next.layers[d.i] = { ...next.layers[d.i], x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) } as Layer;
      if (next.anchor) delete next.anchor;
      return next;
    });
    setDirty(true); setExact(null);
  };
  const onPointerUp = () => {
    if (drag.current && !drag.current.moved) history.current.pop(); // a click, not a change
    drag.current = null; setGuides({ x: [], y: [] });
  };

  // ---- keyboard: nudge, delete, duplicate, undo ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
      if (sel == null || !ov.layers[sel]) return;
      if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicate(sel); return; }
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeLayer(sel); return; }
      const step = e.shiftKey ? 10 : 1;
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (arrows[e.key]) { e.preventDefault(); const l = ov.layers[sel]; setLayer(sel, { x: l.x + arrows[e.key][0], y: l.y + arrows[e.key][1] }); }
      if (e.key === "Escape") setSel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- save / delete ----
  const save = async () => {
    if (!ov.name.trim()) { setMsg("Give the overlay a name first."); return; }
    setBusy(true); setMsg("");
    try {
      const r: any = await api.saveOverlay(ov);
      if (r.error) throw new Error(r.error);
      setDirty(false); setMsg("Saved. Rebuild the channels it's on to see the change.");
      onSaved(r);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!ov.id) { onClose(); return; }
    if (!window.confirm(`Delete "${ov.name}"? It comes off every channel that shows it.`)) return;
    await api.deleteOverlay(ov.id); onClose();
  };
  const checkRender = async () => {
    if (exact) { setExact(null); return; }
    setBusy(true);
    try {
      const r = await api.renderOverlay(ov, vars);
      if (r.error) throw new Error(r.error);
      if (r.png && r.box) setExact({ png: r.png, box: r.box }); else setMsg("Nothing to render yet — add a text, image or box.");
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  const on = new Set(usedBy[ov.id] ?? []);
  const toggleChannel = async (name: string, show: boolean) => {
    const meta = channels.find((c) => c.name === name)?.meta;
    const cur = meta?.overlays ?? [];
    await api.setChannelMeta(name, { overlays: show ? [...cur.filter((x) => x !== ov.id), ov.id] : cur.filter((x) => x !== ov.id) });
    onChannels();
  };

  const L = sel != null ? ov.layers[sel] : null;
  const t = ov.timing ?? { mode: "always" };
  const setTiming = (patch: Partial<Overlay["timing"]>) => change((o) => ({ ...o, timing: { ...o.timing, ...patch } }), { keepAnchor: true });
  const setOpt = (patch: Partial<Overlay>) => change((o) => ({ ...o, ...patch }), { keepAnchor: true });

  return (
    <div className="screen ov-designer">
      <div className="ov-top">
        <button className="ghost" onClick={() => { if (!dirty || window.confirm("Leave without saving your changes?")) onClose(); }}>← Overlays</button>
        <input className="ov-name" value={ov.name} onChange={(e) => setOpt({ name: e.target.value })} placeholder="Overlay name" />
        {dirty && <span className="pill off">Unsaved</span>}
        <div className="ov-top-actions">
          <button onClick={undo} disabled={!history.current.length} title="Undo (Ctrl+Z)">↶</button>
          <button onClick={redo} disabled={!future.current.length} title="Redo (Ctrl+Y)">↷</button>
          {ov.id && <button onClick={remove}>Delete</button>}
          <button className="primary" onClick={save} disabled={busy}>Save</button>
        </div>
      </div>
      {msg && <p className={/saved/i.test(msg) ? "ok" : "err"} style={{ margin: "0 0 8px" }}>{msg}</p>}

      <div className="ov-layout">
        <div className="ov-main">
          <div className="ov-toolbar">
            <span className="muted">Add:</span>
            <button onClick={() => addText()}>T Text</button>
            <button onClick={() => fileRef.current?.click()} disabled={busy}>▣ Image or video</button>
            <button onClick={addBox}>■ Box</button>
            <button onClick={() => addLayer({ type: "image", src: CHANNEL_LOGO, x: 1600, y: 860, w: 220, h: 220 })} title="Each channel shows its own logo here">◎ Channel logo</button>
            <button onClick={() => addLayer({ type: "image", src: `${MATCH_PREFIX}{{next_show}}`, x: 1180, y: 700, w: 400, h: 225 })} title="A picture from the pictures folder, picked by a show detail (e.g. the next show's name)">🖼 Picture by show</button>
            <input ref={fileRef} type="file" accept="image/*,video/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) addFile(f); e.target.value = ""; }} />
          </div>
          <div className="ov-viewbar">
            <div className="ov-viewbar-group">
              <label className="ov-inline"><input type="checkbox" checked={showSamples} onChange={(e) => setShowSamples(e.target.checked)} /> Sample values</label>
              <select className="ov-bg" value={bg} onChange={(e) => setBg(e.target.value as any)} title="Canvas background">
                <option value="dark">Dark background</option><option value="light">Light background</option><option value="check">Checkerboard</option>
              </select>
              <button onClick={() => refInput.current?.click()} className={ref ? "active" : ""} title="Put a picture or a frame of a video behind the canvas to line things up against. Only for designing: it isn't uploaded, saved or shown on air.">{ref ? "Change reference…" : "Reference picture or video…"}</button>
              <input ref={refInput} type="file" accept="image/*,video/*,.mkv,.ts,.avi" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pickRef(f); e.target.value = ""; }} />
            </div>
            <div className="ov-viewbar-group">
              <button onClick={() => { setExact(null); setPlaying((p) => !p); }} className={playing ? "active" : ""} disabled={!isAnimated(ov.layers) && !timed} title={timed ? "Play the whole appearance, each layer at its own time" : isAnimated(ov.layers) ? "Play the in / out animation on the canvas" : "Pick an animation below, or give a layer its own time on screen"}>{playing ? "■ Stop" : timed ? "▶ Play timeline" : "▶ Play animation"}</button>
              <button onClick={checkRender} className={exact ? "active" : ""} disabled={busy} title="Show exactly what a build draws (the server's fonts)">{exact ? "Back to editing" : "Check exact render"}</button>
            </div>
          </div>

          {ref && (
            <div className="ov-refbar">
              <span className="muted" title={ref.name}>Reference: <b>{ref.name.length > 32 ? `${ref.name.slice(0, 30)}…` : ref.name}</b> — only for lining things up; not saved or shown on air</span>
              {(ref.video || ref.lib) && refDurS > 0 && (
                <span className="ov-refscrub">
                  <button className="ghost" onClick={() => seekRef(ref.t - 10)} title="Back 10 seconds">«</button>
                  <button className="ghost" onClick={() => seekRef(ref.t - 1 / 30)} title="Back one frame">‹</button>
                  <input type="range" min={0} max={refDurS} step={1 / 30} value={ref.t} onChange={(e) => seekRef(Number(e.target.value))} aria-label="Frame" />
                  <button className="ghost" onClick={() => seekRef(ref.t + 1 / 30)} title="Forward one frame">›</button>
                  <button className="ghost" onClick={() => seekRef(ref.t + 10)} title="Forward 10 seconds">»</button>
                  <span className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>{clock(ref.t)} / {clock(refDurS)}</span>
                </span>
              )}
              {ref.video && !refDur && !refErr && <span className="muted">Loading the video…</span>}
              <label className="ov-inline" title="Darken the reference so the layers stand out">Dim <input type="range" min={0} max={80} value={ref.dim} onChange={(e) => setRef({ ...ref, dim: Number(e.target.value) })} style={{ width: 80 }} /></label>
              <button className="ghost" onClick={() => { if (ref.url) URL.revokeObjectURL(ref.url); setRef(null); setRefErr(""); }}>Remove</button>
              {refErr && <span className="err">{refErr}</span>}
            </div>
          )}
          <div ref={stageRef} className={`ov-stage bg-${bg}${dropHint ? " drop" : ""}`}
            onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerDown={() => setSel(null)}
            onDragOver={(e) => { e.preventDefault(); setDropHint(true); }} onDragLeave={() => setDropHint(false)}
            onDrop={(e) => {
              e.preventDefault(); setDropHint(false);
              const f = e.dataTransfer.files?.[0]; if (!f) return;
              const r = stageRef.current!.getBoundingClientRect();
              addFile(f, { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale });
            }}>
            {/* shown fitted on black, the way next fits a show into the frame */}
            {ref?.lib && <img className="ov-ref" src={referenceFrameUrl(ref.lib.path, libT)} alt="" onLoad={() => setRefErr("")}
              onError={() => setRefErr("The server couldn't read a frame from that file (is it reachable from this computer?).")} />}
            {ref && !ref.lib && (ref.video
              ? <video key={ref.url} ref={refVideo} className="ov-ref" src={ref.url} muted playsInline preload="auto"
                  onLoadedMetadata={(e) => {
                    const d = e.currentTarget.duration;
                    setRefDur(Number.isFinite(d) ? d : 0);
                    // start a little way in: the first frame is often black
                    const t = ref.t || Math.min(Number.isFinite(d) ? d / 10 : 0, 120);
                    e.currentTarget.currentTime = t;
                    if (t !== ref.t) setRef({ ...ref, t });
                  }}
                  onError={() => setRefErr("This browser can't play that video. An MP4 (H.264) or WebM works — or use a screenshot.")} />
              : <img key={ref.url} className="ov-ref" src={ref.url} alt="" onError={() => setRefErr("That picture couldn't be shown.")} />)}
            {ref && ref.dim > 0 && <div className="ov-ref" style={{ background: `rgba(0,0,0,${ref.dim / 100})` }} />}
            <div className="ov-safe" style={{ inset: `${SAFE * 100}%` }} />
            {exact ? (
              <img className="ov-exact" src={exact.png} style={{ left: exact.box.x * scale, top: exact.box.y * scale, width: exact.box.w * scale, height: exact.box.h * scale }} alt="" />
            ) : ov.layers.map((l, i) => {
              const st = stateOf(l);
              const clip = st.clip ? `inset(${(st.clip.y - l.y) * scale}px ${(l.x + l.w - st.clip.x - st.clip.w) * scale}px ${(l.y + l.h - st.clip.y - st.clip.h) * scale}px ${(st.clip.x - l.x) * scale}px)` : undefined;
              return (
                <div key={i} className={`ov-layer${sel === i && !playing ? " sel" : ""}`} style={{ left: l.x * scale, top: l.y * scale, width: l.w * scale, height: l.h * scale, opacity: (ov.opacity ?? 100) / 100, clipPath: clip }}
                  onPointerDown={(e) => { if (!playing) onPointerDown(e, i, null); }} onDoubleClick={() => { if (l.type === "text") textRef.current?.focus(); }}>
                  <div style={{ position: "absolute", inset: 0, opacity: st.opacity, transform: st.dx || st.dy || st.scale !== 1 ? `translate(${st.dx * scale}px, ${st.dy * scale}px) scale(${st.scale})` : undefined }}>
                    <LayerView l={l} scale={scale} vars={showSamples ? vars : {}} inner chars={st.chars} />
                  </div>
                  {sel === i && !playing && HANDLES.map((h) => <span key={h} className={`ov-h ov-h-${h}`} onPointerDown={(e) => onPointerDown(e, i, h)} />)}
                </div>
              );
            })}
            {guides.x.map((x, k) => <div key={`gx${k}`} className="ov-guide v" style={{ left: x * scale }} />)}
            {guides.y.map((y, k) => <div key={`gy${k}`} className="ov-guide h" style={{ top: y * scale }} />)}
            {!ov.layers.length && !exact && (
              <div className="ov-stage-empty">
                <b>Add a text, image or box from the toolbar</b>
                <span>…or drop an image or video file here</span>
              </div>
            )}
          </div>
          {timedMode && ov.layers.length > 0 && (
            <Timeline layers={ov.layers} showMs={showMs} t={frame && frame !== "hidden" && frame.phase === "tl" ? frame.t : linkedMs()} sel={sel} onSelect={setSel} />
          )}
          <p className="muted ov-hint">Drag to move, drag the corners to resize (Shift stretches images), arrow keys nudge (Shift = 10px). Hold Alt to stop snapping. The dashed line is the safe area most TVs show.</p>

          <div className="ov-panels">
            <div className="meta-card">
              <b>When it shows</b>
              <div className="ov-when">
                {([
                  ["always", "Always on", "The whole time (a watermark or bug)"],
                  ["every", "Every few minutes", "Pops up on a regular schedule"],
                  ["start", "After a show starts", "Once, a set time into each show"],
                  ["end", "Before a show ends", "Once, near the end (great for \"up next\")"],
                  ["media", "When a video plays", "Over one particular video, whenever it airs (e.g. a pre-made up-next bumper)"],
                ] as const).map(([mode, label, desc]) => (
                  <button key={mode} className={`ov-when-opt${t.mode === mode ? " active" : ""}`} onClick={() => setTiming({ mode })}>
                    <b>{label}</b><span>{desc}</span>
                  </button>
                ))}
              </div>
              {t.mode === "every" && (
                <div className="ov-sentence">Show for <input type="number" min={1} value={t.showSeconds ?? 10} onChange={(e) => setTiming({ showSeconds: Number(e.target.value) })} /> seconds every <input type="number" min={1} value={t.everyMinutes ?? 15} onChange={(e) => setTiming({ everyMinutes: Number(e.target.value) })} /> minutes, starting <input type="number" min={0} value={t.offsetSeconds ?? 0} onChange={(e) => setTiming({ offsetSeconds: Number(e.target.value) })} /> seconds past the mark (by the clock, so every viewer sees it at the same time).</div>
              )}
              {t.mode === "start" && (
                <div className="ov-sentence">Show for <input type="number" min={1} value={t.showSeconds ?? 10} onChange={(e) => setTiming({ showSeconds: Number(e.target.value) })} /> seconds, <input type="number" min={0} value={t.offsetSeconds ?? 60} onChange={(e) => setTiming({ offsetSeconds: Number(e.target.value) })} /> seconds after each show starts.</div>
              )}
              {t.mode === "media" && (t.media && !pickMedia ? (
                <div className="ov-media">
                  <div className="ov-sentence">Over <b>{t.media.title || t.media.path.split(/[\\/]/).pop()}</b>{t.media.durationMs ? ` (${clock(t.media.durationMs / 1000).replace(/\.\d+$/, "")})` : ""}
                    {" "}<button className="ghost" onClick={() => setPickMedia(true)}>Change…</button>
                    {!(ref?.lib && ref.lib.path === t.media.path) && <button className="ghost" onClick={() => loadMediaRef(t.media!, t.offsetSeconds ?? 0)}>Show it behind the canvas</button>}
                  </div>
                  <div className="ov-sentence">Show for <input type="number" min={1} value={t.showSeconds ?? 10} onChange={(e) => setTiming({ showSeconds: Number(e.target.value) })} /> seconds, starting <input type="number" min={0} value={t.offsetSeconds ?? 0} onChange={(e) => setTiming({ offsetSeconds: Number(e.target.value) })} /> seconds into it.</div>
                  <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>On every channel, each time it airs — as a commercial or bumper too — so there's no need to tick channels. Show details mean what's around it in the guide: <code>{"{{next_show}}"}</code> is the next show after it. Drag the frame slider above the canvas to see which layers are up at each moment, and give layers their own time under <b>On screen</b>. Rebuild the channels that play it.</p>
                </div>
              ) : (
                <MediaPicker onCancel={t.media ? () => setPickMedia(false) : undefined} onPick={(m) => {
                  setTiming({ media: m, offsetSeconds: 0, showSeconds: Math.max(1, Math.round((m.durationMs ?? 10000) / 1000)) });
                  loadMediaRef(m); setPickMedia(false);
                }} />
              ))}
              {t.mode === "end" && (
                <div className="ov-sentence">Show for <input type="number" min={1} value={t.showSeconds ?? 10} onChange={(e) => setTiming({ showSeconds: Number(e.target.value) })} /> seconds, starting <input type="number" min={0} value={t.offsetSeconds ?? 120} onChange={(e) => setTiming({ offsetSeconds: Number(e.target.value) })} /> seconds before each show ends.</div>
              )}
              <div className="ov-opts">
                {t.mode !== "always" && <label>Fade (seconds)<input type="number" min={0} step={0.5} value={ov.fadeSeconds ?? 1} onChange={(e) => setOpt({ fadeSeconds: Number(e.target.value) })} /></label>}
                <label>Opacity: {ov.opacity ?? 100}%<input type="range" min={10} max={100} value={ov.opacity ?? 100} onChange={(e) => setOpt({ opacity: Number(e.target.value) })} /></label>
              </div>
              <div className="ov-season">
                <label>On which days
                  <select value={ov.season?.holiday ? "holiday" : ov.season?.from ? "dates" : ""} onChange={(e) => setOpt({ season: e.target.value === "holiday" ? { holiday: "christmas", before: 7, after: 0 } : e.target.value === "dates" ? { from: "12-01", to: "12-31" } : undefined })}>
                    <option value="">Every day</option><option value="holiday">Only around a holiday</option><option value="dates">Only between two dates (every year)</option>
                  </select>
                </label>
                {ov.season?.holiday && (
                  <div className="ov-sentence">From <input type="number" min={0} value={ov.season.before ?? 0} onChange={(e) => setOpt({ season: { ...ov.season, before: Number(e.target.value) } })} /> days before
                    {" "}<select style={{ width: "auto", display: "inline-block" }} value={ov.season.holiday} onChange={(e) => setOpt({ season: { ...ov.season, holiday: e.target.value } })}>{HOLIDAYS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                    {" "}to <input type="number" min={0} value={ov.season.after ?? 0} onChange={(e) => setOpt({ season: { ...ov.season, after: Number(e.target.value) } })} /> days after. Moving holidays (Thanksgiving, Easter…) land on the right day each year.</div>
                )}
                {ov.season?.from && (
                  <div className="ov-sentence">From <input style={{ width: 90 }} value={ov.season.from} placeholder="MM-DD" onChange={(e) => setOpt({ season: { ...ov.season, from: e.target.value } })} /> to <input style={{ width: 90 }} value={ov.season.to ?? ""} placeholder="MM-DD" onChange={(e) => setOpt({ season: { ...ov.season, to: e.target.value } })} /> (month-day, e.g. 12-01).</div>
                )}
              </div>
              {t.mode !== "media" && <label className="ov-inline"><input type="checkbox" checked={!!ov.duringFiller} onChange={(e) => setOpt({ duringFiller: e.target.checked })} /> Also show over commercials and bumpers</label>}
              <label className="ov-inline"><input type="checkbox" checked={!!ov.withinContent} onChange={(e) => setOpt({ withinContent: e.target.checked })} /> Keep it inside the picture on letterboxed / 4:3 shows</label>
            </div>

            <div className="meta-card">
              <b>Animation</b>
              <p className="muted" style={{ margin: "2px 0 8px", fontSize: 12 }}>How it comes on and goes off. Pick a style for the whole overlay, then fine-tune any layer (select it). {isAnimated(ov.layers) ? `In ${(animLengths(ov.layers).inMs / 1000).toFixed(1)}s · out ${(animLengths(ov.layers).outMs / 1000).toFixed(1)}s.` : ""}</p>
              <div className="ov-styles">
                {ANIM_STYLES.map((a) => (
                  <button key={a.id} className="ov-when-opt" title={a.desc} onClick={() => { change((o) => ({ ...o, layers: applyAnimStyle(o.layers, a.id) }), { keepAnchor: true }); if (a.id !== "none") setPlaying(true); else setPlaying(false); }}>
                    <b>{a.label}</b><span>{a.desc}</span>
                  </button>
                ))}
              </div>
              {(isAnimated(ov.layers) || timed) && t.mode !== "always" && (
                <div className="ov-motion">
                  <label>Motion
                    <select value={ov.motion ?? "auto"} onChange={(e) => setOpt({ motion: e.target.value === "auto" ? undefined : e.target.value as "live" | "rendered" })}>
                      <option value="auto">Automatic</option>
                      <option value="live">Fades only — drawn live</option>
                      <option value="rendered">Full animation — pre-rendered</option>
                    </select>
                  </label>
                  <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
                    {!ov.motion && (onlyFades(ov.layers) ? "Automatic: it only fades, so it's drawn live. " : "Automatic: it uses wipes, slides or other moves, so it's pre-rendered. ")}
                    {live
                      ? <>Drawn live by the scheduler as it airs: each layer fades in and out at its own time{onlyFades(ov.layers) ? "" : " (other animations play as fades — the preview shows how)"}. Nothing is pre-rendered, so builds are instant and use no disk space. The scheduler must be running while channels play, like the up-next cards.</>
                      : <>Pre-rendered as a short transparent video for each different look (each show, or each airing if it shows times): every animation plays exactly as designed, and it plays even if the scheduler is off. Builds take longer and the videos use disk space (cleared when unused for two weeks). Needs ErsatzTV next 0.2.3 or newer.</>}
                  </p>
                </div>
              )}
              {isAnimated(ov.layers) && t.mode === "always" && <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>Animated always-on overlays are pre-rendered and need ErsatzTV next 0.2.3 or newer. The held part between the animations is a still picture, so viewers who tune in mid-way still see it.</p>}
            </div>

            <div className="meta-card">
              <b>Show on channels</b>
              {t.mode === "media" ? (
                <>
                  <p className="muted" style={{ margin: "4px 0 8px" }}>Shown on every channel, wherever {t.media ? <b>{t.media.title || "its video"}</b> : "the video you pick"} airs. Save it, then rebuild the channels that play that video.</p>
                  {ov.id && <div className="row" style={{ gap: 6 }}>
                    <button onClick={() => navigate("build")}>Go to Build →</button>
                    <button onClick={() => navigate("troubleshoot", { tab: "overlays", overlay: ov.id })} title="Play the moment it appears on a channel, through ErsatzTV next">Test on a channel →</button>
                  </div>}
                </>
              ) : !ov.id ? <p className="muted">Save the overlay first, then pick its channels here.</p> : (
                <>
                  <p className="muted" style={{ margin: "4px 0 8px" }}>Shown over every programme on these channels. To use it on just one block or grid show, pick it in that block's settings. Rebuild a channel after changing this.</p>
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

        <div className="ov-side">
          <div className="meta-card">
            <div className="pane-head"><b>Layers</b><span className="muted" style={{ fontSize: 12 }}>top to bottom</span></div>
            {!ov.layers.length ? <p className="muted">Nothing yet.</p> : (
              <div className="ov-layers">
                {ov.layers.map((l, i) => ({ l, i })).reverse().map(({ l, i }) => (
                  <div key={i} className={`ov-layer-row${sel === i ? " sel" : ""}`} draggable onClick={() => setSel(i)}
                    onDragStart={(e) => e.dataTransfer.setData("text/ov-layer", String(i))}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); const from = Number(e.dataTransfer.getData("text/ov-layer")); if (Number.isFinite(from)) moveLayer(from, i); }}>
                    <span className="ov-grip" title="Drag to reorder">⠿</span>
                    <span className="ov-licon">{LAYER_ICON[l.type]}</span>
                    <span className="ov-lname">{l.type === "text" ? (l.text || "Text").slice(0, 28) : (l.type === "image" || l.type === "video") ? `${LAYER_LABEL[l.type]} · ${l.src === CHANNEL_LOGO ? "channel logo" : l.src.startsWith(MATCH_PREFIX) ? `by ${l.src.slice(MATCH_PREFIX.length)}`.slice(0, 24) : l.src.replace(/^(example:|assets\/)/, "").replace(/\.[a-z0-9]+$/i, "").slice(0, 18)}` : LAYER_LABEL[l.type]}</span>
                    <button className="ghost" title="Bring forward" onClick={(e) => { e.stopPropagation(); moveLayer(i, i + 1); }}>↑</button>
                    <button className="ghost" title="Send backward" onClick={(e) => { e.stopPropagation(); moveLayer(i, i - 1); }}>↓</button>
                    <button className="ghost" title="Delete" onClick={(e) => { e.stopPropagation(); removeLayer(i); }}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {L && sel != null && <LayerProps l={L} i={sel} setLayer={setLayer} textRef={textRef} onReplace={(f) => replaceFile(sel, f)} onDuplicate={() => duplicate(sel)} onDelete={() => removeLayer(sel)} fields={fields} slots={slots} vars={vars} timedMode={timedMode} showMs={showMs} />}

          <div className="meta-card">
            <b>Show details you can use</b>
            <p className="muted" style={{ margin: "2px 0 8px", fontSize: 12 }}>Click one to add it to {L?.type === "text" ? "the selected text" : (L?.type === "image" || L?.type === "video") && L.src.startsWith(MATCH_PREFIX) ? "the selected picture's name" : "a new text layer"}. Each show fills in its own.</p>
            <div className="ov-seg" style={{ flexWrap: "wrap", marginBottom: 6 }}>
              {slots.map((s, k) => <button key={s} className={fieldSlot === k ? "active" : ""} onClick={() => setFieldSlot(k)}>{s}</button>)}
              <button className={fieldSlot === -1 ? "active" : ""} onClick={() => setFieldSlot(-1)}>Channel</button>
            </div>
            <div className="ov-fields">
              {fields.filter((f) => (f.slot ?? -1) === fieldSlot).map((f) => (
                <button key={f.key} className="ov-field" onClick={() => insertField(f.key)} title={`{{${f.key}}}`}>
                  <span>{f.label}</span><span className="muted">{f.sample}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- layer rendering + properties -----------------------------------------------
let measureCtx: CanvasRenderingContext2D | null = null;
// ---- fonts -------------------------------------------------------------------------
// The server draws with its own fonts plus any added on this page (TTF / OTF in
// runtime/overlays/fonts); added ones are loaded here too, so the preview matches.
let fontsCache: Promise<OverlayFonts> | null = null;
const loadFonts = (fresh = false) => {
  if (fresh || !fontsCache) fontsCache = api.overlayFonts().catch(() => ({ families: [], added: [], dir: "" }));
  return fontsCache;
};
/** The added fonts as @font-face rules for the designer's preview. */
function addFontFaces(f: OverlayFonts) {
  let el = document.getElementById("tvn-overlay-fonts") as HTMLStyleElement | null;
  if (!el) { el = document.createElement("style"); el.id = "tvn-overlay-fonts"; document.head.appendChild(el); }
  el.textContent = f.added.flatMap((a) => a.families.map((fam) => `@font-face { font-family: ${JSON.stringify(fam)}; src: url("/overlay-fonts/${encodeURIComponent(a.file)}"); }`)).join("\n");
}
function useOverlayFonts(): OverlayFonts | null {
  const [f, setF] = useState<OverlayFonts | null>(null);
  useEffect(() => {
    let live = true;
    const get = (fresh = false) => loadFonts(fresh).then((x) => { if (!live) return; setF(x); addFontFaces(x); });
    get();
    const changed = () => get(true);
    window.addEventListener("tvn:fonts-changed", changed);
    return () => { live = false; window.removeEventListener("tvn:fonts-changed", changed); };
  }, []);
  return f;
}
const errText = (e: unknown) => { const m = (e as Error).message ?? String(e); try { return JSON.parse(m).error ?? m; } catch { return m; } };

/** A text layer's font: fonts added here, the common ones, then everything on the server,
 *  and adding a font file. */
function FontPicker({ value, onChange }: { value: string; onChange: (font: string) => void }) {
  const f = useOverlayFonts();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const added = [...new Set((f?.added ?? []).flatMap((a) => a.families))].sort((a, b) => a.localeCompare(b));
  const server = (f?.families ?? []).filter((x) => !added.includes(x) && !FONTS.includes(x));
  const known = !f || added.includes(value) || FONTS.includes(value) || server.includes(value);
  const opt = (x: string) => <option key={x} value={x} style={{ fontFamily: x }}>{x}</option>;
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setErr("");
    try {
      const r = await api.uploadOverlayFont(file);
      await loadFonts(true);
      window.dispatchEvent(new Event("tvn:fonts-changed"));
      if (r.families[0]) onChange(r.families[0]);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  return (
    <>
      <label>Font
        <select value={value} style={{ fontFamily: value }} onChange={(e) => (e.target.value === "__add" ? fileRef.current?.click() : onChange(e.target.value))}>
          {!known && <option value={value}>{value} (not on the server)</option>}
          {added.length > 0 && <optgroup label="Added fonts">{added.map(opt)}</optgroup>}
          <optgroup label="Common">{FONTS.map(opt)}</optgroup>
          {server.length > 0 && <optgroup label="Everything on the server">{server.map(opt)}</optgroup>}
          <option value="__add">Add a font file (TTF / OTF)…</option>
        </select>
        {busy && <span className="muted" style={{ fontSize: 12 }}>Adding the font…</span>}
        {err && <span className="err" style={{ fontSize: 12 }}>{err}</span>}
      </label>
      <input ref={fileRef} type="file" accept=".ttf,.otf" hidden onChange={(e) => upload(e.target.files?.[0])} />
    </>
  );
}

/** A line's width in artboard pixels with the browser's font. */
function measure(t: string, font: string, size: number, bold: boolean, italic: boolean): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return 0;
  measureCtx.font = `${italic ? "italic " : ""}${bold ? 700 : 400} ${size}px ${font}, Arial, sans-serif`;
  return measureCtx.measureText(t).width;
}
/** A box's CSS background: its colour, or its gradient (as builds draw it). */
function boxFill(l: Extract<Layer, { type: "box" }>): string {
  const c = l.color || "#000000";
  if (!l.gradient?.to) return c;
  const to = l.gradient.to === "transparent" ? `${c.length === 7 ? c : "#000000"}00` : l.gradient.to;
  return `linear-gradient(${l.gradient.dir === "down" ? "to bottom" : "to right"}, ${c}, ${to})`;
}
function LayerView({ l, scale, vars, inner, chars = 1 }: { l: Layer; scale: number; vars: Record<string, string>; inner?: boolean; chars?: number }) {
  // explicit width / height: images and videos ignore inset:0 and show at their own pixel size
  const pos: React.CSSProperties = inner ? { position: "absolute", left: 0, top: 0, width: "100%", height: "100%" } : { position: "absolute", left: l.x * scale, top: l.y * scale, width: l.w * scale, height: l.h * scale };
  const op = l.opacity != null && l.opacity < 100 ? l.opacity / 100 : undefined;
  if (l.type === "box") return <div style={{ ...pos, background: boxFill(l), borderRadius: (l.radius ?? 0) * scale, opacity: op, border: l.borderWidth ? `${l.borderWidth * scale}px solid ${l.border || "#fff"}` : undefined, boxSizing: "border-box" }} />;
  if ((l.type === "image" || l.type === "video") && l.src.startsWith(MATCH_PREFIX)) return <MatchImage src={l.src} fallback={l.fallback} vars={vars} video={l.type === "video"} style={{ ...pos, opacity: op, pointerEvents: "none" }} />;
  if (l.type === "image") return <img src={overlayAssetSrc(l.src)} draggable={false} alt="" style={{ ...pos, objectFit: "contain", opacity: op, pointerEvents: "none" }} />;
  if (l.type === "video") return <video src={overlayAssetSrc(l.src)} muted loop autoPlay playsInline style={{ ...pos, objectFit: "contain", opacity: op, pointerEvents: "none" }} />;
  let text = fill(l.text ?? "", vars);
  if (l.upper) text = text.toUpperCase();
  let base = l.size ?? 48;
  if (l.fit) { // shrink to fit: one line, smaller only when it's too wide (as builds do)
    const w = Math.max(...text.split(/\r?\n/).map((ln) => measure(ln, l.font || "Arial", base, !!l.bold, !!l.italic)));
    if (w > l.w) base = Math.max(8, Math.floor(base * (l.w / w) * 0.98));
  }
  const size = base * scale;
  if (chars < 1) text = text.slice(0, Math.round(text.length * chars));
  return (
    <div style={{
      ...pos, display: "flex", flexDirection: "column", justifyContent: l.valign === "bottom" ? "flex-end" : l.valign === "middle" ? "center" : "flex-start",
      textAlign: l.align ?? "left", color: l.color || "#fff", fontFamily: `${l.font || "Arial"}, Arial, sans-serif`, fontSize: size, lineHeight: 1.18,
      fontWeight: l.bold ? 700 : 400, fontStyle: l.italic ? "italic" : "normal", whiteSpace: l.fit ? "pre" : "pre-wrap", overflowWrap: "break-word", opacity: op, pointerEvents: "none",
      textShadow: !l.shadow ? undefined : l.shadowStyle === "hard"
        ? `${(l.shadowDistance ?? base / 12) * scale}px ${(l.shadowDistance ?? base / 12) * scale}px 0 ${l.shadowColor || "#000000"}`
        : `${(l.shadowDistance ?? base / 16) * scale}px ${(l.shadowDistance ?? base / 16) * scale}px ${size / 12}px ${l.shadowColor || "#000000"}bf`,
      WebkitTextStroke: l.outlineWidth ? `${l.outlineWidth * scale}px ${l.outline || "#000"}` : undefined, paintOrder: "stroke fill",
    } as React.CSSProperties}>{text}</div>
  );
}

function LayerProps({ l, i, setLayer, textRef, onReplace, onDuplicate, onDelete, fields, slots, vars, timedMode, showMs }: {
  l: Layer; i: number; setLayer: (i: number, p: Partial<Layer>) => void; textRef: React.RefObject<HTMLTextAreaElement>;
  onReplace: (f: File) => void; onDuplicate: () => void; onDelete: () => void;
  fields: OverlayField[]; slots: string[]; vars: Record<string, string>; timedMode: boolean; showMs: number;
}) {
  const set = (p: Record<string, unknown>) => setLayer(i, p as Partial<Layer>);
  const n = (k: string, label: string, min = 0, step = 1) => (
    <label>{label}<input type="number" min={min} step={step} value={Math.round(((l as any)[k] ?? 0) * 100) / 100} onChange={(e) => set({ [k]: Number(e.target.value) })} /></label>
  );
  const replaceRef = useRef<HTMLInputElement>(null);
  return (
    <div className="meta-card ov-props">
      {l.type === "image" && l.src === CHANNEL_LOGO && <p className="muted" style={{ fontSize: 12, margin: 0 }}>Each channel fills this in with its own logo (set on the channel's settings).</p>}
      <div className="pane-head"><b>{(l.type === "image" || l.type === "video") && l.src.startsWith(MATCH_PREFIX) ? `${LAYER_LABEL[l.type]} by show` : LAYER_LABEL[l.type]}</b><span><button className="ghost" onClick={onDuplicate} title="Duplicate (Ctrl+D)">Duplicate</button><button className="ghost" onClick={onDelete}>Delete</button></span></div>
      {l.type === "text" && (
        <>
          <label>Text
            <textarea ref={textRef} rows={3} value={l.text} onChange={(e) => set({ text: e.target.value })} placeholder="Type, and click a show detail below to add it" />
          </label>
          <div className="ov-grid2">
            <FontPicker value={l.font || "Arial"} onChange={(font) => set({ font })} />
            {n("size", "Size", 6)}
          </div>
          <div className="ov-grid3">
            <label>Colour<input type="color" value={l.color || "#ffffff"} onChange={(e) => set({ color: e.target.value })} /></label>
            <label>Outline<input type="color" value={l.outline || "#000000"} onChange={(e) => set({ outline: e.target.value, outlineWidth: l.outlineWidth || 3 })} /></label>
            {n("outlineWidth", "Width")}
          </div>
          <div className="ov-align">
            <span className="ov-align-label">Align</span>
            <div className="ov-seg">
              {(["left", "center", "right"] as const).map((a) => <button key={a} className={(l.align ?? "left") === a ? "active" : ""} onClick={() => set({ align: a })} title={`Align ${a}`}>{a === "left" ? "⇤" : a === "center" ? "↔" : "⇥"}</button>)}
            </div>
            <div className="ov-seg">
              {(["top", "middle", "bottom"] as const).map((a) => <button key={a} className={(l.valign ?? "top") === a ? "active" : ""} onClick={() => set({ valign: a })} title={`Align ${a}`}>{a === "top" ? "⤒" : a === "middle" ? "≡" : "⤓"}</button>)}
            </div>
          </div>
          <div className="ov-checks">
            <label className="ov-inline"><input type="checkbox" checked={!!l.bold} onChange={(e) => set({ bold: e.target.checked })} /> Bold</label>
            <label className="ov-inline"><input type="checkbox" checked={!!l.italic} onChange={(e) => set({ italic: e.target.checked })} /> Italic</label>
            <label className="ov-inline"><input type="checkbox" checked={!!l.upper} onChange={(e) => set({ upper: e.target.checked })} /> ALL CAPS</label>
            <label className="ov-inline"><input type="checkbox" checked={!!l.shadow} onChange={(e) => set({ shadow: e.target.checked })} /> Shadow</label>
            {l.shadow && <label className="ov-inline" title="The shadow's colour"><input type="color" value={l.shadowColor || "#000000"} onChange={(e) => set({ shadowColor: e.target.value })} /></label>}
            {l.shadow && <label className="ov-inline" title="Soft: a blurred drop shadow. Hard: a solid offset copy, like old TV captions.">
              <select value={l.shadowStyle ?? "soft"} onChange={(e) => set({ shadowStyle: e.target.value as "soft" | "hard" })}><option value="soft">Soft</option><option value="hard">Hard</option></select>
            </label>}
            {l.shadow && <label className="ov-inline" title="How far the shadow sits from the text, in pixels (blank: it goes with the text size)">Distance
              <input type="number" min={0} max={60} style={{ width: 56 }} placeholder={String(Math.round((l.size ?? 48) / (l.shadowStyle === "hard" ? 12 : 16)))} value={l.shadowDistance ?? ""}
                onChange={(e) => set({ shadowDistance: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) })} />
            </label>}
            <label className="ov-inline" title="Keep it on one line; it gets smaller when a long show name wouldn't fit"><input type="checkbox" checked={!!l.fit} onChange={(e) => set({ fit: e.target.checked })} /> Shrink to fit</label>
          </div>
        </>
      )}
      {l.type === "box" && (
        <>
          <div className="ov-grid2">
            <label>Colour<input type="color" value={l.color || "#000000"} onChange={(e) => set({ color: e.target.value })} /></label>
            {n("radius", "Rounded corners")}
          </div>
          <div className="ov-grid2">
            <label>Border<input type="color" value={l.border || "#ffffff"} onChange={(e) => set({ border: e.target.value, borderWidth: l.borderWidth || 3 })} /></label>
            {n("borderWidth", "Border width")}
          </div>
          <div className="ov-grid2">
            <label>Gradient
              <select value={!l.gradient ? "" : l.gradient.to === "transparent" ? "fade" : "color"} onChange={(e) => set({ gradient: e.target.value === "fade" ? { to: "transparent", dir: l.gradient?.dir } : e.target.value === "color" ? { to: l.gradient?.to && l.gradient.to !== "transparent" ? l.gradient.to : "#7c3aed", dir: l.gradient?.dir } : undefined })}>
                <option value="">None (solid)</option><option value="fade">Fade out</option><option value="color">To another colour</option>
              </select>
            </label>
            {l.gradient && (
              <label>{l.gradient.to === "transparent" ? "Direction" : "To colour / direction"}
                <div className="ov-seg" style={{ flexWrap: "nowrap" }}>
                  {l.gradient.to !== "transparent" && <input type="color" value={l.gradient.to} onChange={(e) => set({ gradient: { ...l.gradient!, to: e.target.value } })} style={{ width: 44 }} />}
                  <button className={(l.gradient.dir ?? "right") === "right" ? "active" : ""} onClick={() => set({ gradient: { ...l.gradient!, dir: "right" } })} title="Left to right">→</button>
                  <button className={l.gradient.dir === "down" ? "active" : ""} onClick={() => set({ gradient: { ...l.gradient!, dir: "down" } })} title="Top to bottom">↓</button>
                </div>
              </label>
            )}
          </div>
        </>
      )}
      {(l.type === "image" || l.type === "video") && l.src.startsWith(MATCH_PREFIX) && (
        <MatchProps src={l.src} fallback={l.fallback} kind={l.type} fields={fields} slots={slots} vars={vars} set={(p) => set(p)} />
      )}
      {(l.type === "image" || l.type === "video") && !l.src.startsWith(MATCH_PREFIX) && (
        <>
          <button onClick={() => replaceRef.current?.click()}>Replace {l.type}…</button>
          <input ref={replaceRef} type="file" accept={l.type === "image" ? "image/*" : "video/*"} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onReplace(f); e.target.value = ""; }} />
          {l.type === "video" && <p className="muted" style={{ fontSize: 12 }}>Videos play over the show (with transparency if the file has it) and loop while the overlay is up.</p>}
        </>
      )}
      <OnScreen l={l} set={set} timedMode={timedMode} showMs={showMs} />
      <AnimProps l={l} set={set} />
      <label>Layer opacity: {l.opacity ?? 100}%<input type="range" min={0} max={100} value={l.opacity ?? 100} onChange={(e) => set({ opacity: Number(e.target.value) })} /></label>
      <details>
        <summary className="muted">Position & size</summary>
        <div className="ov-grid2">{n("x", "X", -AW)}{n("y", "Y", -AH)}</div>
        <div className="ov-grid2">{n("w", "Width", 1)}{n("h", "Height", 1)}</div>
        <div className="ov-seg" style={{ marginTop: 6 }}>
          <button onClick={() => set({ x: Math.round((AW - l.w) / 2) })}>Centre across</button>
          <button onClick={() => set({ y: Math.round((AH - l.h) / 2) })}>Centre down</button>
        </div>
      </details>
    </div>
  );
}

/** Find the video in the library that sets off a "when a video plays" overlay. */
function MediaPicker({ onPick, onCancel }: { onPick: (m: OverlayMedia) => void; onCancel?: () => void }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ items: SearchItem[]; total: number; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!q.trim()) { setRes(null); return; }
    const h = setTimeout(() => { api.browseSearch(q.trim(), 0, 25).then((r) => setRes({ items: r.items ?? [], total: r.total ?? 0, error: r.error })).catch((e) => setRes({ items: [], total: 0, error: String(e.message ?? e) })); }, 300);
    return () => clearTimeout(h);
  }, [q]);
  const pick = async (it: SearchItem) => {
    setBusy(true); setErr("");
    try {
      const d = await api.browseDetail(it.type, it.id);
      if (!d?.path) throw new Error("The library doesn't have a file for that item.");
      onPick({ path: d.path, title: it.showTitle && it.showTitle !== it.title ? `${it.showTitle} — ${it.title}` : it.title, durationMs: it.durationMs || d.durationMs });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="ov-media">
      <div className="row" style={{ gap: 6, alignItems: "center" }}>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find the video in your library — type part of its name" style={{ flex: 1 }} />
        {onCancel && <button className="ghost" onClick={onCancel}>Cancel</button>}
      </div>
      {res?.error && <p className="err" style={{ fontSize: 12 }}>{res.error}</p>}
      {err && <p className="err" style={{ fontSize: 12 }}>{err}</p>}
      {res && !res.error && !res.items.length && <p className="muted" style={{ fontSize: 12 }}>Nothing matches “{q}”.</p>}
      {!!res?.items.length && (
        <div className="ov-media-list">
          {res.items.map((it) => (
            <button key={`${it.type}-${it.id}`} className="ov-media-row" disabled={busy} onClick={() => pick(it)}>
              <span>{it.showTitle && it.showTitle !== it.title ? <><b>{it.showTitle}</b> — {it.title}</> : <b>{it.title}</b>}{it.year ? ` (${it.year})` : ""}</span>
              <span className="muted">{it.type.replace(/_/g, " ")} · {clock(it.durationMs / 1000).replace(/\.\d+$/, "")}</span>
            </button>
          ))}
          {res.total > res.items.length && <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>{res.total} matches; type more to narrow it down.</p>}
        </div>
      )}
      {!q && <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>Pick the video this overlay goes over. It comes up behind the canvas so you can line things up with it.</p>}
    </div>
  );
}

/** When a layer is on screen within each appearance: from N seconds in, for M seconds. */
function OnScreen({ l, set, timedMode, showMs }: { l: Layer; set: (p: Record<string, unknown>) => void; timedMode: boolean; showMs: number }) {
  const a = l.appear ?? {};
  const own = (a.at ?? 0) > 0 || (a.for ?? 0) > 0;
  const upd = (patch: { at?: number; for?: number }) => {
    const next = { ...a, ...patch };
    if (!next.at) delete next.at;
    if (!next.for) delete next.for;
    set({ appear: next.at || next.for ? next : undefined });
  };
  const sec = showMs / 1000;
  const w = layerWindow(l, showMs);
  return (
    <details open={own}>
      <summary className="muted">On screen{own ? ` · ${(w.start / 1000).toFixed(1)}–${(w.end / 1000).toFixed(1)} s` : ""}</summary>
      {!timedMode ? <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>An overlay that's always on has no start or end to time layers against. Choose another “When it shows” to give layers their own time on screen.</p> : (
        <>
          <div className="ov-grid2">
            <label>From (s in)<input type="number" min={0} max={sec} step={0.5} value={a.at ?? 0} onChange={(e) => upd({ at: Math.max(0, Math.min(sec, Number(e.target.value))) })} /></label>
            <label>For (s)<input type="number" min={0} step={0.5} value={a.for ?? ""} placeholder="to the end" onChange={(e) => upd({ for: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) })} /></label>
          </div>
          <p className="muted" style={{ fontSize: 11, margin: "4px 0 0" }}>Seconds after the overlay appears (it's up for {sec} s). Blank “For” keeps the layer up until the overlay goes off. It comes on and goes off with its own animation below.</p>
          {(a.at ?? 0) >= sec && <p className="warn" style={{ fontSize: 12, margin: "4px 0 0" }}>That's after the overlay has gone ({sec} s), so this layer never shows.</p>}
        </>
      )}
    </details>
  );
}

/** Each layer's time on screen within one appearance, with the preview's playhead. */
function Timeline({ layers, showMs, t, sel, onSelect }: { layers: Layer[]; showMs: number; t: number | null; sel: number | null; onSelect: (i: number) => void }) {
  const ticks = Math.max(1, Math.round(showMs / 1000));
  const every = ticks > 30 ? 10 : ticks > 12 ? 5 : ticks > 6 ? 2 : 1;
  const name = (l: Layer) => (l.type === "text" ? (l.text || "Text").replace(/\s+/g, " ") : (l.type === "image" || l.type === "video") && l.src.startsWith(MATCH_PREFIX) ? `Picture by ${l.src.slice(MATCH_PREFIX.length)}` : LAYER_LABEL[l.type]);
  return (
    <div className="ov-timeline" title="When each layer is on screen during the overlay. Set it per layer under On screen.">
      <div className="ov-tl-row ov-tl-scale">
        <span className="ov-tl-name muted">Seconds</span>
        <div className="ov-tl-track">
          {Array.from({ length: Math.floor(ticks / every) + 1 }, (_, k) => k * every).map((s) => <span key={s} className="ov-tl-tick" style={{ left: `${(s * 1000 / showMs) * 100}%` }}>{s}</span>)}
        </div>
      </div>
      {layers.map((l, i) => ({ l, i })).reverse().map(({ l, i }) => {
        const w = layerWindow(l, showMs);
        return (
          <div key={i} className={`ov-tl-row${sel === i ? " sel" : ""}`} onClick={() => onSelect(i)}>
            <span className="ov-tl-name">{name(l).slice(0, 26)}</span>
            <div className="ov-tl-track">
              <div className={`ov-tl-bar${w.start > 0 || w.own ? " own" : ""}`} style={{ left: `${(w.start / showMs) * 100}%`, width: `${Math.max(0.5, ((w.end - w.start) / showMs) * 100)}%` }} />
            </div>
          </div>
        );
      })}
      {t != null && <div className="ov-tl-head" style={{ left: `calc(var(--tl-name) + (100% - var(--tl-name) - 16px) * ${t / showMs})` }} />}
    </div>
  );
}

/** A layer's in / out animation: what it does, how long, after how long, and the feel. */
function AnimProps({ l, set }: { l: Layer; set: (p: Record<string, unknown>) => void }) {
  const a: LayerAnim = l.anim ?? {};
  const step = (k: "in" | "out", patch: Partial<AnimStep>) => {
    const cur: AnimStep = a[k] ?? { type: "none" };
    const next = { ...cur, ...patch };
    const anim: LayerAnim = { ...a, [k]: next.type === "none" ? undefined : next };
    set({ anim: anim.in || anim.out ? anim : undefined });
  };
  const row = (k: "in" | "out", label: string) => {
    const st = a[k] ?? { type: "none" as const };
    return (
      <div className="ov-anim-row">
        <label>{label}
          <select value={st.type} onChange={(e) => step(k, { type: e.target.value as AnimStep["type"] })}>
            {ANIM_TYPES.filter((t) => !t.textOnly || l.type === "text").map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
        {st.type !== "none" && (
          <div className="ov-grid3">
            <label>Length (s)<input type="number" min={0.1} step={0.1} value={Math.round((st.duration ?? 0.5) * 100) / 100} onChange={(e) => step(k, { duration: Number(e.target.value) })} /></label>
            <label>Delay (s)<input type="number" min={0} step={0.05} value={Math.round((st.delay ?? 0) * 100) / 100} onChange={(e) => step(k, { delay: Number(e.target.value) })} /></label>
            <label>Feel<select value={st.ease ?? (st.type === "pop" ? "bounce" : "smooth")} onChange={(e) => step(k, { ease: e.target.value as AnimStep["ease"] })}>{EASES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
          </div>
        )}
      </div>
    );
  };
  return (
    <details open={!!(a.in || a.out)}>
      <summary className="muted">Animation</summary>
      {row("in", "Comes on")}
      {row("out", "Goes off")}
      <p className="muted" style={{ fontSize: 11, margin: "4px 0 0" }}>Delay staggers layers: e.g. the box wipes open, then the text slides in 0.3 s later.</p>
    </details>
  );
}
