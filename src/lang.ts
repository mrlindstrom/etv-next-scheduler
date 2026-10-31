// -----------------------------------------------------------------------------
// Preferred-language track selection.
// -----------------------------------------------------------------------------
// ErsatzTV *next* has no channel-level "preferred audio/subtitle language"; it
// picks the first stream of each kind unless the playout item names a specific
// stream via `tracks`. So to honor a channel default language we resolve, per
// item, which audio/subtitle stream matches the preference and stamp its
// absolute ffprobe index onto the item. Files with a single audio stream are
// left untouched (the server plays the only track regardless of its language).

import type { Playout, PlayoutItem } from "./model.js";
import type { ContentResolver, MediaStreamInfo } from "./resolver.js";

export interface LanguagePrefs {
  audio?: string;     // ISO 639-2 code, e.g. "eng" ("" / undefined = no preference)
  /** English subtitles, burned in: "off" (default), "on" (full subs) or "forced"
   *  (only for dialogue that isn't in English). */
  subtitles?: string;
}

// Common language aliases → a single canonical token, so a stream tagged "en" or
// "English" matches a preference of "eng" (and vice-versa). Anything not listed
// falls through as its own lowercased value, which still matches exact codes.
const CANON: Record<string, string> = {
  en: "eng", eng: "eng", english: "eng",
  es: "spa", spa: "spa", esp: "spa", spanish: "spa", "español": "spa",
  fr: "fre", fre: "fre", fra: "fre", french: "fre", "français": "fre",
  de: "ger", ger: "ger", deu: "ger", german: "ger", deutsch: "ger",
  it: "ita", ita: "ita", italian: "ita", italiano: "ita",
  pt: "por", por: "por", portuguese: "por",
  ru: "rus", rus: "rus", russian: "rus",
  ja: "jpn", jpn: "jpn", jap: "jpn", japanese: "jpn",
  ko: "kor", kor: "kor", korean: "kor",
  zh: "chi", chi: "chi", zho: "chi", chinese: "chi", mandarin: "chi",
  nl: "dut", dut: "dut", nld: "dut", dutch: "dut",
};

export function canonLang(s: string | undefined | null): string {
  const t = String(s ?? "").trim().toLowerCase();
  if (!t || t === "und" || t === "unknown") return "";
  return CANON[t] ?? t;
}

function langMatches(streamLang: string | undefined, pref: string): boolean {
  const p = canonLang(pref);
  if (!p) return false;
  return canonLang(streamLang) === p;
}

/** Pick the audio stream index matching `pref`, or undefined to leave the server
 *  default. Only selects when there's a real choice (≥2 audio streams). Among
 *  matches prefers a default-flagged stream, then the one with the most channels. */
function pickAudio(streams: MediaStreamInfo[], pref: string): number | undefined {
  const audio = streams.filter((s) => s.kind === "audio");
  if (audio.length < 2) return undefined;             // nothing to choose between
  const matches = audio.filter((s) => langMatches(s.language, pref));
  if (!matches.length) return undefined;              // no track in the wanted language
  matches.sort((a, b) => Number(b.default) - Number(a.default) || (b.channels ?? 0) - (a.channels ?? 0) || a.index - b.index);
  return matches[0].index;
}

const SUB_LANG = "eng";
/** A partial subtitle track (only foreign-language dialogue, or on-screen signs
 *  and songs): flagged forced, or titled that way (many files only say so in the title). */
const isForcedSub = (s: MediaStreamInfo) => !!s.forced || /\b(forced|foreign|signs?|songs?)\b/i.test(s.title ?? "");

/** The audio stream that will play: the one chosen for the item, else the
 *  default-flagged one, else the first. */
function playingAudio(streams: MediaStreamInfo[], chosen: number | undefined): MediaStreamInfo | undefined {
  const audio = streams.filter((s) => s.kind === "audio");
  return audio.find((s) => s.index === chosen) ?? audio.find((s) => s.default) ?? audio[0];
}

/** Pick the English subtitle stream for a channel's subtitles setting, or
 *  undefined for none.
 *  - "on": full subtitles — a regular (not forced-only) track, default-flagged
 *    first; a forced-only track is used only when it's all the file has.
 *  - "forced": the forced track, which covers just the non-English dialogue.
 *    When the audio itself isn't English, all the dialogue is foreign, so the
 *    full subtitles are used instead. */
function pickSubtitle(streams: MediaStreamInfo[], mode: string, audioIdx: number | undefined): number | undefined {
  const subs = streams.filter((s) => s.kind === "subtitle" && langMatches(s.language, SUB_LANG));
  if (!subs.length || (mode !== "on" && mode !== "forced")) return undefined;
  const full = subs.filter((s) => !isForcedSub(s)).sort((a, b) => Number(b.default) - Number(a.default) || a.index - b.index);
  const forced = subs.filter(isForcedSub).sort((a, b) => Number(b.default) - Number(a.default) || a.index - b.index);
  if (mode === "on") return (full[0] ?? forced[0])?.index;
  const audioLang = canonLang(playingAudio(streams, audioIdx)?.language);
  if (audioLang && audioLang !== SUB_LANG) return (full[0] ?? forced[0])?.index;
  return forced[0]?.index;
}

/** Stamp preferred audio/subtitle stream indices onto each local playout item.
 *  Mutates `playout.items` in place. Returns how many items were adjusted. */
export function applyLanguageTracks(playout: Playout, resolver: ContentResolver, prefs: LanguagePrefs): number {
  const wantAudio = canonLang(prefs.audio);
  const subMode = prefs.subtitles === "on" || prefs.subtitles === "forced" ? prefs.subtitles : "";
  if (!wantAudio && !subMode) return 0;
  if (typeof resolver.streamsForPath !== "function") return 0;

  let changed = 0;
  for (const it of playout.items as PlayoutItem[]) {
    const src = it.source;
    if (!src || src.source_type !== "local" || !src.path) continue;
    const streams = resolver.streamsForPath(src.path);
    if (!streams || !streams.length) continue;

    const audioIdx = wantAudio ? pickAudio(streams, wantAudio) : undefined;
    const subIdx = subMode ? pickSubtitle(streams, subMode, audioIdx) : undefined;
    if (audioIdx == null && subIdx == null) continue;

    const tracks = it.tracks ?? {};
    if (audioIdx != null) tracks.audio = { stream_index: audioIdx };
    if (subIdx != null) tracks.subtitle = { stream_index: subIdx };
    it.tracks = tracks;
    changed++;
  }
  return changed;
}
