import { useEffect } from "react";
import { ExternalLink } from "lucide-react";
import "../landing/landing.css";
import { FLEET } from "../data/fleet";
import { Teardown } from "../landing/Teardown";
import { DRONE_SPECS, ROVER_SPECS } from "../landing/specs";

export default function Fleet() {
  useEffect(() => { document.title = "Fleet · AegisLoop"; }, []);
  return (
    <div className="landing">
      <section className="statement page-top">
        <span className="kicker">Fleet</span>
        <h1><span>Real robots.</span><span className="ind">Real limits.</span></h1>
        <div className="statement-foot"><p>Every number below is a published manufacturer figure, and the same figures drive the mission engine: survey time, battery reserve, route speed. In the operations console both robots fly and drive live on the map as 3D models.</p></div>
      </section>
      <Teardown kind="drone" index="01" role="Aerial reconnaissance" name="Holybro X500 V2" specs={DRONE_SPECS} source="Holybro X500 V2 published specifications" />
      <Teardown kind="rover" index="02" role="Ground execution" name="Clearpath Husky A300" specs={ROVER_SPECS} source="Clearpath Husky A300 published specifications" />
      <section className="specs-x">
        {FLEET.map((r) => (
          <details key={r.id} className="spec-acc">
            <summary><span>{r.name}</span><small>Full specification</small></summary>
            <div className="spec-acc-body">
              <table className="table"><tbody>{[...r.specs, ...r.planner].map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table>
              <a className="link-arrow" href={r.source.url} target="_blank" rel="noreferrer">{r.source.label} <ExternalLink size={14} aria-hidden /></a>
            </div>
          </details>
        ))}
      </section>
    </div>
  );
}
