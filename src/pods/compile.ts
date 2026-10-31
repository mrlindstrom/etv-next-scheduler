// -----------------------------------------------------------------------------
// Pod compiler: authoring pods -> engine constructs (content / sequence / pods)
// -----------------------------------------------------------------------------
// Produces a loose object in the legacy-YAML shape ({ content, sequence, pods })
// that loadPlayout() consumes, plus emitYaml() to render it as a channel file.

import { stringify } from "yaml";
import type {
  Pod, ContentSource, BreakPodConfig, FillerPodConfig, ShowPodConfig,
} from "./model.js";
import { podKey } from "./model.js";
import { parseCollectionRef, collectionContentField } from "../collection-ref.js";

type Dict = Record<string, any>;
export interface CompiledDoc { content: Dict[]; sequence: Dict[]; pods: Dict[]; }

/** Show context available at compile time (from the scheduler / show pod). */
export interface PodCtx { showTitle?: string; nextShowTitle?: string; nextShowKey?: string; }

/** Build a search query from a structured ContentSource pick. `ctx` supplies the
 *  current/next show titles used to resolve show_bumper / next_bumper sources. */
export function sourceQuery(src: ContentSource, ctx?: PodCtx): string {
  if (src.kind === "query") return (src.query ?? "").trim();
  if (src.kind === "show_bumper" || src.kind === "next_bumper") {
    const title = src.kind === "show_bumper" ? ctx?.showTitle : ctx?.nextShowTitle;
    const parts = [`type:${src.type || "other_video"}`, `title:"${src.phrase ?? ""}"`];
    if (title) parts.push(`title:"${title}"`);
    return parts.join(" AND ");
  }
  const parts: string[] = [];
  if (src.kind === "show") { parts.push(`type:${src.type || "episode"}`); parts.push(`show_title:"${src.value ?? ""}"`); }
  else if (src.kind === "library") { parts.push(`library_name:"${src.value ?? ""}"`); if (src.type) parts.push(`type:${src.type}`); }
  const lo = src.minMinutes, hi = src.maxMinutes;
  if (lo != null || hi != null) parts.push(`minutes:[${lo ?? 0} TO ${hi ?? "*"}]`);
  return parts.join(" AND ");
}

/** Extract a show title from a raw query's show_title: term (for context). */
function extractShowTitle(query?: string): string | undefined {
  if (!query) return undefined;
  const m = query.match(/show_title:"([^"]+)"/i) ?? query.match(/show_title:(\S+)/i);
  return m?.[1];
}

/** The show title a Show pod plays (for "next show" bumper context). */
export function podShowTitle(pod: Pod): string | undefined {
  if (pod.type !== "show") return undefined;
  const c = pod.config as ShowPodConfig;
  return c.show?.kind === "show" ? c.show.value : extractShowTitle(c.show?.query);
}

export class Compiler {
  content: Dict[] = [];
  sequence: Dict[] = [];
  pods: Dict[] = [];
  /** Top-level entry ref per pod id (what a playout references to run it). */
  top = new Map<string, { kind: "sequence" | "pod"; key: string }>();
  private byId = new Map<string, Pod>();
  private sigToKey = new Map<string, string>();
  private used = new Set<string>();
  private cache = new Map<string, any>();

  constructor(pods: Pod[]) { for (const p of pods) this.byId.set(p.id, p); }

  /** Does a break pod's lead-in/out/body depend on the current show's title? */
  private usesShowCtx(p: Pod): boolean {
    if (p.type !== "break") return false;
    const c = p.config as BreakPodConfig;
    return c.leadIn?.kind === "show_bumper" || c.leadOut?.kind === "show_bumper" || (c.body as any)?.kind === "show_bumper";
  }
  /** Does a show pod's up-next bumper depend on the NEXT scheduled show's title? */
  private usesNextCtx(p: Pod): boolean {
    return p.type === "show" && (p.config as ShowPodConfig).upNext?.kind === "next_bumper";
  }

  private unique(hint: string): string {
    let k = podKey(hint) || "K";
    if (!this.used.has(k)) { this.used.add(k); return k; }
    let i = 2; while (this.used.has(`${k}_${i}`)) i++;
    k = `${k}_${i}`; this.used.add(k); return k;
  }

  /** Add (or reuse) a content def for a source; returns its content key. `peek`
   *  wires a `${next_show_title}` bumper to the next lineup slot's show content. */
  private sourceKey(src: ContentSource | undefined, hint: string, ctx?: { showTitle?: string; nextShowTitle?: string }, peek?: string): string | undefined {
    if (!src) return undefined;
    const order = src.order ?? "shuffle";
    const isCollection = src.kind === "collection";
    const q = sourceQuery(src, ctx);
    const sig = JSON.stringify([src.kind, isCollection ? src.value : q, order, peek ?? ""]);
    const existing = this.sigToKey.get(sig);
    if (existing) return existing;
    const key = this.unique(hint);
    this.sigToKey.set(sig, key);
    if (isCollection) {
      const { type, name } = parseCollectionRef(src.value ?? "");
      this.content.push({ [collectionContentField(type)]: name, key, order, ...(peek ? { peek } : {}) });
    } else this.content.push({ search: null, key, query: q, order, ...(peek ? { peek } : {}) });
    return key;
  }

  /** The content key a show pod's program resolves to (for peek/next-show wiring). */
  showContentKey(pod: Pod): string | undefined {
    if (pod.type !== "show") return undefined;
    const c = pod.config as ShowPodConfig;
    return this.sourceKey({ ...c.show, order: c.order ?? c.show.order }, podKey(pod.id));
  }

  compileAll(): CompiledDoc {
    for (const p of this.byId.values()) this.compilePod(p);
    return { content: this.content, sequence: this.sequence, pods: this.pods };
  }

  compilePod(p: Pod, ctx?: PodCtx) {
    const showCtx = ctx?.showTitle && this.usesShowCtx(p) ? ctx.showTitle : undefined;
    const nextCtx = ctx?.nextShowTitle && this.usesNextCtx(p) ? ctx.nextShowTitle : undefined;
    // When the next show has no single static title (a collection/library),
    // wire the up-next bumper to peek that slot's program at build time.
    const nextKey = !nextCtx && ctx?.nextShowKey && this.usesNextCtx(p) ? ctx.nextShowKey : undefined;
    const cacheId = p.id + (showCtx ? `::s=${showCtx}` : "") + (nextCtx ? `::n=${nextCtx}` : "") + (nextKey ? `::nk=${nextKey}` : "");
    if (this.cache.has(cacheId)) return this.cache.get(cacheId)!;
    let r;
    if (p.type === "break") r = this.compileBreak(p, showCtx);
    else if (p.type === "filler") r = this.compileFiller(p);
    else r = this.compileShow(p, nextCtx, nextKey);
    this.cache.set(cacheId, r);
    return r;
  }

  private compileBreak(p: Pod, showTitle?: string): { kind: "sequence" | "pod"; key: string } {
    const c = p.config as BreakPodConfig;
    const base = showTitle ? podKey(`${showTitle}_${p.id}`) : podKey(p.id);
    const ctx = { showTitle };
    const leadIn = this.sourceKey(c.leadIn, `${base}_BE_BACK`, ctx);
    const body = this.sourceKey(c.body, `${base}_COMMERCIALS`, ctx)!;
    const leadOut = this.sourceKey(c.leadOut, `${base}_BACK_TO`, ctx);
    if (c.target) {
      const slots: Dict[] = [];
      if (leadIn) slots.push({ content: leadIn, count: 1 });
      slots.push({ content: body, fill: true, ...(c.noRepeat ? { no_repeat: c.noRepeat } : {}) });
      if (leadOut) slots.push({ content: leadOut, count: 1 });
      const key = this.unique(`${base}`);
      this.pods.push({ key, target: c.target, tolerance: c.tolerance ?? "15 seconds", slots });
      if (!showTitle) this.top.set(p.id, { kind: "pod", key });
      return { kind: "pod", key };
    }
    const items: Dict[] = [];
    if (leadIn) items.push({ count: 1, content: leadIn });
    items.push({ count: c.bodyCount ?? 4, content: body });
    if (leadOut) items.push({ count: 1, content: leadOut });
    const key = this.unique(`${base}`);
    this.sequence.push({ key, items });
    if (!showTitle) this.top.set(p.id, { kind: "sequence", key });
    return { kind: "sequence", key };
  }

  private compileFiller(p: Pod): { kind: "filler"; contentKey: string; align?: number; fillerKind?: string } {
    const c = p.config as FillerPodConfig;
    const base = podKey(p.id);
    const contentKey = this.sourceKey(c.content, `${base}`)!;
    // A standalone sequence so the filler pod is previewable on its own.
    const items: Dict[] = c.align
      ? [{ pad_to_next: c.align, content: contentKey, filler_kind: c.fillerKind ?? "postroll", trim: c.trim ?? true }]
      : [{ count: c.count ?? 1, content: contentKey, filler_kind: c.fillerKind ?? "postroll" }];
    const seqKey = this.unique(`${base}_SEQ`);
    this.sequence.push({ key: seqKey, items });
    this.top.set(p.id, { kind: "sequence", key: seqKey });
    return { kind: "filler", contentKey, align: c.align, fillerKind: c.fillerKind };
  }

  private compileShow(p: Pod, nextShowTitle?: string, nextShowKey?: string): { kind: "sequence"; key: string } {
    const c = p.config as ShowPodConfig;
    const base = nextShowTitle ? podKey(`${p.id}_TO_${nextShowTitle}`) : podKey(p.id);
    const showKey = this.sourceKey({ ...c.show, order: c.order ?? c.show.order }, `${base}`)!;
    // Static title for a single show; otherwise a runtime placeholder so the
    // break's be-back/back-to match whatever program (from a collection/library)
    // is actually airing.
    const showTitle = (c.show?.kind === "show" ? c.show.value : extractShowTitle(c.show?.query)) || "${show_title}";
    const items: Dict[] = [];
    const epg = c.epgGroup !== false;
    if (epg) items.push({ epg_group: true });

    (c.preroll ?? []).forEach((s, i) => {
      const k = this.sourceKey(s, `${base}_PRE_${i + 1}`);
      if (k) items.push({ count: s.count ?? 1, content: k, filler_kind: "preroll" });
    });

    let midRef: { kind: "sequence" | "pod"; key: string } | undefined;
    if (c.midRoll?.breakPodId && this.byId.has(c.midRoll.breakPodId)) {
      const compiled = this.compilePod(this.byId.get(c.midRoll.breakPodId)!, { showTitle });
      if (compiled && (compiled.kind === "sequence" || compiled.kind === "pod")) midRef = compiled;
    }
    if (midRef) {
      const mr: Dict = { mid_roll: true, [midRef.kind]: midRef.key };
      const m = c.midRoll!;
      if (m.expression) mr.expression = m.expression;
      else {
        mr.mode = m.mode ?? "chapters";
        if (m.mode === "interval" && m.interval) mr.interval = m.interval;
        if (m.breaks) mr.breaks = m.breaks;
      }
      if (m.minSegment) mr.min_segment = m.minSegment;
      items.push(mr);
    }

    items.push({ count: 1, content: showKey });
    if (midRef) items.push({ mid_roll: false });

    (c.postroll ?? []).forEach((s, i) => {
      const k = this.sourceKey(s, `${base}_POST_${i + 1}`);
      if (k) items.push({ count: s.count ?? 1, content: k, filler_kind: "postroll" });
    });
    if (c.upNext) {
      // Prefer a static next title; otherwise (collection/library next slot) use
      // a runtime placeholder that peeks the next slot's program.
      let upNextTitle = nextShowTitle;
      let peek: string | undefined;
      if (!upNextTitle && nextShowKey && c.upNext.kind === "next_bumper") { upNextTitle = "${next_show_title}"; peek = nextShowKey; }
      const k = this.sourceKey(c.upNext, `${base}_UP_NEXT`, { showTitle, nextShowTitle: upNextTitle }, peek);
      if (k) items.push({ count: 1, content: k, filler_kind: "postroll" });
    }

    // Tail padding to the clock boundary.
    let tailSrc = c.tailFiller;
    let align = c.align;
    if (!tailSrc && c.tailFillerPodId && this.byId.has(c.tailFillerPodId)) {
      const fp = this.byId.get(c.tailFillerPodId)!.config as FillerPodConfig;
      tailSrc = fp.content; if (align == null) align = fp.align;
    }
    if (align && tailSrc) {
      const k = this.sourceKey(tailSrc, `${base}_TAIL`)!;
      items.push({ pad_to_next: align, content: k, filler_kind: "postroll", trim: c.trimTail !== false });
    }

    if (epg) items.push({ epg_group: false });
    const key = this.unique(`${base}_SEQ`);
    this.sequence.push({ key, items });
    if (!nextShowTitle) this.top.set(p.id, { kind: "sequence", key });
    return { kind: "sequence", key };
  }
}

/** Compile a set of pods into engine constructs. */
export function compilePods(pods: Pod[]): CompiledDoc {
  return new Compiler(pods).compileAll();
}

/** Compile, also returning each pod's top-level entry ref (for preview/scheduling). */
export function compilePodsDetailed(pods: Pod[]): { doc: CompiledDoc; entry: Map<string, { kind: "sequence" | "pod"; key: string }> } {
  const c = new Compiler(pods);
  const doc = c.compileAll();
  return { doc, entry: c.top };
}

/** The top-level sequence key a show pod compiles to (for scheduling/preview). */
export function showPodSequenceKey(pod: Pod): string {
  return podKey(`${pod.id}_SEQ`);
}

/** Render a compiled doc (optionally with a playout/dayparts) as channel YAML. */
export function emitYaml(doc: CompiledDoc & { playout?: Dict[]; dayparts?: Dict[]; reset?: Dict[] }): string {
  const out: Dict = {};
  if (doc.content.length) out.content = doc.content;
  if (doc.sequence.length) out.sequence = doc.sequence;
  if (doc.pods.length) out.pods = doc.pods;
  if (doc.reset?.length) out.reset = doc.reset;
  if (doc.dayparts?.length) out.dayparts = doc.dayparts;
  if (doc.playout?.length) out.playout = doc.playout;
  return stringify(out, { lineWidth: 0 });
}
