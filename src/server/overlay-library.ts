// -----------------------------------------------------------------------------
// The overlay library on the server: where overlay assets and rendered PNGs
// live, the per-channel build options, and legacy watermark import.
// -----------------------------------------------------------------------------
// <runtime>/overlays/assets   uploaded images / videos (content-addressed names)
// <runtime>/overlays/cache    rendered overlay PNGs (one per distinct text; files
//                             nothing has used for a while are pruned)
// <runtime>/overlays/images   pictures that layers pick by the schedule (match:{{next_show}});
//                             named by the people adding them, so the name is the match.
//                             Settings can point it elsewhere (e.g. a shared folder).
// <runtime>/overlays/fonts    fonts added for overlay text (TTF / OTF, kept by their own names)
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync, unlinkSync, rmSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigStore } from "./config.js";
import { sniffImage, logoPath, isManagedLogo } from "./channel-logos.js";
import { CHANNEL_LOGO, setOverlayExamplesDir, setOverlayPicturesDir, addFontDir, addFontFile, forgetFontFile, fontFileFamilies, type Overlay, type OverlayBuildOptions } from "../overlays.js";
import type { WatermarkLocation } from "../model.js";

export const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const VIDEO_EXT = ["mp4", "mov", "webm", "mkv", "m4v"];

const abs = (root: string, p: string) => (isAbsolute(p) ? p : join(root, p));
export const overlaysDir = (store: ConfigStore, root: string) => join(abs(root, store.getNextConfig().runtimeDir), "overlays");
export const overlayAssetsDir = (store: ConfigStore, root: string) => join(overlaysDir(store, root), "assets");
export const overlayCacheDir = (store: ConfigStore, root: string) => join(overlaysDir(store, root), "cache");
/** Fonts added for overlay text; drawings in this thread can use them once this is called. */
export const overlayFontsDir = (store: ConfigStore, root: string) => {
  const d = join(overlaysDir(store, root), "fonts");
  if (existsSync(d)) addFontDir(d, true);
  return d;
};
/** The pictures folder `match:` layers pick from (also where they resolve in this thread). */
export const overlayPicturesDir = (store: ConfigStore, root: string) => {
  const set = store.get().overlayPicturesDir?.trim();
  const d = set ? abs(root, set) : join(overlaysDir(store, root), "images");
  setOverlayPicturesDir(d);
  return d;
};

/** The library as engine overlays (anything malformed is dropped). */
export function overlayLibrary(store: ConfigStore): Overlay[] {
  return store.listOverlays().filter((o) => o && o.id && Array.isArray(o.layers)).map((o) => o as Overlay);
}

/** What a build of this channel needs to draw its overlays. */
export function overlayOptionsFor(store: ConfigStore, channelName: string, root: string): OverlayBuildOptions {
  const meta = store.channelMeta(channelName);
  const nc = store.getNextConfig();
  const ff = nc.ffmpegPath ? abs(root, nc.ffmpegPath) : join(root, "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  overlayFontsDir(store, root); // the added fonts, for this build's drawings
  return {
    library: overlayLibrary(store),
    channel: meta?.overlays ?? [],
    assetsDir: overlayAssetsDir(store, root),
    cacheDir: overlayCacheDir(store, root),
    channelName: meta?.name ?? channelName,
    channelNumber: meta?.number ?? "",
    examplesDir: overlayExamplesDir(root),
    liveBase: `http://127.0.0.1:${Number(process.env.PORT ?? 8730)}`,
    picturesDir: overlayPicturesDir(store, root),
    ffmpeg: existsSync(ff) ? ff : (nc.ffmpegPath || "ffmpeg"),
    output: { w: nc.video?.width || 1920, h: nc.video?.height || 1080 },
    channelLogo: meta?.logo && isManagedLogo(meta.logo) ? logoPath(join(abs(root, store.getNextConfig().runtimeDir), "logos"), meta.logo) ?? undefined : undefined,
  };
}

/** Store an uploaded image or video (deduplicated by content); returns its `src`. */
export async function saveOverlayAsset(dir: string, data: Buffer, fileName = ""): Promise<{ src: string; kind: "image" | "video" }> {
  const img = sniffImage(data);
  let ext = img?.ext ?? "";
  let kind: "image" | "video" = "image";
  if (!img) {
    const e = fileName.split(".").pop()?.toLowerCase() ?? "";
    // MP4 / MOV: "ftyp" at byte 4; WebM / MKV: EBML magic
    const isoBmff = data.subarray(4, 8).toString("latin1") === "ftyp";
    const ebml = data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3;
    if (!(isoBmff || ebml)) throw new Error("That file isn't a supported image (PNG, JPEG, GIF, WebP, SVG) or video (MP4, MOV, WebM, MKV).");
    ext = VIDEO_EXT.includes(e) ? e : isoBmff ? "mp4" : "webm";
    kind = "video";
    if (data.length > MAX_VIDEO_BYTES) throw new Error("The video is too large (the limit is 300 MB).");
  }
  const file = `${createHash("md5").update(data).digest("hex").toUpperCase()}.${ext}`;
  await mkdir(dir, { recursive: true });
  const dest = join(dir, file);
  if (!existsSync(dest)) await writeFile(dest, data);
  return { src: `assets/${file}`, kind };
}

// ---- fonts added for overlay text --------------------------------------------------
export const MAX_FONT_BYTES = 40 * 1024 * 1024;
const FONT_FILE = /\.(ttf|otf)$/i;
/** The added fonts: each file and the family names in it. */
export function listOverlayFonts(dir: string): { file: string; families: string[] }[] {
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => FONT_FILE.test(n)); } catch { return []; }
  return names.sort((a, b) => a.localeCompare(b)).map((file) => ({ file, families: fontFileFamilies(join(dir, file)) }));
}
/** Save an added font under its own name (a newer copy replaces it) and start using it. */
export async function saveOverlayFont(dir: string, data: Buffer, fileName: string): Promise<{ file: string; families: string[] }> {
  const tag = data.subarray(0, 4).toString("latin1");
  const sfnt = tag === "OTTO" || tag === "true" || (data[0] === 0 && data[1] === 1 && data[2] === 0 && data[3] === 0);
  if (!sfnt) throw new Error(tag === "wOFF" || tag === "wOF2" ? "That's a web font (WOFF). Add the TTF or OTF version of the font." : "That file isn't a TTF or OTF font.");
  if (data.length > MAX_FONT_BYTES) throw new Error("The font file is too large (the limit is 40 MB).");
  const stem = basename(fileName || "font").replace(/\.[^.]*$/, "").replace(/[^\w .()+-]+/g, "").trim() || "font";
  const file = `${stem}.${tag === "OTTO" ? "otf" : "ttf"}`;
  await mkdir(dir, { recursive: true });
  const dest = join(dir, file);
  await writeFile(dest, data);
  forgetFontFile(dest);
  const families = addFontFile(dest);
  if (!families.length) { try { unlinkSync(dest); } catch { /* ignore */ } throw new Error("Couldn't read the font's name from that file."); }
  return { file, families };
}
/** An added font's path by its file name (null when it isn't one). */
export function overlayFontFile(dir: string, file: string): string | null {
  const name = basename(file);
  return name === file && FONT_FILE.test(name) ? join(dir, name) : null;
}
/** Delete an added font. */
export function deleteOverlayFont(dir: string, file: string): boolean {
  const p = overlayFontFile(dir, file);
  if (!p || !existsSync(p)) return false;
  forgetFontFile(p);
  unlinkSync(p);
  return true;
}

// ---- the pictures folder (layers that pick a picture by the schedule) ------------
const PICTURE_FILE = /\.(png|jpe?g|webp|gif|svg|bmp|mp4|mov|webm|mkv|m4v)$/i;

/** A path inside the pictures folder from a name like "logos/Rugrats.png" (null if
 *  it would leave the folder or isn't a picture / video). */
export function pictureFile(dir: string, name: string): string | null {
  const parts = String(name ?? "").replace(/\\/g, "/").split("/").filter((p) => p && p !== ".");
  if (!parts.length || parts.some((p) => p === ".." || /[<>:"|?*\x00-\x1f]/.test(p)) || !PICTURE_FILE.test(parts[parts.length - 1])) return null;
  return join(dir, ...parts);
}

/** Every picture / video in the folder (and its sub-folders), as "sub/name.png". */
export function listPictures(dir: string, limit = 5000): { files: { name: string; size: number }[]; truncated: boolean } {
  const files: { name: string; size: number }[] = [];
  const walk = (rel: string, depth: number) => {
    let ents: import("node:fs").Dirent[] = [];
    try { ents = readdirSync(join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (files.length >= limit) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && depth < 4 && !e.name.startsWith(".")) walk(r, depth + 1);
      else if (e.isFile() && PICTURE_FILE.test(e.name)) { let size = 0; try { size = statSync(join(dir, r)).size; } catch { /* gone */ } files.push({ name: r, size }); }
    }
  };
  walk("", 0);
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return { files, truncated: files.length >= limit };
}

/** Save an uploaded picture under the name it came with (that name is what layers
 *  match), replacing one of the same name. Returns the stored name. */
export async function savePicture(dir: string, data: Buffer, fileName: string, folder = ""): Promise<string> {
  const img = sniffImage(data);
  const isoBmff = data.subarray(4, 8).toString("latin1") === "ftyp";
  const ebml = data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3;
  if (!img && !isoBmff && !ebml) throw new Error("That file isn't a picture (PNG, JPEG, GIF, WebP, SVG, BMP) or video (MP4, MOV, WebM, MKV).");
  if (!img && data.length > MAX_VIDEO_BYTES) throw new Error("The video is too large (the limit is 300 MB).");
  // keep the name people chose (it's the match), minus characters files can't have
  let base = basename(String(fileName || "picture").replace(/\\/g, "/")).replace(/[<>:"/\\|?*\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim() || "picture";
  const ext = (base.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  const kindExt = img?.ext ?? (isoBmff ? "mp4" : "webm");
  if (!PICTURE_FILE.test(base)) base = `${base.replace(/\.[a-z0-9]+$/i, "") || "picture"}.${img ? kindExt : (VIDEO_EXT.includes(ext) ? ext : kindExt)}`;
  const target = pictureFile(dir, folder ? `${folder}/${base}` : base);
  if (!target) throw new Error("That folder name can't be used.");
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, data);
  return folder ? `${folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")}/${base}` : base;
}

/** The stored file for an asset name (null if the name isn't one of ours). */
export function overlayAssetFile(dir: string, file: string): string | null {
  return /^[0-9A-F]{32}\.[a-z0-9]{2,4}$/.test(file) ? join(dir, file) : null;
}

/** Delete rendered stills and animated clips nothing has used for `days` (builds
 *  touch what they reuse), and leftovers of interrupted builds (a day old). */
export function pruneOverlayCache(dir: string, days = 14): number {
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - days * 86_400_000, stale = Date.now() - 86_400_000;
  let n = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    try {
      if (/^[0-9a-f]{40}\.(png|mkv)$/.test(f)) { if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); n++; } }
      else if (/^[0-9a-f]{40}\.part\.mkv$/.test(f) || /^tmp-[0-9a-f]{40}$/.test(f)) { if (statSync(p).mtimeMs < stale) { rmSync(p, { recursive: true, force: true }); n++; } }
    } catch { /* in use */ }
  }
  return n;
}

/** The shipped example overlays and their artwork (examples/overlays). */
// They ship with the code (dist/server/ -> ../../examples), so find them from here,
// falling back to the data root.
export const overlayExamplesDir = (root: string) => {
  const fromCode = fileURLToPath(new URL("../../examples/overlays/assets", import.meta.url));
  const d = existsSync(fromCode) ? fromCode : join(root, "examples", "overlays", "assets");
  setOverlayExamplesDir(d);
  return d;
};

export const newOverlayId = () => `ov-${randomUUID().slice(0, 8)}`;

// ---- legacy watermarks --------------------------------------------------------
// Legacy enums (ErsatzTV legacy: ChannelWatermark.cs, ErsatzTV.FFmpeg/State/WatermarkState.cs)
const LEGACY_LOCATION: WatermarkLocation[] = ["bottom_right", "bottom_left", "top_right", "top_left", "top_center", "center_right", "bottom_center", "center_left", "center"];
const MODE = { None: 0, Permanent: 1, Intermittent: 2, OpacityExpression: 3 } as const;
const IMAGE_SOURCE = { Custom: 0, ChannelLogo: 1 } as const;
const SIZE_ACTUAL = 1;

/** Legacy's watermark cache: <legacy data dir>/cache/artwork/watermarks/<first 2>/<HASH>. */
export function legacyWatermarkFile(legacyDbPaths: string[], hash: string): string | null {
  if (!/^[0-9A-Fa-f]{32}$/.test(hash)) return null;
  for (const db of legacyDbPaths) {
    for (const h of [hash.toUpperCase(), hash.toLowerCase()]) {
      const p = join(db, "..", "cache", "artwork", "watermarks", h.slice(0, 2), h);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** A legacy ChannelWatermark row as an overlay (warnings say what didn't translate).
 *  `image` is the overlay `src` the caller stored, or null. */
export function overlayFromLegacyWatermark(w: any, image: string | null, warnings: string[]): Overlay | null {
  const name = String(w.Name ?? "Watermark");
  if (Number(w.Mode) === MODE.None) { warnings.push(`watermark "${name}" is switched off in legacy — not imported`); return null; }
  const useLogo = Number(w.ImageSource) === IMAGE_SOURCE.ChannelLogo;
  if (!image && !useLogo) { warnings.push(`watermark "${name}": its image isn't in legacy's cache on this machine — not imported`); return null; }
  const o: Overlay = {
    id: `legacy-watermark-${w.Id}`, name: `${name} (watermark)`,
    layers: [{ type: "image", src: useLogo ? CHANNEL_LOGO : image!, x: 0, y: 0, w: 0, h: 0 }],
    timing: { mode: "always" },
    opacity: Math.max(0, Math.min(100, Number(w.Opacity ?? 100))),
    withinContent: !!w.PlaceWithinSourceContent,
    anchor: {
      location: LEGACY_LOCATION[Number(w.Location)] ?? "bottom_right",
      hMargin: Number(w.HorizontalMarginPercent ?? 0), vMargin: Number(w.VerticalMarginPercent ?? 0),
      ...(Number(w.Size) === SIZE_ACTUAL ? {} : { widthPercent: Number(w.WidthPercent ?? 10) }),
    },
  };
  if (Number(w.Mode) === MODE.Intermittent) {
    o.timing = { mode: "every", everyMinutes: Math.max(1, Number(w.FrequencyMinutes ?? 15)), showSeconds: Math.max(1, Number(w.DurationSeconds ?? 15)) };
  } else if (Number(w.Mode) === MODE.OpacityExpression) {
    warnings.push(`watermark "${name}" uses an opacity expression, which isn't supported — imported as always on`);
  }
  return o;
}

/** Read a legacy image file into the overlay asset store (null if unreadable). */
export async function importLegacyOverlayImage(dir: string, file: string): Promise<string | null> {
  try { return (await saveOverlayAsset(dir, await readFile(file))).src; } catch { return null; }
}

export { IMAGE_SOURCE as LEGACY_WATERMARK_IMAGE_SOURCE };
