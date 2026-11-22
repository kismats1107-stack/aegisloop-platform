// Local metric frame (equirectangular around a reference latitude) — accurate to <0.1% over a few km.
export type LngLat = [number, number];
export type XY = [number, number];

export class Frame {
  readonly mLat = 111320;
  readonly mLon: number;
  constructor(readonly origin: LngLat) { this.mLon = 111320 * Math.cos((origin[1] * Math.PI) / 180); }
  toXY([lng, lat]: LngLat): XY { return [(lng - this.origin[0]) * this.mLon, (lat - this.origin[1]) * this.mLat]; }
  toLngLat([x, y]: XY): LngLat { return [this.origin[0] + x / this.mLon, this.origin[1] + y / this.mLat]; }
}

export const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lerp = (a: XY, b: XY, t: number): XY => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const headingDeg = (a: XY, b: XY) => (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;

/** Distance from point p to segment ab (metres in a local frame). */
export function segDist(p: XY, a: XY, b: XY) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Polyline sampler: position and heading at a travelled distance. */
export class Path {
  readonly cum: number[] = [0];
  constructor(readonly pts: XY[]) { for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + dist(pts[i - 1], pts[i])); }
  get length() { return this.cum[this.cum.length - 1]; }
  at(s: number): { p: XY; hdg: number } {
    const d = Math.max(0, Math.min(this.length, s));
    let i = 1; while (i < this.cum.length - 1 && this.cum[i] < d) i++;
    const seg = this.cum[i] - this.cum[i - 1] || 1;
    return { p: lerp(this.pts[i - 1], this.pts[i], (d - this.cum[i - 1]) / seg), hdg: headingDeg(this.pts[i - 1], this.pts[i]) };
  }
}

export function fmtLatLng([lng, lat]: LngLat) {
  const f = (v: number, p: string, n: string) => `${Math.abs(v).toFixed(5)}°${v >= 0 ? p : n}`;
  return `${f(lat, "N", "S")} ${f(lng, "E", "W")}`;
}

export async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
