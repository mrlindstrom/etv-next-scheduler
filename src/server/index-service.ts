// -----------------------------------------------------------------------------
// The server's handle on the search index: runs the index worker, checks/repairs
// the index at startup, applies queued changes after scans and library edits
// (debounced), and reports status for the Library tab.
// -----------------------------------------------------------------------------
import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import type { IndexRequest, IndexStatusMsg } from "./index-worker.js";

export interface IndexStatus {
  phase: "off" | "idle" | "checking" | "rebuilding" | "updating" | "error";
  detail?: string; docs?: number; gen?: number; builtAt?: string; updatedAt?: string;
  last?: IndexStatusMsg["last"]; error?: string; since?: number;
}

class IndexService {
  private worker: Worker | null = null;
  private libraryDbPath = "";
  private timer: NodeJS.Timeout | null = null;
  status: IndexStatus = { phase: "off" };

  private send(op: IndexRequest["op"], reason?: string): void {
    if (!this.libraryDbPath || !existsSync(this.libraryDbPath)) { this.status = { phase: "off", detail: "no library imported yet" }; return; }
    if (!this.worker) {
      this.worker = new Worker(new URL("./index-worker.js", import.meta.url));
      this.worker.on("message", (m: IndexStatusMsg) => {
        if (m?.type !== "status") return;
        const { type: _t, ...msg } = m;
        const busy = m.phase !== "idle" && m.phase !== "error";
        this.status = { ...this.status, ...msg, since: busy ? (this.status.phase === m.phase ? this.status.since : Date.now()) : undefined, last: m.last ?? this.status.last, error: m.phase === "error" ? m.error : undefined };
      });
      this.worker.on("error", (e) => { this.status = { ...this.status, phase: "error", error: String(e) }; this.worker = null; });
      this.worker.on("exit", () => { this.worker = null; });
    }
    this.worker.postMessage({ op, libraryDbPath: this.libraryDbPath, reason } satisfies IndexRequest);
  }

  /** Point at a library and check the index (startup, or after an import). */
  start(libraryDbPath: string, reason?: string): void {
    this.libraryDbPath = libraryDbPath;
    this.send("ensure", reason);
  }

  /** Something changed the library (scan finished, items deleted, collection edited):
   *  apply what's queued, shortly — several changes in a row become one update. */
  changed(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.send("drain"); }, 400);
  }

  rebuild(): void {
    const reason = "rebuild requested from the Library tab";
    this.send("rebuild", reason);
    if (this.status.phase !== "off") this.status = { ...this.status, phase: "rebuilding", detail: reason, since: Date.now(), error: undefined };
  }

  dispose(): void { void this.worker?.terminate(); this.worker = null; }
}

export const indexService = new IndexService();
