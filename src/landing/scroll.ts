// One clock for the whole page: native scrolling + a single requestAnimationFrame ticker.
// Sections read their own scroll progress (0..1 across their sticky span) inside that ticker.
import { useEffect, useRef, useState, type RefObject } from "react";

type Cb = (t: number) => void;
const subs = new Set<Cb>();
let raf = 0;
const loop = (t: number) => { subs.forEach((cb) => cb(t)); raf = requestAnimationFrame(loop); };

export function onFrame(cb: Cb) {
  subs.add(cb);
  if (!raf) raf = requestAnimationFrame(loop);
  return () => { subs.delete(cb); };
}

export const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Native scrolling (kept as a hook so pages do not change). */
export function useSmoothScroll() {}
export const scrollToTop = () => window.scrollTo(0, 0);

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** Progress of an element through the viewport: 0 when its top reaches the top, 1 when its bottom reaches the bottom. */
export function progressOf(el: HTMLElement) {
  const r = el.getBoundingClientRect(), span = r.height - window.innerHeight;
  return span > 0 ? clamp01(-r.top / span) : clamp01(1 - r.top / window.innerHeight);
}
/** Maps p from [a, b] to [0, 1]. */
export const seg = (p: number, a: number, b: number) => clamp01((p - a) / (b - a));
export const smooth = (x: number) => x * x * (3 - 2 * x);

/** Live progress ref for a section (updated every frame, no re-renders). */
export function useProgress(ref: RefObject<HTMLElement>) {
  const p = useRef(0);
  useEffect(() => onFrame(() => { if (ref.current) p.current = progressOf(ref.current); }), [ref]);
  return p;
}

/** Index of the current stage for thresholds (re-renders only when the stage changes). */
export function useStage(ref: RefObject<HTMLElement>, thresholds: number[]) {
  const [stage, setStage] = useState(-1);
  const last = useRef(-1);
  useEffect(() => onFrame(() => {
    if (!ref.current) return;
    const p = progressOf(ref.current);
    let s = -1; thresholds.forEach((th, i) => { if (p >= th) s = i; });
    if (s !== last.current) { last.current = s; setStage(s); }
  }), [ref, thresholds]);
  return stage;
}
