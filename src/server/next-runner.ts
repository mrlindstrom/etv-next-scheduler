// -----------------------------------------------------------------------------
// ErsatzTV *next* process supervisor
// -----------------------------------------------------------------------------
// Keeps a single `ersatztv.exe runtime/lineup.json` instance alive while the
// "keep next running" toggle is on AND there are valid playouts to serve.
//   * auto-start once playouts exist; auto-restart on crash (exponential backoff)
//   * tracks the channel/streaming "signature" it was launched with, so the UI
//     can flag when the running instance is out of date (new channel, port/ffmpeg
//     change) and offer a manual Restart — live viewers aren't interrupted until
//     the user chooses.
// Playout top-ups just drop new window files into the folder next already watches,
// so they don't require a restart.

import { appLog, pipeChildToLog } from "./app-log.js";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import type { ConfigStore } from "./config.js";
import { generateNext, playoutBaseDir } from "./nextgen.js";
import { fallbackInUse } from "./fallback-image.js";

const abs = (root: string, p: string) => (isAbsolute(p) || /^[A-Za-z]:/.test(p) ? p : join(root, p));

type Phase = "stopped" | "waiting" | "starting" | "running" | "crashed";

export interface NextStatus {
  enabled: boolean;
  phase: Phase;
  detail: string;
  /** a setting that stops next from starting (e.g. a missing output folder), shown on the Streaming page */
  problem: string | null;
  pid: number | null;
  uptimeSec: number;
  port: number;
  stale: boolean;
  hasPlayouts: boolean;
  binaryFound: boolean;
  binaryPath: string;
  /** what `ersatztv --version` printed, e.g. "0.2.3+windows-x64" */
  version: string | null;
  /** set when the binary is too old for the configs we write */
  versionWarning: string | null;
  restarts: number;
  lastExit: { code: number | null; signal: string | null; at: number } | null;
  log: string[];
}

export class NextRunner {
  private proc: ChildProcess | null = null;
  private phase: Phase = "stopped";
  private detail = "";
  private problem: string | null = null;
  private startedAt = 0;
  private runningSig = "";
  private failures = 0;
  private restarts = 0;
  private nextAllowedStart = 0;
  private manualStop = false;
  private lastExit: NextStatus["lastExit"] = null;
  private log: string[] = [];
  private versionCache: { key: string; version: string | null } = { key: "", version: null };
  private timer: NodeJS.Timeout;

  constructor(private store: ConfigStore, private root: string) {
    this.timer = setInterval(() => this.ensureRunning(), 10_000);
    // don't auto-launch instantly on boot; give the server a beat
    setTimeout(() => this.ensureRunning(), 3_000);
  }

  // ---- signature / preconditions -------------------------------------------
  private currentSig(): string {
    const metas = this.store.channelMetas().filter((m) => m.enabled)
      .map((m) => ({ name: m.name, number: m.number, tvgId: m.tvgId, logo: m.logo, group: m.group, ...(m.encoding ? { enc: m.encoding } : {}), ...(m.fallbackImage ? { fb: m.fallbackImage } : {}) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const nc = this.store.getNextConfig();
    // logo URLs are built from publicUrl (only part of the signature once set)
    return JSON.stringify({ metas, port: nc.port, bind: nc.bindAddress, ff: [nc.ffmpegPath, nc.ffprobePath], v: nc.video, a: nc.audio, ...(nc.publicUrl ? { pub: nc.publicUrl } : {}), ...(nc.fallbackImage && nc.fallbackImage !== "black" ? { fb: nc.fallbackImage } : {}) });
  }
  private binaryPath(): string { return abs(this.root, this.store.getNextConfig().binaryPath || "bin/ersatztv.exe"); }
  private hasPlayouts(): boolean {
    const base = playoutBaseDir(this.store, this.root);
    for (const m of this.store.channelMetas().filter((c) => c.enabled)) {
      try {
        const files = readdirSync(join(base, m.name)).filter((f) => f.endsWith(".json") && !f.endsWith(".labels.json"));
        if (files.length) return true;
      } catch { /* no folder yet */ }
    }
    return false;
  }

  /** The binary's version, re-read only when the file changes (status is polled). */
  private binaryVersion(): string | null {
    const bin = this.binaryPath();
    let key: string;
    try { const st = statSync(bin); key = `${bin}|${st.mtimeMs}|${st.size}`; } catch { return null; }
    if (key !== this.versionCache.key) {
      const r = spawnSync(bin, ["--version"], { timeout: 5000, encoding: "utf8", windowsHide: true });
      const m = String(r.stdout ?? "").match(/\d+\.\d+\.\d+\S*/);
      this.versionCache = { key, version: m ? m[0] : null };
    }
    return this.versionCache.version;
  }

  /** Builds before 0.2.0 (they report "0.1.0-<commit>") predate versioned channel
   *  configs and miss fixes we rely on, e.g. keeping time when a playout is replaced. */
  private versionWarning(version: string | null): string | null {
    const m = version?.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (maj === 0 && min < 2) return `This ErsatzTV next build (${version}) is older than 0.2.0. Use "Update" under Programs below to install the latest release and its ffmpeg.`;
    // fallback images write channel config 0.1.3, which older builds refuse
    if (maj === 0 && min === 2 && pat < 4 && fallbackInUse(this.store.channelMetas(), this.store.getNextConfig())) {
      return `Fallback images need ErsatzTV next 0.2.4 or newer, and this build (${version}) won't play channels that use one. Use "Update" under Programs below, or set the fallback back to Black.`;
    }
    return null;
  }

  /** A streaming setting next can't run with on this machine, or null. */
  private settingsProblem(): string | null {
    const nc = this.store.getNextConfig();
    const runtimeDir = abs(this.root, nc.runtimeDir);
    const out = abs(runtimeDir, nc.outputFolder || "./output");
    try { mkdirSync(out, { recursive: true }); }
    catch { return `the output folder ${out} doesn't exist on this machine and can't be created. Change "Segment output folder" below, then Apply.`; }
    for (const [label, p] of [["ffmpeg", nc.ffmpegPath], ["ffprobe", nc.ffprobePath]] as const) {
      if (p && (isAbsolute(p) || /^[A-Za-z]:/.test(p)) && !existsSync(p)) return `${label} isn't at ${p} on this machine. Fix the ${label} path below, then Apply.`;
    }
    return null;
  }

  private note(s: string): void {
    appLog("next", String(s));
    for (const line of String(s).split("\n")) { const t = line.replace(/\s+$/, ""); if (t) this.log.push(`${new Date().toISOString().slice(11, 19)} ${t}`); }
    if (this.log.length > 300) this.log = this.log.slice(-300);
  }

  // ---- lifecycle ------------------------------------------------------------
  /** Called on the timer + after config changes: start if it should be running. */
  ensureRunning(): void {
    if (!this.store.get().keepNextRunning) return;
    if (this.proc || this.phase === "starting") return;
    if (Date.now() < this.nextAllowedStart) return;
    void this.start(false);
  }

  /** (Re)evaluate on toggle / config change. */
  reconfigure(): void {
    if (this.store.get().keepNextRunning) this.ensureRunning();
    else if (this.proc) this.stop(true);
    else { this.phase = "stopped"; this.detail = "disabled"; }
  }

  async start(manual: boolean): Promise<void> {
    if (this.proc) return;
    this.manualStop = false;
    const bin = this.binaryPath();
    if (!existsSync(bin)) { this.phase = "waiting"; this.detail = `binary not found: ${bin}`; return; }
    if (!this.hasPlayouts()) { this.phase = "waiting"; this.detail = "waiting for a built playout"; return; }
    // Settings copied from another machine can name drives/files that don't exist
    // here; next would just crash-loop on "path not found", so say what's wrong.
    const problem = this.settingsProblem();
    if (problem) {
      if (problem !== this.problem) this.note(`not starting: ${problem}`);
      this.problem = problem; this.phase = "waiting"; this.detail = problem;
      return;
    }
    this.problem = null;

    this.phase = "starting"; this.detail = "applying settings…";
    try { await generateNext(this.store, this.root); }
    catch (e) { this.note(`apply failed: ${(e as Error).message}`); }

    const nc = this.store.getNextConfig();
    const runtimeDir = abs(this.root, nc.runtimeDir);
    const lineupArg = join(nc.runtimeDir, "lineup.json"); // relative to root cwd, like run-next.ps1
    this.runningSig = this.currentSig();
    if (manual) this.restarts++;

    let child: ChildProcess;
    try { child = spawn(bin, [lineupArg], { cwd: this.root }); }
    catch (e) { this.phase = "crashed"; this.detail = `spawn failed: ${(e as Error).message}`; this.note(this.detail); this.scheduleRetry(); return; }

    this.proc = child; this.startedAt = Date.now();
    this.phase = "running"; this.detail = `running on port ${nc.port}`;
    this.note(`started ErsatzTV next (pid ${child.pid}) on port ${nc.port}`);
    void runtimeDir;

    child.stdout?.on("data", (d) => this.note(String(d)));
    child.stderr?.on("data", (d) => this.note(String(d)));
    child.on("error", (e) => { this.note(`process error: ${String(e)}`); });
    child.on("exit", (code, signal) => {
      this.proc = null;
      this.lastExit = { code, signal, at: Date.now() };
      const ranAWhile = Date.now() - this.startedAt > 30_000;
      if (ranAWhile) this.failures = 0; else this.failures++;
      if (this.manualStop || !this.store.get().keepNextRunning) {
        this.phase = "stopped"; this.detail = "stopped";
        this.note(`exited (code ${code}${signal ? `, ${signal}` : ""})`);
      } else {
        this.phase = "crashed";
        this.scheduleRetry();
        this.note(`exited unexpectedly (code ${code}${signal ? `, ${signal}` : ""})`);
      }
    });
  }

  private scheduleRetry(): void {
    const backoff = Math.min(30_000, 1_000 * 2 ** Math.min(this.failures, 5));
    this.nextAllowedStart = Date.now() + backoff;
    this.detail = `crashed — retrying in ${Math.round(backoff / 1000)}s`;
  }

  stop(manual: boolean): void {
    this.manualStop = manual;
    this.nextAllowedStart = 0;
    if (this.proc) { try { this.proc.kill(); } catch { /* already gone */ } }
    else { this.phase = "stopped"; this.detail = manual ? "stopped" : "disabled"; }
  }

  async restart(): Promise<void> {
    this.note("restart requested");
    if (this.proc) {
      const p = this.proc; this.manualStop = true;
      await new Promise<void>((resolve) => { p.once("exit", () => resolve()); try { p.kill(); } catch { resolve(); } });
    }
    this.manualStop = false; this.failures = 0; this.nextAllowedStart = 0;
    await this.start(true);
  }

  dispose(): void { clearInterval(this.timer); if (this.proc) { try { this.proc.kill(); } catch {} } }

  status(): NextStatus {
    const nc = this.store.getNextConfig();
    const running = this.phase === "running" && !!this.proc;
    const version = this.binaryVersion();
    return {
      enabled: this.store.get().keepNextRunning,
      phase: this.phase, detail: this.detail, problem: this.phase === "waiting" ? this.problem : null,
      pid: this.proc?.pid ?? null,
      uptimeSec: running ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      port: nc.port,
      stale: running && this.runningSig !== this.currentSig(),
      hasPlayouts: this.hasPlayouts(),
      binaryFound: existsSync(this.binaryPath()), binaryPath: this.binaryPath(),
      version, versionWarning: this.versionWarning(version),
      restarts: this.restarts,
      lastExit: this.lastExit,
      log: this.log.slice(-80),
    };
  }
}
