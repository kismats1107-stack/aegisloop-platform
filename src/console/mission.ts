// Browser mission engine for the Antakya case replay.
// Geography, building grades and road damage come from the Copernicus/OSM dataset; robots, timings, the mid-route
// obstruction and any signals of interest are simulated with the published limits of the X500 and Husky A300.
import type { CaseData } from "../data/antakya";
import { HUSKY_PLAN_SPEED, X500_ALT, X500_CRUISE, X500_ENDURANCE_S, X500_SWATH } from "../data/fleet";
import { Frame, type LngLat, Path, type XY, dist, sha256 } from "../lib/geo";
import { type Edge, type Route, buildGraph, hazardsAlong, nearestNode, shortestPath } from "../lib/roadgraph";
import type { ApproveResult, Check, LiveEvent, LiveLink, ProposeResult } from "./live";
import { type FloodTerrain, HUSKY_WADE, depthAtXY, floodReach } from "../lib/flood";

export type Phase = "standby" | "survey" | "review" | "awaiting_approval" | "executing" | "incident" | "on_site" | "complete";
export const PHASES: { id: Phase; label: string }[] = [
  { id: "standby", label: "Standby" },
  { id: "survey", label: "Aerial survey" },
  { id: "review", label: "Findings review" },
  { id: "awaiting_approval", label: "Plan approval" },
  { id: "executing", label: "Ground execution" },
  { id: "on_site", label: "Site inspection" },
  { id: "complete", label: "Target closed" },
];

export type FindingKind = "collapse" | "damaged" | "road" | "barrier" | "camp" | "incident" | "signal";
export interface Finding { id: string; kind: FindingKind; title: string; detail: string; at: LngLat; t: number }
export interface AuditEntry { t: number; actor: string; action: string; detail: string; hash?: string }
/** Radio coverage along a route (modelled): metres on the direct ground link, metres that need the UAV-1 relay, metres with no link. */
export interface RouteLeg { n: number; instruction: string; road: string; length: number; cum: number; at: LngLat; relay: number; hazards: number }
export interface RouteComms { direct: number; relay: number; nolink: number; relayTime: number }
export interface PlanOption { id: string; label: string; route: Route; eta: number; blocked: number; hazardsNear: number; eligible: boolean; reason: string;
  risk?: number; comms?: RouteComms; score?: number; recommended?: boolean; why?: string }
export interface Plan { version: number; id: string; hash: string; target: string; options: PlanOption[]; chosen: string; replan: boolean; approvedBy?: string;
  authority?: ProposeResult; approval?: Record<string, Check>; rejected?: Record<string, Check> }
export interface UnitState { at: LngLat; hdg: number; speed: number; battery: number; status: string; alt?: number }
export interface Target { node: number; at: LngLat; label: string; buildingId: string; area: number; done: boolean }
export interface Incident { at: LngLat; road: string; planId: string; t: number }
/** Modelled radio link between two nodes of the mission network (command post, UAV-1, UGV-1). */
export interface Link { id: "cp-ugv" | "cp-uav" | "uav-ugv"; a: string; b: string; kind: "ground" | "air"; dist: number; q: number; up: boolean; fault: boolean; note: string }
export interface UgvLink { ok: boolean; via: "direct" | "relay" | null }
/** Pre-launch route check on the Copernicus grades (a prior: the survey confirms it). */
export interface RouteCheck { ok: boolean; route: Route | null; length: number; outside: number; segs: { pts: LngLat[]; inside: boolean }[]; message: string }
export type ScenarioKind = "earthquake" | "flood" | "fire";
/** floodRise: peak water level above the riverbank (m). The water leaves the river at 40% of it and, over FLOOD_RAMP seconds,
 *  rises to the peak while spreading outward over low ground at FLOOD_SPREAD m/s. */
export interface ScenarioSpec { kind: ScenarioKind; floodRise: number; fires: LngLat[]; fireRadius: number; intensity: 1 | 2 | 3 }
export const FLOOD_RAMP = 20 * 60, FLOOD_SPREAD = 0.5, FLOOD_SPREAD0 = 90;
export const INTENSITY_LABEL = ["", "Moderate", "Strong", "Severe"] as const;
export const SCENARIO_LABEL: Record<ScenarioKind, string> = { earthquake: "Earthquake", flood: "Flood", fire: "Fire" };
export interface SurveyPlan { custom: boolean; area: number; length: number; duration: number; battery: number; ok: boolean; reason: string }
export interface SeqItem { label: string; at: LngLat; area: number; status: "closed" | "current" | "queued" | "unreachable"; verified: number | null; direct: number | null; eta: number | null; cumEta: number | null; hazardsNear: number; signal: boolean; reason: string }

const EVENT_START = Date.parse("2023-02-06T07:40:00+03:00"); // replay clock: T+3h23m after the 04:17 main shock
const EVENT_T0 = Date.parse("2023-02-06T04:17:00+03:00");
export const OPERATOR = "OPS-1";
const SITE_TIME = 240;                  // s of thermal/acoustic sweep per target
const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
const COV_CELL = 5, OBS_ALT = 40;          // same coverage model as the mission authority (sim/live/authority_core.py)
// Link model (modelled, not measured): mesh radio at the command post and on UGV-1; UAV-1 carries an airborne relay.
// Ground range in collapsed urban terrain is short and each collapsed structure near the line costs margin.
export const GROUND_RANGE = 500, AIR_RANGE = 3000, A2G_RANGE = 1500, LINK_MIN = 0.1;
const SWAP_TIME = 120;                      // s field battery swap for the X500 at staging
const USABLE_BATTERY = 0.75;                // survey must finish with the 25% reserve intact
const RISK_RADIUS = 12;                     // m: collapsed structure this close to a road counts as exposure
// route scoring, in seconds-equivalent: drive time + exposure + dependence on the relay
const RISK_COST = 90, RELAY_COST = 0.4, NOLINK_COST = 12;

/** Ray-casting point-in-polygon. */
function inPoly(p: XY, poly: XY[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segDistXY(p: XY, a: XY, b: XY) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function polyArea(poly: XY[]) { let a = 0; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]); return Math.abs(a / 2); }

export class Mission {
  readonly frame: Frame;
  readonly graph;
  readonly sector: { min: XY; max: XY };
  staging: { node: number; at: LngLat; label: string };
  targets: Target[];
  surveyPath!: Path;
  surveyLngLat!: LngLat[];
  /** Operator-drawn survey area (null = the default sector AOI-M1). */
  surveyArea: LngLat[] | null = null;
  scenarioEdited = false;
  private survey: { id: string; p: XY; g: number }[] = [];
  private roadHazards: { id: string; p: XY; g: number; name: string; ll: LngLat }[] = [];
  private crisisPts: { id: string; p: XY; t: string; ll: LngLat }[] = [];
  private collapseXY: XY[];
  /** New mission mode: nothing is pre-placed and everything stays inside the operator's area. */
  readonly custom: boolean;
  startSet = false;
  destSet = false;
  spec: ScenarioSpec = { kind: "earthquake", floodRise: 1.5, fires: [], fireRadius: 70, intensity: 2 };
  /** Terrain for the flood model (loaded asynchronously from elevation tiles). */
  flood: FloodTerrain | null = null;
  private floodKeyLast = "";
  private lastLoggedLevel = -1;
  /** Real damage data exists (curated case); otherwise an earthquake is simulated. */
  readonly realDamage: boolean;
  private debris: { p: XY; r: number }[] = [];
  private waterPolys: XY[][] = [];
  private waterLines: XY[][] = [];
  private bEff = new Map<string, number>();
  private effCache = new Map<string, number>();
  private areaEdgeCache = new Map<string, boolean>();
  private readonly allB: { id: string; p: XY; g: number; a: number; n: string; m: number }[];
  private readonly allRoadHaz: { id: string; p: XY; g: number; name: string; ll: LngLat }[];
  private readonly allCrisis: { id: string; p: XY; t: string; ll: LngLat }[];
  private sectorPoly: XY[];
  private seen = new Set<string>();

  phase: Phase = "standby";
  t = 0;                                  // simulated seconds since replay start
  speed = 30;                             // replay multiplier
  paused = false;
  findings: Finding[] = [];
  audit: AuditEntry[] = [];
  verified = new Set<string>();           // building ids verified by the survey
  track: LngLat[] = [];                   // UAV survey track
  roverTrail: LngLat[] = [];
  plan: Plan | null = null;
  plans: Plan[] = [];
  approvedHash: string | null = null;
  approvedBy: string | null = null;
  operatorName = OPERATOR;                // signed-in team member (Nexconn identity)
  incident: Incident | null = null;
  incidents: Incident[] = [];
  ti = 0;                                 // current target index
  driven = 0;                             // metres driven by UGV-1
  drone: UnitState;
  rover: UnitState;
  private roverNode: number;
  private closed = new Set<string>();     // road segments closed by in-mission reports
  private surveyS = 0;
  private droneBattery = 1;
  private exec: { path: Path; s: number; route: Route; incidentAt?: { k: number; s: number } } | null = null;
  private siteT = 0;
  private orbitA = 0;
  private rtl = false;
  private listeners = new Set<() => void>();
  live: LiveLink | null = null;           // Gazebo + ROS 2 via the mission authority; null = in-browser replay
  noRoute = false;
  noRouteReason = "";
  private rcCache: { key: string; v: RouteCheck } | null = null;
  private liveT0 = -1;
  private unsubLive?: () => void;
  private cov = new Set<string>();
  private covLast: XY | null = null;
  private obsCache = new Map<string, boolean>();
  linkFault = { ground: false, relay: false };   // operator-injected faults (replay test)
  private lastVia: UgvLink["via"] | "init" = "init";
  private swapT = 0;
  private seqCache: { key: string; items: SeqItem[] } | null = null;

  constructor(readonly data: CaseData, opts: { custom?: boolean } = {}) {
    this.custom = !!opts.custom;
    this.realDamage = data.meta.origin !== "osm";
    this.frame = new Frame(data.meta.center);
    this.graph = buildGraph(data.roads, this.frame);
    const mb = data.meta.missionBounds;
    this.sector = { min: this.frame.toXY([mb[0], mb[1]]), max: this.frame.toXY([mb[2], mb[3]]) };
    const inSector = (p: XY, pad = 0) => p[0] >= this.sector.min[0] - pad && p[0] <= this.sector.max[0] + pad && p[1] >= this.sector.min[1] - pad && p[1] <= this.sector.max[1] + pad;
    const cen = (g: GeoJSON.Geometry): XY => {
      const a = (g as GeoJSON.Polygon | GeoJSON.LineString | GeoJSON.Point).coordinates.flat(3) as number[];
      let x = 0, y = 0, n = 0; for (let i = 0; i < a.length; i += 2) { x += a[i]; y += a[i + 1]; n++; }
      return this.frame.toXY([x / n, y / n]);
    };

    this.allB = data.buildings.features.map((f) => ({ id: f.properties.id, p: cen(f.geometry), g: f.properties.g, a: f.properties.a, n: f.properties.n, m: f.properties.m }));
    this.collapseXY = this.allB.filter((b) => b.g === 3).map((b) => b.p);
    this.allRoadHaz = data.roads.features.map((f, i) => ({ f, i, p: cen(f.geometry) })).filter(({ f }) => f.properties.g >= 2)
      .map(({ f, i, p }) => ({ id: `r${i}`, p, g: f.properties.g, name: roadName(f.properties.n), ll: this.frame.toLngLat(p) }));
    this.allCrisis = data.crisis.features.map((f, i) => ({ id: `c${i}`, p: cen(f.geometry), t: f.properties.t })).map((c) => ({ ...c, ll: this.frame.toLngLat(c.p) }));
    for (const f of data.water?.features ?? []) {
      const g = f.geometry;
      if (g.type === "Polygon") this.waterPolys.push((g.coordinates[0] as [number, number][]).map((c) => this.frame.toXY(c)));
      else if (g.type === "MultiPolygon") g.coordinates.forEach((p) => this.waterPolys.push((p[0] as [number, number][]).map((c) => this.frame.toXY(c))));
      else if (g.type === "LineString") this.waterLines.push((g.coordinates as [number, number][]).map((c) => this.frame.toXY(c)));
      else if (g.type === "MultiLineString") g.coordinates.forEach((l) => this.waterLines.push((l as [number, number][]).map((c) => this.frame.toXY(c))));
    }
    this.allB.forEach((b) => this.bEff.set(b.id, b.g));
    const { min, max } = this.sector;
    this.sectorPoly = [[min[0], min[1]], [max[0], min[1]], [max[0], max[1]], [min[0], max[1]]];
    this.survey = this.allB.filter((b) => b.m === 1).map(({ id, p, g }) => ({ id, p, g }));
    this.roadHazards = this.allRoadHaz.filter((h) => inSector(h.p, 20));
    this.crisisPts = this.allCrisis.filter((c) => inSector(c.p, 20));

    // staging: the Copernicus-mapped spontaneous site closest to the sector edge
    const centre: XY = [(this.sector.min[0] + this.sector.max[0]) / 2, (this.sector.min[1] + this.sector.max[1]) / 2];
    const camps = data.crisis.features.filter((f) => f.properties.t === "Camp").map((f) => cen(f.geometry))
      .filter((p) => dist(p, centre) < 900).sort((a, b) => edgeDist(a) - edgeDist(b));
    function edgeDist(p: XY) { return Math.abs(Math.max(Math.abs(p[0] - centre[0]), Math.abs(p[1] - centre[1])) - 350); }
    const sNode = nearestNode(this.graph, camps[0] ?? [this.sector.min[0], this.sector.min[1]]);
    this.staging = { node: sNode, at: this.frame.toLngLat(this.graph.nodes[sNode]), label: camps[0] ? "Forward staging · spontaneous site (Copernicus)" : "Forward staging" };

    // targets: destroyed structures reachable on verified roads; C-1 is the one where the direct route is unsafe
    const candidates = data.buildings.features.filter((f) => f.properties.m === 1 && f.properties.g === 3).sort((a, b) => b.properties.a - a.properties.a);
    const scored: { f: (typeof candidates)[number]; node: number; score: number }[] = [];
    for (const f of candidates.slice(0, 40)) {
      const p = cen(f.geometry), node = nearestNode(this.graph, p);
      if (node === sNode || dist(this.graph.nodes[node], p) > 60) continue;
      const direct = shortestPath(this.graph, sNode, node), safe = shortestPath(this.graph, sNode, node, (e) => e.grade >= 2);
      if (!direct || !safe) continue;
      scored.push({ f, node, score: (direct.blocked.length > 0 ? 1000 : 0) + Math.min(400, safe.length - direct.length) + f.properties.a / 50 });
    }
    scored.sort((a, b) => b.score - a.score);
    const picked: typeof scored = [];
    for (const s of scored) if (picked.every((q) => dist(this.graph.nodes[q.node], this.graph.nodes[s.node]) > 90)) { picked.push(s); if (picked.length === 3) break; }
    if (!picked.length) picked.push({ f: candidates[0], node: nearestNode(this.graph, centre), score: 0 });
    this.targets = picked.map((s, i) => ({ node: s.node, at: this.frame.toLngLat(this.graph.nodes[s.node]), label: `C-${i + 1}`, buildingId: s.f?.properties.id ?? "", area: s.f?.properties.a ?? 0, done: false }));
    this.roverNode = sNode;

    this.buildSurveyPath();

    this.drone = { at: this.staging.at, hdg: 0, speed: 0, battery: 1, status: "On pad", alt: 0 };
    this.rover = { at: this.staging.at, hdg: 0, speed: 0, battery: 1, status: "Ready at staging" };
    if (this.custom) {
      this.recomputeScenario();
      this.targets = []; this.survey = []; this.roadHazards = []; this.crisisPts = [];
      this.drone.status = "Not deployed"; this.rover.status = "Not deployed";
      this.log("system", "New mission", `${this.realDamage ? "Antakya, Hatay" : data.meta.title} · mark the area, place UGV-1 and its destination · everything stays inside your area`);
      return;
    }
    this.startSet = this.destSet = true;
    this.log("system", "Mission created", `Sector AOI-M1 700 m × 700 m · ${this.survey.length} structures pending verification · ${this.targets.length} candidate collapse sites`);
  }

  // ---------- scenario (editable on the operations map before launch)
  private get areaXY(): XY[] { return this.surveyArea ? this.surveyArea.map((c) => this.frame.toXY(c)) : this.sectorPoly; }
  /** Lawnmower over the survey polygon: east-west legs at 85% of the camera swath, clipped to the polygon. */
  private buildSurveyPath() {
    const poly = this.areaXY, spacing = X500_SWATH * 0.85, inset = X500_SWATH * 0.4;
    const ys = poly.map((p) => p[1]), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const legs: XY[] = []; let row = 0;
    const rows = Math.max(1, Math.ceil((y1 - y0 - 2 * inset) / spacing) + 1), step = rows > 1 ? (y1 - y0 - 2 * inset) / (rows - 1) : 0;
    for (let k = 0; k < rows; k++) {
      const y = rows > 1 ? y0 + inset + k * step : (y0 + y1) / 2;
      const xs: number[] = [];
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y)) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
      }
      if (xs.length < 2) continue;
      const a0 = Math.min(...xs) + inset * 0.6, a1 = Math.max(...xs) - inset * 0.6;
      const a: XY = [Math.min(a0, (a0 + a1) / 2), y], b: XY = [Math.max(a1, (a0 + a1) / 2), y];
      legs.push(...(row % 2 ? [b, a] : [a, b])); row++;
    }
    const home = this.graph.nodes[this.staging.node];
    this.surveyPath = new Path([home, ...legs, home]);
    this.surveyLngLat = this.surveyPath.pts.map((p) => this.frame.toLngLat(p));
    this.seqCache = null;
  }
  /** Structures, road hazards and crisis points the survey can verify: inside the area or within half a swath of it. */
  private rebuildObservables() {
    const poly = this.areaXY, r0 = X500_SWATH / 2;
    const near = this.custom ? (p: XY) => this.inArea(p) : (p: XY) => inPoly(p, poly) || poly.some((a, i) => segDistXY(p, a, poly[(i + 1) % poly.length]) <= r0);
    this.survey = this.allB.filter((b) => near(b.p)).map(({ id, p }) => ({ id, p, g: this.bEff.get(id) ?? 0 }));
    const eq = this.spec.kind === "earthquake";
    const haz = eq && this.realDamage ? this.allRoadHaz : this.data.roads.features.map((f, i) => {
      const L = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.type === "MultiLineString" ? f.geometry.coordinates : [];
      const pts = (L.flat() as [number, number][]).map((c) => this.frame.toXY(c));
      const hit = eq ? pts.find((q, j) => j > 0 && this.debris.some((d) => segDistXY(d.p, pts[j - 1], q) <= d.r)) : pts.find((q) => this.zoneHit(q));
      return hit ? { id: `r${i}`, p: hit, g: 3, name: roadName(f.properties.n), ll: this.frame.toLngLat(hit) } : null;
    }).filter((x): x is NonNullable<typeof x> => !!x);
    this.roadHazards = haz.filter((h) => near(h.p));
    this.crisisPts = eq ? this.allCrisis.filter((c) => near(c.p)) : [];
  }
  get surveyPlan(): SurveyPlan {
    const length = this.surveyPath.length, duration = length / X500_CRUISE, battery = duration / X500_ENDURANCE_S;
    const area = polyArea(this.areaXY), ok = battery <= USABLE_BATTERY && this.surveyPath.pts.length > 2;
    const reason = this.surveyPath.pts.length <= 2 ? "Survey area is too small for one pass" :
      battery > USABLE_BATTERY ? `Needs ${Math.round(duration / 60)} min of flight; one X500 battery gives ${Math.round((X500_ENDURANCE_S * USABLE_BATTERY) / 60)} min with the 25% reserve. Shrink the area.` : "";
    return { custom: !!this.surveyArea, area, length, duration, battery, ok, reason };
  }
  get editable() { return this.phase === "standby"; }
  get ready() { return { area: !this.custom || !!this.surveyArea, start: this.startSet, dest: this.destSet }; }
  /** Inside the operator's area (custom mode), with a small margin for the camera footprint. */
  inArea(p: XY, margin = 10) {
    const poly = this.areaXY;
    return inPoly(p, poly) || poly.some((a, i) => segDistXY(p, a, poly[(i + 1) % poly.length]) <= margin);
  }
  private edgeInArea(u: number, e: Edge) {
    if (!this.custom) return true;
    const k = key(u, e.to), c = this.areaEdgeCache.get(k); if (c !== undefined) return c;
    const v = this.inArea(this.graph.nodes[u]) && this.inArea(this.graph.nodes[e.to]);
    this.areaEdgeCache.set(k, v); return v;
  }
  /** Is this point inside the scenario's hazard (flood band along the Asi, or a fire)? */
  /** Current water level above the river (m): half the peak at the start, the peak after FLOOD_RAMP (quantised to 0.25 m). */
  get floodLevel() { const r = this.spec.floodRise * (0.4 + 0.6 * Math.min(1, this.t / FLOOD_RAMP)); return Math.round(r * 4) / 4; }
  /** How far (m, along the ground) the water has spread from the river, in 30 m steps. */
  get floodSpread() { return Math.round((FLOOD_SPREAD0 + FLOOD_SPREAD * this.t) / 30) * 30; }
  private get floodReachArr() { return this.flood ? floodReach(this.flood, this.spec.floodRise) : undefined; }
  floodReachFor() { return this.floodReachArr; }
  /** Changes whenever the flood picture changes (level or spread step). */
  get floodKey() { return this.spec.kind === "flood" && this.flood ? `${this.floodLevel}|${this.floodSpread}` : ""; }
  /** Water depth (m) at a point in the current flood (0 when not a flood or terrain not loaded). */
  waterDepth(p: XY) { return this.spec.kind === "flood" && this.flood ? depthAtXY(this.flood, this.frame, p, this.floodLevel, this.floodReachArr, this.floodSpread) : 0; }
  setFloodTerrain(t: FloodTerrain | null) { this.flood = t; this.floodKeyLast = ""; if (this.spec.kind === "flood") { this.recomputeScenario(); this.emit(); } }
  private zoneHit(p: XY) {
    const sp = this.spec;
    if (sp.kind === "flood") return this.waterDepth(p) > HUSKY_WADE;
    if (sp.kind === "fire") return sp.fires.some((f) => dist(this.frame.toXY(f), p) <= sp.fireRadius);
    return false;
  }
  /** Effective grade of a road segment in this scenario (earthquake = Copernicus; flood/fire = intact unless inside the hazard). */
  effGrade(u: number, e: Edge) {
    if (this.spec.kind === "earthquake" && this.realDamage) return e.grade;
    const k = key(u, e.to), c = this.effCache.get(k); if (c !== undefined) return c;
    const a = this.graph.nodes[u], b = this.graph.nodes[e.to];
    let v = 0;
    if (this.spec.kind === "earthquake") { for (const d of this.debris) if (segDistXY(d.p, a, b) <= d.r) { v = 3; break; } }   // debris from collapsed buildings
    else v = this.zoneHit(a) || this.zoneHit(b) || this.zoneHit([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]) ? 3 : 0;
    this.effCache.set(k, v); return v;
  }
  /** Simulated earthquake grade of a building (deterministic per building; taller buildings fail more often). */
  private simGrade(b: { id: string; a: number }) {
    let h = 0; for (let i = 0; i < b.id.length; i++) h = (h * 31 + b.id.charCodeAt(i)) >>> 0;
    const u = ((h * 2654435761) >>> 0) / 4294967296, i = this.spec.intensity, tall = Math.min(1.8, 0.7 + b.a / 900);
    const pD = [0, 0.03, 0.08, 0.16][i] * tall, pG = pD + [0, 0.06, 0.12, 0.18][i], pP = pG + [0, 0.08, 0.1, 0.1][i];
    return u < pD ? 3 : u < pG ? 2 : u < pP ? 1 : 0;
  }
  buildingGrade(id: string) { return this.bEff.get(id) ?? 0; }
  get scenarioName() { return this.spec.kind === "earthquake" ? (this.realDamage ? "Earthquake · real Copernicus damage" : `Earthquake · ${INTENSITY_LABEL[this.spec.intensity].toLowerCase()} (simulated)`) : this.spec.kind === "flood" ? `Flood · up to ${this.spec.floodRise} m above the riverbank, terrain-modelled (simulated)` : `Fire · ${this.spec.fires.length} fire${this.spec.fires.length === 1 ? "" : "s"}, ${this.spec.fireRadius} m (simulated)`; }
  private recomputeScenario() {
    const eq = this.spec.kind === "earthquake";
    const fl = this.spec.kind === "flood";
    this.allB.forEach((b) => { const dp = fl ? this.waterDepth(b.p) : 0; this.bEff.set(b.id, eq ? (this.realDamage ? b.g : this.simGrade(b)) : fl ? (dp > 1.2 ? 3 : dp > 0.3 ? 2 : dp > 0.05 ? 1 : 0) : this.zoneHit(b.p) ? 3 : 0); });
    this.collapseXY = fl ? [] : this.allB.filter((b) => this.bEff.get(b.id) === 3).map((b) => b.p);   // flood: no collapse exposure
    this.debris = eq && !this.realDamage ? this.allB.filter((b) => this.bEff.get(b.id) === 3).map((b) => ({ p: b.p, r: Math.sqrt(b.a) / 2 + 5 })) : [];
    this.effCache.clear(); this.rcCache = null; this.seqCache = null;
    if (this.surveyArea || !this.custom) this.rebuildObservables();
  }
  /** Scenario kind and parameters (custom mode, before launch). */
  setScenario(patch: Partial<ScenarioSpec>) {
    if (!this.editable || !this.custom) return;
    this.spec = { ...this.spec, ...patch, fires: patch.fires ?? this.spec.fires }; this.floodKeyLast = "";
    this.recomputeScenario();
    this.log(this.operatorName, "Scenario set", this.scenarioName);
    this.emit();
  }
  addFire(at: LngLat): string | null {
    if (!this.editable || !this.custom) return null;
    if (!this.surveyArea) return "Mark your area first.";
    if (!this.inArea(this.frame.toXY(at), 0)) return "Place the fire inside your area.";
    this.setScenario({ fires: [...this.spec.fires, at] });
    return null;
  }
  placeName(node: number) {
    const e = this.graph.adj[node]?.[0];
    return e ? roadName(this.graph.names[e.road]) : "off the road network";
  }
  /** Survey area drawn on the map (null restores the default sector). */
  setSurveyArea(poly: LngLat[] | null) {
    if (!this.editable) return;
    this.surveyArea = poly && poly.length >= 3 ? poly : null;
    this.scenarioEdited = true; this.areaEdgeCache.clear(); this.rcCache = null;
    if (this.custom) {   // anything now outside the area is cleared
      if (this.startSet && (!this.surveyArea || !this.inArea(this.graph.nodes[this.staging.node]))) { this.startSet = false; this.rover.status = this.drone.status = "Not deployed"; }
      if (this.destSet && (!this.surveyArea || !this.inArea(this.graph.nodes[this.targets[0].node]))) { this.destSet = false; this.targets = []; }
      if (this.spec.kind === "fire" && this.surveyArea) this.spec = { ...this.spec, fires: this.spec.fires.filter((f) => this.inArea(this.frame.toXY(f), 0)) };
      this.recomputeScenario();
    }
    this.buildSurveyPath(); this.rebuildObservables();
    const sp = this.surveyPlan;
    this.log(this.operatorName, "Survey area set", this.surveyArea ? `Custom area ${(sp.area / 1e6).toFixed(2)} km² · ${(sp.length / 1000).toFixed(2)} km pattern · ${Math.round(sp.duration / 60)} min flight · ${Math.round(sp.battery * 100)}% battery${sp.ok ? "" : " · exceeds one battery"}` : "Default sector AOI-M1");
    this.emit();
  }
  /** Rover (and drone pad) deployment point. */
  setStart(at: LngLat): string | null {
    if (!this.editable) return null;
    if (this.custom && !this.surveyArea) return "Mark your area first.";
    const inside = (i: number) => !this.custom || this.inArea(this.graph.nodes[i], 0);
    if (this.custom && !this.inArea(this.frame.toXY(at), 0)) return "Place the rover inside your area.";
    const node = nearestNode(this.graph, this.frame.toXY(at), inside);
    if (node < 0) return "No road inside your area near that point.";
    this.startSet = true; this.rover.status = "Ready at start"; this.drone.status = "On pad";
    const ll = this.frame.toLngLat(this.graph.nodes[node]);
    this.staging = { node, at: ll, label: `Staging · ${this.placeName(node)}` };
    this.roverNode = node; this.scenarioEdited = true;
    this.drone = { ...this.drone, at: ll }; this.rover = { ...this.rover, at: ll };
    this.buildSurveyPath();
    if (this.live) void this.live.reset(ll);
    this.log(this.operatorName, "Rover start set", `UGV-1 and the UAV-1 pad at ${this.placeName(node)}`);
    this.emit();
    return null;
  }
  /** Where UGV-1 must go: replaces the target list with this destination. */
  setDestination(at: LngLat): string | null {
    if (!this.editable) return null;
    if (this.custom && !this.surveyArea) return "Mark your area first.";
    const xy = this.frame.toXY(at);
    if (this.custom && !this.inArea(xy, 0)) return "Place the destination inside your area.";
    const node = nearestNode(this.graph, xy, (i) => !this.custom || this.inArea(this.graph.nodes[i], 0));
    if (node < 0) return "No road inside your area near that point.";
    this.destSet = true;
    let b: (typeof this.allB)[number] | null = null, bd = 45;
    for (const q of this.allB) { const d = dist(q.p, xy); if (d < bd) { bd = d; b = q; } }
    this.targets = [{ node, at: this.frame.toLngLat(this.graph.nodes[node]), label: "T-1", buildingId: b?.id ?? "", area: b?.a ?? 0, done: false }];
    this.ti = 0; this.scenarioEdited = true; this.seqCache = null;
    const bg = b ? this.bEff.get(b.id) ?? b.g : -1;
    const grade = this.spec.kind === "earthquake" ? (["no visible damage", "possibly damaged", "damaged", "destroyed"][Math.max(0, bg)] ?? "not graded") + " (Copernicus)" : bg === 3 ? (this.spec.kind === "flood" ? "flooded (simulated)" : "on fire (simulated)") : "intact";
    this.log(this.operatorName, "Destination set", `T-1 at ${this.placeName(node)}${b ? ` · building ${grade}` : ""}`);
    this.emit();
    return null;
  }

  /** Is there a passable road between start and destination, and how much of it lies outside the survey area? */
  get routeCheck(): RouteCheck {
    const tg = this.target, k = `${this.staging.node}|${tg?.node}|${JSON.stringify(this.surveyArea)}|${this.closed.size}`;
    if (this.rcCache?.key === k) return this.rcCache.v;
    let v: RouteCheck;
    const route = tg && this.startSet ? shortestPath(this.graph, this.staging.node, tg.node, (e, u) => this.effGrade(u, e) >= 2 || this.closed.has(key(u, e.to)) || !this.edgeInArea(u, e)) : null;
    const cause = this.spec.kind === "earthquake" ? (this.realDamage ? "a road Copernicus graded damaged or destroyed" : "earthquake debris") : this.spec.kind === "flood" ? "flood water" : "fire";
    if (!tg || !this.startSet) v = { ok: false, route: null, length: 0, outside: 0, segs: [], message: "Place the rover and its destination." };
    else if (!route) v = { ok: false, route: null, length: 0, outside: 0, segs: [], message: `No passable road connects the start and the destination${this.custom ? " inside your area" : ""}: every connection crosses ${cause}. Move a point${this.custom ? " or enlarge the area" : ""}.` };
    else {
      const poly = this.areaXY, segs: RouteCheck["segs"] = []; let outside = 0;
      route.edges.forEach((e, i) => {
        const a = route.pts[i], b = route.pts[i + 1], mid: XY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        // the camera footprint reaches about 10 m past the area edge
        const inside = inPoly(mid, poly) || poly.some((q, j) => segDistXY(mid, q, poly[(j + 1) % poly.length]) <= 10);
        if (!inside) outside += e.len;
        const last = segs[segs.length - 1], la = this.frame.toLngLat(a), lb = this.frame.toLngLat(b);
        if (last && last.inside === inside) last.pts.push(lb); else segs.push({ pts: [la, lb], inside });
      });
      v = { ok: outside < 1, route, length: route.length, outside, segs,
        message: outside < 1 ? `A passable road of about ${Math.round(route.length)} m exists inside the survey area. The survey must confirm it.`
          : `About ${Math.round(outside)} m of the likely route lies outside the survey area (amber). Extend the area, or the rover will have no verified way through.` };
    }
    this.rcCache = { key: k, v };
    return v;
  }

  // ---------- route ranking (verified roads only) with the radio check
  private linkQ(p: XY) {
    const cp = this.graph.nodes[this.staging.node];
    return 1 - dist(cp, p) / GROUND_RANGE - this.rubbleBetween(cp, p) * 0.03;
  }
  private edgeOut(u: number, e: Edge) {
    const a = this.graph.nodes[u], b = this.graph.nodes[e.to];
    let out = 0; const n = Math.max(1, Math.ceil(e.len / 25));
    for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; if (this.linkQ([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]) <= LINK_MIN) out += e.len / n; }
    return out;
  }
  private edgeRisk(u: number, e: Edge) {
    const a = this.graph.nodes[u], b = this.graph.nodes[e.to];
    let n = 0; for (const c of this.collapseXY) if (segDistXY(c, a, b) <= RISK_RADIUS) n++;
    return n;
  }
  routeComms(route: Route): RouteComms {
    const cp = this.graph.nodes[this.staging.node];
    let direct = 0, relay = 0, nolink = 0;
    route.edges.forEach((e, i) => {
      const a = route.pts[i], b = route.pts[i + 1], n = Math.max(1, Math.ceil(e.len / 10));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n, p: XY = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        if (this.linkQ(p) > LINK_MIN) direct += e.len / n; else if (dist(cp, p) < AIR_RANGE) relay += e.len / n; else nolink += e.len / n;
      }
    });
    return { direct, relay, nolink, relayTime: relay / HUSKY_PLAN_SPEED };
  }
  /** True where UGV-1 would be out of direct ground range but the UAV-1 relay can reach (modelled). */
  relayAt(p: XY) { return this.linkQ(p) <= LINK_MIN && dist(this.graph.nodes[this.staging.node], p) < AIR_RANGE; }
  private routeRisk(route: Route) { return hazardsAlong(route, this.collapseXY, RISK_RADIUS); }

  /** Turn-by-turn legs for the route card: consecutive segments on the same street merge; turns from the bearing change. */
  routeLegs(route: Route): RouteLeg[] {
    const bearing = (a: XY, b: XY) => (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;     // compass, 0 = north
    const name = (i: number) => roadName(this.graph.names[route.edges[i].road]);
    const groups: { from: number; to: number; road: string }[] = [];
    for (let i = 0; i < route.edges.length; i++) {
      const g = groups[groups.length - 1], rd = name(i);
      const prevB = i ? bearing(route.pts[i - 1], route.pts[i]) : 0, b = bearing(route.pts[i], route.pts[i + 1]);
      const sharp = i > 0 && Math.abs(((b - prevB + 540) % 360) - 180) > 45;
      if (g && g.road === rd && !sharp) g.to = i; else groups.push({ from: i, to: i, road: rd });
    }
    const compass = (b: number) => ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round((((b % 360) + 360) % 360) / 45) % 8];
    const cp = this.graph.nodes[this.staging.node];
    let cum = 0;
    const legs: RouteLeg[] = groups.map((g, k) => {
      let len = 0, relay = 0;
      for (let i = g.from; i <= g.to; i++) {
        const e = route.edges[i], a = route.pts[i], b = route.pts[i + 1], n = Math.max(1, Math.ceil(e.len / 10));
        len += e.len;
        for (let j = 0; j < n; j++) { const t = (j + 0.5) / n, p: XY = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; if (this.linkQ(p) <= LINK_MIN && dist(cp, p) < AIR_RANGE) relay += e.len / n; }
      }
      const sub: Route = { nodes: route.nodes.slice(g.from, g.to + 2), pts: route.pts.slice(g.from, g.to + 2), edges: route.edges.slice(g.from, g.to + 1), length: len, blocked: [], hazardsNear: 0 };
      const hazards = hazardsAlong(sub, this.collapseXY, RISK_RADIUS);
      const b0 = bearing(route.pts[g.from], route.pts[g.from + 1]);
      let instruction: string;
      if (k === 0) instruction = `Start at staging on ${g.road}, head ${compass(b0)}`;
      else {
        const pg = groups[k - 1], pb = bearing(route.pts[pg.to], route.pts[pg.to + 1]);
        const d = ((b0 - pb + 540) % 360) - 180;                      // + = right, - = left
        const side = d > 0 ? "right" : "left", ad = Math.abs(d);
        instruction = ad < 20 ? `Continue onto ${g.road}` : ad < 60 ? `Bear ${side} onto ${g.road}` : ad < 150 ? `Turn ${side} onto ${g.road}` : `Make a U-turn onto ${g.road}`;
      }
      const leg: RouteLeg = { n: k + 1, instruction, road: g.road, length: len, cum: cum + len, at: this.frame.toLngLat(route.pts[g.from]), relay, hazards };
      cum += len;
      return leg;
    });
    legs.push({ n: legs.length + 1, instruction: `Arrive at ${this.target?.label ?? "the destination"}`, road: "", length: 0, cum, at: this.frame.toLngLat(route.pts[route.pts.length - 1]), relay: 0, hazards: 0 });
    return legs;
  }
  private scoreRoute(route: Route) {
    const c = this.routeComms(route), risk = this.routeRisk(route);
    return { comms: c, risk, score: route.length / HUSKY_PLAN_SPEED + risk * RISK_COST + c.relay * RELAY_COST + c.nolink * NOLINK_COST };
  }
  /** Up to three distinct verified routes (fastest, lowest exposure, best radio coverage), ranked by the composite score. */
  private rankRoutes(from: number, to: number, skip?: (e: Edge, u: number) => boolean): PlanOption[] {
    const blocked = (e: Edge, u: number) => this.isBlocked(e, u) || !!skip?.(e, u);
    const cand: { kind: string; route: Route | null }[] = [
      { kind: "Fastest verified", route: shortestPath(this.graph, from, to, blocked) },
      { kind: "Lowest collapse exposure", route: shortestPath(this.graph, from, to, blocked, (e, u) => e.len + this.edgeRisk(u, e) * 120) },
      { kind: "Best radio coverage", route: shortestPath(this.graph, from, to, blocked, (e, u) => e.len + this.edgeOut(u, e) * 3) },
    ];
    // alternative corridor: avoid the streets of the fastest route (kept only if it is at most 1.6x longer)
    const first = cand[0].route;
    if (first) {
      const used = new Set(first.nodes.slice(1, -1));
      const alt = shortestPath(this.graph, from, to, blocked, (e) => e.len * (used.has(e.to) ? 6 : 1));
      if (alt && alt.length <= first.length * 1.6) cand.push({ kind: "Alternative corridor", route: alt });
    }
    const seen = new Map<string, PlanOption>();
    for (const c of cand) {
      if (!c.route) continue;
      const k = c.route.nodes.join(",");
      const prev = seen.get(k);
      if (prev) { prev.why = `${prev.why} · ${c.kind.toLowerCase()}`; continue; }
      const sc = this.scoreRoute(c.route);
      seen.set(k, { ...this.option("", c.kind, c.route), ...sc, why: c.kind });
    }
    const opts = [...seen.values()].sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
    opts.forEach((o, i) => {
      o.id = `route-${String.fromCharCode(65 + i)}`;
      o.label = `Route ${String.fromCharCode(65 + i)} · ${o.why}`;
      o.recommended = i === 0;
      const c = o.comms!;
      o.reason = `${Math.round(o.route.length)} m · ${o.risk} collapsed structure${o.risk === 1 ? "" : "s"} within ${RISK_RADIUS} m · ${c.relay > 1 ? `${Math.round(c.relay)} m needs the UAV-1 relay` : "direct ground link all the way"}${c.nolink > 1 ? ` · ${Math.round(c.nolink)} m with no link` : ""}`;
    });
    return opts;
  }

  // ---------- state
  get target() { return this.targets[this.ti]; }
  get remainingTargets() { return this.targets.filter((t) => !t.done).length; }
  get replanning() { return !!this.plan?.replan && (this.phase === "awaiting_approval" || this.phase === "incident"); }
  get clock() { return new Date(EVENT_START + this.t * 1000); }
  get sinceEvent() { return (EVENT_START + this.t * 1000 - EVENT_T0) / 1000; }
  get surveyProgress() { return this.surveyS / this.surveyPath.length; }
  get surveyDuration() { return this.surveyPath.length / X500_CRUISE; }
  get counts() {
    const v = this.survey.filter((b) => this.verified.has(b.id));
    return { total: this.survey.length, verified: v.length, destroyed: v.filter((b) => b.g === 3).length, damaged: v.filter((b) => b.g === 2).length,
      roads: this.findings.filter((f) => f.kind === "road").length };
  }
  get execProgress() { return this.exec ? this.exec.s / this.exec.path.length : this.phase === "on_site" || this.phase === "complete" ? 1 : 0; }
  get siteProgress() { return Math.min(1, this.siteT / SITE_TIME); }
  get debrief() {
    return { elapsed: this.t, driven: this.driven, verified: this.counts.verified, total: this.counts.total, plans: this.plans.length,
      approvals: this.plans.filter((p) => p.approvedBy).length, incidents: this.incidents.length, done: this.targets.filter((t) => t.done).length, targets: this.targets.length,
      signals: this.findings.filter((f) => f.kind === "signal").length };
  }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { this.listeners.forEach((f) => f()); }
  private log(actor: string, action: string, detail: string, hash?: string) { this.audit.push({ t: this.t, actor, action, detail, hash }); }
  private find(f: Omit<Finding, "t">) { this.findings.unshift({ ...f, t: this.t }); }
  /** Unknown is impassable: a segment is usable only if graded passable, not closed, and seen by UAV-1's camera. */
  private isBlocked = (e: Edge, from: number) => this.effGrade(from, e) >= 2 || this.closed.has(key(from, e.to)) || !this.edgeObserved(from, e.to) || !this.edgeInArea(from, e);
  private covAdd(p: XY, alt: number) {
    if (alt < OBS_ALT || (this.covLast && dist(this.covLast, p) < COV_CELL)) return;
    this.covLast = p; this.obsCache.clear();
    const n = Math.floor((X500_SWATH / 2) / COV_CELL) + 1, r2 = ((X500_SWATH / 2) / COV_CELL) ** 2, cx = Math.round(p[0] / COV_CELL), cy = Math.round(p[1] / COV_CELL);
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) if (i * i + j * j <= r2) this.cov.add(`${cx + i},${cy + j}`);
  }
  private covered = (x: number, y: number) => this.cov.has(`${Math.round(x / COV_CELL)},${Math.round(y / COV_CELL)}`);
  private edgeObserved(u: number, v: number) {
    const k = key(u, v), c = this.obsCache.get(k); if (c !== undefined) return c;
    const a = this.graph.nodes[u], b = this.graph.nodes[v], n = Math.max(1, Math.ceil(dist(a, b) / 5));
    let ok = true; for (let i = 0; i <= n && ok; i++) ok = this.covered(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n);
    this.obsCache.set(k, ok); return ok;
  }
  get coverageCells() { return this.cov.size; }
  isCovered(x: number, y: number) { return this.covered(x, y); }
  isClosed(u: number, v: number) { return this.closed.has(key(u, v)); }
  observedEdge(u: number, v: number) { return this.edgeObserved(u, v); }
  get collapses() { return this.collapseXY; }
  /** Route currently executing or proposed (verified option). */
  get activeRoute(): Route | null { return this.exec?.route ?? this.plan?.options.find((o) => o.id === this.plan!.chosen)?.route ?? null; }

  // ---------- comms (modelled link budget; the fail-safe is enforced by the engine in replay)
  private rubbleBetween(a: XY, b: XY) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1;
    let n = 0;
    for (const p of this.collapseXY) {
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L));
      if (Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) < 12) n++;
    }
    return n;
  }
  get links(): Link[] {
    const cp = this.frame.toXY(this.staging.at), d = this.frame.toXY(this.drone.at), r = this.frame.toXY(this.rover.at);
    const air = (this.drone.alt ?? 0) > 20, c01 = (v: number) => Math.max(0, Math.min(1, v));
    const rubble = this.rubbleBetween(cp, r), dg = dist(cp, r);
    const gq = this.linkFault.ground ? 0 : c01(1 - dg / GROUND_RANGE - rubble * 0.03);
    const dq = air ? c01(1 - dist(cp, d) / AIR_RANGE) : 1;
    const rq = air && !this.linkFault.relay ? c01(1 - Math.hypot(dist(d, r), this.drone.alt ?? 0) / A2G_RANGE) : 0;
    return [
      { id: "cp-ugv", a: "Command post", b: "UGV-1", kind: "ground", dist: dg, q: gq, up: gq > LINK_MIN, fault: this.linkFault.ground,
        note: this.linkFault.ground ? "Jammed (injected test)" : `Mesh radio · ${rubble} collapsed structure${rubble === 1 ? "" : "s"} near the path` },
      { id: "cp-uav", a: "Command post", b: "UAV-1", kind: "air", dist: dist(cp, d), q: dq, up: dq > LINK_MIN, fault: false, note: air ? "Line of sight" : "On pad at the command post" },
      { id: "uav-ugv", a: "UAV-1", b: "UGV-1", kind: "air", dist: dist(d, r), q: rq, up: rq > LINK_MIN, fault: this.linkFault.relay,
        note: this.linkFault.relay ? "Relay dropped (injected test)" : air ? "Airborne relay" : "UAV-1 not airborne" },
    ];
  }
  get ugvLink(): UgvLink {
    const [g, cu, ur] = this.links;
    return g.up ? { ok: true, via: "direct" } : cu.up && ur.up ? { ok: true, via: "relay" } : { ok: false, via: null };
  }
  setLinkFault(k: "ground" | "relay", v: boolean) {
    if (this.linkFault[k] === v) return;
    this.linkFault[k] = v;
    this.log(this.operatorName, v ? "Link test started" : "Link test ended", k === "ground" ? `Direct ground link to UGV-1 ${v ? "jammed" : "restored"} (simulated)` : `UAV-1 relay ${v ? "dropped" : "restored"} (simulated)`);
    this.watchLink(); this.emit();
  }
  /** Logs relay hand-overs and link loss; called every step. */
  private watchLink() {
    if (this.phase === "standby") return;
    const l = this.ugvLink;
    if (l.via === this.lastVia) return;
    const prev = this.lastVia; this.lastVia = l.via;
    if (prev === "init") return;
    const dg = Math.round(this.links[0].dist);
    if (!l.ok) this.log("comms", "Command link lost", `No direct ground link (${dg} m from the command post) and no UAV-1 relay · UGV-1 fail-safe: ${this.phase === "executing" ? "stops and holds" : "holds"} until a link returns`);
    else if (prev === null) this.log("comms", "Command link restored", l.via === "relay" ? "Through the UAV-1 airborne relay" : "Direct ground link");
    else if (l.via === "relay") this.log("comms", "Relay engaged", `UGV-1 out of direct ground range (${dg} m) · traffic relayed through UAV-1`);
    else this.log("comms", "Direct link resumed", `UGV-1 back in ground range (${dg} m) · relay standing by`);
  }

  // ---------- extraction sequence (situation report)
  extractionSequence(): SeqItem[] {
    const k = `${this.roverNode}|${this.cov.size}|${this.closed.size}|${this.ti}|${this.targets.map((t) => +t.done).join("")}|${this.findings.length}`;
    if (this.seqCache?.key === k) return this.seqCache.items;
    const sig = new Set(this.findings.filter((f) => f.kind === "signal").map((f) => f.id.slice(4)));
    const base = (t: Target) => ({ label: t.label, at: t.at, area: t.area, signal: sig.has(t.label) });
    const out: SeqItem[] = this.targets.filter((t) => t.done).map((t) => ({ ...base(t), status: "closed" as const, verified: null, direct: null, eta: null, cumEta: null, hazardsNear: 0,
      reason: sig.has(t.label) ? "Signal of interest handed to USAR team" : "Inspected · no signal" }));
    let from = this.roverNode, cum = 0;
    const pool = this.targets.filter((t) => !t.done);
    const cur = pool.find((t) => t === this.target);
    const rest = pool.filter((t) => t !== cur);
    const tail: SeqItem[] = [];
    const push = (t: Target, status: SeqItem["status"]) => {
      const v = shortestPath(this.graph, from, t.node, this.isBlocked), d = shortestPath(this.graph, from, t.node);
      if (!v) { tail.push({ ...base(t), status: "unreachable", verified: null, direct: d ? d.length : null, eta: null, cumEta: null, hazardsNear: 0,
        reason: this.cov.size ? "No route made only of observed, passable segments" : "Awaiting aerial survey" }); return; }
      const eta = v.length / HUSKY_PLAN_SPEED + SITE_TIME; cum += eta;
      out.push({ ...base(t), status, verified: v.length, direct: d ? d.length : null, eta, cumEta: cum, hazardsNear: hazardsAlong(v, this.collapseXY, 6),
        reason: d && d.blocked.length ? `Direct route crosses ${d.blocked.length} impassable segment${d.blocked.length > 1 ? "s" : ""}` : "Direct route is passable" });
      from = t.node;
    };
    if (cur) push(cur, this.phase === "complete" ? "queued" : "current");
    while (rest.length) {   // greedy: nearest next site by verified route
      let bi = 0, bl = Infinity;
      rest.forEach((t, i) => { const v = shortestPath(this.graph, from, t.node, this.isBlocked); if (v && v.length < bl) { bl = v.length; bi = i; } });
      push(rest.splice(bi, 1)[0], "queued");
    }
    const items = [...out, ...tail];
    this.seqCache = { key: k, items };
    return items;
  }

  // ---------- live link (Gazebo + ROS 2)
  async attachLive(link: LiveLink) {
    this.live = link;
    this.unsubLive = link.on((ev) => this.onLive(ev));
    await link.reset(this.staging.at);
    this.log("authority", "Live link attached", "Gazebo world antakya_live · UAV-1 and UGV-1 moved to staging · world version 1");
    this.emit();
  }
  detachLive() { this.unsubLive?.(); this.live = null; }
  private onLive(ev: LiveEvent) {
    if (ev.type === "log") this.log(ev.actor, ev.action, ev.detail);
    else if (ev.type === "survey_complete" && this.phase === "survey") this.finishSurvey();
    else if (ev.type === "arrived" && this.phase === "executing") this.arrive();
    else if (ev.type === "incident" && this.phase === "executing" && this.exec) {
      const route = this.exec.route, a = nearestNode(this.graph, this.frame.toXY(ev.edge[0])), b = nearestNode(this.graph, this.frame.toXY(ev.edge[1]));
      let k = route.nodes.findIndex((n, i) => n === a && route.nodes[i + 1] === b);
      if (k < 0) k = route.nodes.findIndex((n, i) => (n === b && route.nodes[i + 1] === a));
      if (k >= 0) void this.raiseIncident(route, k, ev.worldVersion);
      else this.log("authority", "Incident not matched", `Closed segment near ${ev.road} is not on the executing route`);
    }
    this.emit();
  }
  private stepLive() {
    const tm = this.live!.telemetry; if (!tm) return;
    if (this.liveT0 < 0) this.liveT0 = tm.simTime;
    const prevT = this.t; this.t = Math.max(this.t, tm.simTime - this.liveT0);
    const dt = Math.max(0, this.t - prevT), cap = (m: string) => m.charAt(0).toUpperCase() + m.slice(1);
    const dp = this.frame.toXY(tm.uav.at), prevD = this.frame.toXY(this.drone.at);
    if (this.phase === "survey") this.surveyS = Math.min(this.surveyPath.length * 0.99, this.surveyS + dist(dp, prevD));
    this.drone = { at: tm.uav.at, hdg: tm.uav.hdg, speed: tm.uav.speed, battery: tm.uav.battery, alt: Math.round(tm.uav.alt ?? 0), status: cap(tm.uav.mode) };
    this.droneBattery = tm.uav.battery;
    if ((tm.uav.alt ?? 0) >= OBS_ALT) {
      this.covAdd(dp, tm.uav.alt ?? 0); this.observe(dp);
      const last = this.track[this.track.length - 1];
      if (this.phase === "survey" && (!last || dist(this.frame.toXY(last), dp) > 6)) this.track.push(this.drone.at);
    }
    const rp = this.frame.toXY(tm.ugv.at), prevR = this.frame.toXY(this.rover.at);
    this.rover = { at: tm.ugv.at, hdg: tm.ugv.hdg, speed: tm.ugv.speed, battery: tm.ugv.battery, status: cap(tm.ugv.mode) };
    if (this.phase === "executing" && this.exec) {
      const moved = dist(rp, prevR); if (moved < 20) this.driven += moved;
      const last = this.roverTrail[this.roverTrail.length - 1];
      if (!last || dist(this.frame.toXY(last), rp) > 4) this.roverTrail.push(this.rover.at);
      this.exec.s = this.alongPath(this.exec.path, rp);
    }
    if (this.phase === "on_site") this.stepSite(dt);
    this.emitThrottled();
  }
  private alongPath(path: Path, p: XY) {
    let best = 0, bd = Infinity;
    for (let i = 1; i < path.pts.length; i++) {
      const a = path.pts[i - 1], b = path.pts[i], dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
      const d = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
      if (d < bd) { bd = d; best = path.cum[i - 1] + t * Math.sqrt(L); }
    }
    return best;
  }

  // ---------- operator commands
  get canLaunch() { const rd = this.ready; return this.surveyPlan.ok && rd.area && rd.start && rd.dest; }
  launchSurvey() {
    if (this.phase !== "standby" || !this.canLaunch) return;
    this.phase = "survey";
    this.drone.status = "Surveying";
    if (this.live) void this.live.survey(this.surveyLngLat.slice(1, -1), X500_ALT);
    this.log(this.operatorName, "Survey authorised", `X500 · ${X500_ALT} m AGL · ${X500_CRUISE} m/s · swath ${X500_SWATH} m · ${(this.surveyPath.length / 1000).toFixed(2)} km pattern, est. ${Math.round(this.surveyDuration / 60)} min`);
    this.emit();
  }

  async generatePlan() {
    if (this.phase !== "review") return;
    const g = this.graph, from = this.roverNode, to = this.target.node;
    const direct = shortestPath(g, from, to, (e, u) => !this.edgeInArea(u, e));
    const ranked = this.rankRoutes(from, to);
    if (!ranked.length) {
      this.noRoute = true;
      const rc = this.routeCheck;
      this.noRouteReason = !rc.route ? `Every road between the start and the destination${this.custom ? " inside your area" : ""} is blocked (${this.spec.kind === "earthquake" ? "graded damaged or destroyed" : this.spec.kind}). Edit the scenario: move a point or enlarge the area.`
        : `A passable road exists (${Math.round(rc.length)} m), but UAV-1 has not observed all of it${rc.outside > 1 ? `: ${Math.round(rc.outside)} m lies outside the survey area` : ""}. Edit the scenario and extend the survey area.`;
      this.log("planner", "No verified route", `${this.target.label}: no route made only of observed, passable segments. Extend the survey area to cover the way from the start to the destination.`);
      this.emit(); return;
    }
    this.noRoute = false; this.noRouteReason = "";
    const best = ranked[0], options: PlanOption[] = [];
    if (direct && direct.nodes.join(",") !== best.route.nodes.join(",")) options.push(this.option("direct", "Direct route", direct));
    options.push(...ranked);
    const d = options[0].id === "direct" ? ` vs direct ${Math.round(direct!.length)} m (${options[0].blocked} impassable or unseen segment${options[0].blocked === 1 ? "" : "s"})` : "";
    await this.propose(options, false, `${this.target.label} · ${ranked.length} verified route${ranked.length > 1 ? "s" : ""} compared · recommended ${best.label} ${Math.round(best.route.length)} m${d}`, best.id);
  }

  private option(id: PlanOption["id"], label: string, route: Route, reason?: string): PlanOption {
    const blocked = route.edges.filter((e, i) => this.isBlocked(e, route.nodes[i])).length, hazardsNear = hazardsAlong(route, this.collapseXY, 6);
    const eligible = blocked === 0;
    return { id, label, route: { ...route, blocked: route.edges.filter((e, i) => this.isBlocked(e, route.nodes[i])) }, eta: route.length / HUSKY_PLAN_SPEED, blocked, hazardsNear, eligible,
      reason: reason ?? (eligible ? "All segments observed passable" : `Crosses ${blocked} segment${blocked > 1 ? "s" : ""} graded impassable or not yet observed`) };
  }

  private async propose(options: PlanOption[], replan: boolean, detail: string, chosenId?: string) {
    const pick = options.find((o) => o.id === chosenId) ?? options.find((o) => o.eligible) ?? options[options.length - 1];
    const version = this.plans.length + 1, chosen = pick.route, id = `PLN-${String(version).padStart(3, "0")}`;
    let hash: string, authority: ProposeResult | undefined;
    if (this.live) {
      authority = await this.live.propose({ planId: id, version, target: this.target.label, chosen: pick.id,
        options: options.map((o) => ({ id: o.id, route: this.routeLngLat(o.route) })) });
      hash = authority.hash;
    } else {
      hash = await sha256(JSON.stringify({ mission: "AOI-M1", version, target: this.target.label, unit: "husky-a300", nodes: chosen.nodes, closed: [...this.closed], speed: HUSKY_PLAN_SPEED }));
    }
    this.plan = { version, id, hash, target: this.target.label, options, chosen: pick.id, replan, authority };
    this.plans.push(this.plan);
    this.phase = "awaiting_approval";
    this.log("planner", replan ? "Re-plan proposed" : "Plan proposed", `${this.plan.id} v${version} · ${detail}`, hash);
    this.emit();
  }

  /** Live: the authority must accept the approval first. Returns false when it is rejected. */
  async approve(by: string = OPERATOR, role = "ops-commander"): Promise<boolean> {
    if (this.phase !== "awaiting_approval" || !this.plan) return false;
    // no command path right now: the approval still stands; UGV-1 holds (fail-safe) and starts as soon as a link returns
    const noLink = !this.ugvLink.ok;
    if (this.live) {
      const plan = this.plan;
      const res: ApproveResult = await this.live.approve({ planId: plan.id, version: plan.version, hash: plan.hash, approverRole: role });
      if (!res.ok) { plan.rejected = res.checks; this.emit(); return false; }
      plan.rejected = undefined; plan.approval = res.checks;
    }
    this.plan.rejected = undefined;
    this.approvedHash = this.plan.hash;
    this.approvedBy = by;
    this.plan.approvedBy = by;
    const route = this.plan.options.find((o) => o.id === this.plan!.chosen)!.route;
    this.exec = { path: new Path(route.pts), s: 0, route };
    // one scripted in-mission obstruction on the first sortie (simulated, labelled as such)
    if (!this.live && this.ti === 0 && this.incidents.length === 0) this.exec.incidentAt = this.pickIncident(route);
    this.phase = "executing";
    this.rover.status = `En route to ${this.target.label}`;
    this.incident = null;
    this.log(by, "Plan approved", `${this.plan.id} v${this.plan.version} bound to hash`, this.plan.hash);
    if (noLink) this.log("comms", "Waiting for command link", `${this.plan.id} approved · UGV-1 out of direct ground range and the UAV-1 relay is not up yet · it starts automatically when a link returns`);
    this.log("husky-a300", "Route accepted", `Executing ${Math.round(route.length)} m at ${HUSKY_PLAN_SPEED.toFixed(1)} m/s${this.live ? " · FollowPath goal on /ugv/follow_path (Gazebo)" : ""}`);
    this.emit();
    return true;
  }

  /** The operator prefers another eligible route: it is proposed as a new plan version, so the approval binds to it. */
  async chooseOption(id: string) {
    const p = this.plan;
    if (!p || this.phase !== "awaiting_approval" || p.chosen === id) return;
    const o = p.options.find((x) => x.id === id);
    if (!o?.eligible) return;
    const options = p.options.map((x) => ({ ...x }));
    await this.propose(options, p.replan, `${this.operatorName} selected ${o.label} instead of the recommendation · ${Math.round(o.route.length)} m`, id);
  }

  /** Verification demo: re-submit an earlier plan's approval to the authority; it must be rejected. */
  async retryApproval(p: Plan, role = "ops-commander") {
    if (!this.live) return null;
    const res = await this.live.approve({ planId: p.id, version: p.version, hash: p.hash, approverRole: role });
    this.log("authority", res.ok ? "Re-used approval ACCEPTED" : "Re-used approval rejected", `${p.id} v${p.version} · ${Object.values(res.checks).filter((c) => !c.ok).map((c) => c.detail).join("; ") || "all checks passed"}`);
    this.emit();
    return res;
  }

  /** Picks a segment 35–70% along the route that can be bypassed from the node before it. */
  private pickIncident(route: Route) {
    const path = new Path(route.pts);
    for (let k = 1; k < route.edges.length - 1; k++) {
      const s = path.cum[k], f = s / path.length;
      if (f < 0.35 || f > 0.7 || route.edges[k].len < 12) continue;
      const a = route.nodes[k], b = route.nodes[k + 1], kk = key(a, b);
      const alt = shortestPath(this.graph, a, this.target.node, (e, u) => this.isBlocked(e, u) || key(u, e.to) === kk);
      if (alt && alt.length < route.length * 2.5) return { k, s };
    }
    return undefined;
  }

  private async raiseIncident(route = this.exec!.route, k = this.exec!.incidentAt!.k, worldVersion?: number) {
    const a = route.nodes[k], b = route.nodes[k + 1], pa = this.graph.nodes[a], pb = this.graph.nodes[b];
    const mid = this.frame.toLngLat([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]);
    const road = roadName(this.graph.names[route.edges[k].road]);
    this.closed.add(key(a, b));
    this.roverNode = a;
    this.exec = null;
    this.phase = "incident";
    this.rover = { ...this.rover, speed: 0, status: "Holding · obstruction ahead" };
    this.incident = { at: mid, road, planId: this.plan!.id, t: this.t };
    this.incidents.push(this.incident);
    const wet = this.spec.kind === "flood", dep = wet ? Math.max(this.waterDepth(pa), this.waterDepth(pb), this.waterDepth([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2])) : 0;
    const what = wet ? `Water ${dep.toFixed(1)} m deep across ${road}` : `Debris across ${road}`;
    this.find({ id: `inc-${this.incidents.length}`, kind: "incident", title: wet ? "Road flooded ahead (simulated)" : "New obstruction (simulated)", detail: `${what} · reported by UAV-1 overwatch`, at: mid });
    this.log("x500", "Obstruction detected", `${what}, ${Math.round(dist(pa, pb) / 2)} m ahead of UGV-1${wet ? ` (Husky limit ${HUSKY_WADE} m)` : ""} · ${this.plan!.id} invalidated${worldVersion ? ` · world version ${worldVersion} (Gazebo entity spawned by the authority)` : ""}`);
    this.log("husky-a300", "Holding position", `Stopped at last verified junction · awaiting re-approval`);
    this.emit();
    // continue the old plan (now blocked) vs re-route from the holding point
    const rest: Route = { nodes: route.nodes.slice(k), pts: route.pts.slice(k), edges: route.edges.slice(k), length: 0, blocked: [], hazardsNear: 0 };
    rest.length = rest.edges.reduce((s, e) => s + e.len, 0);
    const ranked = this.rankRoutes(a, this.target.node);
    if (!ranked.length) { this.noRoute = true; this.log("planner", "No verified re-route", "Holding until the area is surveyed again"); this.emit(); return; }
    const options = [this.option("direct", `Continue ${this.plan!.id}`, rest, wet ? "Blocked: the road is now under water deeper than the Husky can drive" : "Blocked by the obstruction UAV-1 just reported"), ...ranked];
    await this.propose(options, true, `re-route ${Math.round(ranked[0].route.length)} m from holding point (${ranked[0].label}) · ${this.plan!.id} blocked on ${road}`, ranked[0].id);
  }

  /** After a target is closed: move on to the next collapse site. */
  nextTarget() {
    if (this.phase !== "complete" || this.remainingTargets === 0) return;
    this.ti = this.targets.findIndex((t) => !t.done);
    this.plan = null; this.approvedHash = null; this.incident = null;
    this.phase = "review";
    this.rover = { ...this.rover, status: `Ready · next target ${this.target.label}` };
    if (this.drone.status.startsWith("Landed")) { this.droneBattery = 1; this.rtl = false; this.drone = { ...this.drone, battery: 1, status: "Landed · battery swapped" }; }
    if (this.live) void this.live.swap();
    this.log(this.operatorName, "Next target", `${this.target.label} selected · ${this.remainingTargets} site(s) remaining`);
    this.emit();
  }

  // ---------- simulation step (real seconds)
  /** Rising water: re-grade on every 0.25 m step; a segment ahead of UGV-1 that goes under water stops it (re-plan). */
  private stepFlood() {
    if (this.spec.kind !== "flood" || !this.flood) return;
    const lvl = this.floodLevel, fk = this.floodKey;
    if (fk === this.floodKeyLast) return;
    const first = this.floodKeyLast === ""; this.floodKeyLast = fk;
    if (first) return;
    this.recomputeScenario();
    if (lvl !== this.lastLoggedLevel) { this.lastLoggedLevel = lvl; this.log("system", "Water rising", `Water now +${lvl.toFixed(2)} m above the riverbank, spread ${this.floodSpread} m from the river (simulated, terrain-modelled)`); }
    const ex = this.exec;
    if (this.phase === "executing" && ex) {
      let i0 = ex.path.cum.findIndex((c) => c > ex.s); if (i0 < 0) return; i0 = Math.max(0, i0 - 1);
      for (let k = i0; k < ex.route.edges.length; k++) if (this.effGrade(ex.route.nodes[k], ex.route.edges[k]) >= 2) { void this.raiseIncident(ex.route, Math.max(k, i0)); break; }
    }
    this.emit();
  }

  step(realDt: number) {
    if (this.live) { this.stepLive(); this.watchLink(); return; }
    this.stepFlood();
    this.watchLink();
    if (this.paused || this.phase === "standby" || this.phase === "complete") return;
    const dt = Math.min(realDt, 0.1) * this.speed;
    this.t += dt;
    if (this.phase === "survey") this.stepSurvey(dt);
    else if (this.phase === "executing") this.stepExec(dt);
    else if (this.phase === "on_site") this.stepSite(dt);
    else if (this.phase === "awaiting_approval" || this.phase === "incident") { if (this.plan?.replan) this.orbitDrone(dt, this.incident?.at); this.emitThrottled(); }
    else this.emitThrottled();
  }

  private stepSurvey(dt: number) {
    this.surveyS = Math.min(this.surveyPath.length, this.surveyS + X500_CRUISE * dt);
    const { p, hdg } = this.surveyPath.at(this.surveyS);
    this.droneBattery -= dt / X500_ENDURANCE_S;
    this.drone = { ...this.drone, at: this.frame.toLngLat(p), hdg, speed: X500_CRUISE, battery: this.droneBattery, alt: X500_ALT };
    const last = this.track[this.track.length - 1];
    if (!last || dist(this.frame.toXY(last), p) > 6) this.track.push(this.drone.at);
    this.covAdd(p, X500_ALT);
    this.observe(p);
    if (this.surveyS >= this.surveyPath.length) this.finishSurvey();
    this.emitThrottled();
  }

  /** Detection model: Copernicus grade of anything inside the camera footprint (simulated perception, labelled). */
  private observe(p: XY) {
    const r = X500_SWATH / 2;
    for (const b of this.survey) if (!this.verified.has(b.id) && dist(b.p, p) <= r) {
      this.verified.add(b.id);
      if (this.spec.kind === "flood" && b.g >= 2) { const dp = this.waterDepth(b.p); this.find({ id: b.id, kind: "collapse", title: dp > 1.2 ? "Building flooded · ground floor under water" : "Building flooded", detail: `Water about ${dp.toFixed(1)} m deep at the entrance · simulated flood`, at: this.frame.toLngLat(b.p) }); }
      else if (b.g === 3) this.find({ id: b.id, kind: "collapse", ...(this.spec.kind === "flood" ? { title: "Building flooded", detail: "Water at ground floor · simulated flood" } : this.spec.kind === "fire" ? { title: "Building on fire", detail: "Inside the fire zone · simulated" } : { title: "Structural collapse", detail: "Destroyed · rubble field" }), at: this.frame.toLngLat(b.p) });
    }
    for (const h of this.roadHazards) if (!this.seen.has(h.id) && dist(h.p, p) <= r) {
      this.seen.add(h.id);
      this.find({ id: h.id, kind: "road", title: this.spec.kind === "flood" ? `Road under ${this.waterDepth(h.p).toFixed(1)} m of water` : this.spec.kind === "fire" ? "Road blocked by fire" : h.g === 3 ? "Road destroyed" : "Road obstructed", detail: h.name, at: h.ll });
    }
    for (const c of this.crisisPts) if (!this.seen.has(c.id) && dist(c.p, p) <= r) {
      this.seen.add(c.id);
      this.find({ id: c.id, kind: c.t === "Camp" ? "camp" : "barrier", title: c.t === "Camp" ? "People gathered" : "Road barrier", detail: c.t === "Camp" ? "Spontaneous site" : "Physical barrier", at: c.ll });
    }
  }

  private finishSurvey() {
    {
      this.phase = "review";
      const c = this.counts, used = Math.round((1 - this.droneBattery) * 100);
      this.droneBattery = 1;
      this.drone = { ...this.drone, at: this.staging.at, status: "Landed · battery swapped", speed: 0, alt: 0, battery: 1 };
      this.log("x500", "Survey complete", `${c.verified}/${c.total} structures verified · ${c.destroyed} destroyed · ${c.damaged} damaged · ${c.roads} road hazards · ${used}% battery used`);
      this.log("x500", "Landed at staging", `Battery swapped (field procedure) · ready for overwatch · ${this.cov.size} coverage cells`);
    }
    this.emit();
  }

  private stepExec(dt: number) {
    const ex = this.exec!, prev = ex.s;
    if (!this.ugvLink.ok) {   // fail-safe: never move without a command path
      this.rover = { ...this.rover, speed: 0, status: "Holding · no command link (fail-safe)" };
      this.orbitDrone(dt); this.emitThrottled(); return;
    }
    if (this.rover.status.startsWith("Holding · no command")) this.rover.status = `En route to ${this.target.label}`;
    const stopAt = ex.incidentAt ? ex.incidentAt.s : ex.path.length;
    ex.s = Math.min(stopAt, ex.s + HUSKY_PLAN_SPEED * dt);
    this.driven += ex.s - prev;
    const { p, hdg } = ex.path.at(ex.s);
    this.rover = { ...this.rover, at: this.frame.toLngLat(p), hdg, speed: HUSKY_PLAN_SPEED, battery: Math.max(0, this.rover.battery - dt / (8 * 3600)) };
    const last = this.roverTrail[this.roverTrail.length - 1];
    if (!last || dist(this.frame.toXY(last), p) > 4) this.roverTrail.push(this.rover.at);
    this.orbitDrone(dt);
    if (ex.incidentAt && ex.s >= ex.incidentAt.s) { void this.raiseIncident(); return; }
    if (ex.s >= ex.path.length) this.arrive();
    this.emitThrottled();
  }

  private arrive() {
    if (this.exec) this.exec.s = this.exec.path.length;
    this.phase = "on_site";
    this.siteT = 0;
    this.roverNode = this.target.node;
    this.rover = { ...this.rover, speed: 0, status: `Inspecting ${this.target.label}` };
    const dev = this.plan?.replan ? "1 approved re-plan" : "0 deviations";
    this.log("husky-a300", `Arrived at ${this.target.label}`, `Route completed with ${dev} · ${Math.round(this.driven)} m driven so far`);
    this.emit();
  }

  private stepSite(dt: number) {
    this.siteT += dt;
    this.orbitDrone(dt);
    if (this.siteT > SITE_TIME) {
      const tg = this.target;
      tg.done = true;
      this.phase = "complete";
      this.rover.status = `Holding at ${tg.label}`;
      const signal = this.ti === 0;
      if (signal) this.find({ id: `sig-${tg.label}`, kind: "signal", title: "Acoustic signal (simulated)", detail: `Tapping detected at ${tg.label} · handed to USAR team`, at: tg.at });
      this.log("husky-a300", "Inspection complete", `${tg.label} · thermal and acoustic sweep, 4 min · ${signal ? "1 simulated signal of interest · handed to USAR team" : "no signal of interest"}`);
      if (this.remainingTargets === 0) this.log("system", "Mission record sealed", `${this.targets.length} sites closed · ${this.plans.length} plans · ${this.incidents.length} incident(s) · ${this.audit.length + 1} entries`, this.approvedHash ?? undefined);
      this.emit();
    } else this.emitThrottled();
  }

  /** Overwatch orbit (60 m) around a point; flies there first; returns to staging at 25% battery. */
  private orbitDrone(dt: number, around?: LngLat) {
    if (this.rtl && this.drone.status.startsWith("Landed")) {
      this.swapT += dt;
      this.drone = { ...this.drone, speed: 0, alt: 0, status: `Landed · battery swap ${Math.min(100, Math.round((this.swapT / SWAP_TIME) * 100))}%` };
      if (this.swapT >= SWAP_TIME) {
        this.swapT = 0; this.rtl = false; this.droneBattery = 1;
        this.drone = { ...this.drone, battery: 1, status: "Relaunching · battery swapped" };
        this.log("x500", "Battery swapped", "Field swap at staging (simulated, 2 min) · relaunching for overwatch and relay");
      }
      return;
    }
    const stepM = X500_CRUISE * dt;
    this.droneBattery -= dt / X500_ENDURANCE_S;
    const cur = this.frame.toXY(this.drone.at);
    const flyTo = (goal: XY, status: string, alt = X500_ALT) => {
      const d = dist(goal, cur);
      if (d <= stepM) { this.drone = { ...this.drone, at: this.frame.toLngLat(goal), speed: 0, alt, status, battery: this.droneBattery }; return true; }
      const p: XY = [cur[0] + ((goal[0] - cur[0]) / d) * stepM, cur[1] + ((goal[1] - cur[1]) / d) * stepM];
      this.drone = { ...this.drone, at: this.frame.toLngLat(p), hdg: (Math.atan2(goal[0] - cur[0], goal[1] - cur[1]) * 180) / Math.PI, speed: X500_CRUISE, alt: X500_ALT, status, battery: this.droneBattery };
      return false;
    };
    if (this.rtl || this.droneBattery <= 0.25) {
      if (!this.rtl) { this.rtl = true; this.log("x500", "Return to staging", `Battery reserve reached (${Math.round(this.droneBattery * 100)}%) · relay unavailable until relaunch`); }
      if (flyTo(this.frame.toXY(this.staging.at), "Landed · battery swap 0%", 0)) { this.drone.speed = 0; this.drone.alt = 0; this.swapT = 0; }
      else this.drone.status = "Returning to staging";
      return;
    }
    const c = this.frame.toXY(around ?? this.target.at);
    const ring: XY = [c[0] + 60 * Math.cos(this.orbitA), c[1] + 60 * Math.sin(this.orbitA)];
    if (dist(ring, cur) > stepM * 1.5) { flyTo(ring, `Transit · overwatch ${around ? "obstruction" : this.target.label}`); return; }
    this.orbitA += (dt * X500_CRUISE * 0.5) / 60;
    const p: XY = [c[0] + 60 * Math.cos(this.orbitA), c[1] + 60 * Math.sin(this.orbitA)];
    this.drone = { ...this.drone, at: this.frame.toLngLat(p), hdg: (-this.orbitA * 180) / Math.PI, speed: X500_CRUISE * 0.5, battery: Math.max(0, this.droneBattery), alt: X500_ALT, status: around ? "Overwatch · obstruction" : `Overwatch · ${this.target.label}` };
    this.covAdd(p, X500_ALT);
  }

  private lastEmit = 0;
  private emitThrottled() { const now = performance.now(); if (now - this.lastEmit > 120) { this.lastEmit = now; this.emit(); } }

  // ---------- geometry for the map
  routeLngLat(r: Route) { return r.pts.map((p) => this.frame.toLngLat(p)); }
  blockedMarks(r: Route): LngLat[] {
    const out: LngLat[] = [];
    r.edges.forEach((e, i) => { if (this.effGrade(r.nodes[i], e) >= 2) { const a = r.pts[i], b = r.pts[i + 1]; out.push(this.frame.toLngLat([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])); } });
    return out;
  }

  exportRecord() {
    return {
      mission: this.custom ? "NEW" : "AOI-M1", case: this.data.meta.id, place: this.data.meta.title, created: new Date().toISOString(), source: this.live ? "gazebo-ros2-live" : "browser-replay",
      replayClockStart: new Date(EVENT_START).toISOString(),
      targets: this.targets.map((t) => ({ label: t.label, at: t.at, done: t.done })),
      plans: this.plans.map((p) => ({ id: p.id, version: p.version, target: p.target, hash: p.hash, replan: p.replan, chosen: p.chosen, approvedBy: p.approvedBy ?? null,
        options: p.options.map((o) => ({ id: o.id, label: o.label, length: Math.round(o.route.length), eligible: o.eligible, risk: o.risk ?? null, comms: o.comms ? { direct: Math.round(o.comms.direct), relay: Math.round(o.comms.relay), nolink: Math.round(o.comms.nolink) } : null, score: o.score ? Math.round(o.score) : null, recommended: !!o.recommended })),
        authority: p.authority ?? null, approvalChecks: p.approval ?? null })),
      scenario: { mode: this.custom ? "new-mission" : "example", kind: this.spec.kind, name: this.scenarioName, floodRisePeak: this.spec.kind === "flood" ? this.spec.floodRise : null, floodLevelNow: this.spec.kind === "flood" ? this.floodLevel : null, fires: this.spec.kind === "fire" ? this.spec.fires : null, fireRadius: this.spec.kind === "fire" ? this.spec.fireRadius : null, edited: this.scenarioEdited, surveyArea: this.surveyArea, start: this.staging.at, destination: this.targets.map((t) => ({ label: t.label, at: t.at })) },
      incidents: this.incidents.map((i) => ({ ...i, t: Math.round(i.t), simulated: true })),
      debrief: { ...this.debrief, elapsed: Math.round(this.t), driven: Math.round(this.driven) },
      comms: { links: this.links.map((l) => ({ id: l.id, up: l.up, q: Math.round(l.q * 100) / 100, dist: Math.round(l.dist) })), via: this.ugvLink.via, model: "modelled link budget, not measured" },
      counts: this.counts, findings: this.findings.map((f) => ({ ...f, t: Math.round(f.t) })), audit: this.audit.map((a) => ({ ...a, t: Math.round(a.t) })),
      sources: this.data.meta.sources, note: this.realDamage && this.spec.kind === "earthquake" ? "Geography and damage grades are real public data; robots, mission, the in-mission obstruction and signals are simulated." : "Geography (buildings, roads, water) is real public data; the hazard, robots, mission and signals are simulated.",
    };
  }
}

const roadName = (n?: string) => (!n || /^(unknown|not applicable|unnamed road)$/i.test(n) ? "an unnamed street" : n);

export function fmtDur(s: number) {
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return m ? `${m} min ${String(r).padStart(2, "0")} s` : `${r} s`;
}
export function fmtClock(d: Date) {
  const t = new Date(d.getTime() + 3 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const mon = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][t.getUTCMonth()];
  return { date: `${p(t.getUTCDate())} ${mon} ${t.getUTCFullYear()}`, time: `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}` };
}
export function fmtSince(s: number) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return `T+${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`; }
