// Procedural models of the reference fleet, built from parts so they can be exploded on scroll.
// Proportions follow the published dimensions (1 unit = 100 mm): X500 V2 500 mm wheelbase; Husky A300 990 × 698 × 381 mm.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

export interface Part { obj: THREE.Object3D; home: THREE.Vector3; dir: THREE.Vector3; delay: number; label?: { title: string; spec: string } }
export interface Robot { group: THREE.Group; parts: Part[]; spin: THREE.Object3D[]; radius: number }

export function materials() {
  const phys = (color: string, o: Partial<THREE.MeshPhysicalMaterialParameters> = {}) =>
    new THREE.MeshPhysicalMaterial({ color, roughness: 0.28, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08, ...o });
  return {
    black: phys("#0e0f14", { roughness: 0.22 }),
    carbon: phys("#17181e", { roughness: 0.45, clearcoat: 0.6 }),
    white: phys("#e8e9f2", { roughness: 0.32 }),
    blue: phys("#1a2ffb", { roughness: 0.3 }),
    metal: new THREE.MeshStandardMaterial({ color: "#9aa0ae", metalness: 1, roughness: 0.28 }),
    rubber: new THREE.MeshStandardMaterial({ color: "#16171b", roughness: 0.92 }),
    lime: new THREE.MeshStandardMaterial({ color: "#c1ff00", emissive: "#c1ff00", emissiveIntensity: 1.4 }),
    red: phys("#e5332a"),
    glass: phys("#0a0b10", { roughness: 0.05, transmission: 0, metalness: 0.2 }),
  };
}
type M = ReturnType<typeof materials>;

const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, pos?: THREE.Vector3, rot?: [number, number, number]) {
  const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true;
  if (pos) m.position.copy(pos); if (rot) m.rotation.set(...rot);
  return m;
}
function part(parts: Part[], group: THREE.Group, obj: THREE.Object3D, dir: THREE.Vector3, delay = 0, label?: Part["label"]) {
  group.add(obj); parts.push({ obj, home: obj.position.clone(), dir, delay, label });
  return obj;
}
function tube(points: THREE.Vector3[], r: number, mat: THREE.Material) {
  return mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 48, r, 12, false), mat);
}

// ---------------------------------------------------------------- Holybro X500 V2 (aerial)
export function buildDrone(m: M = materials()): Robot {
  const group = new THREE.Group(), parts: Part[] = [], spin: THREE.Object3D[] = [];
  const plate = (y: number) => mesh(new RoundedBoxGeometry(1.5, 0.05, 1.5, 4, 0.12), m.carbon, v(0, y, 0));
  part(parts, group, plate(0.38), v(0, 0.9, 0), 0.1, { title: "Carbon frame", spec: "500 mm wheelbase" });
  part(parts, group, plate(0.04), v(0, -0.6, 0), 0.1);
  const fc = new THREE.Group(); fc.position.set(0, 0.52, 0.05);
  fc.add(mesh(new RoundedBoxGeometry(0.62, 0.2, 0.92, 3, 0.05), m.blue));
  fc.add(mesh(new THREE.BoxGeometry(0.05, 0.03, 0.05), m.lime, v(0.2, 0.11, -0.35)));
  part(parts, group, fc, v(0, 1.8, 0), 0.35, { title: "Flight controller", spec: "Pixhawk 6C · PX4" });
  const gps = new THREE.Group(); gps.position.set(0, 0.52, 0.55);
  gps.add(mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.7, 12), m.black, v(0, 0.35, 0)));
  gps.add(mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.1, 40), m.white, v(0, 0.74, 0)));
  gps.add(mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.02, 24), m.black, v(0, 0.8, 0)));
  part(parts, group, gps, v(0, 3.0, 0.6), 0.5, { title: "GNSS receiver", spec: "M10 GPS module" });
  const bat = new THREE.Group(); bat.position.set(0, -0.26, 0);
  bat.add(mesh(new RoundedBoxGeometry(0.62, 0.36, 1.38, 3, 0.06), m.white));
  bat.add(mesh(new THREE.BoxGeometry(0.66, 0.38, 0.12), m.blue, v(0, 0, 0.3)));
  bat.add(mesh(new THREE.BoxGeometry(0.66, 0.38, 0.12), m.blue, v(0, 0, -0.3)));
  part(parts, group, bat, v(0, -2.0, 0), 0.3, { title: "Battery", spec: "4S 5000 mAh · ≈ 18 min" });
  const cam = new THREE.Group(); cam.position.set(0, -0.2, -0.95);
  cam.add(mesh(new THREE.SphereGeometry(0.24, 32, 20), m.black));
  cam.add(mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.16, 24), m.glass, v(0, -0.04, -0.2), [Math.PI / 2, 0, 0]));
  cam.add(mesh(new THREE.TorusGeometry(0.12, 0.02, 10, 32), m.blue, v(0, -0.04, -0.28)));
  part(parts, group, cam, v(0, -1.0, -2.2), 0.45, { title: "Survey camera", spec: "84° HFOV · 105 m swath at 60 m" });

  const diag = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
  diag.forEach(([sx, sz], i) => {
    const dirXZ = v(sx, 0, sz).normalize(), R = 2.5 / Math.SQRT2 * Math.SQRT2; // motor radius 2.5 (wheelbase 500 mm)
    const arm = mesh(new THREE.CylinderGeometry(0.075, 0.075, 1.95, 16), m.black, dirXZ.clone().multiplyScalar(1.55).setY(0.22), [0, 0, 0]);
    arm.quaternion.setFromUnitVectors(v(0, 1, 0), dirXZ);
    part(parts, group, arm, dirXZ.clone().multiplyScalar(1.1), 0.0, i === 0 ? { title: "Arms", spec: "Carbon tube · folding" } : undefined);
    const motor = new THREE.Group(); motor.position.copy(dirXZ.clone().multiplyScalar(R)).setY(0.3);
    motor.add(mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.12, 32), m.black, v(0, -0.06, 0)));
    motor.add(mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.2, 32), m.metal, v(0, 0.1, 0)));
    motor.add(mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.05, 32), m.blue, v(0, 0.2, 0)));
    part(parts, group, motor, dirXZ.clone().multiplyScalar(1.6).setY(0.4), 0.15, i === 1 ? { title: "Motors", spec: "4 × brushless 2216 KV920" } : undefined);
    const prop = new THREE.Group(); prop.position.copy(motor.position).setY(0.56);
    for (const s of [1, -1]) {
      const blade = mesh(new RoundedBoxGeometry(1.2, 0.025, 0.2, 2, 0.01), m.white, v(0.62 * s, 0, 0), [s * 0.14, 0, 0]);
      prop.add(blade);
    }
    prop.add(mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.08, 16), m.metal));
    spin.push(prop);
    part(parts, group, prop, dirXZ.clone().multiplyScalar(1.8).setY(1.6), 0.25, i === 2 ? { title: "Propellers", spec: "10-inch · ≈ 1 kg payload" } : undefined);
  });
  for (const s of [1, -1]) {
    const gear = tube([v(0.45 * s, 0.02, 0.6), v(0.75 * s, -0.55, 0.62), v(0.85 * s, -0.95, 0.65), v(0.85 * s, -0.95, -0.65), v(0.75 * s, -0.55, -0.62), v(0.45 * s, 0.02, -0.6)], 0.045, m.black);
    part(parts, group, gear, v(0.9 * s, -1.4, 0), 0.2, s === 1 ? { title: "Landing gear", spec: "Shock-absorbing skids" } : undefined);
  }
  return { group, parts, spin, radius: 3.4 };
}

// ---------------------------------------------------------------- Clearpath Husky A300 (ground)
export function buildRover(m: M = materials()): Robot {
  const group = new THREE.Group(), parts: Part[] = [], spin: THREE.Object3D[] = [];
  const W = 9.9, D = 6.98;           // length (x) and width (z) in units
  part(parts, group, mesh(new RoundedBoxGeometry(7.6, 2.0, 4.6, 5, 0.32), m.white, v(0, 1.95, 0)), v(0, 0, 0), 0, { title: "Chassis", spec: "990 × 698 × 381 mm · IP54" });
  part(parts, group, mesh(new RoundedBoxGeometry(7.2, 0.16, 4.3, 3, 0.06), m.black, v(0, 3.02, 0)), v(0, 3.2, 0), 0.05, { title: "Payload deck", spec: "100 kg max payload" });
  for (const s of [1, -1]) part(parts, group, mesh(new RoundedBoxGeometry(0.5, 1.0, D - 0.4, 3, 0.18), m.black, v((W / 2 - 0.4) * s, 1.75, 0)), v(1.6 * s, 0, 0), 0.1, s === 1 ? { title: "Bumpers", spec: "Front and rear impact bars" } : undefined);
  const bat = new THREE.Group(); bat.position.set(-0.6, 2.2, 0);
  bat.add(mesh(new RoundedBoxGeometry(3.4, 1.0, 2.4, 3, 0.1), m.white));
  bat.add(mesh(new THREE.BoxGeometry(0.2, 1.04, 2.44), m.blue, v(0.9, 0, 0)));
  bat.add(mesh(new THREE.BoxGeometry(0.2, 1.04, 2.44), m.blue, v(-0.9, 0, 0)));
  part(parts, group, bat, v(0, 5.6, 0), 0.3, { title: "Battery", spec: "8 h standard run time" });
  const pc = new THREE.Group(); pc.position.set(1.6, 3.55, 0);
  pc.add(mesh(new RoundedBoxGeometry(2.4, 0.9, 2.0, 3, 0.12), m.black));
  pc.add(mesh(new THREE.BoxGeometry(0.08, 0.08, 0.5), m.lime, v(1.21, 0.15, 0)));
  part(parts, group, pc, v(0, 4.2, 0), 0.4, { title: "Onboard compute", spec: "ROS 2 Jazzy · autonomy stack" });
  const lidar = new THREE.Group(); lidar.position.set(3.0, 3.1, 0);
  lidar.add(mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.4, 16), m.black, v(0, 0.7, 0)));
  lidar.add(mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.55, 40), m.black, v(0, 1.65, 0)));
  lidar.add(mesh(new THREE.CylinderGeometry(0.56, 0.56, 0.16, 40), m.blue, v(0, 1.62, 0)));
  lidar.add(mesh(new THREE.CylinderGeometry(0.5, 0.55, 0.12, 40), m.white, v(0, 2.0, 0)));
  part(parts, group, lidar, v(1.2, 5.4, 0), 0.55, { title: "3D lidar", spec: "360° mapping · obstacle detection" });
  const cam = new THREE.Group(); cam.position.set(-2.4, 3.1, 1.2);
  cam.add(mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.8, 12), m.black, v(0, 0.9, 0)));
  cam.add(mesh(new RoundedBoxGeometry(0.7, 0.6, 0.6, 3, 0.12), m.white, v(0, 2.0, 0)));
  cam.add(mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.18, 24), m.glass, v(0.38, 2.0, 0), [0, 0, Math.PI / 2]));
  part(parts, group, cam, v(-1.4, 4.6, 1.2), 0.5, { title: "PTZ camera", spec: "Thermal + visual inspection" });
  const estop = mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.22, 24), m.red, v(-3.3, 3.2, -1.7));
  part(parts, group, estop, v(-1, 3.6, -1), 0.6);
  for (const z of [-1.5, -1.9]) part(parts, group, mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.6, 8), m.black, v(-2.9, 3.9, z)), v(-1, 4.8, -0.6), 0.6);

  // wheels: 330 mm tyres
  const tireGeo = new THREE.CylinderGeometry(1.65, 1.65, 1.15, 48);
  const tread = new THREE.BoxGeometry(0.22, 1.18, 0.16);
  [[2.95, 3.0], [-2.95, 3.0], [2.95, -3.0], [-2.95, -3.0]].forEach(([x, z], i) => {
    const wheel = new THREE.Group(); wheel.position.set(x, 1.65, z);
    const inner = new THREE.Group(); inner.rotation.x = Math.PI / 2; wheel.add(inner);
    inner.add(mesh(tireGeo, m.rubber));
    for (let k = 0; k < 28; k++) { const a = (k / 28) * Math.PI * 2; inner.add(mesh(tread, m.rubber, v(Math.cos(a) * 1.66, 0, Math.sin(a) * 1.66), [0, -a, 0])); }
    inner.add(mesh(new THREE.CylinderGeometry(1.0, 1.0, 1.2, 40), m.blue));
    inner.add(mesh(new THREE.CylinderGeometry(0.34, 0.34, 1.25, 24), m.metal));
    spin.push(inner);
    part(parts, group, wheel, v(x > 0 ? 0.8 : -0.8, -0.2, z > 0 ? 3.0 : -3.0), 0.2, i === 0 ? { title: "Drive wheels", spec: "4 × in-wheel motors · 2.0 m/s" } : undefined);
  });
  group.scale.setScalar(0.42);
  return { group, parts, spin, radius: 4.2 };
}

export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** Positions every part for an explode amount in [0, 1] (staggered by part delay). */
export function explode(robot: Robot, t: number, spread = 1) {
  for (const p of robot.parts) {
    const k = easeInOut(Math.min(1, Math.max(0, (t - p.delay * 0.45) / (1 - p.delay * 0.45))));
    p.obj.position.copy(p.home).addScaledVector(p.dir, k * spread);
  }
}
