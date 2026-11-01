// -----------------------------------------------------------------------------
// Overlay animations: how each layer looks at a moment of its in / out
// transition. Pure maths with no Node imports, shared by the build's frame
// renderer (overlays.ts) and the designer's live preview (web), so what you
// preview is what airs.
// -----------------------------------------------------------------------------
export type AnimType =
  | "none" | "fade"
  | "wipe_left" | "wipe_right" | "wipe_up" | "wipe_down" | "expand" | "expand_v"
  | "slide_left" | "slide_right" | "slide_up" | "slide_down"
  | "fly_left" | "fly_right" | "fly_up" | "fly_down"
  | "pop" | "zoom" | "typewriter";
export type Ease = "smooth" | "snappy" | "bounce" | "linear";
export interface AnimStep { type: AnimType; duration?: number; delay?: number; ease?: Ease } // seconds
export interface LayerAnim { in?: AnimStep; out?: AnimStep }

/** Labels for the designer (in: "from", out: "to" — the same motion, reversed). */
export const ANIM_TYPES: { id: AnimType; label: string; textOnly?: boolean }[] = [
  { id: "none", label: "None (just appear)" },
  { id: "fade", label: "Fade" },
  { id: "wipe_left", label: "Wipe — left edge" },
  { id: "wipe_right", label: "Wipe — right edge" },
  { id: "wipe_up", label: "Wipe — bottom edge" },
  { id: "wipe_down", label: "Wipe — top edge" },
  { id: "expand", label: "Expand — from the middle (sideways)" },
  { id: "expand_v", label: "Expand — from the middle (up/down)" },
  { id: "slide_left", label: "Slide — from the left" },
  { id: "slide_right", label: "Slide — from the right" },
  { id: "slide_up", label: "Slide — from below" },
  { id: "slide_down", label: "Slide — from above" },
  { id: "fly_left", label: "Fly — off the left of the screen" },
  { id: "fly_right", label: "Fly — off the right of the screen" },
  { id: "fly_up", label: "Fly — off the bottom of the screen" },
  { id: "fly_down", label: "Fly — off the top of the screen" },
  { id: "pop", label: "Pop (springy grow)" },
  { id: "zoom", label: "Zoom (settle in)" },
  { id: "typewriter", label: "Typewriter (text)", textOnly: true },
];
export const EASES: { id: Ease; label: string }[] = [
  { id: "smooth", label: "Smooth" }, { id: "snappy", label: "Snappy" }, { id: "bounce", label: "Bounce" }, { id: "linear", label: "Linear" },
];

const AW = 1920, AH = 1080;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
function ease(e: Ease | undefined, p: number): number {
  switch (e) {
    case "linear": return p;
    case "snappy": return p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
    case "bounce": { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); }
    default: return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  }
}
const stepMs = (s?: AnimStep) => (s && s.type !== "none" ? Math.max(0, (s.delay ?? 0) + (s.duration ?? 0.5)) * 1000 : 0);

interface Geo { x: number; y: number; w: number; h: number; type: string; anim?: LayerAnim }
/** How long the whole overlay takes to come in / go out (the slowest layer). */
export function animLengths(layers: Geo[]): { inMs: number; outMs: number } {
  return { inMs: Math.max(0, ...layers.map((l) => stepMs(l.anim?.in))), outMs: Math.max(0, ...layers.map((l) => stepMs(l.anim?.out))) };
}
export const isAnimated = (layers: Geo[]) => layers.some((l) => (l.anim?.in && l.anim.in.type !== "none") || (l.anim?.out && l.anim.out.type !== "none"));

export interface LayerState {
  opacity: number; dx: number; dy: number; scale: number;
  clip: { x: number; y: number; w: number; h: number } | null; // artboard coordinates
  chars: number;    // typewriter: the share of the text shown (0..1)
}
export const FULL: LayerState = { opacity: 1, dx: 0, dy: 0, scale: 1, clip: null, chars: 1 };

/** A layer's look `tMs` into the overlay's "in" (or "out") transition. */
export function layerState(l: Geo, phase: "in" | "out", tMs: number): LayerState {
  const s = phase === "in" ? l.anim?.in : l.anim?.out;
  if (!s || s.type === "none") return FULL;
  const dur = Math.max(1, (s.duration ?? 0.5) * 1000), q = clamp01((tMs - (s.delay ?? 0) * 1000) / dur);
  const e = s.type === "pop" && !s.ease ? ease("bounce", q) : ease(s.ease, q);
  const p = phase === "in" ? e : 1 - e;          // 1 = fully on screen
  const lin = phase === "in" ? q : 1 - q;          // un-eased, for fades
  const { x, y, w, h } = l;
  const st: LayerState = { opacity: 1, dx: 0, dy: 0, scale: 1, clip: null, chars: 1 };
  const D = Math.min(140, h * 0.6 + 24), DX = Math.min(220, w * 0.3 + 30);
  switch (s.type) {
    case "fade": st.opacity = lin; break;
    case "wipe_left": st.clip = { x, y, w: w * p, h }; break;
    case "wipe_right": st.clip = { x: x + w * (1 - p), y, w: w * p, h }; break;
    case "wipe_up": st.clip = { x, y: y + h * (1 - p), w, h: h * p }; break;
    case "wipe_down": st.clip = { x, y, w, h: h * p }; break;
    case "expand": st.clip = { x: x + (w * (1 - p)) / 2, y, w: w * p, h }; break;
    case "expand_v": st.clip = { x, y: y + (h * (1 - p)) / 2, w, h: h * p }; break;
    case "slide_left": st.dx = -(1 - p) * DX; st.opacity = clamp01(lin * 1.6); break;
    case "slide_right": st.dx = (1 - p) * DX; st.opacity = clamp01(lin * 1.6); break;
    case "slide_up": st.dy = (1 - p) * D; st.opacity = clamp01(lin * 1.6); break;
    case "slide_down": st.dy = -(1 - p) * D; st.opacity = clamp01(lin * 1.6); break;
    case "fly_left": st.dx = -(1 - p) * (x + w); break;
    case "fly_right": st.dx = (1 - p) * (AW - x); break;
    case "fly_up": st.dy = (1 - p) * (AH - y); break;
    case "fly_down": st.dy = -(1 - p) * (y + h); break;
    case "pop": st.scale = Math.max(0.01, 0.35 + 0.65 * p); st.opacity = clamp01(lin * 2.5); break;
    case "zoom": st.scale = 1.25 - 0.25 * p; st.opacity = lin; break;
    case "typewriter": st.chars = l.type === "text" ? p : 1; if (l.type !== "text") st.opacity = lin; break;
  }
  return st;
}

/** The artboard box a layer covers in a given state (null = nothing visible). */
export function stateBox(l: Geo, st: LayerState): { x: number; y: number; w: number; h: number } | null {
  if (st.opacity <= 0.001 || st.chars <= 0) return null;
  const w = l.w * st.scale, h = l.h * st.scale;
  let b = { x: l.x + (l.w - w) / 2 + st.dx, y: l.y + (l.h - h) / 2 + st.dy, w, h };
  if (st.clip) {
    const x0 = Math.max(b.x, st.clip.x), y0 = Math.max(b.y, st.clip.y);
    const x1 = Math.min(b.x + b.w, st.clip.x + st.clip.w), y1 = Math.min(b.y + b.h, st.clip.y + st.clip.h);
    if (x1 <= x0 || y1 <= y0) return null;
    b = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  return b;
}

// ---- ready-made styles (applied to every layer, staggered) ----------------------
export type AnimStyle = "none" | "broadcast" | "fade" | "slide" | "fly" | "pop" | "expand";
export const ANIM_STYLES: { id: AnimStyle; label: string; desc: string }[] = [
  { id: "broadcast", label: "Broadcast", desc: "Boxes wipe open, then text slides up; reverses on the way out" },
  { id: "expand", label: "Expand", desc: "Boxes grow from the middle, text fades in" },
  { id: "slide", label: "Slide", desc: "Everything slides in from the left, one after another" },
  { id: "fly", label: "Fly in", desc: "Flies in from the side of the screen and back out" },
  { id: "pop", label: "Pop", desc: "Springy pop-in, quick fade out" },
  { id: "fade", label: "Fade", desc: "A soft fade in and out" },
  { id: "none", label: "No animation", desc: "Appears and disappears (with the fade setting)" },
];
export function applyAnimStyle<T extends Geo>(layers: T[], style: AnimStyle): T[] {
  let box = 0, txt = 0, img = 0;
  return layers.map((l) => {
    const k = l.type === "box" ? box++ : l.type === "text" ? txt++ : img++;
    let anim: LayerAnim | undefined;
    switch (style) {
      case "broadcast":
        anim = l.type === "box"
          ? { in: { type: "wipe_left", duration: 0.5, delay: k * 0.08 }, out: { type: "wipe_left", duration: 0.4, delay: 0.2 + k * 0.05 } }
          : l.type === "text"
            ? { in: { type: "slide_up", duration: 0.45, delay: 0.3 + k * 0.1, ease: "snappy" }, out: { type: "fade", duration: 0.25, delay: k * 0.04 } }
            : { in: { type: "pop", duration: 0.5, delay: 0.25 + k * 0.08 }, out: { type: "fade", duration: 0.25 } };
        break;
      case "expand":
        anim = l.type === "box"
          ? { in: { type: "expand", duration: 0.5, delay: k * 0.06 }, out: { type: "expand", duration: 0.4, delay: 0.15 } }
          : { in: { type: "fade", duration: 0.4, delay: 0.35 + k * 0.08 }, out: { type: "fade", duration: 0.2 } };
        break;
      case "slide": { const i = box + txt + img - 1; anim = { in: { type: "slide_left", duration: 0.45, delay: i * 0.07, ease: "snappy" }, out: { type: "slide_left", duration: 0.35, delay: 0 } }; break; }
      case "fly": anim = { in: { type: "fly_left", duration: 0.6, delay: k * 0.05, ease: "snappy" }, out: { type: "fly_left", duration: 0.5 } }; break;
      case "pop": anim = { in: { type: "pop", duration: 0.5, delay: (box + txt + img - 1) * 0.06 }, out: { type: "fade", duration: 0.25 } }; break;
      case "fade": anim = { in: { type: "fade", duration: 0.4 }, out: { type: "fade", duration: 0.4 } }; break;
      default: anim = undefined;
    }
    const next = { ...l };
    if (anim) next.anim = anim; else delete next.anim;
    return next;
  });
}
