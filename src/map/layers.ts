import type { ExpressionSpecification, Map as MLMap } from "maplibre-gl";
import type { Bounds, CaseData } from "../data/antakya";
import { GRADE_COLOR } from "../data/antakya";
import type { Scene } from "./style";

// effective grade: a scenario (flood, fire) may override the Copernicus grade through feature-state "sg"
const G: ExpressionSpecification = ["coalesce", ["feature-state", "sg"], ["get", "g"]];
const gradeColor: ExpressionSpecification = ["match", G, 3, GRADE_COLOR[3], 2, GRADE_COLOR[2], 1, GRADE_COLOR[1], GRADE_COLOR[0]];

export const boundsPolygon = (b: Bounds) => ({
  type: "Feature" as const, properties: {},
  geometry: { type: "Polygon" as const, coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]] },
});

/**
 * Damage overlay on imagery: graded footprints (fill + outline) and light 3D massing for mapped OSM buildings.
 * Copernicus block polygons are never extruded — the imagery shows the real buildings inside them.
 * With `fogOfWar`, structures in the mission sector show no grade until feature-state { v: true } (drone coverage).
 */
export function addCaseLayers(map: MLMap, data: CaseData, opts: { fogOfWar?: boolean; threeD?: boolean } = {}) {
  const fog = !!opts.fogOfWar;
  map.addSource("buildings", { type: "geojson", data: data.buildings, promoteId: "id" });
  map.addSource("roads", { type: "geojson", data: data.roads });
  map.addSource("crisis", { type: "geojson", data: data.crisis });
  map.addSource("aoi", { type: "geojson", data: boundsPolygon(data.meta.missionBounds) });

  const known: ExpressionSpecification = fog ? ["boolean", ["feature-state", "v"], false] : ["literal", true];
  const graded: ExpressionSpecification = ["all", known, [">=", G, 1]];
  // with fog of war every structure is unknown until UAV-1's camera has covered it (survey areas can be anywhere)
  const unverified: ExpressionSpecification = fog ? ["!", known] : ["literal", false];

  map.addLayer({
    id: "bld-foot", type: "fill", source: "buildings",
    paint: { "fill-color": ["case", graded, gradeColor, unverified, "#ffffff", "#000000"], "fill-opacity": ["case", graded, ["match", G, 3, 0.24, 0.13], unverified, 0.06, 0] },
  });
  map.addLayer({
    id: "bld-outline", type: "line", source: "buildings",
    paint: { "line-color": ["case", graded, gradeColor, "#ffffff"], "line-width": ["case", graded, ["match", G, 3, 1.5, 1], unverified, 0.6, 0], "line-opacity": ["case", graded, 1, unverified, 0.55, 0] },
  });
  map.addLayer({
    id: "bld", type: "fill-extrusion", source: "buildings", layout: { visibility: opts.threeD ? "visible" : "none" }, filter: ["all", ["!=", ["get", "k"], "block"], ["<", ["get", "g"], 3]],
    paint: {
      "fill-extrusion-color": ["case", ["all", known, ["==", ["get", "g"], 2]], "#f6a15a", ["all", known, ["==", ["get", "g"], 1]], "#f3d76a", "#f4f4f1"],
      "fill-extrusion-height": ["get", "h0"],
      "fill-extrusion-opacity": 0.82,
      "fill-extrusion-vertical-gradient": true,
    },
  });
  map.addLayer({
    id: "roads-blocked-casing", type: "line", source: "roads", filter: [">=", ["get", "g"], 2],
    paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 13, 2, 17, 5], "line-opacity": fog ? 0 : 0.55 },
  });
  map.addLayer({
    id: "roads-blocked", type: "line", source: "roads", filter: [">=", ["get", "g"], 2],
    paint: { "line-color": GRADE_COLOR[3], "line-width": ["interpolate", ["linear"], ["zoom"], 13, 1.2, 17, 3], "line-dasharray": [2, 1.2], "line-opacity": fog ? 0 : 1 },
  });
  map.addLayer({ id: "aoi-line", type: "line", source: "aoi", paint: { "line-color": "#ffffff", "line-width": 2, "line-dasharray": [3, 2], "line-opacity": 0.95 } });
  map.addLayer({
    id: "crisis-camp", type: "circle", source: "crisis", filter: ["==", ["get", "t"], "Camp"],
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 3.5, 17, 7], "circle-color": "#1a66d9", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
  });
  map.addLayer({
    id: "crisis-barrier", type: "circle", source: "crisis", filter: ["==", ["get", "t"], "Physical Barrier"],
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 3, 17, 6], "circle-color": "#f9ab00", "circle-stroke-color": "#3c2a00", "circle-stroke-width": 1.5 },
  });
}

/** Before the earthquake every structure stands at its pre-event height and the damage overlay is hidden. */
export function setCaseScene(map: MLMap, scene: Scene, overlay = true) {
  if (!map.getLayer("bld")) return;
  map.setFilter("bld", scene === "pre" ? ["!=", ["get", "k"], "block"] : ["all", ["!=", ["get", "k"], "block"], ["<", ["get", "g"], 3]]);
  const show = scene === "post" && overlay ? "visible" : "none";
  for (const id of ["bld-foot", "bld-outline", "roads-blocked-casing", "roads-blocked"]) map.setLayoutProperty(id, "visibility", show);
  // crisis information (spontaneous sites, barriers) only exists after the event
  const crisis = scene === "pre" || map.getContainer().dataset.noCrisis ? "none" : "visible";
  for (const id of ["crisis-camp", "crisis-barrier"]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", crisis);
}

export function setLightForCase(map: MLMap) {
  map.setLight({ anchor: "map", position: [1.3, 160, 40], color: "#ffffff", intensity: 0.32 });
  map.setSky({ "sky-color": "#bcd4ec", "horizon-color": "#e9eef3", "fog-color": "#eef1f4", "fog-ground-blend": 0.6, "horizon-fog-blend": 0.5, "sky-horizon-blend": 0.8, "atmosphere-blend": 0 });
}
