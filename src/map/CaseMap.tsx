import { useEffect, useRef } from "react";
import maplibregl, { type Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { CaseData } from "../data/antakya";
import { baseStyle, type Scene, setScene } from "./style";
import { addCaseLayers, setCaseScene, setLightForCase } from "./layers";

export interface CaseMapProps {
  data: CaseData;
  scene?: Scene;                   // imagery: before (Dec 2022) or after (Feb 2023) the earthquake
  overlay?: boolean;               // damage grading overlay
  fogOfWar?: boolean;
  orbit?: boolean;                 // slow rotation (paused under reduced motion, off-screen, or after user interaction)
  interactive?: boolean;
  scrollZoom?: boolean;
  terrain?: boolean;
  view?: { zoom?: number; pitch?: number; bearing?: number; center?: [number, number] };
  controls?: boolean;
  onReady?: (map: MLMap) => void;
  className?: string;
  label?: string;
}

export function CaseMap({ data, scene = "post", overlay = true, fogOfWar, orbit, interactive = true, scrollZoom = true, terrain = false, view, controls, onReady, className, label }: CaseMapProps) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const readyCb = useRef(onReady);
  readyCb.current = onReady;
  const sceneRef = useRef({ scene, overlay });
  sceneRef.current = { scene, overlay };

  useEffect(() => {
    if (!el.current) return;
    const map = new maplibregl.Map({
      container: el.current,
      style: baseStyle(data.imagery, scene, data.tiles),
      center: view?.center ?? data.meta.center,
      zoom: view?.zoom ?? 16,
      pitch: view?.pitch ?? 50,
      bearing: view?.bearing ?? -20,
      maxPitch: 68,
      maxZoom: 18.6,                   // Maxar is ~0.5 m: beyond this we would only stretch pixels
      interactive,
      scrollZoom,
      cooperativeGestures: interactive && !scrollZoom ? true : undefined,
      attributionControl: { compact: true, customAttribution: data.tiles ? ["Imagery © Maxar Open Data Program (CC BY-NC 4.0)", "Damage grading © European Union, Copernicus EMS (EMSR648)"] : ["Buildings, roads and water © OpenStreetMap contributors (ODbL)"] },
      fadeDuration: 0,
      pixelRatio: Math.min(window.devicePixelRatio, 2),
      maxTileCacheSize: 600,
      refreshExpiredTiles: false,
      renderWorldCopies: false,
      dragRotate: true,
      touchPitch: true,
    });
    mapRef.current = map;
    if (import.meta.env.DEV) { (window as unknown as { __caseMap: MLMap }).__caseMap = map; map.on("error", (e) => console.warn("[map error]", e.error?.message ?? e)); }   // test hook (dev only)
    if (controls) map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

    // attach our layers as soon as the style is ready (do not wait for every basemap tile: a slow tile server must not block the console)
    map.once("style.load", () => {
      if (terrain) map.setTerrain({ source: "dem", exaggeration: 1 });
      setLightForCase(map);
      addCaseLayers(map, data, { fogOfWar });
      setCaseScene(map, sceneRef.current.scene, sceneRef.current.overlay);
      readyCb.current?.(map);
    });

    let raf = 0, visible = true, last = performance.now(), userBusy = false;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; });
    io.observe(el.current);
    if (orbit && !reduce) {
      const stop = () => (userBusy = true);
      map.on("mousedown", stop); map.on("touchstart", stop); map.on("wheel", stop);
      const tick = (t: number) => {
        const dt = Math.min(50, t - last); last = t;
        if (visible && !userBusy && map.loaded()) map.setBearing(map.getBearing() + dt * 0.0016);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
    return () => { cancelAnimationFrame(raf); io.disconnect(); map.remove(); mapRef.current = null; };
    // the map is created once per dataset; view props are initial values
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    setScene(map, scene);
    setCaseScene(map, scene, overlay);
  }, [scene, overlay]);

  return <div ref={el} className={className} role="region" aria-label={label ?? "Map of the Antakya case area"} />;
}
