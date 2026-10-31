import { useEffect, useState } from "react";
import { api } from "./api.js";

type Mode = "" | "black" | "standby" | "image";
const modeOf = (v: string): Mode => (v === "" || v === "black" || v === "standby" ? v : "image");

/**
 * Picks what a channel shows when it has nothing to play (a gap, or an item that
 * fails): black, a "We'll be right back" card, or an image file, with a preview.
 * `defaultLabel` adds a "Default (…)" choice whose value is "" (per-channel use).
 */
export function FallbackPicker({ value, onChange, channel, defaultLabel }: { value: string; onChange: (v: string) => void; channel: string; defaultLabel?: string }) {
  const [mode, setMode] = useState<Mode>(modeOf(value));
  // follow the saved value (switching channels), but stay on "image" while its path is still empty
  useEffect(() => { setMode((m) => (value === "" && m === "image" ? m : modeOf(value))); }, [value]);
  const [preview, setPreview] = useState<{ url?: string; note?: string; black?: boolean }>({});

  // preview what the setting shows (debounced while a path is typed)
  useEffect(() => {
    let url: string | undefined, dead = false;
    const t = window.setTimeout(async () => {
      if (mode === "image" && !value.trim()) { setPreview({ note: "Enter the full path to a PNG or JPEG on this machine." }); return; }
      try {
        const r = await fetch(api.fallbackPreviewUrl(channel, value));
        if (dead) return;
        if (r.status === 204) setPreview({ black: true });
        else if (r.ok) { url = URL.createObjectURL(await r.blob()); setPreview({ url }); }
        else setPreview({ note: r.status === 404 ? "⚠ Not found on this machine, so the channel shows black. Fix the path, then Apply." : r.status === 415 ? "⚠ That file isn't an image." : ((await r.json().catch(() => null))?.error ?? "Couldn't draw the preview.") });
      } catch { /* server unreachable */ }
    }, mode === "image" ? 400 : 0);
    return () => { dead = true; clearTimeout(t); if (url) URL.revokeObjectURL(url); };
  }, [mode, value, channel]);

  const pick = (m: Mode) => { setMode(m); onChange(m === "image" ? "" : m); };
  return (
    <div className="fallback-picker">
      <div className="row">
        <label>When there's nothing to play
          <select value={mode} onChange={(e) => pick(e.target.value as Mode)}>
            {defaultLabel && <option value="">Default ({defaultLabel})</option>}
            <option value="black">Black screen</option>
            <option value="standby">“We'll be right back” card</option>
            <option value="image">An image file</option>
          </select>
        </label>
        {mode === "image" && (
          <label style={{ flex: 2 }}>Image file
            <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={"C:\\Pictures\\standby.png"} />
          </label>
        )}
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", margin: "4px 0 6px" }}>
        {(preview.url || preview.black) && (
          <div style={{ position: "relative", width: 192, height: 108, flex: "none", background: "#000", borderRadius: 6, overflow: "hidden", border: "1px solid var(--line)", display: "grid", placeItems: "center" }}>
            {preview.url ? <img src={preview.url} alt="Fallback preview" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }} /> : <span className="muted" style={{ fontSize: 11 }}>black</span>}
          </div>
        )}
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          {preview.note && <span className={preview.note.startsWith("⚠") ? "err" : ""}>{preview.note} </span>}
          Shown, silent, when the schedule has a gap or an item can't play (e.g. a missing file).
          {mode === "standby" && " The card uses the channel's logo and name."}
          {" "}Needs ErsatzTV next 0.2.4 or newer. Click <b>Apply</b> on the Streaming page (or restart ErsatzTV next) for a change to take effect.
        </p>
      </div>
    </div>
  );
}
