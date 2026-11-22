# AegisLoop Platform

Product website and operations console for AegisLoop, built around a real-location case replay:
**Antakya, Hatay — 6 February 2023 earthquake** (Copernicus EMS activation EMSR648, AOI11).

Geography and damage are real public data. Robots, missions and signals of interest are simulated.

## Run

```bash
npm install
npm start          # web app on http://localhost:5180 + Nexconn chat server on :8787
npm run dev        # web app only
npm run build      # static build in dist/
```

Pages: `/` overview · `/platform` · `/cases/antakya-2023` · `/fleet` · `/responsible-use` · `/console` operations console.
The website has a light/dark theme toggle (the console keeps its own light theme).

Copy `.env.example` to `.env` and fill in the Nexconn keys and one access code per team member.

## Sign-in

The console asks for sign-in every time it opens. Five team members (Ops Commander, Field Lead, UAV Pilot, UGV Operator,
Medical Liaison) each have a personal access code (`AEGIS_CODE_<ROLE>`), checked on the server and never sent to the browser.
A correct code returns a signed 12-hour session; Nexconn chat tokens and bot events require it. Only the Ops Commander can
approve plans.

## Deploy (Render, free)

`render.yaml` defines one web service: `npm run build`, then `node server/nexconn-server.mjs`, which serves `dist/` and the API.
In the Render dashboard: New → Blueprint → this repository, then enter `NEXCONN_APP_KEY`, `NEXCONN_APP_SECRET` and the five
`AEGIS_CODE_*` values (the session secret is generated). Gazebo live mode is local only (the button stays disabled online).

## Operations console

| Page | What it does |
|---|---|
| Operations | Map of the mission: survey, findings, routes, approval, execution. Real 3D X500 and Husky models (drawn at a constant screen size), blue camera beam |
| UAV-1 feed | Nadir camera view with severity overlays (needs Maxar imagery: Antakya only) |
| Situation | Tactical known-map, extraction sequence, fleet table, advisories; Save as PDF |
| Damage | Everything UAV-1 has verified, by severity |
| Plans | Every plan version, authority checks, approvals |
| Comms | Modelled link budget (command post, UAV-1 relay, UGV-1), link-loss tests, fail-safe hold |
| Team | Nexconn mission channel (5 roles, bot posts mission events) |
| Record | Append-only mission record, JSON export |

**Antakya example.** The guided replay of sector AOI-M1, unchanged.

**New mission.** On the same map: pick a place and a scenario, mark the area with dots, place the rover and its
destination, launch. The drone flies only inside the area, findings come only from it, and the rover's routes never leave it.
- Places: the Antakya case (real Copernicus damage, Maxar imagery) or **any city** searched by name: real buildings, roads and
  water from OpenStreetMap (Overpass API, ~1.2 × 1.2 km), Sentinel-2 imagery, damage simulated.
- Scenarios: earthquake (real grades in Antakya; simulated moderate/strong/severe elsewhere, debris blocks nearby streets),
  flood (terrain model: water rises from the real river over free elevation data, fills connected low ground, spreads
  outward and keeps rising for 20 min; roads deeper than 20 cm stop the Husky), fire (fires placed on the map).
- Before launch a route check says whether a passable road likely exists inside the area.

**Best path.** Up to four verified routes are compared (fastest, lowest collapse exposure, best radio coverage, alternative
corridor) and ranked by drive time + exposure + dependence on the UAV-1 relay. The operator can pick another eligible route,
which becomes a new plan version. Only observed, passable segments are eligible ("unknown is impassable").

**Route card.** One A4 page for responders (Plan tab → Route card → Save as PDF): satellite map with numbered turns, hazards and
relay stretches, turn-by-turn directions with street names, distance/ETA/relay, route rules, plan hash and approval;
stamped NOT APPROVED until the Ops Commander approves.

## Data pipeline

```bash
npm run data       # tools/build-antakya.mjs  -> public/data/antakya/*
~/aegis_geo_venv/bin/python tools/tile-imagery.py   # Maxar mosaic -> public/data/antakya/tiles (sources in ~/aegis_maxar)
npm run gazebo     # tools/export-gazebo.mjs  -> sim/worlds/antakya_aoi_m1.sdf (+ OBJ meshes)
bash sim/run_antakya.sh   # in WSL: open the case world in Gazebo Harmonic
```

| Source | Used for | Licence |
|---|---|---|
| Copernicus EMS EMSR648 AOI11, Grading Monitoring 01 (13 Feb 2023), `data-src/copernicus-emsr648-aoi11/` | Building-block and road damage grades, spontaneous sites, road barriers | © European Union, Copernicus EMS |
| OpenStreetMap buildings via Overpass, cached in `data-src/osm-antakya-buildings.json` | Building footprints and heights where tagged | © OpenStreetMap contributors, ODbL |
| OpenFreeMap vector tiles | Basemap | OSM data, ODbL |
| Mapzen terrain tiles (AWS Open Data) | Terrain and hillshade | Open data |
| EOX Sentinel-2 cloudless 2021 | Worldwide satellite base layer (no key) | CC BY-NC-SA 4.0 |
| OpenStreetMap via Overpass API (live, in the browser) and Nominatim place search | "Any city" missions: buildings, roads, water | ODbL |
| Maxar Open Data, 4 ARD tiles per date (UTM 37 grid 031133023302/303/320/321) | Pre/post imagery of ~10 x 10 km of Antakya as XYZ tiles z13-18 (`tools/tile-imagery.py`) | CC BY-NC 4.0 |

The mission sector AOI-M1 is selected automatically as the densest 700 m square of graded damage.
Buildings: OSM footprints where mapped, graded by their containing Copernicus block; unmapped graded blocks are shown as block massing.
Heights without OSM tags are estimated and flagged (`est: 1`). Destroyed structures render as rubble with the pre-event height kept as `h0`.

## Mission engine (`src/console/mission.ts`)

- X500 V2 survey at 60 m AGL, 10 m/s, 105 m swath; 18 min endurance with a 25% reserve.
- Structures are "unverified" until inside the drone's camera footprint.
- Ground routing on the Copernicus road network (Dijkstra); segments graded Damaged/Destroyed are impassable.
- The direct route is compared with the verified route; the operator approves an exact sha256 plan hash.
- Husky A300 executes at 1.0 m/s; every step is written to an exportable mission record.

Robot figures are manufacturer specifications (see `src/data/fleet.ts`).

## Live mode: Gazebo + ROS 2 + mission authority

```bash
# WSL (ROS 2 Jazzy, Gazebo Harmonic, aegisloop_interfaces built in ~/aegisloop_ws)
npm run gazebo -- --live          # once: generates sim/worlds/antakya_live.sdf (robots + Antakya sector)
bash sim/run_live.sh [--gui]       # Gazebo + ros_gz bridges + ROS 2 nodes + authority API on :8790
# Windows / any shell
npm start                          # web app (:5180) + Nexconn server; in the console choose "Gazebo live"
```

| ROS 2 node | Interface | Role |
|---|---|---|
| `uav_controller` | action `/uav/fly_route` (FlyRoute) → `/uav/cmd_vel` | survey and overwatch flight (Gazebo VelocityControl, kinematic) |
| `ugv_controller` | action `/ugv/follow_path` (FollowPath) → `/ugv/cmd_vel` | pure-pursuit path following (Gazebo DiffDrive) |
| `mission_authority` | `/uav/odom`, `/ugv/odom`, `/clock`; Gazebo create/remove/set_pose | independent plan verification, execution, simulated obstruction |

**Verification (sim/live/authority_core.py, tests in sim/live/test_authority.py).** The console proposes; the authority decides.
A plan is executable only if every segment is on the Copernicus road graph, graded passable and not closed, and inside the
area UAV-1's camera actually covered (computed from Gazebo drone odometry, nothing else). Road segments are split to ≤ 20 m in both the console
(`src/lib/roadgraph.ts`) and the authority, so coverage is judged per street block. Approvals must come from the
Ops Commander, quote the authority's SHA-256 of the exact route, target the latest plan version and the current world
version, and can be used once. Any world change (e.g. an obstruction) bumps the world version and makes earlier approvals stale.

```bash
~/aegisloop_venv/bin/python -m pytest -q sim/live/test_authority.py     # 11 tests on the real Antakya road network
```

Real vs simulated in live mode: imagery, damage grades and roads are real data; robot motion is Gazebo physics (simulated);
detection is modelled (Copernicus grade inside the camera footprint); the obstruction is injected by the authority and labelled.
UGV-1 is a kinematic ground model (Gazebo VelocityControl; wheel-contact physics is not simulated) and UAV-1 a kinematic flight model.
Buildings are visual-only in the live world (footprints and road centrelines do not align to the metre); barriers on segments
graded Damaged/Destroyed keep collision.
