import { appLog } from "./app-log.js";
// In-memory build-job registry (progress polling from the UI).
export interface Job {
  id: string; channels: string[]; status: "queued" | "running" | "done" | "error";
  log: string[]; results: { channel: string; itemCount?: number; file?: string; error?: string }[];
  startedAt: number; finishedAt?: number;
}
const jobs = new Map<string, Job>();
let seq = 0;

export function createJob(channels: string[]): Job {
  // the job's progress log also goes to the app log (web Logs tab) as [build]
  const log: string[] = [];
  const push = log.push.bind(log);
  log.push = (...lines: string[]) => { for (const l of lines) appLog("build", l.trim()); return push(...lines); };
  const job: Job = { id: `j${++seq}`, channels, status: "queued", log, results: [], startedAt: Date.now() };
  jobs.set(job.id, job);
  return job;
}
export function getJob(id: string): Job | undefined { return jobs.get(id); }
