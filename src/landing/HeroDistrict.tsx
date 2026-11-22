import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUpRight } from "lucide-react";
import * as THREE from "three";
import type { CaseData } from "../data/antakya";
import { buildDistrict } from "../three/district";
import { onFrame, reducedMotion } from "./scroll";

/** Full-bleed hero: a live point-cloud twin of the real Antakya sector, scanned by the drone. */
export function HeroDistrict({ data }: { data: CaseData | null }) {
  const host = useRef<HTMLDivElement>(null);
  const scanEl = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!data?.imagery) return;
    const cv = document.createElement("canvas"); cv.className = "hx-canvas"; cv.setAttribute("role", "img"); cv.setAttribute("aria-label", "Point-cloud model of central Antakya built from Maxar imagery of 11 February 2023, coloured by Copernicus damage grade");
    host.current!.appendChild(cv);
    const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.setClearColor("#07080b", 1);
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog("#07080b", 420, 720);
    const camera = new THREE.PerspectiveCamera(34, 1, 1, 1000);
    const drone = new THREE.Group();
    const core = new THREE.Mesh(new THREE.SphereGeometry(1.3, 20, 14), new THREE.MeshBasicMaterial({ color: "#5b6cff" }));
    const halo = new THREE.Mesh(new THREE.SphereGeometry(3.2, 20, 14), new THREE.MeshBasicMaterial({ color: "#1a2ffb", transparent: true, opacity: 0.25 }));
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 18, 6), new THREE.MeshBasicMaterial({ color: "#8a96ff", transparent: true, opacity: 0.35 }));
    beam.position.y = -9; drone.add(core, halo, beam); scene.add(drone);
    let disposed = false, district: Awaited<ReturnType<typeof buildDistrict>> | null = null;
    const resize = () => { const w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); if (district) district.material.uniforms.uPixel.value = renderer.domElement.height * 0.3;
      const wide = w / h > 1.1; camera.setViewOffset(w, h, wide ? -w * 0.13 : 0, wide ? 0 : h * 0.12, w, h); };
    const ro = new ResizeObserver(resize); ro.observe(cv);
    buildDistrict(data, { step: 2, extent: 1.55 }).then((d) => {
      if (disposed) return;
      district = d; scene.add(d.points); resize(); renderer.compile(scene, camera); cv.classList.add("on"); setReady(true);
    });
    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    const onMove = (e: PointerEvent) => { mouse.tx = e.clientX / innerWidth - 0.5; mouse.ty = e.clientY / innerHeight - 0.5; };
    addEventListener("pointermove", onMove);
    let visible = true; const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting)); io.observe(cv);
    const calm = reducedMotion();
    const off = onFrame((t) => {
      if (!visible || !district) return;
      const s = t / 1000, sc = Math.min(1, scrollY / innerHeight);
      mouse.x += (mouse.tx - mouse.x) * 0.04; mouse.y += (mouse.ty - mouse.y) * 0.04;
      // drone along the survey pattern, 90 s per sweep
      const path = district.scanPath, u = calm ? 0.45 : (s / 90) % 1, f = u * (path.length - 1), i = Math.floor(f);
      const p = path[i].clone().lerp(path[Math.min(path.length - 1, i + 1)], f - i);
      drone.position.copy(p).setY(18 + Math.sin(s * 2) * 0.4);
      halo.scale.setScalar(1 + Math.sin(s * 3) * 0.15);
      const U = district.material.uniforms;
      U.uTime.value = s; U.uScanPos.value.copy(drone.position); U.uReveal.value = u;
      if (scanEl.current) scanEl.current.textContent = `${Math.round(u * 100)}%`;
      const ang = (calm ? 0.6 : s * 0.035) + mouse.x * 0.5;
      const dist = 380 - sc * 120, elev = 0.34 - mouse.y * 0.08 - sc * 0.06;
      camera.position.set(Math.sin(ang) * dist * Math.cos(elev), Math.sin(elev) * dist, Math.cos(ang) * dist * Math.cos(elev));
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    });
    return () => { disposed = true; off(); io.disconnect(); ro.disconnect(); removeEventListener("pointermove", onMove); district?.points.geometry.dispose(); district?.material.dispose(); renderer.dispose(); cv.remove(); };
  }, [data]);

  const st = data?.meta.stats.mission;
  return (
    <section className="hx">
      <div ref={host} className={`hx-host ${ready ? "ready" : ""}`} />
      <div className="hx-grad" aria-hidden="true" />
      <div className="hx-copy">
        <span className="hx-kicker"><i />Live twin · Antakya, Hatay · 6 Feb 2023</span>
        <h1>Know the ground<br />before anyone moves.</h1>
        <p>Drones verify the damage. Robots take the safe route. People approve every move.</p>
        <div className="hx-cta">
          <Link to="/console" className="hx-btn primary">Open the console <ArrowUpRight size={18} aria-hidden /></Link>
          <a href="#quake" className="hx-btn" onClick={(e) => { e.preventDefault(); document.querySelector(".quake")?.scrollIntoView({ behavior: "smooth" }); }}>Watch the replay <ArrowDown size={18} aria-hidden /></a>
        </div>
      </div>
      <aside className="hx-panel" aria-label="Sector summary">
        <div className="hx-panel-h"><span className="hx-live" />Sector AOI-M1</div>
        <dl>
          <div><dt>Structures</dt><dd>{st?.buildings ?? "—"}</dd></div>
          <div><dt>Collapsed blocks</dt><dd className="hot">{st?.destroyed ?? "—"}</dd></div>
          <div><dt>Damaged blocks</dt><dd className="warm">{st?.damaged ?? "—"}</dd></div>
          <div><dt>Roads cut</dt><dd>{st?.roadsBlocked ?? "—"}</dd></div>
          <div><dt>Drone scan</dt><dd><span ref={scanEl}>0%</span></dd></div>
        </dl>
        <p>Maxar 11 Feb 2023 · Copernicus EMSR648</p>
      </aside>
      <div className="hx-coords" aria-hidden="true">36.2077°N · 36.1578°E</div>
    </section>
  );
}
