// -----------------------------------------------------------------------------
// ErsatzTV next + ErsatzTV-ffmpeg updater (Streaming page → "Programs")
// -----------------------------------------------------------------------------
// Checks GitHub for the latest tagged release of each, compares it with what's
// in the bin folder (the folder holding the ErsatzTV next binary), and installs
// one on request:
//   download (checked against GitHub's sha256 digest) → extract with `tar`
//   (Windows 10+ ships one that reads .zip) → swap the files into bin.
// Windows lets a running .exe/.dll be renamed but not overwritten, so the old
// files are renamed to *.old first; that works while next is streaming, and the
// .old files are deleted on the next update (or server start) once nothing uses
// them. If the managed next instance was running it's restarted onto the new
// build at the end.

import type { FastifyInstance } from "fastify";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, copyFileSync, chmodSync } from "node:fs";
import { dirname, isAbsolute, join, basename } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { appLog } from "./app-log.js";
import type { ConfigStore } from "./config.js";
import type { NextRunner } from "./next-runner.js";

type ComponentId = "next" | "ffmpeg";

interface Release { tag: string; publishedAt: string; pageUrl: string; asset: { name: string; size: number; url: string; digest: string | null } | null; notes: string }

export interface ComponentStatus {
  id: ComponentId;
  label: string;
  /** the file whose version is shown */
  path: string;
  found: boolean;
  /** version as the program reports it, e.g. "0.2.4+windows-x64" or "n8.1.2-etv.7" */
  installed: string | null;
  latest: { tag: string; publishedAt: string; pageUrl: string; asset: string | null; size: number } | null;
  updateAvailable: boolean;
  /** why an update is offered when the versions can't be compared, e.g. not ErsatzTV's ffmpeg */
  note: string | null;
}

export interface UpdateJob {
  component: ComponentId;
  phase: "downloading" | "extracting" | "installing" | "done" | "failed";
  received: number;
  total: number;
  message: string;
  startedAt: number;
}

export interface UpdateStatus {
  binDir: string;
  checkedAt: number | null;
  checkError: string | null;
  components: ComponentStatus[];
  /** the ffmpeg build the latest next release's notes say it needs, e.g. "8.1.2-6" */
  ffmpegRequired: string | null;
  job: UpdateJob | null;
}

const REPOS: Record<ComponentId, string> = { next: "ErsatzTV/next", ffmpeg: "ErsatzTV/ErsatzTV-ffmpeg" };
const EXE = process.platform === "win32" ? ".exe" : "";
const isAbs = (p: string) => isAbsolute(p) || /^[A-Za-z]:/.test(p);

/** The release asset for this machine, e.g. "ersatztv-next-v0.2.4-windows-x64.zip" or "ffmpeg-n8.1.2-etv.7-win64-gpl-8.1.zip". */
function assetPattern(id: ComponentId): RegExp | null {
  const arm = process.arch === "arm64";
  if (process.platform !== "win32" && process.platform !== "linux" && process.platform !== "darwin") return null;
  if (process.platform === "win32" && arm) return null;
  if (id === "next") {
    const plat = process.platform === "win32" ? "windows-x64" : process.platform === "darwin" ? `macos-${arm ? "arm64" : "x64"}` : `linux-${arm ? "arm64" : "x64"}`;
    return new RegExp(`-${plat}\\.(zip|tar\\.gz)$`);
  }
  const plat = process.platform === "win32" ? "win64" : process.platform === "darwin" ? (arm ? "macosarm64" : "macos64") : (arm ? "linuxarm64" : "linux64");
  return new RegExp(`^ffmpeg-.*-${plat}-gpl.*\\.(zip|tar\\.xz)$`);
}

/** [major, minor, patch, build] from "v0.2.4" / "0.2.4-5df6-develop+windows-x64" (next) or "8.1.2-7" / "n8.1.2-etv.7" (ffmpeg). */
function versionParts(id: ComponentId, v: string): { nums: number[]; pre: boolean } | null {
  if (id === "next") {
    const m = v.match(/(\d+)\.(\d+)\.(\d+)(-[^+\s]+)?/);
    return m ? { nums: [+m[1], +m[2], +m[3]], pre: !!m[4] } : null;
  }
  const m = v.match(/(\d+)\.(\d+)(?:\.(\d+))?-(?:etv\.)?(\d+)/);
  return m ? { nums: [+m[1], +m[2], +(m[3] ?? 0), +m[4]], pre: false } : null;
}

/** Is `latest` newer than `installed`? A develop/CI build counts as older than the release of the same number. */
function isNewer(id: ComponentId, latest: string, installed: string): boolean | null {
  const a = versionParts(id, latest), b = versionParts(id, installed);
  if (!a || !b) return null;
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const d = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (d) return d > 0;
  }
  return b.pre && !a.pre;
}

export class Updater {
  private releases: Partial<Record<ComponentId, Release>> = {};
  private checkedAt: number | null = null;
  private checkError: string | null = null;
  private job: UpdateJob | null = null;
  private versionCache = new Map<string, { key: string; version: string | null }>();

  constructor(private store: ConfigStore, private root: string, private runner?: NextRunner) {
    this.cleanOldFiles();
  }

  binDir(): string {
    const p = this.store.getNextConfig().binaryPath || `bin/ersatztv${EXE}`;
    return dirname(isAbs(p) ? p : join(this.root, p));
  }
  private nextPath(): string { const p = this.store.getNextConfig().binaryPath || `bin/ersatztv${EXE}`; return isAbs(p) ? p : join(this.root, p); }
  private ffmpegPath(): string { const p = this.store.getNextConfig().ffmpegPath; return p ? (isAbs(p) ? p : join(this.root, p)) : join(this.binDir(), `ffmpeg${EXE}`); }

  /** What the program prints for its version, re-run only when the file changes. */
  private installedVersion(file: string, args: string[], re: RegExp): string | null {
    let key: string;
    try { const st = statSync(file); key = `${st.mtimeMs}|${st.size}`; } catch { return null; }
    const hit = this.versionCache.get(file);
    if (hit?.key === key) return hit.version;
    const r = spawnSync(file, args, { timeout: 8000, encoding: "utf8", windowsHide: true });
    const m = String(r.stdout ?? "").match(re);
    const version = m ? m[0] : null;
    this.versionCache.set(file, { key, version });
    return version;
  }

  private async fetchRelease(id: ComponentId): Promise<Release> {
    const r = await fetch(`https://api.github.com/repos/${REPOS[id]}/releases/latest`, {
      headers: { "user-agent": "tv-next-scheduler", accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(r.status === 403 ? "GitHub's rate limit was hit; try again in an hour" : `GitHub answered ${r.status} for ${REPOS[id]}`);
    const j = await r.json() as any;
    const pat = assetPattern(id);
    const a = pat ? (j.assets ?? []).find((x: any) => pat.test(x.name)) : null;
    return {
      tag: j.tag_name, publishedAt: j.published_at, pageUrl: j.html_url, notes: String(j.body ?? ""),
      asset: a ? { name: a.name, size: a.size, url: a.browser_download_url, digest: typeof a.digest === "string" ? a.digest : null } : null,
    };
  }

  /** Re-fetches the latest releases (cached for 10 minutes unless forced). */
  async check(force = false): Promise<void> {
    if (!force && this.checkedAt && Date.now() - this.checkedAt < 10 * 60_000) return;
    try {
      const [n, f] = await Promise.all([this.fetchRelease("next"), this.fetchRelease("ffmpeg")]);
      this.releases = { next: n, ffmpeg: f }; this.checkError = null;
    } catch (e) {
      this.checkError = (e as Error).name === "TimeoutError" ? "GitHub didn't answer in time" : (e as Error).message;
    }
    this.checkedAt = Date.now();
  }

  private component(id: ComponentId): ComponentStatus {
    const path = id === "next" ? this.nextPath() : this.ffmpegPath();
    const installed = id === "next"
      ? this.installedVersion(path, ["--version"], /\d+\.\d+\.\d+\S*/)
      : this.installedVersion(path, ["-version"], /(?<=ffmpeg version )\S+/);
    const rel = this.releases[id];
    let updateAvailable = false, note: string | null = null;
    if (rel?.asset) {
      if (!installed) { updateAvailable = true; note = existsSync(path) ? "couldn't read its version" : "not installed"; }
      else {
        const newer = isNewer(id, rel.tag, installed);
        if (newer === null) { updateAvailable = true; note = id === "ffmpeg" ? "not ErsatzTV's ffmpeg build" : "unrecognised version"; }
        else updateAvailable = newer;
      }
    } else if (rel) note = "no download for this platform";
    return {
      id, label: id === "next" ? "ErsatzTV next" : "ErsatzTV ffmpeg", path, found: existsSync(path), installed,
      latest: rel ? { tag: rel.tag, publishedAt: rel.publishedAt, pageUrl: rel.pageUrl, asset: rel.asset?.name ?? null, size: rel.asset?.size ?? 0 } : null,
      updateAvailable, note,
    };
  }

  status(): UpdateStatus {
    const req = this.releases.next?.notes.match(/ErsatzTV-ffmpeg\s+`?(\d+\.\d+(?:\.\d+)?-\d+)`?/i);
    return {
      binDir: this.binDir(), checkedAt: this.checkedAt, checkError: this.checkError,
      components: [this.component("next"), this.component("ffmpeg")],
      ffmpegRequired: req ? req[1] : null, job: this.job,
    };
  }

  busy(): boolean { return !!this.job && (this.job.phase === "downloading" || this.job.phase === "extracting" || this.job.phase === "installing"); }

  /** Starts installing the latest release of each component, one after the other, in the background. */
  async install(ids: ComponentId[]): Promise<void> {
    if (this.busy()) throw new Error("an update is already running");
    await this.check();
    const rels: [ComponentId, Release][] = [];
    for (const id of ids) {
      const rel = this.releases[id];
      if (!rel) throw new Error(this.checkError ?? "couldn't reach GitHub");
      if (!rel.asset) throw new Error(`${REPOS[id]} ${rel.tag} has no download for this platform (${process.platform}-${process.arch})`);
      rels.push([id, rel]);
    }
    if (!rels.length) throw new Error("nothing to update");
    this.job = { component: rels[0][0], phase: "downloading", received: 0, total: 0, message: "Starting…", startedAt: Date.now() };
    void (async () => {
      const done: string[] = [];
      for (const [id, rel] of rels) {
        Object.assign(this.job!, { component: id, phase: "downloading", received: 0, total: rel.asset!.size, message: `Downloading ${rel.asset!.name}…` });
        try { await this.run(id, rel); done.push(`${id === "next" ? "ErsatzTV next" : "ffmpeg"} ${rel.tag}`); }
        catch (e) {
          Object.assign(this.job!, { phase: "failed", message: `${done.length ? `Installed ${done.join(" and ")}, but ` : ""}${id === "next" ? "ErsatzTV next" : "ffmpeg"}: ${(e as Error).message}` });
          appLog("updates", `${id} update failed: ${(e as Error).message}`);
          return;
        }
      }
      // restart the managed instance onto the new build(s)
      let restarted = false;
      if (this.runner?.status().phase === "running") { await this.runner.restart(); restarted = true; }
      Object.assign(this.job!, { phase: "done", message: `Installed ${done.join(" and ")}.${restarted ? " ErsatzTV next was restarted to use it." : ""}` });
    })();
  }

  private async run(id: ComponentId, rel: Release): Promise<void> {
    const job = this.job!, asset = rel.asset!;
    const bin = this.binDir();
    const work = join(bin, ".update");
    rmSync(work, { recursive: true, force: true });
    mkdirSync(join(work, "x"), { recursive: true });
    this.cleanOldFiles();

    // 1. download, hashing as it streams
    const archive = join(work, asset.name);
    const res = await fetch(asset.url, { headers: { "user-agent": "tv-next-scheduler" } });
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
    job.total = Number(res.headers.get("content-length")) || asset.size;
    const hash = createHash("sha256");
    const counter = new Transform({ transform(chunk, _enc, cb) { job.received += chunk.length; hash.update(chunk); cb(null, chunk); } });
    await pipeline(Readable.fromWeb(res.body as any), counter, createWriteStream(archive));
    const digest = hash.digest("hex");
    if (asset.digest?.startsWith("sha256:") && asset.digest.slice(7).toLowerCase() !== digest) {
      throw new Error("the download didn't match GitHub's checksum; nothing was changed. Try again.");
    }

    // 2. extract
    job.phase = "extracting"; job.message = `Unpacking ${asset.name}…`;
    await new Promise<void>((resolve, reject) => {
      const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
      const p = spawn(tar, ["-xf", archive, "-C", join(work, "x")], { windowsHide: true });
      let err = "";
      p.stderr.on("data", (d) => { err += String(d); });
      p.on("error", reject);
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`unpacking failed: ${err.trim() || `tar exited ${code}`}`))));
    });
    const main = id === "next" ? `ersatztv${EXE}` : `ffmpeg${EXE}`;
    const from = findDirWith(join(work, "x"), main, 4);
    if (!from) throw new Error(`${main} wasn't in ${asset.name}`);

    // 3. swap the files in: rename what's there to *.old (allowed even while running), then move the new ones in
    job.phase = "installing"; job.message = "Installing…";
    const files = readdirSync(from, { withFileTypes: true }).filter((d) => d.isFile() && !/^ffplay/i.test(d.name)).map((d) => d.name);
    for (const name of files) {
      const dest = join(bin, name);
      if (existsSync(dest)) {
        let old = `${dest}.old`;
        try { rmSync(old, { force: true }); } catch { old = `${dest}.${Date.now()}.old`; }
        renameSync(dest, old);
      }
      try { renameSync(join(from, name), dest); } catch { copyFileSync(join(from, name), dest); }
      if (process.platform !== "win32") { try { chmodSync(dest, 0o755); } catch { /* not ours to change */ } }
    }
    rmSync(work, { recursive: true, force: true });

    // 4. point the settings at the new files
    const nc = this.store.getNextConfig();
    if (id === "ffmpeg") {
      const ff = join(bin, `ffmpeg${EXE}`), fp = join(bin, `ffprobe${EXE}`);
      if (nc.ffmpegPath !== ff || nc.ffprobePath !== fp) this.store.setNextConfig({ ffmpegPath: ff, ffprobePath: existsSync(fp) ? fp : nc.ffprobePath });
    } else if (basename(this.nextPath()) !== main) {
      this.store.setNextConfig({ binaryPath: join(bin, main) });
    }
    appLog("updates", `installed ${REPOS[id]} ${rel.tag} (${files.length} files) into ${bin}`);
  }

  /** Deletes *.old files left by an earlier update (skips any still in use). */
  private cleanOldFiles(): void {
    try {
      for (const f of readdirSync(this.binDir())) if (f.endsWith(".old")) { try { rmSync(join(this.binDir(), f), { force: true }); } catch { /* still running */ } }
    } catch { /* no bin folder yet */ }
  }
}

/** The folder under `dir` (or `dir` itself) holding `file`, searching `depth` levels down. */
function findDirWith(dir: string, file: string, depth: number): string | null {
  if (existsSync(join(dir, file))) return dir;
  if (depth <= 0) return null;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const hit = findDirWith(join(dir, d.name), file, depth - 1);
    if (hit) return hit;
  }
  return null;
}

export function registerUpdateRoutes(app: FastifyInstance, updater: Updater) {
  app.get("/api/updates", async (req) => {
    const q = req.query as { refresh?: string; cached?: string };
    if (q.cached !== "1") await updater.check(q.refresh === "1");
    return updater.status();
  });
  app.post("/api/updates/install", async (req, reply) => {
    const ids = (req.body as { components?: string[] })?.components ?? [];
    if (!ids.length || ids.some((id) => id !== "next" && id !== "ffmpeg")) return reply.code(400).send({ error: "components must list next and/or ffmpeg" });
    try { await updater.install([...new Set(ids)] as ComponentId[]); } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
    return updater.status();
  });
}
