// The reference fleet as true 3D models on the operations map (MapLibre custom layer, three.js, shared GL context).
// Real models and proportions (Husky A300 990 mm long, X500 V2 500 mm wheelbase) at the drone's real altitude, drawn at a
// constant on-screen size like a navigation app (true size would be ~2 px at the imagery's maximum zoom).
// Soft ground shadows, spinning props, wheels turning with speed.
import maplibregl, { type CustomLayerInterface, type Map as MLMap } from "maplibre-gl";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { LngLat } from "../lib/geo";
import { buildDrone, buildRover, materials, type Robot } from "../three/robots";

export interface UnitPose { at: LngLat; hdg: number; alt: number; speed: number; visible: boolean }

const MODEL_UNIT = 0.1;                         // robots.ts builds in 100 mm units
const SCREEN_PX = { rover: 42, drone: 54 };

function shadowTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const x = c.getContext("2d")!, g = x.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, "rgba(0,0,0,0.55)"); g.addColorStop(0.6, "rgba(0,0,0,0.22)"); g.addColorStop(1, "rgba(0,0,0,0)");
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

interface Unit { scene: THREE.Scene; root: THREE.Group; yaw: THREE.Group; robot: Robot; shadow: THREE.Mesh; len: number; frontYaw: number }

export function fleetLayer(id: string, get: () => { drone: UnitPose; rover: UnitPose }): CustomLayerInterface {
  let renderer: THREE.WebGLRenderer, camera: THREE.Camera, map: MLMap, env: THREE.Texture | null = null;
  let drone: Unit, rover: Unit, last = performance.now();
  const shadowTex = shadowTexture();

  const makeUnit = (robot: Robot, len: number, frontYaw: number, shadowSize: number): Unit => {
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight("#ffffff", "#8a8f9f", 2.1));
    const sun = new THREE.DirectionalLight("#fff6ea", 3.4); sun.position.set(-0.6, -0.8, 1.6); scene.add(sun);   // metre frame: x east, y north, z up
    const root = new THREE.Group(), yaw = new THREE.Group(), upright = new THREE.Group();
    upright.rotation.x = Math.PI / 2;                    // models are Y-up; the map frame is Z-up
    robot.group.scale.setScalar(MODEL_UNIT);
    upright.add(robot.group); yaw.add(upright); root.add(yaw); scene.add(root);
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(shadowSize, shadowSize), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
    scene.add(shadow);
    return { scene, root, yaw, robot, shadow, len, frontYaw };
  };

  return {
    id, type: "custom", renderingMode: "3d",
    onAdd(m, gl) {
      map = m;
      camera = new THREE.Camera();
      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      try { const pm = new THREE.PMREMGenerator(renderer); env = pm.fromScene(new RoomEnvironment(renderer), 0.04).texture; pm.dispose(); } catch { env = null; }
      const mats = materials();
      Object.values(mats).forEach((mt) => { (mt as THREE.MeshStandardMaterial).envMapIntensity = 0.7; });
      // rover front is +x in the model; drone front is -z (camera side) -> after standing up it faces +y
      rover = makeUnit(buildRover(mats), 0.99, Math.PI / 2, 11);
      drone = makeUnit(buildDrone(mats), 0.7, 0, 9);
      for (const u of [rover, drone]) if (env) u.scene.environment = env;
    },
    render(_gl, matrix) {
      const st = get(), now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
      const z = map.getZoom(), lat = map.getCenter().lat;
      const mpp = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** z);
      const m = new THREE.Matrix4().fromArray(matrix as unknown as number[]);
      renderer.resetState();
      for (const [u, pose, isDrone] of [[rover, st.rover, false], [drone, st.drone, true]] as const) {
        if (!pose.visible) continue;
        const f = Math.max(1, ((isDrone ? SCREEN_PX.drone : SCREEN_PX.rover) * mpp) / u.len);
        const mc = maplibregl.MercatorCoordinate.fromLngLat(pose.at as [number, number], 0), k = mc.meterInMercatorCoordinateUnits();
        const alt = isDrone ? Math.max(0, pose.alt) : 0;
        u.root.position.set(0, 0, alt + (isDrone ? 0.12 * f : 0.02 * f));
        u.root.scale.setScalar(f);
        u.yaw.rotation.z = u.frontYaw - (pose.hdg * Math.PI) / 180;
        // shadow on the ground, softer and wider the higher the drone flies
        const spread = isDrone ? 1 + Math.min(3, alt / 25) : 1;
        u.shadow.position.set(0, 0, 0.05); u.shadow.scale.setScalar((f * spread) / 10);
        (u.shadow.material as THREE.MeshBasicMaterial).opacity = isDrone ? Math.max(0.15, 0.7 - alt / 120) : 0.85;
        // motion: props always spin when airborne, wheels with speed
        if (isDrone) u.robot.spin.forEach((p, i) => (p.rotation.y += dt * (alt > 1 ? 55 : 4) * (i % 2 ? -1 : 1)));
        else u.robot.spin.forEach((w) => (w.rotation.y += dt * (pose.speed / 0.165)));   // 330 mm wheels
        camera.projectionMatrix = m.clone().multiply(new THREE.Matrix4().makeTranslation(mc.x, mc.y, 0).scale(new THREE.Vector3(k, -k, k)));
        renderer.render(u.scene, camera);
      }
      map.triggerRepaint();
    },
    onRemove() { env?.dispose(); shadowTex.dispose(); renderer?.dispose(); },
  };
}
