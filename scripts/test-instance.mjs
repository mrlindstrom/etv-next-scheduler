// An isolated copy of the scheduler for testing server changes without touching
// the real one: `npm run test-instance` (add --refresh to recopy the data).
//
// It runs this repo's dist/ from .test-instance/ (the server's root is its working
// folder), which holds copies of data/, channels/ and runtime/, and links to bin/
// and web/. Its settings have auto-build, auto-scan and "keep ErsatzTV next
// running" switched off, so it never writes to the real playouts or library, and
// it listens on port 8731 (or TEST_PORT).
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(repo, ".test-instance");
const port = process.env.TEST_PORT ?? "8731";
const refresh = process.argv.includes("--refresh");

if (!existsSync(join(repo, "dist", "server", "main.js"))) { console.error("Build first: npm run build"); process.exit(1); }
if (refresh) rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, "data"), { recursive: true });

// copy a file or folder once (or again when the original is newer)
const copy = (rel, opts = {}) => {
  const from = join(repo, rel), to = join(dir, rel);
  if (!existsSync(from)) return;
  if (existsSync(to) && statSync(to).mtimeMs >= statSync(from).mtimeMs && !opts.always) return;
  console.log(`copying ${rel}…`);
  cpSync(from, to, { recursive: true, force: true });
};
const link = (rel) => {
  const to = join(dir, rel);
  if (!existsSync(to) && existsSync(join(repo, rel))) symlinkSync(join(repo, rel), to, process.platform === "win32" ? "junction" : "dir");
};

// databases: a consistent snapshot (the running server may have changes in its WAL)
const copyDb = (rel) => {
  const from = join(repo, rel), to = join(dir, rel);
  if (!existsSync(from) || (existsSync(to) && statSync(to).mtimeMs >= statSync(from).mtimeMs)) return;
  console.log(`copying ${rel}…`);
  rmSync(to, { force: true });
  const db = new DatabaseSync(from, { readOnly: true });
  try { db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); } finally { db.close(); }
};
copyDb("data/app.sqlite");
copyDb("data/library.sqlite");
copyDb("data/search-index.sqlite");
if (!existsSync(join(dir, "channels"))) copy("channels");
if (!existsSync(join(dir, "runtime"))) copy("runtime");
copy("package.json", { always: true });
link("bin"); link("web");

// switch off everything that writes outside the copy, or starts background work
const { ConfigStore } = await import(pathToFileURL(join(repo, "dist", "server", "config.js")).href);
const store = new ConfigStore(join(dir, "data", "app.sqlite"));
store.set({ autoBuild: false, autoScanHours: 0, keepNextRunning: false, libraryDbPath: "data/library.sqlite", channelsDir: "channels" });
store.setNextConfig({ runtimeDir: "runtime", outputFolder: "./output" });

console.log(`test instance: http://localhost:${port}  (root ${dir})`);
const child = spawn(process.execPath, [join(repo, "dist", "server", "main.js")], { cwd: dir, env: { ...process.env, PORT: port, APP_DB: join(dir, "data", "app.sqlite") }, stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
