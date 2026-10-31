// YAML playout module — the original ErsatzTV-legacy scripted format.
import { loadPlayout } from "../yaml.js";
import type { SchedulingModule } from "./module.js";

const DEFAULT = `# YAML playout (ErsatzTV-legacy format)
content:
  - key: main
    search: type:episode
    order: shuffle
playout:
  - epg_group: true
  - count: 1
    content: main
  - epg_group: false
  - repeat: true
`;

export const yamlModule: SchedulingModule = {
  id: "yaml",
  label: "YAML playout",
  description: "ErsatzTV-legacy scripted playout — full control (sequences, pods, dayparts, mid-roll).",
  editor: "yaml",
  fileExts: [".yml", ".yaml"],
  saveExt: ".yml",
  defaultConfig: () => DEFAULT,
  compile: (raw) => loadPlayout(raw),
  summarize: (raw) => {
    try {
      const d = loadPlayout(raw);
      return {
        valid: true,
        contentDefs: d.content.length,
        sequences: Object.keys(d.sequences).length,
        pods: Object.keys(d.pods).length,
        dayparts: d.dayparts.length,
        blocks: d.playout.filter((i) => i.op === "sequence").length,
        repeats: d.playout.some((i) => i.op === "repeat"),
      };
    } catch (e) { return { valid: false, error: (e as Error).message }; }
  },
};
