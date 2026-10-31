// -----------------------------------------------------------------------------
// Content resolution: turn a content key into an ordered stream of MediaItems.
// -----------------------------------------------------------------------------
// The engine is decoupled from where media comes from. A ContentResolver knows
// how to look up a content definition (search / show / collection / ...) in the
// legacy database and return concrete MediaItems. Playback order + cursor state
// is handled by Enumerator so that shuffle/chronological "continue" correctly
// across an entire multi-day build.

import type { MediaItem } from "./model.js";
import type { ContentDef, PlaybackOrder } from "./yaml.js";

export interface GraphicsAsset { path: string; kind: "image" | "text" | "other"; }

/** One audio/subtitle/video stream of a media file, as probed by the scanner. */
export interface MediaStreamInfo {
  index: number;              // absolute ffprobe stream index within the file
  kind: string;               // "audio" | "subtitle" | "video"
  language?: string;          // ISO 639 code as tagged in the file (may be "", "und", "en", "eng"…)
  channels?: number;
  default?: boolean;
  forced?: boolean;
  title?: string;             // stream title as tagged (e.g. "Forced", "English SDH")
}

export interface ContentResolver {
  /** Resolve a content definition to its full item list (unordered). */
  resolveContent(def: ContentDef): Promise<MediaItem[]>;
  /** Optional: resolve a graphics/watermark element file to an on-disk asset. */
  resolveGraphics?(element: string): Promise<GraphicsAsset | null>;
  /** Optional: extra guide metadata (genres/rating/icon) for a scheduled item. */
  guideExtras?(id: string): { genres: string[]; contentRating?: string; icon?: string };
  /** Optional: audio/subtitle streams for a local file path (for language-based
   *  track selection). Returns undefined if the file isn't known to the library. */
  streamsForPath?(path: string): MediaStreamInfo[] | undefined;
  /** Optional: a playlist's entries in order, each with its own items and play
   *  rules (ErsatzTV legacy semantics). Without it, playlists resolve as a flat list. */
  resolvePlaylist?(name: string, opts?: { includeSpecials?: boolean }): Promise<PlaylistEntry[]>;
}

/** One line of a playlist: what it plays, in what order, and how many per pass. */
export interface PlaylistEntry {
  label: string;
  source: string;        // what it plays ("smart:6", "item:123"): entries playing the same thing share one cursor
  items: MediaItem[];
  order: PlaybackOrder;
  count?: number;        // play this many per pass (default 1)
  playAll?: boolean;     // play every item of the entry per pass
  inGuide: boolean;      // false: plays like filler (no guide entry of its own)
}

// --- deterministic PRNG (mulberry32) so shuffles are reproducible per seed ----
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chronoSort(items: MediaItem[]): MediaItem[] {
  return [...items].sort((a, b) => {
    const s = (a.season ?? 0) - (b.season ?? 0);
    if (s) return s;
    const e = (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0);
    if (e) return e;
    const da = a.aired ?? a.releaseDate ?? "";
    const db = b.aired ?? b.releaseDate ?? "";
    if (da !== db) return da < db ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Stateful cursor over a content list honoring a playback order. */
export class Enumerator {
  private cursor = 0;
  private ordered: MediaItem[];
  private rng: () => number;

  constructor(
    public readonly key: string,
    private readonly items: MediaItem[],
    private readonly order: PlaybackOrder,
    seed = 1,
    startCursor = 0,
  ) {
    this.rng = mulberry32(seed + hashKey(key));
    this.ordered = this.applyOrder(items);
    // resume where a previous build left off (per-show progress / no-repeat)
    if (this.ordered.length) this.cursor = ((startCursor % this.ordered.length) + this.ordered.length) % this.ordered.length;
  }

  get size(): number { return this.ordered.length; }
  get isEmpty(): boolean { return this.ordered.length === 0; }
  /** Current position in the ordered list (persist this to resume next build). */
  get position(): number { return this.cursor; }

  peek(): MediaItem | undefined { return this.ordered[this.cursor]; }

  /** The item `ahead` places after the next one (0 = the next one). */
  peekAt(ahead: number): MediaItem | undefined {
    if (!this.ordered.length || ahead >= this.ordered.length) return undefined;
    return this.ordered[(this.cursor + ahead) % this.ordered.length];
  }

  /** Move the item `ahead` places along up to the cursor, so it plays next and
   *  the items it jumped stay next in line, in their order. */
  promote(ahead: number): void {
    const n = this.ordered.length;
    if (ahead <= 0 || ahead >= n) return;
    const i = (this.cursor + ahead) % n;
    const [item] = this.ordered.splice(i, 1);
    if (i < this.cursor) this.cursor--; // removed from before the cursor (wrapped round)
    this.ordered.splice(this.cursor, 0, item);
  }

  next(): MediaItem | undefined {
    if (this.ordered.length === 0) return undefined;
    const item = this.ordered[this.cursor];
    this.cursor++;
    if (this.cursor >= this.ordered.length) {
      this.cursor = 0;
      if (this.order === "shuffle" || this.order === "random") {
        this.ordered = this.applyOrder(this.items); // reshuffle each cycle
      }
    }
    return item;
  }

  private applyOrder(items: MediaItem[]): MediaItem[] {
    switch (this.order) {
      case "chronological":
      case "season_episode":
        return chronoSort(items);
      case "shuffle":
        return items.some((it) => it.group) ? this.showBalancedShuffle(items) : this.shuffle(items);
      case "random":
      case "shuffle_in_order":
      case "multi_episode_shuffle":
        return this.shuffle(items);
      default:
        return [...items];
    }
  }

  /** Shuffle content that lists whole shows by show, not by episode, so a show
   *  with 300 episodes airs as often as one with 13: each round deals one
   *  episode from every show (shows in a fresh random order, never the same show
   *  twice in a row); each show draws from its own reshuffled episode list.
   *  Items not from a listed show share one slot per round. */
  private showBalancedShuffle(items: MediaItem[]): MediaItem[] {
    const pools = new Map<string, MediaItem[]>();
    for (const it of items) { const k = it.group ?? "__items"; const p = pools.get(k); if (p) p.push(it); else pools.set(k, [it]); }
    const decks = [...pools.entries()].map(([key, pool]) => ({ key, pool, deck: this.shuffle(pool), pos: 0 }));
    const rounds = Math.min(Math.max(...decks.map((d) => d.pool.length)), Math.max(1, Math.ceil(20000 / decks.length)));
    const out: MediaItem[] = [];
    let lastKey: string | undefined;
    for (let r = 0; r < rounds; r++) {
      const order = this.shuffle(decks.map((_, i) => i));
      if (order.length > 1 && decks[order[0]].key === lastKey) [order[0], order[1]] = [order[1], order[0]];
      for (const i of order) {
        const d = decks[i];
        if (d.pos >= d.deck.length) { d.deck = this.shuffle(d.pool); d.pos = 0; }
        out.push(d.deck[d.pos++]);
      }
      lastKey = decks[order[order.length - 1]].key;
    }
    return out;
  }

  private shuffle<T>(items: T[]): T[] {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

/** A playlist played the ErsatzTV-legacy way: its entries in order, each taking
 *  its turn for one item (or `count`, or all of them), then round again. Each
 *  entry keeps its own cursor (passed in, so progress persists per entry); this
 *  enumerator's position is where it is in the round. */
export class PlaylistEnumerator {
  private entry = 0;     // which entry's turn it is
  private taken = 0;     // items it has played this turn

  constructor(public readonly key: string, private readonly entries: { e: Enumerator; take: number | "all"; inGuide: boolean }[], startPosition = 0) {
    const live = entries.filter((x) => !x.e.isEmpty).length;
    if (!live) return;
    this.entry = Math.floor(startPosition / 100_000) % entries.length;
    this.taken = startPosition % 100_000;
    this.skipEmpty();
    if (this.taken >= this.turnLength()) { this.taken = 0; this.advance(); }
  }

  get size(): number { return this.entries.reduce((n, x) => n + x.e.size, 0); }
  get isEmpty(): boolean { return this.size === 0; }
  get position(): number { return this.entry * 100_000 + this.taken; }
  /** Whether the item `next()` last returned belongs in the guide (false: its entry
   *  is an interstitial, so it plays like filler). */
  lastInGuide = true;

  peek(): MediaItem | undefined { return this.isEmpty ? undefined : this.entries[this.entry].e.peek(); }
  peekAt(ahead: number): MediaItem | undefined { return ahead === 0 ? this.peek() : undefined; }
  promote(): void { /* order is the playlist's: never reordered */ }

  next(): MediaItem | undefined {
    if (this.isEmpty) return undefined;
    const item = this.entries[this.entry].e.next();
    this.lastInGuide = this.entries[this.entry].inGuide;
    if (++this.taken >= this.turnLength()) { this.taken = 0; this.advance(); }
    return item;
  }

  private turnLength(): number {
    const x = this.entries[this.entry];
    return x.take === "all" ? Math.max(1, x.e.size) : Math.max(1, x.take);
  }
  private advance(): void { this.entry = (this.entry + 1) % this.entries.length; this.skipEmpty(); }
  private skipEmpty(): void {
    for (let i = 0; i < this.entries.length && this.entries[this.entry].e.isEmpty; i++) this.entry = (this.entry + 1) % this.entries.length;
  }
}

function hashKey(k: string): number {
  let h = 0;
  for (let i = 0; i < k.length; i++) h = (Math.imul(h, 31) + k.charCodeAt(i)) | 0;
  return h;
}

// --- in-memory mock resolver (tests / offline demo) --------------------------
export class MockResolver implements ContentResolver {
  constructor(private readonly factory: (def: ContentDef) => MediaItem[]) {}
  async resolveContent(def: ContentDef): Promise<MediaItem[]> { return this.factory(def); }
  async resolveGraphics(element: string): Promise<GraphicsAsset | null> {
    return { path: `/graphics/${element}`, kind: element.startsWith("text/") ? "text" : "image" };
  }
}
