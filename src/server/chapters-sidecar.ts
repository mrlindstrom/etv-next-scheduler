// Read chapter markers from a sidecar file next to a media file, for media that
// carries chapters alongside it rather than embedded. Supports the Matroska
// chapters XML (`<name>.chapters.xml`) and the OGM/simple text format
// (`<name>.chapters.txt`). Times are normalized to the DB's TimeSpan string form.
import { existsSync, readFileSync } from "node:fs";

export interface SidecarChapter { id: number; start: string; end: string; title: string | null }

/** Seconds -> "HH:MM:SS.fffffff" (matches scanner-local.tsFromSec). */
function ts(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const frac = Math.round((sec - Math.floor(sec)) * 1e7);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(h)}:${p2(m)}:${p2(s)}.${String(frac).padStart(7, "0")}`;
}

/** Parse "HH:MM:SS(.frac)", "MM:SS", or a bare seconds number to seconds. */
function toSec(t: string): number {
  const s = (t ?? "").trim();
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (m) return (m[1] ? +m[1] : 0) * 3600 + +m[2] * 60 + parseFloat(m[3]);
  const n = Number(s);
  return isFinite(n) ? n : 0;
}

/** Candidate sidecar paths for a media file (extension-swapped and appended). */
function candidates(mediaPath: string): string[] {
  const slash = Math.max(mediaPath.lastIndexOf("/"), mediaPath.lastIndexOf("\\"));
  const dot = mediaPath.lastIndexOf(".");
  const stem = dot > slash ? mediaPath.slice(0, dot) : mediaPath;
  return [
    `${stem}.chapters.xml`,      // foo.mp4  -> foo.chapters.xml
    `${mediaPath}.chapters.xml`, // foo.mp4  -> foo.mp4.chapters.xml
    `${stem}.chapters.txt`,
    `${mediaPath}.chapters.txt`,
    `${stem}.xml`,
  ];
}

/** Matroska chapters XML: one entry per <ChapterAtom> (start + optional end/title). */
function parseXml(xml: string): { start: number; end?: number; title: string | null }[] {
  const out: { start: number; end?: number; title: string | null }[] = [];
  // Each ChapterTimeStart begins an atom; grab until the next start / edition end.
  const re = /<ChapterTimeStart>\s*([^<]+?)\s*<\/ChapterTimeStart>([\s\S]*?)(?=<ChapterTimeStart>|<\/EditionEntry>|<\/Chapters>|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const rest = m[2] ?? "";
    const endM = /<ChapterTimeEnd>\s*([^<]+?)\s*<\/ChapterTimeEnd>/i.exec(rest);
    const titleM = /<ChapterString>\s*([^<]*?)\s*<\/ChapterString>/i.exec(rest);
    out.push({ start: toSec(m[1]), end: endM ? toSec(endM[1]) : undefined, title: titleM ? titleM[1] : null });
  }
  return out;
}

/** OGM/simple chapters: CHAPTERnn=HH:MM:SS.mmm / CHAPTERnnNAME=Title. */
function parseTxt(txt: string): { start: number; end?: number; title: string | null }[] {
  const times = new Map<string, number>(), names = new Map<string, string>();
  for (const line of txt.split(/\r?\n/)) {
    let m = /^CHAPTER(\d+)\s*=\s*(.+)$/i.exec(line.trim());
    if (m) { times.set(m[1], toSec(m[2])); continue; }
    m = /^CHAPTER(\d+)NAME\s*=\s*(.*)$/i.exec(line.trim());
    if (m) names.set(m[1], m[2]);
  }
  return [...times.keys()].sort().map((k) => ({ start: times.get(k)!, title: names.get(k) ?? null }));
}

/** Return chapters from a media file's sidecar, or [] if none is found. */
export function readSidecarChapters(mediaPath: string): SidecarChapter[] {
  if (!mediaPath) return [];
  let file: string | undefined, text: string | undefined;
  for (const c of candidates(mediaPath)) {
    try { if (existsSync(c)) { text = readFileSync(c, "utf8"); file = c; break; } } catch { /* keep looking */ }
  }
  if (!file || text == null) return [];
  const raw = /\.txt$/i.test(file) ? parseTxt(text) : parseXml(text);
  if (!raw.length) return [];
  // End times: use explicit end, else the next chapter's start; last spans to itself.
  return raw.map((c, i) => ({
    id: i,
    start: ts(c.start),
    end: ts(c.end ?? (i + 1 < raw.length ? raw[i + 1].start : c.start)),
    title: c.title && c.title.length ? c.title : null,
  }));
}
