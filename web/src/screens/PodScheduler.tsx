import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Pod, type DayGroup, type PodScheduleConfig } from "../api.js";

const DAYS = [["sun", "Su"], ["mon", "Mo"], ["tue", "Tu"], ["wed", "We"], ["thu", "Th"], ["fri", "Fr"], ["sat", "Sa"]] as const;

const DEFAULT_GROUPS: DayGroup[] = [
  { id: "weekday", label: "Weekdays", days: ["mon", "tue", "wed", "thu", "fri"], slots: [] },
  { id: "saturday", label: "Saturday", days: ["sat"], slots: [] },
  { id: "sunday", label: "Sunday", days: ["sun"], slots: [] },
];

const fmtTime = (min: number) => {
  const m = ((min % 1440) + 1440) % 1440;
  let h = Math.floor(m / 60), mm = m % 60, ap = h < 12 ? "AM" : "PM";
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(mm).padStart(2, "0")} ${ap}`;
};
const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "group";
const podDuration = (p?: Pod) => (p?.config?.align && p.config.align > 0 ? p.config.align : 30);

export function PodScheduler({ value, onChange }: { value: PodScheduleConfig; onChange: (v: PodScheduleConfig) => void }) {
  const [libPods, setLibPods] = useState<Pod[]>([]);
  const [selGroup, setSelGroup] = useState<string>("");
  const dragOverIdx = useRef<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  useEffect(() => { api.pods().then(setLibPods).catch(() => {}); }, []);

  const groups: DayGroup[] = value.groups?.length ? value.groups : DEFAULT_GROUPS;
  useEffect(() => { if (!selGroup && groups[0]) setSelGroup(groups[0].id); }, [groups, selGroup]);

  // Pod lookup: prefer the live library, fall back to the embedded snapshot.
  const podMap = useMemo(() => {
    const m = new Map<string, Pod>();
    for (const p of value.pods ?? []) m.set(p.id, p);
    for (const p of libPods) m.set(p.id, p);
    return m;
  }, [libPods, value.pods]);
  const showPods = libPods.filter((p) => p.type === "show");

  // A show pod also depends on its mid-roll break pod and tail-filler pod; pull
  // those (transitively) into the snapshot so the channel is self-contained.
  const collectDeps = (podId: string, acc: Set<string>) => {
    if (acc.has(podId)) return;
    const p = podMap.get(podId); if (!p) return;
    acc.add(podId);
    const c: any = p.config ?? {};
    if (c.midRoll?.breakPodId) collectDeps(c.midRoll.breakPodId, acc);
    if (c.tailFillerPodId) collectDeps(c.tailFillerPodId, acc);
  };
  // Persist: snapshot every pod referenced by any group (plus deps) so the channel is self-contained.
  const commit = (nextGroups: DayGroup[]) => {
    const ids = new Set<string>();
    for (const g of nextGroups) for (const s of g.slots) collectDeps(s, ids);
    const pods = [...ids].map((id) => podMap.get(id)).filter((p): p is Pod => !!p);
    onChange({ pods, groups: nextGroups });
  };
  const updateGroup = (id: string, patch: Partial<DayGroup>) => commit(groups.map((g) => g.id === id ? { ...g, ...patch } : g));
  const group = groups.find((g) => g.id === selGroup) ?? groups[0];

  // --- slot ops ---
  const insertPod = (podId: string, at: number) => {
    if (!group) return;
    const slots = [...group.slots]; slots.splice(at, 0, podId);
    updateGroup(group.id, { slots });
  };
  const moveSlot = (from: number, to: number) => {
    if (!group || from === to) return;
    const slots = [...group.slots]; const [x] = slots.splice(from, 1); slots.splice(from < to ? to - 1 : to, 0, x);
    updateGroup(group.id, { slots });
  };
  const removeSlot = (i: number) => { if (!group) return; updateGroup(group.id, { slots: group.slots.filter((_, j) => j !== i) }); };

  const onDropAt = (e: React.DragEvent, at: number) => {
    e.preventDefault(); setOverIdx(null); dragOverIdx.current = null;
    const podId = e.dataTransfer.getData("text/pod");
    const slotIdx = e.dataTransfer.getData("text/slot");
    if (podId) insertPod(podId, at);
    else if (slotIdx !== "") moveSlot(Number(slotIdx), at);
  };

  // --- group management ---
  const addGroup = () => {
    const label = prompt("New day-group name (e.g. Holidays, Christmas):"); if (!label) return;
    let id = slug(label); while (groups.some((g) => g.id === id)) id += "_2";
    commit([...groups, { id, label, days: [], slots: [] }]); setSelGroup(id);
  };
  const removeGroup = () => {
    if (!group) return; if (!confirm(`Remove day-group "${group.label}"?`)) return;
    const next = groups.filter((g) => g.id !== group.id); commit(next); setSelGroup(next[0]?.id ?? "");
  };
  const toggleDay = (d: string) => { if (!group) return; const days = group.days.includes(d) ? group.days.filter((x) => x !== d) : [...group.days, d]; updateGroup(group.id, { days }); };

  // cumulative start time per slot (minutes from midnight)
  let acc = 0; const startMins = (group?.slots ?? []).map((id) => { const s = acc; acc += podDuration(podMap.get(id)); return s; });

  return (
    <div className="pod-sched">
      <div className="ps-palette">
        <h3>Show pods</h3>
        <p className="muted" style={{ fontSize: 11 }}>Drag a show into a day's timeline. Build pods on the Pods page.</p>
        {showPods.length === 0 && <p className="muted">No show pods yet — create some on the Pods page.</p>}
        {showPods.map((p) => (
          <div key={p.id} className="ps-pod" draggable onDragStart={(e) => e.dataTransfer.setData("text/pod", p.id)}>
            <span className="ps-pod-name">{p.name || p.id}</span>
            <span className="badge">{podDuration(p) === 60 ? "1 hr" : `${podDuration(p)} min`}</span>
          </div>
        ))}
      </div>

      <div className="ps-main">
        <div className="ps-tabs">
          {groups.map((g) => (
            <button key={g.id} className={g.id === selGroup ? "active" : ""} onClick={() => setSelGroup(g.id)}>
              {g.label} <span className="muted">{g.slots.length}</span>
            </button>
          ))}
          <button className="ps-addgroup" onClick={addGroup}>+ day-group</button>
        </div>

        {group && (
          <>
            <div className="ps-groupbar">
              <span className="muted">Applies on:</span>
              {DAYS.map(([d, lbl]) => (
                <button key={d} className={`ps-day ${group.days.includes(d) ? "on" : ""}`} onClick={() => toggleDay(d)}>{lbl}</button>
              ))}
              <label className="ps-holiday">Holiday
                <input value={group.holiday ?? ""} placeholder="e.g. christmas" onChange={(e) => updateGroup(group.id, { holiday: e.target.value || undefined })} />
              </label>
              {groups.length > 1 && <button className="danger ps-delgroup" onClick={removeGroup}>Remove day-group</button>}
            </div>

            <div className="ps-timeline" onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDropAt(e, group.slots.length)}>
              {group.slots.length === 0 && <p className="muted ps-empty">Drag show pods here to build the day (top = midnight). Each pod fills to its clock boundary.</p>}
              {group.slots.map((id, i) => {
                const p = podMap.get(id);
                return (
                  <div key={i}
                    className={`ps-slot ${overIdx === i ? "over" : ""} ${p ? "" : "missing"}`}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("text/slot", String(i))}
                    onDragOver={(e) => { e.preventDefault(); if (overIdx !== i) setOverIdx(i); }}
                    onDragLeave={() => setOverIdx((v) => v === i ? null : v)}
                    onDrop={(e) => onDropAt(e, i)}>
                    <span className="ps-time">{fmtTime(startMins[i])}</span>
                    <span className="ps-slot-name">{p ? (p.name || p.id) : `${id} (missing pod)`}</span>
                    <span className="badge">{podDuration(p) === 60 ? "1 hr" : `${podDuration(p)} min`}</span>
                    {p && !(p.config?.align > 0) && <span className="err" style={{ fontSize: 11 }} title="This pod has no clock alignment set — it may drift. Set an align + tail filler on the Pods page.">⚠ no align</span>}
                    <button className="ps-x" onClick={() => removeSlot(i)} title="remove">✕</button>
                  </div>
                );
              })}
              <div className="ps-daytotal muted">Day ends ~{fmtTime(acc)} · loops to fill 24h</div>
            </div>
            <p className="muted" style={{ fontSize: 12 }}>
              The lineup loops to fill the day and clock-aligns each block (a 30-min pod pads to the next :30, a 1-hr pod to the top of the hour).
              Save &amp; validate below, then build the channel on the Build page.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
