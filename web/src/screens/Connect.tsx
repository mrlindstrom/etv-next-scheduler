import { useEffect, useState } from "react";
import { api, type AppConfig, type VerifyResult } from "../api.js";
import { SchedulerUpdates } from "./SchedulerUpdates.js";

export function Connect({ config, onSaved }: { config: AppConfig | null; onSaved: (c: AppConfig) => void }) {
  const [form, setForm] = useState<AppConfig>(config ?? { etvDbPath: "", channelsDir: "channels", outputDir: "playouts", timeZone: "", days: 3, autoBuild: false, buildIntervalMin: 60, refreshThresholdHours: 24, prunePast: true, includeSpecials: false, autoScanHours: 0, keepNextRunning: false, legacyImport: true });
  // the page can open before the saved config has loaded: fill the form once it arrives
  // (otherwise "Save" would write the empty defaults over the real settings)
  const [loaded, setLoaded] = useState(!!config);
  useEffect(() => { if (config && !loaded) { setForm(config); setLoaded(true); } }, [config, loaded]);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const upd = (k: keyof AppConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: k === "days" ? Number(e.target.value) : e.target.value });

  const [saveErr, setSaveErr] = useState("");
  const errText = (e: unknown) => { const t = String((e as Error).message ?? e); try { return JSON.parse(t).error ?? t; } catch { return t; } };
  const save = async () => {
    setBusy(true); setSaveErr("");
    try { const c = await api.setConfig(form); onSaved(c); setSaved(true); setTimeout(() => setSaved(false), 1500); }
    catch (e) { setSaveErr(errText(e)); }
    setBusy(false);
  };
  const zones = (() => { try { return (Intl as any).supportedValuesOf("timeZone") as string[]; } catch { return []; } })();
  const zoneChanged = loaded && (config?.timeZone ?? "") !== form.timeZone;
  // the legacy-import switch saves on its own (it's not part of the path/folder form)
  const [importMsg, setImportMsg] = useState("");
  const setLegacyImport = async (on: boolean) => {
    const c = await api.setConfig({ legacyImport: on }); setForm({ ...form, legacyImport: c.legacyImport }); onSaved(c);
    setImportMsg(on ? "Import tools are back on the Library and Channels tabs." : "Import tools hidden. Turn this back on if you ever need to re-import.");
  };
  const setSpecials = async (on: boolean) => { const c = await api.setConfig({ includeSpecials: on }); setForm({ ...form, includeSpecials: c.includeSpecials }); onSaved(c); };
  const doVerify = async () => { setBusy(true); setVerify(null); try { await api.setConfig(form); onSaved(form); setVerify(await api.verify(form.etvDbPath)); } catch (e) { setVerify({ ok: false, error: String(e) }); } setBusy(false); };

  return (
    <section className="screen">
      <h1>Settings</h1>
      <p className="muted">Your ErsatzTV legacy database (opened <b>read-only</b>), folders and build defaults. Settings are stored in this app's own database.</p>

      <div className="form">
        <label>ErsatzTV database path
          <input value={form.etvDbPath} onChange={upd("etvDbPath")} placeholder="/path/to/ersatztv.sqlite3 or C:\\ProgramData\\ErsatzTV\\ersatztv.sqlite3" />
        </label>
        <div className="row">
          <label>Channels folder<input value={form.channelsDir} onChange={upd("channelsDir")} /></label>
          <label>Output folder<input value={form.outputDir} onChange={upd("outputDir")} /></label>
        </div>
        <div className="row">
          <label title="Grids, dayparts and the guide follow this zone's wall clock, daylight saving included">Time zone
            <input value={form.timeZone} onChange={upd("timeZone")} list="tz-list" placeholder={`${String(config?.tz ?? "")} (this machine)`} />
            <datalist id="tz-list">{zones.map((z) => <option key={z} value={z} />)}</datalist>
          </label>
          <label>Days to build<input type="number" value={form.days} onChange={upd("days")} /></label>
        </div>
        <p className="muted" style={{ margin: "0 0 10px", fontSize: 12 }}>
          Leave the time zone blank to use this machine's. Schedules stay on the wall clock across daylight saving: on fall-back night the 1 AM hour plays twice,
          on spring-forward night the skipped hour's slots don't air.
          {zoneChanged && <> <b>After saving a new zone, rebuild all channels on the Build page</b> ("Rebuild from scratch") so already-built days move too.</>}
        </p>
        <div className="actions">
          <button className="primary" onClick={doVerify} disabled={busy || !loaded || !form.etvDbPath}>{busy ? "Verifying…" : "Verify & save"}</button>
          <button onClick={save} disabled={busy || !loaded}>Save only</button>
          {saved && <span className="ok">Saved ✓</span>}
          {saveErr && <span className="err">{saveErr}</span>}
        </div>
      </div>

      <div className="meta-card" style={{ marginTop: 18 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>Scheduling</div>
        <label className="switch"><input type="checkbox" checked={!!form.includeSpecials} onChange={(e) => setSpecials(e.target.checked)} /> Include specials (Season 0 episodes) when scheduling shows</label>
        <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>Off by default, so specials are skipped. A content definition can still opt in with <code>include_specials: true</code>. Applies from the next build.</p>
      </div>

      <SchedulerUpdates config={config} onSaved={onSaved} />

      <div className="meta-card" style={{ marginTop: 18 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>ErsatzTV legacy import</div>
        <p className="muted" style={{ fontSize: 13, margin: "0 0 8px" }}>
          The one-time migration tools: <b>Import from ErsatzTV</b> on the Library page (copies the legacy media library) and
          <b> Import…</b> on the Channels page (brings over channels and their schedules). Once you've migrated, turn this off so a
          re-import can't replace your library — including collections, scans and metadata changes made here — or overwrite channels.
        </p>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, width: "auto" }}>
          <input type="checkbox" style={{ width: "auto" }} checked={form.legacyImport !== false} onChange={(e) => setLegacyImport(e.target.checked)} />
          {form.legacyImport !== false ? "On — import tools available" : "Off — migration finished, import tools hidden"}
        </label>
        {importMsg && <div className="ok" style={{ fontSize: 12, marginTop: 6 }}>{importMsg}</div>}
      </div>

      {verify && (
        <div className={`verify ${verify.ok ? "good" : "bad"}`}>
          {verify.error && <div className="bad">✗ {verify.error}</div>}
          {!verify.error && (
            <>
              <div className="status">{verify.ok ? "✓ Database looks good" : "⚠ Schema issues found"}</div>
              {verify.problems && verify.problems.length > 0 && <ul>{verify.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
              {verify.stats && (
                <div className="stats">
                  <Stat n={verify.stats.mediaItems} label="media items" />
                  <Stat n={verify.stats.episodes} label="episodes" />
                  <Stat n={verify.stats.shows} label="shows" />
                  <Stat n={verify.stats.chapters} label="with chapters" hint="mid-roll candidates" />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Stat({ n, label, hint }: { n: number; label: string; hint?: string }) {
  return <div className="stat"><div className="num">{n.toLocaleString()}</div><div className="lbl">{label}</div>{hint && <div className="hint">{hint}</div>}</div>;
}
