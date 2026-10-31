// -----------------------------------------------------------------------------
// Tiny append-only runtime log, shared by the server and the spawned guide-stream
// processes (whose stderr is otherwise swallowed by next). Everything lands in
// {runtime}/guide.log; the web "Logs" tab reads the tail via /api/logs.
// -----------------------------------------------------------------------------
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";

const MAX_BYTES = 512 * 1024;   // trim the file when it grows past this
const KEEP_LINES = 2000;        // ...back down to this many lines

/** Append one timestamped line. Best-effort: logging never throws. */
export async function logLine(logFile: string, msg: string): Promise<void> {
  if (!logFile) return;
  try {
    await appendFile(logFile, `${new Date().toISOString()} ${msg}\n`);
    const s = await stat(logFile).catch(() => null);
    if (s && s.size > MAX_BYTES) {
      const lines = (await readFile(logFile, "utf8")).split("\n");
      await writeFile(logFile, lines.slice(-KEEP_LINES).join("\n"));
    }
  } catch { /* logging is best-effort */ }
}

/** Synchronous-ish fire-and-forget logger bound to a file (for hot paths). */
export function makeLogger(logFile: string): (msg: string) => void {
  return (msg: string) => { void logLine(logFile, msg); };
}

/** Return the last `n` non-empty log lines (oldest first). */
export async function readLog(logFile: string, n = 300): Promise<string[]> {
  try {
    const lines = (await readFile(logFile, "utf8")).split("\n").filter((l) => l.length > 0);
    return lines.slice(-Math.max(1, Math.min(5000, n)));
  } catch { return []; }
}
