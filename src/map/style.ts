import type { LayerSpecification, SourceSpecification, StyleSpecification } from "maplibre-gl";
import type { Imagery, ImageryTiles } from "../data/antakya";

// Satellite hybrid style, like Google Maps' satellite view, with no paid service and no API key:
//   * worldwide base: EOX Sentinel-2 cloudless mosaic (free, CC BY-NC-SA 4.0), so every zoom and every place is real imagery
//   * Antakya: Maxar Open Data at ~0.5 m (pre 22 Dec 2022 / post 11 Feb 2023), our own XYZ tiles
//   * on top: subtle OSM road casings and white labels (OpenFreeMap vector tiles)
export const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
export type Scene = "pre" | "post";

export function baseStyle(imagery: Imagery | null, scene: Scene = "post", tiles: ImageryTiles | null = null): StyleSpecification {
  const sources: Record<string, SourceSpecification> = {
    omt: { type: "vector", url: "https://tiles.openfreemap.org/planet", attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>' },
    s2: { type: "raster", tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/g/{z}/{y}/{x}.jpg"], tileSize: 256, maxzoom: 15,
      attribution: '<a href="https://s2maps.eu" target="_blank">Sentinel-2 cloudless</a> by EOX (Copernicus Sentinel data 2021)' } as SourceSpecification,
    dem: { type: "raster-dem", tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 14, encoding: "terrarium", attribution: "Terrain: Mapzen / AWS Open Data" },
  };
  const imageLayers: LayerSpecification[] = [];
  if (tiles) {
    // Google-Maps-like loading: 256 px tiles per zoom level, only what is on screen, full Maxar resolution at z18
    for (const key of ["pre", "post"] as Scene[]) {
      const id = `img-${key}`;
      sources[id] = { type: "raster", tiles: [`/data/antakya/tiles/${key}/{z}/{x}/{y}.jpg`], tileSize: 256, minzoom: tiles.minzoom, maxzoom: tiles.maxzoom, bounds: tiles.bounds } as SourceSpecification;
      imageLayers.push({ id, type: "raster", source: id, paint: { "raster-opacity": key === scene ? 1 : 0, "raster-opacity-transition": { duration: 600 }, "raster-fade-duration": 180, "raster-resampling": "linear" } } as unknown as LayerSpecification);
    }
  } else if (imagery) {
    for (const key of ["pre", "post"] as Scene[]) {
      const sc = imagery.scenes[key];
      for (const ext of ["outer", "inner"] as const) {
        const l = sc.layers[ext];
        const id = `img-${key}-${ext}`;
        sources[id] = { type: "image", url: `/data/antakya/imagery/${l.file}`, coordinates: l.coordinates as [[number, number], [number, number], [number, number], [number, number]]} as SourceSpecification;
        imageLayers.push({ id, type: "raster", source: id, paint: { "raster-opacity": key === scene ? 1 : 0, "raster-opacity-transition": { duration: 700 }, "raster-fade-duration": 0, "raster-contrast": 0.05, "raster-saturation": 0.05 } } as unknown as LayerSpecification);
      }
    }
  }
  const halo = { "text-color": "#ffffff", "text-halo-color": "rgba(20,22,25,0.85)", "text-halo-width": 1.4 };
  return {
    version: 8,
    glyphs: GLYPHS,
    sources,
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#4a4a3c" } },
      { id: "s2", type: "raster", source: "s2", paint: { "raster-fade-duration": 200, "raster-saturation": -0.05, "raster-contrast": 0.08, "raster-brightness-max": 0.95 } },
      ...imageLayers,
      // hybrid overlay: thin road casings that fade in with zoom, like Google's satellite view
      { id: "road-major", type: "line", source: "omt", "source-layer": "transportation", minzoom: 11, filter: ["in", ["get", "class"], ["literal", ["primary", "secondary", "trunk", "motorway"]]], layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#fff3c4", "line-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.55, 15, 0.35, 17, 0.18], "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 11, 0.8, 17, 4] } },
      { id: "road-minor", type: "line", source: "omt", "source-layer": "transportation", minzoom: 14, filter: ["in", ["get", "class"], ["literal", ["tertiary", "minor"]]], layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0.3, 17, 0.12], "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 14, 0.5, 17, 2.5] } },
      { id: "boundary", type: "line", source: "omt", "source-layer": "boundary", filter: ["<=", ["get", "admin_level"], 4], paint: { "line-color": "#ffffff", "line-opacity": 0.45, "line-dasharray": [3, 2], "line-width": 1 } },
      { id: "road-label", type: "symbol", source: "omt", "source-layer": "transportation_name", minzoom: 15, filter: ["in", ["get", "class"], ["literal", ["primary", "secondary", "tertiary", "minor"]]],
        layout: { "symbol-placement": "line", "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]], "text-font": ["Noto Sans Regular"], "text-size": 12 }, paint: halo },
      { id: "water-label", type: "symbol", source: "omt", "source-layer": "waterway", minzoom: 13,
        layout: { "symbol-placement": "line", "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]], "text-font": ["Noto Sans Italic"], "text-size": 12 }, paint: { ...halo, "text-color": "#cfe6ff" } },
      { id: "place-label", type: "symbol", source: "omt", "source-layer": "place", filter: ["any", ["in", ["get", "class"], ["literal", ["country", "state", "city"]]], ["all", ["==", ["get", "class"], "town"], [">=", ["zoom"], 10]], ["all", ["==", ["get", "class"], "village"], [">=", ["zoom"], 12.5]], ["all", ["in", ["get", "class"], ["literal", ["suburb", "neighbourhood", "quarter"]]], [">=", ["zoom"], 13.5]]],
        layout: { "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]], "text-font": ["Noto Sans Bold"], "text-size": ["match", ["get", "class"], "country", 15, "state", 13, "city", 16, "town", 14, 12], "text-max-width": 8 }, paint: halo },
    ],
  };
}

export function setScene(map: import("maplibre-gl").Map, scene: Scene) {
  for (const key of ["pre", "post"]) for (const id of [`img-${key}`, `img-${key}-outer`, `img-${key}-inner`]) {
    if (map.getLayer(id)) map.setPaintProperty(id, "raster-opacity", key === scene ? 1 : 0);
  }
}
