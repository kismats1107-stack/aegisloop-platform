import { Link, Outlet, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { ArrowUpRight, Moon, Sun } from "lucide-react";

type Theme = "light" | "dark";
const readTheme = (): Theme => { try { return localStorage.getItem("aegis-theme") === "dark" ? "dark" : "light"; } catch { return "light"; } };
/** Light/dark theme for the website (the console keeps its own theme). */
function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0b0c11" : "#f0f1fa");
    try { localStorage.setItem("aegis-theme", theme); } catch { /* storage unavailable */ }
  }, [theme]);
  useEffect(() => () => { delete document.documentElement.dataset.theme; }, []);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))] as const;
}
import { onFrame, scrollToTop, useSmoothScroll } from "../landing/scroll";

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <span className="logo">
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
        <path d="M16 4 27 10v8c0 5.8-4.6 9.7-11 11.2C9.6 27.7 5 23.8 5 18v-8Z" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <path d="M11 17a5 5 0 1 0 5-5" fill="none" stroke="var(--primary)" strokeWidth="2.4" strokeLinecap="round" />
        <path d="m16 9.4 2.5 2.6-2.5 2.6" fill="none" stroke="var(--primary)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>AegisLoop</span>
    </span>
  );
}

const NAV = [
  { to: "/", label: "Overview" },
  { to: "/cases/antakya-2023", label: "Antakya 2023" },
  { to: "/fleet", label: "Fleet" },
  { to: "/platform", label: "Platform" },
  { to: "/responsible-use", label: "Responsible use" },
];

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => { document.body.style.overflow = open ? "hidden" : ""; }, [open]);
  const [hidden, setHidden] = useState(false);
  const [dark, setDark] = useState(false);
  // the landing hero is dark: light header text while it is under the header
  useEffect(() => onFrame(() => { const el = loc.pathname === "/" ? document.querySelector(".hx") : null; const d = !!el && el.getBoundingClientRect().bottom > 70; setDark((v) => (v === d ? v : d)); }), [loc.pathname]);
  useEffect(() => { let last = 0, h = false; return onFrame(() => { const y = scrollY, d = y - last; if (Math.abs(d) > 4) { const nh = d > 0 && y > 140; if (nh !== h) { h = nh; setHidden(nh); } last = y; } }); }, []);
  return (
    <>
      <header className={`xh ${hidden && !open ? "hide" : ""} ${dark && !open ? "on-dark" : ""}`}>
        <Link to="/" aria-label="AegisLoop home" className="xh-logo"><Logo /></Link>
        <div className="xh-right">
          <button className="xh-pill xh-theme" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} title={theme === "dark" ? "Light theme" : "Dark theme"}>
            {theme === "dark" ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
          </button>
          <Link to="/console" className="xh-pill dark">Console <i aria-hidden /></Link>
          <button className="xh-pill" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="xmenu">
            {open ? "Close" : "Menu"} <b aria-hidden>{open ? "×" : "••"}</b>
          </button>
        </div>
      </header>
      <div id="xmenu" className={`xmenu ${open ? "open" : ""}`} aria-hidden={!open}>
        <nav aria-label="Primary">
          {NAV.map((n, i) => (
            <Link key={n.to} to={n.to} tabIndex={open ? 0 : -1} style={{ transitionDelay: open ? `${80 + i * 50}ms` : "0ms" }} className={loc.pathname === n.to ? "on" : ""}>
              <span className="xmenu-n">0{i + 1}</span>{n.label}
            </Link>
          ))}
        </nav>
        <Link to="/console" className="xmenu-cta" tabIndex={open ? 0 : -1}>Open operations console <ArrowUpRight size={18} aria-hidden /></Link>
      </div>
    </>
  );
}

export function SiteFooter() {
  return (
    <footer className="xf">
      <div className="xf-top">
        <div className="xf-brand"><Logo /><p>Verified autonomy for urban search and rescue.</p></div>
        <nav className="xf-cols" aria-label="Footer">
          <div><h4>Product</h4><Link to="/console">Operations console</Link><Link to="/fleet">Fleet</Link><Link to="/platform">Platform</Link></div>
          <div><h4>Evidence</h4><Link to="/cases/antakya-2023">Antakya 2023</Link><Link to="/responsible-use">Responsible use</Link><a href="https://mapping.emergency.copernicus.eu/activations/EMSR648" target="_blank" rel="noreferrer">Copernicus EMSR648</a></div>
          <div><h4>Built with</h4><span>Nexconn Chat</span><span>ROS 2 Jazzy</span><span>Gazebo Harmonic</span></div>
        </nav>
      </div>
      <div className="xf-base">
        <span>© 2026 AegisLoop · Nexconn Build Challenge</span>
        <span>Real geography and damage. Simulated robots and missions.</span>
      </div>
      <p className="xf-credits">Imagery © Maxar Open Data Program (CC BY-NC 4.0) · Sentinel-2 cloudless by EOX (Copernicus Sentinel data 2021) · Damage grading © European Union, Copernicus EMS · Buildings and roads © OpenStreetMap contributors (ODbL) · Basemap labels by OpenFreeMap</p>
    </footer>
  );
}

export function SiteLayout() {
  const { pathname } = useLocation();
  useSmoothScroll();
  useEffect(() => { scrollToTop(); }, [pathname]);
  return (
    <>
      <SiteHeader />
      <main id="main"><Outlet /></main>
      <SiteFooter />
    </>
  );
}
