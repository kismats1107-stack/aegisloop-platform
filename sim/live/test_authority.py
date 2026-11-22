"""Verification tests for the mission authority, on the real Antakya road network (Copernicus EMSR648).

    ~/aegisloop_venv/bin/python -m pytest -q sim/live/test_authority.py
"""
import json
import os

import pytest

from authority_core import Authority, Coverage, Frame, RoadGraph, closure_key

DATA = os.path.join(os.path.dirname(__file__), "..", "..", "public", "data", "antakya")


@pytest.fixture(scope="module")
def world():
    meta = json.load(open(os.path.join(DATA, "meta.json")))
    roads = json.load(open(os.path.join(DATA, "roads.geojson")))
    frame = Frame(*meta["center"])
    graph = RoadGraph(roads, frame)
    mb = meta["missionBounds"]
    lo, hi = frame.to_xy((mb[0], mb[1])), frame.to_xy((mb[2], mb[3]))
    inside = [i for i, p in enumerate(graph.nodes) if lo[0] < p[0] < hi[0] and lo[1] < p[1] < hi[1] and graph.adj[i]]
    safe = lambda u, e: e.grade >= 2
    # a pair where the shortest route crosses graded-impassable roads but a verified route exists (like staging -> C-1)
    for s in inside[::7]:
        for t in inside[::11]:
            if s == t:
                continue
            direct, verified = graph.shortest(s, t), graph.shortest(s, t, safe)
            if direct and verified and any(graph.edge(direct[i], direct[i + 1]).grade >= 2 for i in range(len(direct) - 1)) and len(verified) > 4:
                return dict(frame=frame, graph=graph, lo=lo, hi=hi, direct=direct, verified=verified, target=t)
    pytest.fail("no direct/verified pair found in the sector")


def ll(w, nodes):
    return [w["frame"].to_ll(w["graph"].nodes[n]) for n in nodes]


def survey(cov: Coverage, lo, hi, alt=60.0, pad=200.0):
    """Coverage as produced by real drone odometry: a lawn-mower pattern at survey altitude."""
    y = lo[1] - pad
    while y <= hi[1] + pad:
        x = lo[0] - pad
        while x <= hi[0] + pad:
            cov.add_pose(x, y, alt)
            x += 4.0
        y += 80.0


def authority(w, surveyed=True):
    a = Authority(w["graph"], w["frame"])
    if surveyed:
        survey(a.coverage, w["lo"], w["hi"])
    return a


def test_road_graph_built_from_copernicus(world):
    assert len(world["graph"].nodes) > 1000
    assert sum(len(a) for a in world["graph"].adj) > 1000


def test_unobserved_route_is_rejected(world):
    a = authority(world, surveyed=False)
    r = a.propose("PLN-001", 1, "C-1", [{"id": "verified", "route": ll(world, world["verified"])}], "verified")
    assert not r["options"]["verified"]["checks"]["observed"]["ok"]
    res = a.approve("PLN-001", 1, r["hash"], "ops-commander")
    assert not res["ok"] and not res["checks"]["observed"]["ok"]


def test_survey_altitude_matters(world):
    a = authority(world, surveyed=False)
    survey(a.coverage, world["lo"], world["hi"], alt=5.0)        # taxiing / landing poses are not observations
    assert not a.check_route(ll(world, world["verified"]))["checks"]["observed"]["ok"]


def test_observed_passable_route_is_approved_once(world):
    a = authority(world)
    r = a.propose("PLN-001", 1, "C-1", [{"id": "verified", "route": ll(world, world["verified"])}], "verified")
    assert r["options"]["verified"]["ok"]
    assert a.approve("PLN-001", 1, r["hash"], "ops-commander")["ok"]
    again = a.approve("PLN-001", 1, r["hash"], "ops-commander")
    assert not again["ok"] and "already used" in again["checks"]["bound"]["detail"]


def test_direct_route_through_graded_damage_is_rejected(world):
    a = authority(world)
    r = a.propose("PLN-001", 1, "C-1", [{"id": "direct", "route": ll(world, world["direct"])}, {"id": "verified", "route": ll(world, world["verified"])}], "direct")
    assert not r["options"]["direct"]["checks"]["passable"]["ok"]
    assert r["options"]["verified"]["checks"]["passable"]["ok"]
    assert not a.approve("PLN-001", 1, r["hash"], "ops-commander")["ok"]


def test_stale_approval_after_world_change(world):
    a = authority(world)
    r = a.propose("PLN-001", 1, "C-1", [{"id": "verified", "route": ll(world, world["verified"])}], "verified")
    v = world["verified"]
    a.close_segment(v[-2], v[-1], "debris reported by UAV-1")          # world version 1 -> 2
    res = a.approve("PLN-001", 1, r["hash"], "ops-commander")
    assert not res["ok"]
    assert "stale" in res["checks"]["world"]["detail"]
    assert not res["checks"]["passable"]["ok"]                          # and the route itself is now closed


def test_superseded_plan_cannot_be_approved(world):
    a = authority(world)
    r1 = a.propose("PLN-001", 1, "C-1", [{"id": "verified", "route": ll(world, world["verified"])}], "verified")
    a.propose("PLN-002", 2, "C-1", [{"id": "verified", "route": ll(world, world["verified"])}], "verified")
    res = a.approve("PLN-001", 1, r1["hash"], "ops-commander")
    assert not res["ok"] and "superseded" in res["checks"]["current"]["detail"]


def test_tampered_hash_and_wrong_role(world):
    a = authority(world)
    r = a.propose("PLN-001", 1, "C-1", [{"id": "verified", "route": ll(world, world["verified"])}], "verified")
    bad = a.approve("PLN-001", 1, "0" * 64, "ops-commander")
    assert not bad["ok"] and not bad["checks"]["bound"]["ok"]
    lead = a.approve("PLN-001", 1, r["hash"], "field-lead")
    assert not lead["ok"] and not lead["checks"]["role"]["ok"]
    assert a.approve("PLN-001", 1, r["hash"], "ops-commander")["ok"]   # rejections do not consume the plan


def test_route_off_the_road_network_is_rejected(world):
    a = authority(world)
    pts = ll(world, world["verified"])
    off = [pts[0], (pts[0][0] + 0.002, pts[0][1] + 0.002), pts[-1]]   # cuts through blocks
    assert not a.check_route(off)["checks"]["on_network"]["ok"]


def test_hash_binds_route_and_world_version(world):
    a = authority(world)
    pts = [world["graph"].nodes[n] for n in world["verified"]]
    h1 = a.canonical_hash("PLN-001", 1, "C-1", pts, 1)
    assert h1 == a.canonical_hash("PLN-001", 1, "C-1", pts, 1)
    assert h1 != a.canonical_hash("PLN-001", 1, "C-1", pts[:-1], 1)
    assert h1 != a.canonical_hash("PLN-001", 1, "C-1", pts, 2)


def test_incident_pick_has_a_bypass(world):
    a = authority(world)
    k = a.pick_incident(world["verified"], world["target"])
    if k is None:
        pytest.skip("route too short for a bypassable incident")
    v = world["verified"]
    key = closure_key(v[k], v[k + 1])
    alt = world["graph"].shortest(v[k], world["target"], lambda u, e: e.grade >= 2 or closure_key(u, e.to) == key)
    assert alt and all(closure_key(alt[i], alt[i + 1]) != key for i in range(len(alt) - 1))
