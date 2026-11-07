// Channels refer to collections by name ("collection::Rugrats", "smart::Commercials",
// or `collection: Rugrats` in a legacy-style YAML playout), so renaming a collection
// would quietly break them and deleting one leaves them pointing at nothing. These
// find the channels that use a collection, and carry a rename over to them.
import { readFile, writeFile } from "node:fs/promises";
import { listChannelFiles } from "../scheduling/registry.js";
import type { CollectionType } from "./library-collections.js";

// the YAML playout's key for each kind
const YAML_KEY: Record<CollectionType, string> = { collection: "collection", smart: "smart_collection", multi: "multi_collection", playlist: "playlist" };
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A YAML line `  collection: Name` (optionally quoted, optionally a list item) for this collection. */
function yamlLine(type: CollectionType, name: string): RegExp {
  return new RegExp(`^(\\s*(?:-\\s+)?${YAML_KEY[type]}:\\s*)(["']?)${escRe(name)}\\2(\\s*(?:#.*)?)$`, "gm");
}
const isYaml = (file: string) => /\.ya?ml$/i.test(file);

/** Channel names whose config refers to this collection. */
export async function channelsUsing(channelsDir: string, type: CollectionType, name: string): Promise<string[]> {
  const json = JSON.stringify(`${type}::${name}`);
  const out: string[] = [];
  for (const c of await listChannelFiles(channelsDir)) {
    let text: string;
    try { text = await readFile(c.path, "utf8"); } catch { continue; }
    if (isYaml(c.file) ? yamlLine(type, name).test(text) : text.includes(json)) out.push(c.name);
  }
  return out;
}

/** Point every channel that used `from` at `to`; returns the channels changed. */
export async function renameInChannels(channelsDir: string, type: CollectionType, from: string, to: string): Promise<string[]> {
  if (from === to) return [];
  const oldJson = JSON.stringify(`${type}::${from}`), newJson = JSON.stringify(`${type}::${to}`);
  const changed: string[] = [];
  for (const c of await listChannelFiles(channelsDir)) {
    let text: string;
    try { text = await readFile(c.path, "utf8"); } catch { continue; }
    // the exact quoted value only, so formatting and line endings stay as they were
    const next = isYaml(c.file)
      ? text.replace(yamlLine(type, from), (_m, pre: string, _q: string, post: string) => `${pre}${/[:#'"]|^\s|\s$/.test(to) ? JSON.stringify(to) : to}${post}`)
      : text.split(oldJson).join(newJson);
    if (next !== text) { await writeFile(c.path, next); changed.push(c.name); }
  }
  return changed;
}
