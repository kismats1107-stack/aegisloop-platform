// Exports the Antakya case sector as a georeferenced Gazebo Harmonic (gz-sim 8) world.
// Same geometry as the web console: public/data/antakya/*.geojson
//   node tools/export-gazebo.mjs [--margin 150] [--out sim/worlds/antakya_aoi_m1.sdf]
//   node tools/export-gazebo.mjs --live            -> sim/worlds/antakya_live.sdf: + UAV-1/UGV-1, ROS-controllable, RTF 8
// Live world: buildings and rubble are visual-only (OSM/Copernicus footprints do not align to road centrelines to the
// metre); barriers on segments Copernicus graded Damaged/Destroyed keep collision, so an unsafe route is physically blocked.
// Frame: ENU metres, origin at the sector centre (meta.center); <spherical_coordinates> carries the real WGS84 reference.
// Buildings are triangulated here (earcut) and written as one OBJ mesh per damage grade: Gazebo's own polyline
// tessellation fails on some real footprints, and a handful of meshes render far faster than hundreds of models.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import earcut from "earcut";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const MARGIN = +arg("--margin", 150);
const LIVE = process.argv.includes("--live");
const RTF = +arg("--rtf", 8);
const OUT = join(ROOT, arg("--out", LIVE ? "sim/worlds/antakya_live.sdf" : "sim/worlds/antakya_aoi_m1.sdf"));
const NAME = basename(OUT, ".sdf");
const MESH_DIR = join(dirname(OUT), NAME);
const D = (f) => JSON.parse(readFileSync(join(ROOT, "public/data/antakya", f), "utf8"));
const meta = D("meta.json"), buildings = D("buildings.geojson"), roads = D("roads.geojson");

const [lon0, lat0] = meta.center;
const mLat = 111320, mLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
const xy = ([lon, lat]) => [(lon - lon0) * mLon, (lat - lat0) * mLat];
const mb = meta.missionBounds, [x0, y0] = xy([mb[0], mb[1]]), [x1, y1] = xy([mb[2], mb[3]]);
const inBox = ([x, y]) => x >= x0 - MARGIN && x <= x1 + MARGIN && y >= y0 - MARGIN && y <= y1 + MARGIN;
const f3 = (v) => (Math.round(v * 1000) / 1000).toString();
const rand = (seed) => { let s = seed >>> 0 || 1; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) ^ Math.imul(s ^ (s >>> 13), 3266489917)) >>> 0) / 4294967296; };

const GRADES = { 3: ["destroyed", "0.5 0.19 0.19"], 2: ["damaged", "0.6 0.44 0.33"], 1: ["possibly_damaged", "0.6 0.57 0.45"], 0: ["no_visible_damage", "0.56 0.57 0.59"], "-1": ["not_graded", "0.5 0.51 0.53"] };
const material = (rgb) => `<material><ambient>${rgb} 1</ambient><diffuse>${rgb} 1</diffuse><specular>0.05 0.05 0.05 1</specular></material>`;

const signedArea = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const [xa, ya] = pts[i], [xb, yb] = pts[(i + 1) % pts.length]; a += xa * yb - xb * ya; } return a / 2; };
function clean(pts, tol = 0.25) {
  const out = [];
  for (const p of pts) { const q = out[out.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > tol) out.push(p); }
  while (out.length > 2 && Math.hypot(out[0][0] - out.at(-1)[0], out[0][1] - out.at(-1)[1]) <= tol) out.pop();
  return out;
}

// ---------- building meshes (one OBJ per grade)
const meshes = {};                                   // grade -> { v: [], f: [] }
const mesh = (g) => (meshes[g] ??= { v: [], f: [] });
let nB = 0, nRubble = 0, nDebris = 0, debris = "";
for (const f of buildings.features) {
  if (f.geometry.type !== "Polygon") continue;
  let ring = clean(f.geometry.coordinates[0].map(xy));
  if (ring.length < 3) continue;
  const c = ring.reduce((s, p) => [s[0] + p[0] / ring.length, s[1] + p[1] / ring.length], [0, 0]);
  if (!inBox(c)) continue;
  if (signedArea(ring) < 0) ring = ring.reverse();   // CCW: outward wall normals, upward roof normals
  const p = f.properties, g = p.g, h = Math.max(0.5, g === 3 ? p.h : p.h0);
  const tris = earcut(ring.flat());
  if (!tris.length) continue;
  const m = mesh(g), base = m.v.length, n = ring.length;
  for (const [x, y] of ring) m.v.push([x, y, 0]);
  for (const [x, y] of ring) m.v.push([x, y, h]);
  for (let i = 0; i < tris.length; i += 3) {         // roof, oriented upward
    let [a, b, cc] = [tris[i], tris[i + 1], tris[i + 2]];
    const A = ring[a], B = ring[b], C = ring[cc];
    if ((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]) < 0) [b, cc] = [cc, b];
    m.f.push([base + n + a, base + n + b, base + n + cc]);
  }
  for (let i = 0; i < n; i++) {                      // walls
    const j = (i + 1) % n;
    m.f.push([base + i, base + j, base + n + j], [base + i, base + n + j, base + n + i]);
  }
  nB++;
  if (g === 3) {                                     // rubble field around a collapsed footprint
    nRubble++;
    const r = rand(nB * 7919), span = Math.min(14, Math.sqrt(p.a) / 2);
    for (let k = 0; k < 6; k++) {
      const dx = (r() - 0.5) * 2 * span, dy = (r() - 0.5) * 2 * span, sx = 0.8 + r() * 2.4, sy = 0.6 + r() * 1.8, sz = 0.4 + r() * 1.2;
      const box = `<geometry><box><size>${f3(sx)} ${f3(sy)} ${f3(sz)}</size></box></geometry>`;
      debris += `    <model name="debris_${nRubble}_${k}"><static>true</static><pose>${f3(c[0] + dx)} ${f3(c[1] + dy)} ${f3(sz / 2)} ${f3(r() * 0.4)} ${f3(r() * 0.4)} ${f3(r() * 3.14)}</pose><link name="l">` +
        `${LIVE ? "" : `<collision name="c">${box}</collision>`}<visual name="v">${box}${material("0.45 0.42 0.4")}</visual></link></model>\n`;
      nDebris++;
    }
  }
}
mkdirSync(MESH_DIR, { recursive: true });
let meshModels = "";
for (const [g, m] of Object.entries(meshes)) {
  const [label, rgb] = GRADES[g];
  const file = `buildings_${label}.obj`;
  // flat shading: every triangle gets its own vertices and one face normal (DART collision needs one normal per vertex)
  const vs = [], ns = [], fs = [];
  m.f.forEach(([a, b, c], i) => {
    const A = m.v[a], B = m.v[b], C = m.v[c];
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], w = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const nx = u[1] * w[2] - u[2] * w[1], ny = u[2] * w[0] - u[0] * w[2], nz = u[0] * w[1] - u[1] * w[0], L = Math.hypot(nx, ny, nz) || 1;
    vs.push(A, B, C);
    for (let k = 0; k < 3; k++) ns.push([nx / L, ny / L, nz / L]);
    fs.push(`f ${3 * i + 1}//${3 * i + 1} ${3 * i + 2}//${3 * i + 2} ${3 * i + 3}//${3 * i + 3}`);
  });
  writeFileSync(join(MESH_DIR, `buildings_${label}.mtl`), `newmtl ${label}\nKa ${rgb}\nKd ${rgb}\nKs 0.05 0.05 0.05\nd 1\n`);
  const obj = `# AegisLoop ${NAME}: structures graded "${label}" (Copernicus EMS EMSR648). Units: metres, ENU, Z up.\nmtllib buildings_${label}.mtl\no buildings_${label}\nusemtl ${label}\n` +
    vs.map(([x, y, z]) => `v ${f3(x)} ${f3(y)} ${f3(z)}`).join("\n") + "\n" + ns.map(([x, y, z]) => `vn ${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)}`).join("\n") + "\n" + fs.join("\n") + "\n";
  writeFileSync(join(MESH_DIR, file), obj);
  const geom = `<geometry><mesh><uri>${NAME}/${file}</uri></mesh></geometry>`;
  meshModels += `    <model name="buildings_${label}"><static>true</static><link name="l">${LIVE ? "" : `<collision name="c">${geom}</collision>`}<visual name="v">${geom}${material(rgb)}</visual></link></model>\n`;
}

// ---------- impassable roads: debris barriers on each damaged/destroyed segment (matches the planner's blocked edges)
let nBarrier = 0, barriers = "";
roads.features.forEach((f, i) => {
  if (f.properties.g < 2 || f.geometry.type !== "LineString") return;
  const pts = f.geometry.coordinates.map(xy);
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k], m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (!inBox(m) || Math.hypot(b[0] - a[0], b[1] - a[1]) < 4) continue;
    const yaw = Math.atan2(b[1] - a[1], b[0] - a[0]) + Math.PI / 2;
    const box = `<geometry><box><size>8 1.6 1.2</size></box></geometry>`;
    barriers += `    <model name="road_block_${i}_${k}"><static>true</static><pose>${f3(m[0])} ${f3(m[1])} 0.6 0 0 ${f3(yaw)}</pose><link name="l">` +
      `<collision name="c">${box}</collision><visual name="v">${box}${material("0.5 0.44 0.38")}</visual></link></model>\n`;
    nBarrier++;
  }
});

const W = x1 - x0 + 2 * MARGIN + 200, H = y1 - y0 + 2 * MARGIN + 200;
// robots start at the sector centre; the mission authority moves them to the staging point on reset
const robots = `    <include><uri>model://aegis_rover</uri><name>rover_1</name><pose>0 0 0.05 0 0 0</pose></include>
    <include><uri>model://aegis_drone</uri><name>drone_1</name><pose>3 0 0.3 0 0 0</pose></include>
`;
const sdf = `<?xml version="1.0"?>
<!-- AegisLoop case world: Antakya, Hatay (EMSR648 AOI11), sector AOI-M1.
     Generated by aegisloop-platform/tools/export-gazebo.mjs from Copernicus EMS grading (© European Union) and OpenStreetMap (© contributors, ODbL).
     ${nB} structures in ${Object.keys(meshes).length} grade meshes, ${nRubble} collapsed with ${nDebris} debris bodies, ${nBarrier} barriers on impassable road segments. -->
<sdf version="1.9">
  <world name="${NAME}">
    <physics name="${LIVE ? "10ms" : "4ms"}" type="ignored"><max_step_size>${LIVE ? "0.01" : "0.004"}</max_step_size><real_time_factor>${LIVE ? RTF.toFixed(1) : "1.0"}</real_time_factor></physics>
    <plugin filename="gz-sim-physics-system" name="gz::sim::systems::Physics"/>
    <plugin filename="gz-sim-user-commands-system" name="gz::sim::systems::UserCommands"/>
    <plugin filename="gz-sim-scene-broadcaster-system" name="gz::sim::systems::SceneBroadcaster"/>
${LIVE ? "" : `    <plugin filename="gz-sim-sensors-system" name="gz::sim::systems::Sensors"><render_engine>ogre2</render_engine></plugin>
    <plugin filename="gz-sim-navsat-system" name="gz::sim::systems::NavSat"/>`}
    <spherical_coordinates>
      <surface_model>EARTH_WGS84</surface_model>
      <world_frame_orientation>ENU</world_frame_orientation>
      <latitude_deg>${lat0.toFixed(7)}</latitude_deg>
      <longitude_deg>${lon0.toFixed(7)}</longitude_deg>
      <elevation>85</elevation>
      <heading_deg>0</heading_deg>
    </spherical_coordinates>
    <scene><ambient>0.45 0.45 0.48 1</ambient><background>0.62 0.68 0.75 1</background><shadows>true</shadows></scene>
    <!-- low winter morning sun from the south-east (06 Feb, ~08:00 local) -->
    <light type="directional" name="sun"><cast_shadows>true</cast_shadows><pose>0 0 100 0 0 0</pose>
      <diffuse>0.95 0.9 0.82 1</diffuse><specular>0.2 0.2 0.2 1</specular><direction>-0.55 0.7 -0.45</direction></light>
    <model name="ground"><static>true</static><link name="l">
      <collision name="c"><geometry><plane><normal>0 0 1</normal><size>${f3(W)} ${f3(H)}</size></plane></geometry></collision>
      <visual name="v"><geometry><plane><normal>0 0 1</normal><size>${f3(W)} ${f3(H)}</size></plane></geometry>${material("0.32 0.31 0.3")}</visual></link></model>
${meshModels}${debris}${barriers}${LIVE ? robots : ""}  </world>
</sdf>
`;
writeFileSync(OUT, sdf);
console.log(`wrote ${OUT}\n  structures ${nB} in ${Object.keys(meshes).length} meshes · collapsed ${nRubble} (+${nDebris} debris) · road barriers ${nBarrier}`);
