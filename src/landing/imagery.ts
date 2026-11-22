// 2D canvas renderer for the Maxar imagery with building overlays in image space.
import type { CaseData, Grade } from "../data/antakya";
import { GRADE_COLOR } from "../data/antakya";

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const imgCache = new Map<string, Promise<HTMLImageElement>>();
export function loadImage(src: string) {
  if (!imgCache.has(src)) imgCache.set(src, new Promise((res, rej) => { const i = new Image(); i.decoding = "async"; i.onload = () => res(i); i.onerror = rej; i.src = src; }));
  return imgCache.get(src)!;
}

/** Downscaled, GPU-friendly copy of a large image (drawing a 4096 px source every frame is the main scroll cost). */
const bmpCache = new Map<HTMLImageElement, Promise<{ src: CanvasImageSource; k: number }>>();
export function scaled(img: HTMLImageElement, maxW = 2048) {
  if (!bmpCache.has(img)) {
    const k = Math.min(1, maxW / img.naturalWidth);
    bmpCache.set(img, ("createImageBitmap" in window
      ? createImageBitmap(img, { resizeWidth: Math.round(img.naturalWidth * k), resizeHeight: Math.round(img.naturalHeight * k), resizeQuality: "high" })
      : Promise.resolve(img as CanvasImageSource)).then((src) => ({ src, k: src === img ? 1 : k })));
  }
  return bmpCache.get(img)!;
}

export interface Poly { pts: [number, number][]; g: Grade; m: number; id: string; cx: number; cy: number }

export class ImageSpace {
  readonly w: number; readonly n: number; readonly e: number; readonly s: number; readonly W: number; readonly H: number;
  constructor(data: CaseData) {
    const L = data.imagery!.scenes.post.layers.inner;
    [this.w, this.n] = L.coordinates[0]; [this.e, this.s] = L.coordinates[2];
    [this.W, this.H] = L.px;
  }
  px([lng, lat]: [number, number]): [number, number] {
    return [((lng - this.w) / (this.e - this.w)) * this.W, ((mercY(this.n) - mercY(lat)) / (mercY(this.n) - mercY(this.s))) * this.H];
  }
  polys(data: CaseData): Poly[] {
    const out: Poly[] = [];
    for (const f of data.buildings.features) {
      if (f.geometry.type !== "Polygon" || f.properties.g < 1) continue;
      const pts = (f.geometry.coordinates[0] as [number, number][]).map((c) => this.px(c));
      const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      out.push({ pts, g: f.properties.g, m: f.properties.m, id: f.properties.id, cx, cy });
    }
    return out;
  }
}

/** A camera over image space: centre (px) and visible width (px); draws "cover" into the canvas. */
export class View {
  cx = 0; cy = 0; vw = 1000; shakeX = 0; shakeY = 0;
  constructor(readonly ctx: CanvasRenderingContext2D) {}
  get scale() { return this.ctx.canvas.width / this.vw; }
  /** keep the camera inside the image so no empty edge shows */
  clampTo(W: number, H: number, e?: { x0: number; x1: number; y0: number; y1: number }) {
    const c = this.ctx.canvas, x0 = e?.x0 ?? 0, x1 = e?.x1 ?? W, y0 = e?.y0 ?? 0, y1 = e?.y1 ?? H;
    this.vw = Math.min(this.vw, x1 - x0, ((y1 - y0) * c.width) / c.height);
    const vh = (this.vw * c.height) / c.width;
    this.cx = Math.min(x1 - this.vw / 2, Math.max(x0 + this.vw / 2, this.cx));
    this.cy = Math.min(y1 - vh / 2, Math.max(y0 + vh / 2, this.cy));
  }
  toScreen(x: number, y: number): [number, number] {
    const c = this.ctx.canvas, k = this.scale;
    return [(x - this.cx) * k + c.width / 2 + this.shakeX, (y - this.cy) * k + c.height / 2 + this.shakeY];
  }
  image(img: { src: CanvasImageSource; k: number }, alpha = 1) {
    const c = this.ctx.canvas, k = this.scale, sw = c.width / k, sh = c.height / k, f = img.k;
    this.ctx.globalAlpha = alpha;
    this.ctx.drawImage(img.src, (this.cx - sw / 2 - this.shakeX / k) * f, (this.cy - sh / 2 - this.shakeY / k) * f, sw * f, sh * f, 0, 0, c.width, c.height);
    this.ctx.globalAlpha = 1;
  }
  poly(p: Poly, alpha: number) {
    if (alpha <= 0) return;
    const ctx = this.ctx; ctx.beginPath();
    p.pts.forEach(([x, y], i) => { const [sx, sy] = this.toScreen(x, y); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    ctx.closePath();
    const col = GRADE_COLOR[p.g];
    ctx.globalAlpha = alpha * (p.g === 3 ? 0.26 : 0.14); ctx.fillStyle = col; ctx.fill();
    ctx.globalAlpha = alpha; ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, this.scale * 1.4) * (p.g === 3 ? 1.2 : 1); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  line(pts: [number, number][], upto: number, style: { color: string; width: number; dash?: number[]; casing?: string }) {
    if (upto <= 0 || pts.length < 2) return;
    const ctx = this.ctx, scr = pts.map(([x, y]) => this.toScreen(x, y));
    let total = 0; const seg: number[] = [];
    for (let i = 1; i < scr.length; i++) { const d = Math.hypot(scr[i][0] - scr[i - 1][0], scr[i][1] - scr[i - 1][1]); seg.push(d); total += d; }
    const draw = (color: string, width: number, dash?: number[]) => {
      ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.setLineDash(dash ?? []);
      ctx.beginPath(); ctx.moveTo(scr[0][0], scr[0][1]);
      let left = total * Math.min(1, upto);
      for (let i = 1; i < scr.length && left > 0; i++) {
        const t = Math.min(1, left / seg[i - 1]);
        ctx.lineTo(scr[i - 1][0] + (scr[i][0] - scr[i - 1][0]) * t, scr[i - 1][1] + (scr[i][1] - scr[i - 1][1]) * t);
        left -= seg[i - 1];
      }
      ctx.stroke(); ctx.restore();
    };
    if (style.casing) draw(style.casing, style.width + 4 * devicePixelRatio);
    draw(style.color, style.width, style.dash);
  }
  /** point along a polyline at fraction t */
  static along(pts: [number, number][], t: number): [number, number] {
    let total = 0; const seg: number[] = [];
    for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(d); total += d; }
    let left = total * Math.min(1, Math.max(0, t));
    for (let i = 1; i < pts.length; i++) {
      if (left <= seg[i - 1]) { const k = left / (seg[i - 1] || 1); return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k]; }
      left -= seg[i - 1];
    }
    return pts[pts.length - 1];
  }
}

/** Valid (non-black) extent of a satellite image, in image px — the scene edge is not axis-aligned. */
export function validExtent(bmp: { src: CanvasImageSource; k: number }, natW: number, natH: number) {
  const S = 512, k = natW / S, h = Math.round(natH / k);
  const c = document.createElement("canvas"); c.width = S; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true })!; g.drawImage(bmp.src, 0, 0, S, h);
  const d = g.getImageData(0, 0, S, h).data, ok = (x: number, y: number) => { const i = (y * S + x) * 4; return d[i] + d[i + 1] + d[i + 2] > 24; };
  let x0 = 0, x1 = S - 1, y0 = 0, y1 = h - 1;
  for (let y = Math.round(h * 0.2); y < h * 0.8; y += 4) { let a = 0; while (a < S && !ok(a, y)) a++; let b = S - 1; while (b > 0 && !ok(b, y)) b--; x0 = Math.max(x0, a); x1 = Math.min(x1, b); }
  for (let x = Math.round(S * 0.2); x < S * 0.8; x += 4) { let a = 0; while (a < h && !ok(x, a)) a++; let b = h - 1; while (b > 0 && !ok(x, b)) b--; y0 = Math.max(y0, a); y1 = Math.min(y1, b); }
  return { x0: (x0 + 2) * k, x1: (x1 - 2) * k, y0: (y0 + 2) * k, y1: (y1 - 2) * k };
}

export function fitCanvas(canvas: HTMLCanvasElement) {
  const dpr = Math.min(devicePixelRatio, 1.5), w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}
