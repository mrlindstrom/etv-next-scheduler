// -----------------------------------------------------------------------------
// ErsatzTV legacy graphics elements on the server: import and test.
// -----------------------------------------------------------------------------
//   GET  /api/overlays/legacy-folder          legacy's graphics-elements folder and what's in it
//   POST /api/overlays/legacy-import          { items: [{ file, text, kind? }] } (pasted / uploaded)
//   POST /api/overlays/legacy-import-folder   { folder }  every element in a graphics-elements folder
//   POST /api/overlays/legacy-test            { overlay, channel, match?, at? }  fill an element in for
//        a real airing: the variables, the filled-in YAML, the layers a build makes, and a preview
//        drawn over that item's own picture
// Imported elements are overlays with a `legacy` part (see legacy-graphics.ts); re-importing a
// file replaces the element with the same file name.
import type { FastifyInstance } from "fastify";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import type { ConfigStore } from "./config.js";
import { getResolver } from "./resolverCache.js";
import { overlayCacheDir, newOverlayId } from "./overlay-library.js";
import { legacyKindOf, legacyRef, legacyVars, fillLegacy, legacyLayers, epgEntriesOf, missingPaths, imageSize, legacyPosition, LEGACY_KINDS, type LegacyElement, type LegacyKind, type LegacyContext } from "../legacy-graphics.js";
import { templateSyntaxError, toText, TemplateDate, TemplateSpan } from "../scriban.js";
import { parseOpacity } from "../ncalc.js";
import { rasterize, loadRasterizer, type Overlay } from "../overlays.js";
import type { GuideEntry } from "../engine.js";

const DEFAULT_FOLDER = () => join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || process.env.HOME || "", "AppData", "Local"), "ersatztv", "templates", "graphics-elements");

/** The elements in a graphics-elements folder: "image/x.yml" etc. */
function folderElements(folder: string): { file: string; kind: LegacyKind; path: string }[] {
  const out: { file: string; kind: LegacyKind; path: string }[] = [];
  for (const kind of LEGACY_KINDS) {
    const d = join(folder, kind);
    let names: string[] = [];
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) if (/\.ya?ml$/i.test(n)) { try { if (statSync(join(d, n)).isFile()) out.push({ file: `${kind}/${n}`, kind, path: join(d, n) }); } catch { /* gone */ } }
  }
  return out;
}

/** A readable name from a legacy file name: "image/cn_city.yml" -> "cn city (legacy image)". */
const nameFor = (file: string, kind: LegacyKind) => `${basename(file).replace(/\.ya?ml$/i, "").replace(/[_-]+/g, " ").trim() || "element"} (legacy ${kind})`;

/** A programme list from an XMLTV file (what legacy's Epg[n] reads). */
function xmltvGuide(file: string): GuideEntry[] {
  let xml = "";
  try { xml = readFileSync(file, "utf8"); } catch { return []; }
  const un = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  const when = (s: string) => { const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)\s*([+-]\d{4})?/.exec(s); if (!m) return NaN; const off = m[7] ? (m[7][0] === "-" ? -1 : 1) * (+m[7].slice(1, 3) * 60 + +m[7].slice(3)) : 0; return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - off * 60_000; };
  const out: GuideEntry[] = [];
  for (const m of xml.matchAll(/<programme\b([^>]*)>([\s\S]*?)<\/programme>/g)) {
    const attr = (n: string) => new RegExp(`${n}="([^"]*)"`).exec(m[1])?.[1] ?? "";
    const tag = (n: string) => { const t = new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)</${n}>`).exec(m[2]); return t ? un(t[1].trim()) : ""; };
    const title = tag("title"), sub = tag("sub-title");
    const startMs = when(attr("start")), stopMs = when(attr("stop"));
    if (!Number.isFinite(startMs) || !Number.isFinite(stopMs)) continue;
    const genres = [...m[2].matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/g)].map((c) => un(c[1].trim()));
    const year = Number(tag("date").slice(0, 4));
    out.push({ startMs, stopMs, item: { id: String(out.length), path: "", durationMs: stopMs - startMs, chapters: [], title: sub || title, showTitle: sub ? title : "", plot: tag("desc"), year: Number.isFinite(year) && year > 0 ? year : undefined, genres } as any });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** The variables an element saw, flattened for display ("Epg[1].Title" → value). */
function flatVars(v: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = [];
  const show = (x: unknown) => (x instanceof TemplateDate || x instanceof TemplateSpan ? x.toString() : Array.isArray(x) ? x.map((y) => toText(y)).join(", ") : toText(x));
  for (const [k, x] of Object.entries(v)) {
    if (k === "Epg" && Array.isArray(x)) x.forEach((e, i) => { for (const [f, y] of Object.entries(e as object)) out.push([`Epg[${i}].${f}`, show(y)]); });
    else if (x && typeof x === "object" && !(x instanceof TemplateDate) && !(x instanceof TemplateSpan) && !Array.isArray(x)) for (const [f, y] of Object.entries(x)) out.push([`${k}.${f}`, show(y)]);
    else out.push([k, show(x)]);
  }
  return out;
}

/** "fades in at 1.24 s, full 1.44–9.04 s, gone by 9.24 s" */
function describeOpacity(def: Record<string, any>): string {
  const expr = def.opacity_expression != null ? String(def.opacity_expression).trim() : "";
  if (!expr) return `always shown${def.opacity_percent != null ? ` at ${def.opacity_percent}%` : ""}`;
  try {
    const p = parseOpacity(expr);
    if (p.kind === "constant") return `always shown at ${Math.round(p.opacity * 100)}%`;
    if (p.kind === "curve") return "a custom curve: shown as timed fades where it's visible";
    const f = p.fade, r = (n: number) => Math.round(n * 100) / 100;
    const s = `fades in from ${r(f.startS)} s, full ${r(f.startS + f.fadeInS)}–${r(f.startS + f.fadeInS + f.holdS)} s, gone by ${r(f.startS + f.fadeInS + f.holdS + f.fadeOutS)} s`;
    const clock = f.clock === "content" ? "into the item" : "of the day";
    return `${s} ${clock}${f.everyS && f.everyS !== 86_400 ? `, every ${r(f.everyS)} s` : ""}${Math.abs(f.fadeInS - f.fadeOutS) > 0.005 ? " (next uses one fade length both ways: the average)" : ""}`;
  } catch (e) { return `opacity_expression problem: ${(e as Error).message}`; }
}

export function registerLegacyElementRoutes(app: FastifyInstance, store: ConfigStore, root: string, libDb: () => string): void {
  const abs = (p: string) => (isAbsolute(p) || /^[A-Za-z]:/.test(p) ? p : join(root, p));
  const nc = () => store.getNextConfig();

  const save = (file: string, text: string, kindIn?: string) => {
    const f = file.replace(/\\/g, "/").trim() || "element.yml";
    const kind = (LEGACY_KINDS as string[]).includes(String(kindIn)) ? kindIn as LegacyKind : legacyKindOf(f, text);
    const ref = f.includes("/") ? f : `${kind}/${f}`;
    const existing = (store.listOverlays() as Overlay[]).find((o) => o.legacy?.file && legacyRef(o.legacy.file) === legacyRef(ref));
    const legacy: LegacyElement = { kind, yaml: text, file: /\.ya?ml$/i.test(ref) ? ref : `${ref}.yml` };
    const o: Overlay = existing ? { ...existing, legacy } : { id: newOverlayId(), name: nameFor(ref, kind), layers: [], timing: { mode: "always" }, duringFiller: true, legacy };
    store.saveOverlay(o as any);
    const warnings: string[] = [];
    const syntax = templateSyntaxError(text);
    if (syntax) warnings.push(`template: ${syntax}`);
    for (const p of missingPaths(text)) warnings.push(`${p} isn't on this machine`);
    if (kind === "subtitle" || kind === "script") warnings.push(`${kind} elements aren't supported yet — it's imported, but won't draw`);
    return { id: o.id, name: o.name, kind, file: legacy.file, replaced: !!existing, warnings };
  };

  app.get("/api/overlays/legacy-folder", async (req) => {
    const folder = String((req.query as any).folder ?? "") || DEFAULT_FOLDER();
    return { folder, exists: existsSync(folder), files: folderElements(folder).map(({ file, kind }) => ({ file, kind })) };
  });
  app.post("/api/overlays/legacy-import", async (req, reply) => {
    const items = ((req.body ?? {}) as { items?: { file?: string; text?: string; kind?: string }[] }).items ?? [];
    if (!items.length) { reply.code(400); return { error: "Paste or upload at least one element." }; }
    return { imported: items.filter((i) => String(i.text ?? "").trim()).map((i) => save(String(i.file ?? "element.yml"), String(i.text), i.kind)) };
  });
  app.post("/api/overlays/legacy-import-folder", async (req, reply) => {
    const folder = String(((req.body ?? {}) as { folder?: string }).folder ?? "") || DEFAULT_FOLDER();
    if (!existsSync(folder)) { reply.code(400); return { error: `${folder} isn't on this machine.` }; }
    const files = folderElements(folder);
    if (!files.length) { reply.code(400); return { error: `No elements found in ${folder} (it should have image, text, motion… folders of .yml files).` }; }
    return { imported: files.map((f) => save(f.file, readFileSync(f.path, "utf8"), f.kind)) };
  });

  // fill an element in for a real airing on a channel, and draw what a build would
  app.post("/api/overlays/legacy-test", async (req, reply) => {
    const body = (req.body ?? {}) as { overlay?: Overlay; channel?: string; match?: string; at?: number };
    const el = body.overlay?.legacy;
    if (!el) { reply.code(400); return { error: "Send the element to test." }; }
    const ch = String(body.channel ?? "");
    const meta = store.channelMeta(ch);
    if (!meta) { reply.code(400); return { error: "Pick a channel." }; }
    const runtime = abs(nc().runtimeDir);
    const dir = join(runtime, "playouts", ch);
    let items: { start: string; finish: string; source?: { path?: string } }[] = [];
    try {
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".json") && !x.endsWith(".labels.json")).sort()) {
        try { items.push(...(JSON.parse(readFileSync(join(dir, f), "utf8")).items ?? [])); } catch { /* skip */ }
      }
    } catch { reply.code(400); return { error: `${ch} has no built playout yet — build it first (Build page).` }; }
    items = items.filter((i) => i.source?.path).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const now = Number(body.at) || Date.now();
    const match = String(body.match ?? "").trim().toLowerCase();
    const item = match
      ? items.find((i) => Date.parse(i.finish) > now && i.source!.path!.toLowerCase().includes(match)) ?? items.find((i) => i.source!.path!.toLowerCase().includes(match))
      : items.find((i) => Date.parse(i.start) <= now && Date.parse(i.finish) > now) ?? items.find((i) => Date.parse(i.start) > now) ?? items[items.length - 1];
    if (!item) { reply.code(400); return { error: match ? `Nothing on ${ch} plays a file whose name contains “${body.match}”.` : `${ch}'s playout is empty.` }; }
    const resolver = (() => { try { return getResolver(libDb()); } catch { return null; } })();
    const output = { w: nc().video?.width || 1920, h: nc().video?.height || 1080 };
    const guide = xmltvGuide(join(runtime, "xmltv", `${meta.tvgId || ch}.xml`));
    const tz = store.get().tz;
    const ctx: LegacyContext = { path: item.source!.path!, startMs: Date.parse(item.start), stopMs: Date.parse(item.finish), tz, guide, output,
      info: (p) => { try { return (resolver as any)?.templateData?.(p) ?? null; } catch { return null; } } };
    const vars = legacyVars(ctx, epgEntriesOf(el.yaml));
    const problems: string[] = [];
    let yaml = "", def: Record<string, any> | null = null;
    try { ({ yaml, def } = fillLegacy(el, vars, tz)); } catch (e) { problems.push((e as Error).message); }
    const ffmpeg = nc().ffmpegPath ? abs(nc().ffmpegPath) : "ffmpeg";
    const layers = def ? (await legacyLayers(el, ctx, { cacheDir: overlayCacheDir(store, root), ffprobe: ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace(/ffmpeg/i, "ffprobe")), problems })).sort((a, b) => a.z - b.z) : [];

    // preview: the item's own picture once the element is fully up, with the element drawn on it
    let preview: string | null = null;
    if (def) {
      const t = layers[0]?.layer.timing;
      const atS = t && t.clock === "content" ? ((t.phase_offset_ms ?? 0) + (t.fade_ms ?? 0) + Math.min(500, (t.hold_ms ?? 0) / 2)) / 1000 : Math.min(5, (ctx.stopMs - ctx.startMs) / 3000);
      const frame = await new Promise<Buffer | null>((done) => {
        execFile(ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", atS.toFixed(2), "-i", ctx.path, "-frames:v", "1", "-vf", `scale=${output.w}:${output.h}:force_original_aspect_ratio=decrease,pad=${output.w}:${output.h}:(ow-iw)/2:(oh-ih)/2`, "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
          { encoding: "buffer", windowsHide: true, timeout: 20_000, maxBuffer: 32 << 20 }, (err, out) => done(err || !out?.length ? null : out));
      });
      const W = output.w, H = output.h;
      let body = frame ? `<image width="${W}" height="${H}" href="data:image/jpeg;base64,${frame.toString("base64")}"/>` : `<rect width="${W}" height="${H}" fill="#111827"/>`;
      for (const { layer } of layers) {
        const p = (layer.source as { path?: string }).path ?? "";
        const op = layer.opacity_percent != null ? layer.opacity_percent / 100 : 1;
        const isVideo = /\.(mp4|mov|mkv|webm|m4v|avi|ts)$/i.test(p);
        if (!p || !existsSync(p)) continue;
        if (isVideo) {
          const w = layer.width_percent ? (layer.width_percent / 100) * W : W / 4, h = w * 9 / 16;
          const pos = legacyPosition(locKey(layer.location), W, H, w, h, Math.round((layer.horizontal_margin_percent ?? 0) / 100 * W), Math.round((layer.vertical_margin_percent ?? 0) / 100 * H));
          body += `<rect x="${pos.x}" y="${pos.y}" width="${w}" height="${h}" fill="rgba(79,140,255,.35)" stroke="#4f8cff" stroke-width="4" opacity="${op}"/><text x="${pos.x + 12}" y="${pos.y + 40}" font-family="Arial" font-size="30" fill="#fff">▶ ${basename(p).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`;
          continue;
        }
        const size = imageSize(p);
        if (!size) continue;
        const w = layer.width_percent != null ? Math.round((layer.width_percent / 100) * W) : size.w;
        const h = Math.round(w * (size.h / size.w));
        const pos = legacyPosition(locKey(layer.location), W, H, w, h, Math.round((layer.horizontal_margin_percent ?? 0) / 100 * W), Math.round((layer.vertical_margin_percent ?? 0) / 100 * H));
        const mime = /\.png$/i.test(p) ? "image/png" : /\.gif$/i.test(p) ? "image/gif" : /\.webp$/i.test(p) ? "image/webp" : "image/jpeg";
        body += `<image x="${pos.x}" y="${pos.y}" width="${w}" height="${h}" preserveAspectRatio="none" opacity="${op}" href="data:${mime};base64,${readFileSync(p).toString("base64")}"/>`;
      }
      await loadRasterizer();
      const png = await rasterize(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(W / 2)}" height="${Math.round(H / 2)}" viewBox="0 0 ${W} ${H}">${body}</svg>`);
      preview = png ? `data:image/png;base64,${png.toString("base64")}` : null;
    }
    return {
      item: { path: ctx.path, name: basename(ctx.path), start: item.start, finish: item.finish },
      vars: flatVars(vars), yaml, layers: layers.map((x) => ({ ...x.layer, z: x.z })), problems: [...new Set(problems)],
      timing: def ? describeOpacity(def) : "", preview, guideFound: guide.length > 0,
    };
  });
}

/** next's location back to legacy's position rule key. */
function locKey(loc: string): string {
  return ({ bottom_right: "bottomright", bottom_left: "bottomleft", top_right: "topright", top_left: "topleft", top_center: "topmiddle", center_right: "rightmiddle", bottom_center: "bottommiddle", center_left: "leftmiddle", center: "middlecenter" } as Record<string, string>)[loc] ?? "bottomright";
}
