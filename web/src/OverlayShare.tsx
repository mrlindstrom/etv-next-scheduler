// Sharing overlays with other people: an overlay pack (*.overlays.json) holds
// overlays plus every image, video, picture and font they use (server:
// src/server/overlay-share.ts).
//   - SharePanel: pick overlays and download them as a pack
//   - ImportResult: what a pack brought in, with a way to open each overlay
//   - downloadPack / readError: shared with the designer's Export button
import { useState } from "react";
import { api, type Overlay } from "./api.js";

/** The server's message out of a failed request ({"error": "..."}), else the text. */
export function readError(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  try { return JSON.parse(m).error || m; } catch { return m; }
}

/** Export overlays and save the pack to the browser's downloads. Returns the notes. */
export async function downloadPack(ids: string[]): Promise<{ fileName: string; notes: string[] }> {
  const r = await api.exportOverlays(ids);
  const url = URL.createObjectURL(new Blob([JSON.stringify(r.pack)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = r.fileName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return { fileName: r.fileName, notes: r.notes };
}

export function SharePanel({ list, onClose }: { list: Overlay[]; onClose: () => void }) {
  const shareable = list.filter((o) => !o.legacy);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(shareable.map((o) => o.id)));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ fileName: string; notes: string[] } | null>(null);
  const [err, setErr] = useState("");
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const go = async () => {
    setBusy(true); setErr(""); setDone(null);
    try { setDone(await downloadPack([...picked])); } catch (e) { setErr(readError(e)); } finally { setBusy(false); }
  };
  return (
    <div className="meta-card" style={{ marginBottom: 14 }}>
      <div className="pane-head"><b>Share overlays</b><button className="ghost" onClick={onClose}>Close</button></div>
      <p className="muted" style={{ margin: "2px 0 10px", fontSize: 13 }}>
        Pick the overlays to share. They download as one <code>.overlays.json</code> file with every image, video, picture and added font they use,
        ready to post for others. Anyone with the scheduler brings it in with <b>Import overlays…</b> on this page.
      </p>
      {!shareable.length ? <p className="muted">There's nothing to share yet: ErsatzTV legacy elements can't be shared this way.</p> : (
        <>
          <div className="row" style={{ gap: 6, marginBottom: 6 }}>
            <button className="ghost" onClick={() => setPicked(new Set(shareable.map((o) => o.id)))}>Select all</button>
            <button className="ghost" onClick={() => setPicked(new Set())}>Select none</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "2px 14px", marginBottom: 10 }}>
            {shareable.map((o) => (
              <label key={o.id} className="row" style={{ gap: 6, fontSize: 13 }}>
                <input type="checkbox" style={{ width: "auto" }} checked={picked.has(o.id)} onChange={() => toggle(o.id)} />
                {o.name}
              </label>
            ))}
          </div>
          <button className="primary" onClick={go} disabled={busy || !picked.size}>
            {busy ? "Packing…" : `Download ${picked.size} overlay${picked.size === 1 ? "" : "s"}`}
          </button>
        </>
      )}
      {err && <p className="err">{err}</p>}
      {done && <Notes ok={`Saved ${done.fileName} to your downloads. Share that file: it has everything the overlays need.`} notes={done.notes} />}
    </div>
  );
}

export function ImportResult({ result, onOpen, onClose }: { result: { imported: { id: string; name: string }[]; notes: string[] }; onOpen: (id: string) => void; onClose: () => void }) {
  const n = result.imported.length;
  return (
    <div className="meta-card" style={{ marginBottom: 14 }}>
      <div className="pane-head"><b>{n ? `Brought in ${n} overlay${n === 1 ? "" : "s"}` : "Nothing was brought in"}</b><button className="ghost" onClick={onClose}>Close</button></div>
      {n > 0 && (
        <>
          <p className="muted" style={{ margin: "2px 0 8px", fontSize: 13 }}>
            Their images, pictures and fonts are in place. Next: open one to check it, then turn it on for your channels under <b>Show on channels</b> and rebuild them.
          </p>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {result.imported.map((o) => <button key={o.id} onClick={() => onOpen(o.id)}>Open {o.name} →</button>)}
          </div>
        </>
      )}
      <Notes notes={result.notes} />
    </div>
  );
}

function Notes({ ok, notes }: { ok?: string; notes: string[] }) {
  return (
    <>
      {ok && <p className="ok" style={{ margin: "8px 0 0" }}>{ok}</p>}
      {notes.length > 0 && (
        <ul className="muted" style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13 }}>
          {notes.map((t, i) => <li key={i}>{t}</li>)}
        </ul>
      )}
    </>
  );
}
