// Import channels + Classic/Block schedules from ErsatzTV legacy, as a guided workflow:
//   1. Choose — the server's read-only plan, with a content check per channel
//      (would it air anything? if not, why, and which fix to run)
//   2. Import — write the selected channels
//   3. Next steps — build their playouts, publish the lineup to ErsatzTV next,
//      and fix anything that would air nothing (each with a button to do it)
import { useEffect, useMemo, useRef, useState } from "react";
import { api, legacyLogoSrc, type LegacyChannelPlan, type ContentFix, type BuildJob } from "../api.js";
import { normalizeChannelNumber, suggestChannelNumber } from "../channelNumbers.js";

const STATUS_LABEL: Record<LegacyChannelPlan["status"], string> = { new: "new", exists: "already exists", unsupported: "can't import" };
const FIX: Record<Exclude<ContentFix, null>, { button: string; tab: string; how: string }> = {
  "refresh-metadata": { button: "Scan library", tab: "library", how: "On the Library page, click Scan on the library these items are in (e.g. Movies). Scans fill in cast, crew and ratings for older items, up to 5,000 per scan — the scan status says if more remain. Then build these channels again." },
  "scan-source": { button: "Scan source", tab: "library", how: "On the Library page, open your Plex/Jellyfin source and click Scan source so the show gets matched to its external id. Then build these channels again." },
  "enable-library": { button: "Enable library", tab: "library", how: "Its media is only in libraries that are switched off for scheduling. On the Library page, turn those libraries back on (or pick different content for the channel), then build these channels again." },
  "import-library": { button: "Re-import library", tab: "library", how: "The collection was created in legacy after your library import. Re-import the library on the Library page (or recreate the collection), then build these channels again." },
};
const link = { background: "none", border: "none", color: "#3b82f6", cursor: "pointer", padding: 0 } as const;

type Props = { onImported: (names: string[]) => void; onNavigate: (tab: string) => void; onOpenChannel: (name: string) => void };

export function LegacyImport({ onImported, onNavigate, onOpenChannel }: Props) {
  const [plans, setPlans] = useState<LegacyChannelPlan[] | null>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [also, setAlso] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [overwrite, setOverwrite] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ imported: string[]; skipped: { name: string; reason: string }[] } | null>(null);
  const [usedNumbers, setUsedNumbers] = useState<Record<string, string>>({}); // your channels: normalized number -> name
  const [numbers, setNumbers] = useState<Record<string, string>>({});         // edited numbers, by plan key

  const load = (extra?: string) => {
    setLoading(true); setError("");
    api.legacyChannels(extra).then((r) => {
      if (r.error) { setError(r.error); return; }
      const ch = r.channels ?? [];
      setSources(r.sources ?? []);
      setUsedNumbers(r.usedNumbers ?? {});
      setNumbers({});
      if (extra === undefined) setAlso((r.sources ?? [])[1] ?? "");
      setPlans(ch);
      // pre-select what's new, would actually air something, and has a free number
      setPicked(new Set(ch.filter((p) => p.status === "new" && !p.check?.airsNothing && !p.numberClash).map((p) => p.key)));
    }).catch((e) => setError(String(e))).finally(() => setLoading(false));
  };
  useEffect(() => load(), []);

  const importable = (p: LegacyChannelPlan) => p.status === "new" || (p.status === "exists" && overwrite && !p.caseClash);
  const selected = useMemo(() => (plans ?? []).filter((p) => picked.has(p.key) && importable(p)), [plans, picked, overwrite]);
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // Channel numbers must be unique: against your channels and the other selected ones.
  const numberOf = (p: LegacyChannelPlan) => numbers[p.key] ?? p.number;
  const numberProblem = useMemo(() => {
    const out = new Map<string, string>();
    const claimed = new Map<string, string>(); // selected so far: normalized -> name
    for (const p of selected) {
      const num = numberOf(p).trim(), k = normalizeChannelNumber(num);
      if (!k) { out.set(p.key, "needs a channel number"); continue; }
      const owner = usedNumbers[k];
      if (owner && owner.toLowerCase() !== p.name.toLowerCase()) out.set(p.key, `${num} is used by your channel "${owner}"`);
      else if (claimed.has(k)) out.set(p.key, `${num} is also set for "${claimed.get(k)}"`);
      else claimed.set(k, p.name);
    }
    return out;
  }, [selected, numbers, usedNumbers]);
  // a free number for a row, given everything already used or chosen
  const takenNumbers = (except?: string) => new Set([...Object.keys(usedNumbers), ...selected.filter((p) => p.key !== except).map((p) => normalizeChannelNumber(numberOf(p)))]);
  const suggestFor = (p: LegacyChannelPlan) => suggestChannelNumber(numberOf(p), takenNumbers(p.key));
  /** Give every clashing row (selected, or clashing with your channels) a free number, and select it. */
  const useFreeNumbers = () => {
    const taken = new Set([...Object.keys(usedNumbers)]);
    const next: Record<string, string> = { ...numbers };
    const pick = new Set(picked);
    // keep the rows that already have a good number first, then renumber the rest
    const rows = (plans ?? []).filter((p) => importable(p) && !p.check?.airsNothing && (picked.has(p.key) || p.numberClash));
    const needs: LegacyChannelPlan[] = [];
    for (const p of rows) { const k = normalizeChannelNumber(numberOf(p)); if (k && !taken.has(k)) taken.add(k); else needs.push(p); }
    // suggest from the LEGACY number (12 -> 12.1), not whatever was typed in the row
    for (const p of needs) { const n = suggestChannelNumber(p.number, taken); next[p.key] = n; taken.add(normalizeChannelNumber(n)); pick.add(p.key); }
    setNumbers(next); setPicked(pick);
  };
  // channels you already imported that have a logo in legacy but none here
  const logoless = useMemo(() => (plans ?? []).filter((p) => p.status === "exists" && !p.caseClash && !p.hasLogo && legacyLogoSrc(p)), [plans]);
  const [logoMsg, setLogoMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const bringLogos = async () => {
    setLogoMsg(null);
    try {
      const r = await api.importLegacyLogos(logoless.map((p) => p.name), false, also || undefined);
      if (r.error) { setLogoMsg({ ok: false, text: r.error }); return; }
      setLogoMsg({ ok: true, text: `Added logos to ${r.updated.length} channel${r.updated.length === 1 ? "" : "s"}${r.missing.length ? ` (${r.missing.length} couldn't be read: ${r.missing.join(", ")})` : ""}. Publish the lineup for TV apps to show them.` });
      setPlans((ps) => ps && ps.map((p) => (r.updated.includes(p.name) ? { ...p, hasLogo: true } : p)));
      onImported(r.updated);
    } catch (e) { setLogoMsg({ ok: false, text: String(e) }); }
  };
  // channels you already imported whose legacy watermark isn't on them yet
  const unmarked = useMemo(() => (plans ?? []).filter((p) => p.status === "exists" && !p.caseClash && p.watermark?.file && !p.hasWatermark), [plans]);
  const [wmMsg, setWmMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const bringWatermarks = async () => {
    setWmMsg(null);
    try {
      const r = await api.legacyWatermarks(unmarked.map((p) => p.name), also || undefined);
      if (r.error) { setWmMsg({ ok: false, text: r.error }); return; }
      setWmMsg({ ok: true, text: `Added watermarks to ${r.updated.length} channel${r.updated.length === 1 ? "" : "s"}${r.missing.length ? ` (${r.missing.length} couldn't be read: ${r.missing.join(", ")})` : ""}. They're on the Overlays page, where you can adjust them. Rebuild these channels to see them.` });
      setPlans((ps) => ps && ps.map((p) => (r.updated.includes(p.name) ? { ...p, hasWatermark: true } : p)));
    } catch (e) { setWmMsg({ ok: false, text: String(e) }); }
  };
  const toggleOpen = (id: string) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const run = async () => {
    setBusy(true); setError("");
    try {
      const changed = Object.fromEntries(selected.filter((p) => numberOf(p) !== p.number).map((p) => [p.key, numberOf(p).trim()]));
      const r = await api.importLegacyChannels(selected.map((p) => p.key), overwrite, also || undefined, changed);
      if (r.error) { setError(r.error); return; }
      const names = (r.imported ?? []).map((i) => i.name);
      setResult({ imported: names, skipped: r.skipped ?? [] });
      onImported(names);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  if (error && !plans) return <p className="err">{error}</p>;
  if (!plans) return <p className="muted">Reading the ErsatzTV legacy database and checking each channel against your library…</p>;
  if (result) return <NextSteps result={result} plans={plans} onNavigate={onNavigate} onOpenChannel={onOpenChannel} onMore={() => { setResult(null); load(also || undefined); }} />;

  const n = (f: (p: LegacyChannelPlan) => boolean) => plans.filter(f).length;
  return (
    <div>
      <Step n={1} title="Choose channels">
        Classic schedules become <b>Schedule (blocks)</b> channels and Block schedules become <b>Weekly grid</b> channels, both editable here; YAML playouts are copied as-is.
        Each channel is checked against your library so you can see what it would air. Nothing is written until you import.
      </Step>

      <div className="meta-card" style={{ marginBottom: 10 }}>
        <div className="muted" style={{ fontSize: 12 }}>Legacy database: <code>{sources[0]}</code></div>
        <div className="row" style={{ alignItems: "end" }}>
          <label style={{ flex: 3 }}>Recover lost schedules from an older copy (optional)
            <input value={also} onChange={(e) => setAlso(e.target.value)} placeholder="path to an older ersatztv.sqlite3" />
          </label>
          <div style={{ flex: 1, paddingBottom: 8 }}><button onClick={() => load(also)} disabled={loading}>{loading ? "Checking…" : "Re-check"}</button></div>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>Legacy deletes a schedule's items when their show is removed (e.g. a Plex rescan re-creating shows). An older copy of its database still has them.</p>
      </div>

      <p style={{ fontSize: 13 }}>
        <b>{n((p) => p.status === "new" && !p.check?.airsNothing)}</b> ready ·{" "}
        <span className={n((p) => !!p.check?.airsNothing) ? "err" : ""}><b>{n((p) => !!p.check?.airsNothing)}</b> would air nothing</span> ·{" "}
        <b>{n((p) => p.status === "exists")}</b> already exist · <b>{n((p) => p.status === "unsupported")}</b> can't be imported
      </p>
      {logoless.length > 0 && (
        <div className="meta-card" style={{ marginBottom: 8, fontSize: 13, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", gap: 4 }}>
            {logoless.slice(0, 6).map((p) => <img key={p.key} src={legacyLogoSrc(p)} alt="" title={p.name} style={{ width: 24, height: 24, objectFit: "contain" }} />)}
          </span>
          <span><b>{logoless.length}</b> of your channels {logoless.length === 1 ? "has" : "have"} a logo in legacy but only a generated name logo (or none) here.</span>
          <button className="primary" onClick={bringLogos}>Bring in their logos</button>
        </div>
      )}
      {logoMsg && <div className={logoMsg.ok ? "ok" : "err"} style={{ fontSize: 12, marginBottom: 8 }}>{logoMsg.text}</div>}
      {unmarked.length > 0 && (
        <div className="meta-card" style={{ marginBottom: 8, fontSize: 13, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span><b>{unmarked.length}</b> of your channels {unmarked.length === 1 ? "has" : "have"} a watermark in legacy ({[...new Set(unmarked.map((p) => p.watermark!.row.Name))].slice(0, 4).join(", ")}{new Set(unmarked.map((p) => p.watermark!.row.Name)).size > 4 ? "…" : ""}). They come over as overlays, with the same corner, size, opacity and timing.</span>
          <button className="primary" onClick={bringWatermarks}>Bring in their watermarks</button>
        </div>
      )}
      {wmMsg && <div className={wmMsg.ok ? "ok" : "err"} style={{ fontSize: 12, marginBottom: 8 }}>{wmMsg.text}</div>}
      {(n((p) => !!p.numberClash && importable(p)) > 0 || numberProblem.size > 0) && (
        <div className="meta-card" style={{ marginBottom: 8, fontSize: 13 }}>
          Channel numbers must be unique. <b>{n((p) => !!p.numberClash && importable(p))}</b> legacy channel{n((p) => !!p.numberClash && importable(p)) === 1 ? " uses a number" : "s use numbers"} your channels already have
          {numberProblem.size > 0 && <> and <span className="err"><b>{numberProblem.size}</b> selected have a number conflict</span></>}.
          {" "}You can edit numbers in the # column, or <button onClick={useFreeNumbers}>Use free numbers</button> (e.g. 12 → 12.1).
        </div>
      )}
      <div className="actions" style={{ marginBottom: 8 }}>
        <button onClick={() => setPicked(new Set(plans.filter((p) => importable(p) && !p.check?.airsNothing).map((p) => p.key)))}>Select all ready</button>
        <button onClick={() => setPicked(new Set())}>Select none</button>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, width: "auto" }}><input type="checkbox" style={{ width: "auto" }} checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Replace channels that already exist</label>
      </div>

      <table className="history" style={{ width: "100%" }}>
        <thead><tr><th /><th>#</th><th>Channel</th><th>Type</th><th>Will air</th><th>Status</th><th>Notes</th></tr></thead>
        <tbody>
          {plans.map((p) => {
            const main = p.check?.problems.find((x) => x.role === "main content");
            const filler = p.check?.problems.filter((x) => x.role !== "main content") ?? [];
            return (
              <tr key={p.key} style={{ opacity: importable(p) ? 1 : 0.55, verticalAlign: "top" }}>
                <td><input type="checkbox" disabled={!importable(p)} checked={importable(p) && picked.has(p.key)} onChange={() => toggle(p.key)} /></td>
                <td style={{ minWidth: 90 }}>
                  {importable(p)
                    ? <input value={numberOf(p)} onChange={(e) => setNumbers((m) => ({ ...m, [p.key]: e.target.value }))} style={{ width: 64 }} aria-label={`Channel number for ${p.name}`} />
                    : p.number}
                  {picked.has(p.key) && numberProblem.get(p.key) && (
                    <div className="err" style={{ fontSize: 11 }}>{numberProblem.get(p.key)} <button style={link} onClick={() => setNumbers((m) => ({ ...m, [p.key]: suggestFor(p) }))}>use {suggestFor(p)}</button></div>
                  )}
                  {!picked.has(p.key) && p.numberClash && importable(p) && numberOf(p) === p.number && (
                    <div className="muted" style={{ fontSize: 11 }}>taken by "{p.numberClash}"</div>
                  )}
                </td>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 28, height: 28, flex: "0 0 28px", display: "inline-flex", alignItems: "center", justifyContent: "center" }} title={legacyLogoSrc(p) ? "Imported with the channel" : p.logo ? "Logo not found on this machine" : "No logo in legacy"}>
                      {legacyLogoSrc(p) ? <img src={legacyLogoSrc(p)} alt="" loading="lazy" style={{ maxWidth: 28, maxHeight: 28, objectFit: "contain" }} /> : null}
                    </span>
                    <div>{p.name}<div className="muted" style={{ fontSize: 11 }}>{p.schedule ?? ""}</div></div>
                  </div>
                </td>
                <td>{p.kind}</td>
                <td style={{ fontSize: 12, maxWidth: 260 }}>
                  {!p.check ? <span className="muted">{p.kind === "yaml" ? "as in the YAML" : "—"}</span>
                    : p.check.airsNothing
                      ? <><span className="err">nothing</span> — {main?.reason}{main?.fix && <> <button style={link} onClick={() => onNavigate(FIX[main.fix!].tab)}>{FIX[main.fix].button} →</button></>}</>
                      : <span className="ok">{p.check.items.toLocaleString()} items</span>}
                  {filler.length > 0 && <div className="err" style={{ fontSize: 11 }}>{filler.map((f) => `${f.role}: ${f.reason}`).join("; ")}</div>}
                </td>
                <td>{p.caseClash ? <span className="err">clashes with "{p.caseClash}"</span> : STATUS_LABEL[p.status]}</td>
                <td style={{ fontSize: 12 }}>
                  {p.warnings.length === 0 ? <span className="muted">—</span> : (
                    <>
                      <button style={link} onClick={() => toggleOpen(p.key)}>{open.has(p.key) ? "hide" : `${p.warnings.length} note${p.warnings.length === 1 ? "" : "s"}`}</button>
                      {open.has(p.key) && <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>{p.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="actions" style={{ marginTop: 10 }}>
        <button className="primary" onClick={run} disabled={busy || selected.length === 0 || numberProblem.size > 0}>{busy ? "Importing…" : numberProblem.size ? `Fix ${numberProblem.size} channel number${numberProblem.size === 1 ? "" : "s"} first` : `Import ${selected.length} channel${selected.length === 1 ? "" : "s"}`}</button>
        {error && <span className="err">{error}</span>}
      </div>
    </div>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children?: React.ReactNode }) {
  return (
    <div style={{ margin: "12px 0 8px" }}>
      <div style={{ fontWeight: 700 }}>{done ? "✓" : `${n}.`} {title}</div>
      {children && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{children}</div>}
    </div>
  );
}

/** After importing: build → publish → fix, each one click away. */
function NextSteps({ result, plans, onNavigate, onOpenChannel, onMore }: {
  result: { imported: string[]; skipped: { name: string; reason: string }[] }; plans: LegacyChannelPlan[];
  onNavigate: (tab: string) => void; onOpenChannel: (name: string) => void; onMore: () => void;
}) {
  const [job, setJob] = useState<BuildJob | null>(null);
  const [buildErr, setBuildErr] = useState("");
  const [published, setPublished] = useState<{ ok: boolean; text: string } | null>(null);
  const poll = useRef<number | null>(null);
  useEffect(() => () => { if (poll.current) clearInterval(poll.current); }, []);

  const imported = new Set(result.imported);
  const importedPlans = plans.filter((p) => imported.has(p.name));
  // channels needing a fix, grouped by the fix
  const fixes = new Map<Exclude<ContentFix, null>, string[]>();
  const unfixable: { name: string; reason: string }[] = [];
  for (const p of importedPlans) for (const pr of p.check?.problems ?? []) {
    if (pr.fix) { const a = fixes.get(pr.fix) ?? []; if (!a.includes(p.name)) a.push(p.name); fixes.set(pr.fix, a); }
    else if (pr.role === "main content") unfixable.push({ name: p.name, reason: pr.reason });
  }
  const buildable = result.imported.filter((n) => !importedPlans.find((p) => p.name === n)?.check?.airsNothing);

  const build = async () => {
    setBuildErr("");
    try {
      const r = await api.buildChannels(buildable);
      const tick = async () => {
        const j = await api.job(r.jobId); setJob(j);
        if ((j.status === "done" || j.status === "error") && poll.current) { clearInterval(poll.current); poll.current = null; }
      };
      await tick(); poll.current = window.setInterval(tick, 1500);
    } catch (e) { setBuildErr(String(e)); }
  };
  // next reads the lineup only when it starts: after publishing, offer a restart if it's running
  const [restart, setRestart] = useState<"offer" | "restarting" | "done" | null>(null);
  const publish = async () => {
    try {
      const r = await api.applyNext();
      try { const st = await api.nextRunner(); setRestart(st.phase === "running" || st.stale ? "offer" : null); } catch { setRestart(null); }
      setPublished({ ok: true, text: `Lineup written with ${r.channels.length} channels${r.skipped.length ? ` (${r.skipped.length} skipped: ${r.skipped.join(", ")})` : ""}.` });
    }
    catch (e) { setPublished({ ok: false, text: String(e) }); }
  };
  const restartNext = async () => { setRestart("restarting"); try { await api.nextRestart(); setRestart("done"); } catch { setRestart("offer"); } };
  const built = job?.results.length ?? 0;
  const buildDone = job?.status === "done" || job?.status === "error";
  const buildErrors = job?.results.filter((r) => r.error) ?? [];

  return (
    <div>
      <Step n={1} title={`Imported ${result.imported.length} channel${result.imported.length === 1 ? "" : "s"}`} done>
        {result.imported.map((name, i) => <span key={name}>{i ? ", " : ""}<button style={link} onClick={() => onOpenChannel(name)}>{name}</button></span>)}
        {result.skipped.length > 0 && <div className="err" style={{ marginTop: 4 }}>Skipped: {result.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}</div>}
      </Step>

      <Step n={2} title="Build their playouts" done={buildDone && !buildErrors.length}>
        Generates the schedule for the next few days so the channels have something to play. 
        {fixes.size > 0 || unfixable.length > 0 ? " Channels that would air nothing are left out until they're fixed." : ""}
        Automation will also pick them up on its next check.
      </Step>
      <div className="actions">
        <button className="primary" onClick={build} disabled={!buildable.length || (!!job && !buildDone)}>{job && !buildDone ? `Building… ${built}/${buildable.length}` : buildDone ? "Build again" : `Build ${buildable.length} channel${buildable.length === 1 ? "" : "s"} now`}</button>
        {job && <span className={buildErrors.length ? "err" : "ok"}>{built}/{buildable.length} built{buildErrors.length ? `, ${buildErrors.length} failed` : ""}</span>}
        {buildErr && <span className="err">{buildErr}</span>}
        <button onClick={() => onNavigate("build")}>Open Build page</button>
      </div>
      {buildErrors.length > 0 && <ul className="err" style={{ fontSize: 12 }}>{buildErrors.map((r) => <li key={r.channel}>{r.channel}: {r.error}</li>)}</ul>}

      <Step n={3} title="Publish to ErsatzTV next" done={published?.ok}>
        Writes the channel lineup and per-channel configs ErsatzTV next reads (same as Apply on the Streaming page).
      </Step>
      <div className="actions">
        <button className="primary" onClick={publish}>Publish lineup</button>
        {published && <span className={published.ok ? "ok" : "err"}>{published.text}</span>}
        {restart === "offer" && <button onClick={restartNext} title="ErsatzTV next reads the lineup when it starts">Restart ErsatzTV next to apply</button>}
        {restart === "restarting" && <span className="muted">Restarting ErsatzTV next…</span>}
        {restart === "done" && <span className="ok">ErsatzTV next restarted with the new lineup.</span>}
        <button onClick={() => onNavigate("streaming")}>Streaming settings</button>
      </div>

      {(fixes.size > 0 || unfixable.length > 0) && (
        <>
          <Step n={4} title="Fix channels that would air nothing" />
          {[...fixes].map(([fix, names]) => (
            <div key={fix} className="meta-card" style={{ marginBottom: 8 }}>
              <div><b>{names.join(", ")}</b></div>
              <p className="muted" style={{ fontSize: 12, margin: "4px 0" }}>{FIX[fix].how}</p>
              <div className="actions"><button onClick={() => onNavigate(FIX[fix].tab)}>{FIX[fix].button} →</button></div>
            </div>
          ))}
          {unfixable.length > 0 && (
            <div className="meta-card">
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>These need their content changed — open the channel and pick different content:</p>
              <ul style={{ fontSize: 12 }}>{unfixable.map((u) => <li key={u.name}><button style={link} onClick={() => onOpenChannel(u.name)}>{u.name}</button>: {u.reason}</li>)}</ul>
            </div>
          )}
        </>
      )}

      <div className="actions" style={{ marginTop: 14 }}><button onClick={onMore}>Import more channels</button></div>
    </div>
  );
}
