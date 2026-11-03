import Fastify from "fastify";
import cors from "@fastify/cors";
import fstatic from "@fastify/static";
import { join, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { ConfigStore } from "./config.js";
import { registerRoutes } from "./routes.js";
import { Scheduler } from "./scheduler.js";
import { NextRunner } from "./next-runner.js";
import { Updater, registerUpdateRoutes } from "./updates.js";
import { registerLiveProxy } from "./live-proxy.js";
import { SelfUpdater, registerSelfUpdateRoutes } from "./self-update.js";
import { initAppLog, appLog } from "./app-log.js";
import { indexService } from "./index-service.js";
import { HdhrTuner, registerHdhrRoutes } from "./hdhr.js";

const PORT = Number(process.env.PORT ?? 8730);
const ROOT = process.cwd();

// App config DB. Override with APP_DB when the project folder is on a mount that
// can't host a writable SQLite file (e.g. some network/VM shares).
const store = new ConfigStore(process.env.APP_DB ?? join(ROOT, "data", "app.sqlite"));
// Everything the server prints (and its child processes, wired up where they're
// spawned) also goes to the log the web Logs tab shows — {runtime}/guide.log,
// which the guide-stream processes already write to.
initAppLog(() => {
  const dir = store.getNextConfig().runtimeDir || "runtime";
  return join(isAbsolute(dir) || /^[A-Za-z]:/.test(dir) ? dir : join(ROOT, dir), "guide.log");
});
appLog("server", `tv-next-scheduler starting (pid ${process.pid}, port ${PORT})`);
const app = Fastify({ logger: { level: "warn" } });
await app.register(cors, { origin: true });
const scheduler = new Scheduler(store, ROOT);
const nextRunner = new NextRunner(store, ROOT);
await registerRoutes(app, store, scheduler, nextRunner);
registerUpdateRoutes(app, new Updater(store, ROOT, nextRunner));
registerLiveProxy(app, store);
registerSelfUpdateRoutes(app, new SelfUpdater(store, ROOT, nextRunner));
// HDHomeRun tuner for Plex (its own port; off until turned on under Streaming)
const hdhr = new HdhrTuner(store, ROOT);
registerHdhrRoutes(app, hdhr, store, ROOT);
void hdhr.reconfigure();
scheduler.reconfigure(); // start the auto-build loop if enabled in config
// Search index: check it (rebuild if missing/corrupt/outdated) and apply anything
// queued while the server was down — in a worker thread, so startup isn't blocked.
{
  const lib = store.get().libraryDbPath;
  const libPath = isAbsolute(lib) || /^[A-Za-z]:/.test(lib) ? lib : join(ROOT, lib);
  if (existsSync(libPath)) indexService.start(libPath, "startup check");
}

// Stop the managed ErsatzTV next process when the web server exits.
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { nextRunner.dispose(); process.exit(0); });
process.on("exit", () => { nextRunner.dispose(); indexService.dispose(); hdhr.stopAll(); });

// Serve the built SPA (web/dist) if present; SPA fallback to index.html.
const webDist = join(ROOT, "web", "dist");
if (existsSync(webDist)) {
  await app.register(fstatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api")) { reply.code(404).send({ error: "not found" }); return; }
    reply.sendFile("index.html");
  });
}

await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`tv-next-scheduler server on http://localhost:${PORT}`);
