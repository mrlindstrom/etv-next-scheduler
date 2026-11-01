// -----------------------------------------------------------------------------
// Background auto-build scheduler
// -----------------------------------------------------------------------------
// Keeps every channel's playout coverage extended to ~now+days. On each tick it
// looks at the existing (day-aligned) window files and, when coverage falls
// short of the target by more than the threshold, APPENDS a new future window
// starting where coverage ends. It never rewrites the currently-airing window,
// so a live stream is undisturbed. Optionally prunes fully-past windows.

import { overlayOptionsFor } from "./overlay-library.js";
import { appLog, pipeChildToLog } from "./app-log.js";
import { indexService } from "./index-service.js";
import { readdir, stat, unlink } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { spawn } from "node:child_process";
import { refreshPodsChannelFile } from "./pods-channel.js";
import { buildChannel, timeshiftSource, writeShiftedXmltv } from "../index.js";
import { mergeChannelXmltv } from "../xmltv.js";
import { schedulerBaseUrl } from "./channel-logos.js";
import { floorLocalMidnight, ceilLocalMidnight } from "../time.js";
import { getResolver, dropResolver } from "./resolverCache.js";
import { effectiveDbPath } from "./library-import.js";
import { listLibraries, libraryExists } from "./library-repo.js";
import { playoutBaseDir, upNextOptionsFor, writeGuidePlayout } from "./nextgen.js";
import type { ConfigStore, AppConfig } from "./config.js";

const abs = (root: string, p: string) => (p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : join(root, p));

// finish epoch from a "{start}_{finish}.json" compact filename
function windowFinishMs(file: string): number | null {
  const m = basename(file, ".json").match(/_(\d{8})T(\d{6})\.\d+([+-]\d{2})(\d{2})$/);
  if (!m) return null;
  const [, d, t, oh, om] = m;
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}${oh}:${om}`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export interface SchedulerStatus {
  enabled: boolean; intervalMin: number; thresholdHours: number;
  running: boolean; lastTick: string | null; nextTickAt: string | null; log: string[];
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastTick: number | null = null;
  private nextTickAt: number | null = null;
  private log: string[] = [];
  private cfg: AppConfig;

  constructor(private store: ConfigStore, private root: string) {
    this.cfg = store.get();
  }

  status(): SchedulerStatus {
    const c = this.store.get();
    return {
      enabled: c.autoBuild, intervalMin: c.buildIntervalMin, thresholdHours: c.refreshThresholdHours,
      running: this.running,
      lastTick: this.lastTick ? new Date(this.lastTick).toISOString() : null,
      nextTickAt: this.nextTickAt ? new Date(this.nextTickAt).toISOString() : null,
      log: this.log.slice(-40),
    };
  }

  /** (Re)configure from current app config: start/stop the interval. */
  reconfigure(): void {
    this.cfg = this.store.get();
    if (this.timer) { clearInterval(this.timer); this.timer = null; this.nextTickAt = null; }
    if (!this.cfg.autoBuild && this.cfg.autoScanHours <= 0) { this.note("automation disabled"); return; }
    const ms = Math.max(1, this.cfg.buildIntervalMin) * 60_000;
    this.note(`automation enabled; checking every ${this.cfg.buildIntervalMin} min` + (this.cfg.autoScanHours > 0 ? ` (rescan local + remote libraries older than ${this.cfg.autoScanHours}h)` : ""));
    this.timer = setInterval(() => void this.tick(), ms);
    this.nextTickAt = Date.now() + ms;
    void this.tick(); // run one immediately
  }

  /** Force a coverage check now (used by the API "run top-up" button). */
  async runNow(): Promise<void> { await this.tick(); }

  private note(msg: string) {
    appLog("scheduler", msg);
    const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
    this.log.push(line);
    if (this.log.length > 200) this.log = this.log.slice(-200);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.lastTick = Date.now();
    try {
      const c = this.store.get();
      // keep libraries fresh first, so the build sees new/removed files
      await this.scanStaleLocal(c);
      await this.scanStaleRemote(c);
      if (!c.autoBuild) return;
      const dbPath = effectiveDbPath(abs(this.root, c.libraryDbPath), c.etvDbPath);
      if (!dbPath) { this.note("skip: no database configured"); return; }
      const channelsDir = abs(this.root, c.channelsDir);
      const { listChannelFiles } = await import("./../scheduling/registry.js");
      const chFiles = await listChannelFiles(channelsDir);
      // time-shift channels copy another channel's playout: top them up after the rest
      const shiftOf = new Map<string, string>();
      for (const ch of chFiles) { const src = await timeshiftSource(ch.path); if (src) shiftOf.set(ch.name, src); }
      chFiles.sort((a, b) => Number(shiftOf.has(a.name)) - Number(shiftOf.has(b.name)));
      if (!chFiles.length) { this.note("skip: no channel configs"); return; }

      const now = Date.now();
      const targetEnd = ceilLocalMidnight(now + c.days * 86_400_000, c.tz);
      const thresholdMs = c.refreshThresholdHours * 3_600_000;
      const resolver = getResolver(dbPath);
      resolver.setDisabledLibraries(this.store.disabledLibraryIds());
      resolver.setExcludeSpecials(!c.includeSpecials);

      for (const ch of chFiles) {
        const name = ch.name;
        const outDir = join(playoutBaseDir(this.store, this.root), name);
        const coverageEnd = await this.coverageEnd(outDir);
        // start where coverage ends if it still covers "now"; else at today's midnight
        const startInstant = coverageEnd && coverageEnd >= now ? coverageEnd : floorLocalMidnight(now, c.tz);
        const gap = targetEnd - startInstant;
        if (gap <= thresholdMs || startInstant >= targetEnd) continue;

        const rec = this.store.startBuild(name);
        try {
          this.note(`${name}: extending coverage +${Math.round(gap / 3_600_000)}h`);
          await refreshPodsChannelFile(ch.path, this.store.listPods()); // keep pod snapshot fresh
          const cm = this.store.channelMeta(name);
          const xmltvDir = join(abs(this.root, this.store.getNextConfig().runtimeDir), "xmltv");
          const src = shiftOf.get(name);
          const res = await buildChannel({
            configPath: ch.path, resolver, outputDir: outDir,
            sourceXmltv: src ? join(xmltvDir, `${this.store.channelMeta(src)?.tvgId || src}.xml`) : undefined,
            options: { startMs: startInstant, finishMs: targetEnd, tz: c.tz, seed: hashName(name), progress: this.store.getProgress(name),
              preferredAudioLang: cm?.audioLang || undefined, subtitles: cm?.subtitles || undefined,
              upNext: await upNextOptionsFor(this.store, name, this.root), overlays: overlayOptionsFor(this.store, name, this.root) },
          });
          this.store.saveProgress(name, res.progress);
          try {
            const tvgId = this.store.channelMeta(name)?.tvgId || name;
            if (res.xmltv != null) await writeShiftedXmltv(xmltvDir, tvgId, res.xmltv);
            else await mergeChannelXmltv(xmltvDir, tvgId, res.guide, c.tz, now, resolver, schedulerBaseUrl(this.store.getNextConfig().publicUrl, Number(process.env.PORT ?? 8730)));
          } catch (e) { this.note(`  ${name}: xmltv warning ${(e as Error).message}`); }
          this.store.finishBuild(rec, "done", res.itemCount, res.file, null);
          this.note(`  ${name}: +${res.itemCount} items, ${res.guide.length} guide entries`);
          if (res.overlayProblems?.length) this.note(`  ${name}: overlays: ${res.overlayProblems.join("; ")}`);
        } catch (e) {
          const msg = (e as Error).message;
          this.store.finishBuild(rec, "error", null, null, msg);
          this.note(`  ${name}: ERROR ${msg}`);
        }
        if (c.prunePast) await this.prune(outDir, now);
      }

      // TV-guide scroller channel coverage (a synthetic channel, not a YAML file).
      if (this.store.getNextConfig().guide.enabled) {
        try {
          const gdir = join(playoutBaseDir(this.store, this.root), "guide");
          const gCov = await this.coverageEnd(gdir);
          const gStart = gCov && gCov >= now ? gCov : floorLocalMidnight(now, c.tz);
          if (targetEnd - gStart > thresholdMs) {
            await writeGuidePlayout(this.store, this.root, gStart, targetEnd, c.tz);
            this.note(`  guide: extended scroller coverage`);
          }
          if (c.prunePast) await this.prune(gdir, now);
        } catch (e) { this.note(`  guide: ERROR ${(e as Error).message}`); }
      }
    } finally {
      this.running = false;
      if (this.timer) this.nextTickAt = Date.now() + Math.max(1, this.store.get().buildIntervalMin) * 60_000;
    }
  }

  /** Rescan local libraries whose last scan is older than autoScanHours. */
  private async scanStaleLocal(c: AppConfig): Promise<void> {
    if (c.autoScanHours <= 0) return;
    const libPath = abs(this.root, c.libraryDbPath);
    if (!libraryExists(libPath)) return;
    let libs;
    try { libs = listLibraries(libPath); } catch { return; }
    // Note: the enabled flag controls scheduling inclusion, not scan freshness —
    // keep every library's mirror up to date regardless of whether it's enabled.
    const cutoff = Date.now() - c.autoScanHours * 3_600_000;
    const stale = libs.filter((l) => l.sourceType === "local" && (!l.lastScan || Date.parse(l.lastScan) < cutoff));
    if (!stale.length) return;
    const ffprobe = this.store.getNextConfig().ffprobePath || "ffprobe";
    for (const l of stale) {
      this.note(`scan: ${l.name} (last ${l.lastScan ?? "never"})`);
      await this.runScanChild(l.id, libPath, ffprobe);
    }
    indexService.changed(); // apply what the scans queued for re-indexing
  }

  private runScanChild(id: number, libPath: string, ffprobe: string): Promise<void> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [join(this.root, "dist", "cli.js"), "scan-library", "--library", String(id), "--db", libPath, "--ffprobe", ffprobe], { cwd: this.root });
      pipeChildToLog(child, "scan");
      let summary: string | null = null;
      child.stdout.on("data", (d) => { const m = String(d).match(/^DONE: found \d+, added (\d+), updated (\d+), unchanged \d+, missing (\d+)/m); if (m) summary = `+${m[1]} ~${m[2]} missing:${m[3]}`; });
      child.on("close", () => { if (summary) this.note(`  library ${id}: ${summary}`); resolve(); });
      child.on("error", (e) => { this.note(`  library ${id}: scan error ${String(e)}`); resolve(); });
    });
  }

  /** Rescan remote sources (Plex/Jellyfin/Emby) that have a saved token and stale libraries. */
  private async scanStaleRemote(c: AppConfig): Promise<void> {
    if (c.autoScanHours <= 0) return;
    const libPath = abs(this.root, c.libraryDbPath);
    if (!libraryExists(libPath)) return;
    let libs;
    try { libs = listLibraries(libPath); } catch { return; }
    const cutoff = Date.now() - c.autoScanHours * 3_600_000;
    // Group stale remote libraries by source (a scan refreshes the whole source).
    // The enabled flag only affects scheduling inclusion, so it does not gate scans.
    const staleSources = new Set<number>();
    for (const l of libs) {
      if (l.sourceType === "local") continue;
      if (!l.lastScan || Date.parse(l.lastScan) < cutoff) staleSources.add(l.sourceId);
    }
    let scanned = 0;
    for (const sid of staleSources) {
      if (!this.store.hasSourceToken(sid)) { this.note(`skip remote source ${sid}: no saved token`); continue; }
      this.note(`scan: remote source ${sid}`);
      await this.runRemoteScanChild(sid, libPath);
      scanned++;
    }
    if (scanned) indexService.changed();
  }

  private runRemoteScanChild(sourceId: number, libPath: string): Promise<void> {
    return new Promise((resolve) => {
      const secret = this.store.getSourceSecret(sourceId);
      const args = [join(this.root, "dist", "cli.js"), "scan-remote", "--source", String(sourceId), "--db", libPath, "--token", secret.token];
      if (secret.address) args.push("--address", secret.address);
      const child = spawn(process.execPath, args, { cwd: this.root });
      pipeChildToLog(child, "scan");
      let summary: string | null = null;
      child.stdout.on("data", (d) => { const m = String(d).match(/^DONE: \d+ libraries, found \d+, added (\d+), updated (\d+), missing (\d+)/m); if (m) summary = `+${m[1]} ~${m[2]} missing:${m[3]}`; });
      child.on("close", () => { if (summary) this.note(`  source ${sourceId}: ${summary}`); resolve(); });
      child.on("error", (e) => { this.note(`  source ${sourceId}: scan error ${String(e)}`); resolve(); });
    });
  }

  private async coverageEnd(outDir: string): Promise<number | null> {
    let files: string[] = [];
    try { files = (await readdir(outDir)).filter((f) => f.endsWith(".json") && !f.endsWith(".labels.json")); } catch { return null; }
    let max: number | null = null;
    for (const f of files) { const fin = windowFinishMs(f); if (fin != null && (max == null || fin > max)) max = fin; }
    return max;
  }

  private async prune(outDir: string, now: number): Promise<void> {
    let files: string[] = [];
    try { files = await readdir(outDir); } catch { return; }
    for (const f of files) {
      if (!f.endsWith(".json") || f.endsWith(".labels.json")) continue;
      const fin = windowFinishMs(f);
      if (fin != null && fin < now) {
        try { await unlink(join(outDir, f)); } catch {}
        try { await unlink(join(outDir, f.replace(/\.json$/, ".labels.json"))); } catch {}
        this.note(`  pruned past window ${f}`);
      }
    }
    void stat;
  }
}

function hashName(s: string): number { let h = 0; for (const c of s) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0; return Math.abs(h); }
