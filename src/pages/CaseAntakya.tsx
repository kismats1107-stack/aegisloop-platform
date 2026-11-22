import { useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import "../landing/landing.css";
import { useAntakya } from "../data/useCase";
import { MapShowcase } from "../components/MapShowcase";
import { Quake } from "../landing/Quake";
import { LoopStory } from "../landing/LoopStory";

const REAL: [string, string, string][] = [
  ["Satellite imagery, before and after", "Real", "Maxar Open Data Program · 22 Dec 2022 and 11 Feb 2023"],
  ["Streets and road network", "Real", "Copernicus EMS transportation layer · OpenStreetMap"],
  ["Building footprints", "Real", "OpenStreetMap where mapped · Copernicus built-up blocks elsewhere"],
  ["Damage grades, buildings and roads", "Real", "Copernicus EMS EMSR648 AOI11 · grading monitoring 01 · 13 Feb 2023"],
  ["Spontaneous sites and road barriers", "Real", "Copernicus EMS crisis information layer"],
  ["Building heights", "Partly estimated", "OSM height tags where present, otherwise estimated and flagged"],
  ["Robot capabilities", "Published specs", "Holybro X500 V2 · Clearpath Husky A300"],
  ["Robots, mission, timings, signals of interest", "Simulated", "AegisLoop mission engine"],
];

export default function CaseAntakya() {
  const { data } = useAntakya();
  useEffect(() => { document.title = "Antakya 2023 · AegisLoop"; }, []);
  return (
    <div className="landing">
      <section className="statement page-top">
        <span className="kicker">Case replay · Copernicus EMSR648 · AOI11</span>
        <h1><span>Antakya.</span><span className="ind">6 February 2023.</span></h1>
        <div className="statement-foot">
          <p>More than 50,000 lives were lost in Türkiye. Antakya, the historic heart of Hatay, was among the hardest-hit cities. On that ground, with that damage: how would a verified robot team have moved?</p>
        </div>
      </section>

      {data?.imagery ? <Quake data={data} /> : <div className="pin-skel" />}

      <section className="explore-x">
        <span className="kicker">Explore</span>
        <h2>Drag the real ground.</h2>
        {data && <MapShowcase data={data} height={680} view={{ zoom: 15.9, pitch: 40, bearing: -18 }} />}
      </section>

      {data?.imagery ? <LoopStory data={data} /> : <div className="pin-skel" />}

      <section className="specs-x">
        <details className="spec-acc">
          <summary><span>Real and simulated</span><small>What this replay claims</small></summary>
          <div className="spec-acc-body">
            <table className="table rs-table"><tbody>{REAL.map(([e, s, src]) => (
              <tr key={e}><td>{e}</td><td><span className={`chip ${s === "Real" ? "chip-real" : s === "Simulated" ? "chip-sim" : "chip-est"}`}>{s}</span></td><td>{src}</td></tr>
            ))}</tbody></table>
          </div>
        </details>
        <details className="spec-acc">
          <summary><span>Sources</span><small>Data and licences</small></summary>
          <div className="spec-acc-body prose">
            <p>Damage grading © European Union, Copernicus Emergency Management Service, activation <a href="https://mapping.emergency.copernicus.eu/activations/EMSR648" target="_blank" rel="noreferrer">EMSR648</a>. Imagery © Maxar Technologies via the Maxar Open Data Program (CC BY-NC 4.0). Buildings and roads © OpenStreetMap contributors (ODbL). Terrain: Mapzen / AWS Open Data.</p>
          </div>
        </details>
      </section>

      <section className="cta-x">
        <Link to="/console" className="cta-huge"><span>Run the replay</span><ArrowUpRight aria-hidden /></Link>
      </section>
    </div>
  );
}
