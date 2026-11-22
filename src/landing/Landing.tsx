import { useEffect, useRef } from "react";
import "./landing.css";
import { useAntakya } from "../data/useCase";
import { HeroDistrict } from "./HeroDistrict";
import { Closing } from "./Closing";
import { Capabilities } from "./Capabilities";
import { Quake } from "./Quake";
import { LoopStory } from "./LoopStory";
import { Teardown } from "./Teardown";
import { onFrame, progressOf, seg } from "./scroll";
import { DRONE_SPECS, ROVER_SPECS } from "./specs";


export default function Landing() {
  const { data } = useAntakya();
  useEffect(() => { document.title = "AegisLoop · Verified autonomy for search and rescue"; }, []);
  return (
    <div className="landing">
      <HeroDistrict data={data ?? null} />

      {data?.imagery ? <Quake data={data} /> : <div className="pin-skel" />}

      <Words text="Drones see. Robots move. People decide." accent={[0, 2, 4]} />

      {data?.imagery ? <LoopStory data={data} /> : <div className="pin-skel" />}

      <Words text="Real robots. Real limits." accent={[1, 3]} small />

      <Teardown kind="drone" index="01" role="Aerial reconnaissance" name="Holybro X500 V2" specs={DRONE_SPECS} source="Holybro X500 V2 published specifications" />
      <Teardown kind="rover" index="02" role="Ground execution" name="Clearpath Husky A300" specs={ROVER_SPECS} source="Clearpath Husky A300 published specifications" />

      <Capabilities />

      <GazeboBlock />

      <Closing />
    </div>
  );
}


/** Big statement whose words light up as it scrolls through the viewport. */
function Words({ text, accent = [], small }: { text: string; accent?: number[]; small?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const words = text.split(" ");
  useEffect(() => onFrame(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect(), p = seg(1 - (r.top + r.height * 0.5) / innerHeight, 0.05, 0.55);
    el.querySelectorAll<HTMLSpanElement>("span").forEach((s, i) => { s.style.opacity = String(0.12 + 0.88 * seg(p * words.length, i, i + 1)); });
  }), [words.length]);
  return (
    <section ref={ref} className={`words ${small ? "small" : ""}`}>
      <h2>{words.map((w, i) => <span key={i} className={accent.includes(i) ? "acc" : ""}>{w} </span>)}</h2>
    </section>
  );
}

function GazeboBlock() {
  const ref = useRef<HTMLElement>(null), img = useRef<HTMLImageElement>(null);
  useEffect(() => onFrame(() => {
    if (!ref.current || !img.current) return;
    const p = progressOf(ref.current);
    img.current.style.transform = `scale(${(1.18 - 0.18 * p).toFixed(4)}) translateY(${(-4 + 8 * p).toFixed(2)}%)`;
  }), []);
  return (
    <section ref={ref} className="gz">
      <div className="gz-text">
        <span className="kicker">03 · Simulation</span>
        <h2>Same ground.<br />Real physics.</h2>
        <p>The Antakya sector, exported to Gazebo Harmonic for ROS 2 testing: 361 structures, 19 collapses, 105 road barriers.</p>
      </div>
      <div className="gz-frame"><img ref={img} src="/media/gazebo-antakya.jpg" alt="The Antakya sector rendered in Gazebo Harmonic, with buildings coloured by damage grade" loading="lazy" /></div>
    </section>
  );
}
