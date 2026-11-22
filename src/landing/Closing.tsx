import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Lock } from "lucide-react";

interface Status { configured: boolean; status: string; channel: { id: string; name: string }; roster: { id: string; name: string; role: string }[] }

const SCRIPT = [
  { who: "bot", text: "Survey complete · 130/148 structures verified · 18 roads cut." },
  { who: "Field Lead", text: "Team 2 at staging. Ready to move on approval." },
  { who: "bot", text: "PLN-001 proposed · verified route 735 m · direct route rejected (4 cut roads)." },
  { who: "Ops Commander", text: "Approved. Medical, stand by at C-1." },
  { who: "bot", text: "PLN-001 approved · sha256 b77aee96… · Husky A300 dispatched." },
];

/** Closing section: the team layer (Nexconn) + one clear call to action. */
export function Closing() {
  const [st, setSt] = useState<Status | null>(null);
  const [n, setN] = useState(1);
  useEffect(() => { fetch("/api/nx/status").then((r) => r.json()).then(setSt).catch(() => {}); }, []);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setN(SCRIPT.length); return; }
    const id = setInterval(() => setN((v) => (v >= SCRIPT.length ? 1 : v + 1)), 2200);
    return () => clearInterval(id);
  }, []);
  const live = st?.configured && st.status === "connected";
  return (
    <section className="close-x">
      <div className="close-card">
        <div className="close-copy">
          <span className="close-kicker">Team layer · Powered by Nexconn</span>
          <h2>One channel for the whole response.</h2>
          <p>Every survey, plan and approval lands in the mission channel the moment it happens. Field teams, pilots and medics talk in the same thread. Approval stays a separate, hash-bound action.</p>
          <div className="close-cta">
            <Link to="/console" className="hx-btn primary">Run the Antakya replay <ArrowUpRight size={18} aria-hidden /></Link>
            <Link to="/cases/antakya-2023" className="hx-btn">Read the case</Link>
          </div>
          <dl className="close-facts">
            <div><dt>Robots</dt><dd>X500 · Husky A300</dd></div>
            <div><dt>Ground truth</dt><dd>Copernicus · Maxar</dd></div>
            <div><dt>Simulation</dt><dd>ROS 2 · Gazebo</dd></div>
          </dl>
        </div>
        <div className="close-chat" aria-label="Mission channel preview">
          <div className="cc-head">
            <div><b>{st?.channel.name ?? "Antakya · Sector AOI-M1"}</b><small>{st ? `${st.roster.length + 1} members` : "Mission channel"}</small></div>
            <span className={`cc-live ${live ? "on" : ""}`}><i />{live ? "Live on Nexconn" : "Nexconn"}</span>
          </div>
          <div className="cc-list">
            {SCRIPT.slice(0, n).map((m, i) => m.who === "bot"
              ? <div key={i} className="cc-ev"><span>AegisLoop</span><p>{m.text}</p></div>
              : <div key={i} className="cc-msg"><span className="cc-av">{m.who.split(" ").map((w) => w[0]).join("")}</span><div><b>{m.who}</b><p>{m.text}</p></div></div>)}
          </div>
          <div className="cc-foot"><Lock size={12} aria-hidden /> Preview. The live channel runs inside the console.</div>
        </div>
      </div>
    </section>
  );
}
