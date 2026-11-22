"""AegisLoop mission authority: the independent verifier between the planner (web console) and the robots.

ROS-independent so it can be unit-tested. The planner proposes; the authority decides whether a route may be driven:

  on_network  every segment is an edge of the Copernicus road graph
  passable    no segment is graded Damaged/Destroyed by Copernicus EMS, and none is closed by an in-mission report
  observed    every segment lies inside the area actually covered by UAV-1's camera, computed from the drone's real
              Gazebo odometry (not from the plan, not from the scenario)
  current     the plan is the latest version and was proposed against the current world version
  bound       the approval quotes the authority's own hash of the exact route; each approval can be used once
  role        only the Ops Commander may approve

Frame: local ENU metres around the case centre, identical to the web console and the Gazebo world export.
"""
from __future__ import annotations

import hashlib
import heapq
import json
import math
from dataclasses import dataclass, field

SWATH_M = 105.0          # X500 camera ground swath at 60 m AGL (same constant as the console)
OBS_ALT_MIN = 40.0       # below this altitude the drone is not surveying (take-off / landing)
CELL = 5.0               # coverage grid resolution, m
SNAP = 1.5               # vertex merge distance when building the road graph (same as the console)
MAX_SEG = 20.0           # m, longer road segments are split (same as the console)
NODE_TOL = 2.5           # tolerance when matching a proposed route vertex to a graph node, m
SAMPLE = 5.0             # sampling step along a segment for the coverage check, m
APPROVER_ROLE = "ops-commander"


class Frame:
    def __init__(self, lng0: float, lat0: float):
        self.lng0, self.lat0 = lng0, lat0
        self.m_lat = 111320.0
        self.m_lon = 111320.0 * math.cos(math.radians(lat0))

    def to_xy(self, ll) -> tuple[float, float]:
        return ((ll[0] - self.lng0) * self.m_lon, (ll[1] - self.lat0) * self.m_lat)

    def to_ll(self, xy) -> tuple[float, float]:
        return (self.lng0 + xy[0] / self.m_lon, self.lat0 + xy[1] / self.m_lat)


@dataclass
class Edge:
    to: int
    length: float
    road: int
    grade: int


class RoadGraph:
    """Same construction as src/lib/roadgraph.ts: Copernicus transportation lines, vertices merged within 1.5 m."""

    def __init__(self, roads: dict, frame: Frame):
        self.nodes: list[tuple[float, float]] = []
        self.adj: list[list[Edge]] = []
        self.names: list[str] = []
        self._index: dict[tuple[int, int], int] = {}
        for f in roads["features"]:
            g = f["geometry"]
            lines = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"] if g["type"] == "MultiLineString" else []
            road = len(self.names)
            self.names.append(f["properties"].get("n") or "Unnamed road")
            grade = int(f["properties"].get("g", -1))
            for line in lines:
                prev, prev_xy = -1, None
                for c in line:
                    xy = frame.to_xy(c)
                    # densify: no segment longer than MAX_SEG (same rule as src/lib/roadgraph.ts)
                    if prev_xy is not None:
                        n = math.ceil(_dist(prev_xy, xy) / MAX_SEG)
                        for k in range(1, n):
                            mid = self._node_at((prev_xy[0] + (xy[0] - prev_xy[0]) * k / n, prev_xy[1] + (xy[1] - prev_xy[1]) * k / n))
                            self._link(prev, mid, road, grade)
                            prev = mid
                    nid = self._node_at(xy)
                    self._link(prev, nid, road, grade)
                    prev, prev_xy = nid, xy

    def _link(self, a: int, b: int, road: int, grade: int) -> None:
        if a < 0 or a == b:
            return
        L = _dist(self.nodes[a], self.nodes[b])
        self.adj[a].append(Edge(b, L, road, grade))
        self.adj[b].append(Edge(a, L, road, grade))

    def _node_at(self, p) -> int:
        kx, ky = round(p[0] / SNAP), round(p[1] / SNAP)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                i = self._index.get((kx + dx, ky + dy))
                if i is not None and _dist(self.nodes[i], p) <= SNAP:
                    return i
        self.nodes.append(p)
        self.adj.append([])
        self._index[(kx, ky)] = len(self.nodes) - 1
        return len(self.nodes) - 1

    def nearest(self, p, tol: float = NODE_TOL) -> int | None:
        kx, ky = round(p[0] / SNAP), round(p[1] / SNAP)
        r = int(math.ceil(tol / SNAP)) + 1
        best, bd = None, tol
        for dx in range(-r, r + 1):
            for dy in range(-r, r + 1):
                i = self._index.get((kx + dx, ky + dy))
                if i is not None:
                    d = _dist(self.nodes[i], p)
                    if d <= bd:
                        best, bd = i, d
        return best

    def edge(self, u: int, v: int) -> Edge | None:
        for e in self.adj[u]:
            if e.to == v:
                return e
        return None

    def shortest(self, src: int, dst: int, blocked=lambda u, e: False) -> list[int] | None:
        dist = {src: 0.0}
        prev: dict[int, int] = {}
        heap = [(0.0, src)]
        while heap:
            d, u = heapq.heappop(heap)
            if u == dst:
                break
            if d > dist.get(u, math.inf):
                continue
            for e in self.adj[u]:
                if blocked(u, e):
                    continue
                nd = d + e.length
                if nd < dist.get(e.to, math.inf):
                    dist[e.to], prev[e.to] = nd, u
                    heapq.heappush(heap, (nd, e.to))
        if dst not in dist:
            return None
        path, v = [dst], dst
        while v != src:
            v = prev[v]
            path.append(v)
        return path[::-1]


class Coverage:
    """Ground area seen by UAV-1's camera, accumulated from real drone poses only."""

    def __init__(self, swath: float = SWATH_M, cell: float = CELL):
        self.r, self.cell = swath / 2.0, cell
        self.cells: set[tuple[int, int]] = set()
        self._last: tuple[float, float] | None = None
        self.samples = 0

    def add_pose(self, x: float, y: float, z: float) -> None:
        if z < OBS_ALT_MIN:
            return
        if self._last and _dist(self._last, (x, y)) < self.cell:
            return
        self._last = (x, y)
        self.samples += 1
        c, n = self.cell, int(self.r // self.cell) + 1
        cx, cy = round(x / c), round(y / c)
        r2 = (self.r / c) ** 2
        for i in range(-n, n + 1):
            for j in range(-n, n + 1):
                if i * i + j * j <= r2:
                    self.cells.add((cx + i, cy + j))

    def covered(self, x: float, y: float) -> bool:
        return (round(x / self.cell), round(y / self.cell)) in self.cells

    def segment_covered(self, a, b) -> bool:
        L = _dist(a, b)
        n = max(1, int(math.ceil(L / SAMPLE)))
        return all(self.covered(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) for k in range(n + 1))

    def reset(self) -> None:
        self.cells.clear()
        self._last = None
        self.samples = 0


def closure_key(u: int, v: int) -> tuple[int, int]:
    return (u, v) if u < v else (v, u)


@dataclass
class Plan:
    plan_id: str
    version: int
    target: str
    route_xy: list[tuple[float, float]]
    nodes: list[int]
    world_version: int
    hash: str
    approved_by: str | None = None
    consumed: bool = False


@dataclass
class Authority:
    graph: RoadGraph
    frame: Frame
    coverage: Coverage = field(default_factory=Coverage)
    world_version: int = 1
    closed: set = field(default_factory=set)
    plans: dict = field(default_factory=dict)
    latest_version: int = 0
    log: list = field(default_factory=list)

    # ---------------------------------------------------------------- checks
    def check_route(self, route_ll: list) -> dict:
        pts = [self.frame.to_xy(p) for p in route_ll]
        nodes = [self.graph.nearest(p) for p in pts]
        checks = {}
        unmatched = sum(1 for n in nodes if n is None)
        seg_total = max(0, len(pts) - 1)
        off_net = impassable = unobserved = 0
        imp_detail = []
        if not unmatched:
            for i in range(seg_total):
                u, v = nodes[i], nodes[i + 1]
                e = self.graph.edge(u, v)
                if e is None:
                    off_net += 1
                    continue
                if e.grade >= 2:
                    impassable += 1
                    imp_detail.append("graded " + ("destroyed" if e.grade == 3 else "damaged"))
                elif closure_key(u, v) in self.closed:
                    impassable += 1
                    imp_detail.append("closed by in-mission report")
                if not self.coverage.segment_covered(self.graph.nodes[u], self.graph.nodes[v]):
                    unobserved += 1
        checks["on_network"] = _chk(unmatched == 0 and off_net == 0,
                                    f"{seg_total} segments on the Copernicus road graph" if unmatched == 0 and off_net == 0
                                    else f"{unmatched} vertices off the road graph, {off_net} segments are not roads")
        checks["passable"] = _chk(impassable == 0, "no segment graded impassable or closed" if impassable == 0
                                  else f"{impassable} impassable segment(s): {', '.join(sorted(set(imp_detail)))}")
        checks["observed"] = _chk(unobserved == 0 and seg_total > 0,
                                  f"all {seg_total} segments inside UAV-1 camera coverage (from Gazebo odometry)" if unobserved == 0
                                  else f"{unobserved} of {seg_total} segments never seen by UAV-1")
        length = sum(_dist(pts[i], pts[i + 1]) for i in range(seg_total))
        return {"checks": checks, "nodes": nodes, "pts": pts, "length": round(length, 1),
                "ok": all(c["ok"] for c in checks.values())}

    # ---------------------------------------------------------------- plans
    def canonical_hash(self, plan_id: str, version: int, target: str, pts, world_version: int) -> str:
        body = {"mission": "AOI-M1", "plan": plan_id, "version": version, "target": target, "unit": "ugv-1",
                "worldVersion": world_version, "route": [[round(x, 2), round(y, 2)] for x, y in pts]}
        return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    def propose(self, plan_id: str, version: int, target: str, options: list[dict], chosen: str) -> dict:
        """Registers the chosen option as the current plan; returns authority checks for every option."""
        results = {}
        for o in options:
            results[o["id"]] = self.check_route(o["route"])
        ch = results[chosen]
        h = self.canonical_hash(plan_id, version, target, ch["pts"], self.world_version)
        self.plans[plan_id] = Plan(plan_id, version, target, ch["pts"], ch["nodes"], self.world_version, h)
        self.latest_version = max(self.latest_version, version)
        self.log.append(("proposed", plan_id, version, self.world_version, h))
        return {"hash": h, "worldVersion": self.world_version,
                "options": {k: {"ok": v["ok"], "checks": v["checks"], "length": v["length"]} for k, v in results.items()}}

    def approve(self, plan_id: str, version: int, quoted_hash: str, approver_role: str) -> dict:
        """Validates an approval. Returns {ok, checks, plan?}. Never mutates world state on rejection."""
        p: Plan | None = self.plans.get(plan_id)
        checks = {}
        if p is None:
            return {"ok": False, "checks": {"known": _chk(False, f"{plan_id} was never proposed to the authority")}}
        checks["role"] = _chk(approver_role == APPROVER_ROLE, "approved by the Ops Commander" if approver_role == APPROVER_ROLE
                              else f"role '{approver_role}' may not approve plans")
        checks["current"] = _chk(p.version == self.latest_version and version == p.version,
                                 f"v{p.version} is the latest plan" if p.version == self.latest_version and version == p.version
                                 else f"superseded: latest plan is v{self.latest_version}")
        checks["world"] = _chk(p.world_version == self.world_version,
                               f"proposed at world version {p.world_version} (current)" if p.world_version == self.world_version
                               else f"stale: proposed at world version {p.world_version}, world is now v{self.world_version}")
        checks["bound"] = _chk(quoted_hash == p.hash and not p.consumed,
                               "approval quotes the authority's hash of this exact route" if quoted_hash == p.hash and not p.consumed
                               else ("approval already used" if p.consumed else "hash does not match the registered route"))
        live = self.check_route([self.frame.to_ll(xy) for xy in p.route_xy])   # re-verify against the world *now*
        checks.update(live["checks"])
        ok = all(c["ok"] for c in checks.values())
        self.log.append(("approve" if ok else "reject", plan_id, version, self.world_version, quoted_hash[:12]))
        if ok:
            p.approved_by, p.consumed = approver_role, True
        return {"ok": ok, "checks": checks, "plan": p if ok else None}

    # ---------------------------------------------------------------- world changes
    def close_segment(self, u: int, v: int, reason: str) -> int:
        self.closed.add(closure_key(u, v))
        self.world_version += 1
        self.log.append(("closed", u, v, self.world_version, reason))
        return self.world_version

    def pick_incident(self, nodes: list[int], target_node: int, lo: float = 0.35, hi: float = 0.7) -> int | None:
        """Index k of a route segment 35-70% along the route that can be bypassed from nodes[k]."""
        cum, total = [0.0], 0.0
        for i in range(len(nodes) - 1):
            total += _dist(self.graph.nodes[nodes[i]], self.graph.nodes[nodes[i + 1]])
            cum.append(total)
        for k in range(1, len(nodes) - 2):
            if not (lo <= cum[k] / max(total, 1e-6) <= hi):
                continue
            if _dist(self.graph.nodes[nodes[k]], self.graph.nodes[nodes[k + 1]]) < 12:
                continue
            kk = closure_key(nodes[k], nodes[k + 1])
            # the detour must satisfy the same rules the planner and this authority enforce: passable, open, and observed
            alt = self.graph.shortest(nodes[k], target_node, lambda u, e: e.grade >= 2 or closure_key(u, e.to) in self.closed or closure_key(u, e.to) == kk
                                      or not self.coverage.segment_covered(self.graph.nodes[u], self.graph.nodes[e.to]))
            if alt:
                return k
        return None

    def reset(self) -> None:
        self.coverage.reset()
        self.closed.clear()
        self.plans.clear()
        self.latest_version = 0
        self.world_version = 1
        self.log.clear()


def _chk(ok: bool, detail: str) -> dict:
    return {"ok": bool(ok), "detail": detail}


def _dist(a, b) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])
