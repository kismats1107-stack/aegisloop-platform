/**
 * UAV-1 nadir camera feed (operator monitor).
 * The image is RENDERED from the real Maxar post-event imagery (11 Feb 2023) at the drone's live position and heading;
 * it is not a video stream. Damage overlays are the Copernicus EMS grades of what is inside the footprint, shown only
 * once UAV-1 has observed them. Severity labels map Copernicus grades: Destroyed = Severe, Damaged = High, Possibly = Moderate.
 */
import { useEffect, useRef, useState } from "react";
import type { CaseData } from "../data/antakya";
import { ImageSpace, loadImage } from "../landing/imagery";
import type { Finding, Mission } from "./mission";
import { fmtLatLng } from "../lib/geo";
import { fmtClock } from "./mission";

type Bmp = { src: CanvasImageSource; k: number };
export const SEVERITY: Record<number, { label: string; color: string }> = {
  3: { label: "Severe", color: "#ff4d40" }, 2: { label: "High", color: "#ff9a3c" }, 1: { label: "Moderate", color: "#f2c94c" }, 0: { label: "Low", color: "#5fd27a" },
};
const KIND_LABEL: Record<string, string> = { collapse: "Building collapse", road: "Road cut", barrier: "Road barrier", camp: "People gathered", incident: "New obstruction", signal: "Signal of interest", damaged: "Building damage" };
const VIEW_M = 180;                 // ground width shown (camera footprint 105 m, dashed, plus context)

export function findingSeverity(f: Finding): { label: string; color: string } {
  if (f.kind === "collapse" || f.kind === "incident") return SEVERITY[3];
  if (f.kind === "road") return f.title.includes("destroyed") ? SEVERITY[3] : SEVERITY[2];
  if (f.kind === "barrier") return SEVERITY[2];
  return { label: "Info", color: "#6c8cff" };
}

/** Pixel space shared by Maxar (ImageSpace) and a Web-Mercator tile mosaic (any city). */
interface PxSpace { px(c: [number, number]): [number, number] }
const lon2x = (lon: number, z: number) => ((lon + 180) / 360) * 256 * 2 ** z;
const lat2y = (lat: number, z: number) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 256 * 2 ** z; };
function polysOf(sp: PxSpace, data: CaseData) {
  const out: { pts: [number, number][]; id: string; cx: number; cy: number }[] = [];
  for (const f of data.buildings.features) {
    if (f.geometry.type !== "Polygon") continue;
    const pts = (f.geometry.coordinates[0] as [number, number][]).map((c) => sp.px(c));
    out.push({ pts, id: f.properties.id, cx: pts.reduce((a, p) => a + p[0], 0) / pts.length, cy: pts.reduce((a, p) => a + p[1], 0) / pts.length });
  }
  return out;
}
/** Sentinel-2 cloudless mosaic of the place at z16 pixel space (z15 tiles, the free layer's limit, upsampled). */
async function tileMosaic(data: CaseData) {
  const Z = 16, b = data.meta.contextBounds, x0 = lon2x(b[0], Z), y0 = lat2y(b[3], Z), x1 = lon2x(b[2], Z), y1 = lat2y(b[1], Z);
  const sp: PxSpace = { px: ([lo, la]) => [lon2x(lo, Z) - x0, lat2y(la, Z) - y0] };
  const c = document.createElement("canvas"); c.width = Math.ceil(x1 - x0); c.height = Math.ceil(y1 - y0);
  const ctx = c.getContext("2d")!; ctx.fillStyle = "#1b2026"; ctx.fillRect(0, 0, c.width, c.height);
  const t0x = Math.floor(x0 / 512), t1x = Math.floor(x1 / 512), t0y = Math.floor(y0 / 512), t1y = Math.floor(y1 / 512);
  const jobs: Promise<void>[] = [];
  for (let tx = t0x; tx <= t1x; tx++) for (let ty = t0y; ty <= t1y; ty++) jobs.push(new Promise((res) => {
    const im = new Image(); im.crossOrigin = "anonymous";
    im.onload = () => { ctx.imageSmoothingQuality = "high"; ctx.drawImage(im, tx * 512 - x0, ty * 512 - y0, 512, 512); res(); };
    im.onerror = () => res();
    im.src = `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/g/15/${ty}/${tx}.jpg`;
  }));
  await Promise.all(jobs);
  const lat = (b[1] + b[3]) / 2, pxPerM = (256 * 2 ** Z) / (40075016.686 * Math.cos((lat * Math.PI) / 180));
  return { sp, src: c as CanvasImageSource, pxPerM };
}

export function UavFeed({ mission, data, active }: { mission: Mission; data: CaseData; active: boolean }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const [bmp, setBmp] = useState<Bmp | null>(null);
  const thumbs = useRef(new Map<string, string>());
  const [, setTick] = useState(0);
  const space = useRef<PxSpace | null>(null);
  const geo = useRef<{ polys: ReturnType<typeof polysOf>; roads: { id: string; g: number; pts: [number, number][] }[]; pxPerM: number } | null>(null);

  useEffect(() => {
    let off = false;
    const roadsIn = (sp: PxSpace) => data.roads.features.map((f, i) => ({ f, i })).filter(({ f }) => f.geometry.type === "LineString")
      .map(({ f, i }) => ({ id: `r${i}`, g: f.properties.g, pts: (f.geometry as GeoJSON.LineString).coordinates.map((c) => sp.px(c as [number, number])) }));
    if (data.imagery) {
      const sp = new ImageSpace(data); space.current = sp;
      const mb = data.meta.missionBounds, a = sp.px([mb[0], mb[3]]), b = sp.px([mb[2], mb[1]]);
      geo.current = { polys: polysOf(sp, data), roads: roadsIn(sp), pxPerM: (b[0] - a[0]) / 700 };
      loadImage(`/data/antakya/imagery/${data.imagery.scenes.post.layers.inner.file}`)
        .then(async (img) => { if (!off) setBmp({ src: "createImageBitmap" in window ? await createImageBitmap(img) : img, k: 1 }); });   // full resolution (~0.5 m/px)
    } else {
      void tileMosaic(data).then(({ sp, src, pxPerM }) => { if (off) return; space.current = sp; geo.current = { polys: polysOf(sp, data), roads: roadsIn(sp), pxPerM }; setBmp({ src, k: 1 }); });
    }
    return () => { off = true; };
  }, [data]);

  // render loop
  useEffect(() => {
    if (!active) return;
    let raf = 0, frame = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = cv.current, sp = space.current, g = geo.current;
      if (!c || !sp || !g || !bmp) return;
      const dpr = Math.min(devicePixelRatio, 1.5), W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      const ctx = c.getContext("2d")!;
      const d = mission.drone, [cx, cy] = sp.px(d.at), rot = (-d.hdg * Math.PI) / 180;
      const viewPx = VIEW_M * g.pxPerM * Math.max(0.55, Math.min(1.4, (d.alt || 60) / 60)), s = W / viewPx;
      const airborne = (d.alt ?? 0) > 5;
      ctx.fillStyle = "#05070a"; ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.translate(W / 2, H / 2); ctx.rotate(rot); ctx.scale(s, s); ctx.translate(-cx, -cy);
      const r = viewPx * 1.2;
      ctx.drawImage(bmp.src, (cx - r) * bmp.k, (cy - r) * bmp.k, 2 * r * bmp.k, 2 * r * bmp.k, cx - r, cy - r, 2 * r, 2 * r);
      // damaged roads (observed only)
      const seen = new Set(mission.findings.map((f) => f.id));
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      for (const rd of g.roads) {
        if (!seen.has(rd.id) || Math.hypot(rd.pts[0][0] - cx, rd.pts[0][1] - cy) > r * 1.5) continue;
        ctx.strokeStyle = SEVERITY[mission.spec.kind === "earthquake" && mission.realDamage ? Math.max(2, rd.g) : 3].color; ctx.globalAlpha = 0.85; ctx.lineWidth = 5 / s * dpr;
        ctx.beginPath(); rd.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // graded buildings inside the frame (observed only)
      const labels: { x: number; y: number; text: string; color: string }[] = [];
      for (const p of g.polys) {
        const pg = mission.buildingGrade(p.id);
        if (pg < 1 || !mission.verified.has(p.id) || Math.hypot(p.cx - cx, p.cy - cy) > r) continue;
        const col = SEVERITY[pg]?.color ?? "#fff";
        ctx.strokeStyle = col; ctx.lineWidth = 2.2 / s * dpr; ctx.fillStyle = col; ctx.globalAlpha = 0.16;
        ctx.beginPath(); p.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 1; ctx.stroke();
        if (pg >= 2) labels.push({ x: p.cx, y: p.cy, text: `${pg === 3 ? (mission.spec.kind === "flood" ? "FLOODED" : mission.spec.kind === "fire" ? "FIRE" : "COLLAPSE") : "DAMAGE"} · ${SEVERITY[pg].label.toUpperCase()}`, color: col });
      }
      ctx.restore();
      // labels upright in screen space
      ctx.font = `600 ${11 * dpr}px Inter, sans-serif`;
      for (const l of labels.slice(0, 8)) {
        const dx = (l.x - cx) * s, dy = (l.y - cy) * s, x = W / 2 + dx * Math.cos(rot) - dy * Math.sin(rot), y = H / 2 + dx * Math.sin(rot) + dy * Math.cos(rot);
        if (x < 20 || y < 20 || x > W - 20 || y > H - 20) continue;
        const tw = ctx.measureText(l.text).width;
        ctx.fillStyle = "rgba(5,7,10,0.78)"; ctx.fillRect(x + 10 * dpr, y - 9 * dpr, tw + 12 * dpr, 18 * dpr);
        ctx.fillStyle = l.color; ctx.fillRect(x + 10 * dpr, y - 9 * dpr, 3 * dpr, 18 * dpr);
        ctx.fillStyle = "#fff"; ctx.fillText(l.text, x + 17 * dpr, y + 4 * dpr);
        ctx.strokeStyle = l.color; ctx.lineWidth = 1.5 * dpr; ctx.beginPath(); ctx.arc(x, y, 4 * dpr, 0, 7); ctx.stroke();
      }
      // footprint, reticle, scanline
      const fp = 105 * g.pxPerM * s;
      ctx.strokeStyle = "rgba(140,190,255,0.55)"; ctx.lineWidth = 1 * dpr; ctx.setLineDash([6 * dpr, 6 * dpr]);
      ctx.strokeRect(W / 2 - fp / 2, H / 2 - fp / 2, fp, fp); ctx.setLineDash([]);
      ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1.5 * dpr;
      const cl = 14 * dpr; ctx.beginPath();
      ctx.moveTo(W / 2 - cl * 2, H / 2); ctx.lineTo(W / 2 - cl * 0.6, H / 2); ctx.moveTo(W / 2 + cl * 0.6, H / 2); ctx.lineTo(W / 2 + cl * 2, H / 2);
      ctx.moveTo(W / 2, H / 2 - cl * 2); ctx.lineTo(W / 2, H / 2 - cl * 0.6); ctx.moveTo(W / 2, H / 2 + cl * 0.6); ctx.lineTo(W / 2, H / 2 + cl * 2); ctx.stroke();
      if (airborne && mission.phase === "survey") {
        const sy = ((frame * 4) % H); const grd = ctx.createLinearGradient(0, sy - 30 * dpr, 0, sy);
        grd.addColorStop(0, "rgba(108,160,255,0)"); grd.addColorStop(1, "rgba(108,160,255,0.22)"); ctx.fillStyle = grd; ctx.fillRect(0, sy - 30 * dpr, W, 30 * dpr);
      }
      // vignette + standby
      const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
      vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,0,0.55)"); ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
      if (!airborne) { ctx.fillStyle = "rgba(5,7,10,0.6)"; ctx.fillRect(0, 0, W, H); }
      frame++;
      if (frame % 15 === 0) setTick((t) => t + 1);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [active, bmp, mission]);

  // thumbnails cropped from the real imagery
  const thumb = (f: Finding) => {
    const hit = thumbs.current.get(f.id); if (hit) return hit;
    const sp = space.current; if (!sp || !bmp || !geo.current) return "";
    const [x, y] = sp.px(f.at), half = 35 * geo.current.pxPerM;
    const c = document.createElement("canvas"); c.width = 128; c.height = 96;
    c.getContext("2d")!.drawImage(bmp.src, (x - half * 1.33) * bmp.k, (y - half) * bmp.k, half * 2.66 * bmp.k, half * 2 * bmp.k, 0, 0, 128, 96);
    const url = c.toDataURL("image/jpeg", 0.8); thumbs.current.set(f.id, url); return url;
  };

  const d = mission.drone, clk = fmtClock(mission.clock), airborne = (d.alt ?? 0) > 5;
  const dets = mission.findings.filter((f) => f.kind !== "signal").slice(0, 40);
  const counts = { severe: dets.filter((f) => findingSeverity(f).label === "Severe").length, high: dets.filter((f) => findingSeverity(f).label === "High").length };
  const bat = Math.round(d.battery * 100), cardinal = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round((((d.hdg % 360) + 360) % 360) / 45) % 8];
  return (
    <div className="uf">
      <div className="uf-cam">
        <canvas ref={cv} className="uf-canvas" role="img" aria-label="UAV-1 nadir camera view rendered from satellite imagery with damage overlays" />
        <div className="uf-hud tl">
          <span className={`uf-rec ${airborne ? "on" : ""}`}><i />{airborne ? "REC" : "STANDBY"}</span>
          <b>UAV-1 · NADIR CAM</b><small>{data.imagery ? "Rendered from Maxar imagery · 11 Feb 2023" : "Rendered from Sentinel-2 imagery (10 m) · OpenStreetMap buildings"} · {mission.live ? "pose from Gazebo" : "replay pose"}</small>
        </div>
        <div className="uf-hud tr mono"><span>{clk.date}</span><b>{clk.time} TRT</b></div>
        <div className="uf-hud bl mono">
          <div><small>ALT</small><b>{Math.round(d.alt ?? 0)} m</b></div>
          <div><small>SPD</small><b>{d.speed.toFixed(1)} m/s</b></div>
          <div><small>HDG</small><b>{Math.round(((d.hdg % 360) + 360) % 360)}° {cardinal}</b></div>
          <div><small>BAT</small><b className={bat < 30 ? "low" : ""}>{bat}%</b></div>
        </div>
        <div className="uf-hud br mono"><small>{fmtLatLng(d.at)}</small><small>{d.status}</small></div>
        <div className="uf-legend">{[3, 2, 1].map((g) => <span key={g}><i style={{ background: SEVERITY[g].color }} />{SEVERITY[g].label}</span>)}<em>{data.imagery && mission.spec.kind === "earthquake" ? "Severity = Copernicus EMS grade" : "Severity = simulated hazard"}</em></div>
      </div>
      <aside className="uf-side" aria-label="Detections">
        <div className="uf-side-h">
          <b>Detections</b>
          <span className="uf-counts"><i className="sev" />{counts.severe} severe <i className="hi" />{counts.high} high</span>
        </div>
        <p className="uf-note">{data.imagery && mission.spec.kind === "earthquake" ? "Modelled perception: the Copernicus grade of what enters UAV-1's footprint. Thumbnails are real Maxar crops." : `Modelled perception: the simulated ${mission.spec.kind} damage of what enters UAV-1's footprint. Thumbnails are ${data.imagery ? "real Maxar" : "Sentinel-2"} crops.`}</p>
        <ul className="uf-list">
          {dets.length === 0 && <li className="uf-empty">No detections yet. Authorise the aerial survey.</li>}
          {dets.map((f) => { const sv = findingSeverity(f); return (
            <li key={f.id + f.t} className="uf-det" style={{ "--sev": sv.color } as React.CSSProperties}>
              <img src={thumb(f)} alt="" width={96} height={72} />
              <div><b>{KIND_LABEL[f.kind] ?? f.title}</b><span className="uf-sev">{sv.label}</span><small>{f.detail}</small><small className="mono">{fmtLatLng(f.at)}</small></div>
            </li>
          ); })}
        </ul>
      </aside>
    </div>
  );
}
