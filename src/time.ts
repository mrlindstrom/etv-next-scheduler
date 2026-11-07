// Time helpers. Wall-clock math follows a time zone: an IANA name like
// "America/Chicago" (DST-aware), or a fixed UTC offset in minutes (tests, CLI).
//
// DST rules, like a real station:
// - fall back: the repeated hour (1:00-1:59 twice) is just more wall-clock time,
//   so a 1:00 slot airs twice and a 1:00-2:00 daypart runs two hours;
// - spring forward: wall times in the skipped hour don't exist; a time asked for
//   in it lands just after the gap (2:30 -> 3:30).

/** IANA zone name, or a fixed UTC offset in minutes (e.g. -300). */
export type Tz = string | number;

/** This machine's IANA zone (e.g. "America/Chicago"). */
export function machineTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** True when `name` is an IANA zone this runtime knows. */
export function isValidTz(name: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: name }); return true; } catch { return false; }
}

const fmts = new Map<string, Intl.DateTimeFormat>();
const offsets = new Map<string, number>();
// Real zones only change offset on (at least) 15-minute boundaries.
const BUCKET = 15 * 60_000;

/** UTC offset in minutes at instant `ms` (negative west of Greenwich). */
export function offsetAt(ms: number, tz: Tz): number {
  if (typeof tz === "number") return tz;
  const bucket = Math.floor(ms / BUCKET) * BUCKET;
  const key = `${tz}@${bucket}`;
  const hit = offsets.get(key);
  if (hit !== undefined) return hit;
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    fmts.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(bucket)) if (part.type !== "literal") p[part.type] = Number(part.value);
  const off = Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - bucket) / 60_000);
  if (offsets.size > 50_000) offsets.clear();
  offsets.set(key, off);
  return off;
}

export function parseDurationMs(s: string): number {
  const str = String(s).trim().toLowerCase();
  // HH:MM:SS or MM:SS
  const clock = str.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (clock) {
    const a = Number(clock[1]), b = Number(clock[2]), c = clock[3] ? Number(clock[3]) : undefined;
    return (c !== undefined ? (a * 3600 + b * 60 + c) : (a * 60 + b)) * 1000;
  }
  let total = 0; let matched = false;
  for (const m of str.matchAll(/(\d+(?:\.\d+)?)\s*(h|hour|hours|m|min|minute|minutes|s|sec|second|seconds)/g)) {
    matched = true;
    const n = Number(m[1]); const u = m[2];
    if (u.startsWith("h")) total += n * 3600000;
    else if (u.startsWith("s")) total += n * 1000;
    else total += n * 60000;
  }
  if (!matched) { const n = Number(str); if (!Number.isNaN(n)) return n * 60000; }
  return total;
}

export function parseTimeOfDay(s: string): { h: number; m: number } {
  const str = String(s).trim().toLowerCase();
  const m = str.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) throw new Error(`Bad time-of-day: ${s}`);
  let h = Number(m[1]); const min = m[2] ? Number(m[2]) : 0; const ap = m[3];
  if (ap === "am") { if (h === 12) h = 0; }
  else if (ap === "pm") { if (h !== 12) h += 12; }
  return { h, m: min };
}

/** Local wall-clock parts for an epoch-ms instant. */
export function localParts(ms: number, tz: Tz) {
  const d = new Date(ms + offsetAt(ms, tz) * 60000);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth(), da: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), se: d.getUTCSeconds(),
    msOfDay: (d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()) * 1000 + d.getUTCMilliseconds(),
  };
}

/** Every instant whose local wall clock reads Y/M/D h:mi: two in a fall-back
 *  hour (earliest first), one normally. A time in a spring-forward gap gives the
 *  instant just after the gap. Out-of-range fields roll over (day 32 = next month). */
export function localToEpochAll(y: number, mo: number, da: number, h: number, mi: number, tz: Tz): number[] {
  const wall = Date.UTC(y, mo, da, h, mi, 0, 0);
  if (typeof tz === "number") return [wall - tz * 60000];
  const before = offsetAt(wall - 86_400_000, tz), after = offsetAt(wall + 86_400_000, tz);
  const out = [...new Set([before, after])]
    .map((o) => wall - o * 60000)
    .filter((t) => t + offsetAt(t, tz) * 60000 === wall)
    .sort((a, b) => a - b);
  return out.length ? out : [wall - before * 60000];
}

/** Epoch ms for a local Y/M/D + time of day (the earliest, if it happens twice). */
export function localToEpoch(y: number, mo: number, da: number, h: number, mi: number, tz: Tz): number {
  return localToEpochAll(y, mo, da, h, mi, tz)[0];
}

/** Next epoch-ms strictly after `nowMs` (or at it, with allowNow) where local time == when. */
export function nextTimeOfDay(nowMs: number, when: string, tz: Tz, allowNow = false): number {
  const { h, m } = parseTimeOfDay(when);
  const p = localParts(nowMs, tz);
  for (let add = 0; ; add++) {
    for (const t of localToEpochAll(p.y, p.mo, p.da + add, h, m, tz)) {
      if (t > nowMs || (t === nowMs && allowNow)) return t;
    }
  }
}

/** Next epoch-ms after now that lands on a local N-minute boundary (counted from
 *  local midnight). In a fall-back hour, the repeated :00/:30 marks count again. */
/** Is this moment exactly on a mark (:00 / :30 … for `minutes` = 30), to the second? */
export function onMinuteBoundary(nowMs: number, minutes: number, tz: Tz): boolean {
  if (!(minutes > 0)) return false;
  return localParts(Math.round(nowMs / 1000) * 1000, tz).msOfDay % (minutes * 60000) === 0;
}

export function nextMinuteBoundary(nowMs: number, minutes: number, tz: Tz): number {
  const stepMs = minutes * 60000;
  const p = localParts(nowMs, tz);
  const nextOfDay = Math.floor(p.msOfDay / stepMs) * stepMs + stepMs;
  if (nextOfDay >= 86_400_000) return localToEpoch(p.y, p.mo, p.da + 1, 0, 0, tz);
  // A DST change in between shifts the wall clock by whole hours, which usually
  // still lands on a mark (1:50 CDT + 10 min = 1:00 CST, the repeated hour).
  const c = nowMs + (nextOfDay - p.msOfDay);
  if (offsetAt(c, tz) === offsetAt(nowMs, tz) || localParts(c, tz).msOfDay % stepMs === 0) return c;
  // otherwise walk forward to the first whole minute that reads as a mark
  for (let t = Math.floor(nowMs / 60000) * 60000 + 60000; t < c + 86_400_000; t += 60000) {
    if (localParts(t, tz).msOfDay % stepMs === 0) return t;
  }
  return c;
}

/** Local day of week for an instant (0=Sunday .. 6=Saturday). */
export function localWeekday(ms: number, tz: Tz): number {
  return new Date(ms + offsetAt(ms, tz) * 60000).getUTCDay();
}

/** The local midnight at or before `ms` (epoch ms). */
export function floorLocalMidnight(ms: number, tz: Tz): number {
  const p = localParts(ms, tz);
  return localToEpoch(p.y, p.mo, p.da, 0, 0, tz);
}

/** The local midnight at or after `ms` (epoch ms). */
export function ceilLocalMidnight(ms: number, tz: Tz): number {
  const f = floorLocalMidnight(ms, tz);
  if (f === ms) return ms;
  const p = localParts(ms, tz);
  return localToEpoch(p.y, p.mo, p.da + 1, 0, 0, tz);
}

/** Local midnight `days` calendar days after the day containing `ms` (days may be
 *  23 or 25 hours long across a DST change). */
export function addLocalDays(ms: number, days: number, tz: Tz): number {
  const p = localParts(ms, tz);
  return localToEpoch(p.y, p.mo, p.da + days, 0, 0, tz);
}

/** RFC3339 timestamp with the zone's offset at that instant, e.g. 2026-04-13T00:24:21.527-05:00. */
export function formatRfc3339(ms: number, tz: Tz): string {
  const off = offsetAt(ms, tz);
  const d = new Date(ms + off * 60000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const sign = off >= 0 ? "+" : "-";
  const ao = Math.abs(off);
  const iso =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    `.${pad(d.getUTCMilliseconds(), 3)}`;
  return `${iso}${sign}${pad(Math.floor(ao / 60))}:${pad(ao % 60)}`;
}
