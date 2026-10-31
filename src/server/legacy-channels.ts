// -----------------------------------------------------------------------------
// Import ErsatzTV legacy channels + their Classic schedules as Schedule (blocks)
// channels, so existing channels don't have to be recreated by hand.
// -----------------------------------------------------------------------------
// planLegacyImport() is read-only: it reads the legacy DB and returns, per
// channel, the proposed `.schedule.json` config, channel settings and a list of
// warnings for anything that doesn't translate exactly. applyLegacyImport()
// writes only the channels the caller selects.
//
// Mapping (legacy enums from ErsatzTV.Core.Domain):
//   ProgramScheduleItem One / Flood / Multiple / Duration -> block fill count / flood / count N / duration
//     (a schedule with a single One/Flood item just loops that item, so it becomes count 1)
//   CollectionType Collection / Smart / Multi / Playlist   -> collection refs "<type>::<name>"
//   CollectionType TelevisionShow / TelevisionSeason       -> search query, pinned by the show's guid
//   FillerPreset PreRoll (count)  -> preRoll + preRollCount
//   FillerPreset MidRoll (count | duration) -> chapter mid-roll from adCollection (adCount | adTarget)
//   FillerPreset PostRoll (pad N) -> align N + padCollection, alignFit off (pad after any item)
//   FillerPreset Tail / Fallback  -> fallbackCollection (channel fallback when the item has none)
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toImmutableUri } from "../sqlite-resolver.js";
import { makeCollectionRef, type CollKind } from "../collection-ref.js";
import type { ChannelMeta } from "./config.js";
import { legacyLogoFile, importLegacyLogo, hasRealLogo } from "./channel-logos.js";

// legacy enums
const PLAYBACK_ORDER: Record<number, { order: string; warn?: string }> = {
  0: { order: "shuffle", warn: "play order 'None' imported as shuffle" },
  1: { order: "chronological" }, 2: { order: "random" }, 3: { order: "shuffle" },
  4: { order: "shuffle_in_order" }, 5: { order: "multi_episode_shuffle" }, 6: { order: "season_episode" },
  7: { order: "shuffle", warn: "play order 'Random Rotation' imported as shuffle" },
  8: { order: "chronological", warn: "play order 'Marathon' imported as chronological (marathon grouping isn't supported)" },
};
const FILLER = { PreRoll: 1, MidRoll: 2, PostRoll: 3, Tail: 4, Fallback: 5 } as const;
const FILLER_MODE = { None: 0, Duration: 1, Count: 2, Pad: 3, RandomCount: 4 } as const;
const SCHEDULE_KIND: Record<number, LegacyChannelPlan["kind"]> = { 1: "classic", 2: "block", 3: "yaml" };

export interface LegacyChannelPlan {
  key: string;               // "<number>|<name>" — unique across legacy DB copies (playout ids are not)
  playoutId: number;
  channelId: number;
  number: string;
  name: string;              // channel name in this app (= config file base name)
  kind: "classic" | "block" | "yaml" | "other";
  schedule: string | null;   // legacy schedule name / YAML path
  file: string | null;       // config file this import would write
  status: "new" | "exists" | "unsupported";
  config: string | null;     // proposed file contents
  yamlSource?: string;       // YAML playouts: the legacy file to copy
  // An existing channel whose name differs only in capitalization. On Windows
  // (and other case-insensitive file systems) the two would share one config
  // file and one playout folder, so this plan can't be imported — even with
  // "replace" — until one of them is renamed.
  caseClash?: string;
  // Another of your channels already uses this channel number (its name), and a
  // free number to use instead. Numbers must be unique across the lineup.
  numberClash?: string;
  suggestedNumber?: string;
  meta: Partial<ChannelMeta>;
  // the channel's legacy logo: a cached file (by its cache key) or a URL; `file`
  // is missing when the cache key is known but the file isn't on this machine
  logo?: { hash?: string; file?: string; url?: string };
  warnings: string[];
}

function openLegacy(path: string): DatabaseSync {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout=10000;");
    db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get(); // some mounts open fine but fail the first read
    return db;
  } catch {
    try { db?.close(); } catch { /* ignore */ }
    return new DatabaseSync(toImmutableUri(path), { readOnly: true });
  }
}

/** A file-system-safe channel name (the config file's base name). */
export function channelFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "") || "channel";
}

const q = (s: string) => `"${String(s).replace(/"/g, "")}"`;
const GUID_PREF = ["tvdb", "imdb", "tmdb", "plex"];

import { normalizeChannelNumber, suggestChannelNumber } from "../channel-numbers.js";
export { normalizeChannelNumber, suggestChannelNumber };

export function planLegacyImport(legacyDbPath: string, opts: {
  channelsDir: string; existing: Set<string>; libraryDbPath?: string;
  // numbers your channels already use: normalized number -> channel name
  existingNumbers?: Map<string, string>;
  // legacy databases whose artwork cache (next to each) may hold channel logos
  logoDbPaths?: string[];
}): LegacyChannelPlan[] {
  const db = openLegacy(legacyDbPath);
  // Collections are resolved from the app's imported library, so flag any that
  // were created in legacy after the library import.
  let lib: DatabaseSync | null = null;
  try { if (opts.libraryDbPath && existsSync(opts.libraryDbPath)) lib = new DatabaseSync(toImmutableUri(opts.libraryDbPath), { readOnly: true }); } catch { lib = null; }
  try {
    const one = (sql: string, ...a: any[]): any => db.prepare(sql).get(...a);
    const all = (sql: string, ...a: any[]): any[] => db.prepare(sql).all(...a) as any[];
    const has = (t: string) => !!one(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, t);
    const colsOf = (t: string) => new Set(all(`SELECT name FROM pragma_table_info('${t}')`).map((r) => r.name));
    const libHas = (table: string, name: string) => { if (!lib) return true; try { return !!lib.prepare(`SELECT 1 FROM ${table} WHERE Name=?`).get(name); } catch { return true; } };

    const presets = new Map<number, any>(all(`SELECT * FROM FillerPreset`).map((f) => [f.Id, f]));

    /** Legacy content (by CollectionType) -> block content + source. */
    const content = (ct: number, it: any, warnings: string[], where: string): { source: "search" | "collection"; content: string } | null => {
      const ref = (kind: CollKind, table: string, id: number | null) => {
        const name = id == null ? null : one(`SELECT Name n FROM ${table} WHERE Id=?`, id)?.n;
        if (!name) { warnings.push(`${where}: its ${kind} collection no longer exists in legacy`); return null; }
        if (!libHas(table, name)) warnings.push(`${where}: ${kind} collection "${name}" isn't in your imported library yet — re-import the library (or recreate it) before building`);
        return { source: "collection" as const, content: makeCollectionRef(kind, name) };
      };
      const showPin = (showId: number) => {
        const title = one(`SELECT Title t FROM ShowMetadata WHERE ShowId=?`, showId)?.t as string | undefined;
        if (!title) return null;
        const guids = all(`SELECT g.Guid g FROM MetadataGuid g JOIN ShowMetadata sm ON sm.Id=g.ShowMetadataId WHERE sm.ShowId=?`, showId).map((r) => String(r.g));
        // Pin by the show's external id alone: titles differ by region and get
        // renamed (legacy's "The Great British Bake Off" is Plex's "…Baking Show").
        for (const scheme of GUID_PREF) {
          const g = guids.find((x) => x.toLowerCase().startsWith(scheme + "://"));
          if (g) return `type:episode AND show_guid:${q(`${scheme}://${g.slice(scheme.length + 3)}`)}`;
        }
        warnings.push(`${where}: show "${title}" has no external id, so it's matched by title (show_title also matches longer titles containing it)`);
        return `type:episode AND show_title:${q(title)}`;
      };
      switch (ct) {
        case 0: return ref("collection", "Collection", it.CollectionId);
        case 4: return ref("multi", "MultiCollection", it.MultiCollectionId);
        case 5: return ref("smart", "SmartCollection", it.SmartCollectionId);
        case 6: return ref("playlist", "Playlist", it.PlaylistId);
        case 1: { const s = showPin(it.MediaItemId); if (!s) { warnings.push(`${where}: its show no longer exists in legacy`); return null; } return { source: "search", content: s }; }
        case 2: {
          const se = one(`SELECT ShowId, SeasonNumber FROM Season WHERE Id=?`, it.MediaItemId);
          const s = se ? showPin(se.ShowId) : null;
          if (!s) { warnings.push(`${where}: its season no longer exists in legacy`); return null; }
          return { source: "search", content: `${s} AND season_number:${se.SeasonNumber}` };
        }
        default: warnings.push(`${where}: content type ${ct} isn't supported by the importer`); return null;
      }
    };

    /** A filler preset's content as a collection ref (show/season filler can't be a collection). */
    const fillerRef = (f: any, warnings: string[], role: string): string | null => {
      const c = content(f.CollectionType, f, warnings, `${role} filler "${f.Name}"`);
      if (!c) return null;
      if (c.source !== "collection") { warnings.push(`${role} filler "${f.Name}" uses a show/season, which filler can't use yet — skipped`); return null; }
      if (f.Expression) warnings.push(`${role} filler "${f.Name}" has a filler expression, which isn't imported`);
      if (f.UseChaptersAsMediaItems) warnings.push(`${role} filler "${f.Name}" uses chapters as media items, which isn't supported`);
      return c.content;
    };

    const channelCols = colsOf("Channel");
    const col = (c: string) => (channelCols.has(c) ? `c."${c}"` : "NULL");
    const rows = all(`SELECT p.Id pid, p.ScheduleKind sk, p.ProgramScheduleId psid, ${has("Playout") && colsOf("Playout").has("ScheduleFile") ? "p.ScheduleFile" : "NULL"} yaml,
        c.Id cid, c.Number num, c.Name name, ${col("Group")} grp, ${col("IsEnabled")} enabled, ${col("FallbackFillerId")} chFallback,
        ${col("PreferredAudioLanguageCode")} audio, ${col("PreferredSubtitleLanguageCode")} subs, ${col("SubtitleMode")} submode, ${col("WatermarkId")} wm
      FROM Playout p JOIN Channel c ON c.Id=p.ChannelId ORDER BY CAST(c.Number AS REAL), c.Number`);

    // channel logos: Artwork rows of kind Logo (2) — a cache key into legacy's
    // artwork/logos folder, or (newer legacy) an external URL
    const logoDbs = [legacyDbPath, ...(opts.logoDbPaths ?? [])];
    const logoOf = (channelId: number): LegacyChannelPlan["logo"] => {
      if (!has("Artwork") || !colsOf("Artwork").has("ChannelId")) return undefined;
      const path = one(`SELECT Path p FROM Artwork WHERE ChannelId=? AND ArtworkKind=2 ORDER BY Id DESC LIMIT 1`, channelId)?.p as string | undefined;
      if (!path) return undefined;
      if (/^https?:\/\//i.test(path)) return { url: path };
      return { hash: path, file: legacyLogoFile(logoDbs, path) ?? undefined };
    };

    const plans: LegacyChannelPlan[] = [];
    // existing channel names, compared ignoring case (see LegacyChannelPlan.caseClash)
    const existingLower = new Map([...opts.existing].map((n) => [n.toLowerCase(), n]));
    const setStatus = (plan: LegacyChannelPlan) => {
      const other = existingLower.get(plan.name.toLowerCase());
      if (!other) { plan.status = "new"; return; }
      plan.status = "exists";
      if (other !== plan.name) {
        plan.caseClash = other;
        plan.warnings.push(`you already have a channel named "${other}" — names that differ only in capitalization share the same files on Windows, so rename one of them to import this`);
      }
    };
    for (const r of rows) {
      const warnings: string[] = [];
      const name = channelFileName(String(r.name ?? `Channel ${r.num}`));
      const kind = SCHEDULE_KIND[r.sk] ?? "other";
      const meta: Partial<ChannelMeta> = { number: String(r.num ?? ""), group: r.grp ?? "", enabled: r.enabled == null ? true : !!r.enabled, tvgId: name };
      if (r.audio) meta.audioLang = r.audio;
      // legacy subtitle mode: 0 None, 1 Forced, 2 Default, 3 Any (older DBs: language only)
      meta.subtitles = r.submode == null ? (r.subs ? "forced" : "off") : Number(r.submode) === 1 ? "forced" : Number(r.submode) >= 2 ? "on" : "off";
      if (r.wm) warnings.push("channel watermark isn't imported — set it up under graphics");
      if (name !== String(r.name)) warnings.push(`renamed to "${name}" (characters not allowed in file names)`);
      const plan: LegacyChannelPlan = { key: `${meta.number}|${name}`, playoutId: r.pid, channelId: r.cid, number: meta.number!, name, kind, schedule: null, file: null, status: "unsupported", config: null, meta, warnings, logo: logoOf(r.cid) };
      if (plan.logo?.hash && !plan.logo.file) warnings.push("its logo isn't in legacy's artwork cache on this machine — upload one on the channel after importing");
      plans.push(plan);

      if (kind === "yaml") {
        plan.schedule = r.yaml ?? null;
        plan.file = `${name}.yml`;
        if (r.yaml && existsSync(r.yaml)) { plan.yamlSource = r.yaml; setStatus(plan); }
        else warnings.push(`YAML file ${r.yaml ?? "(none)"} isn't reachable from here — copy it into the channels folder yourself`);
        continue;
      }
      if (kind !== "classic") { warnings.push(kind === "block" ? "Block schedules aren't importable yet" : `schedule kind ${r.sk} isn't importable`); continue; }

      const ps = one(`SELECT * FROM ProgramSchedule WHERE Id=?`, r.psid);
      if (!ps) { warnings.push("its schedule no longer exists"); continue; }
      plan.schedule = ps.Name;
      if (ps.ShuffleScheduleItems) warnings.push("'shuffle schedule items' isn't supported — items play in order");
      if (ps.RandomStartPoint) warnings.push("'random start point' isn't supported — playback starts at the beginning of the order");
      if (ps.TreatCollectionsAsShows) warnings.push("'treat collections as shows' isn't supported");
      if (has("ProgramScheduleAlternate") && one(`SELECT 1 FROM ProgramScheduleAlternate WHERE PlayoutId=?`, r.pid)) warnings.push("alternate schedules (by day/month) aren't imported — only the main schedule");

      const items = all(`SELECT i.*, o.Id isOne, f.Id isFlood, m.Id isMulti, m.Count mCount, m.MultipleMode mMode, d.Id isDur, d.PlayoutDuration dur, d.TailMode tailMode
          FROM ProgramScheduleItem i
          LEFT JOIN ProgramScheduleOneItem o ON o.Id=i.Id LEFT JOIN ProgramScheduleFloodItem f ON f.Id=i.Id
          LEFT JOIN ProgramScheduleMultipleItem m ON m.Id=i.Id LEFT JOIN ProgramScheduleDurationItem d ON d.Id=i.Id
         WHERE i.ProgramScheduleId=? ORDER BY i."Index"`, r.psid);
      if (!items.length) { warnings.push("its schedule has no items"); continue; }
      const loopSingle = items.length === 1 && (items[0].isOne || items[0].isFlood);

      const blocks: any[] = [];
      items.forEach((it: any, n: number) => {
        const where = `item ${n + 1}`;
        const c = content(it.CollectionType, it, warnings, where);
        if (!c) return;
        const ord = PLAYBACK_ORDER[it.PlaybackOrder] ?? { order: "shuffle", warn: `play order ${it.PlaybackOrder} imported as shuffle` };
        if (ord.warn) warnings.push(`${where}: ${ord.warn}`);
        const b: any = { source: c.source, content: c.content, order: ord.order, align: "0" };

        if (loopSingle) { b.fill = "count"; b.count = 1; }
        else if (it.isOne) { b.fill = "count"; b.count = 1; }
        else if (it.isFlood) b.fill = "flood";
        else if (it.isMulti) {
          b.fill = "count";
          const nCount = Number(it.mCount);
          b.count = Number.isFinite(nCount) && nCount > 0 ? nCount : 1;
          if (it.mMode && it.mMode !== 0) warnings.push(`${where}: 'multiple' by collection/playlist size imported as a fixed count of ${b.count}`);
        } else if (it.isDur) {
          b.fill = "duration";
          const m = /^(?:(\d+)\.)?(\d+):(\d+):(\d+)/.exec(String(it.dur ?? ""));
          b.minutes = m ? Math.max(1, Math.round(Number(m[1] ?? 0) * 1440 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 60)) : 30;
          if (it.tailMode === 1 || it.tailMode === 2) warnings.push(`${where}: duration tail '${it.tailMode === 1 ? "offline" : "slate"}' isn't supported — the next block starts when content runs out`);
        } else { warnings.push(`${where}: unknown item type, imported as one item`); b.fill = "count"; b.count = 1; }

        if (it.StartTime) warnings.push(`${where}: fixed start time ${it.StartTime} isn't supported — blocks play back-to-back`);
        if (it.CustomTitle) b.title = it.CustomTitle;
        if (it.GuideMode) warnings.push(`${where}: guide mode 'filler' isn't supported`);
        if (it.MarathonGroupBy || it.FillWithGroupMode) warnings.push(`${where}: marathon / fill-with-group settings aren't supported`);
        if (it.PreferredAudioLanguageCode && !meta.audioLang) meta.audioLang = it.PreferredAudioLanguageCode;

        // filler presets
        const pre = presets.get(it.PreRollFillerId), mid = presets.get(it.MidRollFillerId), post = presets.get(it.PostRollFillerId);
        const tail = presets.get(it.TailFillerId), fb = presets.get(it.FallbackFillerId) ?? presets.get(r.chFallback);
        if (pre) {
          const ref = fillerRef(pre, warnings, "pre-roll");
          if (ref) {
            b.preRoll = ref;
            b.preRollCount = pre.FillerMode === FILLER_MODE.Count && pre.Count ? pre.Count : 1;
            if (pre.FillerMode !== FILLER_MODE.Count) warnings.push(`pre-roll filler "${pre.Name}": only 'count' mode is supported — imported as ${b.preRollCount} item`);
          }
        }
        if (mid) {
          const ref = fillerRef(mid, warnings, "mid-roll");
          if (ref) {
            b.ads = true; b.adMode = "chapters"; b.adCollection = ref;
            if (mid.FillerMode === FILLER_MODE.Count && mid.Count) b.adCount = mid.Count;
            else if (mid.FillerMode === FILLER_MODE.Duration && mid.Duration) { const m = /(\d+):(\d+):(\d+)/.exec(mid.Duration); b.adTarget = m ? Math.max(1, Number(m[1]) * 60 + Number(m[2])) : 2; }
            else { b.adCount = 1; warnings.push(`mid-roll filler "${mid.Name}": mode ${mid.FillerMode} imported as 1 item per break`); }
          }
        }
        if (post) {
          const ref = fillerRef(post, warnings, "post-roll");
          if (ref && post.FillerMode === FILLER_MODE.Pad && post.PadToNearestMinute) {
            b.align = String(post.PadToNearestMinute); b.padCollection = ref; b.alignFit = false;
          } else if (ref) warnings.push(`post-roll filler "${post.Name}": only 'pad to nearest minute' is supported — skipped`);
        }
        const fbPreset = it.isDur ? (tail ?? fb) : fb;
        if (tail && !it.isDur) warnings.push(`tail filler "${tail.Name}" only applies to duration items — skipped`);
        if (fbPreset) { const ref = fillerRef(fbPreset, warnings, fbPreset === tail ? "tail" : "fallback"); if (ref) b.fallbackCollection = ref; }
        blocks.push(b);
      });
      if (!blocks.length) { warnings.push("nothing in its schedule could be imported"); continue; }

      plan.file = `${name}.schedule.json`;
      setStatus(plan);
      plan.config = JSON.stringify({ imported: { from: "ErsatzTV legacy", channel: `${r.num} ${r.name}`, schedule: ps.Name, warnings }, blocks }, null, 2);
    }

    // channel numbers: clashes with your existing channels (a suggestion is
    // offered), and legacy channels that share a number with each other
    const used = new Set([...(opts.existingNumbers?.keys() ?? []), ...plans.map((p) => normalizeChannelNumber(p.number))]);
    for (const p of plans) {
      const owner = opts.existingNumbers?.get(normalizeChannelNumber(p.number));
      if (owner && owner.toLowerCase() !== p.name.toLowerCase()) {
        p.numberClash = owner;
        p.suggestedNumber = suggestChannelNumber(p.number, used);
        used.add(normalizeChannelNumber(p.suggestedNumber));
        p.warnings.push(`channel number ${p.number} is already used by your channel "${owner}" — import it as ${p.suggestedNumber} or pick another number`);
      }
    }
    const byNum = new Map<string, LegacyChannelPlan[]>();
    for (const p of plans) { const k = normalizeChannelNumber(p.number); (byNum.get(k) ?? byNum.set(k, []).get(k)!).push(p); }
    for (const [num, ps] of byNum) if (num && ps.length > 1) for (const p of ps) p.warnings.push(`legacy channel number ${p.number} is shared with ${ps.filter((x) => x !== p).map((x) => x.name).join(", ")} — only one can keep it`);
    const byName = new Map<string, number>();
    for (const p of plans) { const k = p.name.toLowerCase(); byName.set(k, (byName.get(k) ?? 0) + 1); }
    for (const p of plans) if ((byName.get(p.name.toLowerCase()) ?? 0) > 1) { p.warnings.push(`another legacy channel is also named "${p.name}" — only one can be imported`); }
    return plans;
  } finally {
    db.close();
    try { lib?.close(); } catch { /* ignore */ }
  }
}

/** Legacy deletes a schedule's items when their show/season is removed (e.g. a
 *  Plex rescan re-creating shows), so an older copy of the legacy DB may still
 *  hold a schedule the live one lost. Plan against each DB in order and, per
 *  channel, keep the first plan that produced a config. */
export function planLegacyImportMulti(paths: string[], opts: Parameters<typeof planLegacyImport>[1]): LegacyChannelPlan[] {
  const [primary, ...others] = paths.filter((p) => p && existsSync(p));
  if (!primary) return [];
  const plans = planLegacyImport(primary, opts);
  for (const alt of others) {
    const altPlans = new Map(planLegacyImport(alt, opts).map((p) => [`${p.channelId}|${p.number}`, p]));
    plans.forEach((p, i) => {
      if (p.config || p.yamlSource) return;
      const a = altPlans.get(`${p.channelId}|${p.number}`);
      if (a && (a.config || a.yamlSource)) {
        a.warnings.unshift(`recovered from ${alt} — the live legacy DB lost this schedule's items`);
        plans[i] = a;
      }
    });
  }
  return plans;
}

// ---- content check (what would each imported channel actually air?) ---------
export type ContentFix = "refresh-metadata" | "scan-source" | "import-library" | "enable-library" | null;
export interface ContentProblem { role: string; what: string; reason: string; fix: ContentFix; }
export interface ContentCheck { items: number; airsNothing: boolean; problems: ContentProblem[]; }
const ROLE: Record<string, string> = { "": "main content", _mid: "mid-roll filler", _pad: "post-roll filler", _pre: "pre-roll filler", _fallback: "fallback filler" };

/** Resolve a plan's content against the library the way a build would, and
 *  explain anything that comes back empty with the fix the user should run. */
export async function checkPlanContent(
  plan: LegacyChannelPlan,
  resolver: { resolveContent(def: any): Promise<unknown[]> },
  libraryDbPath: string,
  // the same resolver WITHOUT disabled libraries (created lazily, only when needed)
  unfiltered?: () => { resolveContent(def: any): Promise<unknown[]> },
): Promise<ContentCheck | null> {
  if (!plan.config) return null;
  const { compileBlocks } = await import("../scheduling/blocks-module.js");
  const doc = compileBlocks(JSON.parse(plan.config));
  let lib: DatabaseSync | null = null;
  try { if (existsSync(libraryDbPath)) lib = new DatabaseSync(toImmutableUri(libraryDbPath), { readOnly: true }); } catch { lib = null; }
  const get = (sql: string, ...a: any[]): any => { try { return lib?.prepare(sql).get(...a); } catch { return undefined; } };
  const count = async (def: any) => { try { return (await resolver.resolveContent(def)).length; } catch { return 0; } };
  try {
    const problems: ContentProblem[] = [];
    let items = 0, mainEmpty = true;
    for (const def of doc.content) {
      const m = /^b\d+(.*)$/.exec(def.key); const suffix = m?.[1] ?? "";
      if (suffix === "_fill") continue; // library pool (not used by imports)
      const n = await count(def);
      if (!suffix) { items += n; if (n > 0) mainEmpty = false; }
      if (n > 0) continue;
      const role = ROLE[suffix] ?? "content";
      const name = def.collection ?? def.playlist ?? "";
      const what = def.kind === "search" ? (def.query ?? "") : `${def.kind.replace("_", " ")} "${name}"`;
      let reason = "matches nothing in your library", fix: ContentFix = null;
      const table = { collection: "Collection", smart_collection: "SmartCollection", multi_collection: "MultiCollection", playlist: "Playlist" }[def.kind as string];
      const inDisabled = async (d: any) => { if (!unfiltered) return false; try { return (await unfiltered().resolveContent(d)).length > 0; } catch { return false; } };
      if (table && lib && !get(`SELECT 1 FROM ${table} WHERE Name=?`, name)) {
        reason = "it isn't in your imported library (created in legacy after the library import)"; fix = "import-library";
      } else if (def.kind === "playlist" && !get(`SELECT 1 FROM PlaylistItem pi JOIN Playlist p ON p.Id=pi.PlaylistId WHERE p.Name=? LIMIT 1`, name)) {
        reason = "the playlist has no items (it's empty in legacy too)";
      } else {
        const query: string = def.kind === "search" ? def.query : def.kind === "smart_collection" ? (get(`SELECT Query q FROM SmartCollection WHERE Name=?`, name)?.q ?? "") : "";
        if (/\b(director|writer|actor):/i.test(query)) {
          reason = "it searches by director/writer/actor, which many items in your library don't have yet"; fix = "refresh-metadata";
        }
      }
      if (fix === null && reason === "matches nothing in your library") {
        if (await inDisabled(def)) { reason = "its media is only in libraries you've disabled"; fix = "enable-library"; }
        else if (def.kind === "search" && /\bshow_guid:/i.test(def.query ?? "")) {
          const id = /\bshow_guid:"?([^"\s]+)/i.exec(def.query ?? "")?.[1] ?? "";
          reason = `no show in your library has id ${id} yet — if the show is there, scan its source so it gets matched to its ids`; fix = "scan-source";
        }
      }
      problems.push({ role, what, reason, fix });
    }
    return { items, airsNothing: mainEmpty, problems };
  } finally { try { lib?.close(); } catch { /* ignore */ } }
}

export interface ApplyResult { imported: { name: string; file: string; logo?: boolean }[]; skipped: { name: string; reason: string }[]; }

/** Write the selected plans' configs into the channels folder and register their
 *  channel settings. Existing channels are only replaced when `overwrite` is set. */
export async function applyLegacyImport(
  plans: LegacyChannelPlan[], keys: string[], channelsDir: string,
  store: LogoStore,
  opts: {
    overwrite?: boolean;
    numbers?: Record<string, string>;         // plan key -> channel number to import it as
    existingNumbers?: Map<string, string>;    // normalized number -> your channel using it
    logosDir?: string;                        // where channel logos are stored
  } = {},
): Promise<ApplyResult> {
  const want = new Set(keys);
  const out: ApplyResult = { imported: [], skipped: [] };
  await mkdir(channelsDir, { recursive: true });
  const done = new Set<string>();
  // numbers are unique across the lineup: yours plus everything imported so far
  const taken = new Map(opts.existingNumbers ?? []);
  for (const p of plans) {
    if (!want.has(p.key)) continue;
    if (done.has(p.name.toLowerCase())) { out.skipped.push({ name: p.name, reason: "another selected channel has the same name" }); continue; }
    const number = String(opts.numbers?.[p.key] ?? p.meta.number ?? p.number ?? "").trim();
    if (!number) { out.skipped.push({ name: p.name, reason: "it needs a channel number" }); continue; }
    const owner = taken.get(normalizeChannelNumber(number));
    if (owner && owner.toLowerCase() !== p.name.toLowerCase()) { out.skipped.push({ name: p.name, reason: `channel number ${number} is already used by "${owner}"` }); continue; }
    if (p.status === "unsupported" || !p.file) { out.skipped.push({ name: p.name, reason: p.warnings[0] ?? "not importable" }); continue; }
    if (p.caseClash) { out.skipped.push({ name: p.name, reason: `it would collide with your channel "${p.caseClash}" (same name ignoring capitalization) — rename one first` }); continue; }
    if (p.status === "exists" && !opts.overwrite) { out.skipped.push({ name: p.name, reason: "a channel with this name already exists" }); continue; }
    const dest = join(channelsDir, p.file);
    if (p.yamlSource) await copyFile(p.yamlSource, dest);
    else await writeFile(dest, p.config!, "utf8");
    // the legacy logo comes along — but a replaced channel keeps a logo you set
    const logo = !hasRealLogo(store.channelMeta?.(p.name)) && opts.logosDir ? await legacyLogoValue(p, opts.logosDir) : null;
    store.upsertChannelMeta(p.name, { ...p.meta, number, ...(logo ? { logo } : {}) });
    taken.set(normalizeChannelNumber(number), p.name);
    done.add(p.name.toLowerCase());
    out.imported.push({ name: p.name, file: p.file, logo: !!logo });
  }
  return out;
}

type LogoStore = {
  upsertChannelMeta(name: string, patch: Partial<ChannelMeta>): unknown;
  channelMeta?(name: string): { logo?: string; logoGenerated?: boolean } | null | undefined;
};

/** A plan's legacy logo as a channel `logo` value (stored file or URL), or null. */
async function legacyLogoValue(p: LegacyChannelPlan, logosDir: string): Promise<string | null> {
  if (p.logo?.url) return p.logo.url;
  return p.logo?.file ? importLegacyLogo(logosDir, p.logo.file) : null;
}

/** For channels you already have (same name as a legacy channel): copy over their
 *  legacy logos. Only channels without a logo, unless `replace`. */
export async function applyLegacyLogos(plans: LegacyChannelPlan[], store: LogoStore & { channelMeta(name: string): { logo?: string; logoGenerated?: boolean } | null | undefined },
  logosDir: string, opts: { names?: string[]; replace?: boolean } = {}): Promise<{ updated: string[]; missing: string[] }> {
  const want = opts.names ? new Set(opts.names) : null;
  const out = { updated: [] as string[], missing: [] as string[] };
  const seen = new Set<string>();
  for (const p of plans) {
    if (p.status !== "exists" || p.caseClash || !p.logo || seen.has(p.name) || (want && !want.has(p.name))) continue;
    seen.add(p.name);
    if (hasRealLogo(store.channelMeta(p.name)) && !opts.replace) continue;
    const logo = await legacyLogoValue(p, logosDir);
    if (!logo) { out.missing.push(p.name); continue; }
    store.upsertChannelMeta(p.name, { logo });
    out.updated.push(p.name);
  }
  return out;
}
