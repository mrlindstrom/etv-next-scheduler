// -----------------------------------------------------------------------------
// The overlay library on the server: where overlay assets and rendered PNGs
// live, the per-channel build options, and legacy watermark import.
// -----------------------------------------------------------------------------
// <runtime>/overlays/assets   uploaded images / videos (content-addressed names)
// <runtime>/overlays/cache    rendered overlay PNGs (one per distinct text; files
//                             nothing has used for a while are pruned)
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import type { ConfigStore } from "./config.js";
import { sniffImage, logoPath, isManagedLogo } from "./channel-logos.js";
import { CHANNEL_LOGO, type Overlay, type OverlayBuildOptions } from "../overlays.js";
import type { WatermarkLocation } from "../model.js";

export const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const VIDEO_EXT = ["mp4", "mov", "webm", "mkv", "m4v"];

const abs = (root: string, p: string) => (isAbsolute(p) ? p : join(root, p));
export const overlaysDir = (store: ConfigStore, root: string) => join(abs(root, store.getNextConfig().runtimeDir), "overlays");
export const overlayAssetsDir = (store: ConfigStore, root: string) => join(overlaysDir(store, root), "assets");
export const overlayCacheDir = (store: ConfigStore, root: string) => join(overlaysDir(store, root), "cache");

/** The library as engine overlays (anything malformed is dropped). */
export function overlayLibrary(store: ConfigStore): Overlay[] {
  return store.listOverlays().filter((o) => o && o.id && Array.isArray(o.layers)).map((o) => o as Overlay);
}

/** What a build of this channel needs to draw its overlays. */
export function overlayOptionsFor(store: ConfigStore, channelName: string, root: string): OverlayBuildOptions {
  const meta = store.channelMeta(channelName);
  return {
    library: overlayLibrary(store),
    channel: meta?.overlays ?? [],
    assetsDir: overlayAssetsDir(store, root),
    cacheDir: overlayCacheDir(store, root),
    channelName: meta?.name ?? channelName,
    channelNumber: meta?.number ?? "",
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

/** The stored file for an asset name (null if the name isn't one of ours). */
export function overlayAssetFile(dir: string, file: string): string | null {
  return /^[0-9A-F]{32}\.[a-z0-9]{2,4}$/.test(file) ? join(dir, file) : null;
}

/** Delete rendered PNGs nothing has used for `days` (builds touch what they reuse). */
export function pruneOverlayCache(dir: string, days = 14): number {
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - days * 86_400_000;
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (!/^[0-9a-f]{40}\.png$/.test(f)) continue;
    try { if (statSync(join(dir, f)).mtimeMs < cutoff) { unlinkSync(join(dir, f)); n++; } } catch { /* in use */ }
  }
  return n;
}

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
