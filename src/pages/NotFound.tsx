import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import "../landing/landing.css";

export default function NotFound() {
  return (
    <div className="landing">
      <section className="statement page-top nf">
        <span className="kicker">404 · Not found</span>
        <h1><span>Off the map.</span><span className="ind">Unknown is impassable.</span></h1>
        <div className="nf-cta">
          <Link to="/" className="btn btn-primary">Back to overview</Link>
          <Link to="/console" className="btn btn-ghost">Operations console <ArrowUpRight size={16} aria-hidden /></Link>
        </div>
      </section>
    </div>
  );
}
