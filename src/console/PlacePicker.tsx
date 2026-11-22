// Place picker for a new mission: curated real disaster cases, or any city from OpenStreetMap.
import { useState } from "react";
import { Loader2, MapPin, Search, X } from "lucide-react";
import type { CaseData } from "../data/antakya";
import { type PlaceHit, loadOsmPlace, searchPlaces } from "../data/osmPlace";

export function PlacePicker({ current, onClose, onAntakya, onLoaded }: { current: string; onClose: () => void; onAntakya: () => void; onLoaded: (d: CaseData) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PlaceHit[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const search = async () => {
    if (q.trim().length < 2) return;
    setErr(null); setBusy("search");
    try { const h = await searchPlaces(q.trim()); setHits(h); if (!h.length) setErr("No place found. Try another spelling or a nearby city."); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const pick = async (h: PlaceHit) => {
    setErr(null); setBusy(h.display);
    try { onLoaded(await loadOsmPlace(h)); }
    catch (e) { setErr((e as Error).message); setBusy(null); }
  };
  return (
    <div className="pp-scrim" role="dialog" aria-modal="true" aria-label="Choose a place" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="pp">
        <div className="pp-h"><div><h3>Choose a place</h3><p>Current: {current}</p></div><button className="cx-icon" onClick={onClose} disabled={!!busy && busy !== "search"} aria-label="Close"><X size={16} /></button></div>

        <section>
          <h4>Real disaster cases</h4>
          <button className="pp-case" onClick={onAntakya} disabled={!!busy}>
            <span className="pp-ic"><MapPin size={16} /></span>
            <div><b>Antakya, Türkiye · Earthquake, 6 Feb 2023</b><small>Real Copernicus damage grades · Maxar imagery before and after · Gazebo live supported</small></div>
            <span className="chip chip-ok">Real data</span>
          </button>
          <p className="pp-note">More real cases are being prepared from free Copernicus data (for example the 2023 Derna flood and the 2023 Al Haouz earthquake).</p>
        </section>

        <section>
          <h4>Any city</h4>
          <p className="pp-note">Real buildings, roads and rivers from OpenStreetMap, about 1.2 km × 1.2 km around the place. The disaster is simulated (earthquake, flood or fire).</p>
          <form className="pp-search" onSubmit={(e) => { e.preventDefault(); void search(); }}>
            <Search size={16} aria-hidden />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a city or neighbourhood, e.g. Kathmandu, Thamel" aria-label="City or neighbourhood" disabled={!!busy && busy !== "search"} />
            <button className="btn btn-primary btn-sm" disabled={q.trim().length < 2 || !!busy}>{busy === "search" ? <Loader2 size={15} className="spin" /> : "Search"}</button>
          </form>
          {hits && hits.length > 0 && (
            <ul className="pp-hits">
              {hits.map((h) => (
                <li key={h.display}><button onClick={() => void pick(h)} disabled={!!busy}>
                  <MapPin size={14} aria-hidden /><div><b>{h.name}</b><small>{h.display}</small></div>
                  {busy === h.display && <span className="pp-load"><Loader2 size={14} className="spin" />Loading buildings and roads…</span>}
                </button></li>
              ))}
            </ul>
          )}
          {err && <p className="pp-err">{err}</p>}
        </section>
        <p className="pp-foot">Place search by Nominatim · map data © OpenStreetMap contributors (ODbL)</p>
      </div>
    </div>
  );
}
