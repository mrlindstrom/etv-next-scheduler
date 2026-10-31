// Keep a Pod-scheduler channel's embedded pod snapshot in sync with the live
// pod library: every Show placed in a lineup (plus its mid-roll break and tail
// filler dependencies) is refreshed from the current pod defs. This makes
// editing a pod on the Pods tab flow into every channel that uses it, while the
// channel config stays self-contained for the compiler.
import { readFile, writeFile } from "node:fs/promises";

interface LibPod { id: string; name: string; type: string; config: any; }

/** Rebuild a pod-schedule config's `pods` from the library (transitive deps),
 *  preferring live defs and falling back to whatever was already embedded. */
export function refreshPodsConfig(raw: string, libPods: LibPod[]): string {
  let cfg: any; try { cfg = JSON.parse(raw || "{}"); } catch { return raw; }
  const lib = new Map(libPods.map((p) => [p.id, p]));
  const embedded = new Map((cfg.pods ?? []).map((p: any) => [p.id, p]));
  const get = (id: string): any => lib.get(id) ?? embedded.get(id);
  const order: string[] = [];
  const seen = new Set<string>();
  const collect = (id: string) => {
    if (seen.has(id)) return;
    const p = get(id); if (!p) return;
    seen.add(id); order.push(id);
    const c = p.config ?? {};
    if (c.midRoll?.breakPodId) collect(c.midRoll.breakPodId);
    if (c.tailFillerPodId) collect(c.tailFillerPodId);
  };
  for (const g of cfg.groups ?? []) for (const s of (g.slots ?? [])) collect(s);
  cfg.pods = order.map(get).filter(Boolean).map((p) => ({ id: p.id, name: p.name, type: p.type, config: p.config }));
  return JSON.stringify(cfg, null, 2);
}

/** Refresh a `.pods.json` channel file in place from the live pod library. */
export async function refreshPodsChannelFile(path: string, libPods: LibPod[]): Promise<void> {
  if (!/\.pods\.json$/i.test(path)) return;
  try {
    const raw = await readFile(path, "utf8");
    const next = refreshPodsConfig(raw, libPods);
    if (next !== raw) await writeFile(path, next, "utf8");
  } catch { /* leave the file as-is on any error */ }
}
