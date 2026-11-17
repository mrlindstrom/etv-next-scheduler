// -----------------------------------------------------------------------------
// Emergency alerts: what's shared between the scheduler (eas.ts: polls the
// National Weather Service, writes the state file) and the alert stream process
// (eas-stream.ts: turns the state file into the live overlay next composites).
// -----------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The alert stream's code, as a hash: the scheduler replaces a stream process
 *  started from older code (it outlives scheduler restarts and updates). */
export function streamVersion(): string {
  const h = createHash("sha1");
  for (const f of ["./eas-stream.js", "./eas-alerts.js"]) { try { h.update(readFileSync(fileURLToPath(new URL(f, import.meta.url)))); } catch { h.update(f); } }
  return h.digest("hex").slice(0, 12);
}

/** Alert settings (the "easConfig" setting). */
export interface EasConfig {
  enabled: boolean;
  /** where alerts are checked for (a point; NWS finds the zones and counties around it) */
  lat: number | null;
  lon: number | null;
  /** the place name NWS gave for the point, shown on the page */
  place: string;
  /** the least severe alert that goes on screen */
  minSeverity: "Extreme" | "Severe" | "Moderate" | "Minor";
  /** how often NWS is asked (seconds) */
  pollSec: number;
  /** where the banner sits */
  position: "bottom" | "top";
  /** seconds each alert stays up when several are active */
  rotateSec: number;
  /** like a weather crawl: on for showSec as soon as an alert starts, then off for hideSec,
   *  repeating until it ends (hideSec 0 = on the whole time) */
  showSec: number;
  hideSec: number;
  /** optional contact (email or site) sent to NWS in the User-Agent, as they ask */
  contact: string;
  /** the alert stream port; 0 = the scheduler's port + 5 */
  streamPort: number;
  /** keep the alert stream running after alerts are turned off (built channels still use it until rebuilt) */
  keepStream: boolean;
}

export const EAS_DEFAULTS: EasConfig = {
  enabled: false, lat: null, lon: null, place: "", minSeverity: "Severe", pollSec: 60, position: "bottom", rotateSec: 12,
  showSec: 60, hideSec: 300, contact: "", streamPort: 0, keepStream: false,
};

export const SEVERITIES = ["Extreme", "Severe", "Moderate", "Minor"] as const;
export const severityRank = (s: string): number => { const i = SEVERITIES.indexOf(s as any); return i < 0 ? SEVERITIES.length : i; };

/** Civil alerts officials send through NWS (AMBER, evacuations, shelter in place…). They
 *  often come with severity "Unknown", so they're shown whatever the severity setting. */
const CIVIL = /civil (emergency|danger)|shelter in place|evacuation|law enforcement|child abduction|blue alert|hazardous materials|radiological|nuclear power|911 telephone|local area emergency/i;
export const isCivil = (event: string): boolean => CIVIL.test(event);

/** Whether an alert passes the severity setting: civil alerts always do, and "Unknown"
 *  (or a missing severity) counts as the least severe, so "everything" includes it. */
export const passesSeverity = (event: string, severity: string, min: string): boolean =>
  isCivil(event) || (severityRank(severity) < SEVERITIES.length ? severityRank(severity) <= severityRank(min) : severityRank(min) === SEVERITIES.length - 1);

/** One alert as the card draws it (display-ready: times already in the scheduler's zone). */
export interface AlertCard {
  id: string;
  event: string;      // "Tornado Warning"
  severity: string;   // Extreme / Severe / Moderate / Minor / Unknown
  area: string;       // "Dallas, TX; Tarrant, TX"
  until: string;      // "until 9:45 PM" ("" when open-ended)
  headline: string;   // one or two sentences
  test?: boolean;
}

/** The state file the alert stream reads. */
export interface EasState {
  alerts: AlertCard[];
  position: "bottom" | "top";
  rotateSec: number;
  /** the on/off cycle (EasConfig), counted from cycleStart: when the newest alert came in */
  showSec?: number;
  hideSec?: number;
  cycleStart?: number;
  updatedAt: number;
}

/** Whether alerts are on screen at time `at`. Missing settings (a state file written by an
 *  older scheduler) mean the defaults, not "on the whole time". */
export function cycleOn(s: Pick<EasState, "showSec" | "hideSec" | "cycleStart">, at: number): boolean {
  const show = (s.showSec ?? EAS_DEFAULTS.showSec) * 1000, hide = (s.hideSec ?? EAS_DEFAULTS.hideSec) * 1000, t = at - (s.cycleStart ?? 0);
  if (hide <= 0) return true;
  return t >= 0 && t % (show + hide) < show;
}

/** Banner height for an output size (the layer is the banner, not the whole frame). */
export const bannerHeight = (h: number) => Math.max(120, Math.round(h * 0.3) & ~1);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Break text into lines that fit `maxChars` (an estimate from the font size), at most `maxLines`. */
function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= maxChars) cur += " " + w;
    else { lines.push(cur); cur = w; if (lines.length === maxLines) break; }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = (last.length > maxChars - 1 ? last.slice(0, maxChars - 1) : last).replace(/[\s,.;:]+$/, "") + "…";
  }
  return lines;
}

const FONT = `Arial, Helvetica, "Liberation Sans", "DejaVu Sans", sans-serif`;

/** The alert banner as SVG, `w` × `bannerHeight(h)`. `index`/`count` number the alerts when several rotate. */
export function alertCardSvg(a: AlertCard, w: number, h: number, index = 0, count = 1): string {
  const bh = bannerHeight(h);
  const u = bh / 324; // drawn for a 1080p banner, scaled
  const pad = Math.round(36 * u);
  const headH = Math.round(84 * u);
  const titleSize = Math.round(46 * u), metaSize = Math.round(30 * u), bodySize = Math.round(34 * u);
  const red = a.severity === "Extreme" || a.severity === "Severe" || a.test || isCivil(a.event) ? "#c1121f" : "#d97706";
  const label = a.test ? "TEST · EMERGENCY ALERT SYSTEM" : "EMERGENCY ALERT";
  const counter = count > 1 ? `${index + 1} of ${count}` : "";
  const charsPerLine = Math.max(20, Math.floor((w - pad * 2) / (bodySize * 0.5)));
  const body = wrap(a.headline, charsPerLine, 3);
  const meta = [a.area, a.until].filter(Boolean).join(" · ");
  const metaLine = wrap(meta, Math.floor((w - pad * 2) / (metaSize * 0.5)), 1)[0] ?? "";
  const y0 = headH + Math.round(52 * u);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${bh}" viewBox="0 0 ${w} ${bh}">
<rect x="0" y="0" width="${w}" height="${bh}" fill="#0b0f19" fill-opacity="0.92"/>
<rect x="0" y="0" width="${w}" height="${headH}" fill="${red}"/>
<text x="${pad}" y="${Math.round(headH * 0.68)}" font-family='${FONT}' font-size="${titleSize}" font-weight="bold" fill="#ffffff">${esc(`${label}: ${a.event.toUpperCase()}`)}</text>
${counter ? `<text x="${w - pad}" y="${Math.round(headH * 0.66)}" font-family='${FONT}' font-size="${metaSize}" fill="#ffffff" text-anchor="end">${esc(counter)}</text>` : ""}
<text x="${pad}" y="${y0}" font-family='${FONT}' font-size="${metaSize}" font-weight="bold" fill="#fbbf24">${esc(metaLine)}</text>
${body.map((l, i) => `<text x="${pad}" y="${y0 + Math.round((48 + i * 44) * u)}" font-family='${FONT}' font-size="${bodySize}" fill="#f1f5f9">${esc(l)}</text>`).join("\n")}
</svg>`;
}

/** The test alert (Emergency alerts → Show a test alert). */
export function testCard(untilText: string): AlertCard {
  return {
    id: "test", test: true, event: "Test", severity: "Severe", area: "This is only a test", until: untilText,
    headline: "This is a test of the emergency alert overlay. If this had been an actual emergency, the alert for your area would be shown here.",
  };
}
