// Scheduling module registry — add a module here to make it a selectable mode.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SchedulingModule } from "./module.js";
import { yamlModule } from "./yaml-module.js";
import { blocksModule } from "./blocks-module.js";
import { podsModule } from "./pods-module.js";
import { gridModule } from "./grid-module.js";
import { timeshiftModule } from "./timeshift-module.js";
import { moviesModule } from "./movies-module.js";
import { remoteModule } from "./remote-module.js";

export const MODULES: SchedulingModule[] = [yamlModule, blocksModule, podsModule, gridModule, moviesModule, timeshiftModule, remoteModule];

export function moduleById(id: string): SchedulingModule | undefined {
  return MODULES.find((m) => m.id === id);
}

/** Pick the module that owns a config file (longest matching extension wins so
 *  ".schedule.json" beats a bare ".json"). Falls back to YAML. */
export function moduleForFile(path: string): SchedulingModule {
  const p = path.toLowerCase();
  let best: SchedulingModule | undefined; let bestLen = -1;
  for (const m of MODULES) for (const ext of m.fileExts) {
    if (p.endsWith(ext) && ext.length > bestLen) { best = m; bestLen = ext.length; }
  }
  return best ?? yamlModule;
}

export interface ChannelFile { name: string; file: string; path: string; module: SchedulingModule; }

/** Strip a known module extension from a filename, returning the channel name. */
function baseName(file: string): { name: string; module: SchedulingModule } | null {
  const lower = file.toLowerCase();
  let best: { name: string; module: SchedulingModule; len: number } | null = null;
  for (const m of MODULES) for (const ext of m.fileExts) {
    if (lower.endsWith(ext) && ext.length > (best?.len ?? -1)) best = { name: file.slice(0, file.length - ext.length), module: m, len: ext.length };
  }
  return best ? { name: best.name, module: best.module } : null;
}

/** List all channel config files in a directory (across every module). */
export async function listChannelFiles(dir: string): Promise<ChannelFile[]> {
  let files: string[] = [];
  try { files = await readdir(dir); } catch { return []; }
  const out: ChannelFile[] = [];
  for (const f of files) {
    const b = baseName(f);
    if (b) out.push({ name: b.name, file: f, path: join(dir, f), module: b.module });
  }
  // stable, one entry per name (prefer the first module found)
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}

/** Resolve a channel name to its existing config file, if any. */
export async function channelFile(dir: string, name: string): Promise<ChannelFile | null> {
  return (await listChannelFiles(dir)).find((c) => c.name === name) ?? null;
}
