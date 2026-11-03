// App config store (its own SQLite DB). Never touches the ErsatzTV DB.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { machineTz, isValidTz, type Tz } from "../time.js";

function safeJson(s: any): any { try { return JSON.parse(s); } catch { return {}; } }

export interface AppConfig {
  etvDbPath: string;      // the source ErsatzTV legacy DB (used for the initial import)
  libraryDbPath: string;  // our own imported library (used for scheduling once it exists)
  channelsDir: string;
  outputDir: string;
  timeZone: string;       // IANA zone for wall-clock scheduling; "" = this machine's zone
  tz: Tz;                 // the zone in effect (timeZone, or the machine's); read-only
  days: number;
  // automation
  autoBuild: boolean;         // enable the background top-up scheduler
  buildIntervalMin: number;   // how often to check coverage
  refreshThresholdHours: number; // append a window when coverage is short by more than this
  prunePast: boolean;         // delete window files that finished in the past
  includeSpecials: boolean;   // include Season 0 (specials) episodes when scheduling shows
  autoScanHours: number;      // rescan local libraries whose last scan is older than this (0 = off)
  keepNextRunning: boolean;   // keep an ErsatzTV next instance alive while playouts are valid
  // ErsatzTV legacy import tools (library + channel import). Turned off once the
  // migration is done, so a stray re-import can't replace the library (and the
  // collections/scans made since) or overwrite channels.
  legacyImport: boolean;
  // updating this scheduler from git (Settings → Scheduler updates): "off", "notify" (check hourly, show
  // what's new) or "install" (also pull, build and restart at selfUpdateHour, local time)
  selfUpdate: string;
  selfUpdateHour: number;
}

const DEFAULTS: AppConfig = {
  etvDbPath: "", libraryDbPath: "data/library.sqlite", channelsDir: "channels", outputDir: "playouts", timeZone: "", tz: "UTC", days: 3,
  autoBuild: false, buildIntervalMin: 60, refreshThresholdHours: 24, prunePast: true, includeSpecials: false, autoScanHours: 0,
  keepNextRunning: false, legacyImport: true, selfUpdate: "notify", selfUpdateHour: 4,
};

export interface ChannelMeta {
  name: string;       // = channel YAML filename (source of truth for playout/xmltv naming)
  number: string;     // HDHR channel number, e.g. "1" or "2.1"
  tvgId: string;      // XMLTV id (defaults to name)
  logo: string;
  logoGenerated: boolean; // logo was drawn from the channel name (replaced by any real logo; redrawn on rename)
  group: string;
  enabled: boolean;
  sort: number;
  audioLang: string;  // preferred audio language (ISO 639-2, e.g. "eng"); "" = server default
  subtitles: string;     // English subtitles, burned in: "off" | "on" (full) | "forced" (foreign dialog only)
  upNextTheme: string;  // "coming up next" card design: off | splat | slime | clock | chips
  upNextAudio: string;  // absolute path to a background audio/music bed for the card ("" = silent)
  upNextText: string;   // how the card's text is rendered: "image" (PNG layers) | "subtitles" (burned ASS via libass)
  encoding: string;     // "" (default: pass remote streams through, re-encode the rest) | "transcode" | "copy" (next's copy mode)
  fallbackImage: string; // shown when there's nothing to play: "" (Streaming default) | "black" | "standby" | an image path
  overlays: string[];    // overlay ids drawn over every programme (watermark / bug, straps…)
}

/** ErsatzTV next streaming settings, written into lineup.json + config.json. */
export interface NextConfig {
  runtimeDir: string;   // where lineup.json / channels / playouts / xmltv live
  outputFolder: string; // where next writes transcoded HLS segments (lineup.output.folder);
                        // absolute path (e.g. a ramdisk) or relative to runtimeDir. Default "./output".
  binaryPath: string;   // path to the ErsatzTV next server binary
  bindAddress: string;
  port: number;
  // The address TV apps on your network use to reach THIS scheduler (for channel
  // logos in the M3U/guide), e.g. "http://192.168.1.20:8730". Blank = this
  // machine's LAN address and the scheduler's port.
  publicUrl: string;
  ffmpegPath: string;
  ffprobePath: string;
  // default fallback for channels without their own: "black" | "standby" (a "We'll be right back" card) | an image path
  fallbackImage: string;
  video: { width: number; height: number; codec: string; bitDepth: number; bitrateKbps: number; bufferKbps: number; accel: string; tonemapAlgorithm: string };
  audio: { codec: string; bitrateKbps: number; bufferKbps: number; channels: number; sampleRateHz: number; normalizeLoudness: boolean };
  // Live "coming up next" graphics-canvas card inserted at the end of each break.
  // Served by this server's /graphics/upnext endpoint (must be running during
  // playback). `fontFile` is the TTF ffmpeg's drawtext uses to render the card.
  upNext: { enabled: boolean; count: number; durationMs: number; fontFile: string };
  // A scrolling "TV guide" channel rendered from every channel's XMLTV guide and
  // fed to next as its own channel (a `script` playout source that streams the
  // scroll + background music). `musicFolder` is picked from at random.
  guide: {
    enabled: boolean; number: string; name: string; group: string; tvgId: string;
    musicFolder: string; columns: number; scrollSpeed: number; refreshMin: number; theme: string;
    promoRotateSec: number; promoFolder: string;
  };
  // HDHomeRun tuner emulation for Plex Live TV & DVR (src/server/hdhr.ts), on its
  // own port. `deviceId` is made once; Plex remembers the tuner by it.
  hdhr: { enabled: boolean; port: number; tuners: number; name: string; deviceId: string };
}

export function defaultNextConfig(): NextConfig {
  return {
    runtimeDir: "runtime", outputFolder: "./output", binaryPath: "bin/ersatztv.exe", bindAddress: "0.0.0.0", port: 8409, publicUrl: "", ffmpegPath: "", ffprobePath: "", fallbackImage: "black",
    video: { width: 1920, height: 1080, codec: "h264", bitDepth: 8, bitrateKbps: 2000, bufferKbps: 4000, accel: "", tonemapAlgorithm: "linear" },
    audio: { codec: "aac", bitrateKbps: 192, bufferKbps: 384, channels: 2, sampleRateHz: 48000, normalizeLoudness: true },
    upNext: { enabled: false, count: 3, durationMs: 12000, fontFile: "C:/Windows/Fonts/arialbd.ttf" },
    guide: { enabled: false, number: "100", name: "Guide", group: "", tvgId: "guide", musicFolder: "", columns: 3, scrollSpeed: 60, refreshMin: 30, theme: "classic", promoRotateSec: 30, promoFolder: "" },
    hdhr: { enabled: false, port: 5004, tuners: 4, name: "tv-next-scheduler", deviceId: "" },
  };
}

export interface BuildRecord {
  id: number; channel: string; started_at: string; finished_at: string | null;
  status: string; item_count: number | null; file: string | null; error: string | null;
}

const parseList = (s: unknown): string[] => { const v = safeJson(s); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; };

export class ConfigStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS builds (
        id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, started_at TEXT,
        finished_at TEXT, status TEXT, item_count INTEGER, file TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS channel_meta (
        name TEXT PRIMARY KEY, number TEXT, tvg_id TEXT, logo TEXT, "group" TEXT,
        enabled INTEGER DEFAULT 1, sort INTEGER DEFAULT 0,
        audio_lang TEXT DEFAULT '', subtitle_lang TEXT DEFAULT '', subtitle_mode TEXT DEFAULT 'burn',
        up_next_theme TEXT DEFAULT 'splat', up_next_audio TEXT DEFAULT '', up_next_text TEXT DEFAULT 'image', logo_generated INTEGER DEFAULT 0, subtitles TEXT DEFAULT 'off');
      CREATE TABLE IF NOT EXISTS library_settings (
        library_id INTEGER PRIMARY KEY, enabled INTEGER DEFAULT 1);
      CREATE TABLE IF NOT EXISTS playout_progress (
        channel TEXT, content_key TEXT, cursor INTEGER, PRIMARY KEY(channel, content_key));
      CREATE TABLE IF NOT EXISTS source_secrets (
        source_id INTEGER PRIMARY KEY, token TEXT, address TEXT);
      CREATE TABLE IF NOT EXISTS pods (
        id TEXT PRIMARY KEY, name TEXT, type TEXT, config TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS overlays (
        id TEXT PRIMARY KEY, name TEXT, config TEXT, updated_at TEXT);
    `);
    // Migrate older DBs that predate the per-channel language columns.
    const cols = (this.db.prepare(`PRAGMA table_info(channel_meta)`).all() as any[]).map((c) => c.name);
    if (!cols.includes("audio_lang")) this.db.exec(`ALTER TABLE channel_meta ADD COLUMN audio_lang TEXT DEFAULT ''`);
    if (!cols.includes("subtitle_lang")) this.db.exec(`ALTER TABLE channel_meta ADD COLUMN subtitle_lang TEXT DEFAULT ''`);
    if (!cols.includes("subtitle_mode")) this.db.exec(`ALTER TABLE channel_meta ADD COLUMN subtitle_mode TEXT DEFAULT 'burn'`);
    if (!cols.includes("up_next_theme")) this.db.exec(`ALTER TABLE channel_meta ADD COLUMN up_next_theme TEXT DEFAULT 'splat'`);
    if (!cols.includes("up_next_audio")) this.db.exec(`ALTER TABLE channel_meta ADD COLUMN up_next_audio TEXT DEFAULT ''`);
    if (!cols.includes("up_next_text")) this.db.exec(`ALTER TABLE channel_meta ADD COLUMN up_next_text TEXT DEFAULT 'image'`);
    // one subtitles setting replaces language + mode; channels that had a subtitle
    // language start on foreign-dialog-only (what legacy's "Forced" mode meant)
    if (!cols.includes("subtitles")) {
      this.db.exec(`ALTER TABLE channel_meta ADD COLUMN subtitles TEXT DEFAULT 'off'`);
      this.db.exec(`UPDATE channel_meta SET subtitles = CASE WHEN COALESCE(subtitle_lang,'') <> '' THEN 'forced' ELSE 'off' END`);
    }
    if (!cols.includes("logo_generated")) this.db.exec(`ALTER TABLE channel_meta ADD COLUMN logo_generated INTEGER DEFAULT 0`);
    if (!cols.includes("encoding")) this.db.exec(`ALTER TABLE channel_meta ADD COLUMN encoding TEXT DEFAULT ''`);
    if (!cols.includes("fallback_image")) this.db.exec(`ALTER TABLE channel_meta ADD COLUMN fallback_image TEXT DEFAULT ''`);
    if (!cols.includes("overlays")) this.db.exec(`ALTER TABLE channel_meta ADD COLUMN overlays TEXT DEFAULT ''`);
  }

  // --- per-source remote credentials (token/API key; address optional override) ---
  getSourceSecret(sourceId: number): { token: string; address: string | null } {
    const r = this.db.prepare(`SELECT token, address FROM source_secrets WHERE source_id=?`).get(sourceId) as any;
    return { token: r?.token ?? "", address: r?.address ?? null };
  }
  setSourceSecret(sourceId: number, patch: { token?: string; address?: string | null }): void {
    const cur = this.getSourceSecret(sourceId);
    const token = patch.token ?? cur.token;
    const address = patch.address !== undefined ? patch.address : cur.address;
    this.db.prepare(`INSERT INTO source_secrets(source_id, token, address) VALUES(?,?,?)
      ON CONFLICT(source_id) DO UPDATE SET token=excluded.token, address=excluded.address`).run(sourceId, token, address);
  }
  hasSourceToken(sourceId: number): boolean { return !!this.getSourceSecret(sourceId).token; }
  /** All stored source credentials (for building the guide's live-fetch map). */
  listSourceSecrets(): { sourceId: number; token: string; address: string | null }[] {
    return (this.db.prepare(`SELECT source_id AS sourceId, token, address FROM source_secrets`).all() as any[])
      .map((r) => ({ sourceId: Number(r.sourceId), token: r.token ?? "", address: r.address ?? null }));
  }

  // --- overlays (graphics drawn over programmes; see src/overlays.ts) ---------
  listOverlays(): any[] {
    return (this.db.prepare(`SELECT id, name, config, updated_at FROM overlays ORDER BY name`).all() as any[])
      .map((r) => ({ ...safeJson(r.config), id: r.id, name: r.name, updatedAt: r.updated_at }));
  }
  getOverlay(id: string): any | null { return this.listOverlays().find((o) => o.id === id) ?? null; }
  saveOverlay(o: { id: string; name: string; [k: string]: unknown }): void {
    const { id, name, updatedAt: _u, ...rest } = o as any;
    this.db.prepare(`INSERT INTO overlays(id, name, config, updated_at) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, config=excluded.config, updated_at=excluded.updated_at`).run(id, name, JSON.stringify(rest), new Date().toISOString());
  }
  deleteOverlay(id: string): void { this.db.prepare(`DELETE FROM overlays WHERE id=?`).run(id); }

  // --- pods (authoring building blocks) --------------------------------------
  listPods(): { id: string; name: string; type: string; config: any; updatedAt: string }[] {
    return (this.db.prepare(`SELECT id, name, type, config, updated_at FROM pods ORDER BY type, name`).all() as any[])
      .map((r) => ({ id: r.id, name: r.name, type: r.type, config: safeJson(r.config), updatedAt: r.updated_at }));
  }
  getPod(id: string): { id: string; name: string; type: string; config: any; updatedAt: string } | null {
    const r = this.db.prepare(`SELECT id, name, type, config, updated_at FROM pods WHERE id=?`).get(id) as any;
    return r ? { id: r.id, name: r.name, type: r.type, config: safeJson(r.config), updatedAt: r.updated_at } : null;
  }
  savePod(pod: { id: string; name: string; type: string; config: any }): void {
    this.db.prepare(`INSERT INTO pods(id, name, type, config, updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, config=excluded.config, updated_at=excluded.updated_at`)
      .run(pod.id, pod.name, pod.type, JSON.stringify(pod.config ?? {}), new Date().toISOString());
  }
  deletePod(id: string): void { this.db.prepare(`DELETE FROM pods WHERE id=?`).run(id); }
  removeSourceSecret(sourceId: number): void { this.db.prepare(`DELETE FROM source_secrets WHERE source_id=?`).run(sourceId); }

  /** Stable client/device identifier for provider auth (generated once, persisted). */
  getClientId(): string {
    const r = this.db.prepare(`SELECT value FROM settings WHERE key='clientId'`).get() as any;
    if (r?.value) return r.value;
    const id = randomUUID();
    this.db.prepare(`INSERT INTO settings(key,value) VALUES('clientId',?)`).run(id);
    return id;
  }

  // --- per-channel playout progress (resume episode order; no repeats on rebuild) ---
  getProgress(channel: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.prepare(`SELECT content_key, cursor FROM playout_progress WHERE channel=?`).all(channel) as any[]) out[r.content_key] = r.cursor;
    return out;
  }
  saveProgress(channel: string, progress: Record<string, number>): void {
    const st = this.db.prepare(`INSERT INTO playout_progress(channel, content_key, cursor) VALUES(?,?,?) ON CONFLICT(channel, content_key) DO UPDATE SET cursor=excluded.cursor`);
    for (const [k, v] of Object.entries(progress)) st.run(channel, k, v);
  }
  clearProgress(channel: string): void {
    this.db.prepare(`DELETE FROM playout_progress WHERE channel=?`).run(channel);
  }

  // --- per-library enable/disable (survives re-import; library ids are stable) ---
  libraryEnabledMap(): Map<number, boolean> {
    const m = new Map<number, boolean>();
    for (const r of this.db.prepare(`SELECT library_id, enabled FROM library_settings`).all() as any[]) m.set(r.library_id, !!r.enabled);
    return m;
  }
  setLibraryEnabled(id: number, enabled: boolean): void {
    this.db.prepare(`INSERT INTO library_settings(library_id, enabled) VALUES(?,?) ON CONFLICT(library_id) DO UPDATE SET enabled=excluded.enabled`).run(id, enabled ? 1 : 0);
  }
  disabledLibraryIds(): number[] {
    return (this.db.prepare(`SELECT library_id FROM library_settings WHERE enabled=0`).all() as any[]).map((r) => r.library_id);
  }
  removeLibrarySetting(id: number): void { this.db.prepare(`DELETE FROM library_settings WHERE library_id=?`).run(id); }

  // --- channel registry (metadata for the ErsatzTV next lineup) --------------
  channelMetas(): ChannelMeta[] {
    return (this.db.prepare(`SELECT * FROM channel_meta ORDER BY sort, number, name`).all() as any[])
      .map((r) => ({ name: r.name, number: r.number ?? "", tvgId: r.tvg_id ?? "", logo: r.logo ?? "", logoGenerated: !!r.logo_generated, group: r.group ?? "", enabled: !!r.enabled, sort: r.sort ?? 0, audioLang: r.audio_lang ?? "", subtitles: r.subtitles || "off", upNextTheme: r.up_next_theme ?? "splat", upNextAudio: r.up_next_audio ?? "", upNextText: r.up_next_text ?? "image", encoding: r.encoding ?? "", fallbackImage: r.fallback_image ?? "", overlays: parseList(r.overlays) }));
  }
  channelMeta(name: string): ChannelMeta | undefined {
    return this.channelMetas().find((c) => c.name === name);
  }
  /** Create a default registry row for a channel that doesn't have one yet. */
  ensureChannelMeta(name: string): ChannelMeta {
    const existing = this.channelMeta(name);
    if (existing) return existing;
    const n = String((this.db.prepare(`SELECT COALESCE(MAX(CAST(number AS INTEGER)),0)+1 AS n FROM channel_meta`).get() as any).n);
    this.db.prepare(`INSERT INTO channel_meta(name,number,tvg_id,logo,"group",enabled,sort) VALUES(?,?,?,?,?,1,?)`)
      .run(name, n, name, "", "", Number(n));
    return this.channelMeta(name)!;
  }
  upsertChannelMeta(name: string, patch: Partial<ChannelMeta>): ChannelMeta {
    this.ensureChannelMeta(name);
    // the generated flag follows the logo: a new logo is a real one unless the caller
    // says it was generated; with the logo unchanged an echoed flag is ignored
    const prev = this.channelMeta(name)!;
    if (patch.logo !== undefined && patch.logo !== prev.logo) patch = { ...patch, logoGenerated: !!patch.logoGenerated };
    else { const { logoGenerated: _ignored, ...rest } = patch; patch = rest; }
    const cols: Record<string, string> = { number: "number", tvgId: "tvg_id", logo: "logo", logoGenerated: "logo_generated", group: '"group"', enabled: "enabled", sort: "sort", audioLang: "audio_lang", subtitles: "subtitles", upNextTheme: "up_next_theme", upNextAudio: "up_next_audio", upNextText: "up_next_text", encoding: "encoding", fallbackImage: "fallback_image", overlays: "overlays" };
    for (const [k, col] of Object.entries(cols)) {
      let v = (patch as any)[k];
      if (v === undefined) continue;
      if (k === "overlays") v = JSON.stringify(Array.isArray(v) ? v.filter((x: unknown) => typeof x === "string" && x) : []);
      this.db.prepare(`UPDATE channel_meta SET ${col}=? WHERE name=?`).run(k === "enabled" || k === "logoGenerated" ? (v ? 1 : 0) : v, name);
    }
    return this.channelMeta(name)!;
  }
  /** Move a channel's settings, episode progress and build history to a new name.
   *  Anything still stored under the new name belongs to a channel that no longer
   *  exists (the caller checks there's no such channel), so it's cleared first. */
  renameChannel(from: string, to: string): void {
    this.db.exec("BEGIN");
    try {
      if (from.toLowerCase() !== to.toLowerCase() || from === to) {
        this.db.prepare(`DELETE FROM channel_meta WHERE name=?`).run(to);
        this.db.prepare(`DELETE FROM playout_progress WHERE channel=?`).run(to);
      }
      this.db.prepare(`UPDATE channel_meta SET name=? WHERE name=?`).run(to, from);
      this.db.prepare(`UPDATE playout_progress SET channel=? WHERE channel=?`).run(to, from);
      this.db.prepare(`UPDATE builds SET channel=? WHERE channel=?`).run(to, from);
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  deleteChannelMeta(name: string): void {
    this.db.prepare(`DELETE FROM channel_meta WHERE name=?`).run(name);
  }

  // --- ErsatzTV next streaming config (JSON blob in settings) ----------------
  getNextConfig(): NextConfig {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key='nextConfig'`).get() as any;
    const stored = row ? JSON.parse(row.value) : {};
    const merged = { ...defaultNextConfig(), ...stored,
      video: { ...defaultNextConfig().video, ...(stored.video ?? {}) },
      audio: { ...defaultNextConfig().audio, ...(stored.audio ?? {}) },
      upNext: { ...defaultNextConfig().upNext, ...(stored.upNext ?? {}) },
      guide: { ...defaultNextConfig().guide, ...(stored.guide ?? {}) },
      hdhr: { ...defaultNextConfig().hdhr, ...(stored.hdhr ?? {}) } };
    // ErsatzTV next names NVIDIA accel "cuda"; heal an earlier "nvenc" value.
    if (merged.video.accel === "nvenc") merged.video.accel = "cuda";
    return merged;
  }
  setNextConfig(patch: Partial<NextConfig>): NextConfig {
    const merged = { ...this.getNextConfig(), ...patch,
      video: { ...this.getNextConfig().video, ...(patch.video ?? {}) },
      audio: { ...this.getNextConfig().audio, ...(patch.audio ?? {}) },
      upNext: { ...this.getNextConfig().upNext, ...((patch as any).upNext ?? {}) },
      guide: { ...this.getNextConfig().guide, ...((patch as any).guide ?? {}) },
      hdhr: { ...this.getNextConfig().hdhr, ...((patch as any).hdhr ?? {}) } };
    // the device id is made by the server; a settings page saved before it existed mustn't blank it
    if (!merged.hdhr.deviceId) merged.hdhr.deviceId = this.getNextConfig().hdhr.deviceId;
    this.db.prepare(`INSERT INTO settings(key,value) VALUES('nextConfig',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(merged));
    return merged;
  }

  get(): AppConfig {
    const rows = this.db.prepare(`SELECT key, value FROM settings`).all() as any[];
    const m: Record<string, string> = {};
    for (const r of rows) m[r.key] = r.value;
    const bool = (v: string | undefined, d: boolean) => (v == null ? d : v === "true");
    const num = (v: string | undefined, d: number) => (v != null ? Number(v) : d);
    return {
      etvDbPath: m.etvDbPath ?? DEFAULTS.etvDbPath,
      libraryDbPath: m.libraryDbPath ?? DEFAULTS.libraryDbPath,
      channelsDir: m.channelsDir ?? DEFAULTS.channelsDir,
      outputDir: m.outputDir ?? DEFAULTS.outputDir,
      // (the old fixed `offsetMin` setting is ignored: it couldn't follow DST)
      timeZone: m.timeZone ?? DEFAULTS.timeZone,
      tz: m.timeZone && isValidTz(m.timeZone) ? m.timeZone : machineTz(),
      days: num(m.days, DEFAULTS.days),
      autoBuild: bool(m.autoBuild, DEFAULTS.autoBuild),
      buildIntervalMin: num(m.buildIntervalMin, DEFAULTS.buildIntervalMin),
      refreshThresholdHours: num(m.refreshThresholdHours, DEFAULTS.refreshThresholdHours),
      prunePast: bool(m.prunePast, DEFAULTS.prunePast),
      includeSpecials: bool(m.includeSpecials, DEFAULTS.includeSpecials),
      autoScanHours: num(m.autoScanHours, DEFAULTS.autoScanHours),
      keepNextRunning: bool(m.keepNextRunning, DEFAULTS.keepNextRunning),
      legacyImport: bool(m.legacyImport, DEFAULTS.legacyImport),
      selfUpdate: m.selfUpdate ?? DEFAULTS.selfUpdate,
      selfUpdateHour: num(m.selfUpdateHour, DEFAULTS.selfUpdateHour),
    };
  }

  set(patch: Partial<AppConfig>): AppConfig {
    const st = this.db.prepare(
      `INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
    if (patch.timeZone && !isValidTz(patch.timeZone)) throw new Error(`Unknown time zone "${patch.timeZone}" (use a name like America/Chicago).`);
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && k !== "tz") st.run(k, String(v));
    return this.get();
  }

  startBuild(channel: string): number {
    const r = this.db.prepare(
      `INSERT INTO builds(channel, started_at, status) VALUES(?,?, 'running')`).run(channel, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }
  finishBuild(id: number, status: string, itemCount: number | null, file: string | null, error: string | null) {
    this.db.prepare(
      `UPDATE builds SET finished_at=?, status=?, item_count=?, file=?, error=? WHERE id=?`)
      .run(new Date().toISOString(), status, itemCount, file, error, id);
  }
  recentBuilds(limit = 25): BuildRecord[] {
    return this.db.prepare(`SELECT * FROM builds ORDER BY id DESC LIMIT ?`).all(limit) as any[];
  }
}
