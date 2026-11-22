import { GRADE_COLOR, GRADE_LABEL, type Grade } from "../data/antakya";

export function DamageLegend({ compact }: { compact?: boolean }) {
  const grades: Grade[] = [3, 2, 1];
  return (
    <ul className={`legend ${compact ? "legend-compact" : ""}`} aria-label="Map legend">
      {grades.map((g) => (
        <li key={g}><span className="sw" style={{ background: GRADE_COLOR[g] }} aria-hidden />{GRADE_LABEL[g]}</li>
      ))}
      <li><span className="sw sw-line" aria-hidden />Road impassable</li>
      <li><span className="sw sw-dot" aria-hidden />People gathered</li>
      <li><span className="sw sw-aoi" aria-hidden />Mission sector</li>
    </ul>
  );
}
