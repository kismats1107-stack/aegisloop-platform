// UAV-1 sensor beam as a MapLibre custom 3D layer (three.js): a translucent cone from the drone down to the
// ground, the camera footprint (true size: 105 m swath at 60 m AGL) with a grid and a sweeping scan line.
import maplibregl, { type CustomLayerInterface, type Map as MLMap } from "maplibre-gl";
import * as THREE from "three";
import type { LngLat } from "../lib/geo";

export interface BeamState { at: LngLat; alt: number; hdg: number; active: boolean }

const VS = /* glsl */ `
varying vec2 vUv;
varying float vH;
void main() { vUv = uv; vH = position.z; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const CONE_FS = /* glsl */ `
uniform float uTime, uOn;
varying vec2 vUv;
varying float vH;
void main() {
  float lines = smoothstep(0.92, 1.0, fract(vUv.x * 24.0)) * 0.55 + smoothstep(0.94, 1.0, fract(vUv.y * 10.0 - uTime * 0.8)) * 0.6;
  float fadeTop = smoothstep(1.0, 0.75, vUv.y);           // brighter near the ground
  float a = (0.2 + lines * 0.45) * (1.0 - fadeTop * 0.5) * uOn;
  gl_FragColor = vec4(vec3(0.38, 0.62, 1.0) + lines * 0.3, a);
}`;
const FOOT_FS = /* glsl */ `
uniform float uTime, uOn;
varying vec2 vUv;
void main() {
  vec2 g = abs(fract(vUv * 10.0) - 0.5);
  float grid = smoothstep(0.46, 0.5, max(g.x, g.y));
  float edge = smoothstep(0.47, 0.5, max(abs(vUv.x - 0.5), abs(vUv.y - 0.5)));
  float sweep = smoothstep(0.035, 0.0, abs(vUv.y - fract(uTime * 0.45)));
  float a = (0.08 + grid * 0.35 + edge * 0.85 + sweep * 0.7) * uOn;
  gl_FragColor = vec4(mix(vec3(0.35, 0.6, 1.0), vec3(0.85, 0.95, 1.0), sweep + edge * 0.4), a);
}`;

/** Creates the beam layer. `get()` is called every frame for the drone's current state. */
export function scanBeamLayer(id: string, swathM: number, get: () => BeamState): CustomLayerInterface {
  let renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, group: THREE.Group;
  let cone: THREE.Mesh, foot: THREE.Mesh, uniforms: { uTime: { value: number }; uOn: { value: number } };
  let map: MLMap, on = 0, t0 = performance.now();
  return {
    id, type: "custom", renderingMode: "3d",
    onAdd(m, gl) {
      map = m;
      camera = new THREE.Camera();
      scene = new THREE.Scene();
      group = new THREE.Group();
      scene.add(group);
      uniforms = { uTime: { value: 0 }, uOn: { value: 0 } };
      const half = swathM / 2;
      // pyramid frustum (square footprint, like a nadir camera), apex at the drone, open at the ground
      const coneGeo = new THREE.CylinderGeometry(0.4, half * Math.SQRT2, 1, 4, 1, true);
      coneGeo.rotateY(Math.PI / 4);
      coneGeo.rotateX(Math.PI / 2);           // axis along z (up) in our metre frame
      coneGeo.translate(0, 0, 0.5);
      cone = new THREE.Mesh(coneGeo, new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: CONE_FS, uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
      foot = new THREE.Mesh(new THREE.PlaneGeometry(swathM, swathM), new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FOOT_FS, uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
      foot.position.z = 0.6;
      group.add(cone, foot);
      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },
    render(_gl, matrix) {
      const s = get();
      on += ((s.active && s.alt > 5 ? 1 : 0) - on) * 0.08;
      if (on < 0.01) return;
      const mc = maplibregl.MercatorCoordinate.fromLngLat(s.at as [number, number], 0);
      const k = mc.meterInMercatorCoordinateUnits();
      const elev = map.queryTerrainElevation(s.at as [number, number]) ?? 0;
      const alt = Math.max(1, s.alt);
      cone.scale.set(1, 1, alt);
      group.rotation.set(0, 0, (-s.hdg * Math.PI) / 180);
      const m = new THREE.Matrix4().fromArray(matrix as unknown as number[]);
      const l = new THREE.Matrix4().makeTranslation(mc.x, mc.y, elev * k).scale(new THREE.Vector3(k, -k, k));
      camera.projectionMatrix = m.multiply(l);
      uniforms.uTime.value = (performance.now() - t0) / 1000;
      uniforms.uOn.value = on;
      renderer.resetState();
      renderer.render(scene, camera);
      map.triggerRepaint();
    },
  };
}
