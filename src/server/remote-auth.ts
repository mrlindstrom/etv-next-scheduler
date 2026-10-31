// Native sign-in for remote sources, so the user never has to hand-copy a token.
//
//  * Plex   — the plex.tv PIN ("Plex OAuth") flow: create a PIN, send the user to
//             Plex's own auth page, then poll until Plex hands us an authToken.
//  * Jellyfin / Emby — username + password against /Users/AuthenticateByName,
//             which returns an AccessToken we store as the source token.
//
// The HTTP layer is injectable (`Http`) so the flow logic is testable offline.

export const PRODUCT = "tv-next-scheduler";
// Override only for testing; defaults to the real Plex cloud API.
const PLEX_BASE = process.env.PLEX_BASE ?? "https://plex.tv/api/v2";

export type Http = (url: string, init?: any) => Promise<any>;
export const defaultHttp: Http = async (url, init) => {
  const r = await fetch(url, init);
  const body = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
  return body ? JSON.parse(body) : {};
};

function plexHeaders(clientId: string): Record<string, string> {
  return {
    Accept: "application/json",
    "X-Plex-Product": PRODUCT,
    "X-Plex-Version": "1.0",
    "X-Plex-Client-Identifier": clientId,
    "X-Plex-Device": "server",
    "X-Plex-Device-Name": PRODUCT,
    "X-Plex-Platform": "Node",
  };
}

export interface PlexPin { id: number; code: string; clientId: string; authUrl: string; }

/** Step 1: ask Plex for a PIN and build the URL the user should open to authorize. */
export async function plexCreatePin(clientId: string, http: Http = defaultHttp, base = PLEX_BASE): Promise<PlexPin> {
  const r = await http(`${base}/pins?strong=true`, { method: "POST", headers: plexHeaders(clientId) });
  const id = Number(r.id);
  const code = String(r.code);
  // Plex's hosted auth page; forwardUrl is optional (we poll instead of redirect).
  const q =
    `clientID=${encodeURIComponent(clientId)}` +
    `&code=${encodeURIComponent(code)}` +
    `&context%5Bdevice%5D%5Bproduct%5D=${encodeURIComponent(PRODUCT)}`;
  const authUrl = `https://app.plex.tv/auth#?${q}`;
  return { id, code, clientId, authUrl };
}

/** Step 2 (polled): returns the authToken once the user has authorized, else null. */
export async function plexCheckPin(id: number, clientId: string, http: Http = defaultHttp, base = PLEX_BASE): Promise<string | null> {
  const r = await http(`${base}/pins/${id}`, { method: "GET", headers: plexHeaders(clientId) });
  return r.authToken ? String(r.authToken) : null;
}

/** Jellyfin / Emby: username + password -> AccessToken. */
export async function mediaBrowserLogin(address: string, username: string, password: string, deviceId: string, http: Http = defaultHttp): Promise<string> {
  const base = address.replace(/\/+$/, "");
  const authHeader = `MediaBrowser Client="${PRODUCT}", Device="server", DeviceId="${deviceId}", Version="1.0"`;
  const r = await http(`${base}/Users/AuthenticateByName`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-Emby-Authorization": authHeader, Authorization: authHeader },
    body: JSON.stringify({ Username: username, Pw: password }),
  });
  if (!r.AccessToken) throw new Error("Authentication succeeded but no AccessToken was returned");
  return String(r.AccessToken);
}
