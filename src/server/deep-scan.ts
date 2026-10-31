// Targeted "deep scan" — force a full metadata refresh (re-probing streams and
// chapters) for one item, or a whole show/season, mirroring ErsatzTV legacy's
// per-title deep scan. Unlike the library scan it ignores the incremental skip:
//   * local items are re-ffprobed
//   * Plex items get a per-item /library/metadata fetch (streams + chapters)
//   * Jellyfin/Emby items are re-fetched by id with full Fields
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { openRW, reprobeLocalVersion, ffprobeChapters, KIND_TABLE, KIND_FK } from "./scanner-local.js";
import { readSourceInfo, pickReachableAddress, fetchPlexItemFull, fetchJellyfinByIds, upsertRemoteLibrary, applyReplacements, type Fetcher, type RemoteItem, type ProviderType } from "./scanner-remote.js";

const TYPE_KIND: Record<string, number> = { movie: 1, episode: 2, music_video: 3, other_video: 4, song: 5, image: 6 };

export interface DeepScanEvent { phase: string; done?: number; total?: number; current?: string; }
export interface DeepScanSummary { targets: number; refreshed: number; failed: number; chapters: number; ms: number; }

interface Ctx { itemId: number; kind: number; versionId: number; path: string | null; libraryId: number; sourceId: number; sourceType: string; key: string | null; }

function sourceType(db: DatabaseSync, sourceId: number): string {
  const has = (t: string) => { try { return !!db.prepare(`SELECT 1 FROM ${t} WHERE Id=?`).get(sourceId); } catch { return false; } };
  if (has("LocalMediaSource")) return "local";
  if (has("PlexMediaSource")) return "plex";
  if (has("JellyfinMediaSource")) return "jellyfin";
  if (has("EmbyMediaSource")) return "emby";
  return "unknown";
}

function targetItems(db: DatabaseSync, type: string, id: number): { itemId: number; kind: number }[] {
  if (type === "show") return (db.prepare(`SELECT e.Id id FROM Episode e JOIN Season se ON se.Id=e.SeasonId WHERE se.ShowId=?`).all(id) as any[]).map((r) => ({ itemId: r.id, kind: 2 }));
  if (type === "season") return (db.prepare(`SELECT Id id FROM Episode WHERE SeasonId=?`).all(id) as any[]).map((r) => ({ itemId: r.id, kind: 2 }));
  const kind = TYPE_KIND[type];
  return kind ? [{ itemId: id, kind }] : [];
}

function contextFor(db: DatabaseSync, itemId: number, kind: number): Ctx | null {
  const tbl = KIND_TABLE[kind], fk = KIND_FK[kind];
  const r = db.prepare(
    `SELECT mv.Id versionId, l.MediaSourceId sourceId, lp.LibraryId libraryId,
            (SELECT Path FROM MediaFile WHERE MediaVersionId=mv.Id LIMIT 1) path
       FROM ${tbl} k JOIN MediaVersion mv ON mv.${fk}=k.Id
       JOIN MediaItem mi ON mi.Id=k.Id
       JOIN LibraryPath lp ON lp.Id=mi.LibraryPathId
       JOIN Library l ON l.Id=lp.LibraryId
      WHERE k.Id=?`
  ).get(itemId) as any;
  if (!r) return null;
  const st = sourceType(db, r.sourceId);
  let key: string | null = null;
  if (st !== "local") {
    const keyTbl = `${st === "plex" ? "Plex" : st === "jellyfin" ? "Jellyfin" : "Emby"}${tbl}`;
    const keyCol = st === "plex" ? "Key" : "ItemId";
    try { const k = db.prepare(`SELECT ${keyCol} v FROM ${keyTbl} WHERE Id=?`).get(itemId) as any; key = k?.v ?? null; } catch { key = null; }
  }
  return { itemId, kind, versionId: r.versionId, path: r.path, libraryId: r.libraryId, sourceId: r.sourceId, sourceType: st, key };
}

export async function runDeepScan(
  dbPath: string, type: string, id: number,
  opts: { ffprobePath?: string; fetcher?: Fetcher; secretFor: (sourceId: number) => { token: string; address: string | null }; onEvent?: (e: DeepScanEvent) => void }
): Promise<DeepScanSummary> {
  const t0 = Date.now();
  const emit = opts.onEvent ?? (() => {});
  const ffprobePath = opts.ffprobePath ?? "ffprobe";
  const db = openRW(dbPath);
  let refreshed = 0, failed = 0, chapters = 0;
  try {
    const targets = targetItems(db, type, id);
    const ctxs = targets.map((t) => contextFor(db, t.itemId, t.kind)).filter((c): c is Ctx => !!c);
    emit({ phase: "start", total: ctxs.length });

    // group remote items by (sourceId, libraryId, kind); locals handled directly
    const remoteGroups = new Map<string, Ctx[]>();
    const locals: Ctx[] = [];
    for (const c of ctxs) {
      if (c.sourceType === "local") locals.push(c);
      else if (c.key) { const g = `${c.sourceId}|${c.libraryId}|${c.kind}`; (remoteGroups.get(g) ?? remoteGroups.set(g, []).get(g)!).push(c); }
    }

    let done = 0;
    // locals: re-ffprobe each file
    for (const c of locals) {
      if (c.path) {
        const r = reprobeLocalVersion(db, c.versionId, c.itemId, c.path, ffprobePath);
        if (r.ok) { refreshed++; chapters += r.chapters; } else failed++;
      } else failed++;
      done++; if (done % 5 === 0 || done === ctxs.length) emit({ phase: "scanning", done, total: ctxs.length });
    }

    // remote groups: fetch full detail per item, then force-upsert into the library
    for (const [g, group] of remoteGroups) {
      const [sid] = g.split("|").map(Number);
      const info = readSourceInfo(dbPath, sid);
      const secret = opts.secretFor(sid);
      const candidates = info ? [...new Set([secret.address, ...info.addresses, info.address].filter(Boolean) as string[])] : [];
      let address: string | null = null;
      if (info && candidates.length && secret.token) {
        try { address = await pickReachableAddress(info.type, candidates, secret.token, () => {}); } catch { address = null; }
      }
      if (!info || !address || !secret.token) { failed += group.length; done += group.length; emit({ phase: "scanning", done, total: ctxs.length }); continue; }
      const items: RemoteItem[] = [];
      try {
        if (info.type === "plex") {
          for (const c of group) { const it = await fetchPlexItemFull(address, secret.token, c.key!, opts.fetcher ?? defaultRemoteFetcher()); if (it) items.push(it); done++; if (done % 3 === 0) emit({ phase: "scanning", done, total: ctxs.length, current: it?.title }); }
        } else {
          const fetched = await fetchJellyfinByIds(address, secret.token, group.map((c) => c.key!), opts.fetcher ?? defaultRemoteFetcher());
          items.push(...fetched); done += group.length; emit({ phase: "scanning", done, total: ctxs.length });
        }
        // Fallback: if the provider returned no chapters for an item but its file
        // is reachable (via path replacements), ffprobe the file directly — its
        // embedded chapters are ground truth, independent of Plex's chapter
        // analysis. This is what "the file has chapters but Plex/deep-scan didn't
        // find them" needs.
        for (const it of items) {
          if ((it.chapters?.length ?? 0) > 0) continue;
          const local = applyReplacements(it.path, info.pathReplacements);
          if (local && existsSync(local)) {
            try { const ch = ffprobeChapters(ffprobePath, local); if (ch.length) it.chapters = ch; } catch { /* unreadable file */ }
          }
        }
        const kind = group[0].kind, libraryId = group[0].libraryId;
        const s = upsertRemoteLibrary(db, info.type as ProviderType, { libraryId, kind, providerKey: "", name: "" }, items, info.pathReplacements, { skipMissing: true });
        refreshed += s.added + s.updated;
        for (const it of items) chapters += it.chapters?.length ?? 0;
      } catch { failed += group.length; }
    }
    emit({ phase: "done", done: ctxs.length, total: ctxs.length });
    return { targets: ctxs.length, refreshed, failed, chapters, ms: Date.now() - t0 };
  } finally { db.close(); }
}

function defaultRemoteFetcher(): Fetcher {
  return async (url, headers) => {
    const r = await fetch(url, { headers });
    const body = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    return body ? JSON.parse(body) : {};
  };
}
