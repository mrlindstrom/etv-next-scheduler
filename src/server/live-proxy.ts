// -----------------------------------------------------------------------------
// Live channel proxy (Troubleshooting → Watch live)
// -----------------------------------------------------------------------------
// Passes ErsatzTV next's HLS endpoints through this server, so the web UI can play
// a channel from its own address (including behind a reverse proxy or HTTPS)
// without the browser having to reach next's port:
//   /channel/<number>.m3u8   multivariant playlist (starts the channel if idle)
//   /session/<number>/...    media playlist + segments
// next writes absolute URLs into its playlists from the request's
// X-Forwarded-Host/-Proto, so we send this server's host and the URLs it hands
// the player point back here.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Readable } from "node:stream";
import type { ConfigStore } from "./config.js";

export function registerLiveProxy(app: FastifyInstance, store: ConfigStore) {
  const pass = async (req: FastifyRequest, reply: FastifyReply) => {
    const nc = store.getNextConfig();
    const host = !nc.bindAddress || nc.bindAddress === "0.0.0.0" || nc.bindAddress === "::" ? "127.0.0.1" : nc.bindAddress;
    const proto = String(req.headers["x-forwarded-proto"] ?? req.protocol).split(",")[0].trim();
    const fwdHost = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0].trim();
    let res: Response;
    try {
      res = await fetch(`http://${host}:${nc.port}${req.url}`, {
        headers: { "x-forwarded-host": fwdHost, "x-forwarded-proto": proto },
        // next waits up to 30 s for a cold channel's first segment
        signal: AbortSignal.timeout(45_000),
      });
    } catch (e) {
      return reply.code(502).send({ error: `ErsatzTV next isn't answering on port ${nc.port} (${(e as Error).name === "TimeoutError" ? "timed out" : "not running?"}). Start it on the Streaming page.` });
    }
    reply.code(res.status);
    for (const h of ["content-type", "content-length", "cache-control"]) { const v = res.headers.get(h); if (v) reply.header(h, v); }
    if (!res.headers.get("cache-control") && req.url.includes(".m3u8")) reply.header("cache-control", "no-store");
    return reply.send(res.body ? Readable.fromWeb(res.body as any) : "");
  };
  app.get("/channel/:file", pass);
  app.get("/session/*", pass);
}
