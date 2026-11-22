// Situation report (tactical known-map, extraction sequence, fleet telemetry, advisories; printable as PDF)
// and the comms page (modelled link budget, airborne relay, fail-safe link tests).
import { useEffect, useMemo, useRef } from "react";
import { Printer, RadioTower, ShieldAlert, Unplug } from "lucide-react";
import type { CaseData } from "../data/antakya";
import { GRADE_COLOR } from "../data/antakya";
import { FLEET, X500_SWATH } from "../data/fleet";
import { type LngLat, type XY, fmtLatLng } from "../lib/geo";
import { GROUND_RANGE, type Link, type Mission, fmtClock, fmtDur, fmtSince } from "./mission";

// ------------------------------------------------------------------ shared geometry
interface Box { min: XY; max: XY }
function missionBox(m: Mission, pad: number, extra: XY[] = []): Box {
  const pts: XY[] = [m.sector.min, m.sector.max, m.frame.toXY(m.staging.at), ...extra];
  return { min: [Math.min(...pts.map((p) => p[0])) - pad, Math.min(...pts.map((p) => p[1])) - pad], max: [Math.max(...pts.map((p) => p[0])) + pad, Math.max(...pts.map((p) => p[1])) + pad] };
}
const pctKnown = (m: Mission) => {
  const { min, max } = m.sector; let n = 0, k = 0;
  for (let x = min[0]; x <= max[0]; x += 10) for (let y = min[1]; y <= max[1]; y += 10) { n++; if (m.isCovered(x, y)) k++; }
  return n ? k / n : 0;
};
const linkLabel = (m: Mission) => { const l = m.ugvLink; return l.via === "direct" ? "Direct" : l.via === "relay" ? "Via UAV-1 relay" : "None · holding"; };
const rssi = (q: number) => Math.round(-48 - (1 - q) * 52);           // modelled dBm, for display only
const qColor = (l: Link) => (!l.up ? "#d93025" : l.q > 0.5 ? "#188038" : "#e8a400");

// ------------------------------------------------------------------ tactical map (canvas)
function TacticalMap({ mission, data }: { mission: Mission; data: CaseData }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useMemo(() => missionBox(mission, 40), [mission]);
  const W = 760, H = Math.round((W * (box.max[1] - box.min[1])) / (box.max[0] - box.min[0]));
  const polys = useMemo(() => {
    const out: { id: string; g: number; rings: XY[][] }[] = [];
    for (const f of data.buildings.features) {
      const g = f.geometry;
      const polysLL = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
      const rings = polysLL.map((p) => p[0].map((c) => mission.frame.toXY(c as LngLat)));
      const q = rings[0]?.[0];
      if (!q || q[0] < box.min[0] || q[0] > box.max[0] || q[1] < box.min[1] || q[1] > box.max[1]) continue;
      out.push({ id: f.properties.id, g: mission.buildingGrade(f.properties.id), rings });
    }
    return out;
  }, [data, mission]);
  const edges = useMemo(() => {
    const out: [number, number, number][] = [];
    mission.graph.adj.forEach((es, u) => es.forEach((e) => {
      if (u >= e.to) return;
      const a = mission.graph.nodes[u], b = mission.graph.nodes[e.to];
      const inside = (p: XY) => p[0] > box.min[0] && p[0] < box.max[0] && p[1] > box.min[1] && p[1] < box.max[1];
      if (inside(a) || inside(b)) out.push([u, e.to, e.grade]);
    }));
    return out;
  }, [mission, box]);

  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sx = W / (box.max[0] - box.min[0]);
    const P = (p: XY): [number, number] => [(p[0] - box.min[0]) * sx, H - (p[1] - box.min[1]) * sx];
    // known / unknown cells (5 m)
    ctx.fillStyle = "#dfe2e8"; ctx.fillRect(0, 0, W, H);
    const cell = 5, nx = Math.ceil((box.max[0] - box.min[0]) / cell), ny = Math.ceil((box.max[1] - box.min[1]) / cell);
    const img = new ImageData(nx, ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const known = mission.isCovered(box.min[0] + i * cell + cell / 2, box.max[1] - j * cell - cell / 2), o = (j * nx + i) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = known ? 255 : 223; img.data[o + 3] = known ? 255 : 0;
    }
    const tmp = document.createElement("canvas"); tmp.width = nx; tmp.height = ny; tmp.getContext("2d")!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false; ctx.drawImage(tmp, 0, 0, nx * cell * sx, ny * cell * sx);
    // 50 m grid
    ctx.strokeStyle = "rgba(20,24,40,0.06)"; ctx.lineWidth = 1;
    for (let x = Math.ceil(box.min[0] / 50) * 50; x < box.max[0]; x += 50) { const [px] = P([x, 0]); ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke(); }
    for (let y = Math.ceil(box.min[1] / 50) * 50; y < box.max[1]; y += 50) { const [, py] = P([0, y]); ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(W, py); ctx.stroke(); }
    // sector outline
    const [s0x, s0y] = P(mission.sector.min), [s1x, s1y] = P(mission.sector.max);
    ctx.setLineDash([6, 4]); ctx.strokeStyle = "rgba(26,47,251,0.5)"; ctx.strokeRect(s0x, s1y, s1x - s0x, s0y - s1y); ctx.setLineDash([]);
    // buildings
    for (const b of polys) {
      const v = mission.verified.has(b.id);
      ctx.beginPath();
      for (const r of b.rings) r.forEach((p, i) => { const [x, y] = P(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      if (v && b.g >= 1) { ctx.fillStyle = GRADE_COLOR[b.g as 1 | 2 | 3]; ctx.globalAlpha = 0.85; ctx.fill(); ctx.globalAlpha = 1; }
      else if (v) { ctx.fillStyle = "#c9ced6"; ctx.fill(); }
      else { ctx.strokeStyle = "rgba(60,63,76,0.25)"; ctx.lineWidth = 0.7; ctx.stroke(); }
    }
    // roads
    ctx.lineCap = "round";
    for (const [u, v, g] of edges) {
      const [ax, ay] = P(mission.graph.nodes[u]), [bx, by] = P(mission.graph.nodes[v]);
      const obs = mission.observedEdge(u, v), closed = mission.isClosed(u, v);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      if (closed) { ctx.strokeStyle = "#d93025"; ctx.lineWidth = 3; ctx.setLineDash([2, 3]); }
      else if (!obs) { ctx.strokeStyle = "rgba(60,63,76,0.28)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); }
      else if (g >= 2) { ctx.strokeStyle = "#d93025"; ctx.lineWidth = 2.4; ctx.setLineDash([]); }
      else { ctx.strokeStyle = "#5f6677"; ctx.lineWidth = 2; ctx.setLineDash([]); }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // active route + trail
    const route = mission.activeRoute;
    if (route) {
      const pts = route.pts.map(P);
      for (const [w, c] of [[7, "#ffffff"], [3.5, "#1a2ffb"]] as const) { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.strokeStyle = c; ctx.lineWidth = w; ctx.lineJoin = "round"; ctx.stroke(); }
    }
    if (mission.roverTrail.length > 1) { ctx.beginPath(); mission.roverTrail.forEach((ll, i) => { const [x, y] = P(mission.frame.toXY(ll)); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.strokeStyle = "rgba(11,12,16,0.7)"; ctx.lineWidth = 1.6; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]); }
    // incidents
    for (const inc of mission.incidents) { const [x, y] = P(mission.frame.toXY(inc.at)); ctx.strokeStyle = "#d93025"; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(x - 6, y - 6); ctx.lineTo(x + 6, y + 6); ctx.moveTo(x + 6, y - 6); ctx.lineTo(x - 6, y + 6); ctx.stroke(); }
    // targets
    ctx.font = "600 11px Inter, system-ui, sans-serif"; ctx.textBaseline = "middle";
    mission.targets.forEach((t, i) => {
      const [x, y] = P(mission.frame.toXY(t.at)), cur = i === mission.ti && !t.done;
      ctx.beginPath(); ctx.arc(x, y, cur ? 9 : 7, 0, Math.PI * 2); ctx.fillStyle = t.done ? "#188038" : "#ffffff"; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = t.done ? "#ffffff" : "#d93025"; ctx.stroke();
      if (!t.done) { ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fillStyle = "#d93025"; ctx.fill(); }
      label(ctx, t.label, x + 12, y);
    });
    // command post
    const [cx, cy] = P(mission.frame.toXY(mission.staging.at));
    ctx.fillStyle = "#0b0c10"; ctx.fillRect(cx - 7, cy - 7, 14, 14); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.strokeRect(cx - 7, cy - 7, 14, 14); ctx.textAlign = "right"; label(ctx, "CP", cx - 12, cy); ctx.textAlign = "left";
    // UGV-1
    const [rx, ry] = P(mission.frame.toXY(mission.rover.at));
    ctx.save(); ctx.translate(rx, ry); ctx.rotate((mission.rover.hdg * Math.PI) / 180);
    ctx.fillStyle = "#1a2ffb"; ctx.fillRect(-6, -6, 12, 12); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.strokeRect(-6, -6, 12, 12);
    ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(0, -13); ctx.stroke(); ctx.restore(); label(ctx, "UGV-1", rx + 12, ry + 12);
    // UAV-1 with camera footprint
    if ((mission.drone.alt ?? 0) > 5) {
      const [dx, dy] = P(mission.frame.toXY(mission.drone.at));
      ctx.beginPath(); ctx.arc(dx, dy, (X500_SWATH / 2) * sx, 0, Math.PI * 2); ctx.fillStyle = "rgba(26,47,251,0.08)"; ctx.fill(); ctx.strokeStyle = "rgba(26,47,251,0.55)"; ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
      ctx.save(); ctx.translate(dx, dy); ctx.rotate((mission.drone.hdg * Math.PI) / 180);
      ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(7, 7); ctx.lineTo(0, 3); ctx.lineTo(-7, 7); ctx.closePath(); ctx.fillStyle = "#1a2ffb"; ctx.fill(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.6; ctx.stroke(); ctx.restore();
      label(ctx, "UAV-1", dx + 12, dy - 12);
    }
    // scale bar + north
    const bar = 100 * sx; ctx.fillStyle = "#0b0c10"; ctx.fillRect(16, H - 22, bar, 4); ctx.fillRect(16, H - 28, 2, 10); ctx.fillRect(16 + bar - 2, H - 28, 2, 10);
    ctx.font = "600 10.5px Inter, system-ui, sans-serif"; ctx.fillText("100 m", 16 + bar + 8, H - 20);
    ctx.beginPath(); ctx.moveTo(W - 22, 14); ctx.lineTo(W - 16, 30); ctx.lineTo(W - 28, 30); ctx.closePath(); ctx.fill(); ctx.fillText("N", W - 26, 40);
  });

  return <canvas ref={ref} className="sr-canvas" style={{ aspectRatio: `${W} / ${H}` }} role="img" aria-label="Tactical map: what UAV-1 has observed, road states, routes and units" />;
}
function label(ctx: CanvasRenderingContext2D, t: string, x: number, y: number) {
  ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,0.95)"; ctx.strokeText(t, x, y); ctx.fillStyle = "#0b0c10"; ctx.fillText(t, x, y);
}

// ------------------------------------------------------------------ situation report page
export function SitrepPage({ mission, data }: { mission: Mission; data: CaseData }) {
  const c = mission.counts, known = pctKnown(mission), seq = mission.extractionSequence(), links = mission.links, ul = mission.ugvLink;
  const clk = fmtClock(mission.clock), route = mission.activeRoute;
  const hazardsNear = route ? mission.extractionSequence().find((s) => s.status === "current")?.hazardsNear ?? 0 : 0;
  const advisories: { tone: "bad" | "warn" | "info"; text: string }[] = [];
  if (mission.phase === "standby") advisories.push({ tone: "info", text: "No aerial survey yet. Every road is treated as impassable until UAV-1's camera has observed it." });
  else if (known < 0.98) advisories.push({ tone: "warn", text: `${Math.round((1 - known) * 100)}% of sector AOI-M1 is unobserved. Routes may not use any segment in that area.` });
  if (mission.incidents.length) advisories.push({ tone: "bad", text: `${mission.incidents.length} in-mission obstruction${mission.incidents.length > 1 ? "s" : ""} (simulated): ${mission.incidents.map((i) => i.road).join(", ")}. Affected segments are closed for all plans.` });
  if (route && hazardsNear) advisories.push({ tone: "warn", text: `${hazardsNear} destroyed structure${hazardsNear > 1 ? "s" : ""} within 6 m of the active route (secondary-collapse exposure). Copernicus grades, not structural surveys.` });
  if (!ul.ok) advisories.push({ tone: "bad", text: "UGV-1 has no command path. It is stopped under the fail-safe and no plan can be dispatched until a link returns." });
  else if (ul.via === "relay") advisories.push({ tone: "warn", text: `UGV-1 is out of direct ground range and depends on the UAV-1 relay. UAV-1 battery ${Math.round(mission.drone.battery * 100)}%; return to staging at 25% interrupts the relay.` });
  const signals = seq.filter((s) => s.signal);
  if (signals.length) advisories.push({ tone: "info", text: `Signal of interest at ${signals.map((s) => s.label).join(", ")} (simulated) handed to the USAR team.` });
  const units = [
    { id: "UAV-1", model: FLEET[0].name, s: mission.drone, link: links[1].up ? (links[1].note === "On pad at the command post" ? "Local" : `${rssi(links[1].q)} dBm`) : "Lost", extra: mission.drone.alt ? `${mission.drone.alt} m AGL` : "On pad" },
    { id: "UGV-1", model: FLEET[1].name, s: mission.rover, link: linkLabel(mission), extra: mission.phase === "executing" ? "Autonomous" : "Idle" },
  ];
  return (
    <div className="cx-page sr">
      <div className="sr-print-h" aria-hidden>
        <b>AegisLoop · Situation report</b>
        <span>Antakya, Hatay · Copernicus EMSR648 · Sector AOI-M1 · Replay clock {clk.date} {clk.time} TRT ({fmtSince(mission.sinceEvent)}) · Printed {new Date().toLocaleString()}</span>
        <span>Source: {mission.live ? "Gazebo + ROS 2 (live)" : "browser replay"}. Geography, imagery and damage grades are real public data; robots, mission, obstruction, signals and links are simulated or modelled.</span>
      </div>
      <header className="cx-page-h">
        <div><h2>Situation report</h2><p>The common operating picture for the incident commander: what is known, where the ground unit can safely go next, the state of every unit, and the open risks. Nothing on this page is drawn from outside UAV-1's observations.</p></div>
        <button className="btn btn-primary no-print" onClick={() => window.print()}><Printer size={16} />Save as PDF</button>
      </header>
      <section className="cx-kpi-row">
        <div className="cx-kpi-card"><span>Sector known</span><b>{Math.round(known * 100)}<small>%</small></b></div>
        <div className="cx-kpi-card"><span>Structures verified</span><b>{c.verified}<small>/{c.total}</small></b></div>
        <div className="cx-kpi-card sev"><span>Destroyed</span><b>{c.destroyed}</b></div>
        <div className="cx-kpi-card"><span>Road hazards</span><b>{c.roads}</b></div>
        <div className="cx-kpi-card"><span>Sites closed</span><b>{mission.debrief.done}<small>/{mission.targets.length}</small></b></div>
        <div className={`cx-kpi-card ${ul.ok ? "" : "sev"}`}><span>UGV-1 command path</span><b className="sr-kpi-s">{linkLabel(mission)}</b></div>
      </section>
      <div className="sr-grid">
        <section className="sr-card sr-map">
          <div className="sr-card-h"><h3>Tactical map</h3><span className="mono">5 m cells · {fmtLatLng(data.meta.center)}</span></div>
          <TacticalMap mission={mission} data={data} />
          <div className="sr-legend">
            <span><i className="k-unknown" />Not observed</span><span><i className="k-known" />Observed</span>
            <span><i style={{ background: GRADE_COLOR[3] }} />Destroyed</span><span><i style={{ background: GRADE_COLOR[2] }} />Damaged</span>
            <span><i className="k-road" />Passable road</span><span><i className="k-cut" />Impassable / closed</span><span><i className="k-route" />Active verified route</span>
          </div>
        </section>
        <section className="sr-card">
          <div className="sr-card-h"><h3>Extraction sequence</h3><span>verified routes only</span></div>
          <p className="sr-note">Order: the committed target first, then the nearest remaining site by verified route. ETA includes {fmtDur(240)} of thermal and acoustic sweep per site at the Husky's 1.0 m/s plan speed.</p>
          <ol className="sr-seq">
            {seq.map((s, i) => (
              <li key={s.label} className={`st-${s.status}`}>
                <span className="sr-seq-n">{s.status === "closed" ? "✓" : i + 1}</span>
                <div>
                  <div className="sr-seq-h"><b>{s.label}</b><span className={`chip ${s.status === "current" ? "chip-warn" : s.status === "closed" ? "chip-ok" : s.status === "unreachable" ? "chip-bad" : ""}`}>{s.status === "current" ? "Committed" : s.status === "closed" ? "Closed" : s.status === "unreachable" ? "No verified route" : "Queued"}</span></div>
                  <small>Destroyed structure · {s.area.toLocaleString("en-US")} m² footprint{s.signal ? " · signal of interest (simulated)" : ""}</small>
                  {s.verified !== null && <dl><div><dt>Verified</dt><dd className="mono">{Math.round(s.verified)} m</dd></div><div><dt>Direct</dt><dd className="mono">{s.direct !== null ? `${Math.round(s.direct)} m` : "—"}</dd></div><div><dt>ETA</dt><dd className="mono">{fmtDur(s.eta!)}</dd></div><div><dt>Cumulative</dt><dd className="mono">{fmtDur(s.cumEta!)}</dd></div></dl>}
                  <small className="sr-seq-r">{s.reason}</small>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
      <section className="sr-card">
        <div className="sr-card-h"><h3>Fleet telemetry</h3><span>{mission.live ? "Gazebo odometry" : "replay model"} · links modelled</span></div>
        <div className="sr-table-wrap">
          <table className="sr-table">
            <thead><tr><th>Unit</th><th>Platform</th><th>Status</th><th>Battery</th><th>Speed</th><th>Mode / alt</th><th>Position</th><th>Command link</th></tr></thead>
            <tbody>{units.map((u) => (
              <tr key={u.id}><td><b>{u.id}</b></td><td>{u.model}</td><td>{u.s.status}</td><td className="mono">{Math.max(0, Math.round(u.s.battery * 100))}%</td><td className="mono">{u.s.speed.toFixed(1)} m/s</td><td>{u.extra}</td><td className="mono">{fmtLatLng(u.s.at)}</td><td className={u.link.startsWith("None") || u.link === "Lost" ? "bad" : ""}>{u.link}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </section>
      <section className="sr-card">
        <div className="sr-card-h"><h3>Advisories</h3><span>derived from mission state</span></div>
        {advisories.length === 0 ? <p className="sr-note">No open advisories.</p> : <ul className="sr-adv">{advisories.map((a, i) => <li key={i} className={a.tone}><ShieldAlert size={15} aria-hidden />{a.text}</li>)}</ul>}
      </section>
      <p className="sr-foot">Imagery © Maxar Open Data (CC BY-NC 4.0) · Damage grading © European Union, Copernicus EMS EMSR648 · Roads and buildings © OpenStreetMap contributors · Robots, mission events and radio links are simulated; this is not an operational product.</p>
    </div>
  );
}

// ------------------------------------------------------------------ comms page
export function CommsPage({ mission }: { mission: Mission }) {
  const links = mission.links, ul = mission.ugvLink;
  const cp = mission.frame.toXY(mission.staging.at), d = mission.frame.toXY(mission.drone.at), r = mission.frame.toXY(mission.rover.at);
  const box = useMemo(() => missionBox(mission, 120), [mission]);
  const b2: Box = { min: [Math.min(box.min[0], d[0] - 60, r[0] - 60), Math.min(box.min[1], d[1] - 60, r[1] - 60)], max: [Math.max(box.max[0], d[0] + 60, r[0] + 60), Math.max(box.max[1], d[1] + 60, r[1] + 60)] };
  const W = 720, s = W / (b2.max[0] - b2.min[0]), H = Math.round((b2.max[1] - b2.min[1]) * s);
  const P = (p: XY) => [((p[0] - b2.min[0]) * s).toFixed(1), (H - (p[1] - b2.min[1]) * s).toFixed(1)].join(",");
  const roads = useMemo(() => {
    let dd = "";
    mission.graph.adj.forEach((es, u) => es.forEach((e) => { if (u < e.to) { const a = mission.graph.nodes[u], b = mission.graph.nodes[e.to]; dd += `M${P(a)}L${P(b)}`; } }));
    return dd;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mission, b2.min[0], b2.min[1], b2.max[0], b2.max[1]]);
  const airborne = (mission.drone.alt ?? 0) > 20;
  const nodes: Record<string, XY> = { "Command post": cp, "UAV-1": d, "UGV-1": r };
  const active = new Set(ul.via === "direct" ? ["cp-ugv"] : ul.via === "relay" ? ["cp-uav", "uav-ugv"] : []);
  const log = mission.audit.filter((a) => a.actor === "comms" || a.action.startsWith("Link test")).reverse();
  const live = !!mission.live;
  const latency = ul.via === "direct" ? "≈ 20 ms" : ul.via === "relay" ? "≈ 45 ms" : "—";
  return (
    <div className="cx-page cm">
      <header className="cx-page-h">
        <div><h2>Comms &amp; fail-safe</h2><p>The mission network: a mesh radio at the command post and on UGV-1, and an airborne relay on UAV-1. Every command to UGV-1 needs a path. With no path UGV-1 stops and holds, and an approval that cannot reach it is not consumed. Link figures are a modelled budget, not measurements.</p></div>
      </header>
      <section className="cx-kpi-row">
        <div className={`cx-kpi-card ${ul.ok ? "" : "sev"}`}><span>UGV-1 command path</span><b className="sr-kpi-s">{linkLabel(mission)}</b></div>
        <div className="cx-kpi-card"><span>Hops</span><b>{ul.via === "direct" ? 1 : ul.via === "relay" ? 2 : "—"}</b></div>
        <div className="cx-kpi-card"><span>Est. latency</span><b className="sr-kpi-s">{latency}</b></div>
        <div className="cx-kpi-card"><span>UGV-1 to CP</span><b>{Math.round(links[0].dist)}<small> m</small></b><small className="cx-kpi-note">ground range {GROUND_RANGE} m</small></div>
        <div className="cx-kpi-card"><span>UAV-1 relay</span><b className="sr-kpi-s">{airborne ? (mission.linkFault.relay ? "Dropped" : "Airborne") : "On pad"}</b><small className="cx-kpi-note">battery {Math.round(mission.drone.battery * 100)}%</small></div>
        <div className="cx-kpi-card"><span>Link events</span><b>{log.length}</b></div>
      </section>
      <div className="sr-grid">
        <section className="sr-card">
          <div className="sr-card-h"><h3>Network</h3><span>positions live · {mission.live ? "Gazebo" : "replay"}</span></div>
          <svg className="cm-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Mission network: command post, UAV-1 and UGV-1 with link quality">
            <path d={roads} className="cm-roads" />
            <circle cx={P(cp).split(",")[0]} cy={P(cp).split(",")[1]} r={GROUND_RANGE * s} className="cm-range" />
            {links.map((l) => {
              const [a, b] = [nodes[l.a], nodes[l.b]];
              if (l.id === "uav-ugv" && !airborne) return null;
              if (l.id === "cp-uav" && !airborne) return null;
              const [ax, ay] = P(a).split(","), [bx, by] = P(b).split(",");
              const mx = (+ax + +bx) / 2, my = (+ay + +by) / 2;
              return (
                <g key={l.id}>
                  <line x1={ax} y1={ay} x2={bx} y2={by} stroke={qColor(l)} strokeWidth={l.up ? 3 : 2} strokeDasharray={l.up ? undefined : "6 5"} opacity={l.up ? 0.9 : 0.7} />
                  {active.has(l.id) && <line x1={l.id === "uav-ugv" ? ax : ax} y1={ay} x2={bx} y2={by} className="cm-flow" />}
                  <g transform={`translate(${mx},${my})`}><rect x={-46} y={-11} width={92} height={22} rx={11} className="cm-tag" /><text textAnchor="middle" dy="4" className="cm-tag-t">{l.up ? `${Math.round(l.dist)} m · ${rssi(l.q)} dBm` : l.fault ? "test: down" : "no link"}</text></g>
                </g>
              );
            })}
            <Node at={P(cp)} kind="cp" label="Command post" />
            <Node at={P(r)} kind="ugv" label={`UGV-1${ul.ok ? "" : " · HOLD"}`} bad={!ul.ok} />
            <Node at={P(d)} kind="uav" label={airborne ? `UAV-1 · ${mission.drone.alt} m` : "UAV-1 (pad)"} />
          </svg>
          <div className="sr-legend">
            <span><i style={{ background: "#188038" }} />Good</span><span><i style={{ background: "#e8a400" }} />Marginal</span><span><i style={{ background: "#d93025" }} />Down</span>
            <span><i className="k-flow" />Active command path</span><span><i className="k-ring" />Ground range from CP ({GROUND_RANGE} m)</span>
          </div>
        </section>
        <div className="cm-side">
          <section className="sr-card">
            <div className="sr-card-h"><h3>Links</h3><span>modelled</span></div>
            <ul className="cm-links">
              {links.map((l) => (
                <li key={l.id}>
                  <div className="cm-links-h"><b>{l.a} ↔ {l.b}</b><span className={`chip ${l.up ? (l.q > 0.5 ? "chip-ok" : "chip-warn") : "chip-bad"}`}>{l.up ? (l.q > 0.5 ? "Good" : "Marginal") : "Down"}</span></div>
                  <div className="cm-q"><span style={{ width: `${Math.round(l.q * 100)}%`, background: qColor(l) }} /></div>
                  <small>{l.kind === "ground" ? "Ground" : "Air"} · {Math.round(l.dist)} m · {l.up ? `${rssi(l.q)} dBm` : "—"} · {l.note}</small>
                </li>
              ))}
            </ul>
          </section>
          <section className="sr-card">
            <div className="sr-card-h"><h3>Link tests</h3><span>{live ? "replay only" : "simulated faults"}</span></div>
            <p className="sr-note">Inject a fault and watch the engine respond: UGV-1 stops when it has no path, and resumes on its own when the relay or the ground link returns.</p>
            <div className="cm-tests">
              <button className={`cm-test ${mission.linkFault.ground ? "on" : ""}`} aria-pressed={mission.linkFault.ground} disabled={live} onClick={() => mission.setLinkFault("ground", !mission.linkFault.ground)}><Unplug size={16} />{mission.linkFault.ground ? "Restore ground link" : "Jam direct ground link"}</button>
              <button className={`cm-test ${mission.linkFault.relay ? "on" : ""}`} aria-pressed={mission.linkFault.relay} disabled={live} onClick={() => mission.setLinkFault("relay", !mission.linkFault.relay)}><RadioTower size={16} />{mission.linkFault.relay ? "Restore UAV-1 relay" : "Drop UAV-1 relay"}</button>
            </div>
            {live && <p className="sr-note">In Gazebo live mode links are monitored and logged; the fail-safe stop is enforced in the replay engine.</p>}
          </section>
          <section className="sr-card">
            <div className="sr-card-h"><h3>Link events</h3><span>{log.length}</span></div>
            {log.length === 0 ? <p className="sr-note">No link events yet. Start the mission: UGV-1 hands over to the UAV-1 relay when it leaves ground range.</p> : (
              <ul className="cm-log">{log.slice(0, 12).map((a, i) => <li key={i}><span className="mono">{fmtSince(mission.sinceEvent - (mission.t - a.t))}</span><div><b>{a.action}</b><small>{a.detail}</small></div></li>)}</ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Node({ at, kind, label, bad }: { at: string; kind: "cp" | "uav" | "ugv"; label: string; bad?: boolean }) {
  const [x, y] = at.split(",").map(Number);
  return (
    <g transform={`translate(${x},${y})`} className={`cm-node ${kind} ${bad ? "bad" : ""}`}>
      {kind === "uav" ? <circle r={9} /> : <rect x={-8} y={-8} width={16} height={16} rx={kind === "cp" ? 2 : 4} />}
      {kind === "uav" && <circle r={16} className="cm-node-ring" />}
      <text x={14} y={-12} className="cm-node-t">{label}</text>
    </g>
  );
}
