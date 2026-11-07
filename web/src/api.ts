// Typed API client for the Fastify backend.
export interface AppConfig { etvDbPath: string; channelsDir: string; outputDir: string; timeZone: string; tz?: string | number; days: number; autoBuild: boolean; buildIntervalMin: number; refreshThresholdHours: number; prunePast: boolean; includeSpecials: boolean; autoScanHours: number; keepNextRunning: boolean; legacyImport: boolean; selfUpdate?: "off" | "notify" | "install"; selfUpdateHour?: number; overlayPicturesDir?: string; }
export interface GitCommit { sha: string; subject: string; date: string }
export interface SelfUpdateStatus { available: boolean; reason: string | null; branch: string; upstream: string; current: GitCommit | null; behind: number; ahead: number; commits: GitCommit[]; blocked: string[]; checkedAt: number | null; checkError: string | null; underLauncher: boolean; bootId: string; staged: boolean; job: { phase: "running" | "restarting" | "staged" | "failed"; step: string; log: string[]; startedAt: number } | null; }
export interface UpdateComponent { id: "next" | "ffmpeg"; label: string; path: string; found: boolean; installed: string | null; latest: { tag: string; publishedAt: string; pageUrl: string; asset: string | null; size: number } | null; updateAvailable: boolean; note: string | null; }
export interface UpdateStatus { binDir: string; checkedAt: number | null; checkError: string | null; components: UpdateComponent[]; ffmpegRequired: string | null; job: { component: "next" | "ffmpeg"; phase: "downloading" | "extracting" | "installing" | "done" | "failed"; received: number; total: number; message: string; startedAt: number } | null; }
export interface NextRunnerStatus { enabled: boolean; phase: "stopped" | "waiting" | "starting" | "running" | "crashed"; detail: string; problem: string | null; pid: number | null; uptimeSec: number; port: number; stale: boolean; hasPlayouts: boolean; binaryFound: boolean; binaryPath: string; version: string | null; versionWarning: string | null; restarts: number; lastExit: { code: number | null; signal: string | null; at: number } | null; log: string[]; }
export interface SchedulerStatus { enabled: boolean; intervalMin?: number; thresholdHours?: number; running?: boolean; lastTick?: string | null; nextTickAt?: string | null; log?: string[]; }
export interface VerifyResult { ok: boolean; problems?: string[]; error?: string; path?: string; stats?: { mediaItems: number; episodes: number; shows: number; chapters: number }; }
export interface ChannelMeta { name: string; number: string; tvgId: string; logo: string; logoGenerated: boolean; group: string; enabled: boolean; sort: number; audioLang: string; subtitles: string; upNextTheme: string; upNextAudio: string; upNextText: string; encoding: string; fallbackImage: string; overlays: string[]; }
export type ContentFix = "refresh-metadata" | "scan-source" | "import-library" | "enable-library" | null;
export interface ContentCheck { items: number; airsNothing: boolean; problems: { role: string; what: string; reason: string; fix: ContentFix }[]; }
export interface LegacyChannelPlan { key: string; playoutId: number; channelId: number; number: string; name: string; kind: "classic" | "block" | "yaml" | "other"; schedule: string | null; file: string | null; status: "new" | "exists" | "unsupported"; config: string | null; warnings: string[]; check: ContentCheck | null; caseClash?: string; numberClash?: string; suggestedNumber?: string; logo?: { hash?: string; file?: string; url?: string }; hasLogo?: boolean; watermark?: { row: { Id: number; Name: string }; file?: string }; hasWatermark?: boolean; }
/** Where a channel's `logo` value can be shown from in the browser ("" = none):
 *  a stored logo ("logos/<file>", served by this server) or an external URL. */
export const logoSrc = (logo?: string): string => (!logo ? "" : /^https?:\/\//i.test(logo) ? logo : logo.startsWith("logos/") ? `/${logo}` : "");
/** A legacy channel's logo, for previews in the import list. */
export const legacyLogoSrc = (p: LegacyChannelPlan): string => p.logo?.url ?? (p.logo?.hash && p.logo.file ? `/api/legacy/logo/${p.logo.hash}` : "");
// ---- overlays (timed graphics over programmes; see src/overlays.ts) ----
import type { LayerAnim } from "../../src/overlay-anim.js";
export type { LayerAnim } from "../../src/overlay-anim.js";
interface OvBox { x: number; y: number; w: number; h: number; opacity?: number; anim?: LayerAnim; appear?: { at?: number; for?: number } }
export type OverlayLayer =
  | (OvBox & { type: "image"; src: string; fallback?: string })
  | (OvBox & { type: "text"; text: string; font?: string; size?: number; color?: string; bold?: boolean; italic?: boolean; upper?: boolean; align?: "left" | "center" | "right"; valign?: "top" | "middle" | "bottom"; outline?: string; outlineWidth?: number; shadow?: boolean; fit?: boolean })
  | (OvBox & { type: "box"; color?: string; radius?: number; border?: string; borderWidth?: number; gradient?: { to: string; dir?: "right" | "down" } })
  | (OvBox & { type: "video"; src: string; fallback?: string });
export interface OverlayTiming { mode: "always" | "every" | "start" | "end" | "media"; everyMinutes?: number; showSeconds?: number; offsetSeconds?: number; media?: OverlayMedia }
/** The file that sets off a "when a video plays" overlay. */
export interface OverlayMedia { path: string; title?: string; durationMs?: number }
/** One frame of a library file (drawn by the server's ffmpeg), for the designer's reference. */
export const referenceFrameUrl = (path: string, t: number) => `/api/overlays/reference-frame?path=${encodeURIComponent(path)}&t=${t.toFixed(2)}`;
export type OverlayLocation = "top_left" | "top_center" | "top_right" | "center_left" | "center" | "center_right" | "bottom_left" | "bottom_center" | "bottom_right";
/** An imported ErsatzTV legacy graphics element (its YAML as written; filled in per item by builds). */
export interface LegacyElement { kind: "image" | "text" | "motion" | "subtitle" | "script"; yaml: string; file?: string }
export interface LegacyImported { id: string; name: string; kind: string; file: string; replaced: boolean; warnings: string[] }
export interface LegacyTest { item: { path: string; name: string; start: string; finish: string }; vars: [string, string][]; yaml: string; layers: Record<string, unknown>[]; problems: string[]; timing: string; preview: string | null; guideFound: boolean; error?: string }
export interface Overlay { id: string; name: string; layers: OverlayLayer[]; timing: OverlayTiming; motion?: "live" | "rendered"; legacy?: LegacyElement; fadeSeconds?: number; opacity?: number; duringFiller?: boolean; withinContent?: boolean; anchor?: { location: OverlayLocation; hMargin: number; vMargin: number; widthPercent?: number }; season?: OverlaySeason; category?: string; description?: string; updatedAt?: string }
export interface OverlaySeason { holiday?: string; before?: number; after?: number; from?: string; to?: string }
export interface OverlayMoment { file: string; itemId: string; itemStart: number; at: number; overlay: string; path: string; filler: boolean }
export interface OverlayField { key: string; label: string; sample: string; slot?: number }
/** Where an overlay asset (`assets/<file>`, or an absolute path on the server) shows in the browser. */
export const CHANNEL_LOGO = "channel-logo";
const LOGO_PLACEHOLDER = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect x="6" y="6" width="388" height="388" rx="40" fill="rgba(79,140,255,.25)" stroke="#4f8cff" stroke-width="8" stroke-dasharray="24 14"/><text x="200" y="185" font-family="Arial" font-weight="700" font-size="64" fill="#fff" text-anchor="middle">CHANNEL</text><text x="200" y="260" font-family="Arial" font-weight="700" font-size="64" fill="#fff" text-anchor="middle">LOGO</text></svg>');
export const overlayAssetSrc = (src: string): string => (src === CHANNEL_LOGO ? LOGO_PLACEHOLDER : src.startsWith("assets/") ? `/overlay-assets/${src.slice(7)}` : src.startsWith("example:") ? `/overlay-examples/${src.slice(8)}`
  : src.startsWith(MATCH_PREFIX) ? `/overlay-pictures/match?name=${encodeURIComponent(src.slice(MATCH_PREFIX.length))}` : "");
/** A layer source that picks a picture from the pictures folder by the schedule, e.g. `match:{{next_show}}`. */
export const MATCH_PREFIX = "match:";
/** A `match:` source filled in with these values (slashes in values dropped, as builds do). */
export const resolveMatch = (src: string, vars: Record<string, string>): string => {
  if (!src.startsWith(MATCH_PREFIX)) return src;
  const t = src.slice(MATCH_PREFIX.length).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k: string) => String(vars[k.toLowerCase()] ?? "").replace(/[\\/]+/g, " "));
  return MATCH_PREFIX + t.trim();
};
export interface OverlayPicture { name: string; size: number }
export interface OverlayPictures { dir: string; isDefault: boolean; files: OverlayPicture[]; truncated: boolean }

export interface ChannelSummary { name: string; file: string; mode?: string; valid: boolean; error?: string; meta?: ChannelMeta; contentDefs?: number; sequences?: number; pods?: number; dayparts?: number; blocks?: number; repeats?: boolean; ads?: number; }
export interface ShowIf { key: string; equals: string | string[]; }
export type SchemaField =
  | { type: "text" | "textarea" | "query"; key: string; label: string; help?: string; placeholder?: string; default?: string; showIf?: ShowIf }
  | { type: "number"; key: string; label: string; help?: string; default?: number; min?: number; max?: number; showIf?: ShowIf }
  | { type: "select"; key: string; label: string; help?: string; options: { value: string; label: string }[]; default?: string; showIf?: ShowIf }
  | { type: "checkbox"; key: string; label: string; help?: string; default?: boolean; showIf?: ShowIf }
  | { type: "collection"; key: string; label: string; help?: string; showIf?: ShowIf }
  | { type: "libraries"; key: string; label: string; help?: string; showIf?: ShowIf }
  | { type: "channel"; key: string; label: string; help?: string; showIf?: ShowIf }
  | { type: "tags"; key: string; label: string; help?: string; libraries?: string; collection?: string; showIf?: ShowIf }
  | { type: "overlays"; key: string; label: string; help?: string; showIf?: ShowIf }
  | { type: "list"; key: string; label: string; help?: string; addLabel?: string; itemTitle?: string; fields: SchemaField[]; showIf?: ShowIf };
/** What a remote stream channel's playlist and guide resolve to ("Check stream"). */
export interface RemoteProbe {
  error?: string;
  streamUrl?: string; name?: string; entries?: { name: string; tvgId: string }[];
  guide?: { url: string; count?: number; firstMs?: number; lastMs?: number; title?: string; error?: string } | null;
}
export interface SchedulingModuleInfo { id: string; label: string; description: string; editor: "yaml" | "form" | "pods" | "grid"; schema: SchemaField[] | null; defaultConfig: string; }
export interface ChannelDoc { name: string; config: string; yaml: string; mode: string; editor: "yaml" | "form" | "pods" | "grid"; schema: SchemaField[] | null; summary: any; }
export interface DayGroup { id: string; label: string; days: string[]; holiday?: string; dateFrom?: string; dateTo?: string; slots: string[]; }
export interface PodScheduleConfig { pods: Pod[]; groups: DayGroup[]; }
export interface NextConfig {
  runtimeDir: string; outputFolder: string; bindAddress: string; port: number; publicUrl: string; ffmpegPath: string; ffprobePath: string;
  /** shown when a channel has nothing to play: "black" | "standby" | an image path (channels can override) */
  fallbackImage: string;
  video: { width: number; height: number; codec: string; bitDepth: number; bitrateKbps: number; bufferKbps: number; accel: string; tonemapAlgorithm: string };
  audio: { codec: string; bitrateKbps: number; bufferKbps: number; channels: number; sampleRateHz: number; normalizeLoudness: boolean };
  upNext: { enabled: boolean; count: number; durationMs: number; fontFile: string };
  guide: { enabled: boolean; number: string; name: string; group: string; tvgId: string; musicFolder: string; columns: number; scrollSpeed: number; refreshMin: number; theme: string; promoRotateSec: number; promoFolder: string; logo: string };
  hdhr: { enabled: boolean; port: number; tuners: number; name: string; deviceId: string };
}
export interface HdhrStatus {
  enabled: boolean; listening: boolean; port: number; error: string; address: string; guideUrl: string;
  tuners: number; deviceId: string; name: string;
  inUse: { channel: string; name: string; client: string; sinceSec: number; mb: number }[];
}
export interface HdhrTest { ok: boolean; firstByteSec: number | null; seconds: number; mb: number; video: string; audio: string; problem: string; advice: string }
export interface ApplyResult { lineup: string; channels: { name: string; config: string }[]; skipped: string[]; }
export interface ImportJob { running: boolean; done: boolean; error: string | null; index: number; total: number; table: string; result: { tables: number; rows: number } | null; startedAt: number; }
export interface LibraryStatus { imported: boolean; libraryDbPath: string; source: string; job: ImportJob; stats?: { mediaItems: number; episodes: number; shows: number; chapters: number } | null; }
export interface SourceInfo { id: number; type: string; name: string; libraries: number; items: number; }
export interface LibraryInfo { id: number; name: string; kind: string; kindId: number; sourceId: number; sourceType: string; sourceName: string; lastScan: string | null; present: number; missing: number; remote: number; paths: string[]; enabled: boolean; hasToken?: boolean; }
export interface TrashItem { id: number; state: number; stateName: string; path: string | null; }
export interface LibraryPath { id: number; path: string; present: number; missing: number; }
export interface ScanJob { running: boolean; done: boolean; error: string | null; warning: string | null; note?: string | null; scope: "local" | "remote" | null; libraryId: number | null; sourceId: number | null; done_: number; total: number; added: number; updated: number; missing: number; current: string; result: { found: number; added: number; updated: number; unchanged: number; missing: number; errors: number } | null; startedAt: number; }
export interface PathReplacement { id: number; remote: string; local: string; }
export interface SourceConnection { type: "plex" | "jellyfin" | "emby" | null; address: string | null; importedAddress: string | null; hasToken: boolean; pathReplacements: { remote: string; local: string }[]; libraries: { libraryId: number; kind: number; providerKey: string; name: string }[]; }
export interface BuildJob { id: string; status: string; log: string[]; results: { channel: string; itemCount?: number; file?: string; error?: string }[]; }
export interface PlayoutWindow { file: string; start?: string; finish?: string; }
export interface ItemLabel { key?: string; fillerKind?: string; type?: string; tags?: string[]; }
export interface PlayoutItem { id: string; start: string; finish: string; source?: { path?: string; in_point_ms?: number; out_point_ms?: number }; graphics?: unknown[]; }
export interface PlayoutView { playout: { version: string; items: PlayoutItem[] }; labels: Record<string, ItemLabel>; }

export type PlaylistRef = { type: "collection" | "smart" | "multi" | "item"; id: number };
export interface PlaylistEntryInfo { id: number; index: number; ref: PlaylistRef; label: string; order: string; playAll: boolean; count: number | null; inGuide: boolean; items: number; }
export interface PlaylistDetail { id: number; name: string; entries: PlaylistEntryInfo[]; }
export interface BrowseCard { id: number; type: string; title: string; subtitle?: string; year?: number | null; durationMs?: number; episodes?: number; hasArt: boolean; }
export interface IndexStatus {
  phase: "off" | "idle" | "checking" | "rebuilding" | "updating" | "error";
  detail?: string; docs?: number; gen?: number; builtAt?: string; updatedAt?: string; error?: string; since?: number;
  last?: { kind: "rebuild" | "update"; docs: number; removed?: number; ms: number; at: string; reason?: string };
}
export interface SearchField { name: string; group: string; kind: "keyword" | "text" | "int" | "date" | "reldate" | "guid"; desc: string; example: string; values: boolean; }
export interface SearchItem { id: number; type: string; title: string; showTitle: string; season?: number; episode?: number; year?: number; durationMs: number; }
export interface DeepScanJob { running: boolean; done: boolean; error: string | null; type: string; id: number; done_: number; total: number; current: string; result: { targets: number; refreshed: number; failed: number; chapters: number } | null; }
export interface BrowseDetail { id: number; type: string; title: string; showTitle?: string; season?: number; episode?: number; year?: number | null; plot?: string | null; durationMs: number; path?: string; library?: string; genres: string[]; tags: string[]; studios: string[]; guids: string[]; streams: { kind: string; codec: string | null; language: string | null; channels?: number }[]; chapters: number; hasArt: boolean; }

// --- troubleshooting ---
export interface ProbeSummary { file: string; container?: string; durationSec?: number; sizeBytes?: number; bitrateKbps?: number; chapters: number; streams: { index: number; kind: string; codec: string; profile?: string; detail: string; language?: string; title?: string; default: boolean; forced: boolean }[]; error?: string; }
export interface TroubleSystem {
  scheduler: { version: string; node: string; os: string; cpu: string; cores: number; memoryGb: number };
  ffmpeg: { path: string; ok: boolean; version: string; hwaccels: string[]; encoders: string[] };
  ffprobe: { path: string; ok: boolean; version: string };
  next: { path: string; found: boolean; version: string; phase: string; detail: string; port: number; outputFolder: string };
  streaming: { codec: string; accel: string; accelLabel: string; encoder: string; size: string; bitrateKbps: number; audio: string };
}
export interface HwTestResult { accel: string; label: string; codec: string; encoder: string; ok: boolean; ms: number; error?: string; current: boolean; }
export interface TestRequest { kind: "item" | "upnext" | "playout" | "guide"; file?: string; itemId?: string; forceOverlay?: string; lead?: number; type?: string; id?: number; startSec?: number; at?: number; theme?: string; channel?: string; overlays?: boolean; durationSec?: number; accel?: string; }
export interface TestRun {
  id: string; label: string; status: "starting" | "running" | "finishing" | "done" | "failed" | "stopped"; message: string; startedAt: number; finishedAt?: number;
  request: TestRequest; accel: string; encoder: string; port: number; targetSec: number; capturedSec: number; firstSegmentSec?: number; speed?: number;
  pipelines: string[]; problems: string[]; log: string[]; source?: ProbeSummary; output?: ProbeSummary; video: boolean;
}
export interface CardSlot { startMs: number; finishMs: number; anchorMs: number; next: string; nextAt: string; }
export interface CardPreview { channel: string; theme: string; count: number; durationMs: number; textMode: string; width: number; height: number; layers: { url: string; phaseMs: number; fadeMs: number; holdMs: number }[]; rows: { label: string; title: string }[]; audio: boolean; audioName: string; enabled: boolean; }
const j = async (r: Response) => { if (!r.ok) throw new Error((await r.text()) || r.statusText); return r.json(); };
// Only send a JSON content-type when there's actually a body — otherwise Fastify
// rejects an empty body with content-type application/json (FST_ERR_CTP_EMPTY_JSON_BODY).
const opts = (m: string, body?: unknown): RequestInit =>
  body === undefined
    ? { method: m }
    : { method: m, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };

export const api = {
  // troubleshooting
  troubleSystem: (): Promise<TroubleSystem> => fetch("/api/troubleshoot/system").then(j),
  hwTest: (): Promise<{ results: HwTestResult[] }> => fetch("/api/troubleshoot/hwtest", opts("POST")).then(j),
  troubleProbe: (type: string, id: number): Promise<{ item: { title: string; durationMs: number; path: string; library?: string }; probe: ProbeSummary }> => fetch(`/api/troubleshoot/probe?type=${encodeURIComponent(type)}&id=${id}`).then(j),
  startTest: (r: TestRequest): Promise<TestRun> => fetch("/api/troubleshoot/play", opts("POST", r)).then(async (x) => { const b = await x.json(); if (!x.ok) throw new Error(b.error || x.statusText); return b; }),
  currentTest: (): Promise<TestRun | null> => fetch("/api/troubleshoot/play").then(j),
  testRun: (id: string): Promise<TestRun> => fetch(`/api/troubleshoot/play/${id}`).then(j),
  stopTest: (id: string): Promise<TestRun | null> => fetch(`/api/troubleshoot/play/${id}/stop`, opts("POST")).then(j),
  makeShareable: (id: string): Promise<{ sizeBytes: number }> => fetch(`/api/troubleshoot/play/${id}/shareable`, opts("POST")).then(async (x) => { const b = await x.json(); if (!x.ok) throw new Error(b.error || x.statusText); return b; }),
  cardSlots: (channel: string, from: number, to: number): Promise<{ slots: CardSlot[]; built: boolean }> => fetch(`/api/troubleshoot/upnext/slots?channel=${encodeURIComponent(channel)}&from=${from}&to=${to}`).then(j),
  cardPreview: (channel: string, at: number, theme?: string, durationMs?: number): Promise<CardPreview> => fetch(`/api/troubleshoot/upnext/card?channel=${encodeURIComponent(channel)}&at=${at}${theme ? `&theme=${encodeURIComponent(theme)}` : ""}${durationMs ? `&durationMs=${durationMs}` : ""}`).then(j),
  getConfig: (): Promise<AppConfig> => fetch("/api/config").then(j),
  setConfig: (c: Partial<AppConfig>): Promise<AppConfig> => fetch("/api/config", opts("PUT", c)).then(j),
  selfUpdate: (refresh = false): Promise<SelfUpdateStatus> => fetch(`/api/self-update${refresh ? "?refresh=1" : ""}`).then(j),
  version: (): Promise<{ version: string; commit: GitCommit | null; behind: number }> => fetch("/api/version").then(j),
  installSelfUpdate: (): Promise<SelfUpdateStatus | { error: string }> => fetch("/api/self-update/install", opts("POST")).then((r) => r.json()),
  verify: (path?: string): Promise<VerifyResult> => fetch("/api/db/verify", opts("POST", { path })).then(j),
  channels: (): Promise<ChannelSummary[]> => fetch("/api/channels").then(j),
  channel: (name: string): Promise<ChannelDoc> => fetch(`/api/channels/${name}`).then(j),
  saveChannel: (name: string, config: string) => fetch(`/api/channels/${name}`, opts("PUT", { config })).then(j),
  createChannel: (name: string, mode?: string) => fetch("/api/channels", opts("POST", { name, mode })).then(j),
  legacyChannels: (also?: string): Promise<{ sources?: string[]; usedNumbers?: Record<string, string>; channels?: LegacyChannelPlan[]; error?: string }> => fetch(`/api/legacy/channels${also ? `?also=${encodeURIComponent(also)}` : ""}`).then(j),
  importLegacyChannels: (keys: string[], overwrite: boolean, also?: string, numbers?: Record<string, string>): Promise<{ imported?: { name: string; file: string }[]; skipped?: { name: string; reason: string }[]; error?: string }> => fetch("/api/legacy/channels/import", opts("POST", { keys, overwrite, also, numbers })).then(j),
  buildChannels: (channels: string[]): Promise<{ jobId: string; channels: string[] }> => fetch("/api/build", opts("POST", { channels })).then(j),
  schedulingModules: (): Promise<SchedulingModuleInfo[]> => fetch("/api/scheduling/modules").then(j),
  probeRemote: (config: string): Promise<RemoteProbe> => fetch("/api/remote/probe", opts("POST", { config })).then(j),
  fileExists: (path: string): Promise<{ exists: boolean }> => fetch(`/api/file-exists?path=${encodeURIComponent(path)}`).then(j),
  setChannelMeta: (name: string, patch: Partial<ChannelMeta>): Promise<ChannelMeta> => fetch(`/api/channels/${name}/meta`, opts("PUT", patch)).then(j),
  uploadChannelLogo: (name: string, file: File): Promise<ChannelMeta> =>
    fetch(`/api/channels/${encodeURIComponent(name)}/logo`, { method: "POST", headers: { "Content-Type": file.type && file.type.startsWith("image/") ? file.type : "image/png" }, body: file }).then(j),
  uploadGuideLogo: (file: File): Promise<NextConfig> =>
    fetch("/api/guide/logo", { method: "POST", headers: { "Content-Type": file.type && file.type.startsWith("image/") ? file.type : "image/png" }, body: file }).then(j),
  removeGuideLogo: (): Promise<NextConfig> => fetch("/api/guide/logo", { method: "DELETE" }).then(j),
  removeChannelLogo: (name: string): Promise<ChannelMeta> => fetch(`/api/channels/${encodeURIComponent(name)}/logo`, { method: "DELETE" }).then(j),
  renumberChannels: (apply: boolean, start = 1): Promise<{ start: number; plan: { name: string; from: string; to: string; enabled: boolean }[]; changed: number; applied: boolean }> =>
    fetch("/api/channels/renumber", opts("POST", { apply, start })).then(j),
  generateMissingLogos: (): Promise<{ generated: string[] }> => fetch("/api/channels/logos/generate", { method: "POST" }).then(j),
  logoAddress: (): Promise<{ publicUrl: string; auto: string; effective: string }> => fetch("/api/logos/address").then(j),
  importLegacyLogos: (names?: string[], replace = false, also?: string): Promise<{ updated: string[]; missing: string[]; error?: string }> =>
    fetch("/api/legacy/channels/logos", opts("POST", { names, replace, also })).then(j),
  resetChannelProgress: (name: string): Promise<{ ok: boolean }> => fetch(`/api/channels/${name}/reset-progress`, opts("POST")).then(j),
  renameChannel: (name: string, to: string, keepGuideId: boolean): Promise<{ name?: string; meta?: ChannelMeta; timeshiftUpdated?: string[]; error?: string }> =>
    fetch(`/api/channels/${encodeURIComponent(name)}/rename`, opts("POST", { to, keepGuideId })).then((r) => r.json()),
  deleteChannel: (name: string) => fetch(`/api/channels/${name}`, opts("DELETE")).then(j),
  upNextThemes: (): Promise<{ id: string; label: string }[]> => fetch("/api/upnext/themes").then(j),
  guideThemes: (): Promise<{ id: string; label: string }[]> => fetch("/api/guide/themes").then(j),
  guideCheck: (): Promise<{ ffmpeg: string; found: boolean; drawtext: boolean }> => fetch("/api/guide/check").then(j),
  hdhr: (): Promise<HdhrStatus> => fetch("/api/hdhr").then(j),
  hdhrTest: (channel: string): Promise<HdhrTest> => fetch("/api/hdhr/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel }) }).then(j),
  logs: (n = 400): Promise<{ lines: string[] }> => fetch(`/api/logs?n=${n}`).then(j),
  clearLogs: (): Promise<{ ok: boolean }> => fetch("/api/logs/clear", opts("POST")).then(j),
  getNextConfig: (): Promise<NextConfig> => fetch("/api/next-config").then(j),
  setNextConfig: (patch: Partial<NextConfig>): Promise<NextConfig> => fetch("/api/next-config", opts("PUT", patch)).then(j),
  applyNext: (): Promise<ApplyResult> => fetch("/api/next/apply", opts("POST")).then(j),
  nextRunner: (): Promise<NextRunnerStatus> => fetch("/api/next/runner").then(j),
  nextStart: (): Promise<NextRunnerStatus> => fetch("/api/next/start", opts("POST")).then(j),
  nextStop: (): Promise<NextRunnerStatus> => fetch("/api/next/stop", opts("POST")).then(j),
  nextRestart: (): Promise<NextRunnerStatus> => fetch("/api/next/restart", opts("POST")).then(j),
  /** URL of the fallback picture for a channel (blank = a sample channel) with an unsaved setting; 204 = black */
  fallbackPreviewUrl: (channel: string, value: string) => `/api/fallback/preview?channel=${encodeURIComponent(channel)}&value=${encodeURIComponent(value)}`,
  updates: (mode?: "refresh" | "cached"): Promise<UpdateStatus> => fetch(`/api/updates${mode === "refresh" ? "?refresh=1" : mode === "cached" ? "?cached=1" : ""}`).then(j),
  installUpdates: (components: UpdateComponent["id"][]): Promise<UpdateStatus | { error: string }> =>
    fetch("/api/updates/install", opts("POST", { components })).then((r) => r.json()),
  libraryStatus: (): Promise<LibraryStatus> => fetch("/api/library/status").then(j),
  indexStatus: (): Promise<IndexStatus> => fetch("/api/index/status").then(j),
  rebuildIndex: (): Promise<IndexStatus> => fetch("/api/index/rebuild", opts("POST")).then(j),
  libraryImport: (): Promise<ImportJob | { error: string }> => fetch("/api/library/import", opts("POST")).then(j),
  mediaSources: (): Promise<SourceInfo[]> => fetch("/api/media/sources").then(j),
  mediaLibraries: (): Promise<LibraryInfo[]> => fetch("/api/media/libraries").then(j),
  createLibrary: (body: { name: string; kind: number; paths: string[] }): Promise<LibraryInfo | { error: string }> => fetch("/api/media/libraries", opts("POST", body)).then(j),
  deleteLibrary: (id: number): Promise<{ deleted: number }> => fetch(`/api/media/libraries/${id}`, opts("DELETE")).then(j),
  libraryPaths: (id: number): Promise<LibraryPath[]> => fetch(`/api/media/libraries/${id}/paths`).then(j),
  addLibraryPath: (id: number, path: string): Promise<LibraryPath | { error: string }> => fetch(`/api/media/libraries/${id}/paths`, opts("POST", { path })).then(j),
  updateLibraryPath: (pathId: number, path: string): Promise<{ ok?: boolean; error?: string }> => fetch(`/api/media/paths/${pathId}`, opts("PUT", { path })).then(j),
  removeLibraryPath: (pathId: number): Promise<{ deleted?: number; error?: string }> => fetch(`/api/media/paths/${pathId}`, opts("DELETE")).then(j),
  addSource: (body: { type: string; serverName: string; address: string; token?: string }): Promise<{ sourceId?: number; error?: string }> => fetch("/api/media/sources", opts("POST", body)).then(j),
  discoverSource: (id: number): Promise<{ discovered?: number; added?: number; libraries?: { id: number; name: string; kind: string }[]; error?: string }> => fetch(`/api/media/sources/${id}/discover`, opts("POST")).then(j),
  deleteSource: (id: number): Promise<{ deletedLibraries: number; deletedItems: number }> => fetch(`/api/media/sources/${id}`, opts("DELETE")).then(j),
  mediaTrash: (limit = 200, offset = 0): Promise<{ total: number; items: TrashItem[] }> => fetch(`/api/media/trash?limit=${limit}&offset=${offset}`).then(j),
  mediaTrashEmpty: (): Promise<{ deleted: number }> => fetch("/api/media/trash/empty", opts("POST")).then(j),
  mediaSource: (id: number): Promise<{ source: SourceInfo | null; libraries: LibraryInfo[] }> => fetch(`/api/media/sources/${id}`).then(j),
  setLibraryEnabled: (id: number, enabled: boolean): Promise<{ id: number; enabled: boolean }> => fetch(`/api/media/libraries/${id}/enabled`, opts("PUT", { enabled })).then(j),
  browseKinds: (): Promise<{ kind: string; label: string; count: number }[]> => fetch("/api/browse/kinds").then(j),
  showSuggest: (q: string): Promise<string[]> => fetch(`/api/browse/shows?q=${encodeURIComponent(q)}`).then(j),
  collections: (): Promise<CollectionInfo[]> => fetch("/api/collections").then(j),
  collectionItems: (type: string, id: number, offset = 0, limit = 200): Promise<{ name: string; type: string; query?: string; total: number; cards: BrowseCard[] }> =>
    fetch(`/api/collections/${type}/${id}/items?offset=${offset}&limit=${limit}`).then(j),
  createCollection: (body: { type: string; name: string; query?: string }): Promise<{ id: number; type: string } | { error: string }> => fetch("/api/collections", opts("POST", body)).then(j),
  collectionMembership: (itemId: number): Promise<{ id: number; name: string }[]> => fetch(`/api/collections/membership/${itemId}`).then(j),
  addToCollection: (collectionId: number, itemId: number): Promise<{ ok?: boolean; error?: string }> => fetch(`/api/collections/collection/${collectionId}/items`, opts("POST", { itemId })).then(j),
  removeFromCollection: (collectionId: number, itemId: number): Promise<{ ok?: boolean }> => fetch(`/api/collections/collection/${collectionId}/items/${itemId}`, opts("DELETE")).then(j),
  updateCollection: (type: string, id: number, patch: { name?: string; query?: string }): Promise<{ ok: boolean; channels?: string[] }> => fetch(`/api/collections/${type}/${id}`, opts("PUT", patch)).then(j),
  fillerTags: (src: { libraries?: string[]; collection?: string }): Promise<{ items: number; tags: { tag: string; count: number }[]; combos?: { tags: string[]; count: number }[]; error?: string }> => fetch("/api/filler-tags", opts("POST", src)).then(j),
  collectionUsage: (type: string, id: number): Promise<{ channels: string[]; library: string[] }> => fetch(`/api/collections/${type}/${id}/usage`).then(j),
  multiMembers: (id: number): Promise<MultiMember[]> => fetch(`/api/collections/multi/${id}/members`).then(j),
  addMultiMember: (id: number, m: { type: "collection" | "smart"; id: number }): Promise<{ ok?: boolean; error?: string }> => fetch(`/api/collections/multi/${id}/members`, opts("POST", m)).then(j),
  removeMultiMember: (id: number, m: { type: "collection" | "smart"; id: number }): Promise<{ ok?: boolean }> => fetch(`/api/collections/multi/${id}/members/${m.type}/${m.id}`, opts("DELETE")).then(j),
  deleteCollection: (type: string, id: number): Promise<{ ok: boolean }> => fetch(`/api/collections/${type}/${id}`, opts("DELETE")).then(j),
  playlist: (id: number): Promise<PlaylistDetail | { error: string }> => fetch(`/api/playlists/${id}`).then(j),
  addPlaylistEntry: (id: number, ref: PlaylistRef): Promise<{ id?: number; error?: string }> => fetch(`/api/playlists/${id}/entries`, opts("POST", ref)).then(j),
  updatePlaylistEntry: (id: number, entryId: number, patch: Partial<Pick<PlaylistEntryInfo, "order" | "playAll" | "count" | "inGuide">>) => fetch(`/api/playlists/${id}/entries/${entryId}`, opts("PUT", patch)).then(j),
  reorderPlaylist: (id: number, ids: number[]) => fetch(`/api/playlists/${id}/order`, opts("PUT", { ids })).then(j),
  removePlaylistEntry: (id: number, entryId: number) => fetch(`/api/playlists/${id}/entries/${entryId}`, opts("DELETE")).then(j),
  playlistMembership: (itemId: number): Promise<{ id: number; name: string }[]> => fetch(`/api/playlists/membership/${itemId}`).then(j),
  playlistPreview: (id: number, n = 24): Promise<{ items: { title: string; entry: string; durationMs: number; inGuide: boolean }[] }> => fetch(`/api/playlists/${id}/preview?n=${n}`).then(j),
  browseLetters: (kind: string): Promise<Record<string, number>> => fetch(`/api/browse/letters?kind=${encodeURIComponent(kind)}`).then(j),
  browseList: (kind: string, offset = 0, limit = 60): Promise<{ total: number; cards: BrowseCard[] }> => fetch(`/api/browse/list?kind=${encodeURIComponent(kind)}&offset=${offset}&limit=${limit}`).then(j),
  browseSeasons: (showId: number): Promise<{ show: { id: number; title: string }; seasons: BrowseCard[] }> => fetch(`/api/browse/seasons/${showId}`).then(j),
  browseEpisodes: (seasonId: number): Promise<{ season: { id: number; title: string; showTitle: string; showId: number | null }; episodes: BrowseCard[] }> => fetch(`/api/browse/episodes/${seasonId}`).then(j),
  browseDetail: (type: string, id: number): Promise<BrowseDetail | null> => fetch(`/api/browse/detail?type=${encodeURIComponent(type)}&id=${id}`).then(j),
  browseSearch: (q: string, offset = 0, limit = 60): Promise<{ total: number; unknownFields: string[]; items: SearchItem[]; error?: string; explain?: string; didYouMean?: Record<string, string> }> => fetch(`/api/browse/search?q=${encodeURIComponent(q)}&offset=${offset}&limit=${limit}`).then(j),
  searchFields: (): Promise<SearchField[]> => fetch("/api/search/fields").then(j),
  searchValues: (field: string, text: string, limit = 12): Promise<{ value: string; count: number }[]> => fetch(`/api/search/values?field=${encodeURIComponent(field)}&text=${encodeURIComponent(text)}&limit=${limit}`).then(j),
  deepScanStatus: (): Promise<DeepScanJob> => fetch("/api/browse/deep-scan").then(j),
  deepScan: (type: string, id: number): Promise<DeepScanJob | { error: string }> => fetch("/api/browse/deep-scan", opts("POST", { type, id })).then(j),
  scanStatus: (): Promise<ScanJob> => fetch("/api/media/scan").then(j),
  scanLibrary: (id: number): Promise<ScanJob | { error: string }> => fetch(`/api/media/libraries/${id}/scan`, opts("POST")).then(j),
  sourceConnection: (id: number): Promise<SourceConnection> => fetch(`/api/media/sources/${id}/connection`).then(j),
  setSourceConnection: (id: number, patch: { token?: string; address?: string | null }): Promise<{ ok: boolean; hasToken: boolean }> => fetch(`/api/media/sources/${id}/connection`, opts("PUT", patch)).then(j),
  pathReplacements: (id: number): Promise<{ sourceType: string; replacements: PathReplacement[] }> => fetch(`/api/media/sources/${id}/path-replacements`).then(j),
  addPathReplacement: (id: number, remote: string, local: string): Promise<{ id?: number; error?: string }> => fetch(`/api/media/sources/${id}/path-replacements`, opts("POST", { remote, local })).then(j),
  updatePathReplacement: (id: number, prId: number, remote: string, local: string): Promise<{ ok: boolean }> => fetch(`/api/media/sources/${id}/path-replacements/${prId}`, opts("PUT", { remote, local })).then(j),
  removePathReplacement: (id: number, prId: number): Promise<{ ok: boolean }> => fetch(`/api/media/sources/${id}/path-replacements/${prId}`, opts("DELETE")).then(j),
  scanSource: (id: number, refresh = false): Promise<ScanJob | { error: string }> => fetch(`/api/media/sources/${id}/scan${refresh ? "?refresh=1" : ""}`, opts("POST")).then(j),
  plexAuthStart: (id: number): Promise<{ authUrl?: string; pinId?: number; error?: string }> => fetch(`/api/media/sources/${id}/auth/plex/start`, opts("POST")).then(j),
  plexAuthPoll: (id: number): Promise<{ authorized: boolean; error?: string }> => fetch(`/api/media/sources/${id}/auth/plex/poll`, opts("POST")).then(j),
  remoteLogin: (id: number, body: { username: string; password: string; address?: string }): Promise<{ ok?: boolean; error?: string }> => fetch(`/api/media/sources/${id}/auth/login`, opts("POST", body)).then(j),
  build: (channel: string, days?: number, rebuild?: boolean): Promise<{ jobId: string; channels: string[] }> => fetch("/api/build", opts("POST", { channel, days, rebuild })).then(j),
  job: (id: string): Promise<BuildJob> => fetch(`/api/build/${id}`).then(j),
  builds: () => fetch("/api/builds").then(j),
  coverage: (): Promise<Record<string, string | null>> => fetch("/api/coverage").then(j),
  playouts: (channel: string): Promise<PlayoutWindow[]> => fetch(`/api/playouts/${channel}`).then(j),
  playout: (channel: string, file: string): Promise<PlayoutView> => fetch(`/api/playouts/${channel}/${file}`).then(j),
  scheduler: (): Promise<SchedulerStatus> => fetch("/api/scheduler").then(j),
  schedulerRun: (): Promise<SchedulerStatus> => fetch("/api/scheduler/run", opts("POST")).then(j),
  overlays: (): Promise<{ overlays: Overlay[]; fields: OverlayField[]; slots?: string[]; usedBy: Record<string, string[]> }> => fetch("/api/overlays").then(j),
  overlayPictures: (): Promise<OverlayPictures> => fetch("/api/overlays/pictures").then(j),
  legacyFolder: (folder = ""): Promise<{ folder: string; exists: boolean; files: { file: string; kind: string }[] }> => fetch(`/api/overlays/legacy-folder?folder=${encodeURIComponent(folder)}`).then(j),
  legacyImport: (items: { file: string; text: string; kind?: string }[]): Promise<{ imported: LegacyImported[] }> => fetch("/api/overlays/legacy-import", opts("POST", { items })).then(j).then((r) => { window.dispatchEvent(new Event("tvn:overlays-changed")); return r; }),
  legacyImportFolder: (folder: string): Promise<{ imported: LegacyImported[] }> => fetch("/api/overlays/legacy-import-folder", opts("POST", { folder })).then(j).then((r) => { window.dispatchEvent(new Event("tvn:overlays-changed")); return r; }),
  legacyTest: (overlay: Overlay, channel: string, match?: string, at?: number): Promise<LegacyTest> => fetch("/api/overlays/legacy-test", opts("POST", { overlay, channel, match, at })).then(j),
  uploadOverlayPicture: (file: File, folder = ""): Promise<{ name: string }> =>
    fetch("/api/overlays/pictures", { method: "POST", headers: { "Content-Type": file.type && /^(image|video)\//.test(file.type) ? file.type : "application/octet-stream", "x-file-name": encodeURIComponent(file.name), "x-folder": encodeURIComponent(folder) }, body: file }).then(j),
  deleteOverlayPicture: (name: string): Promise<{ ok: boolean }> => fetch(`/api/overlays/pictures?name=${encodeURIComponent(name)}`, { method: "DELETE" }).then(j),
  matchOverlayPicture: (name: string, kind: "image" | "video" = "image"): Promise<{ name: string; file: string | null }> =>
    fetch(`/api/overlays/pictures/match?name=${encodeURIComponent(name)}&kind=${kind}`).then(j),
  overlayExamples: (): Promise<Overlay[]> => fetch("/api/overlays/examples").then(j),
  overlayMoments: (channel: string, overlay?: string): Promise<{ moments: OverlayMoment[]; note?: string; outOfSeason?: { id: string; name: string; when: string }[]; programmes?: { file: string; itemId: string; itemStart: number; path: string }[] }> =>
    fetch(`/api/troubleshoot/overlay-moments?${new URLSearchParams({ channel, ...(overlay ? { overlay } : {}) })}`).then(j),
  // (both tell any overlay pickers on the page to fetch the list again)
  saveOverlay: (o: Overlay): Promise<Overlay> => fetch("/api/overlays", opts("POST", o)).then(j).then((r) => { window.dispatchEvent(new Event("tvn:overlays-changed")); return r; }),
  deleteOverlay: (id: string): Promise<{ ok: boolean }> => fetch(`/api/overlays/${encodeURIComponent(id)}`, opts("DELETE")).then(j).then((r) => { window.dispatchEvent(new Event("tvn:overlays-changed")); return r; }),
  uploadOverlayAsset: (file: File): Promise<{ src: string; kind: "image" | "video"; error?: string }> =>
    fetch("/api/overlays/assets", { method: "POST", headers: { "Content-Type": file.type && /^(image|video)\//.test(file.type) ? file.type : "application/octet-stream", "x-file-name": encodeURIComponent(file.name) }, body: file }).then(j),
  renderOverlay: (overlay: Overlay, vars?: Record<string, string>): Promise<{ png: string | null; box: { x: number; y: number; w: number; h: number } | null; error?: string }> => fetch("/api/overlays/render", opts("POST", { overlay, vars })).then(j),
  legacyWatermarks: (names?: string[], also?: string): Promise<{ updated: string[]; missing: string[]; error?: string }> =>
    fetch("/api/legacy/channels/watermarks", opts("POST", { names, also })).then(j),
  pods: (): Promise<Pod[]> => fetch("/api/pods").then(j),
  savePod: (pod: Pod): Promise<Pod> => fetch("/api/pods", opts("POST", pod)).then(j),
  deletePod: (id: string): Promise<{ ok: boolean }> => fetch(`/api/pods/${encodeURIComponent(id)}`, opts("DELETE")).then(j),
  podPreview: (body: { pods?: Pod[]; entryId: string; hours?: number }): Promise<PodPreview> => fetch("/api/pods/preview", opts("POST", body)).then(j),
};

// --- pods -------------------------------------------------------------------
export type PodType = "break" | "filler" | "show";
export interface ContentSource {
  kind: "query" | "show" | "collection" | "library" | "show_bumper" | "next_bumper";
  query?: string; value?: string; phrase?: string; count?: number; minMinutes?: number; maxMinutes?: number; type?: string;
  order?: "chronological" | "shuffle";
}
export interface CollectionInfo { type: "collection" | "smart" | "multi" | "playlist"; id: number; name: string; group?: string; query?: string; count?: number | null; }
export interface MultiMember { type: "collection" | "smart"; id: number; name: string; count: number | null; }
export interface Pod { id: string; name: string; type: PodType; config: any; updatedAt?: string; }
export interface PodPreview {
  yaml?: string; entryKey?: string; error?: string; warning?: string;
  items?: PlayoutItem[]; labels?: Record<string, ItemLabel>;
}

// Category + color for a playout item, from its label.
export const CATEGORY_COLORS: Record<string, string> = {
  "Program": "#3b82f6", "Commercial": "#6b7280", "Bumper": "#14b8a6",
  "Promo": "#a855f7", "Up Next": "#f59e0b", "Break bumper": "#f97316",
  "Transition": "#334155", "Filler": "#64748b",
};
const paint = (cat: string) => ({ cat, color: CATEGORY_COLORS[cat] ?? CATEGORY_COLORS.Filler });

/**
 * Classify a scheduled item for the preview. Prefers the ACTUAL content — the
 * item's type, tags, and title — so it's robust to how the content key was
 * named (namespacing, custom keys). The content key is only a last-resort
 * fallback. `title` is the item's filename/title (the preview passes it from the
 * playout item, so already-built windows without tags still classify correctly).
 */
export function category(label?: ItemLabel, title?: string): { cat: string; color: string } {
  const type = label?.type ?? "";
  const tags = (label?.tags ?? []).map((t) => t.toLowerCase());
  const t = (title ?? "").toLowerCase().replace(/\.[a-z0-9]+$/, ""); // strip extension
  const key = (label?.key ?? "").toUpperCase().replace(/^[A-Z0-9]+__/, ""); // drop namespace
  const hasTag = (...n: string[]) => n.some((x) => tags.includes(x));

  // 1) Structural: real programs are episodes/movies (never an "up next" bumper).
  if (["episode", "movie"].includes(type) && !key.startsWith("UP_NEXT")) return paint("Program");

  // 2) Actual-content signals — tags are ground truth, title patterns back them up.
  if (hasTag("be right back") || /^be right back\b/.test(t)) return paint("Break bumper");
  if (hasTag("back to") || /^back to\b/.test(t)) return paint("Break bumper");
  if (hasTag("promos", "promo") || /\bpromo\b/.test(t)) return paint("Promo");
  if (/\bup next\b|\bthen\b/.test(t)) return paint("Up Next");
  if (/\bbumper\b/.test(t)) return paint("Bumper");
  if (/\bcommercial\b/.test(t)) return paint("Commercial");
  if (t === "white") return paint("Transition");

  // 3) Fallback: legacy content-key heuristics.
  if (key.includes("COMMERCIAL")) return paint("Commercial");
  if (key.startsWith("BUMPER")) return paint("Bumper");
  if (key.startsWith("PROMO")) return paint("Promo");
  if (key.startsWith("UP_NEXT")) return paint("Up Next");
  if (key.startsWith("BE_BACK") || key.startsWith("BACK_TO")) return paint("Break bumper");
  if (key === "WHITE") return paint("Transition");

  // 4) Anything else with a program type is a program; otherwise generic filler.
  if (["episode", "movie"].includes(type)) return paint("Program");
  return { cat: label?.key ?? "Filler", color: CATEGORY_COLORS.Filler };
}
