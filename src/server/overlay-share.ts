// -----------------------------------------------------------------------------
// Sharing overlays: an overlay pack is a zip (*.overlays.zip) holding overlays and
// every file they draw with, so it can be passed around and brought into another
// scheduler as is. Export gathers the files; import puts each one where it belongs:
//   overlays.json         the overlays (layer sources point at the files below)
//   assets/<md5>.<ext>    uploaded images / videos and shipped example art
//                         -> <runtime>/overlays/assets (content-addressed)
//   pictures/<name>       pictures a layer names outright (match:Station logo)
//                         -> the pictures folder, under the same name
//   fonts/<file>          added fonts the text layers use -> <runtime>/overlays/fonts
// Import also takes the first packs' single .overlays.json (the same, with the
// files base64 in `files`).
// Nothing from the exporter's machine but those files goes in: a "when a file
// airs" overlay leaves its library file out (the importer picks their own), and
// file paths become asset names.
// -----------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { CHANNEL_LOGO, MATCH_PREFIX, assetPath, findPicture, fontFamilyNames, type Overlay, type OverlayLayer } from "../overlays.js";
import { saveOverlayAsset, savePicture, saveOverlayFont, listOverlayFonts, pictureFile, newOverlayId } from "./overlay-library.js";
import { writeZip, readZip, isZip } from "../zip.js";

export const PACK_FORMAT = "tv-next-scheduler/overlays";
export const PACK_VERSION = 1;
export const PACK_CONTENT_TYPE = "application/zip";
/** a pack can carry videos (300 MB each) */
export const MAX_PACK_BYTES = 1024 * 1024 * 1024;
const MANIFEST = "overlays.json";
const README = `Overlays for tv-next-scheduler (ErsatzTV next).

To use them: open the scheduler's Overlays page, click "Import overlays..." and
pick this zip as it is (don't unzip it). Its images, videos, pictures and fonts
go where they belong, and the overlays are added to your library.

  overlays.json   the overlays
  assets/         their images and videos
  pictures/       pictures they pick by name (go in your pictures folder)
  fonts/          fonts their text uses
`;

export interface OverlayPack {
  format: string;
  version: number;
  exportedAt: string;
  overlays: Omit<Overlay, "id">[];
  /** the first packs (one .overlays.json): "assets/<file>" | "pictures/<name>" | "fonts/<file>" -> base64 */
  files?: Record<string, string>;
}
export interface ShareDirs { assetsDir: string; picturesDir: string; fontsDir: string }

const SOURCE_KEYS = ["src", "fallback"] as const;
const mediaLayer = (l: OverlayLayer): l is Extract<OverlayLayer, { type: "image" | "video" }> => l.type === "image" || l.type === "video";
const hasTemplate = (s: string) => s.includes("{{");
const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex").toUpperCase();
const sameFile = async (p: string, data: Buffer) => { try { return md5(await readFile(p)) === md5(data); } catch { return false; } };
const quote = (s: string) => `“${s}”`;

/** A file name for the pack: the overlay's own name for one, else "N overlays". */
export function packFileName(names: string[]): string {
  const stem = names.length === 1 ? names[0].replace(/[<>:"/\\|?*\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim() || "overlay" : `${names.length} overlays`;
  return `${stem}.overlays.zip`;
}

/** Gather overlays and the files they use into a pack (a zip). Notes say what couldn't go in. */
export async function exportOverlays(list: Overlay[], dirs: ShareDirs): Promise<{ zip: Buffer; count: number; notes: string[]; fileName: string }> {
  const files = new Map<string, Buffer>();
  // a file gone since it was looked up (or unreadable) counts as missing, not a failed export
  const read = (path: string) => readFile(path).catch(() => null);
  const add = async (key: string, path: string) => { if (files.has(key)) return true; const d = await read(path); if (d) files.set(key, d); return !!d; };
  const notes: string[] = [];
  const added = listOverlayFonts(dirs.fontsDir);
  const overlays: OverlayPack["overlays"] = [];
  for (const orig of list) {
    if (orig.legacy) { notes.push(`${quote(orig.name)} is an ErsatzTV legacy element. Those can't be shared this way, so it was left out.`); continue; }
    const { id: _id, liveId: _live, updatedAt: _u, category: _c, ...rest } = structuredClone(orig) as Overlay & { updatedAt?: string };
    const o = rest as Omit<Overlay, "id">;
    const missing = new Set<string>();
    let byShow = false;
    for (const l of o.layers ?? []) {
      if (l.type === "text" && l.font) {
        const want = l.font.toLowerCase();
        const f = added.find((a) => a.families.some((n) => n.toLowerCase() === want));
        if (f && !(await add(`fonts/${f.file}`, join(dirs.fontsDir, f.file)))) missing.add(`the font ${l.font}`);
      }
      if (!mediaLayer(l)) continue;
      for (const k of SOURCE_KEYS) {
        const src = l[k];
        if (!src || src === CHANNEL_LOGO) continue;
        if (src.startsWith(MATCH_PREFIX)) {
          // a picture picked by show can't be known ahead; one named outright goes in
          const name = src.slice(MATCH_PREFIX.length).trim();
          if (!name || hasTemplate(name)) { byShow = true; continue; }
          const p = findPicture(name, l.type === "video" ? "video" : "image", dirs.picturesDir);
          if (!p) { missing.add(name); continue; }
          const rel = relative(dirs.picturesDir, p).replace(/\\/g, "/");
          if (!(await add(`pictures/${rel}`, p))) missing.add(name);
          continue;
        }
        // uploaded, example and (legacy) absolute-path files all become pack assets
        const p = assetPath(src, dirs.assetsDir, undefined, l.type);
        const data = p ? await read(p) : null;
        if (!data) { missing.add(src.startsWith("assets/") ? `an uploaded ${l.type}` : basename(src)); continue; }
        const key = `assets/${md5(data)}${extname(p).toLowerCase() || ".png"}`;
        if (!files.has(key)) files.set(key, data);
        l[k] = key;
      }
    }
    if (o.timing?.mode === "media" && o.timing.media) {
      delete o.timing.media; // a path in this library; the importer picks their own file
      notes.push(`${quote(o.name)} shows whenever a particular video airs. That video isn't in the file: whoever imports it picks their own.`);
    }
    if (byShow) notes.push(`${quote(o.name)} picks pictures from the pictures folder by show. Those pictures aren't in the file: whoever imports it adds their own.`);
    if (missing.size) notes.push(`${quote(o.name)} uses ${[...missing].join(", ")}, which ${missing.size === 1 ? "isn't" : "aren't"} on this computer any more, so ${missing.size === 1 ? "it's" : "they're"} not in the file.`);
    overlays.push(o);
  }
  const manifest: OverlayPack = { format: PACK_FORMAT, version: PACK_VERSION, exportedAt: new Date().toISOString(), overlays };
  const zip = overlays.length ? writeZip([
    { name: MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") },
    { name: "README.txt", data: Buffer.from(README.replace(/\n/g, "\r\n"), "utf8") },
    ...[...files].map(([name, data]) => ({ name, data })),
  ]) : Buffer.alloc(0);
  return {
    zip,
    count: overlays.length,
    notes,
    fileName: packFileName(overlays.map((o) => o.name)),
  };
}

/** Bring a pack in: its files go where they belong and every overlay is added as a
 *  new one (renamed when the name is taken). Notes say what needs a look. */
export async function importOverlays(raw: Buffer, dirs: ShareDirs, takenNames: string[], save: (o: Overlay) => void): Promise<{ imported: { id: string; name: string }[]; notes: string[] }> {
  const NOT_A_PACK = "That file isn't an overlay pack. Pick a .overlays.zip file someone exported from the Overlays page.";
  let pack: OverlayPack;
  const files = new Map<string, Buffer>();
  if (isZip(raw)) {
    let entries;
    try { entries = readZip(raw); } catch (e) { throw new Error(`That zip can't be read: ${(e as Error).message}.`); }
    // re-zipped from a folder: everything sits one folder down
    const top = entries.find((e) => e.name === MANIFEST || e.name.endsWith(`/${MANIFEST}`) && e.name.split("/").length === 2);
    if (!top) throw new Error(NOT_A_PACK);
    const base = top.name.slice(0, -MANIFEST.length);
    try { pack = JSON.parse(top.data.toString("utf8")); } catch { throw new Error(`${NOT_A_PACK} (its overlays.json isn't valid)`); }
    for (const e of entries) if (e.name.startsWith(base) && e !== top) files.set(e.name.slice(base.length), e.data);
  } else {
    try { pack = JSON.parse(raw.toString("utf8")); } catch { throw new Error(NOT_A_PACK); }
    for (const [k, b64] of Object.entries(pack?.files && typeof pack.files === "object" ? pack.files : {})) if (typeof b64 === "string") files.set(k, Buffer.from(b64, "base64"));
  }
  if (pack?.format !== PACK_FORMAT || !Array.isArray(pack.overlays)) throw new Error(NOT_A_PACK);
  if (Number(pack.version) > PACK_VERSION) throw new Error("That pack was made by a newer version of the scheduler. Update this one (Settings) and try again.");
  const notes: string[] = [];

  // the files first: assets get new (content) names, pictures and fonts keep theirs
  const assets = new Map<string, string>(); // pack key -> src here
  for (const [key, data] of files) {
    try {
      if (/^assets\/[^/\\]+$/.test(key)) {
        assets.set(key, (await saveOverlayAsset(dirs.assetsDir, data, key.slice(7))).src);
      } else if (key.startsWith("pictures/")) {
        const rel = key.slice(9);
        const p = pictureFile(dirs.picturesDir, rel);
        if (!p) { notes.push(`Skipped the picture ${quote(rel)}: that name can't be used.`); continue; }
        if (existsSync(p)) { if (!(await sameFile(p, data))) notes.push(`Kept your own ${quote(rel)} in the pictures folder; the pack has a different one of the same name.`); continue; }
        const folder = dirname(rel.replace(/\\/g, "/"));
        await savePicture(dirs.picturesDir, data, basename(rel), folder === "." ? "" : folder);
      } else if (/^fonts\/[^/\\]+$/.test(key)) {
        const file = key.slice(6);
        const p = join(dirs.fontsDir, basename(file));
        if (existsSync(p)) { if (!(await sameFile(p, data))) notes.push(`Kept your own font file ${quote(file)}; the pack has a different one of the same name.`); continue; }
        await saveOverlayFont(dirs.fontsDir, data, file);
      }
    } catch (e) { notes.push(`Couldn't bring in ${quote(basename(key))}: ${(e as Error).message}`); }
  }

  const families = new Set(fontFamilyNames().map((f) => f.toLowerCase()));
  const names = new Set(takenNames.map((n) => n.toLowerCase()));
  const imported: { id: string; name: string }[] = [];
  for (const o of pack.overlays as Overlay[]) {
    if (!o || typeof o.name !== "string" || !o.name.trim() || !Array.isArray(o.layers)) { notes.push("Skipped an overlay with no name or layers."); continue; }
    if (o.legacy) { notes.push(`Skipped ${quote(o.name)}: ErsatzTV legacy elements can't come in this way.`); continue; }
    const { id: _id, liveId: _live, category: _c, updatedAt: _u, ...rest } = o as Overlay & { updatedAt?: string };
    let name = o.name.trim();
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${o.name.trim()} (${n})`;
    names.add(name.toLowerCase());
    const missing = new Set<string>();
    const fonts = new Set<string>();
    for (const l of rest.layers) {
      if (l?.type === "text" && l.font && !families.has(l.font.toLowerCase())) fonts.add(l.font);
      if (!l || !mediaLayer(l)) continue;
      for (const k of SOURCE_KEYS) {
        const src = l[k];
        if (!src || src === CHANNEL_LOGO || src.startsWith(MATCH_PREFIX) || src.startsWith("example:")) continue;
        if (assets.has(src)) { l[k] = assets.get(src)!; continue; }
        // a path on the sharer's machine never points into this one
        if (isAbsolute(src) || /^[a-z]:/i.test(src) || !existsSync(assetPath(src, dirs.assetsDir))) { missing.add(l.type); l[k] = ""; }
      }
    }
    const saved: Overlay = { ...rest, id: newOverlayId(), name };
    save(saved);
    imported.push({ id: saved.id, name });
    if (missing.size) notes.push(`${quote(name)} is missing ${[...missing].map((t) => (t === "image" ? "an image" : "a video")).join(" and ")} that wasn't in the pack. Open it and add one.`);
    if (fonts.size) notes.push(`${quote(name)} uses ${[...fonts].join(", ")}, which ${fonts.size === 1 ? "isn't" : "aren't"} on this computer, so its text draws in a stand-in font. Add it with "Add a font file" in a text layer's font list.`);
    if (saved.timing?.mode === "media" && !saved.timing.media) notes.push(`${quote(name)} shows whenever a particular video airs. Open it and pick the video under "When it shows".`);
    if (saved.layers.some((l) => mediaLayer(l) && [l.src, l.fallback].some((s) => s?.startsWith(MATCH_PREFIX) && hasTemplate(s)))) notes.push(`${quote(name)} picks pictures from the pictures folder by show. Add yours on the Overlays page, under Pictures picked by the schedule.`);
  }
  return { imported, notes };
}
