import type { FeatureCollection, Geometry } from "geojson";
import type { RoadProps } from "../data/antakya";
import { Frame, type XY, dist, segDist } from "./geo";

export interface Edge { to: number; len: number; road: number; grade: number }
export interface RoadGraph { nodes: XY[]; adj: Edge[][]; names: string[]; grades: number[] }

/** Builds a routable graph from Copernicus transportation lines; vertices within ~1.5 m are merged. */
export const MAX_SEG = 20;   // m

export function buildGraph(roads: FeatureCollection<Geometry, RoadProps>, frame: Frame): RoadGraph {
  const nodes: XY[] = [], adj: Edge[][] = [], names: string[] = [], grades: number[] = [];
  const index = new Map<string, number>();
  const SNAP = 1.5;
  const nodeAt = (p: XY) => {
    const kx = Math.round(p[0] / SNAP), ky = Math.round(p[1] / SNAP);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const id = index.get(`${kx + dx},${ky + dy}`);
      if (id !== undefined && dist(nodes[id], p) <= SNAP) return id;
    }
    nodes.push(p); adj.push([]); index.set(`${kx},${ky}`, nodes.length - 1);
    return nodes.length - 1;
  };
  roads.features.forEach((f) => {
    const lines = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.type === "MultiLineString" ? f.geometry.coordinates : [];
    const road = names.length; names.push(f.properties.n || "Unnamed road"); grades.push(f.properties.g);
    for (const line of lines) {
      let prev = -1, prevXY: XY | null = null;
      const link = (a: number, b: number) => {
        if (a < 0 || a === b) return;
        const len = dist(nodes[a], nodes[b]);
        adj[a].push({ to: b, len, road, grade: f.properties.g });
        adj[b].push({ to: a, len, road, grade: f.properties.g });
      };
      for (const c of line) {
        const xy = frame.toXY(c as [number, number]);
        // densify: no segment longer than MAX_SEG, so coverage and routing work at street-block resolution
        // (same rule as sim/live/authority_core.py RoadGraph)
        if (prevXY) {
          const n = Math.ceil(dist(prevXY, xy) / MAX_SEG);
          for (let k = 1; k < n; k++) { const id = nodeAt([prevXY[0] + ((xy[0] - prevXY[0]) * k) / n, prevXY[1] + ((xy[1] - prevXY[1]) * k) / n]); link(prev, id); prev = id; }
        }
        const id = nodeAt(xy);
        link(prev, id);
        prev = id; prevXY = xy;
      }
    }
  });
  return { nodes, adj, names, grades };
}

export function nearestNode(g: RoadGraph, p: XY, usable?: (i: number) => boolean) {
  let best = -1, bd = Infinity;
  g.nodes.forEach((n, i) => { if (!g.adj[i].length || (usable && !usable(i))) return; const d = dist(n, p); if (d < bd) { bd = d; best = i; } });
  return best;
}

export interface Route { nodes: number[]; pts: XY[]; length: number; edges: Edge[]; blocked: Edge[]; hazardsNear: number }

/** Dijkstra. `blocked(edge)` returns true for edges that must not be used. */
export function shortestPath(g: RoadGraph, from: number, to: number, blocked: (e: Edge, from: number) => boolean = () => false, cost: (e: Edge, from: number) => number = (e) => e.len): Route | null {
  const n = g.nodes.length, d = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), via: (Edge | null)[] = new Array(n).fill(null);
  const heap: [number, number][] = [[0, from]]; d[from] = 0;
  const push = (x: [number, number]) => { heap.push(x); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop()!; if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  while (heap.length) {
    const [du, u] = pop();
    if (du > d[u]) continue;
    if (u === to) break;
    for (const e of g.adj[u]) {
      if (blocked(e, u)) continue;
      const nd = du + cost(e, u);
      if (nd < d[e.to]) { d[e.to] = nd; prev[e.to] = u; via[e.to] = e; push([nd, e.to]); }
    }
  }
  if (!isFinite(d[to])) return null;
  const nodes: number[] = [], edges: Edge[] = [];
  for (let v = to; v !== -1; v = prev[v]) { nodes.push(v); if (via[v]) edges.push(via[v]!); }
  nodes.reverse(); edges.reverse();
  return { nodes, pts: nodes.map((i) => g.nodes[i]), length: edges.reduce((s, e) => s + e.len, 0), edges, blocked: edges.filter((e) => e.grade >= 2), hazardsNear: 0 };
}

/** Counts hazard points (e.g. destroyed-structure centroids) within `radius` metres of a route. */
export function hazardsAlong(route: Route, hazards: XY[], radius: number) {
  let n = 0;
  for (const h of hazards) for (let i = 1; i < route.pts.length; i++) if (segDist(h, route.pts[i - 1], route.pts[i]) <= radius) { n++; break; }
  return n;
}
