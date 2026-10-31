// Channel-number rules (server side). The web UI mirrors these in
// web/src/channelNumbers.ts.

/** Canonical form for uniqueness: each dot part as a number ("02" == "2",
 *  "2.10" != "2.1"). Non-numeric numbers compare as text. */
export function normalizeChannelNumber(n: string | null | undefined): string {
  const s = String(n ?? "").trim();
  if (!s) return "";
  const parts = s.split(".");
  return parts.every((p) => /^\d+$/.test(p)) ? parts.map((p) => String(Number(p))).join(".") : s.toLowerCase();
}

/** First free "N.1", "N.2", … (or 1, 2, … for non-numeric) not in `used`. */
export function suggestChannelNumber(number: string, used: Set<string>): string {
  const base = normalizeChannelNumber(number).split(".")[0];
  if (/^\d+$/.test(base)) for (let i = 1; i < 1000; i++) { const c = `${base}.${i}`; if (!used.has(normalizeChannelNumber(c))) return c; }
  for (let i = 1; ; i++) if (!used.has(String(i))) return String(i);
}

/** Channel order: part by part as numbers ("2.2" < "2.10" < "10"); blank or
 *  non-numeric numbers last. */
export function compareChannelNumbers(a: string, b: string): number {
  const pa = (a ?? "").trim().split(".").map(Number), pb = (b ?? "").trim().split(".").map(Number);
  const ba = !(a ?? "").trim() || pa.some((n) => !Number.isFinite(n));
  const bb = !(b ?? "").trim() || pb.some((n) => !Number.isFinite(n));
  if (ba || bb) return ba === bb ? 0 : ba ? 1 : -1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d) return d;
  }
  return 0;
}
