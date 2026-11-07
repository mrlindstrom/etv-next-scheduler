// Classic "Schedule" module — a form-driven, ordered list of blocks (mirrors
// ErsatzTV legacy's ProgramSchedule). Each block picks content (a search query or
// a collection), a play order, and how much to play (flood / N items / N minutes),
// with optional per-block mid-roll ad breaks and optional clock alignment (pad the
// block's end to the next :00/:30/etc. barrier with filler). Blocks loop to fill
// the day and compile to the same PlayoutDoc the YAML module produces.
import type { ContentDef, Instruction, PlayoutDoc, PodDef, PlaybackOrder } from "../yaml.js";
import type { Field, SchedulingModule, ModuleSummary } from "./module.js";
import { parseCollectionRef } from "../collection-ref.js";
import { stationIdContent, STATION_FIELDS, type StationOptions } from "./station.js";

interface Block {
  content: string;                 // search query or collection name
  source: "search" | "collection";
  order: PlaybackOrder;
  fill: "flood" | "count" | "duration";
  count?: number;                  // fill === count
  minutes?: number;                // fill === duration
  title?: string;                  // custom guide title
  align?: string;                  // clock barrier in minutes ("0" = off, "30", …)
  fillerLibraries?: string[];      // local libraries: mid-roll breaks + end padding
  ads?: boolean;                   // insert mid-roll breaks
  adMode?: "interval" | "count" | "chapters";
  adInterval?: number;             // minutes between breaks (interval)
  adBreaks?: number;               // number of breaks (count)
  adTarget?: number;               // target break length, minutes
  // legacy field name (pre-rename); read for back-compat
  adLibraries?: string[];
  // Filler drawn from a collection ("<type>::<name>", see collection-ref) —
  // ErsatzTV legacy's filler presets. Each overrides fillerLibraries for its role.
  preRoll?: string;                // pre-roll: N items before each program item
  preRollCount?: number;
  adCollection?: string;           // mid-roll breaks
  adCount?: number;                // items per break (instead of a target length)
  adTags?: NonNullable<ContentDef["tags"]>;  // mid-roll: only filler matching a rule (a tag, or a path of tags all on the item)
  padCollection?: string;          // clock-alignment padding (legacy post-roll "pad")
  fallbackCollection?: string;     // fills whatever the padding couldn't
  alignFit?: boolean;              // aligned blocks budget mid-roll breaks to the item's slot (default true)
  upNext?: boolean;                // up-next card after the block when it isn't padded (back-to-back)
  overlays?: string[];             // overlays (library ids) shown during this block, on top of the channel's own
  inGuide?: boolean;               // false = plays like filler, with no guide entry of its own (legacy guide mode "filler")
}
interface ScheduleConfig extends StationOptions { blocks: Block[]; }

const ORDERS = ["shuffle", "chronological", "random", "season_episode", "shuffle_in_order", "multi_episode_shuffle"];
const quote = (n: string) => `"${String(n).replace(/"/g, "")}"`;
const fillLibsQuery = (libs: string[]) => libs.map(quote).join(" OR ");

function contentDef(key: string, source: string, value: string, order: PlaybackOrder): ContentDef {
  if (source === "collection") {
    const { type, name } = parseCollectionRef(value);
    const kind = type === "smart" ? "smart_collection" : type === "multi" ? "multi_collection" : type === "playlist" ? "playlist" : "collection";
    return { key, kind, order, collection: type === "playlist" ? undefined : name, playlist: type === "playlist" ? name : undefined, raw: {} };
  }
  return { key, kind: "search", order, query: value, raw: {} };
}

export function compileBlocks(cfg: ScheduleConfig): PlayoutDoc {
  const content: ContentDef[] = [];
  const pods: Record<string, PodDef> = {};
  const playout: Instruction[] = [];

  (cfg.blocks ?? []).forEach((b, i) => {
    if (!b.content) return;
    const key = `b${i}`;
    content.push(contentDef(key, b.source, b.content, b.order || "shuffle"));

    // shared filler pool (local libraries) for both mid-roll breaks and padding
    const fillerLibs = (b.fillerLibraries ?? b.adLibraries ?? []).filter(Boolean);
    const hasFiller = fillerLibs.length > 0;
    const fillerKey = `b${i}_fill`;
    if (hasFiller) content.push(contentDef(fillerKey, "search", `library_name:(${fillLibsQuery(fillerLibs)})`, "shuffle"));
    // a collection-sourced filler role, else the shared library pool (if any)
    const roleKey = (role: string, ref: string | undefined): string | null => {
      if (ref) { const k = `b${i}_${role}`; content.push(contentDef(k, "collection", ref, "shuffle")); return k; }
      return hasFiller ? fillerKey : null;
    };
    // mid-roll limited to filler with certain tags: its own pool, so padding keeps everything
    const adTags = (b.adTags ?? []).filter(Boolean);
    let adKey = b.ads ? roleKey("mid", b.adCollection) : null;
    if (adKey && adTags.length) {
      if (adKey === fillerKey) { adKey = `b${i}_mid`; content.push({ ...contentDef(adKey, "search", `library_name:(${fillLibsQuery(fillerLibs)})`, "shuffle"), tags: adTags }); }
      else { const d = content.find((c) => c.key === adKey); if (d) d.tags = adTags; }
    }
    const padKey = roleKey("pad", b.padCollection);
    const fallbackKey = b.fallbackCollection ? roleKey("fallback", b.fallbackCollection) ?? undefined : undefined;

    // per-block mid-roll ad breaks: N items per break, or filled to a target length
    if (adKey) {
      const podKey = `b${i}_pod`;
      pods[podKey] = b.adCount
        ? { key: podKey, slots: [{ content: adKey, count: Math.max(1, b.adCount), fillerKind: "midroll" }] }
        : { key: podKey, target: `${b.adTarget ?? 2} minutes`, slots: [{ content: adKey, fill: true, fillerKind: "midroll" }] };
      playout.push({ op: "mid_roll", enabled: true, pod: podKey, mode: b.adMode || "interval", interval: `${b.adInterval ?? 15} minutes`, breaks: b.adBreaks ?? 2 }); // defaults match the form's
    } else {
      playout.push({ op: "mid_roll", enabled: false });
    }
    if (b.preRoll) {
      const preKey = `b${i}_pre`;
      content.push(contentDef(preKey, "collection", b.preRoll, "shuffle"));
      playout.push({ op: "pre_roll_on", content: preKey, count: Math.max(1, b.preRollCount ?? 1) });
    }

    const barrier = Number(b.align || 0);

    const overlays = (b.overlays ?? []).filter(Boolean);
    for (const o of overlays) playout.push({ op: "graphics_on", element: o });

    // fill mode, wrapped in an EPG group so each block becomes a guide entry.
    // For a clock-aligned count, `fitMinutes` gives each item a slot that runs to
    // the first barrier after it (a 45-min episode on a :00/:30 grid gets an
    // hour) and budgets its mid-roll breaks to end there; with alignFit off
    // (legacy post-roll pad) breaks aren't budgeted and the item pads to the
    // next barrier after it finishes.
    const grouped = b.inGuide !== false;
    if (grouped) playout.push({ op: "epg_group", value: true });
    if (b.fill === "count") playout.push({ op: "count", content: key, count: Math.max(1, b.count ?? 1), fillerKind: grouped ? undefined : "postroll", customTitle: b.title, fitMinutes: barrier > 0 && b.alignFit !== false ? barrier : undefined });
    else if (b.fill === "duration") playout.push({ op: "duration", content: key, duration: `${Math.max(1, b.minutes ?? 30)} minutes`, fallback: fallbackKey });
    else playout.push({ op: "pad_until", content: key, when: "00:00", tomorrow: true }); // flood to end of day
    if (b.preRoll) playout.push({ op: "pre_roll_off" });

    // clock alignment: pad the block's end to the next barrier using the filler.
    // (The next block therefore starts exactly on a barrier.)
    const padded = barrier > 0 && !!padKey && b.fill !== "flood";
    if (padded) {
      if (adKey) playout.push({ op: "mid_roll", enabled: false }); // don't break the pad filler
      // Without fallback, trim the final filler item so the block ends exactly on
      // the barrier. With fallback (legacy), whole filler items play and the
      // fallback content covers — and is trimmed to — whatever gap remains.
      playout.push({ op: "pad_to_next", content: padKey!, minutes: barrier, fillerKind: b.padCollection ? "postroll" : "tail", trim: !fallbackKey, fallback: fallbackKey });
    }
    // Padded blocks get the card at the start of their padding automatically; a
    // back-to-back block can ask for one straight after it (inside its guide
    // entry, so the next programme's entry starts when the card ends).
    if (b.upNext && !padded && b.fill !== "flood") playout.push({ op: "up_next", afterProgram: true });
    if (grouped) playout.push({ op: "epg_group", value: false });
    for (const o of overlays) playout.push({ op: "graphics_off", element: o });
  });

  playout.push({ op: "repeat" });
  // era-matched commercials: every filler pool (breaks + padding) follows the airing show's year
  if (cfg.matchEra) for (const c of content) if (/_(fill|mid|pad)$/.test(c.key)) c.matchEra = true;
  const sid = stationIdContent(cfg);
  if (sid) content.push(sid);
  return { content, sequences: {}, pods, dayparts: [], reset: [], playout, stationId: sid ? sid.key : undefined };
}

const SCHEMA: Field[] = [
  {
    type: "list", key: "blocks", label: "Blocks", addLabel: "+ Add block", itemTitle: "content",
    help: "Blocks play top-to-bottom and the whole list loops to fill the day.",
    fields: [
      { type: "select", key: "source", label: "Content from", options: [{ value: "search", label: "Search query" }, { value: "collection", label: "Collection" }], default: "search" },
      { type: "query", key: "content", label: "Search query", placeholder: 'type:episode AND show_title:"Rugrats"', help: "A search query — test it on the Browse tab.", showIf: { key: "source", equals: "search" } },
      { type: "collection", key: "content", label: "Collection", help: "Pick a collection; the tag shows its type (manual / smart / multi / playlist).", showIf: { key: "source", equals: "collection" } },
      { type: "select", key: "order", label: "Play order", options: ORDERS.map((o) => ({ value: o, label: o.replace(/_/g, " ") })), default: "shuffle" },
      { type: "select", key: "fill", label: "How much", options: [{ value: "count", label: "Play N items" }, { value: "duration", label: "Play N minutes" }, { value: "flood", label: "Flood (fill the day)" }], default: "count" },
      { type: "number", key: "count", label: "N items (for 'Play N items')", default: 1, min: 1 },
      { type: "number", key: "minutes", label: "N minutes (for 'Play N minutes')", default: 30, min: 1 },
      { type: "text", key: "title", label: "Guide title (optional)" },
      {
        type: "select", key: "align", label: "Align block to clock", default: "0",
        help: "Pad the block's end to the next clock barrier with filler, so the next block starts on the barrier. Needs filler libraries.",
        options: [
          { value: "0", label: "Off (back-to-back)" },
          { value: "60", label: "Top of hour (:00)" },
          { value: "30", label: "Half hour (:00, :30)" },
          { value: "15", label: "Quarter hour (:00, :15, :30, :45)" },
          { value: "10", label: "Every 10 min" },
          { value: "5", label: "Every 5 min" },
          { value: "1", label: "Every minute" },
        ],
      },
      { type: "libraries", key: "fillerLibraries", label: "Filler libraries", help: "Local libraries used for mid-roll breaks and clock-alignment padding (commercials, bumpers, promos). Pick one or more." },
      { type: "checkbox", key: "ads", label: "Insert mid-roll ad breaks" },
      { type: "select", key: "adMode", label: "Break spacing", options: [{ value: "interval", label: "Every N minutes" }, { value: "count", label: "N breaks per half hour of show" }, { value: "chapters", label: "At chapter marks" }], default: "interval" },
      { type: "number", key: "adInterval", label: "Minutes between breaks", default: 15, min: 1 },
      { type: "number", key: "adBreaks", label: "Breaks per half hour (for 'N breaks')", default: 2, min: 1, help: "A ~22-minute show gets this many breaks, a ~44-minute show twice as many, a 90-minute movie three times." },
      { type: "number", key: "adTarget", label: "Break length (minutes)", default: 2, min: 1 },
      { type: "collection", key: "adCollection", label: "Mid-roll filler collection (optional)", help: "Fill breaks from this collection instead of the filler libraries." },
      { type: "number", key: "adCount", label: "Items per break (collection; blank = fill to break length)", min: 1 },
      { type: "tags", key: "adTags", label: "Only mid-roll filler with these tags (optional)", libraries: "fillerLibraries", collection: "adCollection", showIf: { key: "ads", equals: true as any },
        help: "The filler's tags, laid out like its folders. Tick a tag to play what's tagged with it (PSA); untick one under it to leave that out (PSA AND NOT Christmas); tick several and breaks mix them. Nothing ticked = any filler. Clock-alignment padding still uses all of it." },
      { type: "collection", key: "preRoll", label: "Pre-roll collection (optional)", help: "Play items from this collection before each program." },
      { type: "number", key: "preRollCount", label: "Pre-roll items", default: 1, min: 1 },
      { type: "collection", key: "padCollection", label: "Clock-alignment filler collection (optional)", help: "Pad to the clock barrier from this collection instead of the filler libraries (legacy post-roll pad)." },
      { type: "checkbox", key: "alignFit", label: "Aligned: keep ad breaks inside each show's slot", default: true, help: "Shows of any length are aligned: a show longer than the slot takes as many as it needs (a 44-minute show fills an hour on a half-hour grid). Off = breaks aren't budgeted to the slot and can push the show past the next mark (legacy behavior)." },
      { type: "checkbox", key: "upNext", label: "Show the up-next card after this block", help: "For blocks that aren't aligned to the clock: the card plays right after the block, then the next item starts. Aligned blocks already show it at the start of their padding. Uses the channel's up-next theme (Channels page) and needs up-next cards turned on (Streaming page).", showIf: { key: "align", equals: ["0", ""] } },
      { type: "collection", key: "fallbackCollection", label: "Fallback filler collection (optional)", help: "Covers any gap the padding can't fill exactly; its last item is trimmed." },
      { type: "checkbox", key: "inGuide", label: "Show this block in the guide", default: true, help: "Off = it plays like filler (bumpers, interstitials) with no guide entry of its own." },
      { type: "overlays", key: "overlays", label: "Overlays during this block", help: "Graphics shown over this block's programmes (lower thirds, a special bug…), on top of the channel's own overlays. Make them on the Overlays page." },
    ],
  },
  ...STATION_FIELDS,
];

export const blocksModule: SchedulingModule = {
  id: "schedule",
  label: "Block scheduling",
  description: "Form-driven ordered blocks: pick content, play order, how much to play, and optional clock alignment + mid-roll ads. Loops to fill the day.",
  editor: "form",
  fileExts: [".schedule.json"],
  saveExt: ".schedule.json",
  defaultConfig: () => JSON.stringify({ blocks: [{ source: "search", content: "type:episode", order: "shuffle", fill: "count", count: 1, align: "0" }] }, null, 2),
  schema: () => SCHEMA,
  compile: (raw) => compileBlocks(JSON.parse(raw)),
  summarize: (raw): ModuleSummary => {
    try {
      const cfg = JSON.parse(raw) as ScheduleConfig;
      const bs = (cfg.blocks ?? []).filter((b) => b.content);
      if (!bs.length) return { valid: false, error: "Add at least one block with content." };
      return { valid: true, blocks: bs.length, ads: bs.filter((b) => b.ads && (b.fillerLibraries ?? b.adLibraries ?? []).length).length, aligned: bs.filter((b) => Number(b.align || 0) > 0).length };
    } catch (e) { return { valid: false, error: (e as Error).message }; }
  },
};
