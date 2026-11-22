// "Your mission, anywhere": what the operations console can do beyond the Antakya example.
import { Link } from "react-router-dom";
import { ArrowUpRight, FileText, Globe2, Hexagon, Route } from "lucide-react";

const ITEMS = [
  { icon: Hexagon, title: "Mark the area", text: "Click dots on the map around the place to search. Place the rover and its destination. The drone flies only there, and the rover never leaves it.", tag: "New mission" },
  { icon: Globe2, title: "Any city, any hazard", text: "Antakya with real Copernicus damage, or any city from OpenStreetMap. Earthquake, flood along the real river, or fire. Simulated damage is labelled as simulated.", tag: "Places · scenarios" },
  { icon: Route, title: "The best verified path", text: "Fastest, least exposed to collapsed buildings, best radio coverage: routes are compared and ranked. Only roads the drone has seen are eligible.", tag: "Planner + comms" },
  { icon: FileText, title: "A route card anyone can follow", text: "One A4 page: satellite map, numbered turns, street names, relay stretches, rules and the approved plan hash. Stamped until the commander approves.", tag: "PDF" },
];

export function Capabilities() {
  return (
    <section className="caps" aria-labelledby="caps-h">
      <div className="caps-h">
        <span className="kicker">Beyond the replay</span>
        <h2 id="caps-h">Your mission.<br />Anywhere.</h2>
        <p>The Antakya case shows the loop on real ground. The console lets you run it yourself: your area, your place, your disaster, with the real X500 and Husky shown live in 3D on the map.</p>
        <Link to="/console" className="pill-btn">Build a mission <ArrowUpRight size={16} aria-hidden /></Link>
      </div>
      <ol className="caps-grid">
        {ITEMS.map(({ icon: Icon, title, text, tag }, i) => (
          <li key={title}>
            <div className="caps-top"><span className="caps-n">{String(i + 1).padStart(2, "0")}</span><span className="caps-tag">{tag}</span></div>
            <Icon size={26} strokeWidth={1.6} aria-hidden />
            <h3>{title}</h3>
            <p>{text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
