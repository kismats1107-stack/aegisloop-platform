import { useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import "../landing/landing.css";

const LOOP = [
  ["Survey", "UAV-1 (Holybro X500 V2) flies a lawnmower pattern at 60 m. Anything inside its 105 m camera footprint becomes verified; everything else stays unknown."],
  ["Verify", "A route segment is usable only if it is on the Copernicus road graph, graded passable, not closed, and seen by the camera. Unknown is impassable."],
  ["Approve", "The Ops Commander approves the exact SHA-256 of the route. An approval is valid once, for the latest plan version and the current world version."],
  ["Execute", "UGV-1 (Clearpath Husky A300) follows the approved route. It holds on a new obstruction or a lost command link, and a re-plan needs a new approval."],
  ["Record", "Every command, finding, plan, approval and link event is appended to the mission record, exportable as JSON and mirrored to the team channel."],
];

const STACK = [
  ["Operations console", "Browser · React, MapLibre, three.js", "Mission map with the real X500 and Husky in 3D, UAV-1 feed, situation report, damage assessment, plans and approvals, comms and fail-safe tests, team chat, mission record."],
  ["Mission builder", "On the operations map", "Pick a place (the Antakya case or any city from OpenStreetMap) and a scenario (earthquake, flood, fire), mark the area with dots, place the rover and its destination. Everything stays inside the area."],
  ["Planner and route card", "Ranked verified routes", "Up to four verified routes compared on drive time, collapse exposure and radio coverage. The approved one becomes a one-page route card with turn-by-turn directions, saved as PDF."],
  ["Mission authority", "ROS 2 Jazzy · FastAPI", "Re-checks every plan independently against UAV-1's real coverage, the road graph and the world version before UGV-1 gets the goal. Covered by 11 automated tests on the Antakya road network."],
  ["Simulation", "Gazebo Harmonic", "The live world is generated from the same Copernicus and OpenStreetMap data the console uses. UAV-1 and UGV-1 run through ROS 2 actions /uav/fly_route and /ugv/follow_path."],
  ["Team layer", "Nexconn Chat", "One mission channel, five roles. The AegisLoop bot posts surveys, plans, approvals and incidents. Access tokens are issued by our server; the App Secret never reaches the browser."],
  ["Ground truth", "Open data", "Copernicus EMS EMSR648 damage grades, OpenStreetMap buildings, roads and rivers (any city, live), Maxar Open Data imagery before and after the earthquake, Sentinel-2 cloudless base map."],
];

const GUARANTEES = [
  ["Plan integrity", "sha256 of the exact route, bound to the approval"],
  ["Freshness", "Superseded plans and stale world versions are refused"],
  ["Single use", "An approval is consumed once and cannot be replayed"],
  ["Fail-safe", "No command path to UGV-1 means it stops and holds"],
  ["Provenance", "Every screen separates real data from simulation"],
  ["Secrets", "Credentials stay on the server, never in the browser"],
];

export default function Platform() {
  useEffect(() => { document.title = "Platform · AegisLoop"; }, []);
  return (
    <div className="landing">
      <section className="statement page-top">
        <span className="kicker">Platform</span>
        <h1><span>Autonomy</span><span className="ind">with receipts.</span></h1>
        <div className="statement-foot">
          <p>AegisLoop sits between field robots and the people accountable for them. What the drone has seen decides what is known. The planner proposes only verified routes. A commander approves one exact plan, and everything is recorded.</p>
        </div>
      </section>

      <section className="ed">
        <div className="ed-h"><h2>The loop</h2><span className="kicker">Five steps, every mission</span></div>
        <ol className="ed-rows">
          {LOOP.map(([h, d], i) => <li key={h}><span className="ed-n">{String(i + 1).padStart(2, "0")}</span><h3>{h}</h3><p>{d}</p></li>)}
        </ol>
      </section>

      <section className="ed">
        <div className="ed-h"><h2>The stack</h2><span className="kicker">What actually runs</span></div>
        <ol className="ed-rows ed-stack">
          {STACK.map(([h, tag, d]) => <li key={h}><span className="ed-tag">{tag}</span><h3>{h}</h3><p>{d}</p></li>)}
        </ol>
      </section>

      <section className="ed">
        <div className="ed-h"><h2>Guarantees</h2><span className="kicker">Enforced, not configured</span></div>
        <dl className="ed-grid">
          {GUARANTEES.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
      </section>

      <section className="cta-x">
        <Link to="/console" className="cta-huge"><span>Open the console</span><ArrowUpRight aria-hidden /></Link>
      </section>
    </div>
  );
}
