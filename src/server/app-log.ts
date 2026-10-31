// -----------------------------------------------------------------------------
// App-wide log: everything the server and its child processes print lands in one
// file the web Logs tab reads — the server's own console (startup "[sqlite]
// loaded …", scheduler, warnings), ErsatzTV next's output, scans/builds/import
// child processes, and the guide-stream processes (which append to the same
// file themselves via runtime-log.ts).
//
// Lines are tagged by source ("[next] …", "[scan] …"); a line that already
// carries a "[tag]" keeps it. Writes are buffered and appended in batches so a
// chatty process (ffmpeg via next) doesn't cost one file write per line.
// -----------------------------------------------------------------------------
import { appendFileSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ChildProcess } from "node:child_process";

const MAX_BYTES = 8 * 1024 * 1024;   // trim the file when it grows past this…
const KEEP_LINES = 20_000;           // …back down to this many lines
const FLUSH_MS = 250;

let fileOf: () => string = () => "";
let buffer: string[] = [];
let timer: NodeJS.Timeout | null = null;
let flushes = 0;

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
// noise that isn't useful in the UI
const IGNORE = /ExperimentalWarning|--trace-warnings|^\(Use `node/;

function flush(): void {
  timer = null;
  if (!buffer.length) return;
  const file = fileOf();
  const chunk = buffer.join("");
  buffer = [];
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, chunk);
    // check the size now and then, not on every flush
    if (++flushes % 20 === 0) {
      const size = statSync(file).size;
      if (size > MAX_BYTES) writeFileSync(file, readFileSync(file, "utf8").split("\n").slice(-KEEP_LINES).join("\n"));
    }
  } catch { /* logging is best-effort */ }
}

/** Queue one or more lines (a chunk may hold several) under `source`. */
export function appLog(source: string, text: string): void {
  const stamp = new Date().toISOString();
  for (const raw of String(text).replace(ANSI, "").split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line || IGNORE.test(line)) continue;
    buffer.push(`${stamp} ${/^\[[^\]]{1,32}\]/.test(line) ? line : `[${source}] ${line}`}\n`);
  }
  if (!timer) timer = setTimeout(flush, FLUSH_MS);
}

/** Point the log at its file (resolved lazily, so a settings change follows) and
 *  mirror the server's own stdout/stderr into it. Call before anything logs. */
export function initAppLog(file: () => string): void {
  fileOf = file;
  for (const [stream, source] of [[process.stdout, "server"], [process.stderr, "server"]] as const) {
    const orig = stream.write.bind(stream) as (...a: any[]) => boolean;
    (stream as any).write = (chunk: any, ...rest: any[]) => {
      try { appLog(source, typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")); } catch { /* never break output */ }
      return orig(chunk, ...rest);
    };
  }
  process.on("exit", flush);
}

/** Also send a child process's output to the app log. Adds listeners only — the
 *  caller's own stdout/stderr handling (progress parsing) is unaffected. */
export function pipeChildToLog(child: ChildProcess, source: string): void {
  child.stdout?.on("data", (d) => appLog(source, String(d)));
  child.stderr?.on("data", (d) => appLog(source, String(d)));
  child.on("error", (e) => appLog(source, `process error: ${String(e)}`));
}
