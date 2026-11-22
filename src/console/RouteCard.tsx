// Route card: a one-page, printable (Save as PDF) brief a responder can follow without the console.
// Satellite map of the approved route with numbered turns, hazards and relay stretches; turn-by-turn directions;
// distances, ETA, comms and fail-safe rules; plan id, hash and approval; provenance.
import { useEffect, useMemo, useRef } from "react";
import { Printer, X } from "lucide-react";
import type { CaseData } from "../data/antakya";
import { GRADE_COLOR } from "../data/antakya";
import { HUSKY_PLAN_SPEED } from "../data/fleet";
import { type LngLat, type XY, fmtLatLng } from "../lib/geo";
import { type Mission, fmtClock, fmtDur, fmtSince } from "./mission";

const W = 900, H = 520;
const lon2x = (lon: number, z: number) => ((lon + 180) / 360) * 256 * 2 ** z;
const lat2y = (lat: number, z: number) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 256 * 2 ** z; };
const loadImg = (src: string) => new Promise<HTMLImageElement | null>((res) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });

function CardMap({ mission, data }: { mission: Mission; data: CaseData }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const plan = mission.plan!, opt = plan.options.find((o) => o.id === plan.chosen)!;
  const legs = useMemo(() => mission.routeLegs(opt.route), [mission, opt]);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    let cancelled = false;
    (async () => {
      const dpr = 2; cv.width = W * dpr; cv.height = H * dpr;
      const ctx = cv.getContext("2d")!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // frame: the route plus a margin, fitted to the card's aspect ratio
      const ll = opt.route.pts.map((p) => mission.frame.toLngLat(p));
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      const Z0 = 18;
      for (const [lo, la] of ll) { const x = lon2x(lo, Z0), y = lat2y(la, Z0); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const pad = 0.14 * Math.max(x1 - x0, y1 - y0) + 40;
      x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
      const ar = W / H; if ((x1 - x0) / (y1 - y0) > ar) { const c = (y0 + y1) / 2, h = (x1 - x0) / ar; y0 = c - h / 2; y1 = c + h / 2; } else { const c = (x0 + x1) / 2, w = (y1 - y0) * ar; x0 = c - w / 2; x1 = c + w / 2; }
      const s = W / (x1 - x0);                                   // canvas px per z18 px
      const P = (c: LngLat): [number, number] => [(lon2x(c[0], Z0) - x0) * s, (lat2y(c[1], Z0) - y0) * s];
      const PX = (p: XY) => P(mission.frame.toLngLat(p));
      // satellite: our Maxar tiles where they exist, else Sentinel-2 cloudless
      ctx.fillStyle = "#2a2f38"; ctx.fillRect(0, 0, W, H);
      const local = !!data.tiles, zt = Math.max(12, Math.min(local ? 18 : 15, Math.round(Z0 + Math.log2(s))));
      const k = 2 ** (Z0 - zt), tx0 = Math.floor(x0 / k / 256), tx1 = Math.floor(x1 / k / 256), ty0 = Math.floor(y0 / k / 256), ty1 = Math.floor(y1 / k / 256);
      const jobs: Promise<void>[] = [];
      for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
        const url = local ? `/data/antakya/tiles/post/${zt}/${tx}/${ty}.jpg` : `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/g/${zt}/${ty}/${tx}.jpg`;
        jobs.push(loadImg(url).then((img) => { if (img && !cancelled) ctx.drawImage(img, (tx * 256 * k - x0) * s, (ty * 256 * k - y0) * s, 256 * k * s + 0.5, 256 * k * s + 0.5); }));
      }
      await Promise.all(jobs);
      if (cancelled) return;
      ctx.fillStyle = "rgba(10,12,18,0.35)"; ctx.fillRect(0, 0, W, H);
      // buildings near the route, coloured by the scenario's grade once UAV-1 has verified them
      ctx.lineWidth = 1;
      for (const f of data.buildings.features) {
        if (f.geometry.type !== "Polygon") continue;
        const ring = (f.geometry.coordinates[0] as LngLat[]).map(P);
        if (ring.every(([x, y]) => x < -20 || y < -20 || x > W + 20 || y > H + 20)) continue;
        const g = mission.buildingGrade(f.properties.id), v = mission.verified.has(f.properties.id);
        ctx.beginPath(); ring.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
        if (v && g >= 1) { ctx.fillStyle = GRADE_COLOR[g as 1 | 2 | 3] + (g === 3 ? "b0" : "70"); ctx.fill(); ctx.strokeStyle = GRADE_COLOR[g as 1 | 2 | 3]; ctx.stroke(); }
        else { ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.stroke(); }
      }
      // rejected direct route
      for (const o of plan.options) if (!o.eligible) {
        ctx.setLineDash([6, 5]); ctx.strokeStyle = "rgba(255,90,80,0.9)"; ctx.lineWidth = 2.2;
        ctx.beginPath(); o.route.pts.forEach((p, i) => { const [x, y] = PX(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke(); ctx.setLineDash([]);
      }
      // approved route: white casing, blue line, amber where the UAV-1 relay is needed
      const pts = opt.route.pts.map(PX);
      for (const [w, c] of [[9, "#ffffff"], [5, "#1a2ffb"]] as const) { ctx.strokeStyle = c; ctx.lineWidth = w; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); }
      const relayOn = (p: XY) => mission.relayAt(p);
      ctx.strokeStyle = "#f5a400"; ctx.lineWidth = 5;
      for (let i = 1; i < opt.route.pts.length; i++) { const a = opt.route.pts[i - 1], b = opt.route.pts[i], m: XY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; if (relayOn(m)) { const [ax, ay] = PX(a), [bx, by] = PX(b); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); } }
      // turn numbers
      ctx.font = "700 11px Inter, Arial, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      legs.forEach((l, i) => {
        if (i === 0 || i === legs.length - 1) return;
        const [x, y] = P(l.at); ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fillStyle = "#ffffff"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#1a2ffb"; ctx.stroke();
        ctx.fillStyle = "#1a2ffb"; ctx.fillText(String(l.n), x, y + 0.5);
      });
      // start and destination
      const [sx, sy] = P(legs[0].at), [dx, dy] = P(legs[legs.length - 1].at);
      ctx.fillStyle = "#0b0c10"; ctx.fillRect(sx - 9, sy - 9, 18, 18); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.strokeRect(sx - 9, sy - 9, 18, 18);
      ctx.fillStyle = "#fff"; ctx.fillText("S", sx, sy + 0.5);
      ctx.beginPath(); ctx.arc(dx, dy, 11, 0, Math.PI * 2); ctx.fillStyle = "#e5332a"; ctx.fill(); ctx.strokeStyle = "#fff"; ctx.stroke();
      ctx.fillStyle = "#fff"; ctx.fillText(plan.target, dx, dy + 0.5);
      // north arrow + scale bar
      const mpp = (40075016.686 * Math.cos((ll[0][1] * Math.PI) / 180)) / (256 * 2 ** Z0) / s;
      const bar = [50, 100, 200, 500].find((m) => m / mpp > 70) ?? 500, bw = bar / mpp;
      ctx.fillStyle = "rgba(255,255,255,0.92)"; ctx.fillRect(12, H - 34, bw + 70, 22);
      ctx.fillStyle = "#0b0c10"; ctx.fillRect(20, H - 25, bw, 4); ctx.textAlign = "left"; ctx.font = "600 11px Inter, Arial, sans-serif"; ctx.fillText(`${bar} m`, 26 + bw, H - 23);
      ctx.beginPath(); ctx.moveTo(W - 24, 14); ctx.lineTo(W - 16, 34); ctx.lineTo(W - 32, 34); ctx.closePath(); ctx.fillStyle = "#fff"; ctx.fill();
      ctx.textAlign = "center"; ctx.fillText("N", W - 24, 46);
    })();
    return () => { cancelled = true; };
  }, [mission, data, opt, plan, legs]);
  return <canvas ref={ref} className="rc-map" style={{ aspectRatio: `${W} / ${H}` }} role="img" aria-label="Map of the approved route with numbered turns" />;
}

export function RouteCard({ mission, data, onClose }: { mission: Mission; data: CaseData; onClose: () => void }) {
  const plan = mission.plan;
  if (!plan) return null;
  const opt = plan.options.find((o) => o.id === plan.chosen)!;
  const legs = mission.routeLegs(opt.route), c = opt.comms ?? mission.routeComms(opt.route);
  const approved = mission.approvedHash === plan.hash, clk = fmtClock(mission.clock);
  const place = data.meta.origin === "osm" ? data.meta.title : "Antakya, Hatay";
  const start = mission.frame.toLngLat(opt.route.pts[0]), end = mission.frame.toLngLat(opt.route.pts[opt.route.pts.length - 1]);
  const approval = mission.audit.slice().reverse().find((a) => a.action === "Plan approved" && a.hash === plan.hash);
  const print = () => {
    const root = document.querySelector(".cx"); root?.classList.add("print-rc");
    const done = () => { root?.classList.remove("print-rc"); removeEventListener("afterprint", done); };
    addEventListener("afterprint", done); window.print(); setTimeout(done, 1500);
  };
  return (
    <div className="cx-page rc">
      <div className="rc-bar no-print"><b>Route card</b><div><button className="btn btn-primary btn-sm" onClick={print}><Printer size={15} />Save as PDF</button><button className="cx-icon" onClick={onClose} aria-label="Close route card"><X size={16} /></button></div></div>
      <article className="rc-sheet">
        {!approved && <div className="rc-stamp" aria-label="Not approved">NOT APPROVED · DO NOT EXECUTE</div>}
        <header className="rc-h">
          <div><span className="rc-kicker">AegisLoop · Ground route card</span><h1>{plan.id} · v{plan.version} → {plan.target}</h1>
            <p>{place} · {mission.scenarioName} · UGV-1 Clearpath Husky A300 · {opt.label}</p></div>
          <div className="rc-meta"><span>Issued {clk.date} {clk.time} TRT ({fmtSince(mission.sinceEvent)})</span><span>{approved ? `Approved by ${plan.approvedBy ?? mission.approvedBy}${approval ? ` at ${fmtSince(mission.sinceEvent - (mission.t - approval.t))}` : ""}` : "Awaiting Ops Commander approval"}</span></div>
        </header>
        <dl className="rc-kpis">
          <div><dt>Distance</dt><dd>{Math.round(opt.route.length)} m</dd></div>
          <div><dt>Drive time</dt><dd>{fmtDur(opt.route.length / HUSKY_PLAN_SPEED)}</dd><small>at {HUSKY_PLAN_SPEED.toFixed(1)} m/s</small></div>
          <div><dt>Turns</dt><dd>{Math.max(0, legs.length - 2)}</dd></div>
          <div><dt>Collapsed within 12 m</dt><dd>{opt.risk ?? opt.hazardsNear}</dd></div>
          <div><dt>Needs UAV-1 relay</dt><dd>{Math.round(c.relay)} m</dd><small>{c.relay > 1 ? `${fmtDur(c.relayTime)} of overwatch` : "direct link all the way"}</small></div>
          <div><dt>No link</dt><dd>{Math.round(c.nolink)} m</dd></div>
        </dl>
        <CardMap mission={mission} data={data} />
        <div className="rc-legend"><span><i className="l-route" />Approved route</span><span><i className="l-relay" />Needs UAV-1 relay</span><span><i className="l-rej" />Rejected direct route</span><span><i style={{ background: GRADE_COLOR[3] }} />Collapsed / blocked</span><span><i style={{ background: GRADE_COLOR[2] }} />Damaged</span><span><i className="l-s">S</i>Start</span></div>
        <div className="rc-cols">
          <section>
            <h2>Directions</h2>
            <table className="rc-table">
              <thead><tr><th>#</th><th>Instruction</th><th>Leg</th><th>Total</th><th>Notes</th></tr></thead>
              <tbody>{legs.map((l) => (
                <tr key={l.n}><td className="n">{l.n}</td><td>{l.instruction}</td><td className="mono">{l.length ? `${Math.round(l.length)} m` : ""}</td><td className="mono">{Math.round(l.cum)} m</td>
                  <td className="notes">{[l.relay > 1 ? `relay ${Math.round(l.relay)} m` : "", l.hazards ? `${l.hazards} collapsed within 12 m` : ""].filter(Boolean).join(" · ")}</td></tr>
              ))}</tbody>
            </table>
          </section>
          <section>
            <h2>Rules for this route</h2>
            <ul className="rc-rules">
              <li><b>Stay on the route.</b> Every segment was observed by UAV-1 and is passable. Anything off it is unverified and counts as impassable.</li>
              <li><b>Command link.</b> {c.relay > 1 ? `For ${Math.round(c.relay)} m UGV-1 is out of direct ground range and depends on the UAV-1 airborne relay.` : "UGV-1 stays inside direct ground range from the command post."} If the link drops, UGV-1 stops and holds until it returns (fail-safe).</li>
              <li><b>Anything new on the route</b> (debris, water, fire, people) means hold and report. A re-plan needs a new approval.</li>
              <li><b>This card is valid only for {plan.id} v{plan.version}</b> and the world state it was approved in. A newer plan version replaces it.</li>
            </ul>
            <h2>Points</h2>
            <dl className="rc-pts"><div><dt>Start</dt><dd className="mono">{fmtLatLng(start)}</dd></div><div><dt>Destination {plan.target}</dt><dd className="mono">{fmtLatLng(end)}</dd></div></dl>
            <h2>Plan integrity</h2>
            <code className="rc-hash">sha256 {plan.hash}</code>
          </section>
        </div>
        <footer className="rc-foot">{data.meta.origin === "osm" ? "Buildings, roads and water © OpenStreetMap contributors (ODbL) · imagery Sentinel-2 cloudless by EOX" : "Imagery © Maxar Open Data Program (CC BY-NC 4.0) · damage grading © European Union, Copernicus EMS EMSR648 · roads © OpenStreetMap contributors"} · Robots, mission{mission.spec.kind !== "earthquake" || data.meta.origin === "osm" ? ", hazard" : ""} and radio links are simulated. Not an operational document.</footer>
      </article>
    </div>
  );
}
