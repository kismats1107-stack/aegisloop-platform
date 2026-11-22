import { useEffect } from "react";
import "../landing/landing.css";

const SECTIONS: { h: string; p?: string; list?: string[] }[] = [
  { h: "What we claim", p: "The Antakya replay shows how a verified robot team could have operated on the ground as it was assessed after the 6 February 2023 earthquakes. It does not depict any actual rescue, person or response team, and we make no claim that AegisLoop was used in the response." },
  { h: "What is real", list: [
    "Satellite imagery of Antakya before (22 December 2022) and after (11 February 2023) the earthquake, from the Maxar Open Data Program.",
    "Street network and building footprints, from Copernicus EMS and OpenStreetMap.",
    "Damage grades for buildings and roads, from Copernicus EMS rapid mapping activation EMSR648, Antakya grading monitoring product of 13 February 2023.",
    "Locations of spontaneous sites and road barriers identified in the same product.",
    "Robot capabilities, from published manufacturer specifications.",
  ] },
  { h: "What is simulated", list: [
    "The robots, their movements, battery use and timings.",
    "The mission, the operator and every approval.",
    "Radio links between the command post, the drone and the rover. These are a modelled budget, not measurements.",
    "Any signal of interest or survivor indication. These are labelled as simulated wherever they appear.",
    "Building heights where OpenStreetMap has no height information. These are estimated and flagged in the data.",
  ] },
  { h: "Human authority", p: "AegisLoop does not move a robot without an operator approving a specific, hashed plan. The system recommends; people decide. This is a design requirement, not a configuration option." },
  { h: "Data and licences", p: "Damage grading © European Union, Copernicus Emergency Management Service. Building and road data © OpenStreetMap contributors, Open Database Licence. Basemap labels by OpenFreeMap. Sentinel-2 cloudless by EOX (Copernicus Sentinel data 2021), CC BY-NC-SA 4.0. Satellite imagery © Maxar Technologies, released through the Maxar Open Data Program under CC BY-NC 4.0." },
];

export default function Responsible() {
  useEffect(() => { document.title = "Responsible use · AegisLoop"; }, []);
  return (
    <div className="landing">
      <section className="statement page-top">
        <span className="kicker">Responsible use</span>
        <h1><span>Real places.</span><span className="ind">Real loss.</span></h1>
        <div className="statement-foot">
          <p>Our case replays are built on the geography of real disasters. That carries an obligation to be precise about what is real, what is simulated, and what we claim.</p>
        </div>
      </section>

      <section className="ed">
        {SECTIONS.map((s) => (
          <article key={s.h} className="ed-split">
            <h2>{s.h}</h2>
            <div>{s.p && <p>{s.p}</p>}{s.list && <ul>{s.list.map((l) => <li key={l}>{l}</li>)}</ul>}</div>
          </article>
        ))}
      </section>

      <section className="ed memory">
        <span className="kicker">In memory</span>
        <p>More than 50,000 people lost their lives in Türkiye in the February 2023 earthquakes, and many more in Syria. This work is dedicated to them, and to the responders who searched the rubble.</p>
      </section>
    </div>
  );
}
