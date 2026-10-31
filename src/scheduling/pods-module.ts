// Pod scheduler module — a visual, drag-and-drop channel built from Show pods.
// The config embeds the pod definitions plus a set of "day groups" (weekday /
// Saturday / Sunday / holiday...), each an ordered lineup of Show pods that
// fills the day. It compiles to the dayparting engine: one lineup sequence per
// group, selected by a daypart rule.
import type { PlayoutDoc } from "../yaml.js";
import { loadPlayout } from "../yaml.js";
import type { SchedulingModule, ModuleSummary } from "./module.js";
import { Compiler, emitYaml, podShowTitle } from "../pods/compile.js";
import { podKey, type Pod } from "../pods/model.js";

export interface DayGroup {
  id: string;
  label: string;
  days: string[];        // weekday tokens: mon,tue,...,sat,sun (or weekday/weekend)
  holiday?: string;      // optional holiday name
  dateFrom?: string;     // optional annual/dated range
  dateTo?: string;
  months?: (number | string)[];
  slots: string[];       // ordered Show-pod ids
}
export interface PodScheduleConfig { pods: Pod[]; groups: DayGroup[]; }

function parse(raw: string): PodScheduleConfig {
  try { const c = JSON.parse(raw || "{}"); return { pods: c.pods ?? [], groups: c.groups ?? [] }; }
  catch { return { pods: [], groups: [] }; }
}

/** Build the loose YAML-shaped doc (content/sequence/pods/dayparts) from a config.
 *  Each slot is compiled with the *next* show in its lineup as context so an
 *  "up next" (next_bumper) resolves to the actual following show. Lineups loop,
 *  so the last slot's "next" wraps to the first. */
function buildDoc(cfg: PodScheduleConfig) {
  const pods = cfg.pods ?? [];
  const byId = new Map(pods.map((p) => [p.id, p]));
  const c = new Compiler(pods);
  const dayparts: Record<string, any>[] = [];
  for (const g of cfg.groups ?? []) {
    const slots = (g.slots ?? []).filter((id) => byId.has(id));
    const items: Record<string, any>[] = [];
    for (let i = 0; i < slots.length; i++) {
      const pod = byId.get(slots[i])!;
      const nextPod = byId.get(slots[(i + 1) % slots.length]);
      const nextShowTitle = nextPod ? podShowTitle(nextPod) : undefined;
      // No single static next title (collection/library slot) → let the up-next
      // bumper peek that slot's program at build time.
      const nextShowKey = !nextShowTitle && nextPod ? c.showContentKey(nextPod) : undefined;
      const ref = c.compilePod(pod, { nextShowTitle, nextShowKey });
      if (ref && (ref.kind === "sequence" || ref.kind === "pod")) items.push({ [ref.kind]: ref.key });
    }
    const lineKey = podKey(`${g.id}_LINEUP`) || `LINEUP_${dayparts.length}`;
    c.sequence.push({ key: lineKey, items });
    const dp: Record<string, any> = { label: g.label || g.id, days: g.days ?? [], sequence: lineKey };
    if (g.holiday) dp.holiday = g.holiday;
    if (g.dateFrom) dp.date_from = g.dateFrom;
    if (g.dateTo) dp.date_to = g.dateTo;
    if (g.months && g.months.length) dp.months = g.months;
    dayparts.push(dp);
  }
  return { content: c.content, sequence: c.sequence, pods: c.pods, dayparts };
}

export const podsModule: SchedulingModule = {
  id: "pods",
  label: "Pod scheduler",
  description: "Drag-and-drop: build reusable Show pods, then arrange them into per-day lineups (weekday / Saturday / Sunday / holiday). Compiles to dayparting.",
  editor: "pods",
  fileExts: [".pods.json"],
  saveExt: ".pods.json",
  defaultConfig: () => JSON.stringify({
    pods: [],
    groups: [
      { id: "weekday", label: "Weekdays", days: ["mon", "tue", "wed", "thu", "fri"], slots: [] },
      { id: "saturday", label: "Saturday", days: ["sat"], slots: [] },
      { id: "sunday", label: "Sunday", days: ["sun"], slots: [] },
    ],
  }, null, 2),

  compile(raw: string): PlayoutDoc {
    const yaml = emitYaml(buildDoc(parse(raw)));
    return loadPlayout(yaml);
  },

  summarize(raw: string): ModuleSummary {
    const cfg = parse(raw);
    const groups = cfg.groups ?? [];
    const slots = groups.reduce((n, g) => n + (g.slots?.length ?? 0), 0);
    if (slots === 0) return { valid: false, error: "Add at least one show to a day.", groups: groups.length, dayparts: groups.length, sequences: 0, pods: 0 };
    // dangling break/filler references (snapshot missing a pod's dependency)
    const ids = new Set((cfg.pods ?? []).map((p) => p.id));
    const missing = new Set<string>();
    for (const p of cfg.pods ?? []) {
      const c: any = p.config ?? {};
      if (c.midRoll?.breakPodId && !ids.has(c.midRoll.breakPodId)) missing.add(c.midRoll.breakPodId);
      if (c.tailFillerPodId && !ids.has(c.tailFillerPodId)) missing.add(c.tailFillerPodId);
    }
    if (missing.size) return { valid: false, error: `Missing referenced pod(s): ${[...missing].join(", ")} — re-open and re-save the schedule.`, groups: groups.length };
    try {
      const doc = buildDoc(cfg);
      return { valid: true, groups: groups.length, dayparts: doc.dayparts.length, sequences: doc.sequence.length, pods: doc.pods.length };
    } catch (e) { return { valid: false, error: (e as Error).message }; }
  },
};
