// Builds the Antakya 2023 case-replay dataset from public sources.
//
//   Copernicus EMS Rapid Mapping, activation EMSR648, AOI11 Antakya, Grading Monitoring 01 (13 Feb 2023)
//     -> data-src/copernicus-emsr648-aoi11/*.json   (© European Union, Copernicus Emergency Management Service)
//   OpenStreetMap buildings (footprints, levels, heights) via Overpass, cached once
//     -> data-src/osm-antakya-buildings.json        (© OpenStreetMap contributors, ODbL)
//
// Output: public/data/antakya/{meta.json, buildings.geojson, blocks.geojson, roads.geojson, water.geojson, crisis.geojson}
//   node tools/build-antakya.mjs [--refresh-osm]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "data-src", "copernicus-emsr648-aoi11");
const OUT = join(ROOT, "public", "data", "antakya");
const OSM_CACHE = join(ROOT, "data-src", "osm-antakya-buildings.json");
mkdirSync(OUT, { recursive: true });

const load = (layer) => JSON.parse(readFileSync(join(SRC, `EMSR648_AOI11_GRA_MONIT01_${layer}_r1_v2.json`), "utf8")).features;
const GRADE = { "No visible damage": 0, "Possibly damaged": 1, Damaged: 2, Destroyed: 3 };
const LAT0 = 36.21, M_LAT = 111320, M_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);

// ---------- geometry helpers
const rings = (g) => (g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []);
const centroid = (g) => {
  const a = g.coordinates.flat(3); let x = 0, y = 0, n = 0;
  for (let i = 0; i < a.length; i += 2) { x += a[i]; y += a[i + 1]; n++; }
  return [x / n, y / n];
};
const inRing = ([x, y], r) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const inPoly = (p, g) => rings(g).some((poly) => inRing(p, poly[0]) && !poly.slice(1).some((h) => inRing(p, h)));
const areaM2 = (g) => rings(g).reduce((s, poly) => {
  const r = poly[0]; let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * M_LON * (r[j][1] + r[i][1]) * M_LAT;
  return s + Math.abs(a / 2);
}, 0);
const bboxOf = (g) => { const a = g.coordinates.flat(3); let b = [1e9, 1e9, -1e9, -1e9];
  for (let i = 0; i < a.length; i += 2) b = [Math.min(b[0], a[i]), Math.min(b[1], a[i + 1]), Math.max(b[2], a[i]), Math.max(b[3], a[i + 1])]; return b; };
const within = ([x, y], b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
const round = (g) => JSON.parse(JSON.stringify(g, (k, v) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v)));

// ---------- load Copernicus layers
const blocks = load("builtUpA").map((f) => ({ f, c: centroid(f.geometry), g: GRADE[f.properties.damage_gra] ?? 0 }));
const roads = load("transportationL").map((f) => ({ f, c: centroid(f.geometry), g: GRADE[f.properties.damage_gra] ?? -1 }));
const waterA = load("hydrographyA"), waterL = load("hydrographyL");
const crisis = [...load("ancillaryCrisisInfoA"), ...load("ancillaryCrisisInfoP")];

// ---------- mission AOI: the densest 700 m square of graded damage (25 m bins + 2D prefix sums)
const SIZE = 700, CELL = 25, N = SIZE / CELL;
const aoi11 = bboxOf(load("areaOfInterestA")[0].geometry);
const W = Math.ceil(((aoi11[2] - aoi11[0]) * M_LON) / CELL), H = Math.ceil(((aoi11[3] - aoi11[1]) * M_LAT) / CELL);
const grid = new Float64Array((W + 1) * (H + 1));
const bin = ([x, y], w) => {
  const i = Math.floor(((x - aoi11[0]) * M_LON) / CELL), j = Math.floor(((y - aoi11[1]) * M_LAT) / CELL);
  if (i >= 0 && j >= 0 && i < W && j < H) grid[(j + 1) * (W + 1) + i + 1] += w;
};
for (const b of blocks) bin(b.c, [0, 0.5, 2, 3][b.g]);
for (const r of roads) if (r.g >= 2) bin(r.c, 1.5);
for (let j = 1; j <= H; j++) for (let i = 1; i <= W; i++)
  grid[j * (W + 1) + i] += grid[(j - 1) * (W + 1) + i] + grid[j * (W + 1) + i - 1] - grid[(j - 1) * (W + 1) + i - 1];
const sum = (i, j) => grid[(j + N) * (W + 1) + i + N] - grid[j * (W + 1) + i + N] - grid[(j + N) * (W + 1) + i] + grid[j * (W + 1) + i];
let best = { s: -1 };
for (let j = 0; j + N <= H; j++) for (let i = 0; i + N <= W; i++) { const s = sum(i, j); if (s > best.s) best = { s, i, j }; }
const mission = [aoi11[0] + (best.i * CELL) / M_LON, aoi11[1] + (best.j * CELL) / M_LAT];
mission.push(mission[0] + SIZE / M_LON, mission[1] + SIZE / M_LAT);
const MARGIN = 650;
const context = [mission[0] - MARGIN / M_LON, mission[1] - MARGIN / M_LAT, mission[2] + MARGIN / M_LON, mission[3] + MARGIN / M_LAT];
const center = [(mission[0] + mission[2]) / 2, (mission[1] + mission[3]) / 2];
console.log(`mission AOI ${mission.map((v) => v.toFixed(5)).join(",")}  score ${best.s.toFixed(1)}`);

// ---------- OSM buildings (cached)
async function fetchOsm() {
  const q = `[out:json][timeout:120];(way["building"](${context[1]},${context[0]},${context[3]},${context[2]}););out tags geom;`;
  const mirrors = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = mirrors[attempt % mirrors.length];
    try {
      const r = await fetch(url, { method: "POST", headers: { "User-Agent": "aegisloop-dataset-builder/0.1", "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q), signal: AbortSignal.timeout(150000) });
      const t = await r.text();
      if (r.ok && t.startsWith("{")) { const j = JSON.parse(t); if (j.elements?.length) return j; }
      console.log(`overpass ${url} -> ${r.status}, retrying`);
    } catch (e) { console.log(`overpass ${url} -> ${e.message}, retrying`); }
    await new Promise((res) => setTimeout(res, 4000 * (attempt + 1)));
  }
  return null;
}
let osm = existsSync(OSM_CACHE) && !process.argv.includes("--refresh-osm") ? JSON.parse(readFileSync(OSM_CACHE, "utf8")) : null;
if (!osm) { osm = await fetchOsm(); if (osm) writeFileSync(OSM_CACHE, JSON.stringify(osm)); }
if (!osm) console.log("WARNING: no OSM buildings available; buildings.geojson will be derived from Copernicus blocks only");

// ---------- join: each OSM building takes the grade of the Copernicus block containing its centroid
const ctxBlocks = blocks.filter((b) => within(b.c, context)).map((b) => ({ ...b, bb: bboxOf(b.f.geometry) }));
const gradeAt = (p) => { for (const b of ctxBlocks) if (within(p, b.bb) && inPoly(p, b.f.geometry)) return b; return null; };
const levelsOf = (t) => {
  const h = parseFloat(t.height), l = parseFloat(t["building:levels"]);
  if (h > 0) return { h, est: false };
  if (l > 0) return { h: l * 3.1 + 1, est: false };
  return { h: null, est: true };
};
// Geometry policy (documented in meta.json):
//   * OSM building footprints where mapped; grade from the Copernicus block containing the centroid (g = -1: outside any graded block)
//   * Copernicus blocks with no OSM building inside are extruded as block massing (k = "block")
//   * heights: OSM height / building:levels when tagged, otherwise an estimate (est = 1)
//   * destroyed (g = 3): rendered as rubble (h), pre-event height kept as h0
const RUBBLE = 2.4;
const hash = (s) => { let x = 2166136261; for (const ch of String(s)) x = Math.imul(x ^ ch.charCodeAt(0), 16777619); return ((x >>> 0) % 1000) / 1000; };
const buildings = [], blocksWithOsm = new Set();
const push = (geom, c, g, h0, est, props) => buildings.push({ type: "Feature", geometry: geom, properties: {
  g, h: g === 3 ? RUBBLE : Math.round(h0 * 10) / 10, h0: Math.round(h0 * 10) / 10, est: est ? 1 : 0,
  a: Math.round(areaM2(geom)), m: within(c, mission) ? 1 : 0, ...props } });
if (osm) {
  for (const el of osm.elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 4) continue;
    const ring = el.geometry.map((p) => [p.lon, p.lat]);
    if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) ring.push(ring[0]);
    const geom = { type: "Polygon", coordinates: [ring] }, c = centroid(geom);
    const blk = gradeAt(c), lv = levelsOf(el.tags || {}), a = areaM2(geom);
    if (blk) blocksWithOsm.add(blk);
    const h = lv.h ?? (a > 600 ? 17.5 : a > 200 ? 14.4 : a > 80 ? 8.2 : 4.1) + hash(el.id) * 3;
    push(geom, c, blk ? blk.g : -1, h, lv.est, { n: el.tags?.name ?? "", k: el.tags?.building ?? "yes", src: blk ? "osm+cems" : "osm", id: `w${el.id}` });
  }
}
for (const b of ctxBlocks) {
  if (blocksWithOsm.has(b)) continue;
  const h = 9.3 + Math.round(hash(b.f.properties.name + b.c.join()) * 4) * 3.1;  // 3–7 storeys, Antakya mid-rise
  push(b.f.geometry, b.c, b.g, h, true, { n: b.f.properties.name ?? "", k: "block", src: "cems", id: `b${b.c[0].toFixed(5)}_${b.c[1].toFixed(5)}` });
}

const fc = (features) => round({ type: "FeatureCollection", features });
const shortType = (s = "") => s.replace(/^\d+-/, "");
writeFileSync(join(OUT, "buildings.geojson"), JSON.stringify(fc(buildings)));
writeFileSync(join(OUT, "blocks.geojson"), JSON.stringify(fc(ctxBlocks.map((b) => ({ type: "Feature", geometry: b.f.geometry,
  properties: { g: b.g, n: b.f.properties.name ?? "", t: shortType(b.f.properties.info ?? b.f.properties.obj_type), m: within(b.c, mission) ? 1 : 0 } })))));
writeFileSync(join(OUT, "roads.geojson"), JSON.stringify(fc(roads.filter((r) => within(r.c, context)).map((r) => ({ type: "Feature", geometry: r.f.geometry,
  properties: { g: r.g, n: r.f.properties.name ?? "", t: shortType(r.f.properties.info ?? r.f.properties.obj_type) } })))));
writeFileSync(join(OUT, "water.geojson"), JSON.stringify(fc([...waterA, ...waterL].filter((f) => { const b = bboxOf(f.geometry); return !(b[2] < context[0] || b[0] > context[2] || b[3] < context[1] || b[1] > context[3]); })
  .map((f) => ({ type: "Feature", geometry: f.geometry, properties: { t: f.properties.obj_type, n: f.properties.name ?? "" } })))));
writeFileSync(join(OUT, "crisis.geojson"), JSON.stringify(fc(crisis.filter((f) => within(centroid(f.geometry), context)).map((f) => ({ type: "Feature", geometry: f.geometry,
  properties: { t: f.properties.obj_type, d: f.properties.obj_desc, n: f.properties.element_co < 900 ? f.properties.element_co : null } })))));

// ---------- stats
const count = (arr, pred) => arr.filter(pred).length;
const inM = blocks.filter((b) => within(b.c, mission)), inMb = buildings.filter((b) => b.properties.m);
const meta = {
  id: "antakya-2023",
  title: "Antakya, Hatay — Kahramanmaraş earthquake sequence",
  event: { date: "2023-02-06", localTime: "04:17", tz: "TRT (UTC+3)", magnitude: "Mw 7.8", epicentre: "Pazarcık, Kahramanmaraş", aftershock: "Mw 7.5 Elbistan, 13:24 TRT" },
  missionBounds: mission, contextBounds: context, center,
  stats: {
    aoi11: { blocks: blocks.length, destroyed: count(blocks, (b) => b.g === 3), damaged: count(blocks, (b) => b.g === 2), possibly: count(blocks, (b) => b.g === 1),
      roadsBlocked: count(roads, (r) => r.g >= 2), camps: count(crisis, (f) => f.properties.obj_type === "Camp"), barriers: count(crisis, (f) => /Barrier/.test(f.properties.obj_type)) },
    mission: { blocks: inM.length, destroyed: count(inM, (b) => b.g === 3), damaged: count(inM, (b) => b.g === 2), possibly: count(inM, (b) => b.g === 1),
      buildings: inMb.length, buildingsAffected: count(inMb, (b) => b.properties.g >= 2), roadsBlocked: count(roads, (r) => r.g >= 2 && within(r.c, mission)),
      heightsFromOsm: count(inMb, (b) => !b.properties.est) },
  },
  geometry: "OSM building footprints where mapped, graded by the containing Copernicus block; unmapped graded blocks shown as block massing. Heights from OSM tags where present, otherwise estimated (flagged). Destroyed structures shown as rubble with pre-event height retained.",
  sources: [
    { name: "Copernicus EMS Rapid Mapping — EMSR648 AOI11 Antakya, Grading Monitoring 01", date: "2023-02-13", licence: "© European Union, Copernicus Emergency Management Service", url: "https://mapping.emergency.copernicus.eu/activations/EMSR648" },
    { name: "OpenStreetMap buildings", licence: "© OpenStreetMap contributors, ODbL", url: "https://www.openstreetmap.org/copyright", available: !!osm },
  ],
};
writeFileSync(join(OUT, "meta.json"), JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta.stats, null, 1));
console.log(`buildings ${buildings.length}, context blocks ${ctxBlocks.length}`);
