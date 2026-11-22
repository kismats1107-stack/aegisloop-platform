// Terrain-based flood model (simulated, physically plausible):
//   * elevation: free Terrarium tiles (Mapzen / AWS Open Data, ~10-30 m source resolution), decoded at zoom 15
//   * the river (OpenStreetMap water lines/polygons) is the source; its local bed level is the lowest ground next to it
//   * a cell floods once the water rise exceeds the lowest "spill height" on any connected path from the river
//     (minimax / priority-flood), so water follows the ground: it runs into low streets and stops at higher ground
//   * depth = river level + rise - ground elevation
import type { Bounds, CaseData } from "../data/antakya";
import type { Frame, XY } from "./geo";

const Z = 15;
const lon2x = (lon: number) => ((lon + 180) / 360) * 256 * 2 ** Z;
const lat2y = (lat: number) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 256 * 2 ** Z; };
const x2lon = (x: number) => (x / (256 * 2 ** Z)) * 360 - 180;
const y2lat = (y: number) => { const n = Math.PI - (2 * Math.PI * y) / (256 * 2 ** Z); return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };

export interface FloodTerrain {
  w: number; h: number; x0: number; y0: number;
  /** ground elevation (m) */ elev: Float32Array;
  /** 1 where OpenStreetMap maps the river or lake */ river: Uint8Array;
  /** river level at the source this cell drains from (m) */ base: Float32Array;
  /** minimum rise above the river needed for water to reach this cell (Infinity = never, NaN = river itself) */ need: Float32Array;
  corners: [[number, number], [number, number], [number, number], [number, number]];   // lng/lat: TL, TR, BR, BL
  metresPerCell: number;
  hasWater: boolean;
}

function loadTile(x: number, y: number): Promise<ImageData | null> {
  return new Promise((res) => {
    const im = new Image(); im.crossOrigin = "anonymous";
    im.onload = () => { const c = document.createElement("canvas"); c.width = c.height = 256; const g = c.getContext("2d", { willReadFrequently: true })!; g.drawImage(im, 0, 0); try { res(g.getImageData(0, 0, 256, 256)); } catch { res(null); } };
    im.onerror = () => res(null);
    im.src = `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${Z}/${x}/${y}.png`;
  });
}

const cache = new Map<string, Promise<FloodTerrain | null>>();
export function loadFloodTerrain(data: CaseData): Promise<FloodTerrain | null> {
  const k = data.meta.id;
  if (!cache.has(k)) cache.set(k, build(data.meta.contextBounds, data));
  return cache.get(k)!;
}

async function build(b: Bounds, data: CaseData): Promise<FloodTerrain | null> {
  const x0 = Math.floor(lon2x(b[0])), x1 = Math.ceil(lon2x(b[2])), y0 = Math.floor(lat2y(b[3])), y1 = Math.ceil(lat2y(b[1]));
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0 || w * h > 1.5e6) return null;
  const elev = new Float32Array(w * h);
  const jobs: Promise<void>[] = [];
  for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x1 - 1) / 256); tx++) for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y1 - 1) / 256); ty++) {
    jobs.push(loadTile(tx, ty).then((img) => {
      if (!img) return;
      for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
        const gx = tx * 256 + i - x0, gy = ty * 256 + j - y0;
        if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
        const o = (j * 256 + i) * 4, d = img.data;
        elev[gy * w + gx] = d[o] * 256 + d[o + 1] + d[o + 2] / 256 - 32768;
      }
    }));
  }
  await Promise.all(jobs);
  // light smoothing (3x3) to remove tile quantisation steps
  const sm = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) { s += elev[yy * w + xx]; n++; } }
    sm[y * w + x] = s / n;
  }
  // river cells from OSM water
  const river = new Uint8Array(w * h);
  const px = (c: number[]): [number, number] => [lon2x(c[0]) - x0, lat2y(c[1]) - y0];
  const mark = (x: number, y: number, r = 1) => { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const xx = Math.round(x) + dx, yy = Math.round(y) + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) river[yy * w + xx] = 1; } };
  const line = (pts: number[][]) => { for (let i = 1; i < pts.length; i++) { const [ax, ay] = px(pts[i - 1]), [bx, by] = px(pts[i]), n = Math.ceil(Math.hypot(bx - ax, by - ay)) + 1; for (let k = 0; k <= n; k++) mark(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n); } };
  for (const f of data.water?.features ?? []) {
    const g = f.geometry;
    if (g.type === "LineString") line(g.coordinates);
    else if (g.type === "MultiLineString") g.coordinates.forEach(line);
    else if (g.type === "Polygon" || g.type === "MultiPolygon") {
      const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      for (const poly of polys) {
        const ring = poly[0].map(px); line(poly[0]);
        const ys = ring.map((p) => p[1]), ya = Math.max(0, Math.floor(Math.min(...ys))), yb = Math.min(h - 1, Math.ceil(Math.max(...ys)));
        for (let y = ya; y <= yb; y++) {
          const xs: number[] = [];
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y)) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi)); }
          xs.sort((a, b2) => a - b2);
          for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k])); x <= Math.min(w - 1, Math.floor(xs[k + 1])); x++) river[y * w + x] = 1;
        }
      }
    }
  }
  // priority flood from the river: need = minimax(elev - riverLevel) along the path
  // full precision while searching (float32 rounding makes cells look improved again and re-queue forever)
  const base = new Float64Array(w * h).fill(NaN), need64 = new Float64Array(w * h).fill(Infinity);
  const heap: number[] = [], hk: number[] = [];
  const push = (i: number, v: number) => { heap.push(i); hk.push(v); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (hk[p] <= hk[c]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; [hk[p], hk[c]] = [hk[c], hk[p]]; c = p; } };
  const pop = () => { const i = heap[0], v = hk[0], li = heap.pop()!, lv = hk.pop()!; if (heap.length) { heap[0] = li; hk[0] = lv; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && hk[l] < hk[m]) m = l; if (r < heap.length && hk[r] < hk[m]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; [hk[m], hk[c]] = [hk[c], hk[m]]; c = m; } } return [i, v] as const; };
  let hasWater = false;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!river[i]) continue;
    hasWater = true;
    let lo = sm[i];                       // riverbank level: lowest ground in a 7x7 window (~28 m); the DEM does not resolve the channel
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) lo = Math.min(lo, sm[yy * w + xx]); }
    base[i] = lo; push(i, 0);
  }
  // 1) local river level for every cell = level of the NEAREST river point (height above nearest drainage); carrying the
  //    level along the flood path would put upstream water on downstream ground and invent metres of depth
  const dist = new Float64Array(w * h).fill(Infinity);
  for (let i = 0; i < w * h; i++) if (river[i]) dist[i] = 0;
  const N8 = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [-1, -1, 1.414], [1, -1, 1.414], [-1, 1, 1.414]];
  while (heap.length) {
    const [i, v] = pop(); if (v > dist[i]) continue;
    const x = i % w, y = (i / w) | 0;
    for (const [dx, dy, wt] of N8) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx, nv = v + wt;
      if (nv < dist[j]) { dist[j] = nv; base[j] = base[i]; push(j, nv); }
    }
  }
  // 2) the rise needed to reach each cell: minimax of (ground - local river level) along any connected path from the river
  for (let i = 0; i < w * h; i++) if (river[i]) { need64[i] = 0; push(i, 0); }
  while (heap.length) {
    const [i, v] = pop(); if (v > need64[i]) continue;
    const x = i % w, y = (i / w) | 0;
    for (const [dx, dy] of N8) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx, nv = Math.max(v, sm[j] - base[j]);
      if (nv < need64[j] && nv < 25) { need64[j] = nv; push(j, nv); }
    }
  }
  const lat = (b[1] + b[3]) / 2;
  return {
    w, h, x0, y0, elev: sm, river, base: Float32Array.from(base), need: Float32Array.from(need64), hasWater,
    corners: [[x2lon(x0), y2lat(y0)], [x2lon(x1), y2lat(y0)], [x2lon(x1), y2lat(y1)], [x2lon(x0), y2lat(y1)]],
    metresPerCell: (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** Z),
  };
}

/** Path distance (m) from the river over ground the water can reach at the peak level (the flood spreads outward over time). */
const reachCache = new WeakMap<FloodTerrain, Map<number, Float32Array>>();
export function floodReach(t: FloodTerrain, peak: number): Float32Array {
  let m = reachCache.get(t); if (!m) { m = new Map(); reachCache.set(t, m); }
  const hit = m.get(peak); if (hit) return hit;
  const d = new Float64Array(t.w * t.h).fill(Infinity), q: number[] = [], qk: number[] = [];
  const push = (i: number, v: number) => { q.push(i); qk.push(v); let c = q.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (qk[p] <= qk[c]) break; [q[p], q[c]] = [q[c], q[p]]; [qk[p], qk[c]] = [qk[c], qk[p]]; c = p; } };
  const pop = () => { const i = q[0], v = qk[0], li = q.pop()!, lv = qk.pop()!; if (q.length) { q[0] = li; qk[0] = lv; let c = 0; for (;;) { const l = 2 * c + 1, rr = l + 1; let mm = c; if (l < q.length && qk[l] < qk[mm]) mm = l; if (rr < q.length && qk[rr] < qk[mm]) mm = rr; if (mm === c) break; [q[mm], q[c]] = [q[c], q[mm]]; [qk[mm], qk[c]] = [qk[c], qk[mm]]; c = mm; } } return [i, v] as const; };
  for (let i = 0; i < t.w * t.h; i++) if (t.river[i] === 1) { d[i] = 0; push(i, 0); }
  const cs = t.metresPerCell;
  while (q.length) {
    const [i, v] = pop(); if (v > d[i]) continue;
    const x = i % t.w, y = (i / t.w) | 0;
    for (const [dx, dy, wt] of [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [-1, -1, 1.414], [1, -1, 1.414], [-1, 1, 1.414]]) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= t.w || yy >= t.h) continue;
      const j = yy * t.w + xx; if (!(t.need[j] < peak)) continue;
      const nv = v + wt * cs; if (nv < d[j]) { d[j] = nv; push(j, nv); }
    }
  }
  const out = Float32Array.from(d); m.set(peak, out); return out;
}

/** Water depth (m) at a lng/lat for a rise above the riverbank, on ground the flood has spread to (within maxDist m of the river). */
export function depthAt(t: FloodTerrain, lng: number, lat: number, rise: number, reach?: Float32Array, maxDist = Infinity) {
  const fx = lon2x(lng) - t.x0, fy = lat2y(lat) - t.y0;
  if (fx < 0 || fy < 0 || fx >= t.w - 1 || fy >= t.h - 1) return 0;
  // the river channel itself is excluded (bridges stay passable unless their approaches flood); depth capped against DEM pits
  const sample = (x: number, y: number) => { const i = y * t.w + x; return !t.river[i] && t.need[i] < rise && (!reach || reach[i] <= maxDist) ? Math.min(rise + 0.5, Math.max(0, t.base[i] + rise - t.elev[i])) : 0; };
  const x = Math.floor(fx), y = Math.floor(fy), ax = fx - x, ay = fy - y;
  return sample(x, y) * (1 - ax) * (1 - ay) + sample(x + 1, y) * ax * (1 - ay) + sample(x, y + 1) * (1 - ax) * ay + sample(x + 1, y + 1) * ax * ay;
}
export const depthAtXY = (t: FloodTerrain, frame: Frame, p: XY, rise: number, reach?: Float32Array, maxDist = Infinity) => { const [lng, lat] = frame.toLngLat(p); return depthAt(t, lng, lat, rise, reach, maxDist); };

/** Muddy floodwater image (shallow = thin silty sheet, deep = dark water) for a MapLibre image source. */
export function floodImage(t: FloodTerrain, rise: number, reach?: Float32Array, maxDist = Infinity): string {
  const W = t.w, H = t.h, N = W * H;
  // depth field, then two box-blur passes so shorelines are smooth (the DEM is coarser than the 4 m grid)
  let dep: Float32Array = new Float32Array(N);
  for (let i = 0; i < N; i++) dep[i] = !t.river[i] && t.need[i] < rise && (!reach || reach[i] <= maxDist) ? Math.min(rise + 0.5, Math.max(0, t.base[i] + rise - t.elev[i])) : 0;
  for (let pass = 0; pass < 2; pass++) {
    const o = new Float32Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H) { s += dep[yy * W + xx]; n++; } }
      o[y * W + x] = s / n;
    }
    dep = o;
  }
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d")!, img = g.createImageData(W, H), d = img.data;
  const ss = (a: number, b: number, x: number) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
  for (let i = 0; i < N; i++) {
    const z = dep[i]; if (z <= 0.015) continue;
    const o = i * 4, k = Math.min(1, z / 1.6), edge = 1 - ss(0.04, 0.22, z);
    // muddy floodwater: ochre-brown, darker and greener with depth; a pale silty wet line at the shoreline
    let r = 168 - 70 * k, gg = 140 - 52 * k, b = 92 - 22 * k;
    r += (214 - r) * edge * 0.75; gg += (196 - gg) * edge * 0.75; b += (150 - b) * edge * 0.75;
    d[o] = r; d[o + 1] = gg; d[o + 2] = b;
    d[o + 3] = Math.round(255 * ss(0.015, 0.12, z) * (0.78 + 0.17 * k));
  }
  g.putImageData(img, 0, 0);
  const out = document.createElement("canvas"); out.width = W * 3; out.height = H * 3;
  const og = out.getContext("2d")!; og.imageSmoothingEnabled = true; og.imageSmoothingQuality = "high"; og.filter = "blur(1.5px)"; og.drawImage(c, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

export const HUSKY_WADE = 0.2;     // m: Husky A300 ground clearance ~13 cm; deeper water is impassable
export const CAUTION = 0.05;       // m: shallow water, passable with caution
