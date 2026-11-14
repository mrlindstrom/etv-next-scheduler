// -----------------------------------------------------------------------------
// Scheduling engine: execute a legacy YAML playout into a "next" playout timeline
// -----------------------------------------------------------------------------
// Faithful to the legacy semantics that matter for broadcast feel:
//  - sequences, count, duration, pad_to_next / pad_until
//  - epg groups, graphics/watermark on-off, pre-roll
//  - CHAPTER-BASED MID-ROLL: split an episode at chapter markers and insert a
//    break "pod" (any sequence) when the mid-roll expression says so.

import type { MediaItem, PlayoutItem, Watermark, LocalSource, GraphicsLayer } from "./model.js";
import type { AssLayout } from "./upnext-ass.js";
import { PLAYOUT_VERSION, PLAYOUT_VERSION_GRAPHICS } from "./model.js";
import type { OverlayBuildOptions } from "./overlays.js";
import type { ContentDef, Instruction, PlayoutDoc, FillerKind } from "./yaml.js";
import { Enumerator, PlaylistEnumerator, type ContentResolver } from "./resolver.js";

/** A content cursor: a plain list, or a playlist stepping through its entries. */
type Cursor = Enumerator | PlaylistEnumerator;
import { groupSegments } from "./segments.js";
import { evalExpression } from "./expr.js";
import {
  parseDurationMs, formatRfc3339, nextTimeOfDay, nextMinuteBoundary, onMinuteBoundary, localParts, localToEpoch,
  localWeekday, floorLocalMidnight, localToEpochAll, type Tz } from "./time.js";
import type { Daypart, DateSpec, DateRange } from "./yaml.js";
import { holidayDate } from "./holidays.js";

export interface BuildOptions {
  startMs: number;
  finishMs: number;
  tz: Tz;   // fixed UTC offset for wall-clock math (e.g. -300 = EST)
  seed?: number;
  maxItems?: number;   // safety cap
  progress?: Record<string, number>; // per-content-key resume cursors (no-repeat across builds)
  preferredAudioLang?: string;    // ISO 639-2 default audio language for this channel
  subtitles?: string; // English subtitles, burned in: "off" | "on" | "forced" (foreign dialog only)
  /** When set, emit a full-screen "coming up next" graphics-canvas card at the
   *  end of each grid-aligned break (see UpNextOptions). Omit to disable. */
  upNext?: UpNextOptions;
  /** The overlay library and this channel's own overlays (see overlays.ts). */
  overlays?: OverlayBuildOptions;
  /** Progress lines for the build log (slow steps, e.g. drawing overlay clips). */
  log?: (msg: string) => void;
}

/** Config for the live "up next" graphics canvas. The card is a full-frame RGBA
 *  layer streamed by an HTTP endpoint (`{baseUrl}/graphics/upnext`) that reads
 *  the channel's guide and renders the next few programmes (time-only). */
export interface UpNextOptions {
  baseUrl: string;        // e.g. "http://127.0.0.1:8409" (no trailing slash needed)
  channelNumber: string;  // lineup channel number (also sent as x-etv-channel by next)
  channelName?: string;   // the channel's name: what the card looks its guide up by (survives renumbering)
  count: number;          // how many upcoming programmes to list (e.g. 3)
  durationMs: number;     // nominal on-screen duration of the card (e.g. 12000)
  width: number;          // output width (canvas is authored at output size)
  height: number;         // output height
  theme: string;          // card design id (splat | slime | clock | chips)
  audioPath?: string;     // optional background audio/music bed (absolute file path); "" = silent
  textMode?: "image" | "subtitles"; // how the card text is rendered (default "image")
  assLayout?: AssLayout;  // text layout for "subtitles" mode (from the theme, merged with defaults)
  fps?: string;           // primary background frame rate, e.g. "24" (next conforms it)
}

/** A "subtitles"-mode card recorded during build; the .ass (populated from the
 *  guide) is written and attached to the item after the build completes. */
export interface UpNextCard { id: string; anchorMs: number; durationMs: number; count: number; }

interface AddOpts { fillerKind?: FillerKind; contentKey?: string; }

/** Fade-in/out duration (ms) for each up-next graphics layer's native timing. */
const FADE_MS = 600;

/** Non-schema per-item metadata used only by the preview UI (sidecar file). */
export interface ItemLabel { key?: string; fillerKind?: string; type?: string; tags?: string[];
  /** overlays on the item and when each first shows (ms from the item's start; 0 = from the start) */
  overlays?: { id: string; at: number }[]; }

/** One guide (XMLTV) programme: a whole show block spanning its slot. */
export interface GuideEntry { startMs: number; stopMs: number; item: MediaItem; }

interface MidRollState {
  sequence?: string; pod?: string; expression?: string;
  mode: "chapters" | "interval" | "count";
  intervalMs?: number; breaks?: number; fallback: "chapters" | "interval" | "count" | "none";
  minSegmentMs: number;
}

export class SchedulingEngine {
  private items: PlayoutItem[] = [];
  private nowMs: number;
  private idSeq = 0;
  private enumerators = new Map<string, Cursor>();
  private contentByKey = new Map<string, ContentDef>();
  private activeGraphics: string[] = [];
  private activeWatermarks: string[] = [];
  private preRoll: { content: string; count: number } | null = null;
  private midRoll: MidRollState | null = null;
  private inMidRollBreak = false;
  private lastPlayed = new Map<string, number>(); // item id -> wall-clock ms last aired (no-repeat)
  private slotEndMs: number | null = null; // wall-clock deadline for the current block (grid slot)
  /** Aligned count with stretchBreaks: one slot's length. A show longer than this (it
   *  takes two or more slots) spreads the spare time through its breaks. */
  private stretchUnitMs: number | null = null;
  private currentShowTitle: string | undefined; // the airing program's show title (for ${show_title} bumpers)
  private currentShowYear: number | undefined;  // the airing program's year (for era-matched filler)
  private groupDepth = 0;
  // playout item id -> overlays on it (channel overlays + graphics_on/watermark_on
  // elements); turned into graphics layers after the build (see overlays.ts)
  private overlayRefs = new Map<string, string[]>();
  private labels: Record<string, ItemLabel> = {};
  private guide: GuideEntry[] = [];
  private groupStartMs: number | null = null;
  private groupItem: MediaItem | null = null;
  private lastYieldMs = 0; // wall-clock of the last event-loop yield (cooperative)
  private hasExplicitUpNext = false; // doc places up_next itself -> suppress auto end-of-break card
  private upNextCards: UpNextCard[] = []; // subtitles-mode cards to attach an .ass to post-build

  constructor(
    private readonly doc: PlayoutDoc,
    private readonly resolver: ContentResolver,
    private readonly opts: BuildOptions,
  ) {
    this.nowMs = opts.startMs;
    for (const c of doc.content) this.contentByKey.set(c.key, c);
    // If the playout places `up_next` itself, don't also auto-insert a card at
    // the end of each break (that would double it).
    const allItems = [...Object.values(doc.sequences).flatMap((s) => s.items), ...doc.playout];
    // (Cards a module places after unaligned blocks don't count: aligned blocks
    // on the same channel still get their end-of-break card.)
    this.hasExplicitUpNext = allItems.some((i) => i.op === "up_next" && !i.afterProgram);
  }

  async build(): Promise<PlayoutItem[]> {
    // Reset instructions (e.g. wait_until midnight) run first for a fresh build.
    for (const ins of this.doc.reset) await this.exec(ins);

    if (this.doc.dayparts.length) { await this.buildDayparts(); this.flushGuide(); return this.items; }

    // Linear playout: detect a trailing repeat -> loop the body until the window fills.
    const body = this.doc.playout.filter((i) => i.op !== "repeat");
    const repeats = this.doc.playout.some((i) => i.op === "repeat");

    // The leading wait_until(s) anchor the FIRST pass to a wall-clock time (e.g.
    // midnight). On repeat passes we skip them: re-applying a "wait_until 12 AM"
    // after the day ran a little long would jump a full day ahead and dead-air
    // the gap. Skipping lets an overrun slip forward seamlessly instead.
    let lead = 0;
    while (lead < body.length && body[lead].op === "wait_until") lead++;

    let guard = 0;
    let pass = 0;
    do {
      const start = pass === 0 ? 0 : lead;
      for (let k = start; k < body.length; k++) {
        await this.exec(body[k]);
        if (this.done()) break;
      }
      pass++;
      if (++guard > 4000) break; // safety
    } while (repeats && !this.done());

    this.flushGuide();
    return this.items;
  }

  // --- dayparting ------------------------------------------------------------
  /** Build by schedule grid: run whichever daypart's sequence covers the current
   *  local weekday+time, filling each daypart window (soft boundary — an item
   *  that started before the boundary finishes) before re-evaluating. */
  private async buildDayparts(): Promise<void> {
    let outer = 0;
    while (!this.done() && outer++ < 100_000) {
      const now = this.nowMs;
      const rule = this.matchDaypart(now);
      if (!rule) {
        const next = this.nextDaypartStart(now);
        if (next == null) break;                 // nothing ever scheduled
        this.nowMs = Math.max(next, now + 1000); // jump over the gap
        continue;
      }
      const end = Math.min(this.daypartEnd(now, rule), this.opts.finishMs);
      let inner = 0;
      while (this.nowMs < end && !this.done() && inner++ < 20_000) {
        const before = this.nowMs;
        await this.execSequence(rule.sequence, end); // stop at the window edge (soft, between slots)
        if (this.nowMs <= before) break;          // no progress -> avoid infinite loop
      }
      if (this.nowMs <= now) this.nowMs = end;     // safety: always advance
    }
  }

  private matchDaypart(now: number): Daypart | null {
    const p = localParts(now, this.opts.tz);
    const wd = localWeekday(now, this.opts.tz);
    const min = Math.floor(p.msOfDay / 60000);
    const y = p.y, mo = p.mo + 1, day = p.da; // localParts.mo is 0-based
    for (const d of this.doc.dayparts) {
      if (!d.days.includes(wd)) continue;
      if (min < d.fromMin || min >= d.toMin) continue;
      if (!dateMatches(d, y, mo, day)) continue;
      return d;
    }
    return null;
  }

  /** When the *active* daypart changes next (the earliest rule boundary after
   *  `now` at which matchDaypart returns a different rule). Handles catch-all
   *  rules being pre-empted by more specific ones later in the day. */
  private daypartEnd(now: number, rule: Daypart): number {
    const tz = this.opts.tz;
    const p = localParts(now, tz);
    const HORIZON = 8; // days — long enough for holiday blocks / seasonal months
    const cands = new Set<number>();
    // Wall-clock boundaries, every occurrence: a fall-back hour repeats its marks
    // (so a 1:00 slot gets its second airing), and days may be 23 or 25 hours.
    const at = (dayOff: number, min: number) => { for (const t of localToEpochAll(p.y, p.mo, p.da + dayOff, Math.floor(min / 60), min % 60, tz)) cands.add(t); };
    for (let dayOff = 0; dayOff <= HORIZON; dayOff++) {
      at(dayOff, 0); // date boundary (midnight) — matters for date/month rules
      for (const d of this.doc.dayparts) { at(dayOff, d.fromMin); at(dayOff, d.toMin); }
    }
    for (const t of [...cands].sort((a, b) => a - b)) {
      if (t <= now) continue;
      if (this.matchDaypart(t) !== rule) return t;
    }
    return localToEpoch(p.y, p.mo, p.da + HORIZON, 0, 0, tz); // no change within horizon
  }

  private nextDaypartStart(now: number): number | null {
    const tz = this.opts.tz;
    const p = localParts(now, tz);
    for (let dayAdd = 0; dayAdd < 8; dayAdd++) {
      const wd = localWeekday(localToEpoch(p.y, p.mo, p.da + dayAdd, 12, 0, tz), tz);
      let best: number | null = null;
      for (const d of this.doc.dayparts) {
        if (!d.days.includes(wd)) continue;
        for (const start of localToEpochAll(p.y, p.mo, p.da + dayAdd, Math.floor(d.fromMin / 60), d.fromMin % 60, tz)) {
          if (start >= now && (best == null || start < best)) best = start;
        }
      }
      if (best != null) return best;
    }
    return null;
  }

  toPlayout() {
    // Only claim the newer schema when a graphics-canvas layer is actually
    // present, so channels without the up-next card stay maximally compatible.
    const usesGraphics = this.items.some((i) => i.graphics && i.graphics.length > 0);
    const version = usesGraphics ? PLAYOUT_VERSION_GRAPHICS : PLAYOUT_VERSION;
    return { version, generated_at: new Date().toISOString(), items: this.items };
  }

  /** Per-item labels (content key / filler kind / type) for the preview UI. */
  getLabels(): Record<string, ItemLabel> { return this.labels; }

  /** Overlays on each playout item, for applyOverlays (overlays.ts). */
  getOverlayRefs(): Map<string, string[]> { return this.overlayRefs; }

  /** Subtitles-mode up-next cards awaiting an .ass file (filled after build). */
  getUpNextCards(): UpNextCard[] { return this.upNextCards; }

  /** Emit a guide entry for a still-open EPG group. The build loop stops the
   *  instant the window is full (`done()`), which can be mid-slot — before the
   *  final `epg_group: false` runs — so the last program block would otherwise be
   *  missing from the guide, leaving a hole at the window boundary in the EPG. */
  private flushGuide(): void {
    if (this.groupStartMs != null && this.groupItem && this.nowMs > this.groupStartMs) {
      this.guide.push({ startMs: this.groupStartMs, stopMs: this.nowMs, item: this.groupItem });
    }
    this.groupStartMs = null; this.groupItem = null;
  }

  /** Guide programmes (one per EPG-group show block) for XMLTV generation. */
  getGuide(): GuideEntry[] { return this.guide; }

  /** Final per-content-key cursor positions, to persist and resume next build. */
  getProgress(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, e] of this.enumerators) out[k] = e.position;
    return out;
  }

  private done(): boolean {
    return this.nowMs >= this.opts.finishMs || this.items.length >= (this.opts.maxItems ?? 200000);
  }

  // --- instruction dispatch --------------------------------------------------
  private async exec(ins: Instruction): Promise<void> {
    if (this.done()) return;
    switch (ins.op) {
      case "wait_until": {
        this.nowMs = nextTimeOfDay(this.nowMs, ins.when, this.opts.tz, true);
        break;
      }
      case "sequence": await this.execSequence(ins.sequence); break;
      case "epg_group":
        this.groupDepth += ins.value ? 1 : -1;
        if (ins.value) { this.groupStartMs = this.nowMs; this.groupItem = null; }
        else {
          if (this.groupStartMs != null && this.groupItem)
            this.guide.push({ startMs: this.groupStartMs, stopMs: this.nowMs, item: this.groupItem });
          this.groupStartMs = null; this.groupItem = null;
        }
        break;
      case "graphics_on": if (!this.activeGraphics.includes(ins.element)) this.activeGraphics.push(ins.element); break;
      case "graphics_off": this.activeGraphics = this.activeGraphics.filter((g) => g !== ins.element); break;
      case "watermark_on": if (!this.activeWatermarks.includes(ins.element)) this.activeWatermarks.push(ins.element); break;
      case "watermark_off": this.activeWatermarks = this.activeWatermarks.filter((g) => g !== ins.element); break;
      case "pre_roll_on": this.preRoll = { content: ins.content, count: Math.max(1, ins.count ?? 1) }; break;
      case "pre_roll_off": this.preRoll = null; break;
      case "up_next": {
        const u = this.opts.upNext;
        if (!u) break; // feature off / no channel info — nothing to place
        const durMs = ins.duration ? parseDurationMs(ins.duration) : u.durationMs;
        // Anchor the guide lookup on the next show's start: the current slot's
        // grid boundary when known, else the next half-hour. A card straight after
        // a programme lists from its own start instead: the programme's guide
        // entry began earlier, and the next one begins when the card ends.
        const anchor = ins.afterProgram ? this.nowMs : this.slotEndMs ?? nextMinuteBoundary(this.nowMs, 30, this.opts.tz);
        this.emitUpNextCard(this.nowMs, this.nowMs + durMs, anchor, { theme: ins.theme, count: ins.count });
        break;
      }
      case "mid_roll":
        this.midRoll = ins.enabled ? {
          sequence: ins.sequence, pod: ins.pod, expression: ins.expression,
          mode: ins.mode ?? "chapters",
          intervalMs: ins.interval ? parseDurationMs(ins.interval) : undefined,
          breaks: ins.breaks,
          fallback: (ins.fallback ?? "none") as MidRollState["fallback"],
          minSegmentMs: ins.minSegment ? parseDurationMs(ins.minSegment) : 60_000,
        } : null;
        break;
      case "pod": await this.executePod(ins.pod); break;
      case "count": {
        const prevStretch = this.stretchUnitMs;
        this.stretchUnitMs = ins.stretchBreaks && ins.fitMinutes ? ins.fitMinutes * 60_000 : null;
        try { await this.execCount(ins.content, ins.count, { fillerKind: ins.fillerKind }, ins.fitMinutes, ins.fitDiscard); }
        finally { this.stretchUnitMs = prevStretch; }
        break;
      }
      case "duration": await this.execDuration(ins); break;
      case "pad_to_next":
        // already on a mark (a "Play 30 minutes" block that filled itself exactly): nothing
        // to pad — "the next mark" would otherwise be a whole slot away
        if (onMinuteBoundary(this.nowMs, ins.minutes, this.opts.tz)) break;
        await this.execPad(ins.content, nextMinuteBoundary(this.nowMs, ins.minutes, this.opts.tz), { fillerKind: ins.fillerKind }, ins.trim ?? false, ins.discardAttempts ?? 0, true, ins.fallback); break;
      case "pad_until": await this.execPad(ins.content, nextTimeOfDay(this.nowMs, ins.when, this.opts.tz, false), { fillerKind: ins.fillerKind }, ins.trim ?? false, 0, true, ins.fallback); break;
      case "skip_items": { const e = await this.enumerator(ins.content); for (let i = 0; i < ins.count; i++) e.next(); break; }
      case "skip_to_item": { const e = await this.enumerator(ins.content); this.skipTo(e, ins.season, ins.episode); break; }
      case "repeat": break; // handled in build()
    }
  }

  // `boundary` (optional) is a soft deadline checked BETWEEN this sequence's
  // items — used for daypart windows so a lineup longer than its window stops at
  // the window edge (after the current slot finishes) instead of overrunning into
  // the next daypart. It is not propagated into nested sequences, so a slot that
  // has already started always plays to completion.
  private async execSequence(name: string, boundary?: number): Promise<void> {
    const seq = this.doc.sequences[name];
    if (!seq) throw new Error(`Sequence not found: ${name}`);
    // If this sequence is a "block" (ends by padding to a grid boundary), record
    // that boundary as the slot deadline so mid-roll can budget ad breaks to fit.
    const padIns = [...seq.items].reverse().find((i) => i.op === "pad_to_next") as
      Extract<Instruction, { op: "pad_to_next" }> | undefined;
    const prevSlot = this.slotEndMs;
    if (padIns) this.slotEndMs = nextMinuteBoundary(this.nowMs, padIns.minutes, this.opts.tz);
    try {
      for (const ins of seq.items) {
        // soft daypart edge: start nothing new, but still close out the program
        // (pad to its clock mark, end its guide entry) so the next window starts aligned
        if (boundary != null && this.nowMs >= boundary && !isClosingOp(ins)) continue;
        await this.exec(ins);
        if (this.done()) break;
      }
    } finally {
      this.slotEndMs = prevSlot;
    }
  }

  private async execCount(content: string, count: number, opts: AddOpts, fitMinutes?: number, fitDiscard = true): Promise<void> {
    const e = await this.enumerator(content);
    if (e.isEmpty) return;

    // Clock-aligned count: place items that fit the remaining time to the barrier.
    // `fitDiscard` true (default): skip/advance over too-long items to find one
    // that fits (used by the Schedule/blocks module). `fitDiscard` false: PACK mode
    // — play items in order while they fit and STOP at the first that doesn't,
    // never advancing past unplayed items. Pack mode adapts the episode count to
    // length (e.g. two ~12-min episodes or one ~24-min episode per half hour) with
    // no risk of burning through the rotation.
    // Discard mode aligns rather than gates: the first item's slot runs to the
    // first barrier at or after it (with its breaks) ends, however long it is (a
    // 44-minute show on a half-hour grid gets a full hour); further items must
    // fit that slot. See alignedSlotEnd.
    if (fitMinutes && fitMinutes > 0) {
      const off = this.opts.tz;
      let slotEnd: number | undefined = fitDiscard ? undefined : nextMinuteBoundary(this.nowMs, fitMinutes, off);
      const prevSlot = this.slotEndMs;
      this.slotEndMs = slotEnd ?? null; // so mid-roll ads are budgeted to the barrier too
      try {
        for (let i = 0; i < count && !this.done(); i++) {
          let placed = false;
          const maxTries = fitDiscard ? e.size : 1; // pack mode: only consider the next item
          for (let t = 0; t < maxTries; t++) {
            const cand = e.peek();
            if (!cand) break;
            const end = slotEnd ?? this.alignedSlotEnd(cand, fitMinutes);
            if (this.nowMs + cand.durationMs <= end) { slotEnd = this.slotEndMs = end; e.next(); await this.addContent(cand, { ...opts, contentKey: content }); placed = true; break; }
            if (!fitDiscard) {
              // pack mode: the next item is too long for the room left (e.g. a
              // double-length special). Air one of the next few that fits instead
              // and keep the long one next in line for a slot it fits.
              let k = 1;
              while (k <= PACK_LOOKAHEAD && (e.peekAt(k)?.durationMs ?? Infinity) > end - this.nowMs) k++;
              if (k <= PACK_LOOKAHEAD && e.peekAt(k)) { e.promote(k); t--; continue; }
              break;                     // nothing near fits: stop, don't discard the item
            }
            e.next();                    // discard mode: too long — try the next option
          }
          if (!placed) break; // no option fits — end the block, let the pad fill
        }
      } finally { this.slotEndMs = prevSlot; }
      return;
    }

    for (let i = 0; i < count && !this.done(); i++) {
      const item = e.next();
      if (item) await this.addContent(item, { ...opts, contentKey: content });
    }
  }

  /** Where an aligned item's slot ends: the first barrier at or after the show
   *  itself ends (~22 minutes -> 30, ~47 -> 60, 87 -> 90). Breaks never push a
   *  show into another slot; they share whatever room the slot leaves. */
  private alignedSlotEnd(item: MediaItem, minutes: number): number {
    return nextMinuteBoundary(this.nowMs + item.durationMs - 1, minutes, this.opts.tz);
  }

  private async execDuration(ins: Extract<Instruction, { op: "duration" }>): Promise<void> {
    const targetMs = this.nowMs + parseDurationMs(ins.duration);
    await this.fillUntil(ins.content, targetMs, { fillerKind: ins.fillerKind }, ins.trim ?? false, ins.discardAttempts ?? 0, ins.breakSequence);
    // tail filler (legacy TailFiller): whole items for what's left, with no mid-roll
    // breaks inside them; trimmed to the end when there's no fallback to cover the rest
    if (ins.tail && targetMs - this.nowMs >= 1000 && !this.done()) {
      const mr = this.midRoll;
      this.midRoll = null;
      try { await this.fillUntil(ins.tail, targetMs, { fillerKind: "tail" }, !ins.fallback, 0); }
      finally { this.midRoll = mr; }
    }
    await this.fillFallback(ins.fallback, targetMs);
  }

  /** Legacy fallback filler: whatever gap the regular filler couldn't cover
   *  (no item short enough) is filled from `fallback`, looping and trimming the
   *  last item so the boundary is hit exactly. */
  private async fillFallback(fallback: string | undefined, targetMs: number): Promise<void> {
    if (!fallback || targetMs - this.nowMs < 1000 || this.done()) return;
    await this.fillUntil(fallback, targetMs, { fillerKind: "fallback" }, true, 0);
  }

  private async execPad(content: string, targetMs: number, opts: AddOpts, trim: boolean, discard: number, endCard = false, fallback?: string): Promise<void> {
    if (targetMs <= this.nowMs) return;
    await this.execPadFill(content, targetMs, opts, trim, discard, endCard);
    await this.fillFallback(fallback, targetMs);
  }

  private async execPadFill(content: string, targetMs: number, opts: AddOpts, trim: boolean, discard: number, endCard: boolean): Promise<void> {
    // station ID: padding that runs up to the top of the hour ends with the ID
    if (this.doc.stationId && localParts(targetMs, this.opts.tz).msOfDay % 3_600_000 === 0) {
      const ids = await this.enumerator(this.doc.stationId);
      const id = ids.peek();
      if (id && id.durationMs <= 60_000 && targetMs - this.nowMs >= id.durationMs + 1000) {
        await this.execPadFillInner(content, targetMs - id.durationMs, opts, trim, discard, endCard, targetMs);
        await this.addContent(ids.next()!, { ...opts, contentKey: this.doc.stationId, fillerKind: "tail" });
        return;
      }
    }
    await this.execPadFillInner(content, targetMs, opts, trim, discard, endCard, targetMs);
  }

  /** `anchorMs` is the real boundary (the next show's start), which the up-next
   *  card lists from even when the fill stops early for a station ID. */
  private async execPadFillInner(content: string, targetMs: number, opts: AddOpts, trim: boolean, discard: number, endCard: boolean, anchorMs: number): Promise<void> {
    // Grid-safe "up next" card at the START of the final break: the show's credits
    // finish, the card plays, then commercials fill the rest of the break up to the
    // boundary (= the next show's start), so the grid never drifts. The card is
    // anchored on the boundary so it lists what airs next. If the break is too
    // short for a card, just pad normally.
    const u = this.opts.upNext;
    if (endCard && u && !this.hasExplicitUpNext && targetMs - this.nowMs >= 3000) {
      const cardEnd = Math.min(this.nowMs + u.durationMs, targetMs);
      this.emitUpNextCard(this.nowMs, cardEnd, anchorMs);          // card right after the show
      if (targetMs > this.nowMs) await this.fillUntil(content, targetMs, opts, trim, discard); // then the break
      return;
    }
    await this.fillUntil(content, targetMs, opts, trim, discard);
  }

  /** Emit a full-screen "coming up next" card (see upNextItem). */
  private emitUpNextCard(startMs: number, finishMs: number, anchorMs: number, override?: { theme?: string; count?: number }): void {
    const u = this.opts.upNext;
    if (!u || finishMs <= startMs) return;
    const pi = upNextItem(u, String(++this.idSeq), startMs, finishMs, anchorMs, this.opts.tz, override);
    this.items.push(pi);
    this.labels[pi.id] = { fillerKind: "upnext", type: "upnext" };
    // Subtitles mode: the text is attached as a burned .ass after the build (see
    // index.buildChannel), which needs the guide. Record the card so it can be filled in then.
    if (u.textMode === "subtitles") this.upNextCards.push({ id: pi.id, anchorMs, durationMs: finishMs - startMs, count: override?.count ?? u.count });
    this.nowMs = finishMs;
  }

  /** Fill the timeline with `content` until `targetMs`, honoring trim/discard.
   *  Never advances the clock past the content it actually placed — leaving the
   *  clock short (rather than jumping to target) avoids dead air; the following
   *  instruction just continues from where content ended. */
  private async fillUntil(content: string, targetMs: number, opts: AddOpts, trim: boolean, discard: number, breakSequence?: string): Promise<void> {
    const e = await this.enumerator(content);
    if (e.isEmpty) return; // nothing to fill with -> do not create dead air
    // With a break sequence (a block of short cartoons + ads) we let the LAST item
    // overshoot the target rather than stop short and dump a big filler block — the
    // caller sizes the target so `target + one item` still fits the slot.
    const overshoot = !!breakSequence;
    let safety = 0;
    while (this.nowMs < targetMs && !this.done()) {
      if (++safety > 100000) break;
      const remaining = targetMs - this.nowMs;
      let item = e.peek()!;
      if (!overshoot && item.durationMs > remaining) {
        // try to find a shorter item first (discard attempts)
        let tries = 0; let fit = false;
        while (tries < discard) { e.next(); const cand = e.peek()!; tries++; if (cand.durationMs <= remaining) { item = cand; fit = true; break; } }
        if (!fit) {
          if (trim) { const chosen = e.next()!; await this.addSimple(chosen, 0, remaining, { ...opts, contentKey: content }); }
          break; // stop: no room and not trimming
        }
      }
      const chosen = e.next()!;
      await this.addContent(chosen, { ...opts, contentKey: content });
      // Optional commercial break after each item (interleaves ads through a block
      // of short cartoons). Only if there's still room, so the break can't run past
      // the target into the next slot.
      if (breakSequence && this.nowMs < targetMs) await this.execSequence(breakSequence);
    }
    // absorb only sub-second rounding; never manufacture dead air for a shortfall
    if (targetMs - this.nowMs > 0 && targetMs - this.nowMs < 1000) this.nowMs = targetMs;
  }

  // --- adding items ----------------------------------------------------------
  private async addContent(item: MediaItem, opts: AddOpts): Promise<void> {
    // a playlist entry kept out of the guide plays like filler
    const from = opts.contentKey ? this.enumerators.get(opts.contentKey) : undefined;
    if (from instanceof PlaylistEnumerator && !from.lastInGuide && !opts.fillerKind) opts = { ...opts, fillerKind: "postroll" };
    // anything a fixed mid-roll sequence adds is the break, not the show
    if (this.inMidRollBreak && !opts.fillerKind) opts = { ...opts, fillerKind: "midroll" };
    // the first program (episode/movie/music video) inside an EPG group defines its guide entry
    if (this.groupStartMs != null && !this.groupItem && !opts.fillerKind && (item.kind === "episode" || item.kind === "movie" || item.kind === "music_video")) {
      this.groupItem = item;
    }
    // Multi-segment episode (e.g. 1x01 a/b/c): air every segment back-to-back as
    // one block, so the commercial break falls AFTER the whole episode, not
    // between its segments. Fit/guide already treat the group as one item.
    // Pre-roll filler (legacy FillerKind.PreRoll): N items before each program
    // item — never before filler, and never before the pre-roll content itself.
    if (this.preRoll && !opts.fillerKind && opts.contentKey !== this.preRoll.content) {
      const pe = await this.enumerator(this.preRoll.content);
      for (let i = 0; i < this.preRoll.count && !pe.isEmpty && !this.done(); i++) {
        const p = pe.next();
        if (p) await this.addSimple(p, 0, p.durationMs, { contentKey: this.preRoll.content, fillerKind: "preroll" });
      }
    }
    if (item.segments && item.segments.length) {
      const blockStart = this.nowMs;
      for (const seg of item.segments) await this.addSimple(seg, 0, seg.durationMs, opts);
      this.lastPlayed.set(item.id, blockStart); // no-repeat keys on the group id
      return;
    }
    if (this.midRoll && this.breakPoints(item, this.midRoll).length > 0) {
      await this.addWithMidRoll(item, opts, this.midRoll);
    } else {
      await this.addSimple(item, 0, item.durationMs, opts);
    }
  }

  /** Candidate mid-roll break offsets (ms) for an item, per the active mode. */
  private breakPoints(item: MediaItem, mr: MidRollState): number[] {
    const dur = item.durationMs;
    const guard = mr.minSegmentMs;
    let pts: number[];
    const strategy = (mode: MidRollState["mode"] | "none"): number[] => {
      if (mode === "interval" && mr.intervalMs && mr.intervalMs > 0) {
        const out: number[] = [];
        for (let t = mr.intervalMs; t < dur - guard; t += mr.intervalMs) out.push(t);
        return out;
      }
      if (mode === "count" && mr.breaks && mr.breaks > 0) {
        // N breaks per half hour of show: a ~22-minute sitcom gets N, a
        // ~44-minute drama 2N, a 90-minute movie 3N
        const n = mr.breaks * Math.max(1, Math.ceil(dur / 1_800_000));
        const out: number[] = [];
        for (let i = 1; i <= n; i++) out.push(Math.round((dur * i) / (n + 1)));
        return out;
      }
      if (mode === "chapters") return interiorChapters(item);
      return [];
    };
    pts = strategy(mr.mode);
    if (pts.length === 0 && mr.mode === "chapters" && mr.fallback !== "none") pts = strategy(mr.fallback);
    // enforce min segment from start/end and between consecutive breaks
    const kept: number[] = [];
    for (const p of pts.sort((a, b) => a - b)) {
      if (p < guard || p > dur - guard) continue;
      if (kept.length && p - kept[kept.length - 1] < guard) continue;
      kept.push(p);
    }
    return kept;
  }

  private async addWithMidRoll(item: MediaItem, opts: AddOpts, mr: MidRollState): Promise<void> {
    const points = this.breakPoints(item, mr);
    const dur = item.durationMs;
    // Ad breaks must never push the block past its slot. Reserve covers the
    // up-next card that airs after the episode (when the channel has one).
    const RESERVE_MS = this.opts.upNext?.durationMs ?? 0;
    let estBreakMs = 120_000; // typical break; refined from the first real break
    let segStart = 0, lastFillerSec = 0, count = 0;
    const fillPod = mr.pod && this.doc.pods[mr.pod]?.target ? mr.pod : undefined;
    // A show longer than one slot (a 35-minute episode on a half-hour grid takes the
    // hour): its breaks grow past their usual length so the spare time is shared
    // between them and the padding after the show, rather than all landing at the end.
    const stretch = !!fillPod && this.slotEndMs != null && this.stretchUnitMs != null && dur > this.stretchUnitMs;
    for (let k = 0; k < points.length; k++) {
      const bp = points[k];
      const pointSec = bp / 1000;
      const remainingSec = (dur - bp) / 1000;
      const scope = {
        point: pointSec, last_mid_filler: pointSec - lastFillerSec,
        // `count` = breaks already inserted in this item. ErsatzTV exposes this as
        // both total_points and matched_points; `remaining` / `remaining_duration`
        // are the seconds left after this break point.
        total_points: count, matched_points: count,
        item_duration: dur / 1000, remaining: remainingSec, remaining_duration: remainingSec,
      };
      if (mr.expression && !evalExpression(mr.expression, scope)) continue; // rule says no break here
      // Budget: breaks must fit in the slot alongside the rest of the episode and
      // the post-roll reserve. Breaks filled to a length share the room left
      // evenly (each at most its target), so a long show gets shorter breaks
      // rather than running into the next slot; fixed breaks are skipped once
      // the next one won't fit.
      let maxBreakMs: number | undefined, wantBreakMs: number | undefined;
      if (this.slotEndMs != null) {
        const room = this.slotEndMs - this.nowMs - (dur - segStart) - RESERVE_MS;
        if (fillPod) {
          maxBreakMs = room / (points.length - k);
          if (maxBreakMs < 30_000) break; // not even 30 s per break left
          if (stretch) wantBreakMs = room / (points.length - k + 1); // this break's share (the padding gets one too)
        } else if (room < estBreakMs) break; // no room for any more breaks
      }
      await this.addSimple(item, segStart, bp, opts);              // episode segment
      const beforeBreak = this.nowMs, breakStart = this.items.length;
      if (mr.pod) await this.executePod(mr.pod, maxBreakMs, wantBreakMs); // pod-built break
      else if (mr.sequence) {                                      // fixed sequence break
        this.inMidRollBreak = true;
        try { await this.execSequence(mr.sequence); } finally { this.inMidRollBreak = false; }
      }
      // a fixed break can run longer than estimated: drop its last items until
      // the rest of the episode still ends inside the slot
      if (this.slotEndMs != null) this.trimBreak(breakStart, this.slotEndMs - (dur - bp) - RESERVE_MS);
      const measured = this.nowMs - beforeBreak;
      if (measured > 0) estBreakMs = measured;                     // learn actual break length
      segStart = bp; lastFillerSec = pointSec; count++;
    }
    await this.addSimple(item, segStart, dur, opts);              // final segment
  }

  // --- commercial-break pod builder -----------------------------------------
  /** Fill a break from ordered slots to a target duration, honoring no-repeat. */
  /** Remove items added since `fromIdx` (a break's) from the end until the clock
   *  is back at or before `latestEnd`. */
  private trimBreak(fromIdx: number, latestEnd: number): void {
    while (this.nowMs > latestEnd && this.items.length > fromIdx) {
      const it = this.items.pop()!;
      delete this.labels[it.id];
      this.nowMs = Date.parse(it.start);
    }
  }

  /** `maxMs` caps a filled break below its target (exactly — no tolerance) when
   *  the slot has less room; `wantMs` lengthens it past its target (a long show's
   *  stretched breaks), never beyond `maxMs`. */
  private async executePod(podKey: string, maxMs?: number, wantMs?: number): Promise<void> {
    const pod = this.doc.pods[podKey];
    if (!pod) throw new Error(`Pod not found: ${podKey}`);
    let targetMs = pod.target ? parseDurationMs(pod.target) : undefined;
    let tolMs = pod.tolerance ? parseDurationMs(pod.tolerance) : 3000;
    if (targetMs != null && wantMs != null && wantMs > targetMs) targetMs = maxMs != null ? Math.min(wantMs, maxMs) : wantMs;
    if (targetMs != null && maxMs != null && maxMs < targetMs) { targetMs = maxMs; tolMs = 0; }

    // Phase A: select fixed (count) slots; remember durations to reserve budget.
    const picks: { content: string; fillerKind?: FillerKind; items: MediaItem[]; fill: boolean; noRepeatMs: number }[] = [];
    let fixedDur = 0;
    const fillSlots: number[] = [];
    for (const slot of pod.slots) {
      const noRepeatMs = slot.noRepeat ? parseDurationMs(slot.noRepeat) : 0;
      const entry = { content: slot.content, fillerKind: slot.fillerKind, items: [] as MediaItem[], fill: !!slot.fill, noRepeatMs };
      if (slot.fill) { fillSlots.push(picks.length); }
      else {
        const e = await this.enumerator(slot.content);
        const n = slot.count ?? 1;
        for (let i = 0; i < n && !e.isEmpty; i++) { const it = this.pickNonRepeating(e, noRepeatMs); if (it) { entry.items.push(it); fixedDur += it.durationMs; } }
      }
      picks.push(entry);
    }

    // Phase B: fill the remaining budget across fill slots.
    if (targetMs != null && fillSlots.length) {
      const per = Math.max(0, targetMs - fixedDur) / fillSlots.length;
      for (const idx of fillSlots) {
        const slot = picks[idx];
        const e = await this.enumerator(slot.content);
        let acc = 0, guard = 0, skipped = 0;
        while (e && !e.isEmpty && guard++ < 500) {
          const cand = e.peek(); if (!cand) break;
          if (acc + cand.durationMs > per + tolMs) {
            // the next item would overshoot: done once the break is mostly full;
            // otherwise pass over it (e.g. a 10-minute bumper in a 3-minute break)
            // and try the next one
            if (acc >= per * 0.75 || ++skipped > Math.min(e.size, 50)) break;
            e.next(); continue;
          }
          const it = this.pickNonRepeating(e, slot.noRepeatMs); if (!it) break;
          slot.items.push(it); acc += it.durationMs;
        }
      }
    } else {
      // no target: fill slots contribute a single item each
      for (const idx of fillSlots) { const e = await this.enumerator(picks[idx].content); const it = e && !e.isEmpty ? this.pickNonRepeating(e, picks[idx].noRepeatMs) : undefined; if (it) picks[idx].items.push(it); }
    }

    // Phase C: emit in slot order.
    let emitted = 0;
    for (const p of picks) {
      for (const it of p.items) {
        if (pod.maxItems && emitted >= pod.maxItems) return;
        await this.addSimple(it, 0, it.durationMs, { contentKey: p.content, fillerKind: p.fillerKind ?? "midroll" });
        emitted++;
      }
    }
  }

  /** Next item from an enumerator that hasn't aired within `windowMs`. */
  private pickNonRepeating(e: Cursor, windowMs: number): MediaItem | undefined {
    if (windowMs <= 0) return e.next();
    for (let k = 0; k < e.size; k++) {
      const cand = e.peek(); if (!cand) return undefined;
      const last = this.lastPlayed.get(cand.id);
      if (last != null && this.nowMs - last < windowMs) { e.next(); continue; } // too recent, skip
      return e.next();
    }
    return e.next(); // everything is recent; reuse the least-recent anyway
  }

  private async addSimple(item: MediaItem, inMs: number, outMs: number, opts: AddOpts): Promise<void> {
    const segDur = Math.max(0, outMs - inMs);
    if (segDur <= 0) return;
    const start = this.nowMs;
    const finish = start + segDur;
    const src: LocalSource = { source_type: "local", path: item.path };
    if (inMs > 0) src.in_point_ms = Math.round(inMs);
    if (outMs < item.durationMs) src.out_point_ms = Math.round(outMs);
    const pi: PlayoutItem = {
      id: String(++this.idSeq),
      start: formatRfc3339(start, this.opts.tz),
      finish: formatRfc3339(finish, this.opts.tz),
      source: src,
    };
    const overlays = [...(this.opts.overlays?.channel ?? []), ...this.activeWatermarks, ...this.activeGraphics];
    if (overlays.length) this.overlayRefs.set(pi.id, overlays);
    this.items.push(pi);
    // Programs are classified by type alone; only interstitials need tags for
    // the preview classifier, so keep the labels sidecar lean by omitting tags
    // on episodes/movies.
    const isProgram = item.kind === "episode" || item.kind === "movie" || item.kind === "music_video";
    // Track the currently-airing program's show title so show-relative bumpers
    // (${show_title}) resolve to whatever is actually playing — e.g. when the
    // program is drawn from a collection of many shows.
    if (isProgram) { this.currentShowTitle = item.showTitle || item.title || ""; this.currentShowYear = itemYear(item); }
    this.labels[pi.id] = {
      key: opts.contentKey, fillerKind: opts.fillerKind, type: item.kind,
      tags: isProgram || !item.tags?.length ? undefined : item.tags,
    };
    this.lastPlayed.set(item.id, start);
    this.nowMs = finish;
    await this.maybeYield();
  }

  /** Hand the event loop back periodically so a long build never starves the
   *  HTTP server (Browse/other tabs stay responsive during a build). Time-sliced
   *  (~every 20ms of continuous work) so the yield overhead is negligible. */
  private async maybeYield(): Promise<void> {
    const now = Date.now();
    if (now - this.lastYieldMs >= 20) {
      this.lastYieldMs = now;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }


  // --- helpers ---------------------------------------------------------------
  private async enumerator(key: string): Promise<Cursor> {
    const def = this.contentByKey.get(key);
    if (!def) throw new Error(`Content key not defined: ${key}`);
    // Show-relative content: `${show_title}` resolves to the program currently
    // airing; `${next_show_title}` resolves to the upcoming program by peeking
    // the enumerator named in `def.peek` (the next lineup slot's show content).
    // Cache one enumerator per resolved title pair so each keeps its own
    // no-repeat position.
    const q0 = def.query ?? "";
    const needShow = q0.includes("${show_title}");
    const needNext = q0.includes("${next_show_title}");
    const dynamic = needShow || needNext;
    let nextTitle = "";
    if (needNext && def.peek) {
      const pe = await this.enumerator(def.peek);
      const pk = pe.peek();
      nextTitle = (pk?.showTitle || pk?.title || "").replace(/"/g, "");
    }
    const curTitle = (this.currentShowTitle ?? "").replace(/"/g, "");
    // monthly rotation: a fresh set of titles each calendar month (own cursor per month)
    let rotation = "";
    if (def.rotation) { const p = localParts(this.nowMs, this.opts.tz); rotation = `${p.y}-${String(p.mo + 1).padStart(2, "0")}`; }
    // era-matched filler: draw from items near the airing program's year
    const era = def.matchEra && this.currentShowYear ? this.currentShowYear : undefined;
    const cacheKey = (dynamic ? `${key}::${needShow ? curTitle : ""}::${nextTitle}` : key) + (rotation ? `::rot${rotation}` : "") + (era ? `::era${era}` : "");
    let e = this.enumerators.get(cacheKey);
    if (e) return e;
    let rdef = def;
    if (dynamic) {
      rdef = { ...def, query: q0.replace(/\$\{show_title\}/g, curTitle).replace(/\$\{next_show_title\}/g, nextTitle) };
    }
    // a playlist plays its entries in order (legacy semantics); each entry keeps its own cursor
    if (def.kind === "playlist" && this.resolver.resolvePlaylist) {
      const seed = this.opts.seed ?? 1;
      const entries = await this.resolver.resolvePlaylist(def.playlist ?? def.collection ?? "", { includeSpecials: def.includeSpecials });
      const subs = entries.map((en) => {
        // the same content in several entries shares one cursor (no back-to-back repeats);
        // keyed by what it plays, so reordering entries keeps each one's place
        const k = `${cacheKey}::${en.source}::${en.order}`;
        let sub = this.enumerators.get(k) as Enumerator | undefined;
        if (!sub) { sub = new Enumerator(k, groupSegments(en.items), en.order, seed, this.opts.progress?.[k] ?? 0); this.enumerators.set(k, sub); }
        return { e: sub, take: en.playAll ? "all" as const : Math.max(1, en.count ?? 1), inGuide: en.inGuide };
      });
      const pe = new PlaylistEnumerator(cacheKey, subs, this.opts.progress?.[cacheKey] ?? 0);
      this.enumerators.set(cacheKey, pe);
      return pe;
    }
    let items = groupSegments(await this.resolver.resolveContent(rdef));
    if (era) items = eraSubset(items, era);
    if (def.rotation && items.length > def.rotation.size) {
      // the month's picks: a seeded draw, so every rebuild in a month agrees
      const pick = new Enumerator(`${cacheKey}#pick`, items, "random", this.opts.seed ?? 1);
      items = Array.from({ length: def.rotation.size }, () => pick.next()!);
    }
    e = new Enumerator(cacheKey, items, def.order, this.opts.seed ?? 1, this.opts.progress?.[cacheKey] ?? 0);
    this.enumerators.set(cacheKey, e);
    return e;
  }

  private skipTo(e: Cursor, season: number, episode: number): void {
    for (let i = 0; i < e.size; i++) {
      const p = e.peek();
      if (p && p.season === season && p.episodeNumber === episode) return;
      e.next();
    }
  }

}

// --- daypart date matching ---------------------------------------------------
/** Ordinal for comparing calendar positions within a year (month-major). */
function md(month: number, day: number): number { return month * 100 + day; }

function inRange(y: number, mo: number, day: number, r: DateRange): boolean {
  const dated = r.from.year != null || r.to.year != null;
  if (dated) {
    // Fully-specified range: compare on (year, month, day).
    const cur = y * 10000 + md(mo, day);
    const lo = (r.from.year ?? y) * 10000 + md(r.from.month, r.from.day);
    const hi = (r.to.year ?? y) * 10000 + md(r.to.month, r.to.day);
    return lo <= cur && cur <= hi;
  }
  // Annual range: compare month/day, allowing wraparound (e.g. Dec 26 -> Jan 2).
  const cur = md(mo, day), lo = md(r.from.month, r.from.day), hi = md(r.to.month, r.to.day);
  return lo <= hi ? cur >= lo && cur <= hi : cur >= lo || cur <= hi;
}

function specMatches(s: DateSpec, y: number, mo: number, day: number): boolean {
  return (s.year == null || s.year === y) && s.month === mo && s.day === day;
}

/** Whether a daypart's date facets (if any) are satisfied by the given date.
 *  `months` is an independent filter; `dates`/`ranges`/`holidays` form an OR set
 *  the date must satisfy when any of them is present. No facets => always true. */
export function dateMatches(d: Daypart, y: number, mo: number, day: number): boolean {
  if (d.months && !d.months.includes(mo)) return false;
  const hasDateSet = !!(d.dates?.length || d.ranges?.length || d.holidays?.length);
  if (!hasDateSet) return true;
  if (d.dates?.some((s) => specMatches(s, y, mo, day))) return true;
  if (d.ranges?.some((r) => inRange(y, mo, day, r))) return true;
  if (d.holidays?.some((h) => { const hd = holidayDate(h, y); return !!hd && hd.month === mo && hd.day === day; })) return true;
  return false;
}

/** Interior chapter break points (ms), i.e. every chapter start after the first. */
function interiorChapters(item: MediaItem): number[] {
  const pts = (item.chapters ?? [])
    .map((c) => c.startMs)
    .filter((s) => s > 500 && s < item.durationMs - 500);
  return Array.from(new Set(pts)).sort((a, b) => a - b);
}

/** Instructions that finish off a program rather than start new content: these
 *  still run after a daypart's soft edge has passed. */
function isClosingOp(ins: Instruction): boolean {
  return (ins.op === "epg_group" && !ins.value) || (ins.op === "mid_roll" && !ins.enabled)
    || ins.op === "pad_to_next" || ins.op === "pre_roll_off" || ins.op === "graphics_off" || ins.op === "watermark_off";
}


/** A media item's year: its metadata year, its air date, or a year in its file name
 *  (commercials are often named like "1994 Toy Commercial.mp4"). */
function itemYear(it: MediaItem): number | undefined {
  if (it.year) return it.year;
  const a = it.aired?.match(/^(\d{4})/);
  if (a) return +a[1];
  const f = (it.path ?? "").split(/[\\/]/).pop() ?? "";
  const m = f.match(/(?:^|\D)(19[3-9]\d|20[0-4]\d)(?:\D|$)/);
  return m ? +m[1] : undefined;
}

/** Filler from near a program's year: within 5 years, else 10, else the closest
 *  dated items (a show older or newer than every ad gets the nearest ones), keeping
 *  enough variety that a break doesn't repeat itself. */
function eraSubset(items: MediaItem[], year: number): MediaItem[] {
  for (const span of [5, 10]) {
    const near = items.filter((it) => { const y = itemYear(it); return y != null && Math.abs(y - year) <= span; });
    if (near.length >= 15) return near;
  }
  const dated = items.map((it) => ({ it, d: Math.abs((itemYear(it) ?? 9999) - year) })).filter((x) => x.d < 5000).sort((a, b) => a.d - b.d);
  if (dated.length < 15) return items;
  const cut = dated[Math.min(dated.length, 60) - 1].d; // every item as close as the 60th-closest
  return dated.filter((x) => x.d <= cut).map((x) => x.it);
}

/** How far ahead pack mode looks for an item that fits when the next one is too long. */
const PACK_LOOKAHEAD = 3;

/** A full-screen "coming up next" interstitial for [startMs, finishMs]. Primary
 *  content is a black lavfi background. The card is built from stacked `media`
 *  graphics layers — a background plus one per upcoming show — each a transparent
 *  PNG served by the up-next endpoint. next's own graphics engine composites and
 *  fades them via each layer's `timing`, so the reveal (base in, rows staggered in,
 *  hold, all fade out together) is done natively. Layer PNGs are dynamic: the
 *  endpoint reads the guide anchored at `anchorMs`. Shared by the engine and the
 *  up-next card tester, so a preview is exactly what airs. */
export function upNextItem(u: UpNextOptions, id: string, startMs: number, finishMs: number, anchorMs: number, tz: Tz, override?: { theme?: string; count?: number }): PlayoutItem {
  const D = finishMs - startMs;
  const count = override?.count ?? u.count;
  const theme = override?.theme || u.theme || "splat";
  const base = u.baseUrl.replace(/\/+$/, "");
  const layerUrl = (layer: string) => {
    const p = new URLSearchParams({
      ...(u.channelName ? { c: u.channelName } : {}), ch: u.channelNumber, at: String(Math.round(anchorMs)), n: String(count),
      theme, w: String(u.width), h: String(u.height), layer,
    });
    return `${base}/graphics/upnext.png?${p.toString()}`;
  };
  const mkLayer = (layer: string, phase: number, hold: number): GraphicsLayer => ({
    kind: "media",
    location: "top_left",
    source: {
      source_type: "http", uri: layerUrl(layer), reconnect: true,
      probe_hint: { format_name: "png_pipe", video: [{ stream_index: 0, codec: "png", width: u.width, height: u.height, pix_fmt: "rgba" }] },
    },
    timing: {
      timing_type: "periodic", clock: "content",
      // Large frequency => a single appearance within the item window.
      frequency_ms: Math.round(Math.max(D * 4, D + 2 * FADE_MS + hold + 1000)),
      phase_offset_ms: Math.max(0, Math.round(phase)),
      fade_ms: FADE_MS,
      hold_ms: Math.max(FADE_MS, Math.round(hold)),
    },
  });

  // Everything fades OUT together over the last FADE_MS, finishing ~100ms early
  // so a trimmed tail can't clip it. Reveals spread evenly across the card.
  const outEnd = Math.max(2 * FADE_MS + 50, D - 100);
  const subtitles = u.textMode === "subtitles";
  const layers: GraphicsLayer[] = [];
  layers.push(mkLayer("base", 0, outEnd - 2 * FADE_MS)); // background + heading: up the whole time
  if (!subtitles) {
    // Image mode: each show's text is its own faded PNG layer.
    const t0 = FADE_MS;
    let revealEnd = Math.min(D * 0.62, outEnd - 3 * FADE_MS - 200);
    if (revealEnd < t0) revealEnd = t0;
    const step = count > 1 ? (revealEnd - t0) / (count - 1) : 0;
    for (let k = 0; k < count; k++) {
      const reveal = t0 + k * step;
      layers.push(mkLayer(String(k), reveal, outEnd - reveal - 2 * FADE_MS));
    }
  }

  // Video: image mode uses a black background with the art composited as
  // graphics layers on top. Subtitles mode makes the background art the PRIMARY
  // video (a still image) so the burned ASS text always lands on top of it —
  // no graphics layer that could cover the subtitles.
  const bgHint = { format_name: "png_pipe", video: [{ stream_index: 0, codec: "png", width: u.width, height: u.height, pix_fmt: "rgba" }] };
  const video = subtitles
    ? { source: { source_type: "http" as const, uri: layerUrl("base"), reconnect: true, probe_hint: bgHint } }
    : { source: { source_type: "lavfi" as const, params: `color=c=black:s=${u.width}x${u.height}:r=${u.fps ?? "24"}` } };
  const pi: PlayoutItem = {
    id,
    start: formatRfc3339(startMs, tz),
    finish: formatRfc3339(finishMs, tz),
    tracks: {
      video,
      // Per-channel background audio bed if configured; otherwise silence.
      audio: u.audioPath
        ? { source: { source_type: "local", path: u.audioPath } }
        : { source: { source_type: "lavfi", params: "anullsrc=channel_layout=stereo:sample_rate=48000" } },
    },
  };
  if (!subtitles) pi.graphics = layers; // image mode composites the art as layers
  return pi;
}
