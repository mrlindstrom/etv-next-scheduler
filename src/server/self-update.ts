// -----------------------------------------------------------------------------
// Updating the scheduler itself from git (Settings → Scheduler updates)
// -----------------------------------------------------------------------------
// check:   `git fetch`, then what the upstream branch has that this copy doesn't.
// install: fast-forward to it, `npm install` where package files changed, build
//          the server into dist-next/ and the web UI into web/dist-next/ (the
//          running version keeps serving meanwhile), then exit with code 75 so
//          scripts/launcher.mjs swaps the new build in and starts it.
// Local changes are respected: files the server regenerates anyway
// (runtime/channels/*.config.json, runtime/lineup.json, runtime/guide-config.json)
// are reset when the update touches them; any other local edit to a file the
// update changes (e.g. a channel config edited here but changed upstream too)
// blocks the update and is listed, so nothing is overwritten.

import type { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appLog } from "./app-log.js";
import type { ConfigStore } from "./config.js";
import type { NextRunner } from "./next-runner.js";

const RESTART_CODE = 75;
/** Changes with every start, so the page can tell the restarted server from the old one. */
const BOOT_ID = `${process.pid}-${Date.now()}`;
const REGENERATED = [/^runtime\/channels\/[^/]+\.config\.json$/, /^runtime\/lineup\.json$/, /^runtime\/guide-config\.json$/];

interface Commit { sha: string; subject: string; date: string }
export interface SelfUpdateStatus {
  available: boolean;        // a git checkout with an upstream branch
  reason: string | null;     // why not, when it isn't
  branch: string; upstream: string;
  current: Commit | null;
  behind: number; ahead: number;
  commits: Commit[];         // what an update brings, newest first
  blocked: string[];         // local edits that stop it
  checkedAt: number | null; checkError: string | null;
  underLauncher: boolean;    // started by scripts/launcher.mjs, so it can restart itself
  bootId: string;
  staged: boolean;           // a built update is waiting for a restart
  job: { phase: "running" | "restarting" | "staged" | "failed"; step: string; log: string[]; startedAt: number } | null;
}

/** Runs a command; resolves with its output, rejects with the output tail on failure. */
function run(cmd: string, args: string[], cwd: string, timeoutMs = 600_000): Promise<string> {
  return new Promise((resolve, reject) => {
    // npm is a .cmd on Windows, which needs a shell
    const p = spawn(cmd, args, { cwd, windowsHide: true, shell: process.platform === "win32" && cmd === "npm" });
    let out = "";
    const t = setTimeout(() => { p.kill(); reject(new Error(`${cmd} ${args[0] ?? ""} took too long`)); }, timeoutMs);
    p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("exit", (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${[cmd, ...args].join(" ")} failed (exit ${code}):\n${out.trim().split(/\r?\n/).slice(-15).join("\n")}`));
    });
  });
}

export class SelfUpdater {
  private st: Omit<SelfUpdateStatus, "underLauncher" | "bootId" | "staged" | "job"> = {
    available: false, reason: "not checked yet", branch: "", upstream: "", current: null,
    behind: 0, ahead: 0, commits: [], blocked: [], checkedAt: null, checkError: null,
  };
  private job: SelfUpdateStatus["job"] = null;
  /** The commit this process started on (HEAD can move ahead of it after a manual pull). */
  private running: Commit | null = null;
  private pkgVersion = "";
  private lastAutoDay = "";
  private timer: NodeJS.Timeout;

  constructor(private store: ConfigStore, private root: string, private runner?: NextRunner) {
    this.timer = setInterval(() => void this.tick(), 15 * 60_000);
    try { this.pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? ""; } catch { /* unknown */ }
    if (existsSync(join(root, ".git"))) this.commit("HEAD").then((c) => { this.running = c; }, () => {});
    setTimeout(() => void this.tick(), 60_000);
  }

  private git = (...args: string[]) => run("git", args, this.root, 120_000);

  private async commit(rev: string): Promise<Commit> {
    const [sha, date, ...subject] = (await this.git("log", "-1", "--format=%H%x09%cI%x09%s", rev)).split("\t");
    return { sha, date, subject: subject.join("\t") };
  }

  /** Tracked files changed on this machine (staged or not), as repo-relative paths. */
  private async localEdits(): Promise<string[]> {
    return (await this.git("-c", "core.quotepath=off", "diff", "--name-only", "HEAD")).split(/\r?\n/).filter(Boolean);
  }

  /** Fetches and works out what an update would bring (and whether anything blocks it). */
  async check(fetch = true): Promise<void> {
    try {
      if (!existsSync(join(this.root, ".git"))) { this.st = { ...this.st, available: false, reason: "this copy isn't a git checkout" }; return; }
      const branch = await this.git("rev-parse", "--abbrev-ref", "HEAD");
      let upstream = "";
      try { upstream = await this.git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"); } catch { /* none */ }
      if (branch === "HEAD" || !upstream) { this.st = { ...this.st, available: false, reason: branch === "HEAD" ? "not on a branch" : `branch ${branch} doesn't track a remote branch` }; return; }
      if (fetch) await this.git("fetch", "--quiet");
      const [ahead, behind] = (await this.git("rev-list", "--left-right", "--count", "HEAD...@{u}")).split(/\s+/).map(Number);
      const log = behind ? await this.git("log", "--format=%H%x09%cI%x09%s", "-n", "30", "HEAD..@{u}") : "";
      const commits = log ? log.split(/\r?\n/).map((l) => { const [sha, date, ...s] = l.split("\t"); return { sha, date, subject: s.join("\t") }; }) : [];
      // local edits to files the update changes
      const incoming = behind ? new Set((await this.git("diff", "--name-only", "HEAD", "@{u}")).split(/\r?\n/).filter(Boolean)) : new Set<string>();
      const dirty = await this.localEdits();
      const blocked = dirty.filter((f) => incoming.has(f) && !REGENERATED.some((re) => re.test(f)));
      this.st = { available: true, reason: null, branch, upstream, current: await this.commit("HEAD"), behind, ahead, commits, blocked, checkedAt: Date.now(), checkError: null };
    } catch (e) {
      this.st = { ...this.st, checkedAt: Date.now(), checkError: (e as Error).message.split("\n").slice(0, 4).join(" ") };
    }
  }

  status(): SelfUpdateStatus {
    return { ...this.st, underLauncher: process.env.TVNS_LAUNCHER === "1", bootId: BOOT_ID, staged: existsSync(join(this.root, "dist-next", ".ready")), job: this.job };
  }

  /** What the sidebar shows: cheap, never runs git. */
  version(): { version: string; commit: Commit | null; behind: number } {
    return { version: this.pkgVersion, commit: this.running, behind: this.st.available ? this.st.behind : 0 };
  }

  busy(): boolean { return this.job?.phase === "running" || this.job?.phase === "restarting"; }

  /** Pulls (when there's anything new), installs, builds the next version and restarts into it. */
  async install(): Promise<void> {
    if (this.busy()) throw new Error("an update is already running");
    await this.check();
    const s = this.st;
    if (!s.available) throw new Error(s.reason ?? s.checkError ?? "can't update this copy");
    if (s.checkError) throw new Error(s.checkError);
    if (s.ahead) throw new Error(`this copy has ${s.ahead} commit(s) that aren't on ${s.upstream}; push or remove them first`);
    if (s.blocked.length) throw new Error(`local changes to files the update also changes: ${s.blocked.join(", ")}`);
    const job: NonNullable<SelfUpdateStatus["job"]> = this.job = { phase: "running", step: "Starting…", log: [], startedAt: Date.now() };
    const step = (t: string) => { job.step = t; job.log.push(`${new Date().toLocaleTimeString()} ${t}`); appLog("update", t); };
    void (async () => {
      try {
        const from = s.current!.sha;
        if (s.behind) {
          const dirty = await this.localEdits();
          const incoming = new Set((await this.git("diff", "--name-only", "HEAD", "@{u}")).split(/\r?\n/).filter(Boolean));
          const reset = dirty.filter((f) => incoming.has(f) && REGENERATED.some((re) => re.test(f)));
          if (reset.length) { step(`Resetting ${reset.length} regenerated file(s) the update also changes`); await this.git("checkout", "--", ...reset); }
          step(`Pulling ${s.behind} new commit(s) from ${s.upstream}`);
          await this.git("merge", "--ff-only", "@{u}");
        } else step("Already up to date with git; rebuilding the current version");
        const changed = s.behind ? (await this.git("diff", "--name-only", from, "HEAD")).split(/\r?\n/) : [];
        if (changed.some((f) => f === "package.json" || f === "package-lock.json") || !existsSync(join(this.root, "node_modules"))) {
          step("Installing server packages (npm install)"); await run("npm", ["install", "--no-audit", "--no-fund"], this.root);
        }
        const web = join(this.root, "web");
        if (changed.some((f) => f === "web/package.json" || f === "web/package-lock.json") || !existsSync(join(web, "node_modules"))) {
          step("Installing web packages (npm --prefix web install)"); await run("npm", ["install", "--no-audit", "--no-fund"], web);
        }
        step("Building the server");
        rmSync(join(this.root, "dist-next"), { recursive: true, force: true });
        await run(process.execPath, [join(this.root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json", "--outDir", "dist-next"], this.root);
        step("Building the web UI");
        await run(process.execPath, [join(web, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", "."], web);
        rmSync(join(web, "dist-next"), { recursive: true, force: true });
        await run(process.execPath, [join(web, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", "dist-next", "--emptyOutDir"], web);
        const to = await this.commit("HEAD");
        writeFileSync(join(this.root, "dist-next", ".ready"), to.sha);
        await this.check(false);
        if (process.env.TVNS_LAUNCHER === "1") {
          step(`Built ${to.sha.slice(0, 7)} (${to.subject}); restarting`);
          job.phase = "restarting";
          setTimeout(() => { this.runner?.dispose(); process.exit(RESTART_CODE); }, 1500); // let the page see "restarting"
        } else {
          step(`Built ${to.sha.slice(0, 7)} (${to.subject}). Restart the scheduler with "npm run server" to switch to it.`);
          job.phase = "staged";
        }
      } catch (e) {
        job.log.push((e as Error).message);
        job.phase = "failed"; job.step = "The update failed; the scheduler keeps running the version it started with.";
        appLog("update", `failed: ${(e as Error).message}`);
      }
    })();
  }

  /** Hourly-ish: check, and in "install" mode update once a day at the chosen hour. */
  private async tick(): Promise<void> {
    const cfg = this.store.get();
    if (cfg.selfUpdate === "off" || this.busy()) return;
    if (!this.st.checkedAt || Date.now() - this.st.checkedAt > 55 * 60_000) await this.check();
    if (cfg.selfUpdate !== "install" || !this.st.available || !this.st.behind || this.st.blocked.length || this.st.ahead) return;
    const now = new Date(), day = now.toDateString();
    if (now.getHours() !== cfg.selfUpdateHour || this.lastAutoDay === day) return;
    this.lastAutoDay = day;
    appLog("update", `installing ${this.st.behind} new commit(s) automatically`);
    try { await this.install(); } catch (e) { appLog("update", `automatic update skipped: ${(e as Error).message}`); }
  }

  dispose(): void { clearInterval(this.timer); }
}

export function registerSelfUpdateRoutes(app: FastifyInstance, updater: SelfUpdater) {
  app.get("/api/self-update", async (req) => {
    const q = req.query as { refresh?: string };
    if (q.refresh === "1" || !updater.status().checkedAt) await updater.check();
    return updater.status();
  });
  app.get("/api/version", async () => updater.version());
  app.post("/api/self-update/install", async (_req, reply) => {
    try { await updater.install(); } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
    return updater.status();
  });
}
