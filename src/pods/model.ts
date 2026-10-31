// -----------------------------------------------------------------------------
// Pod authoring model
// -----------------------------------------------------------------------------
// A "pod" is a reusable, named building block for a channel, authored in the web
// UI and compiled into the engine's content/sequence/pod constructs (and to
// YAML). Three kinds:
//   - break  : a mid-roll commercial break (be-back -> commercials -> back-to)
//   - filler : a tail/pad block (promos/bumpers that pad to a clock boundary)
//   - show   : a complete program unit (preroll + show + mid-roll break +
//              postroll + up-next + clock alignment) — the thing you schedule.
//
// Pods reference *content*. A ContentSource is either a raw search query or a
// point-and-click pick (show / collection / library) that compiles to a query.

export type PlaybackOrder = "chronological" | "shuffle";

/** How a pod segment selects its media. `kind:"query"` is the raw engine query;
 *  the others are conveniences that compile down to a query/collection. */
export interface ContentSource {
  kind: "query" | "show" | "collection" | "library" | "show_bumper" | "next_bumper";
  /** kind:"query" — a full search query, e.g. `type:episode AND show_title:"Rugrats"`. */
  query?: string;
  /** kind:"show" — a show title; kind:"collection" — a collection name;
   *  kind:"library" — a library name. */
  value?: string;
  /** kind:"show_bumper" — a bumper phrase (e.g. "be right back" / "back to")
   *  matched by NAME together with the *current* show's title.
   *  kind:"next_bumper" — an "up next" phrase matched by NAME together with the
   *  *next scheduled* show's title (resolved by the scheduler at build time;
   *  falls back to phrase-only in standalone preview). */
  phrase?: string;
  /** How many items to play from this source per block (pre/post-roll; default 1). */
  count?: number;
  /** Optional duration window (minutes) for show/library picks. */
  minMinutes?: number;
  maxMinutes?: number;
  /** Optional media-type filter (default: any; show_bumper -> other_video). */
  type?: string; // episode | movie | other_video | ...
  order?: PlaybackOrder;
}

export type PodType = "break" | "filler" | "show";

export interface BreakPodConfig {
  leadIn?: ContentSource;   // e.g. "be right back - <show>"
  body: ContentSource;      // the commercials
  bodyCount?: number;       // fixed number of commercials (default 4) when no target
  target?: string;          // e.g. "2 minutes" -> fill commercials to length instead
  tolerance?: string;       // acceptable over/under when filling (default "15 seconds")
  leadOut?: ContentSource;  // e.g. "back to - <show>"
  noRepeat?: string;        // don't reuse an item seen within this window
}

export interface FillerPodConfig {
  content: ContentSource;   // promos / bumpers / commercials
  align?: number;           // pad to next N-minute boundary (0 = just one item)
  fillerKind?: "preroll" | "midroll" | "postroll";
  trim?: boolean;           // trim the last item to hit the boundary exactly
  count?: number;           // when not aligning: how many to play (default 1)
}

export interface ShowPodMidRoll {
  breakPodId: string;                 // which Break pod to insert
  mode: "chapters" | "interval" | "count";
  interval?: string;                  // interval mode: e.g. "8 minutes"
  breaks?: number;                    // max number of breaks
  minSegment?: string;                // don't cut a segment shorter than this
  expression?: string;                // advanced: raw mid-roll expression (overrides mode)
}

export interface ShowPodConfig {
  show: ContentSource;                // the program
  order?: PlaybackOrder;
  preroll?: ContentSource[];          // bumpers before the show
  midRoll?: ShowPodMidRoll;           // optional commercial break
  postroll?: ContentSource[];         // promos after the show
  upNext?: ContentSource;             // an "up next / then" bumper
  tailFillerPodId?: string;           // a Filler pod for the tail (instead of raw commercials)
  tailFiller?: ContentSource;         // OR ad-hoc tail filler content
  align?: number;                     // clock-align the block to an N-minute boundary
  trimTail?: boolean;                 // trim tail filler to hit the boundary (default true)
  epgGroup?: boolean;                 // wrap in a guide group (default true)
}

export interface Pod {
  id: string;                         // stable slug/key (uppercased, used in YAML)
  name: string;                       // human label
  type: PodType;
  config: BreakPodConfig | FillerPodConfig | ShowPodConfig;
  updatedAt?: string;
}

/** Normalize an id/name into a YAML-safe uppercase key. */
export function podKey(id: string): string {
  return String(id).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
