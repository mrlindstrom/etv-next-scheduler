// Pick overlays from the library (chips + an "Add overlay" dropdown), with a way
// to the designer. Used by Channel settings, schedule blocks and grid shows.
import { useEffect, useState } from "react";
import { api, type Overlay } from "./api.js";
import { navigate } from "./nav.js";

// shared for a few seconds only (a page full of pickers asks once); after that,
// and after any overlay is saved or deleted, the list is fetched fresh
let cache: { at: number; list: Promise<Overlay[]> } | null = null;
export const refreshOverlayList = () => { cache = null; };
const loadOverlays = () => {
  if (!cache || Date.now() - cache.at > 5000) cache = { at: Date.now(), list: api.overlays().then((r) => r.overlays).catch(() => { cache = null; return []; }) };
  return cache.list;
};

export function OverlayPicker({ value, onChange, empty = "None" }: { value: string[]; onChange: (v: string[]) => void; empty?: string }) {
  const [all, setAll] = useState<Overlay[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => loadOverlays().then((l) => live && setAll(l));
    load();
    // coming back from the designer in another tab: pick up new overlays
    const onFocus = () => { refreshOverlayList(); load(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("tvn:overlays-changed", onFocus);
    return () => { live = false; window.removeEventListener("focus", onFocus); window.removeEventListener("tvn:overlays-changed", onFocus); };
  }, []);
  const byId = new Map((all ?? []).map((o) => [o.id, o]));
  const rest = (all ?? []).filter((o) => !value.includes(o.id));
  return (
    <div className="ov-picker">
      {!value.length && <span className="muted">{empty}</span>}
      {value.map((id) => (
        <span key={id} className="chip">{byId.get(id)?.name ?? `${id} (deleted)`}<button type="button" title="Remove" onClick={() => onChange(value.filter((x) => x !== id))}>✕</button></span>
      ))}
      {all && (rest.length > 0 ? (
        <select style={{ width: "auto" }} value="" onChange={(e) => { if (e.target.value) onChange([...value, e.target.value]); }}>
          <option value="">+ Add overlay…</option>
          {rest.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      ) : null)}
      <a href="#" onClick={(e) => { e.preventDefault(); navigate("overlays"); }} style={{ fontSize: 12 }}>{all?.length ? "Design overlays →" : "Make an overlay →"}</a>
    </div>
  );
}
