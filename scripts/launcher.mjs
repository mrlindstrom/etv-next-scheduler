// Starts the scheduler server and restarts it after an in-app update
// (`npm run server` runs this).
//
// An update (Settings → Scheduler updates) pulls from git and builds the new
// version into dist-next/ and web/dist-next/ while the old one keeps running,
// then exits with code 75. This launcher then swaps the new build in and starts
// it again, so the downtime is just a restart. Any other exit ends the launcher
// with the same code, as running the server directly would.
import { spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RESTART = 75;

/** Replace `dir` with `next` (rename when possible; copy over when something holds the folder open). */
function swap(dir, next) {
  if (!existsSync(next)) return;
  const old = `${dir}-old`;
  rmSync(old, { recursive: true, force: true });
  try {
    if (existsSync(dir)) renameSync(dir, old);
    renameSync(next, dir);
  } catch {
    if (!existsSync(dir) && existsSync(old)) renameSync(old, dir); // put the old one back, then copy over it
    cpSync(next, dir, { recursive: true, force: true });
    rmSync(next, { recursive: true, force: true });
  }
  rmSync(old, { recursive: true, force: true });
}

/** Swap in a finished update build (dist-next/.ready is written last). */
function applyStagedBuild() {
  const ready = join(root, "dist-next", ".ready");
  if (!existsSync(ready)) return;
  const sha = readFileSync(ready, "utf8").trim();
  swap(join(root, "web", "dist"), join(root, "web", "dist-next"));
  rmSync(ready, { force: true });
  swap(join(root, "dist"), join(root, "dist-next"));
  console.log(`[launcher] switched to the new build${sha ? ` (${sha.slice(0, 7)})` : ""}`);
}

let child = null;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { if (child) child.kill(sig); else process.exit(0); });

for (;;) {
  try { applyStagedBuild(); } catch (e) { console.error(`[launcher] couldn't switch to the new build: ${e.message}; starting the current one`); }
  child = spawn(process.execPath, [join(root, "dist", "server", "main.js"), ...process.argv.slice(2)], {
    cwd: process.cwd(), stdio: "inherit", env: { ...process.env, TVNS_LAUNCHER: "1" },
  });
  const code = await new Promise((resolve) => child.on("exit", (c, signal) => resolve(c ?? (signal ? 1 : 0))));
  child = null;
  if (code !== RESTART) process.exit(code);
  console.log("[launcher] restarting after an update…");
}
