import type { FeatureCollection, Geometry } from "geojson";

export type Bounds = [number, number, number, number];
export type Grade = -1 | 0 | 1 | 2 | 3;

export interface CaseMeta {
  id: string;
  /** "case" = curated real disaster (real damage); "osm" = any city from OpenStreetMap (damage simulated). */
  origin?: "case" | "osm";
  title: string;
  event: { date: string; localTime: string; tz: string; magnitude: string; epicentre: string; aftershock: string };
  missionBounds: Bounds;
  contextBounds: Bounds;
  center: [number, number];
  stats: {
    aoi11: { blocks: number; destroyed: number; damaged: number; possibly: number; roadsBlocked: number; camps: number; barriers: number };
    mission: { blocks: number; destroyed: number; damaged: number; possibly: number; buildings: number; buildingsAffected: number; roadsBlocked: number; heightsFromOsm: number };
  };
  geometry: string;
  sources: { name: string; date?: string; licence: string; url: string }[];
}

export interface BuildingProps { g: Grade; h: number; h0: number; est: 0 | 1; a: number; m: 0 | 1; n: string; k: string; src: string; id: string }
export interface RoadProps { g: Grade; n: string; t: string }
export interface BlockProps { g: Grade; n: string; t: string; m: 0 | 1 }
export interface CrisisProps { t: string; d: string; n: number | null }

export interface ImageryLayer { file: string; coordinates: [number, number][]; px: [number, number] }
export interface Imagery { source: string; url: string; scenes: Record<"pre" | "post", { date: string; gsd: number; catalog: string; layers: Record<"inner" | "outer", ImageryLayer> }> }

export interface ImageryTiles { minzoom: number; maxzoom: number; bounds: Bounds; innerBounds: Bounds }

export interface CaseData {
  imagery: Imagery | null;
  tiles: ImageryTiles | null;
  meta: CaseMeta;
  buildings: FeatureCollection<Geometry, BuildingProps>;
  blocks: FeatureCollection<Geometry, BlockProps>;
  roads: FeatureCollection<Geometry, RoadProps>;
  crisis: FeatureCollection<Geometry, CrisisProps>;
  water: FeatureCollection<Geometry, { n?: string }> | null;
}

export const GRADE_LABEL: Record<Grade, string> = { [-1]: "Not graded", 0: "No visible damage", 1: "Possibly damaged", 2: "Damaged", 3: "Destroyed" };
export const GRADE_COLOR: Record<Grade, string> = { [-1]: "#9aa3ad", 0: "#9aa3ad", 1: "#e8b400", 2: "#f07c1a", 3: "#d93025" };

let cache: Promise<CaseData> | null = null;
export function loadAntakya(): Promise<CaseData> {
  if (!cache) {
    const get = (f: string) => fetch(`/data/antakya/${f}`).then((r) => { if (!r.ok) throw new Error(`${f}: ${r.status}`); return r.json(); });
    cache = Promise.all(["meta.json", "buildings.geojson", "blocks.geojson", "roads.geojson", "crisis.geojson"].map(get))
      .then(async ([meta, buildings, blocks, roads, crisis]) => {
        const [imagery, tiles, water] = await Promise.all([get("imagery/imagery.json").catch(() => null), get("tiles/tiles.json").catch(() => null), get("water.geojson").catch(() => null)]);
        return { meta, buildings, blocks, roads, crisis, imagery, tiles, water };
      });
    cache.catch(() => { cache = null; });
  }
  return cache;
}
