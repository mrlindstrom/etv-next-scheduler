// -----------------------------------------------------------------------------
// Domain model + ErsatzTV "next" playout output types
// -----------------------------------------------------------------------------
// The "next" streamer consumes a flat, time-stamped list of items that point at
// concrete media files (schema: ErsatzTV/next schema/playout.json). Our job is
// to turn a legacy ErsatzTV YAML playout + legacy metadata into that list.

export type Millis = number;

/** A chapter marker on a media item. Interior boundaries are the mid-roll break
 *  points ErsatzTV uses (i.e. the start of every chapter after the first). */
export interface Chapter {
  startMs: Millis;
  endMs: Millis;
  title?: string;
}

/** A concrete, playable piece of media resolved from the legacy database. */
export interface MediaItem {
  id: string;
  /** For an unexpanded show/season entry (whose `id` is synthetic): the real
   *  Show.Id / Season.Id — what artwork and collections key on. */
  refId?: string;
  /** The show/season this item was expanded from when the content listed whole
   *  shows (e.g. a collection of shows), so shuffle can balance by show. */
  group?: string;
  /** Absolute path on disk, as ErsatzTV "next" LocalSource expects. */
  path: string;
  durationMs: Millis;
  /** Chapter markers (may be empty). Used for chapter-based mid-roll. */
  chapters: Chapter[];
  title?: string;
  /** episode | movie | other_video | image | song ... (legacy media kind) */
  kind?: string;
  // ordering hints for chronological playback
  season?: number;
  episodeNumber?: number;
  aired?: string; // ISO date
  releaseDate?: string; // ISO date
  // guide (XMLTV) metadata
  showTitle?: string;   // series title (for episodes)
  plot?: string;        // description
  year?: number;
  /** music videos: the artist (from its folder, as legacy did; the title is the song) */
  artist?: string;
  tags?: string[];      // content tags (used to classify interstitials in the preview)
  /** For multi-segment episodes (e.g. `1x01a`, `1x01b`, `1x01c`): the ordered
   *  segment items that make up one logical episode. When set, this item is a
   *  synthetic group whose `durationMs` is the sum of its segments; the engine
   *  airs every segment back-to-back as one block. Undefined for normal items. */
  segments?: MediaItem[];
}

// --- ErsatzTV "next" playout JSON (subset of the official schema) ------------

export type WatermarkLocation =
  | "top_left" | "top_center" | "top_right"
  | "center_left" | "center" | "center_right"
  | "bottom_left" | "bottom_center" | "bottom_right";

export interface LocalSource {
  source_type: "local";
  path: string;
  in_point_ms?: number;
  out_point_ms?: number;
}

/** A synthetic source produced by an ffmpeg lavfi filter graph (e.g. a solid
 *  color background or silent audio for a generated interstitial). */
export interface LavfiSource {
  source_type: "lavfi";
  params: string;
}

/** Pre-supplied probe metadata so `next` skips ffprobe and opens the source only
 *  once (at playback). Used for the up-next canvas so the render endpoint is hit
 *  once per airing instead of twice (probe + play). */
export interface ProbeHint {
  video?: { stream_index: number; codec: string; width: number; height: number; pix_fmt: string; frame_rate?: string }[];
  audio?: { stream_index: number; codec: string; channels: number }[];
  subtitle?: { stream_index: number; codec: string }[];
  format_name?: string | null;
  duration_ms?: number | null;
}

/** A remote source fetched over HTTP(S). Used for the live "up next" graphics
 *  canvas (an endpoint that streams a full-frame RGBA card). */
export interface HttpSource {
  source_type: "http";
  uri: string;
  headers?: string[];
  user_agent?: string;
  timeout_us?: number;
  reconnect?: boolean;
  /** A live stream (no seeking, no fixed length), e.g. a relayed IPTV channel. */
  is_live?: boolean;
  probe_hint?: ProbeHint;
}

/** An external command whose stdout is an MPEG-TS stream (next proxies it). Used
 *  for the TV-guide scroller channel (a `guide-stream` CLI invocation). */
export interface ScriptSource {
  source_type: "script";
  command: string;
  args?: string[];
  is_live?: boolean;
  probe_hint?: ProbeHint;
}

export type PlayoutItemSource = LocalSource | LavfiSource | HttpSource | ScriptSource;

/** Cyclical visibility for a graphics layer: fade in, hold, fade out, once per
 *  `frequency_ms`. With `clock: "content"` the cycle is measured from the start
 *  of the playout item, so `phase_offset_ms` delays the (single) appearance and
 *  a large `frequency_ms` keeps it from repeating. Constraints (enforced by
 *  next): `2*fade_ms + hold_ms <= frequency_ms` and `fade_ms <= hold_ms`. */
export interface PeriodicTiming {
  timing_type: "periodic";
  clock: "wall" | "content";
  frequency_ms: number;
  hold_ms: number;
  phase_offset_ms?: number;
  disable_after_ms?: number;
  fade_ms?: number;
}

/** A graphics layer (image/video overlay) composited over the primary content.
 *  `kind: "media"` (default) is the classic watermark: positioned + faded via
 *  `timing` by next's own graphics engine. `kind: "canvas"` is a full-frame RGBA
 *  layer composited at (0,0) and content-locked (placement/opacity/timing
 *  ignored). We use stacked `media` layers so next does the fading natively. */
export interface GraphicsLayer {
  source: PlayoutItemSource;
  stream_index?: number;
  kind?: "media" | "canvas";
  location: WatermarkLocation;
  width_percent?: number;
  horizontal_margin_percent?: number;
  vertical_margin_percent?: number;
  opacity_percent?: number;
  /** margins measured from the visible picture, not the letterbox / pillarbox bars */
  within_source_content?: boolean;
  timing?: PeriodicTiming;
  /** canvas only (schema 0.0.7): where the canvas sits — the whole frame, or a region at its own size */
  layout?: { mode: "full_frame" } | { mode: "region"; origin: { x: number; y: number } };
}

/** Back-compat alias: a watermark is just a media graphics layer. */
export type Watermark = GraphicsLayer;

/** Per-track selection. A track may carry its own `source` (overriding the
 *  item's) and/or a specific `stream_index`. Omitting a track lets `next` pick
 *  the first stream of that kind from the effective source. */
export interface TrackSelection {
  source?: PlayoutItemSource;
  stream_index?: number;
}
export interface PlayoutItemTracks {
  video?: TrackSelection;
  audio?: TrackSelection;
  subtitle?: TrackSelection;
}

export interface PlayoutItem {
  id: string;
  start: string;  // RFC3339, e.g. 2026-04-13T00:24:21.527-05:00
  finish: string; // RFC3339
  /** Default source shared by any track that doesn't specify its own. Optional
   *  when every selected track provides its own `source` (e.g. a lavfi
   *  background item that only carries a graphics canvas). */
  source?: PlayoutItemSource;
  /** Optional per-track (audio/subtitle/video) stream/source selection. */
  tracks?: PlayoutItemTracks;
  watermark?: Watermark;
  /** Graphics overlay layers (schema 0.0.3+). Used for the up-next canvas. */
  graphics?: GraphicsLayer[];
}

export interface Playout {
  $schema?: string;
  version: string;
  generated_at?: string;
  items: PlayoutItem[];
}

// Default schema for playouts that use only long-standing features (widest next
// compatibility). Playouts that emit a graphics-canvas layer are stamped with
// PLAYOUT_VERSION_GRAPHICS instead (see engine.toPlayout), so an older next
// binary still accepts every channel that doesn't use the up-next card.
export const PLAYOUT_VERSION = "https://ersatztv.org/playout/version/0.0.2";
// 0.0.4 adds GraphicsLayer.kind ("canvas") — required only by the up-next card.
export const PLAYOUT_VERSION_GRAPHICS = "https://ersatztv.org/playout/version/0.0.4";
// 0.0.7 adds canvas `layout` (region) — animated overlays (ErsatzTV next 0.2.3+).
export const PLAYOUT_VERSION_LAYOUT = "https://ersatztv.org/playout/version/0.0.7";

/** A music video's title as a song name: without the "(Official Music Video)",
 *  "[Lyrics]" or download-id tags file names often carry. */
export function songTitle(t: string): string {
  const s = t
    .replace(/\s*[([][^)\]]*\b(official|music video|video|audio|lyrics?|visuali[sz]er|hd|hq|4k)\b[^)\]]*[)\]]/gi, "")
    .replace(/\s*\[[A-Za-z0-9_-]{11}\]/g, "")
    .replace(/\s{2,}/g, " ").trim();
  return s || t.trim();
}
