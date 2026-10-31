// -----------------------------------------------------------------------------
// Programme poster refs: "art://{sourceId}/{type}/{base64url(providerKey)}" (made
// by the resolver; token-free) -> the media server's image URL. Used by the guide
// channel (directly) and by the scheduler's public /art/… route.
//
// Keys are validated strictly so a ref can only ever name an item's poster —
// never another media-server path — since /art/… is reachable from outside.
// -----------------------------------------------------------------------------
export type ArtProvider = "plex" | "jellyfin" | "emby";
export interface ArtRef { sourceId: string; type: ArtProvider; key: string }

export function parseArtRef(ref: string): ArtRef | null {
  const m = /^art:\/\/(\d+)\/(plex|jellyfin|emby)\/([A-Za-z0-9_-]+)$/.exec(ref);
  if (!m) return null;
  let key = "";
  try { key = Buffer.from(m[3], "base64url").toString("utf8"); } catch { return null; }
  return { sourceId: m[1], type: m[2] as ArtProvider, key };
}

/** The item's poster path on its media server (no address/token), or null if the
 *  key isn't a plain item key. Plex keys are "/library/metadata/{id}" (movies,
 *  episodes) or ".../{id}/children" (shows); Jellyfin/Emby keys are item ids. */
export function artPosterPath(type: ArtProvider, key: string): string | null {
  if (type === "plex") {
    const m = /^\/library\/metadata\/(\d+)(?:\/children)?\/?$/.exec(key);
    return m ? `/library/metadata/${m[1]}/thumb` : null;
  }
  // Jellyfin ids are 32 hex (or a dashed GUID); Emby's are numbers
  return /^(?:[0-9A-Fa-f-]{32,36}|\d{1,12})$/.test(key) ? `/Items/${key}/Images/Primary` : null;
}

/** Full image URL (with the token) for a ref, given its source's address + token. */
export function artImageUrl(ref: ArtRef, address: string, token: string): string | null {
  const path = artPosterPath(ref.type, ref.key);
  if (!path) return null;
  const auth = ref.type === "plex" ? `X-Plex-Token=${encodeURIComponent(token)}` : `api_key=${encodeURIComponent(token)}`;
  return `${address.replace(/\/+$/, "")}${path}?${auth}`;
}
