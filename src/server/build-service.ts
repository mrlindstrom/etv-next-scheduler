// -----------------------------------------------------------------------------
// Owns the single long-lived build worker and routes its messages back to the
// caller by job id. Keeping one worker alive (rather than spawning one per
// build) is what keeps the search index warm across builds — see build-worker.ts.
// -----------------------------------------------------------------------------
import { Worker } from "node:worker_threads";
import type { BuildWorkerRequest, BuildWorkerChannel } from "./build-worker.js";
import type { Tz } from "../time.js";

export type { BuildWorkerChannel } from "./build-worker.js";

export interface BuildMessage { type: "log" | "result" | "error" | "done"; [k: string]: unknown; }
export interface BuildRequestInput {
  libDbPath: string;
  disabledLibs: number[];
  excludeSpecials: boolean;
  tz: Tz;
  xmltvMode: "write" | "merge";
  artBase?: string;      // public address for programme posters in the guide
  now: number;
  channels: BuildWorkerChannel[];
}

class BuildService {
  private worker?: Worker;
  private nextJobId = 1;
  private handlers = new Map<number, (m: BuildMessage) => void>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL("./build-worker.js", import.meta.url));
    w.on("message", (m: BuildMessage & { jobId: number }) => {
      const h = this.handlers.get(m.jobId);
      if (h) h(m);
    });
    const fail = (err: Error) => {
      // surface a terminal error to every in-flight job, then drop the worker so
      // the next request spins up a fresh one (and reloads the index).
      for (const [id, h] of this.handlers) { h({ type: "done", fatal: err.message, jobId: id } as any); }
      this.handlers.clear();
      this.worker = undefined;
    };
    w.on("error", fail);
    w.on("exit", (code) => { if (code !== 0) fail(new Error(`build worker exited (code ${code})`)); else { this.handlers.clear(); this.worker = undefined; } });
    this.worker = w;
    return w;
  }

  /** Run a build job. `onMessage` receives log/result/error messages as they
   *  arrive; the promise resolves when the worker reports `done`. */
  run(req: BuildRequestInput, onMessage: (m: BuildMessage) => void): Promise<void> {
    const worker = this.ensureWorker();
    const jobId = this.nextJobId++;
    return new Promise<void>((resolve) => {
      this.handlers.set(jobId, (m) => {
        if (m.type === "done") { this.handlers.delete(jobId); resolve(); }
        else onMessage(m);
      });
      const msg: BuildWorkerRequest = { jobId, ...req };
      worker.postMessage(msg);
    });
  }
}

export const buildService = new BuildService();
