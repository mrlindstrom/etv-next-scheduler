// -----------------------------------------------------------------------------
// Multi-segment episode grouping.
// -----------------------------------------------------------------------------
// Some cartoons ship one episode as several short segment files, named with a
// trailing letter after the episode number: `Johnny Bravo - 1x01a - ...`,
// `- 1x01b - ...`, `- 1x01c - ...` (also accepts `S01E01a`). Aired individually
// they scatter across the schedule; the viewer expects all of 1x01's segments
// to play back-to-back as one episode, with the commercial break AFTER the block.
//
// groupSegments() folds those sibling files into a single synthetic MediaItem
// carrying the ordered `segments` (by letter) and a summed duration, so the
// engine schedules the whole episode as one unit. Files WITHOUT a segment letter
// are passed through untouched — including "range" files like `S01E04-E06.mkv`
// (one file mapped to several episode numbers), which must never be grouped.

import type { MediaItem } from "./model.js";

// `1x01a` (guard against a leading digit so `31x01a` -> season 1, and against a
// trailing alnum so `1x01` in `1920x1080p` never matches).
const RE_NXMM = /(?<!\d)(\d{1,2})x(\d{1,3})([a-z])(?![a-z0-9])/i;
// `S01E01a` / `s1e1a`
const RE_SXEX = /(?<!\d)s(\d{1,2})e(\d{1,3})([a-z])(?![a-z0-9])/i;

export interface SegRef { season: number; episode: number; seg: string; }

/** Parse a segment marker out of a file path, or null if it isn't segmented. */
export function parseSegment(path?: string): SegRef | null {
  if (!path) return null;
  const fn = path.split(/[\\/]/).pop() || path;
  const m = fn.match(RE_SXEX) || fn.match(RE_NXMM);
  if (!m) return null;
  return { season: Number(m[1]), episode: Number(m[2]), seg: m[3].toLowerCase() };
}

/** Fold sibling segment files into one grouped MediaItem each. Order within a
 *  group is by segment letter (a, b, c…). A "group" needs ≥2 distinct letters;
 *  a lone marker (or a false positive) is left as an ordinary item. Non-episode
 *  items and unmarked files are returned unchanged, preserving input order. */
export function groupSegments(items: MediaItem[]): MediaItem[] {
  interface G { key: string; firstIndex: number; byLetter: Map<string, MediaItem>; base: SegRef; }
  const groups = new Map<string, G>();
  const out: (MediaItem | G)[] = [];

  items.forEach((it, i) => {
    const ref = it.kind === "episode" ? parseSegment(it.path) : null;
    if (!ref) { out.push(it); return; }
    const key = `${(it.showTitle || "").toLowerCase()}|${ref.season}|${ref.episode}`;
    let g = groups.get(key);
    if (!g) { g = { key, firstIndex: i, byLetter: new Map(), base: ref }; groups.set(key, g); out.push(g); }
    if (!g.byLetter.has(ref.seg)) g.byLetter.set(ref.seg, it); // first file wins per letter
  });

  const isGroup = (x: MediaItem | G): x is G => (x as G).byLetter instanceof Map;
  const result: MediaItem[] = [];
  for (const x of out) {
    if (!isGroup(x)) { result.push(x); continue; }
    const letters = [...x.byLetter.keys()].sort();
    if (letters.length < 2) { result.push(...x.byLetter.values()); continue; } // not a real group
    const segs = letters.map((l) => x.byLetter.get(l)!);
    const first = segs[0];
    const totalDur = segs.reduce((s, seg) => s + (seg.durationMs || 0), 0);
    result.push({
      ...first,
      id: `seg:${first.id}`,          // stable synthetic id (no-repeat keys on this)
      durationMs: totalDur,
      season: x.base.season,
      episodeNumber: x.base.episode,   // chronological order uses the base episode
      chapters: [],                    // never mid-roll *inside* a segment block
      segments: segs,
    });
  }
  return result;
}
