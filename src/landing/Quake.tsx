import { useEffect, useRef } from "react";
import type { CaseData } from "../data/antakya";
import { createDust } from "./dust";
import { ImageSpace, View, fitCanvas, loadImage, scaled, validExtent } from "./imagery";
import { onFrame, progressOf, reducedMotion, seg, smooth, useStage } from "./scroll";

const STAGES = [0, 0.3, 0.52, 0.72];

/** 6 Feb 2023, 04:17 — the intact city (Dec 2022) shakes, dust rises and settles on the aftermath (11 Feb 2023). */
export function Quake({ data }: { data: CaseData }) {
  const section = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const dustCv = useRef<HTMLCanvasElement>(null);
  const clock = useRef<HTMLSpanElement>(null);
  const counters = useRef<(HTMLSpanElement | null)[]>([]);
  const stage = useStage(section, STAGES);
  const s = data.meta.stats.aoi11;
  const figures = [{ v: s.destroyed, l: "blocks destroyed", c: "g3" }, { v: s.damaged, l: "blocks damaged", c: "g2" }, { v: s.roadsBlocked, l: "road segments cut" }];

  useEffect(() => {
    const sec = section.current!, cv = canvas.current!, ctx = cv.getContext("2d")!;
    const space = new ImageSpace(data), polys = space.polys(data);
    const mb = data.meta.missionBounds, a = space.px([mb[0], mb[3]]), b = space.px([mb[2], mb[1]]);
    const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, sector = b[0] - a[0];
    const view = new View(ctx), dust = createDust(dustCv.current!), calm = reducedMotion();
    let pre: { src: CanvasImageSource; k: number } | null = null, post: { src: CanvasImageSource; k: number } | null = null, lastP = -1, lastW = 0, ext: ReturnType<typeof validExtent> | undefined, visible = false;
    loadImage(`/data/antakya/imagery/${data.imagery!.scenes.pre.layers.inner.file}`).then(async (i) => { pre = await scaled(i); lastP = -1; });
    loadImage(`/data/antakya/imagery/${data.imagery!.scenes.post.layers.inner.file}`).then(async (i) => { const b = await scaled(i); ext = validExtent(b, i.naturalWidth, i.naturalHeight); post = b; lastP = -1; });
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting), { rootMargin: "200px" }); io.observe(sec);
    const off = onFrame((t) => {
      if (!visible) return;
      fitCanvas(cv);
      const p = progressOf(sec);
      const quake = seg(p, 0.3, 0.52), env = Math.sin(Math.PI * Math.min(1, quake * 1.15)) * (quake < 1 ? 1 : 0);
      const surge = calm ? 0 : smooth(seg(p, 0.36, 0.5)) * (1 - smooth(seg(p, 0.54, 0.72)));
      view.cx = cx; view.cy = cy;
      view.vw = sector * (2.1 - 0.7 * smooth(seg(p, 0, 0.5)) - 0.25 * smooth(seg(p, 0.55, 1)));
      view.clampTo(space.W, space.H, ext);
      const amp = calm ? 0 : env * 14 * devicePixelRatio;
      view.shakeX = Math.sin(t * 0.09) * amp + Math.sin(t * 0.23) * amp * 0.5;
      view.shakeY = Math.cos(t * 0.11) * amp * 0.7;
      dust.render(t, surge);
      const shaking = amp > 0;
      if (!shaking && Math.abs(p - lastP) < 1e-4 && cv.width === lastW) return;
      lastP = p; lastW = cv.width;
      ctx.fillStyle = "#121416"; ctx.fillRect(0, 0, cv.width, cv.height);
      const after = p >= 0.47;
      const img = after ? post : pre;
      if (img) view.image(img);
      const ov = smooth(seg(p, 0.72, 0.84));
      if (ov > 0) for (const q of polys) view.poly(q, ov);
      // clock 04:16:48 → 04:17:00 → running
      if (clock.current) {
        const secs = Math.round(16 * 60 + 48 + Math.min(1, p / 0.3) * 12 + Math.max(0, p - 0.3) * 600);
        const mm = Math.floor(secs / 60), ss = secs % 60;
        clock.current.textContent = `04:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
      }
      const k = smooth(seg(p, 0.74, 0.92));
      figures.forEach((f, i) => { const el = counters.current[i]; if (el) el.textContent = String(Math.round(f.v * Math.min(1, Math.max(0, k * 1.2 - i * 0.08)))); });
    });
    return () => { off(); io.disconnect(); dust.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  return (
    <section ref={section} className={`quake s${stage}`} aria-label="The earthquake: Antakya before and after 6 February 2023">
      <div className="pin">
        <div className="stage-card">
          <canvas ref={canvas} className="stage-canvas" role="img" aria-label="Satellite imagery of central Antakya: 22 December 2022, then 11 February 2023" />
          <canvas ref={dustCv} className="stage-canvas dust" aria-hidden="true" />
          <div className="vignette" aria-hidden="true" />
          <div className="qz-date">
            <span className="qz-day">06.02.2023</span>
            <span className="qz-clock" ref={clock}>04:16:48</span>
            <span className="qz-place">Antakya, Hatay · 36.21°N 36.16°E</span>
          </div>
          <div className="qz-mag" aria-hidden={stage < 1}><b>Mw 7.8</b><span>Pazarcık epicentre</span></div>
          <div className="qz-tag">
            <span className={stage < 2 ? "on" : ""}>Maxar · 22 Dec 2022</span>
            <span className={stage >= 2 ? "on" : ""}>Maxar · 11 Feb 2023</span>
          </div>
          <div className="qz-figs">
            {figures.map((f, i) => (
              <div key={f.l} className={f.c ?? ""}><span ref={(el) => (counters.current[i] = el)}>0</span><small>{f.l}</small></div>
            ))}
            <p>Copernicus EMS damage grading, Antakya</p>
          </div>
        </div>
      </div>
    </section>
  );
}
