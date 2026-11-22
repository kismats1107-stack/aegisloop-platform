// Point-cloud digital twin of the Antakya sector, generated in the browser from real data:
//   colour  <- Maxar post-event imagery (11 Feb 2023)
//   height  <- building footprints (OSM / Copernicus) rasterised with their heights; destroyed blocks become low rubble
//   damage  <- Copernicus grade, used for the glow tint
import * as THREE from "three";
import type { CaseData } from "../data/antakya";
import { ImageSpace, loadImage } from "../landing/imagery";

export interface District { points: THREE.Points; material: THREE.ShaderMaterial; radius: number; scanPath: THREE.Vector3[] }

const VS = /* glsl */ `
uniform float uTime, uSize, uScan, uReveal, uPixel;
uniform vec3 uScanPos;
attribute vec3 color;
attribute float grade;
attribute float seed;
varying vec3 vColor;
varying float vGlow, vAlpha, vScan;
void main() {
  vec3 p = position;
  // collapsed structures shimmer slightly (dust)
  if (grade > 2.5) p.y += sin(uTime * 1.6 + seed * 40.0) * 0.35 * seed;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = distance(p.xz, uScanPos.xz);
  float scan = smoothstep(uScan, 0.0, d);                 // drone sensor footprint
  float ring = smoothstep(6.0, 0.0, abs(d - uScan * 0.85)) * 0.6;
  float revealed = step(seed, uReveal);
  vGlow = (grade > 2.5 ? 0.95 : grade > 1.5 ? 0.22 : 0.0) * (0.5 + 0.5 * revealed);
  vScan = scan * 0.55 + ring;
  vColor = color;
  vAlpha = 0.95;
  gl_PointSize = uSize * uPixel * (1.0 + scan * 0.6) / -mv.z;
}`;
const FS = /* glsl */ `
varying vec3 vColor;
varying float vGlow, vAlpha, vScan;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = dot(c, c);
  if (r > 0.25) discard;
  vec3 hot = mix(vec3(1.0, 0.42, 0.18), vec3(1.0, 0.16, 0.12), clamp(vGlow - 0.6, 0.0, 1.0));
  vec3 col = mix(vColor, hot, clamp(vGlow, 0.0, 0.85));
  col = mix(col, vec3(0.42, 0.5, 1.0), clamp(vScan, 0.0, 0.7));
  gl_FragColor = vec4(col, vAlpha * smoothstep(0.25, 0.12, r));
}`;

export async function buildDistrict(data: CaseData, opts: { step?: number; extent?: number } = {}): Promise<District> {
  const space = new ImageSpace(data);
  const img = await loadImage(`/data/antakya/imagery/${data.imagery!.scenes.post.layers.inner.file}`);
  const mb = data.meta.missionBounds;
  const a = space.px([mb[0], mb[3]]), b = space.px([mb[2], mb[1]]);
  const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, sectorPx = b[0] - a[0];
  const mPerPx = 700 / sectorPx;
  const half = (sectorPx * (opts.extent ?? 1.5)) / 2;                       // area around the sector, in source px
  const R = 1100;                                                            // raster resolution
  const k = R / (2 * half);
  const x0 = cx - half, y0 = cy - half;
  // colour raster
  const cc = document.createElement("canvas"); cc.width = cc.height = R;
  const cg = cc.getContext("2d", { willReadFrequently: true })!;
  cg.drawImage(img, x0, y0, 2 * half, 2 * half, 0, 0, R, R);
  const col = cg.getImageData(0, 0, R, R).data;
  // height + grade raster: R = height (0..63.75 m in 0.25 m), G = grade+1
  const hc = document.createElement("canvas"); hc.width = hc.height = R;
  const hg = hc.getContext("2d", { willReadFrequently: true })!;
  hg.fillStyle = "rgb(0,0,0)"; hg.fillRect(0, 0, R, R);
  const feats = [...data.buildings.features].sort((p, q) => p.properties.h0 - q.properties.h0);
  for (const f of feats) {
    if (f.geometry.type !== "Polygon") continue;
    const g = f.properties.g, h = g === 3 ? 2.5 : f.properties.k === "block" ? Math.min(f.properties.h0, 12) : f.properties.h0;
    hg.fillStyle = `rgb(${Math.min(255, Math.round(h * 4))},${g + 2},0)`;
    hg.beginPath();
    (f.geometry.coordinates[0] as [number, number][]).forEach((c, i) => { const [px, py] = space.px(c); const sx = (px - x0) * k, sy = (py - y0) * k; i ? hg.lineTo(sx, sy) : hg.moveTo(sx, sy); });
    hg.closePath(); hg.fill();
  }
  const hd = hg.getImageData(0, 0, R, R).data;

  const step = opts.step ?? 2, unit = mPerPx / k / 4;                      // world units: 1 = 4 m
  const pos: number[] = [], clr: number[] = [], grd: number[] = [], sd: number[] = [];
  const push = (x: number, y: number, z: number, r: number, g: number, bl: number, gr: number) => { pos.push(x, y, z); clr.push(r, g, bl); grd.push(gr); sd.push(Math.random()); };
  for (let j = 0; j < R; j += step) for (let i = 0; i < R; i += step) {
    const o = (j * R + i) * 4;
    const r = col[o] / 255, g = col[o + 1] / 255, bl = col[o + 2] / 255;
    if (r + g + bl < 0.06) continue;                                        // outside imagery
    const hm = hd[o] / 4, grade = hd[o + 1] - 2;                            // metres, grade (-2 = none)
    const jit = step * unit * 0.9, x = (i - R / 2) * unit + (Math.random() - 0.5) * jit, z = (j - R / 2) * unit + (Math.random() - 0.5) * jit;
    const edge = Math.hypot(i - R / 2, j - R / 2) / (R / 2);
    if (edge > 1) continue;                                                 // circular cut-out
    const dim = 1 - Math.max(0, edge - 0.7) * 2.2;
    const tone = (v: number) => Math.min(1, Math.pow(v, 0.95) * 1.22) * dim;
    if (hm > 0.5) {
      const H = (hm / 4) * 1.6; // 1.6× vertical exaggeration for legibility
      const rubble = grade === 3;
      push(x, rubble ? Math.random() * H : H, z, tone(r), tone(g), tone(bl), grade);
      if (!rubble && (i + j) % (step * 3) === 0) push(x, Math.random() * H, z, tone(r) * 0.55, tone(g) * 0.55, tone(bl) * 0.6, grade); // walls
    } else push(x, 0, z, tone(r) * 0.9, tone(g) * 0.9, tone(bl) * 0.95, -1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(clr, 3));
  geo.setAttribute("grade", new THREE.Float32BufferAttribute(grd, 1));
  geo.setAttribute("seed", new THREE.Float32BufferAttribute(sd, 1));
  const material = new THREE.ShaderMaterial({
    vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: true,
    uniforms: { uTime: { value: 0 }, uSize: { value: 2.6 }, uPixel: { value: 1 }, uScan: { value: 22 }, uReveal: { value: 1 }, uScanPos: { value: new THREE.Vector3() } },
  });
  const points = new THREE.Points(geo, material);
  // drone scan path over the sector (boustrophedon), in world units
  const S = (sectorPx * k * unit) / 2, scanPath: THREE.Vector3[] = [];
  for (let r = 0; r < 6; r++) { const z = -S + (r + 0.5) * (2 * S / 6); const xs = r % 2 ? [S, -S] : [-S, S]; xs.forEach((x) => scanPath.push(new THREE.Vector3(x, 18, z))); }
  return { points, material, radius: (R / 2) * unit, scanPath };
}
