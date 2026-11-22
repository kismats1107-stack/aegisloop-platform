import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import maplibregl, { type GeoJSONSource, type Map as MLMap } from "maplibre-gl";
import { AlertTriangle, ArrowRight, Check, X as XIcon, ChevronLeft, Crosshair, Download, FileCheck2, Flag, Flame, Hexagon, Layers, MousePointer2, Plus, Waves, Pause, Play, Plane, RadioTower, RotateCcw, ShieldCheck, Truck, Users } from "lucide-react";
import "../styles/console.css";
import "../styles/uavfeed.css";
import "../styles/pages.css";
import "../styles/sitrep.css";
import "../styles/scenario.css";
import "../styles/routecard.css";
import { scanBeamLayer } from "../map/scanBeam";
import { fleetLayer } from "../map/fleet3d";
import { UavFeed } from "./UavFeed";
import { CommsPage, SitrepPage } from "./Situation";
import { DamagePage, PlansPage, RecordPage, Rail, type View } from "./Pages";
import { Logo } from "../components/Shell";
import { CaseMap } from "../map/CaseMap";
import { useAntakya } from "../data/useCase";
import { GRADE_COLOR, GRADE_LABEL, type BuildingProps, type CaseData } from "../data/antakya";
import { FLEET, X500_SWATH } from "../data/fleet";
import { fmtLatLng, type LngLat } from "../lib/geo";
import { FLOOD_RAMP, INTENSITY_LABEL, type Finding, Mission, OPERATOR, PHASES, type Phase, type ScenarioKind, type ScenarioSpec, type UgvLink, fmtClock, fmtDur, fmtSince } from "./mission";
import { TeamChat, postMissionEvent, type TeamMember } from "./TeamChat";
import { PlacePicker } from "./PlacePicker";
import { RouteCard } from "./RouteCard";
import { CAUTION, HUSKY_WADE, floodImage, loadFloodTerrain } from "../lib/flood";
import { type Session, SignIn, setSession } from "./SignIn";
import { type ApproveResult, type Check as AuthCheck, LiveLink, type LiveStatus, liveStatus } from "./live";

export default function Console() {
  const { data, error } = useAntakya();
  useEffect(() => { document.title = "Operations console · AegisLoop"; }, []);
  // sign-in is asked every time the console opens; the session lives only in memory
  const [session, setS] = useState<Session | null>(null);
  useEffect(() => () => setSession(null), []);
  const signOut = () => { setSession(null); setS(null); };
  // which place the console runs on: the Antakya case (default) or a city loaded from OpenStreetMap
  const [place, setPlace] = useState<{ data: CaseData | null; mode: "example" | "new"; n: number }>({ data: null, mode: "example", n: 0 });
  if (!session) return <SignIn onSignedIn={setS} />;
  if (error) return <div className="cx-fallback">Could not load case data: {error}</div>;
  if (!data) return <div className="cx-fallback" aria-busy="true"><span className="mono">Loading Antakya case data…</span></div>;
  const d = place.data ?? data;
  return <ConsoleView key={`${d.meta.id}-${place.n}`} data={d} initialMode={place.mode} session={session} onSignOut={signOut}
    onPlace={(pd) => setPlace((p) => ({ data: pd, mode: "new", n: p.n + 1 }))}
    onExample={() => setPlace((p) => ({ data: null, mode: "example", n: p.n + 1 }))} />;
}

type Tab = "findings" | "plan" | "record" | "team";
const framePad = () => window.innerWidth > 900 ? { left: window.innerWidth > 1280 ? 380 : 340, right: window.innerWidth > 1280 ? 420 : 380, top: 70, bottom: 30 } : 20;
const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features });
const line = (coords: LngLat[], props: Record<string, unknown> = {}): GeoJSON.Feature => ({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } });
const point = (c: LngLat, props: Record<string, unknown> = {}): GeoJSON.Feature => ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: c } });

function ConsoleView({ data, initialMode, onPlace, onExample, session, onSignOut }: { data: CaseData; initialMode: "example" | "new"; onPlace: (d: CaseData | null) => void; onExample: () => void; session: Session; onSignOut: () => void }) {
  const isOsm = data.meta.origin === "osm";
  const placeName = isOsm ? data.meta.title : "Antakya, Hatay";
  const [picker, setPicker] = useState(false);
  const [card, setCard] = useState(false);
  const [epoch, setEpoch] = useState(0);
  // "example": the Antakya replay, untouched. "new": the operator builds the mission on the same map.
  const [mode, setMode] = useState<"example" | "new">(initialMode);
  // the operator's new mission survives restarts ("Edit scenario and fly again")
  const blank = (): { area: LngLat[] | null; start: LngLat | null; dest: LngLat | null; spec: Partial<ScenarioSpec> } => ({ area: null, start: null, dest: null, spec: {} });
  const scenario = useRef(blank());
  const mission = useMemo(() => {
    const custom = mode === "new", m = new Mission(data, { custom }), sc = scenario.current;
    if (custom) {
      if (Object.keys(sc.spec).length) m.setScenario(sc.spec);
      if (sc.area) m.setSurveyArea(sc.area);
      if (sc.start) m.setStart(sc.start);
      if (sc.dest) m.setDestination(sc.dest);
    }
    return m;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, epoch, mode]);
  if (import.meta.env.DEV) (window as unknown as { __mission: Mission }).__mission = mission;   // test hook (dev only)
  type Tool = "select" | "area" | "start" | "dest" | "fire";
  const [notice, setNotice] = useState<string | null>(null);
  const [floodState, setFloodState] = useState<"idle" | "loading" | "ready" | "nowater" | "error">("idle");
  useEffect(() => {
    if (mission.spec.kind !== "flood") return;
    if (mission.flood) { setFloodState(mission.flood.hasWater ? "ready" : "nowater"); return; }
    let off = false; setFloodState("loading");
    loadFloodTerrain(data).then((t) => { if (off) return; mission.setFloodTerrain(t); setFloodState(!t ? "error" : t.hasWater ? "ready" : "nowater"); }).catch(() => !off && setFloodState("error"));
    return () => { off = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mission, mission.spec.kind]);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(null), 3500); return () => clearTimeout(t); }, [notice]);
  const [tool, setTool] = useState<Tool>(initialMode === "new" ? "area" : "select");
  const toolRef = useRef<Tool>("select"); toolRef.current = tool;
  const [draft, setDraft] = useState<LngLat[]>([]);
  const draftRef = useRef<LngLat[]>([]); draftRef.current = draft;
  // simulation source: in-browser replay, or Gazebo + ROS 2 through the mission authority (sim/run_live.sh)
  const [source, setSource] = useState<"replay" | "gazebo">("replay");
  const [liveOk, setLiveOk] = useState<LiveStatus | null>(null);
  useEffect(() => { let on = true; const poll = () => liveStatus().then((s) => on && setLiveOk(s)); poll(); const id = setInterval(poll, 3000); return () => { on = false; clearInterval(id); }; }, []);
  const link = useMemo(() => (source === "gazebo" ? new LiveLink().connect() : null), [source]);
  useEffect(() => () => link?.close(), [link]);
  useEffect(() => { if (link) void mission.attachLive(link); return () => mission.detachLive(); }, [mission, link]);
  const switchSource = (s: "replay" | "gazebo") => { if (s === source) return; setSource(s); setEpoch((e) => e + 1); };
  const version = useSyncExternalStore(useCallback((cb) => mission.subscribe(cb), [mission]), () => mission.t + mission.findings.length * 1e7 + mission.audit.length * 1e9 + PHASES.findIndex((p) => p.id === mission.phase));
  void version;
  const [tab, setTab] = useState<Tab>("findings");
  const [view, setView] = useState<View>("ops");
  const missionRef = useRef(mission);
  missionRef.current = mission;
  const [unread, setUnread] = useState(0);
  const member: TeamMember = session.user;
  // mission events -> Nexconn mission channel (posted by the AegisLoop bot, server-signed)
  useEffect(() => { mission.operatorName = member?.name ?? OPERATOR; }, [mission, member]);
  const posted = useRef(0);
  useEffect(() => { posted.current = mission.audit.length; }, [mission]);
  useEffect(() => {
    const fresh = mission.audit.slice(posted.current); posted.current = mission.audit.length;
    for (const a of fresh) { const e = missionEvent(a.action, a.detail, a.actor, a.hash); if (e) postMissionEvent(e.kind, e.text); }
  }, [mission, mission.audit.length]);
  const [scene, setScene] = useState<"pre" | "post">("post");
  const [follow, setFollow] = useState<"none" | "drone" | "rover">("none");
  const followRef = useRef(follow);
  followRef.current = follow;
  const [, force] = useReducer((x: number) => x + 1, 0);
  const mapRef = useRef<MLMap | null>(null);
  const markers = useRef<{ drone?: maplibregl.Marker; rover?: maplibregl.Marker }>({});
  const applied = useRef(new Set<string>());

  // auto-switch to the plan tab when approval is needed
  useEffect(() => { if (mission.phase === "awaiting_approval") setTab("plan"); if (mission.phase === "complete") setTab("record"); }, [mission.phase]);

  // simulation loop
  useEffect(() => {
    let raf = 0, last = performance.now();
    const loop = (now: number) => {
      mission.step((now - last) / 1000); last = now;
      syncMap();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mission]);

  // reset map overlays when the mission is restarted
  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    applied.current.forEach((id) => map.setFeatureState({ source: "buildings", id }, { v: false }));
    applied.current.clear();
    lastFindings.current = -1; lastPlan.current = null; lastTrail.current = -1; lastInc.current = "x"; lastSites.current = "";
    (map.getSource("track") as GeoJSONSource | undefined)?.setData(fc([]));
    (map.getSource("routes") as GeoJSONSource | undefined)?.setData(fc([]));
    (map.getSource("marks") as GeoJSONSource | undefined)?.setData(fc([]));
    (map.getSource("survey-plan") as GeoJSONSource | undefined)?.setData(fc([line(mission.surveyLngLat)]));
    if (map.getLayer("survey-plan")) map.setLayoutProperty("survey-plan", "visibility", "visible");
  }, [mission]);

  const lastFindings = useRef(-1);
  const lastPlan = useRef<string | null>(null);
  const lastTrack = useRef(0);
  const lastTrail = useRef(-1);
  const lastInc = useRef("");
  const lastSites = useRef("");
  const lastLink = useRef(0);
  const lastGrades = useRef("");
  const lastFlood = useRef("");
  function syncMap() {
    const map = mapRef.current; if (!map || !map.getSource("track")) return;
    for (const id of mission.verified) if (!applied.current.has(id)) { applied.current.add(id); map.setFeatureState({ source: "buildings", id }, { v: true }); }
    if (mission.track.length !== lastTrack.current) { lastTrack.current = mission.track.length; (map.getSource("track") as GeoJSONSource).setData(fc(mission.track.length > 1 ? [line([...mission.track, mission.drone.at])] : [])); }
    if (mission.findings.length !== lastFindings.current) {
      lastFindings.current = mission.findings.length;
      const roadIdx = new Set(mission.findings.filter((f) => f.kind === "road").map((f) => Number(f.id.slice(1))));
      (map.getSource("hazard-roads") as GeoJSONSource).setData(fc(data.roads.features.filter((_, i) => roadIdx.has(i))));
      (map.getSource("findings") as GeoJSONSource).setData(fc(mission.findings.filter((f) => f.kind === "camp" || f.kind === "barrier").map((f) => point(f.at, { kind: f.kind }))));
    }
    if (mission.plan && lastPlan.current !== mission.plan.hash) {
      lastPlan.current = mission.plan.hash;
      map.setLayoutProperty("survey-plan", "visibility", "none");
      const pl = mission.plan;
      (map.getSource("routes") as GeoJSONSource).setData(fc(pl.options.map((o) => line(mission.routeLngLat(o.route), { k: o.id === pl.chosen ? "verified" : !o.eligible ? "direct" : "alt", label: o.id.replace("route-", "") }))));
      (map.getSource("marks") as GeoJSONSource).setData(fc(pl.options.filter((o) => !o.eligible).flatMap((o) => mission.blockedMarks(o.route)).map((c) => point(c))));
    }
    if (mission.roverTrail.length !== lastTrail.current) { lastTrail.current = mission.roverTrail.length; (map.getSource("trail") as GeoJSONSource).setData(fc(mission.roverTrail.length > 1 ? [line([...mission.roverTrail, mission.rover.at])] : [])); }
    const incKey = `${mission.incidents.length}`;
    if (incKey !== lastInc.current) { lastInc.current = incKey; (map.getSource("incident") as GeoJSONSource).setData(fc(mission.incidents.map((i) => point(i.at)))); }
    const sKey = `${mission.ti}-${mission.targets.map((t) => +t.done).join("")}`;
    if (sKey !== lastSites.current) { lastSites.current = sKey; (map.getSource("sites") as GeoJSONSource).setData(fc(siteFeatures(mission))); }
    const now = performance.now();
    if (now - lastLink.current > 150) {   // command path to UGV-1 (modelled): CP → UGV-1 or CP → UAV-1 → UGV-1
      lastLink.current = now;
      const l = mission.ugvLink, cp = mission.staging.at, away = Math.abs(cp[0] - mission.rover.at[0]) + Math.abs(cp[1] - mission.rover.at[1]) > 0.0002;
      const path = mission.phase === "standby" || !away ? null : l.via === "direct" ? [cp, mission.rover.at] : l.via === "relay" ? [cp, mission.drone.at, mission.rover.at] : null;
      (map.getSource("cmdlink") as GeoJSONSource | undefined)?.setData(fc(path ? [line(path, { via: l.via })] : []));
    }
    const brg = map.getBearing();
    markers.current.drone?.setLngLat(mission.drone.at);
    markers.current.rover?.setLngLat(mission.rover.at);
    const ds = markers.current.drone?.getElement().firstElementChild as HTMLElement | null, rs = markers.current.rover?.getElement().firstElementChild as HTMLElement | null;
    if (ds) ds.style.transform = `rotate(${mission.drone.hdg - brg}deg)`;
    // the 3D models replace the flat symbols; the drone's name tag rides up to its altitude
    if (ds) ds.style.opacity = "0";
    if (rs) rs.style.opacity = "0";
    const mppNow = (40075016.686 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
    markers.current.drone?.setOffset([0, -((mission.drone.alt ?? 0) / mppNow) * Math.sin((map.getPitch() * Math.PI) / 180) - 18]);
    markers.current.rover?.setOffset([0, -14]);
    if (rs) rs.style.transform = `rotate(${mission.rover.hdg - brg}deg)`;
    const fw = followRef.current;
    if (fw !== "none") map.jumpTo({ center: fw === "drone" ? mission.drone.at : mission.rover.at });
  }

  const onReady = useCallback((map: MLMap) => {
    mapRef.current = map;
    if (import.meta.env.DEV) (window as unknown as { __map: MLMap }).__map = map;   // test hook (dev only)
    map.getContainer().dataset.noCrisis = "1";
    ["crisis-camp", "crisis-barrier", "roads-blocked", "roads-blocked-casing"].forEach((id) => map.setLayoutProperty(id, "visibility", "none"));
    map.addSource("survey-plan", { type: "geojson", data: fc([line(mission.surveyLngLat)]) });
    map.addSource("track", { type: "geojson", data: fc([]) });
    map.addSource("hazard-roads", { type: "geojson", data: fc([]) });
    map.addSource("findings", { type: "geojson", data: fc([]) });
    map.addSource("routes", { type: "geojson", data: fc([]) });
    map.addSource("marks", { type: "geojson", data: fc([]) });
    map.addSource("trail", { type: "geojson", data: fc([]) });
    map.addSource("incident", { type: "geojson", data: fc([]) });
    map.addSource("sites", { type: "geojson", data: fc(siteFeatures(mission)) });
    map.addSource("cmdlink", { type: "geojson", data: fc([]) });
    map.addSource("setup-area", { type: "geojson", data: fc([]) });
    map.addSource("setup-draft", { type: "geojson", data: fc([]) });
    map.addSource("preview", { type: "geojson", data: fc([]) });
    const blank = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const b0 = data.meta.contextBounds;
    map.addSource("hz-flood", { type: "image", url: blank, coordinates: [[b0[0], b0[3]], [b0[2], b0[3]], [b0[2], b0[1]], [b0[0], b0[1]]] });
    map.addSource("hz-fire", { type: "geojson", data: fc([]) });
    const mpp10 = (40075016.686 * Math.cos((data.meta.center[1] * Math.PI) / 180)) / (512 * 1024); // metres per pixel at z10 (512 px tiles)
    const swath = ["interpolate", ["exponential", 2], ["zoom"], 10, 105 / mpp10, 20, (105 / mpp10) * 1024] as maplibregl.ExpressionSpecification;
    map.addLayer({ id: "setup-area-fill", type: "fill", source: "setup-area", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#5b8cff", "fill-opacity": 0.12 } });
    map.addLayer({ id: "setup-area-line", type: "line", source: "setup-area", filter: ["==", ["geometry-type"], "Polygon"], paint: { "line-color": "#8ab4f8", "line-width": 2, "line-dasharray": [2, 1.5] } });
    map.addLayer({ id: "setup-area-pts", type: "circle", source: "setup-area", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 5, "circle-color": "#1a2ffb", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
    map.addLayer({ id: "setup-area-num", type: "symbol", source: "setup-area", filter: ["==", ["geometry-type"], "Point"], layout: { "text-field": ["get", "n"], "text-font": ["Noto Sans Bold"], "text-size": 10, "text-offset": [0, -1.4] }, paint: { "text-color": "#ffffff", "text-halo-color": "#1a2ffb", "text-halo-width": 2 } });
    map.addLayer({ id: "setup-draft-line", type: "line", source: "setup-draft", filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": "#ffffff", "line-width": 2, "line-dasharray": [1.5, 1.5] } });
    map.addLayer({ id: "setup-draft-pts", type: "circle", source: "setup-draft", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": ["case", ["get", "first"], 7, 5], "circle-color": "#ffffff", "circle-stroke-color": "#1a2ffb", "circle-stroke-width": 2.5 } });
    map.addLayer({ id: "setup-draft-num", type: "symbol", source: "setup-draft", filter: ["==", ["geometry-type"], "Point"], layout: { "text-field": ["get", "n"], "text-font": ["Noto Sans Bold"], "text-size": 10, "text-offset": [0, -1.5] }, paint: { "text-color": "#0b0c10", "text-halo-color": "#ffffff", "text-halo-width": 2 } });
    map.addLayer({ id: "hz-flood", type: "raster", source: "hz-flood", layout: { visibility: "none" }, paint: { "raster-opacity": 0.92, "raster-fade-duration": 400, "raster-resampling": "linear" } }, "bld-foot");
    map.addLayer({ id: "hz-fire-glow", type: "circle", source: "hz-fire", layout: { visibility: "none" }, paint: { "circle-color": "#ff5a1f", "circle-opacity": 0.38, "circle-blur": 0.25, "circle-radius": 20, "circle-stroke-color": "#ff8a3d", "circle-stroke-width": 1.5, "circle-stroke-opacity": 0.9 } });
    map.addLayer({ id: "hz-fire-core", type: "circle", source: "hz-fire", layout: { visibility: "none" }, paint: { "circle-color": "#ffb020", "circle-radius": 6, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
    map.addLayer({ id: "preview-casing", type: "line", source: "preview", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#0b0c10", "line-width": 5, "line-opacity": 0.5 } });
    map.addLayer({ id: "preview", type: "line", source: "preview", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": ["case", ["get", "inside"], "#ffffff", "#f9ab00"], "line-width": 2.6, "line-dasharray": [1.4, 1.2] } });
    map.addLayer({ id: "survey-plan", type: "line", source: "survey-plan", paint: { "line-color": "#ffffff", "line-opacity": 0.25, "line-width": 0.8, "line-dasharray": [2, 3] } });
    map.addLayer({ id: "swept", type: "line", source: "track", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#8ab4f8", "line-opacity": 0.1, "line-width": swath } });
    map.addLayer({ id: "track", type: "line", source: "track", paint: { "line-color": "#ffffff", "line-opacity": 0.35, "line-width": 0.9 } });
    map.addLayer({ id: "hazard-roads", type: "line", source: "hazard-roads", layout: { "line-cap": "round" }, paint: { "line-color": "#ff4d40", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 1.2, 18, 3], "line-opacity": 0.9 } });
    map.addLayer({ id: "route-direct", type: "line", source: "routes", filter: ["==", ["get", "k"], "direct"], layout: { "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 1.6, "line-dasharray": [2, 2], "line-opacity": 0.75 } });
    map.addLayer({ id: "route-alt", type: "line", source: "routes", filter: ["==", ["get", "k"], "alt"], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#c9d4ff", "line-width": 2.6, "line-opacity": 0.85 } });
    map.addLayer({ id: "route-alt-label", type: "symbol", source: "routes", filter: ["==", ["get", "k"], "alt"], layout: { "symbol-placement": "line-center", "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 11 }, paint: { "text-color": "#0b0c10", "text-halo-color": "#c9d4ff", "text-halo-width": 3 } });
    map.addLayer({ id: "route-verified-casing", type: "line", source: "routes", filter: ["==", ["get", "k"], "verified"], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.9 } });
    map.addLayer({ id: "route-verified", type: "line", source: "routes", filter: ["==", ["get", "k"], "verified"], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#1a2ffb", "line-width": 4 } });
    map.addLayer({ id: "trail", type: "line", source: "trail", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#1a2ffb", "line-width": 3, "line-opacity": 0.55 } });
    map.addLayer({ id: "cmdlink", type: "line", source: "cmdlink", layout: { "line-join": "round" }, paint: { "line-color": "#8ab4f8", "line-width": 1.4, "line-opacity": 0.85, "line-dasharray": [1, 2.5] } });
    map.addLayer({ id: "incident-halo", type: "circle", source: "incident", paint: { "circle-radius": 16, "circle-color": "rgba(255,77,64,0.18)", "circle-stroke-color": "rgba(255,77,64,0.6)", "circle-stroke-width": 1 } });
    map.addLayer({ id: "incident", type: "circle", source: "incident", paint: { "circle-radius": 6, "circle-color": "#ff4d40", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
    map.addLayer({ id: "incident-label", type: "symbol", source: "incident", layout: { "text-field": "OBSTRUCTION", "text-font": ["Noto Sans Bold"], "text-size": 10, "text-anchor": "left", "text-offset": [1.6, 0], "text-letter-spacing": 0.14 }, paint: { "text-color": "#ffffff", "text-halo-color": "rgba(160,20,10,0.95)", "text-halo-width": 1.4 } });
    map.addLayer({ id: "marks", type: "circle", source: "marks", paint: { "circle-radius": 3.5, "circle-color": "#ff4d40", "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5 } });
    map.addLayer({ id: "findings", type: "circle", source: "findings", paint: {
      "circle-radius": 3, "circle-color": ["match", ["get", "kind"], "camp", "#5b8cff", "barrier", "#f9ab00", "#9aa3ad"],
      "circle-stroke-width": 1.2, "circle-stroke-color": "#ffffff" } });
    map.addLayer({ id: "sites", type: "circle", source: "sites", paint: { "circle-radius": ["match", ["get", "k"], "target", 8, "next", 6, "done", 6, 4], "circle-color": ["match", ["get", "k"], "target", "rgba(0,0,0,0)", "next", "rgba(0,0,0,0)", "done", "#188038", "#ffffff"], "circle-stroke-width": 2, "circle-stroke-color": ["match", ["get", "k"], "target", "#ff4d40", "next", "rgba(255,255,255,0.8)", "done", "#ffffff", "#0b0c10"] } });
    map.addLayer({ id: "sites-core", type: "circle", source: "sites", filter: ["==", ["get", "k"], "target"], paint: { "circle-radius": 2, "circle-color": "#ff4d40" } });
    map.addLayer({ id: "sites-label", type: "symbol", source: "sites", layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 10, "text-anchor": "right", "text-offset": [-1.3, 0], "text-letter-spacing": 0.14 }, paint: { "text-color": "#ffffff", "text-halo-color": "rgba(11,12,16,0.85)", "text-halo-width": 1.2 } });

    map.addLayer(scanBeamLayer("uav-beam", X500_SWATH, () => {
      const m = missionRef.current;
      return { at: m.drone.at, alt: m.drone.alt ?? 0, hdg: m.drone.hdg, active: (m.drone.alt ?? 0) > 5 };
    }));
    // the real robots as 3D models (true size when zoomed in)
    map.addLayer(fleetLayer("fleet-3d", () => {
      const m = missionRef.current, vis = !m.custom || m.startSet;
      return { drone: { at: m.drone.at, hdg: m.drone.hdg, alt: m.drone.alt ?? 0, speed: m.drone.speed, visible: vis }, rover: { at: m.rover.at, hdg: m.rover.hdg, alt: 0, speed: m.rover.speed, visible: vis } };
    }));
    markers.current.drone = new maplibregl.Marker({ element: unitEl("drone"), opacityWhenCovered: "1", subpixelPositioning: true }).setLngLat(mission.drone.at).addTo(map);
    markers.current.rover = new maplibregl.Marker({ element: unitEl("rover"), opacityWhenCovered: "1", subpixelPositioning: true }).setLngLat(mission.rover.at).addTo(map);

    // scenario editing on the operations map
    map.on("click", (e) => {
      const m = missionRef.current, t = toolRef.current;
      if (!m.editable || t === "select") return;
      const ll: LngLat = [e.lngLat.lng, e.lngLat.lat];
      if (t === "start") { const err = m.setStart(ll); if (err) setNotice(err); else { scenario.current.start = ll; setTool(m.destSet ? "select" : "dest"); } }
      else if (t === "dest") { const err = m.setDestination(ll); if (err) setNotice(err); else { scenario.current.dest = ll; setTool("select"); } }
      else if (t === "fire") { const err = m.addFire(ll); if (err) setNotice(err); else scenario.current.spec = { ...scenario.current.spec, fires: m.spec.fires }; }
      else if (t === "area") {
        const d = draftRef.current;
        if (d.length >= 3) {               // clicking the first point closes the area
          const p0 = map.project(d[0] as [number, number]);
          if (Math.hypot(p0.x - e.point.x, p0.y - e.point.y) < 14) { finishArea(d); return; }
        }
        setDraft([...d, ll]);
      }
    });
    map.on("click", "bld", (e) => {
      if (toolRef.current !== "select") return;
      const f = e.features?.[0]; if (!f) return;
      const p = f.properties as unknown as BuildingProps;
      const verified = p.m === 0 || !!f.state?.v;
      new maplibregl.Popup({ closeButton: false, maxWidth: "260px" }).setLngLat(e.lngLat).setHTML(buildingHtml(p, verified)).addTo(map);
    });
    map.on("mouseenter", "bld", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "bld", () => (map.getCanvas().style.cursor = ""));
    const nm = initialMode === "new";
    map.fitBounds(data.meta.missionBounds as [number, number, number, number], { padding: framePad(), pitch: nm ? 0 : 50, bearing: nm ? 0 : -18, duration: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishArea = (pts: LngLat[]) => {
    if (pts.length < 3) return;
    const m = missionRef.current;
    scenario.current.area = pts; m.setSurveyArea(pts);
    if (!m.startSet) scenario.current.start = null;
    if (!m.destSet) scenario.current.dest = null;
    setDraft([]); setTool(!m.startSet ? "start" : !m.destSet ? "dest" : "select");
  };
  const resetScenario = () => { scenario.current = blank(); setDraft([]); setTool("area"); setEpoch((e) => e + 1); };
  const startNew = () => { scenario.current = blank(); setDraft([]); setFollow("none"); setTab("findings"); setMode("new"); setTool("area"); setEpoch((e) => e + 1); mapRef.current?.easeTo({ pitch: 0, bearing: 0, duration: 700 }); };
  const backToExample = () => { if (isOsm) { onExample(); return; } setDraft([]); setTool("select"); setMode("example"); setEpoch((e) => e + 1); };
  const patchScenario = (p: Partial<ScenarioSpec>) => { scenario.current.spec = { ...scenario.current.spec, ...p }; missionRef.current.setScenario(p); if (p.kind === "fire" && !missionRef.current.spec.fires.length) setTool("fire"); };
  // tool cursor, double-click to finish, Esc to cancel
  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    map.getCanvas().style.cursor = tool === "select" ? "" : "crosshair";
    if (tool === "area") map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setDraft([]); setTool("select"); }
      if (e.key === "Enter" && toolRef.current === "area") finishArea(draftRef.current);
      if ((e.key === "Backspace" || (e.key === "z" && (e.ctrlKey || e.metaKey))) && toolRef.current === "area") setDraft((d) => d.slice(0, -1));
    };
    const dbl = () => { if (toolRef.current === "area") finishArea(draftRef.current); };
    addEventListener("keydown", key); map.on("dblclick", dbl);
    return () => { removeEventListener("keydown", key); map.off("dblclick", dbl); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);
  // draw the draft and the committed survey area
  useEffect(() => {
    const map = mapRef.current; if (!map?.getSource("setup-draft")) return;
    const feats: GeoJSON.Feature[] = draft.map((p, i) => point(p, { n: String(i + 1), first: i === 0 }));
    if (draft.length > 1) feats.unshift(line(draft));
    (map.getSource("setup-draft") as GeoJSONSource).setData(fc(feats));
  }, [draft]);
  useEffect(() => {
    const map = mapRef.current; if (!map?.getSource("setup-area")) return;
    const a = mission.surveyArea;
    (map.getSource("setup-area") as GeoJSONSource).setData(fc(a ? [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...a, a[0]]] } }, ...(mission.editable ? a.map((p, i) => point(p, { n: String(i + 1) })) : [])] : []));
    (map.getSource("survey-plan") as GeoJSONSource).setData(fc([line(mission.surveyLngLat)]));
    (map.getSource("sites") as GeoJSONSource).setData(fc(siteFeatures(mission)));
    if (map.getLayer("aoi-line")) map.setLayoutProperty("aoi-line", "visibility", a ? "none" : "visible");
    const rc = mission.editable && mission.startSet && mission.destSet ? mission.routeCheck : null;
    // scenario hazards and effective building grades (flood/fire override the Copernicus grade through feature-state)
    const sp = mission.spec, k = (id: string, v: string) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", v);
    const mpp = (z: number) => (40075016.686 * Math.cos((data.meta.center[1] * Math.PI) / 180)) / (512 * 2 ** z);
    const metres = (m: number) => ["interpolate", ["exponential", 2], ["zoom"], 10, m / mpp(10), 20, m / mpp(20)] as maplibregl.ExpressionSpecification;
    const ft = sp.kind === "flood" ? mission.flood : null;
    k("hz-flood", ft ? "visible" : "none");
    const fk = ft ? `${data.meta.id}|${mission.floodKey}` : "";
    if (ft && fk !== lastFlood.current) { lastFlood.current = fk; (map.getSource("hz-flood") as maplibregl.ImageSource).updateImage({ url: floodImage(ft, mission.floodLevel, mission.floodReachFor(), mission.floodSpread), coordinates: ft.corners }); }
    k("hz-fire-glow", sp.kind === "fire" ? "visible" : "none"); k("hz-fire-core", sp.kind === "fire" ? "visible" : "none");
    if (sp.kind === "fire") { (map.getSource("hz-fire") as GeoJSONSource).setData(fc(sp.fires.map((f) => point(f)))); map.setPaintProperty("hz-fire-glow", "circle-radius", metres(sp.fireRadius)); }
    const gk = `${mission.custom}|${sp.kind}|${sp.kind === "flood" ? `${mission.floodKey}|${!!mission.flood}` : ""}|${sp.fires.length}|${sp.fireRadius}|${sp.intensity}`;
    if (gk !== lastGrades.current) { lastGrades.current = gk; data.buildings.features.forEach((f) => map.setFeatureState({ source: "buildings", id: f.properties.id }, { sg: mission.buildingGrade(f.properties.id) })); }
    const show = !mission.custom || mission.startSet;
    [markers.current.drone, markers.current.rover].forEach((mk) => { const el = mk?.getElement(); if (el) el.style.display = show ? "" : "none"; });
    (map.getSource("preview") as GeoJSONSource | undefined)?.setData(fc(rc ? rc.segs.map((sg) => line(sg.pts, { inside: sg.inside })) : []));
    markers.current.drone?.setLngLat(mission.drone.at); markers.current.rover?.setLngLat(mission.rover.at);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mission, mission.audit.length, mission.phase, mode, floodState, mission.spec.kind === "flood" ? mission.floodKey : ""]);

  // keep markers bound to the current mission after restart
  useEffect(() => { markers.current.drone?.setLngLat(mission.drone.at); markers.current.rover?.setLngLat(mission.rover.at); }, [mission]);

  const flyTo = (c: LngLat) => mapRef.current?.flyTo({ center: c, zoom: 17.4, pitch: 58, duration: 900 });
  const fitSector = () => { setFollow("none"); mapRef.current?.fitBounds(data.meta.missionBounds as [number, number, number, number], { padding: framePad(), pitch: 50, bearing: -18, duration: 900 }); };
  const restart = () => { setFollow("none"); setTab("findings"); setEpoch((e) => e + 1); };
  const exportRecord = () => {
    const blob = new Blob([JSON.stringify(mission.exportRecord(), null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `aegisloop-AOI-M1-record.json`; a.click(); URL.revokeObjectURL(a.href);
  };

  const clk = fmtClock(mission.clock);
  const c = mission.counts;
  const shown: Phase = mission.phase === "incident" || mission.replanning ? "executing" : mission.phase;
  const phaseIdx = PHASES.findIndex((p) => p.id === shown);

  return (
    <div className="cx has-rail">
      <header className="cx-top">
        <div className="cx-top-l">
          <Link to="/" className="cx-back" aria-label="Back to website"><ChevronLeft size={16} /></Link>
          <Logo size={20} />
          <span className="cx-sep" />
          <div className="cx-incident">
            <span className="cx-incident-t">{placeName} · {mode === "new" ? "New mission" : "Case replay"}</span>
            <span className="mono cx-incident-s">{mode === "new" ? `${mission.scenarioName.toUpperCase()} · YOUR AREA` : `EMSR648 · SECTOR AOI-M1 · ${fmtLatLng(data.meta.center)}`}</span>
          </div>
        </div>
        <div className="cx-top-r">
          <div className="cx-clock mono" aria-label="Replay clock">
            <span>{clk.date}</span><strong className="num">{clk.time}</strong><span>TRT</span><span className="cx-since">{fmtSince(mission.sinceEvent)}</span>
          </div>
          {!mission.live && <div className="cx-seg" role="group" aria-label="Replay speed">
            {[10, 30, 60].map((s) => <button key={s} className={mission.speed === s ? "on" : ""} onClick={() => { mission.speed = s; force(); }} aria-pressed={mission.speed === s}>×{s}</button>)}
          </div>}
          {!mission.live && <button className="cx-icon" onClick={() => { mission.paused = !mission.paused; force(); }} aria-label={mission.paused ? "Resume replay" : "Pause replay"}>{mission.paused ? <Play size={16} /> : <Pause size={16} />}</button>}
          {mission.live && <span className="cx-pill live" title="Robot motion from Gazebo physics; plans verified by the ROS 2 mission authority"><span className="cx-led" />ROS 2 · Gazebo ×{(mission.live.telemetry?.rtf ?? 0).toFixed(1)}</span>}
          <div className="cx-who" title={`Signed in as ${member.name}`}><span className={`si-av sm r-${member.id}`}>{member.name.split(" ").map((w) => w[0]).join("").slice(0, 2)}</span><span className="cx-who-n"><b>{member.name}</b><small>{member.id === "ops-commander" ? "Approver" : member.role}</small></span><button className="cx-link" onClick={onSignOut}>Sign out</button></div>
          <div className="cx-src" role="group" aria-label="Simulation source">
            <button className={source === "replay" ? "on" : ""} aria-pressed={source === "replay"} onClick={() => switchSource("replay")}>Replay</button>
            <button className={source === "gazebo" ? "on" : ""} aria-pressed={source === "gazebo"} disabled={(!liveOk?.connected && source !== "gazebo") || isOsm || (mode === "new" && mission.spec.kind !== "earthquake")}
              title={liveOk?.connected ? `Gazebo world ${liveOk.world} · nodes: ${liveOk.nodes.join(", ")}` : "Start the simulation stack (bash sim/run_live.sh) to enable"} onClick={() => switchSource("gazebo")}>
              <span className={`cx-led ${liveOk?.connected ? "" : "off"}`} />Gazebo live
            </button>
          </div>
        </div>
      </header>

      <Rail view={view} onView={(v) => setView(v)} badges={{ team: unread, plans: mission.phase === "awaiting_approval", comms: mission.phase !== "standby" && !mission.ugvLink.ok }} />

      <aside className="cx-left" aria-label="Mission and fleet">
        <section className="cx-card">
          <h2 className="cx-h">Mission</h2>
          <ol className="cx-steps">
            {PHASES.map((p, i) => (
              <li key={p.id} className={i < phaseIdx ? "done" : i === phaseIdx ? "active" : ""}>
                <span className="cx-step-i">{i < phaseIdx ? <Check size={12} /> : i + 1}</span>{p.label}{p.id === "executing" && i === phaseIdx && (mission.phase === "incident" || mission.replanning) && <span className="cx-step-warn">Re-plan</span>}{p.id === "complete" && <span className="cx-step-sub">{mission.debrief.done}/{mission.targets.length}</span>}
              </li>
            ))}
          </ol>
          {mission.noRoute && <div className="cx-alert"><AlertTriangle size={16} aria-hidden /><div><b>No verified route</b><p>{mission.noRouteReason || "No route made only of observed, passable segments."}</p><button className="sc-done sc-again" onClick={restart}>Edit scenario and fly again</button></div></div>}
          {mission.custom && mission.phase === "standby"
            ? <NewMissionSetup mission={mission} floodState={floodState} place={placeName} realPlace={!isOsm} onPickPlace={() => setPicker(true)} tool={tool} setTool={(t) => { setDraft([]); setTool(t); }} patch={patchScenario} onExit={backToExample} onReset={resetScenario} />
            : <PrimaryAction mission={mission} phase={mission.phase} onPlanTab={() => setTab("plan")} onExport={exportRecord} onRestart={restart} onNew={startNew} />}
        </section>

        <section className="cx-card">
          <h2 className="cx-h">Fleet</h2>
          <UnitCard icon={<Plane size={15} />} name={FLEET[0].name} role={`Aerial · ${mission.live ? "Gazebo odometry" : "replay model"}`} s={mission.drone} extra={mission.drone.alt ? `${mission.drone.alt} m AGL` : "On pad"} onLocate={() => flyTo(mission.drone.at)} following={follow === "drone"} onFollow={() => setFollow(follow === "drone" ? "none" : "drone")} />
          <UnitCard icon={<Truck size={15} />} name={FLEET[1].name} role={`Ground · ${mission.live ? "Gazebo odometry" : "replay model"}`} s={mission.rover} extra={mission.phase === "executing" ? "Autonomous" : "Idle"} link={mission.ugvLink} onLocate={() => flyTo(mission.rover.at)} following={follow === "rover"} onFollow={() => setFollow(follow === "rover" ? "none" : "rover")} />
        </section>
      </aside>

      <main className="cx-map">
        <CaseMap data={data} fogOfWar controls scene={scene} onReady={onReady} view={{ zoom: 16, pitch: 52, bearing: -18 }} label="Operations map of sector AOI-M1" />
        {mission.custom && mission.editable && (
          <div className="sc-bar" role="toolbar" aria-label="New mission tools">
            <div className="sc-tools">
              {([["select", MousePointer2, "Select"], ["area", Hexagon, "Mark area"], ["start", Truck, "Rover"], ["dest", Flag, "Destination"], ...(mission.spec.kind === "fire" ? [["fire", Flame, "Fire"]] : [])] as [Tool, typeof Flag, string][]).map(([id, Icon, label]) => (
                <button key={id} className={tool === id ? "on" : ""} aria-pressed={tool === id} onClick={() => { setDraft([]); setTool(id); }}><Icon size={15} aria-hidden />{label}</button>
              ))}
              <span className="sc-sep" />
              <button onClick={resetScenario} title="Clear this mission"><RotateCcw size={15} aria-hidden />Clear</button>
            </div>
            <div className={`sc-hint ${notice ? "err" : ""}`}>
              {notice ?? (tool === "area" ? (draft.length < 3 ? `Click on the map to mark the corners of your area (${draft.length} so far, at least 3).` : <>Click the first dot, double-click or press Enter to close · Backspace removes the last dot <button className="sc-done" onClick={() => finishArea(draft)}>Finish area</button></>)
                : tool === "start" ? "Click a street inside your area where the rover starts. The drone takes off from the same point."
                : tool === "dest" ? "Click inside your area where the rover must go."
                : tool === "fire" ? "Click inside your area to start a fire. Click again to add more."
                : mission.canLaunch ? "Ready. Press Authorise aerial survey on the left." : "Follow the steps on the left.")}
            </div>
          </div>
        )}
        <div className="cx-map-tools">
          {data.tiles && <div className="cx-seg2" role="group" aria-label="Imagery date">
            <button className={scene === "pre" ? "on" : ""} aria-pressed={scene === "pre"} onClick={() => setScene("pre")}><Layers size={14} />Before · Dec 2022</button>
            <button className={scene === "post" ? "on" : ""} aria-pressed={scene === "post"} onClick={() => setScene("post")}>After · Feb 2023</button>
          </div>}
          <button className="cx-tool" onClick={fitSector}><Crosshair size={14} />Sector</button>
        </div>
        <div className="cx-legend">
          <div className="cx-legend-row"><span className="sw sw-unv" />Not yet verified</div>
          {([3, 2, 1] as const).map((g) => <div key={g} className="cx-legend-row"><span className="sw" style={{ background: GRADE_COLOR[g] }} />{GRADE_LABEL[g]}</div>)}
          <div className="cx-legend-row"><span className="sw sw-route" />Verified route</div>
          <div className="cx-legend-row"><span className="sw sw-direct" />Direct route (rejected)</div>
          <div className="cx-legend-row"><span className="sw sw-alt" />Alternative verified route</div>
          <div className="cx-legend-row"><span className="sw sw-link" />Command link to UGV-1 (modelled)</div>
          {mission.spec.kind === "flood" && <div className="cx-legend-row cx-legend-flood"><span className="sw sw-flood" />Floodwater: shallow → deep (now +{mission.floodLevel.toFixed(2)} m, spread {mission.floodSpread} m) · over 20 cm stops the Husky</div>}
          <div className="cx-legend-row cx-legend-note">3D robots drawn enlarged to stay visible (Husky ≈ 1 m long)</div>
          <div className="cx-legend-src"><span className="prov real">Real</span> {isOsm ? "OpenStreetMap buildings, roads, rivers" : mission.custom && mission.spec.kind !== "earthquake" ? "Maxar imagery · OSM roads · Asi river" : "Maxar imagery · Copernicus grades · OSM roads"} <span className="prov sim">Simulated</span> {isOsm || (mission.custom && mission.spec.kind !== "earthquake") ? `${mission.spec.kind === "earthquake" ? "earthquake damage" : mission.spec.kind} · robots` : mission.live ? "Gazebo robots · obstruction" : "robots · obstruction"}</div>
        </div>
      </main>

      <aside className="cx-right" aria-label="Findings, plan and record">
        <div className="cx-right-card">
        <div className="cx-tabs" role="tablist">
          {(["findings", "plan", "record", "team"] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {t === "findings" ? `Findings ${mission.findings.length ? `· ${mission.findings.length}` : ""}` : t === "plan" ? "Plan" : t === "team" ? "Team" : `Record · ${mission.audit.length}`}
              {t === "team" && unread > 0 && tab !== "team" && <span className="cx-badge" aria-label={`${unread} unread`}>{unread}</span>}
              {t === "plan" && mission.phase === "awaiting_approval" && <span className="cx-dot" aria-label="needs approval" />}
            </button>
          ))}
        </div>
        <div className="cx-tabbody">
          {tab === "findings" && (
            <>
              <p className="cx-prov-note">Detections are modelled: the Copernicus grade of anything inside UAV-1's camera footprint{mission.live ? `, computed from Gazebo drone odometry (${mission.coverageCells} coverage cells)` : ""}. Routes may only use segments the camera has seen.</p>
              <div className="cx-kpis">
                <Kpi label="Verified" value={`${c.verified}/${c.total}`} />
                <Kpi label="Destroyed" value={c.destroyed} tone="g3" />
                <Kpi label="Damaged" value={c.damaged} tone="g2" />
                <Kpi label="Road hazards" value={c.roads} />
              </div>
              {mission.findings.length === 0 ? (
                <p className="cx-empty">No findings yet. Findings appear as the aerial survey covers the sector; structures outside camera coverage stay unverified.</p>
              ) : (
                <ul className="cx-list">
                  {mission.findings.map((f) => <FindingRow key={f.id + f.t} f={f} onClick={() => flyTo(f.at)} />)}
                </ul>
              )}
            </>
          )}
          {tab === "plan" && <PlanView mission={mission} member={member} onTeam={() => setTab("team")} onCard={() => setCard(true)} />}
          {view !== "team" && <TeamChat active={tab === "team"} onUnread={setUnread} />}
          {tab === "record" && (
            <ul className="cx-audit">
              {[...mission.audit].reverse().map((a, i) => (
                <li key={i}>
                  <div className="cx-audit-h"><span className="mono">{fmtSince(mission.sinceEvent - (mission.t - a.t))}</span><span className="cx-actor mono">{a.actor}</span></div>
                  <div className="cx-audit-a">{a.action}</div>
                  <div className="cx-audit-d">{a.detail}</div>
                  {a.hash && <div className="cx-hash mono" title={a.hash}>sha256 {a.hash.slice(0, 16)}…</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
        </div>
      </aside>
      {card && mission.plan && <RouteCard mission={mission} data={data} onClose={() => setCard(false)} />}
      {picker && <PlacePicker current={placeName} onClose={() => setPicker(false)}
        onAntakya={() => { setPicker(false); if (isOsm) onPlace(null); }}
        onLoaded={(d) => { setPicker(false); onPlace(d); }} />}
      {view === "feed" && <UavFeed mission={mission} data={data} active />}
      {view === "damage" && <DamagePage mission={mission} data={data} onLocate={(at) => { setView("ops"); setTimeout(() => flyTo(at), 50); }} />}
      {view === "plans" && <PlansPage mission={mission} />}
      {view === "sitrep" && <SitrepPage mission={mission} data={data} />}
      {view === "comms" && <CommsPage mission={mission} />}
      {view === "record" && <RecordPage mission={mission} onExport={exportRecord} />}
      {view === "team" && <div className="cx-team-page"><div className="cx-team-inner"><TeamChat active onUnread={setUnread} /></div></div>}
    </div>
  );
}

function PrimaryAction({ mission, phase, onPlanTab, onExport, onRestart, onNew }: { mission: Mission; phase: Phase; onPlanTab: () => void; onExport: () => void; onRestart: () => void; onNew: () => void }) {
  const tg = mission.target;
  if (phase === "standby") return (
    <div className="cx-action">
      <p>Example: survey pattern {(mission.surveyPath.length / 1000).toFixed(2)} km · est. {fmtDur(mission.surveyDuration)} of {FLEET[0].headline[1][1]} endurance.</p>
      <button className="btn btn-accent cx-btn" onClick={() => mission.launchSurvey()}><Plane size={16} />Authorise aerial survey</button>
      <div className="sc-new">
        <div><b>Your own mission</b><p>Mark an area on the map, place the rover and its destination, pick earthquake, flood or fire.</p></div>
        <button className="btn btn-ghost cx-btn" onClick={onNew}><Plus size={16} />New mission</button>
      </div>
    </div>
  );
  if (phase === "survey") return <Progress label="Aerial survey in progress" value={mission.surveyProgress} />;
  if (phase === "review") return (
    <div className="cx-action">
      <p>{mission.ti === 0 ? `Survey complete. Target ${tg.label} is the largest verified collapse reachable from staging.` : `Next target ${tg.label}. The route starts from the rover's current position.`}</p>
      <button className="btn btn-accent cx-btn" onClick={() => void mission.generatePlan()}><FileCheck2 size={16} />Generate route plan · {tg.label}</button>
    </div>
  );
  if (phase === "incident") return (
    <div className="cx-alert"><AlertTriangle size={16} aria-hidden /><div><b>Obstruction reported</b><p>UAV-1 sees debris on the route. UGV-1 is holding; the planner is re-routing.</p></div></div>
  );
  if (phase === "awaiting_approval") return mission.plan?.replan ? (
    <div className="cx-action">
      <div className="cx-alert"><AlertTriangle size={16} aria-hidden /><div><b>{mission.plan.id} needs re-approval</b><p>Debris on {mission.incident?.road}. UGV-1 is holding at the last verified junction.</p></div></div>
      <button className="btn btn-accent cx-btn" onClick={onPlanTab}><ShieldCheck size={16} />Review re-plan</button>
    </div>
  ) : (
    <div className="cx-action">
      <p>Plan {mission.plan?.id} is waiting for Ops Commander approval.</p>
      <button className="btn btn-ghost cx-btn" onClick={onPlanTab}><ShieldCheck size={16} />Review plan</button>
    </div>
  );
  if (phase === "executing") return <Progress label={`Husky en route to ${tg.label}`} value={mission.execProgress} />;
  if (phase === "on_site") return <Progress label={`Thermal and acoustic sweep · ${tg.label}`} value={mission.siteProgress} />;
  const d = mission.debrief, left = mission.remainingTargets;
  return (
    <div className="cx-action">
      <div className="cx-debrief">
        <div className="cx-debrief-h"><Check size={14} aria-hidden />{left ? `${tg.label} closed` : "Mission complete"}</div>
        <dl>
          <div><dt>Sites</dt><dd>{d.done}/{d.targets}</dd></div>
          <div><dt>Driven</dt><dd>{Math.round(d.driven)} m</dd></div>
          <div><dt>Plans</dt><dd>{d.plans}</dd></div>
          <div><dt>Incidents</dt><dd>{d.incidents}</dd></div>
          <div><dt>Signals</dt><dd>{d.signals}</dd></div>
          <div><dt>Elapsed</dt><dd>{fmtDur(d.elapsed)}</dd></div>
        </dl>
      </div>
      {left > 0 && <button className="btn btn-accent cx-btn" onClick={() => mission.nextTarget()}><ArrowRight size={16} />Next target · {mission.targets.find((t) => !t.done)?.label}</button>}
      <div className="cx-btnrow">
        <button className={`btn ${left ? "btn-ghost" : "btn-primary"} cx-btn`} onClick={onExport}><Download size={16} />Export record</button>
        <button className="btn btn-ghost cx-btn cx-btn-icon" onClick={onRestart} aria-label="Restart replay"><RotateCcw size={16} /></button>
      </div>
    </div>
  );
}

const KINDS: { id: ScenarioKind; label: string; icon: typeof Flag; note: string }[] = [
  { id: "earthquake", label: "Earthquake", icon: AlertTriangle, note: "Real Copernicus damage, 13 Feb 2023" },
  { id: "flood", label: "Flood", icon: Waves, note: "Asi river overflows its banks (simulated)" },
  { id: "fire", label: "Fire", icon: Flame, note: "Fires you place on the map (simulated)" },
];
/** One numbered step of the new-mission setup (top level so inputs keep focus while the mission updates). */
function NmStep({ n, done, active, title, children, action }: { n: number; done: boolean; active: boolean; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <li className={`nm-step ${done ? "done" : ""} ${active ? "active" : ""}`}>
      <span className="nm-n">{done ? <Check size={12} /> : n}</span>
      <div className="nm-b"><div className="nm-h"><b>{title}</b>{action}</div>{children}</div>
    </li>
  );
}
/** Step-by-step setup for a new mission. Everything happens on the operations map. */
function NewMissionSetup({ mission, floodState, place, realPlace, onPickPlace, tool, setTool, patch, onExit, onReset }: { mission: Mission; floodState: string; place: string; realPlace: boolean; onPickPlace: () => void; tool: string; setTool: (t: "select" | "area" | "start" | "dest" | "fire") => void; patch: (p: Partial<ScenarioSpec>) => void; onExit: () => void; onReset: () => void }) {
  const sp = mission.surveyPlan, rd = mission.ready, spec = mission.spec, tg = mission.target;
  const rc = rd.start && rd.dest ? mission.routeCheck : null;
  const btn = (t: "area" | "start" | "dest" | "fire", label: string) => <button className={`nm-btn ${tool === t ? "on" : ""}`} onClick={() => setTool(t)}>{tool === t ? "Click on the map…" : label}</button>;
  return (
    <div className="cx-action nm">
      <div className="nm-top"><span className="chip">New mission</span><button className="cx-link" onClick={onExit}>← Back to the example</button></div>
      <ol className="nm-steps">
        <NmStep n={0} done active={false} title="Place" action={<button className="nm-btn" onClick={onPickPlace}>Change</button>}>
          <small><b className="nm-place">{place}</b> · {realPlace ? "real damage data (Copernicus)" : "real streets from OpenStreetMap · damage simulated"}</small>
        </NmStep>
        <NmStep n={1} done active={false} title="Scenario">
          <div className="nm-kinds" role="radiogroup" aria-label="Scenario">
            {KINDS.map(({ id, label, icon: Icon }) => <button key={id} role="radio" aria-checked={spec.kind === id} className={spec.kind === id ? "on" : ""} onClick={() => patch({ kind: id })}><Icon size={14} aria-hidden />{label}</button>)}
          </div>
          <small>{spec.kind === "earthquake" && !realPlace ? "Simulated damage · taller buildings fail more often · debris blocks nearby streets" : spec.kind === "flood" ? "The river overflows; water spreads over low ground (elevation model, simulated)" : KINDS.find((k) => k.id === spec.kind)!.note}</small>
          {spec.kind === "earthquake" && !realPlace && <div className="nm-kinds nm-int" role="radiogroup" aria-label="Strength">{([1, 2, 3] as const).map((i) => <button key={i} role="radio" aria-checked={spec.intensity === i} className={spec.intensity === i ? "on" : ""} onClick={() => patch({ intensity: i })}>{INTENSITY_LABEL[i]}</button>)}</div>}
          {spec.kind === "flood" && <>
            <label className="nm-range">Peak water above the riverbank <b>+{spec.floodRise} m</b><input type="range" min={0.5} max={4} step={0.5} value={spec.floodRise} onChange={(e) => patch({ floodRise: +e.target.value })} /></label>
            <small>{floodState === "loading" ? "Loading terrain elevation…" : floodState === "nowater" ? "No river or lake is mapped here: pick a place with water." : floodState === "error" ? "Terrain could not be loaded. Check the connection and try again." : `Water follows the real terrain: it leaves the river at +${(spec.floodRise * 0.4).toFixed(1)} m, spreads into low streets and rises to +${spec.floodRise} m over ${FLOOD_RAMP / 60} min. Roads deeper than ${HUSKY_WADE * 100} cm stop the Husky; ${CAUTION * 100}–${HUSKY_WADE * 100} cm is caution.`}</small>
          </>}
          {spec.kind === "fire" && <>
            <label className="nm-range">Fire radius <b>{spec.fireRadius} m</b><input type="range" min={30} max={150} step={5} value={spec.fireRadius} onChange={(e) => patch({ fireRadius: +e.target.value })} /></label>
            <div className="nm-row"><small>{spec.fires.length} fire{spec.fires.length === 1 ? "" : "s"} placed</small>{rd.area && btn("fire", "Place fire")}{spec.fires.length > 0 && <button className="cx-link" onClick={() => patch({ fires: [] })}>Clear fires</button>}</div>
          </>}
        </NmStep>
        <NmStep n={2} done={rd.area} active={!rd.area} title="Mark the area" action={btn("area", rd.area ? "Redraw" : "Mark area")}>
          {rd.area ? <small>{(sp.area / 1e6).toFixed(2)} km² · drone flight {fmtDur(sp.duration)} · <b className={sp.ok ? "" : "bad"}>{Math.round(sp.battery * 100)}% battery</b></small>
            : <small>Click dots around the place to search. The drone and rover stay inside it.</small>}
          {rd.area && !sp.ok && <small className="bad">{sp.reason}</small>}
        </NmStep>
        <NmStep n={3} done={rd.start} active={rd.area && !rd.start} title="Place the rover" action={rd.area ? btn("start", rd.start ? "Move" : "Place") : undefined}>
          <small>{rd.start ? `${mission.placeName(mission.staging.node)} · the drone takes off here too` : "A street inside your area."}</small>
        </NmStep>
        <NmStep n={4} done={rd.dest} active={rd.start && !rd.dest} title="Set the destination" action={rd.start ? btn("dest", rd.dest ? "Move" : "Place") : undefined}>
          <small>{rd.dest && tg ? `${tg.label} · ${mission.placeName(tg.node)}` : "Where the rover must go, inside your area."}</small>
        </NmStep>
      </ol>
      {rc && <div className={`sc-check ${rc.ok ? "ok" : rc.route ? "warn" : "bad"}`}><b>{rc.ok ? "Route check: likely passable" : rc.route ? "Route check: extend the area" : "Route check: no passable road"}</b><p>{rc.message}</p><small>{spec.kind === "earthquake" && realPlace ? "Based on Copernicus grading (13 Feb 2023)." : "Based on the simulated hazard."} The drone confirms it in flight.</small></div>}
      <button className="btn btn-accent cx-btn" disabled={!mission.canLaunch} onClick={() => mission.launchSurvey()}><Plane size={16} />Authorise aerial survey</button>
      <div className="nm-foot"><span>{mission.scenarioName}</span><button className="cx-link" onClick={onReset}>Clear all</button></div>
    </div>
  );
}

function Progress({ label, value, indeterminate }: { label: string; value: number; indeterminate?: boolean }) {
  return (
    <div className="cx-action">
      <div className="cx-prog-h"><span>{label}</span>{!indeterminate && <span className="mono num">{Math.round(value * 100)}%</span>}</div>
      <div className={`cx-prog ${indeterminate ? "ind" : ""}`} role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${value * 100}%` }} /></div>
    </div>
  );
}

function UnitCard({ icon, name, role, s, extra, link, onLocate, onFollow, following }: { icon: React.ReactNode; name: string; role: string; s: Mission["drone"]; extra: string; link?: UgvLink; onLocate: () => void; onFollow: () => void; following: boolean }) {
  const pct = Math.max(0, Math.round(s.battery * 100));
  return (
    <div className="cx-unit">
      <div className="cx-unit-h">
        <span className="cx-unit-i">{icon}</span>
        <div><div className="cx-unit-n">{name}</div><div className="cx-unit-r">{role}</div></div>
        <button className="cx-icon sm" onClick={onLocate} aria-label={`Locate ${name}`}><Crosshair size={14} /></button>
      </div>
      <div className="cx-unit-s">{s.status}</div>
      {link && <div className={`cx-unit-link ${link.ok ? link.via : "lost"}`}><span className="cx-led" />{link.via === "direct" ? "Command link · direct" : link.via === "relay" ? "Command link · via UAV-1 relay" : "No command link · fail-safe hold"}</div>}
      <div className="cx-bat"><span className={pct < 30 ? "low" : ""} style={{ width: `${pct}%` }} /></div>
      <dl className="cx-unit-kv mono">
        <div><dt>BAT</dt><dd className="num">{pct}%</dd></div>
        <div><dt>SPD</dt><dd className="num">{s.speed.toFixed(1)} m/s</dd></div>
        <div><dt>{s.alt !== undefined ? "ALT" : "MODE"}</dt><dd>{extra}</dd></div>
      </dl>
      <div className="cx-unit-f">
        <span className="mono">{fmtLatLng(s.at)}</span>
        <button className={`cx-link ${following ? "on" : ""}`} onClick={onFollow} aria-pressed={following}>{following ? "Following" : "Follow"}</button>
      </div>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string | number; tone?: "g3" | "g2" }) {
  return <div className="cx-kpi"><span className={`cx-kpi-v num ${tone ?? ""}`}>{value}</span><span className="cx-kpi-l">{label}</span></div>;
}

const KIND_ICON = { collapse: AlertTriangle, damaged: AlertTriangle, road: AlertTriangle, barrier: AlertTriangle, camp: Users, incident: AlertTriangle, signal: Users };
function FindingRow({ f, onClick }: { f: Finding; onClick: () => void }) {
  const Icon = KIND_ICON[f.kind];
  return (
    <li>
      <button className={`cx-finding k-${f.kind}`} onClick={onClick}>
        <Icon size={14} aria-hidden />
        <div className="cx-finding-b">
          <div className="cx-finding-t">{f.title}</div>
          <div className="cx-finding-d">{f.detail}</div>
          <div className="cx-finding-c mono">{fmtLatLng(f.at)}</div>
        </div>
      </button>
    </li>
  );
}

const CHECK_LABEL: Record<string, string> = { on_network: "Road network", passable: "Passable", observed: "Observed by UAV-1", role: "Approver", current: "Latest version", world: "World version", bound: "Hash binding", known: "Registered" };
function Checks({ checks, title }: { checks: Record<string, AuthCheck>; title: string }) {
  return (
    <div className="cx-checks">
      <div className="cx-checks-h">{title}</div>
      <ul>{Object.entries(checks).map(([k, c]) => (
        <li key={k} className={c.ok ? "ok" : "bad"}>{c.ok ? <Check size={12} aria-label="pass" /> : <XIcon size={12} aria-label="fail" />}<span><b>{CHECK_LABEL[k] ?? k}</b> · {c.detail}</span></li>
      ))}</ul>
    </div>
  );
}

function PlanView({ mission, member, onTeam, onCard }: { mission: Mission; member: TeamMember | null; onTeam: () => void; onCard: () => void }) {
  const [busy, setBusy] = useState(false);
  const [reuse, setReuse] = useState<{ id: string; res: ApproveResult } | null>(null);
  const canApprove = !member || member.id === "ops-commander";
  const who = member?.name ?? OPERATOR;
  const plan = mission.plan;
  if (!plan) return <p className="cx-empty">No plan yet. Plans are generated only from verified survey findings: complete the aerial survey, then generate a route plan for the ground unit.</p>;
  const approved = mission.approvedHash === plan.hash;
  const older = mission.live && mission.plans.length > 1 ? mission.plans[mission.plans.length - 2] : null;
  const doApprove = async () => { setBusy(true); try { await mission.approve(who, member?.id ?? "ops-commander"); } finally { setBusy(false); } };
  const doReuse = async () => { if (!older) return; setBusy(true); try { const res = await mission.retryApproval(older); if (res) setReuse({ id: older.id, res }); } finally { setBusy(false); } };
  return (
    <div className="cx-plan">
      <div className="cx-plan-h">
        <div><span className="mono">{plan.id} · v{plan.version}{plan.replan ? " · re-plan" : ""}{plan.authority ? ` · world v${plan.authority.worldVersion}` : ""}</span><h3>Husky A300 → {plan.target.startsWith("T-") ? "destination" : "collapse site"} {plan.target}</h3></div>
        <span className={`chip ${approved ? "chip-ok" : "chip-warn"}`}>{approved ? "Approved" : "Awaiting approval"}</span>
      </div>
      {plan.replan && mission.incident && <div className="cx-alert"><AlertTriangle size={16} aria-hidden /><div><b>Re-plan after incident</b><p>UAV-1 reported debris on {mission.incident.road}. {mission.incident.planId} is blocked; UGV-1 is holding.</p></div></div>}
      {plan.options.map((o) => {
        const auth = plan.authority?.options[o.id], chosen = o.id === plan.chosen, c = o.comms;
        return (
          <div key={o.id} className={`cx-opt ${o.eligible ? "ok" : "bad"} ${chosen ? "chosen" : ""}`}>
            <div className="cx-opt-h"><span>{o.label}</span>
              <span className="sc-chips">{o.recommended && <span className="chip chip-ok">Recommended</span>}{chosen && !o.recommended && <span className="chip chip-warn">Selected</span>}{!o.eligible && <span className="chip chip-bad">Rejected</span>}</span></div>
            <dl className="cx-opt-kv">
              <div><dt>Distance</dt><dd className="mono num">{Math.round(o.route.length)} m</dd></div>
              <div><dt>ETA at 1.0 m/s</dt><dd className="mono num">{fmtDur(o.eta)}</dd></div>
              {o.eligible ? <div><dt>Collapses within 12 m</dt><dd className={`mono num ${o.risk ? "warn" : ""}`}>{o.risk ?? o.hazardsNear}</dd></div>
                : <div><dt>Impassable / unseen</dt><dd className="mono num bad">{o.blocked}</dd></div>}
              {c ? <div><dt>Needs UAV-1 relay</dt><dd className={`mono num ${c.relay > 1 ? "warn" : ""}`}>{Math.round(c.relay)} m</dd></div> : <div><dt>Collapses within 6 m</dt><dd className="mono num">{o.hazardsNear}</dd></div>}
            </dl>
            {c && <div className="sc-comms" aria-label="Radio coverage along the route"><span style={{ flex: c.direct }} className="d" /><span style={{ flex: c.relay }} className="r" /><span style={{ flex: c.nolink }} className="n" /></div>}
            <p className="cx-opt-r">{o.reason}</p>
            {c && c.relay > 1 && <p className="cx-note"><RadioTower size={12} aria-hidden /> UAV-1 must hold relay overwatch for {fmtDur(c.relayTime)}{c.relayTime > 18 * 60 * 0.75 ? " · longer than one battery: plan a swap" : ""}. If the relay drops, UGV-1 stops (fail-safe).</p>}
            {o.eligible && !chosen && mission.phase === "awaiting_approval" && <button className="btn btn-ghost cx-btn sc-use" disabled={busy} onClick={async () => { setBusy(true); try { await mission.chooseOption(o.id); } finally { setBusy(false); } }}>Use this route instead</button>}
            {auth && <Checks checks={auth.checks} title="Mission authority · ROS 2" />}
          </div>
        );
      })}
      {plan.options.some((o) => o.score !== undefined) && <p className="cx-note">Ranking = drive time + {90} s per collapsed structure within 12 m + 0.4 s per metre that depends on the relay. Only observed, passable roads are eligible.</p>}
      <button className="btn btn-ghost cx-btn rc-open" onClick={onCard}><FileCheck2 size={16} />Route card · PDF for responders</button>
      <div className="cx-hashbox">
        <div className="cx-hashbox-l">Plan hash (sha256){plan.authority ? " · issued by the mission authority" : " · computed in the browser (replay)"}</div>
        <div className="mono cx-hashbox-v">{plan.hash}</div>
      </div>
      {plan.rejected && <div className="cx-alert"><XIcon size={16} aria-hidden /><div><b>The authority rejected this approval</b><p>{Object.values(plan.rejected).filter((c) => !c.ok).map((c) => c.detail).join(" · ")}</p></div></div>}
      {mission.phase === "awaiting_approval" ? (
        <>
          <button className="btn btn-accent cx-btn" disabled={!canApprove || busy} onClick={doApprove}><ShieldCheck size={16} />{busy ? "Verifying with the authority…" : `Approve ${plan.id} as ${who}`}</button>
          {!canApprove && <p className="cx-note warn">Only the Ops Commander can approve. You are signed in as {member!.name}; ask in the <button className="cx-inline" onClick={onTeam}>team channel</button>.</p>}
          <p className="cx-note">{mission.live ? "The ROS 2 mission authority re-checks the route against UAV-1's real coverage, the current world version and this hash before UGV-1 receives the goal." : "Approval is bound to this exact hash. Authority checks run in Gazebo live mode."}</p>
        </>
      ) : approved ? (
        <>
          <p className="cx-note">Approved by {mission.approvedBy ?? OPERATOR}.{mission.live ? " Verified by the mission authority and dispatched to /ugv/follow_path." : ""}</p>
          {mission.phase === "executing" && !mission.ugvLink.ok && <div className="cx-alert warn-link"><AlertTriangle size={16} aria-hidden /><div><b>Waiting for a command link</b><p>UGV-1 is out of direct ground range and the UAV-1 relay is not up (the drone may be swapping its battery). UGV-1 holds and starts by itself when a link returns. See the Comms page.</p></div></div>}
          {plan.approval && <Checks checks={plan.approval} title="Authority verification at approval" />}
        </>
      ) : null}
      {older && (
        <div className="cx-test">
          <div className="cx-checks-h">Verification test</div>
          <p className="cx-note">Try to execute the earlier plan with its original approval. The authority must refuse it.</p>
          <button className="btn btn-ghost cx-btn" disabled={busy} onClick={doReuse}>Re-use {older.id} approval</button>
          {reuse && <Checks checks={reuse.res.checks} title={`${reuse.id}: ${reuse.res.ok ? "ACCEPTED (unexpected)" : "rejected by the authority"}`} />}
        </div>
      )}
    </div>
  );
}

function unitEl(kind: "drone" | "rover") {
  const el = document.createElement("div");
  el.className = `cx-unit-marker ${kind}`;
  el.innerHTML = kind === "drone"
    ? `<svg class="sym" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true"><path d="M24 24 L15 4 A21 21 0 0 1 33 4 Z" fill="rgba(26,47,251,0.28)"/><circle cx="24" cy="24" r="6.5" fill="#1a2ffb" stroke="#fff" stroke-width="2.2"/></svg><span class="tag">UAV-1</span>`
    : `<svg class="sym" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true"><path d="M24 24 V9" stroke="#fff" stroke-width="2" stroke-linecap="round"/><rect x="18" y="18" width="12" height="12" rx="2.5" fill="#0b0c10" stroke="#fff" stroke-width="2"/></svg><span class="tag">UGV-1</span>`;
  return el;
}

function buildingHtml(p: BuildingProps, verified: boolean) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  const grade = verified ? GRADE_LABEL[p.g] : "Not yet verified";
  const color = verified ? GRADE_COLOR[p.g] : "#5d6672";
  const h = p.g === 3 ? `${p.h0} m pre-event · rubble now` : `${p.h0} m`;
  return `<div class="cx-pop"><div class="cx-pop-g"><span style="background:${color}"></span>${grade}</div>
    ${p.n ? `<div class="cx-pop-n">${esc(p.n)}</div>` : ""}
    <dl><div><dt>Height</dt><dd>${h}${p.est ? " (est.)" : " (OSM)"}</dd></div><div><dt>Footprint</dt><dd>${p.a.toLocaleString("en-US")} m²</dd></div>
    <div><dt>Geometry</dt><dd>${p.k === "block" ? "Copernicus block" : "OSM building"}</dd></div></dl></div>`;
}

/** Turns audit entries into short mission-channel messages. */
function missionEvent(action: string, detail: string, actor: string, hash?: string): { kind: string; text: string } | null {
  const h = hash ? ` · sha256 ${hash.slice(0, 12)}…` : "";
  if (action.startsWith("Arrived at ")) return { kind: "arrived", text: `Husky A300 arrived at collapse site ${action.slice(11)}. ${detail}` };
  switch (action) {
    case "Survey authorised": return { kind: "survey_started", text: `Survey started by ${actor}. ${detail}` };
    case "Survey complete": return { kind: "survey_complete", text: `Survey complete. ${detail}` };
    case "Plan proposed": return { kind: "plan_proposed", text: `Plan proposed: ${detail}${h}. Awaiting Ops Commander approval.` };
    case "Obstruction detected": return { kind: "incident", text: `INCIDENT (simulated): ${detail}. UGV-1 holding.` };
    case "Re-plan proposed": return { kind: "plan_proposed", text: `Re-plan: ${detail}${h}. Ops Commander approval required before UGV-1 moves.` };
    case "Next target": return { kind: "target_next", text: `Next target: ${detail}.` };
    case "Plan approved": return { kind: "plan_approved", text: `${detail.split(" bound")[0]} approved by ${actor}${h}. Husky A300 dispatched.` };
    case "Inspection complete": return { kind: "inspection_complete", text: `Inspection complete: ${detail}` };
    case "Mission record sealed": return { kind: "record_sealed", text: `Mission record sealed. ${detail}${h}` };
    default: return null;
  }
}

function siteFeatures(m: Mission): GeoJSON.Feature[] {
  return [point(m.staging.at, { k: "staging", label: "STAGING" }),
    ...m.targets.map((t, i) => point(t.at, { k: t.done ? "done" : i === m.ti ? "target" : "next", label: `${t.label}${i === m.ti && !t.done ? (t.label.startsWith("T-") ? "  DESTINATION" : "  COLLAPSE") : t.done ? "  CLOSED" : ""}` }))];
}
