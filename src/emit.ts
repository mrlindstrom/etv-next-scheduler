// Emit ErsatzTV "next" playout JSON. Files are named `{start}_{finish}.json`
// using compact ISO 8601 (no separators) so the channel can find the window.

import { mkdir, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Playout } from "./model.js";
import { formatRfc3339, type Tz } from "./time.js";

function compact(ms: number, tz: Tz): string {
  // 2026-04-13T00:24:21.527-05:00 -> 20260413T002421.527000000-0500
  const rfc = formatRfc3339(ms, tz);
  const m = rfc.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})([+-])(\d{2}):(\d{2})$/)!;
  const [, y, mo, d, h, mi, s, milli, sign, oh, om] = m;
  return `${y}${mo}${d}T${h}${mi}${s}.${milli}000000${sign}${oh}${om}`;
}

export function playoutFilename(startMs: number, finishMs: number, tz: Tz): string {
  return `${compact(startMs, tz)}_${compact(finishMs, tz)}.json`;
}

export async function writePlayout(
  dir: string,
  playout: Playout,
  startMs: number,
  finishMs: number,
  tz: Tz,
  labels?: Record<string, unknown>,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  // Name the window by its ACTUAL content end, not the requested finish. The
  // engine lets the last item overshoot `finishMs` (an item is never cut), so a
  // window can run past midnight. If we named it by the requested finish, the
  // next window would start at that midnight and overlap this window's tail —
  // the streamer then has two programs claiming the same minutes and drops/cuts
  // the end-of-day content. Using the real end makes consecutive windows tile
  // exactly (coverage picks up where playback truly ends).
  const items = (playout as any).items as Array<{ finish?: string }> | undefined;
  let endMs = finishMs;
  if (items?.length) {
    const last = Date.parse(items[items.length - 1]?.finish ?? "");
    if (Number.isFinite(last)) endMs = last;
  }
  const name = playoutFilename(startMs, endMs, tz);
  const file = join(dir, name);
  await writeFile(file, JSON.stringify(playout, null, 2), "utf8");
  // Sidecar with preview-only labels (NOT part of the ErsatzTV schema).
  if (labels) await writeFile(file.replace(/\.json$/, ".labels.json"), JSON.stringify(labels), "utf8");
  // The window we just wrote is authoritative for its range; remove any older
  // window files that overlap it so `next` never plays from a stale, ambiguous
  // window (which would desync the stream from the guide).
  await pruneOverlappingWindows(dir, file);
  return file;
}

/** Parse a `{start}_{finish}.json` compact window filename into epoch ms. */
export function parseWindowRange(file: string): { startMs: number; finishMs: number } | null {
  const m = basename(file, ".json").match(
    /^(\d{8})T(\d{6})\.\d+([+-]\d{2})(\d{2})_(\d{8})T(\d{6})\.\d+([+-]\d{2})(\d{2})$/);
  if (!m) return null;
  const iso = (d: string, t: string, oh: string, om: string) =>
    `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}${oh}:${om}`;
  const s = Date.parse(iso(m[1], m[2], m[3], m[4]));
  const f = Date.parse(iso(m[5], m[6], m[7], m[8]));
  return Number.isNaN(s) || Number.isNaN(f) ? null : { startMs: s, finishMs: f };
}

/**
 * Delete window files in `dir` whose [start, finish) overlaps `keepFile`'s range
 * (adjacency, where one window's finish equals the next's start, is NOT an
 * overlap and is preserved). Also removes each deleted window's `.labels.json`.
 * Returns the list of removed window filenames.
 */
export async function pruneOverlappingWindows(dir: string, keepFile: string): Promise<string[]> {
  const keep = parseWindowRange(keepFile);
  if (!keep) return [];
  const keepName = basename(keepFile);
  let files: string[] = [];
  try { files = await readdir(dir); } catch { return []; }
  const removed: string[] = [];
  for (const f of files) {
    if (!f.endsWith(".json") || f.endsWith(".labels.json") || f === keepName) continue;
    const r = parseWindowRange(join(dir, f));
    if (!r) continue;
    const overlaps = keep.startMs < r.finishMs && r.startMs < keep.finishMs;
    if (!overlaps) continue;
    try { await unlink(join(dir, f)); removed.push(f); } catch {}
    try { await unlink(join(dir, f.replace(/\.json$/, ".labels.json"))); } catch {}
  }
  return removed;
}

/**
 * Resolve pre-existing overlaps in a channel's playout directory by keeping the
 * most-recently-written window and discarding any older window that overlaps a
 * kept one. Used to heal directories written before overlap-pruning existed.
 * Returns the removed window filenames.
 */
export async function consolidateWindows(dir: string): Promise<string[]> {
  let names: string[] = [];
  try { names = await readdir(dir); } catch { return []; }
  const wins: { name: string; startMs: number; finishMs: number; mtime: number }[] = [];
  for (const n of names) {
    if (!n.endsWith(".json") || n.endsWith(".labels.json")) continue;
    const r = parseWindowRange(join(dir, n));
    if (!r) continue;
    let mtime = 0; try { mtime = (await stat(join(dir, n))).mtimeMs; } catch {}
    wins.push({ name: n, ...r, mtime });
  }
  wins.sort((a, b) => b.mtime - a.mtime); // newest first
  const kept: typeof wins = [];
  const removed: string[] = [];
  for (const w of wins) {
    const clash = kept.some((k) => w.startMs < k.finishMs && k.startMs < w.finishMs);
    if (clash) {
      try { await unlink(join(dir, w.name)); removed.push(w.name); } catch {}
      try { await unlink(join(dir, w.name.replace(/\.json$/, ".labels.json"))); } catch {}
    } else kept.push(w);
  }
  return removed;
}
