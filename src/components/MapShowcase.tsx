import { useState } from "react";
import { Layers, MapPin } from "lucide-react";
import { CaseMap, type CaseMapProps } from "../map/CaseMap";
import type { Scene } from "../map/style";
import type { CaseData } from "../data/antakya";
import { fmtLatLng } from "../lib/geo";
import { DamageLegend } from "./Legend";

const fmtDate = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** Google-Maps-style map window: imagery with before/after switch and floating cards. */
export function MapShowcase({ data, height = 640, view, orbit, place = true }: { data: CaseData; height?: number; view?: CaseMapProps["view"]; orbit?: boolean; place?: boolean }) {
  const [scene, setScene] = useState<Scene>("post");
  const [overlay, setOverlay] = useState(true);
  const im = data.imagery;
  return (
    <div className="showcase" style={{ height }}>
      <CaseMap data={data} scene={scene} overlay={overlay} orbit={orbit} scrollZoom={false} controls view={view} label="Satellite map of Antakya with Copernicus damage grading" />
      {im && (
        <div className="mcard mcard-tl" role="group" aria-label="Imagery date">
          <div className="seg">
            <button className={scene === "pre" ? "on" : ""} aria-pressed={scene === "pre"} onClick={() => setScene("pre")}>
              <span>Before</span><small>{fmtDate(im.scenes.pre.date)}</small>
            </button>
            <button className={scene === "post" ? "on" : ""} aria-pressed={scene === "post"} onClick={() => setScene("post")}>
              <span>After</span><small>{fmtDate(im.scenes.post.date)}</small>
            </button>
          </div>
        </div>
      )}
      <div className="mcard mcard-tr">
        <div className="mcard-h">
          <span>Damage grading</span>
          <button className={`toggle ${overlay ? "on" : ""}`} role="switch" aria-checked={overlay} aria-label="Show damage grading" onClick={() => setOverlay(!overlay)} disabled={scene === "pre"}><span /></button>
        </div>
        <DamageLegend compact />
        <p className="mcard-src">Copernicus EMS · EMSR648 · 13 Feb 2023</p>
      </div>
      {place && (
        <div className="mcard mcard-bl">
          <div className="place-ic"><MapPin size={18} /></div>
          <div>
            <div className="place-t">Antakya, Hatay, Türkiye</div>
            <div className="place-s">Sector AOI-M1 · 700 m × 700 m</div>
            <div className="place-s">{fmtLatLng(data.meta.center)}</div>
            <div className="place-s"><Layers size={12} aria-hidden /> Maxar imagery · {scene === "pre" ? "22 Dec 2022" : "11 Feb 2023"}</div>
          </div>
        </div>
      )}
    </div>
  );
}
