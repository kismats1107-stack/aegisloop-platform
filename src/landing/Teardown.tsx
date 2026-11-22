import { useEffect, useRef } from "react";
import * as THREE from "three";
import { createStage } from "../three/stage";
import { buildDrone, buildRover, explode, materials, type Robot } from "../three/robots";
import { onFrame, progressOf, seg, smooth, useStage } from "./scroll";

export interface TeardownProps {
  kind: "drone" | "rover";
  index: string;
  role: string;
  name: string;
  specs: { value: number | string; decimals?: number; unit: string; label: string }[];
  source: string;
}

const STAGES = [0, 0.14, 0.62, 0.8];

/** Pinned teardown: assembled → exploded with labelled parts → reassembled with spec numerals. */
export function Teardown({ kind, index, role, name, specs, source }: TeardownProps) {
  const section = useRef<HTMLElement>(null);
  const mount = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const nums = useRef<(HTMLSpanElement | null)[]>([]);
  const stage = useStage(section, STAGES);

  useEffect(() => {
    const sec = section.current!;
    const cv = document.createElement("canvas"); cv.className = "stage-canvas"; cv.setAttribute("role", "img"); cv.setAttribute("aria-label", `3D model of the ${name}, exploding into its components as you scroll`);
    mount.current!.appendChild(cv);
    const st = createStage(cv, { background: null, fov: 30 });
    const robot: Robot = kind === "drone" ? buildDrone(materials()) : buildRover(materials());
    const pivot = new THREE.Group(); pivot.add(robot.group); st.scene.add(pivot);
    if (kind === "drone") robot.group.scale.setScalar(0.8);
    const box = new THREE.Box3().setFromObject(robot.group), c = box.getCenter(new THREE.Vector3());
    robot.group.position.sub(c);
    st.camera.position.set(0, 2.2, kind === "drone" ? 13.5 : 14); st.camera.lookAt(0, 0, 0);
    explode(robot, 0.5); st.warm(); explode(robot, 0);
    const labelled = robot.parts.filter((p) => p.label);
    const host = labels.current!;
    host.innerHTML = "";
    const els = labelled.map((p) => {
      const el = document.createElement("div"); el.className = "tlabel";
      el.innerHTML = `<i></i><span><b>${p.label!.title}</b><small>${p.label!.spec}</small></span>`;
      host.appendChild(el); return el;
    });
    let visible = false;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting), { rootMargin: "200px" }); io.observe(sec);
    const tmp = new THREE.Vector3();
    let lastP = -1;
    const off = onFrame((t) => {
      if (!visible) return;
      const p = progressOf(sec);
      if (kind === "rover" && Math.abs(p - lastP) < 1e-4) return;
      lastP = p;
      const intro = smooth(seg(p, 0, 0.14));
      const ex = seg(p, 0.16, 0.5) * (1 - seg(p, 0.66, 0.8));
      const side = smooth(seg(p, 0.68, 0.84));
      explode(robot, ex, kind === "drone" ? 0.62 : 0.8);
      robot.spin.forEach((s, i) => (kind === "drone" ? (s.rotation.y += i % 2 ? 0.6 : -0.6) : (s.rotation.y = -p * 12)));
      pivot.rotation.y = -0.9 + intro * 0.5 + p * 1.6 + Math.sin(t / 2400) * 0.04;
      pivot.rotation.x = 0.12 + ex * 0.18;
      pivot.position.x = -side * (innerWidth > 900 ? 2.4 : 0);
      pivot.position.y = (1 - intro) * -1.2 + (kind === "drone" ? Math.sin(t / 700) * 0.06 : 0);
      pivot.scale.setScalar(0.75 + intro * 0.25 - side * 0.12);
      st.render();
      // part labels (projected)
      const show = seg(p, 0.3, 0.38) * (1 - seg(p, 0.64, 0.7));
      const w = cv.clientWidth, h = cv.clientHeight;
      const pts = labelled.map((part, i) => {
        part.obj.getWorldPosition(tmp); tmp.project(st.camera);
        const x = (tmp.x * 0.5 + 0.5) * w, y = (-tmp.y * 0.5 + 0.5) * h;
        return { i, x, y, right: x > w / 2, ly: y };
      });
      // declutter: per side, keep callouts at least 52 px apart vertically (dots stay on the parts)
      for (const side of [true, false]) {
        const col = pts.filter((q) => q.right === side).sort((m, n) => m.y - n.y);
        for (let j = 1; j < col.length; j++) col[j].ly = Math.max(col[j].ly, col[j - 1].ly + 52);
      }
      pts.forEach((q) => {
        const el = els[q.i];
        el.style.transform = `translate(${q.x.toFixed(1)}px, ${q.y.toFixed(1)}px)`;
        el.style.setProperty("--dy", `${(q.ly - q.y).toFixed(1)}px`);
        el.classList.toggle("left", !q.right);
        el.style.opacity = String(Math.max(0, Math.min(1, show * 1.4 - q.i * 0.04)));
      });
      // count-up numerals
      const k = smooth(seg(p, 0.8, 0.95));
      specs.forEach((s, i) => {
        const el = nums.current[i]; if (!el || typeof s.value !== "number") return;
        el.textContent = (s.value * Math.min(1, Math.max(0, k * 1.15 - i * 0.05))).toFixed(s.decimals ?? 0);
      });
    });
    return () => { off(); io.disconnect(); st.dispose(); cv.remove(); };
  }, [kind, specs, name]);

  return (
    <section ref={section} className={`teardown s${stage}`} aria-label={`${name} teardown`}>
      <div className="pin">
        <div className="stage-card dark">
          <div ref={mount} className="stage-host" />
          <div ref={labels} className="tlabels" aria-hidden="true" />
          <header className="td-head">
            <span className="td-idx">{index}</span>
            <span className="td-role">{role}</span>
            <h2>{name}</h2>
          </header>
          <div className="td-hint" aria-hidden="true">Scroll to take it apart</div>
          <dl className="td-specs">
            {specs.map((s, i) => (
              <div key={s.label} style={{ transitionDelay: `${i * 70}ms` }}>
                <dt>{s.label}</dt>
                <dd><span ref={(el) => (nums.current[i] = el)}>{typeof s.value === "number" ? "0" : s.value}</span><em>{s.unit}</em></dd>
              </div>
            ))}
            <p className="td-src">{source}</p>
          </dl>
        </div>
      </div>
    </section>
  );
}
