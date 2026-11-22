import { useEffect, useMemo, useRef, useState } from "react";
import type { CaseData } from "../data/antakya";
import { HUSKY_PLAN_SPEED, X500_SWATH } from "../data/fleet";
import { sha256 } from "../lib/geo";
import { shortestPath } from "../lib/roadgraph";
import { Mission, fmtDur } from "../console/mission";
import { ImageSpace, View, fitCanvas, loadImage, scaled, validExtent } from "./imagery";
import { onFrame, progressOf, seg, smooth, useStage } from "./scroll";

const STAGES = [0, 0.38, 0.47, 0.7, 0.82];
const WORDS = ["Survey", "Verify", "Plan", "Approve", "Execute"];

/** The AegisLoop cycle, scrubbed by scroll on the real post-event imagery. */
export function LoopStory({ data }: { data: CaseData }) {
  const section = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const verifiedEl = useRef<HTMLSpanElement>(null);
  const stage = useStage(section, STAGES);
  const [hash, setHash] = useState("");

  const geo = useMemo(() => {
    const m = new Mission(data);
    const direct = shortestPath(m.graph, m.staging.node, m.target.node)!;
    const safe = shortestPath(m.graph, m.staging.node, m.target.node, (e) => e.grade >= 2)!;
    return { m, direct, safe };
  }, [data]);
  useEffect(() => {
    const body = JSON.stringify({ mission: "AOI-M1", version: 1, target: geo.m.target.label, unit: "husky-a300", nodes: geo.safe.nodes, speed: HUSKY_PLAN_SPEED });
    sha256(body).then(setHash);
  }, [geo]);

  useEffect(() => {
    const sec = section.current!, cv = canvas.current!, ctx = cv.getContext("2d")!;
    const space = new ImageSpace(data), { m, direct, safe } = geo;
    const toPx = (xy: [number, number]) => space.px(m.frame.toLngLat(xy));
    const survey = m.surveyPath.pts.map(toPx), routeD = direct.pts.map(toPx), routeV = safe.pts.map(toPx);
    const marks = m.blockedMarks(direct).map((ll) => space.px(ll));
    const staging = space.px(m.staging.at), target = space.px(m.target.at);
    const mb = data.meta.missionBounds, a = space.px([mb[0], mb[3]]), b = space.px([mb[2], mb[1]]);
    const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, S = b[0] - a[0];
    const pxPerM = S / 700, swathPx = X500_SWATH * pxPerM;
    // reveal time for each sector polygon = first time the drone passes within half a swath
    const samples: [number, number][] = []; for (let i = 0; i <= 400; i++) samples.push(View.along(survey, i / 400));
    const polys = space.polys(data).filter((q) => q.m === 1).map((q) => {
      let tr = 1; for (let i = 0; i < samples.length; i++) if (Math.hypot(samples[i][0] - q.cx, samples[i][1] - q.cy) < swathPx / 2) { tr = i / 400; break; }
      return { ...q, tr };
    });
    const total = data.buildings.features.filter((f) => f.properties.m === 1).length;
    const view = new View(ctx);
    let post: { src: CanvasImageSource; k: number } | null = null, lastP = -1, lastW = 0, ext: ReturnType<typeof validExtent> | undefined, visible = false;
    loadImage(`/data/antakya/imagery/${data.imagery!.scenes.post.layers.inner.file}`).then(async (i) => { const b = await scaled(i); ext = validExtent(b, i.naturalWidth, i.naturalHeight); post = b; lastP = -1; });
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting), { rootMargin: "200px" }); io.observe(sec);
    const dot = (x: number, y: number, r: number, fill: string, ring = "#fff", rw = 3) => {
      const [sx, sy] = view.toScreen(x, y), d = devicePixelRatio;
      ctx.beginPath(); ctx.arc(sx, sy, Math.max(0, r) * d, 0, Math.PI * 2); ctx.fillStyle = ring; ctx.fill();
      ctx.beginPath(); ctx.arc(sx, sy, Math.max(0, r - rw) * d, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
    };
    const sym = {
      label(sx: number, sy: number, text: string) {
        const d = devicePixelRatio; ctx.font = `600 ${10 * d}px Inter, sans-serif`; ctx.letterSpacing = `${1.2 * d}px`;
        const w = ctx.measureText(text).width + 12 * d;
        ctx.fillStyle = "rgba(11,12,16,0.82)"; ctx.beginPath(); ctx.roundRect(sx, sy - 9 * d, w, 18 * d, 4 * d); ctx.fill();
        ctx.fillStyle = "#fff"; ctx.textBaseline = "middle"; ctx.fillText(text, sx + 6 * d, sy + 0.5 * d); ctx.letterSpacing = "0px";
      },
      site(x: number, y: number, text: string, target: boolean) {
        const [sx, sy] = view.toScreen(x, y), d = devicePixelRatio;
        if (target) { ctx.strokeStyle = "#ff4d40"; ctx.lineWidth = 2 * d; ctx.beginPath(); ctx.arc(sx, sy, 8 * d, 0, 7); ctx.stroke(); ctx.fillStyle = "#ff4d40"; ctx.beginPath(); ctx.arc(sx, sy, 2 * d, 0, 7); ctx.fill(); }
        else { ctx.fillStyle = "#fff"; ctx.strokeStyle = "#0b0c10"; ctx.lineWidth = 2 * d; ctx.fillRect(sx - 4 * d, sy - 4 * d, 8 * d, 8 * d); ctx.strokeRect(sx - 4 * d, sy - 4 * d, 8 * d, 8 * d); }
        this.label(sx + 14 * d, sy, text);
      },
      cut(x: number, y: number, al: number) {
        const [sx, sy] = view.toScreen(x, y), d = devicePixelRatio; ctx.globalAlpha = al;
        ctx.fillStyle = "#ff4d40"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5 * d; ctx.beginPath(); ctx.arc(sx, sy, 3.5 * d, 0, 7); ctx.fill(); ctx.stroke(); ctx.globalAlpha = 1;
      },
      uav(x: number, y: number, hdg: number) {
        const [sx, sy] = view.toScreen(x, y), d = devicePixelRatio;
        ctx.save(); ctx.translate(sx, sy); ctx.rotate(hdg);
        ctx.fillStyle = "rgba(26,47,251,0.3)"; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 24 * d, -Math.PI / 2 - 0.45, -Math.PI / 2 + 0.45); ctx.closePath(); ctx.fill(); ctx.restore();
        ctx.fillStyle = "#1a2ffb"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2.2 * d; ctx.beginPath(); ctx.arc(sx, sy, 6 * d, 0, 7); ctx.fill(); ctx.stroke();
        this.label(sx + 14 * d, sy, "UAV-1");
      },
      ugv(x: number, y: number, hdg: number) {
        const [sx, sy] = view.toScreen(x, y), d = devicePixelRatio;
        ctx.save(); ctx.translate(sx, sy); ctx.rotate(hdg); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2 * d; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -14 * d); ctx.stroke();
        ctx.fillStyle = "#0b0c10"; ctx.beginPath(); ctx.roundRect(-6 * d, -6 * d, 12 * d, 12 * d, 2.5 * d); ctx.fill(); ctx.stroke(); ctx.restore();
        this.label(sx + 14 * d, sy, "UGV-1");
      },
    };
    void dot;
    const off = onFrame(() => {
      if (!visible) return;
      fitCanvas(cv);
      const p = progressOf(sec), d = devicePixelRatio;
      if (Math.abs(p - lastP) < 1e-4 && cv.width === lastW) return;
      lastP = p; lastW = cv.width;
      const asp = cv.width / cv.height;
      view.cx = cx; view.cy = cy; view.vw = S * (asp > 1 ? 1.18 * asp : 1.08) * (1.08 - 0.08 * smooth(seg(p, 0, 0.3))); view.clampTo(space.W, space.H, ext);
      ctx.fillStyle = "#121416"; ctx.fillRect(0, 0, cv.width, cv.height);
      if (post) view.image(post);
      // dim outside the sector
      const [ax, ay] = view.toScreen(a[0], a[1]), [bx, by] = view.toScreen(b[0], b[1]);
      ctx.fillStyle = "rgba(10,11,16,0.5)"; ctx.beginPath(); ctx.rect(0, 0, cv.width, cv.height); ctx.rect(ax, by, bx - ax, ay - by); ctx.fill("evenodd");
      ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1.5 * d; ctx.setLineDash([8 * d, 6 * d]); ctx.strokeRect(ax, ay, bx - ax, by - ay); ctx.setLineDash([]);

      const sp = seg(p, 0.04, 0.38);
      view.line(survey, sp, { color: "rgba(140,170,255,0.16)", width: swathPx * view.scale });
      view.line(survey, sp, { color: "rgba(255,255,255,0.4)", width: 1 * d });
      let nver = 0;
      for (const q of polys) { const al = smooth(seg(sp, q.tr, q.tr + 0.04)); if (al > 0) view.poly(q, al * (1 - 0.35 * seg(p, 0.5, 0.6))); }
      for (const f of polys) if (sp > f.tr) nver++;
      if (verifiedEl.current) verifiedEl.current.textContent = String(Math.round((sp >= 1 ? total : Math.min(total, sp * total * 1.03))));

      const dp = seg(p, 0.48, 0.58), vp = seg(p, 0.58, 0.68);
      view.line(routeD, dp, { color: "rgba(255,255,255,0.8)", width: 1.6 * d, dash: [5 * d, 5 * d] });
      if (dp > 0.6) marks.forEach(([x, y], i) => { const al = seg(dp, 0.6 + i * 0.08, 0.7 + i * 0.08); if (al > 0) sym.cut(x, y, al); });
      view.line(routeV, vp, { color: "#1a2ffb", width: 4 * d, casing: "rgba(255,255,255,0.9)" });

      sym.site(staging[0], staging[1], "STAGING", false);
      if (p > 0.4) sym.site(target[0], target[1], "C-1  COLLAPSE", true);
      // drone during survey, then overwatch orbit
      if (sp > 0 && p < 0.82) { const [x, y] = View.along(survey, sp), [x2, y2] = View.along(survey, Math.min(1, sp + 0.002)); sym.uav(x, y, Math.atan2(x2 - x, -(y2 - y))); }
      if (p >= 0.82) { const a2 = p * 40; sym.uav(target[0] + Math.cos(a2) * 60 * pxPerM, target[1] + Math.sin(a2) * 60 * pxPerM, a2 + Math.PI); }
      const ep = seg(p, 0.83, 0.98);
      const [rx, ry] = ep > 0 ? View.along(routeV, ep) : staging;
      if (p > 0.46) { const [qx, qy] = ep > 0 ? View.along(routeV, Math.min(1, ep + 0.01)) : [rx, ry - 1]; sym.ugv(rx, ry, Math.atan2(qx - rx, -(qy - ry))); }
      void nver;
    });
    return () => { off(); io.disconnect(); };
  }, [data, geo]);

  const s = data.meta.stats.mission;
  const info = [
    <>X500 · 60 m · 105 m swath · <span ref={verifiedEl}>0</span>/{s.buildings} structures verified</>,
    <>{s.destroyed} blocks destroyed · {s.damaged} damaged · {s.roadsBlocked} roads cut</>,
    <>Direct {Math.round(geo.direct.length)} m · {geo.direct.blocked.length} cut roads → rejected. Verified {Math.round(geo.safe.length)} m · clear.</>,
    <>PLN-001 · sha256 {hash.slice(0, 12)}… · OPS-1</>,
    <>Husky A300 · 1.0 m/s · {fmtDur(geo.safe.length / HUSKY_PLAN_SPEED)} · recorded</>,
  ];
  return (
    <section ref={section} className={`loopstory s${stage}`} aria-label="How AegisLoop works, on the Antakya sector">
      <div className="pin">
        <div className="stage-card">
          <canvas ref={canvas} className="stage-canvas" role="img" aria-label="Drone survey, route comparison, approval and rover execution over the Antakya sector" />
          <div className="ls-words" aria-live="polite">
            <span className="ls-count">0{Math.max(1, stage + 1)} / 05</span>
            <div className="ls-stack">
              {WORDS.map((w, i) => <h3 key={w} className={i === stage ? "on" : i < stage ? "past" : ""}>{w}.</h3>)}
            </div>
            <p className="ls-info">{info[Math.max(0, stage)]}</p>
          </div>
          <div className={`ls-stamp ${stage === 3 ? "on" : ""}`} aria-hidden={stage !== 3}>
            <span>Approved</span>
            <b>PLN-001 · v1</b>
            <code>{hash.slice(0, 32)}</code>
          </div>
          <div className="ls-legend">
            <span><i className="d-staging" />Staging</span><span><i className="d-target" />Collapse C-1</span><span><i className="d-route" />Verified route</span><span><i className="d-cut" />Cut road</span>
          </div>
        </div>
      </div>
    </section>
  );
}
