// "Any city": real buildings, roads and water from OpenStreetMap (Overpass API) around a searched place,
// shaped as CaseData so the operations console and mission engine run on it unchanged.
// Damage there is simulated by the scenario (earthquake / flood / fire) and labelled as such.
import type { Feature, FeatureCollection, Geometry, LineString, Polygon } from "geojson";
import type { Bounds, BuildingProps, CaseData, RoadProps } from "./antakya";

export interface PlaceHit { name: string; display: string; lat: number; lon: number }

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];

/** Free OpenStreetMap place search (Nominatim; low volume, one request per search). */
export async function searchPlaces(q: string): Promise<PlaceHit[]> {
  const url = `${NOMINATIM}?format=json&limit=6&accept-language=en&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`Place search failed (${r.status})`);
  const j = (await r.json()) as { name?: string; display_name: string; lat: string; lon: string }[];
  return j.map((h) => ({ name: h.name || h.display_name.split(",")[0], display: h.display_name, lat: +h.lat, lon: +h.lon }));
}

interface OsmWay { type: "way"; id: number; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[] }

const cache = new Map<string, Promise<CaseData>>();
/** Loads a square of `size` metres around the place. */
export function loadOsmPlace(hit: PlaceHit, size = 1200): Promise<CaseData> {
  const k = `${hit.lat.toFixed(5)},${hit.lon.toFixed(5)},${size}`;
  if (!cache.has(k)) { const p = build(hit, size); cache.set(k, p); p.catch(() => cache.delete(k)); }
  return cache.get(k)!;
}

async function build(hit: PlaceHit, size: number): Promise<CaseData> {
  const dLat = size / 2 / 111320, dLon = size / 2 / (111320 * Math.cos((hit.lat * Math.PI) / 180));
  const bounds: Bounds = [hit.lon - dLon, hit.lat - dLat, hit.lon + dLon, hit.lat + dLat];
  const bb = `${bounds[1]},${bounds[0]},${bounds[3]},${bounds[2]}`;
  const q = `[out:json][timeout:60];(
    way["building"](${bb});
    way["highway"]["highway"!~"^(proposed|construction|steps|corridor|elevator|platform|bus_stop|raceway|bridleway|abandoned)$"]["area"!="yes"](${bb});
    way["natural"="water"](${bb});
    way["waterway"~"^(river|stream|canal)$"](${bb});
  );out geom;`;
  let json: { elements: OsmWay[] } | null = null, lastErr = "";
  for (const ep of OVERPASS) {
    try {
      const r = await fetch(ep, { method: "POST", body: new URLSearchParams({ data: q }) });
      if (!r.ok) { lastErr = `${r.status}`; continue; }
      json = await r.json(); break;
    } catch (e) { lastErr = (e as Error).message; }
  }
  if (!json) throw new Error(`OpenStreetMap data service unavailable (${lastErr}). Try again in a minute.`);

  const lat0 = hit.lat, mLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const buildings: Feature<Polygon, BuildingProps>[] = [], roads: Feature<LineString, RoadProps>[] = [], water: Feature<Geometry, { n?: string }>[] = [];
  const hash = (n: number) => { let x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); };
  for (const el of json.elements) {
    const g = el.geometry, t = el.tags ?? {};
    if (!g || g.length < 2) continue;
    const coords = g.map((p) => [p.lon, p.lat] as [number, number]);
    const closed = coords.length > 3 && coords[0][0] === coords[coords.length - 1][0] && coords[0][1] === coords[coords.length - 1][1];
    if (t.building && closed) {
      let a = 0; for (let i = 1; i < coords.length; i++) a += (coords[i - 1][0] * mLon) * (coords[i][1] * 111320) - (coords[i][0] * mLon) * (coords[i - 1][1] * 111320);
      a = Math.abs(a / 2);
      if (a < 12) continue;
      const lv = parseFloat(t["building:levels"]), hh = parseFloat(t.height);
      const est = !(hh > 0 || lv > 0);
      const h = hh > 0 ? hh : lv > 0 ? lv * 3.1 : Math.round(6 + hash(el.id) * 12);
      buildings.push({ type: "Feature", properties: { id: `osm-w${el.id}`, g: 0, h, h0: h, est: est ? 1 : 0, a: Math.round(a), m: 0, n: t.name ?? "", k: "building", src: "osm" }, geometry: { type: "Polygon", coordinates: [coords] } });
    } else if (t.highway) {
      roads.push({ type: "Feature", properties: { g: 0, n: t.name ?? t.ref ?? "", t: t.highway }, geometry: { type: "LineString", coordinates: coords } });
    } else if (t.natural === "water" && closed) {
      water.push({ type: "Feature", properties: { n: t.name }, geometry: { type: "Polygon", coordinates: [coords] } });
    } else if (t.waterway) {
      water.push({ type: "Feature", properties: { n: t.name }, geometry: { type: "LineString", coordinates: coords } });
    }
  }
  if (!roads.length) throw new Error("OpenStreetMap has no roads mapped here. Pick a more central point.");
  const fc = <T extends Feature>(features: T[]) => ({ type: "FeatureCollection", features }) as FeatureCollection<T["geometry"], T["properties"] & object>;
  return {
    meta: {
      id: `osm-${hit.lat.toFixed(4)}_${hit.lon.toFixed(4)}`, origin: "osm", title: hit.name,
      event: { date: "", localTime: "", tz: "", magnitude: "", epicentre: "", aftershock: "" },
      missionBounds: bounds, contextBounds: bounds, center: [hit.lon, hit.lat],
      stats: { aoi11: { blocks: 0, destroyed: 0, damaged: 0, possibly: 0, roadsBlocked: 0, camps: 0, barriers: 0 }, mission: { blocks: 0, destroyed: 0, damaged: 0, possibly: 0, buildings: buildings.length, buildingsAffected: 0, roadsBlocked: 0, heightsFromOsm: buildings.filter((b) => !b.properties.est).length } },
      geometry: "OpenStreetMap",
      sources: [{ name: "Buildings, roads and water © OpenStreetMap contributors", licence: "ODbL", url: "https://www.openstreetmap.org/copyright" },
        { name: "Sentinel-2 cloudless by EOX (Copernicus Sentinel data 2021)", licence: "CC BY-NC-SA 4.0", url: "https://s2maps.eu" }],
    },
    buildings: fc(buildings) as CaseData["buildings"], roads: fc(roads) as CaseData["roads"],
    blocks: { type: "FeatureCollection", features: [] }, crisis: { type: "FeatureCollection", features: [] },
    water: fc(water) as CaseData["water"], imagery: null, tiles: null,
  };
}
