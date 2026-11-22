// Secondary console pages: navigation rail, damage assessment, plans & approvals, mission record.
import { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardList, Download, FileClock, FileText, Map as MapIcon, MessageSquare, RadioTower, ShieldCheck, Video } from "lucide-react";
import type { CaseData } from "../data/antakya";
import { ImageSpace, loadImage } from "../landing/imagery";
import { type LngLat, fmtLatLng } from "../lib/geo";
import { type Mission, fmtDur, fmtSince } from "./mission";
import { SEVERITY, findingSeverity } from "./UavFeed";

export type View = "ops" | "feed" | "sitrep" | "damage" | "plans" | "comms" | "team" | "record";
const NAV: { id: View; label: string; icon: typeof MapIcon }[] = [
  { id: "ops", label: "Operations", icon: MapIcon },
  { id: "feed", label: "UAV-1 feed", icon: Video },
  { id: "sitrep", label: "Situation", icon: FileText },
  { id: "damage", label: "Damage", icon: ClipboardList },
  { id: "plans", label: "Plans", icon: ShieldCheck },
  { id: "comms", label: "Comms", icon: RadioTower },
  { id: "team", label: "Team", icon: MessageSquare },
  { id: "record", label: "Record", icon: FileClock },
];

export function Rail({ view, onView, badges }: { view: View; onView: (v: View) => void; badges: Partial<Record<View, number | boolean>> }) {
  return (
    <nav className="cx-rail" aria-label="Console pages">
      {NAV.map(({ id, label, icon: Icon }) => {
        const b = badges[id];
        return (
          <button key={id} className={view === id ? "on" : ""} aria-current={view === id ? "page" : undefined} onClick={() => onView(id)}>
            <Icon size={19} aria-hidden /><span>{label}</span>
            {b ? <i className={typeof b === "number" ? "n" : "dot"}>{typeof b === "number" ? b : ""}</i> : null}
          </button>
        );
      })}
    </nav>
  );
}

// ------------------------------------------------------------------ thumbnails from the real imagery
function useThumbs(data: CaseData) {
  const [img, setImg] = useState<{ src: CanvasImageSource; sp: ImageSpace; pxPerM: number } | null>(null);
  const cache = useRef(new Map<string, string>());
  useEffect(() => {
    if (!data.imagery) return;
    const sp = new ImageSpace(data), mb = data.meta.missionBounds, a = sp.px([mb[0], mb[3]]), b = sp.px([mb[2], mb[1]]);
    loadImage(`/data/antakya/imagery/${data.imagery.scenes.post.layers.inner.file}`).then((i) => setImg({ src: i, sp, pxPerM: (b[0] - a[0]) / 700 }));
  }, [data]);
  return (id: string, at: LngLat, sizeM = 70) => {
    const hit = cache.current.get(id); if (hit) return hit;
    if (!img) return "";
    const [x, y] = img.sp.px(at), h = (sizeM / 2) * img.pxPerM;
    const c = document.createElement("canvas"); c.width = 160; c.height = 120;
    c.getContext("2d")!.drawImage(img.src, x - h * 1.33, y - h, h * 2.66, h * 2, 0, 0, 160, 120);
    const u = c.toDataURL("image/jpeg", 0.82); cache.current.set(id, u); return u;
  };
}

// ------------------------------------------------------------------ damage assessment
interface Item { id: string; kind: string; title: string; detail: string; at: LngLat; sev: { label: string; color: string }; area?: number }

export function DamagePage({ mission, data, onLocate }: { mission: Mission; data: CaseData; onLocate: (at: LngLat) => void }) {
  const thumb = useThumbs(data);
  const [filter, setFilter] = useState<"All" | "Severe" | "High" | "Moderate">("All");
  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    for (const f of data.buildings.features) {
      const p = f.properties;
      const g = mission.buildingGrade(p.id);
      if (g < 1 || !mission.verified.has(p.id) || f.geometry.type !== "Polygon") continue;
      const ring = (f.geometry as GeoJSON.Polygon).coordinates[0];
      const at: LngLat = [ring.reduce((s, c) => s + c[0], 0) / ring.length, ring.reduce((s, c) => s + c[1], 0) / ring.length];
      out.push({ id: p.id, kind: "building", title: g === 3 ? (mission.spec.kind === "flood" ? "Building flooded" : mission.spec.kind === "fire" ? "Building on fire" : "Building collapse") : g === 2 ? "Building damage" : "Possible damage", detail: `${p.n || (p.k === "block" ? "Building block" : "Building")} · ${p.a.toLocaleString("en-US")} m²`, at, sev: SEVERITY[g], area: p.a });
    }
    for (const f of mission.findings) if (f.kind === "road" || f.kind === "barrier" || f.kind === "incident")
      out.push({ id: f.id, kind: f.kind, title: f.kind === "incident" ? "New obstruction (simulated)" : f.title, detail: f.detail, at: f.at, sev: findingSeverity(f) });
    return out.sort((a, b) => ["Severe", "High", "Moderate"].indexOf(a.sev.label) - ["Severe", "High", "Moderate"].indexOf(b.sev.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, mission, mission.verified.size, mission.findings.length]);
  const n = (l: string) => items.filter((i) => i.sev.label === l).length;
  const total = Math.max(1, items.length), shown = items.filter((i) => filter === "All" || i.sev.label === filter);
  const t = (action: string) => mission.audit.find((a) => a.action === action)?.t;
  const tSurvey = t("Survey authorised"), tDone = t("Survey complete"), tPlan = t("Plan proposed"), tAppr = t("Plan approved");
  const c = mission.counts;
  return (
    <div className="cx-page">
      <header className="cx-page-h">
        <div><h2>Damage assessment</h2><p>Only what UAV-1 has observed. Severity = Copernicus EMS grade (Destroyed → Severe, Damaged → High, Possibly damaged → Moderate). Photos are real Maxar crops from 11 Feb 2023.</p></div>
      </header>
      <section className="cx-kpi-row">
        <div className="cx-kpi-card"><span>Structures verified</span><b>{c.verified}<small>/{c.total}</small></b></div>
        <div className="cx-kpi-card sev"><span>Severe</span><b>{n("Severe")}</b></div>
        <div className="cx-kpi-card hi"><span>High</span><b>{n("High")}</b></div>
        <div className="cx-kpi-card mod"><span>Moderate</span><b>{n("Moderate")}</b></div>
        <div className="cx-kpi-card"><span>Survey → verified plan</span><b>{tSurvey !== undefined && tPlan !== undefined ? fmtDur(tPlan - tSurvey) : "—"}</b><small className="cx-kpi-note">measured, simulated time</small></div>
        <div className="cx-kpi-card"><span>Survey flight</span><b>{tSurvey !== undefined && tDone !== undefined ? fmtDur(tDone - tSurvey) : "—"}</b><small className="cx-kpi-note">{tAppr !== undefined ? `approved ${fmtDur(tAppr - (tPlan ?? tAppr))} after proposal` : "measured, simulated time"}</small></div>
      </section>
      <div className="cx-dist" aria-label="Severity distribution">
        {(["Severe", "High", "Moderate"] as const).map((l) => <span key={l} style={{ width: `${(n(l) / total) * 100}%`, background: SEVERITY[l === "Severe" ? 3 : l === "High" ? 2 : 1].color }} title={`${l}: ${n(l)}`} />)}
      </div>
      <div className="cx-filter" role="group" aria-label="Severity filter">
        {(["All", "Severe", "High", "Moderate"] as const).map((f) => <button key={f} className={filter === f ? "on" : ""} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f}{f !== "All" ? ` · ${n(f)}` : ` · ${items.length}`}</button>)}
      </div>
      {shown.length === 0 ? <p className="cx-empty">Nothing observed yet. Authorise the aerial survey on the Operations page.</p> : (
        <ul className="cx-grid">
          {shown.slice(0, 120).map((i) => (
            <li key={i.id}><button className="cx-dcard" style={{ "--sev": i.sev.color } as React.CSSProperties} onClick={() => onLocate(i.at)}>
              <img src={thumb(i.id, i.at, i.area && i.area > 2000 ? 110 : 70)} alt="" />
              <div><span className="cx-sev">{i.sev.label}</span><b>{i.title}</b><small>{i.detail}</small><small className="mono">{fmtLatLng(i.at)}</small></div>
            </button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ plans & approvals
const CHECK_LABEL: Record<string, string> = { on_network: "Road network", passable: "Passable", observed: "Observed by UAV-1", role: "Approver", current: "Latest version", world: "World version", bound: "Hash binding", known: "Registered" };
export function PlansPage({ mission }: { mission: Mission }) {
  const authority = mission.audit.filter((a) => a.actor === "authority" || a.action.includes("Re-used") || a.action.includes("rejected")).reverse();
  return (
    <div className="cx-page">
      <header className="cx-page-h"><div><h2>Plans &amp; approvals</h2><p>Every plan version, what the {mission.live ? "ROS 2 mission authority" : "planner"} checked, and who approved it. A plan is executable only once, by the Ops Commander, against the current world version.</p></div></header>
      {mission.plans.length === 0 && <p className="cx-empty">No plans yet.</p>}
      <div className="cx-plans">
        {[...mission.plans].reverse().map((p) => (
          <article key={p.id} className={`cx-pcard ${p === mission.plan ? "cur" : ""}`}>
            <div className="cx-pcard-h">
              <div><b>{p.id} · v{p.version}</b><small>{p.replan ? "Re-plan after incident" : "Initial plan"} · target {p.target}{p.authority ? ` · world v${p.authority.worldVersion}` : ""}</small></div>
              <span className={`chip ${p.approvedBy ? "chip-ok" : p === mission.plan ? "chip-warn" : ""}`}>{p.approvedBy ? `Approved · ${p.approvedBy}` : p === mission.plan ? "Awaiting approval" : "Superseded"}</span>
            </div>
            <div className="cx-pcard-opts">
              {p.options.map((o) => {
                const a = p.authority?.options[o.id];
                return (
                  <div key={o.id} className={`cx-po ${o.eligible ? "ok" : "bad"}`}>
                    <div className="cx-po-h"><b>{o.label}</b><span>{Math.round(o.route.length)} m · {fmtDur(o.eta)}</span></div>
                    {a ? <ul>{Object.entries(a.checks).map(([k, c]) => <li key={k} className={c.ok ? "ok" : "bad"}>{c.ok ? "✓" : "✕"} <b>{CHECK_LABEL[k] ?? k}</b> · {c.detail}</li>)}</ul>
                      : <p>{o.reason}</p>}
                  </div>
                );
              })}
            </div>
            <code className="cx-pcard-hash">sha256 {p.hash}</code>
            {p.rejected && <p className="cx-pcard-rej">Rejected approval: {Object.values(p.rejected).filter((c) => !c.ok).map((c) => c.detail).join(" · ")}</p>}
          </article>
        ))}
      </div>
      {authority.length > 0 && (
        <section className="cx-auth-log"><h3>Authority decisions</h3>
          <ul>{authority.map((a, i) => <li key={i}><span className="mono">{fmtSince(mission.sinceEvent - (mission.t - a.t))}</span><b>{a.action}</b><small>{a.detail}</small></li>)}</ul>
        </section>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ mission record
export function RecordPage({ mission, onExport }: { mission: Mission; onExport: () => void }) {
  const d = mission.debrief;
  return (
    <div className="cx-page">
      <header className="cx-page-h">
        <div><h2>Mission record</h2><p>Append-only record of every command, finding, plan and approval. Source: {mission.live ? "Gazebo + ROS 2 (live)" : "browser replay"}. Times are simulated mission time.</p></div>
        <button className="btn btn-primary" onClick={onExport}><Download size={16} />Export JSON</button>
      </header>
      <section className="cx-kpi-row">
        {[["Sites closed", `${d.done}/${d.targets}`], ["Distance driven", `${Math.round(d.driven)} m`], ["Plans", d.plans], ["Approvals", d.approvals], ["Incidents", d.incidents], ["Elapsed", fmtDur(d.elapsed)]].map(([k, v]) =>
          <div key={k} className="cx-kpi-card"><span>{k}</span><b>{v}</b></div>)}
      </section>
      <ol className="cx-timeline">
        {[...mission.audit].reverse().map((a, i) => (
          <li key={i} className={a.actor === "authority" ? "auth" : a.action.includes("Obstruction") ? "inc" : ""}>
            <span className="mono">{fmtSince(mission.sinceEvent - (mission.t - a.t))}</span>
            <div><b>{a.action}</b><small>{a.actor} · {a.detail}</small>{a.hash && <code>sha256 {a.hash.slice(0, 24)}…</code>}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}
