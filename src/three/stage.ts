import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/** Glossy studio stage: room-environment reflections, key light and an electric-blue rim. */
export function createStage(canvas: HTMLCanvasElement, opts: { background?: string | null; fov?: number; shadows?: boolean } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: opts.background == null, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.LinearToneMapping; // keeps the electric blue from drifting to violet
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = !!opts.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  if (opts.background) scene.background = new THREE.Color(opts.background);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  scene.environment = env;
  const camera = new THREE.PerspectiveCamera(opts.fov ?? 32, 1, 0.1, 200);
  const key = new THREE.DirectionalLight("#ffffff", 2.2); key.position.set(6, 10, 7); key.castShadow = !!opts.shadows;
  key.shadow.mapSize.set(1024, 1024); key.shadow.camera.left = -8; key.shadow.camera.right = 8; key.shadow.camera.top = 8; key.shadow.camera.bottom = -8;
  scene.add(key);
  const rim = new THREE.PointLight("#1a2ffb", 60, 30, 1.6); rim.position.set(-6, 3, -5); scene.add(rim);
  const fill = new THREE.PointLight("#c9cdf6", 18, 30, 1.6); fill.position.set(5, 2, 6); scene.add(fill);
  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize); ro.observe(canvas);
  return {
    renderer, scene, camera, key,
    render: () => renderer.render(scene, camera),
    /** compile every material in the background so the first visible frame does not stall the scroll */
    warm: () => { const go = () => { try { renderer.compile(scene, camera); renderer.render(scene, camera); } catch { /* ignore */ } };
      const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
      ric ? ric(go, { timeout: 1500 }) : setTimeout(go, 200); },
    dispose: () => { ro.disconnect(); env.dispose(); pmrem.dispose(); renderer.dispose(); },
  };
}
