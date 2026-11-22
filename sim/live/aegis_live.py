"""AegisLoop live link: ROS 2 nodes for the Antakya Gazebo world + the mission authority API for the web console.

Nodes (one process, MultiThreadedExecutor):
  uav_controller     FlyRoute action server  /uav/fly_route    -> /uav/cmd_vel  (Gazebo VelocityControl, kinematic flight)
  ugv_controller     FollowPath action server /ugv/follow_path -> /ugv/cmd_vel  (Gazebo DiffDrive, pure pursuit)
  mission_authority  drone coverage from /uav/odom, plan verification (authority_core), execution, incident injection

HTTP/WebSocket API on 127.0.0.1:8790 (the console reaches it as /api/live via the Vite proxy).
Started by sim/run_live.sh. Real vs simulated: robot motion is Gazebo physics; detection is modelled (camera footprint);
the in-mission obstruction is injected by this process and labelled simulated.
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import sys
import threading
import time

import rclpy
from rclpy.action import ActionClient, ActionServer, CancelResponse, GoalResponse
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from geometry_msgs.msg import Point, Twist
from nav_msgs.msg import Odometry
from rosgraph_msgs.msg import Clock
from aegisloop_interfaces.action import FlyRoute, FollowPath
from ros_gz_interfaces.msg import Entity
from ros_gz_interfaces.srv import DeleteEntity, SetEntityPose, SpawnEntity
from fastapi import FastAPI, WebSocket, WebSocketDisconnect   # module level: annotations are resolved from globals
from fastapi.responses import JSONResponse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from authority_core import Authority, Frame, RoadGraph, closure_key  # noqa: E402

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "public", "data", "antakya")
WORLD = "antakya_live"
PORT = int(os.environ.get("AEGIS_LIVE_PORT", "8790"))
UAV_ALT, UAV_SPEED, UAV_ENDURANCE_S = 60.0, 10.0, 18 * 60.0
UGV_SPEED = 1.0


def yaw_of(q) -> float:
    return math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z))


def wrap(a: float) -> float:
    return (a + math.pi) % (2 * math.pi) - math.pi


# ============================================================================ controllers
class UgvController(Node):
    """Pure-pursuit path follower for UGV-1. One active goal; a new goal or a cancel preempts it."""

    def __init__(self):
        super().__init__("ugv_controller")
        cb = ReentrantCallbackGroup()
        self.pub = self.create_publisher(Twist, "/ugv/cmd_vel", 10)
        self.create_subscription(Odometry, "/ugv/odom", self.on_odom, 20, callback_group=cb)
        self.pose = None
        self.active = 0
        self.diag = {}
        ActionServer(self, FollowPath, "/ugv/follow_path", execute_callback=self.execute, callback_group=cb,
                     goal_callback=lambda g: GoalResponse.ACCEPT, cancel_callback=lambda h: CancelResponse.ACCEPT)

    def on_odom(self, m: Odometry):
        p = m.pose.pose
        self.pose = (p.position.x, p.position.y, yaw_of(p.orientation))

    def stop(self):
        self.pub.publish(Twist())

    def execute(self, gh):
        self.active += 1
        me = self.active
        wps = [(p.x, p.y) for p in gh.request.waypoints]
        vmax = gh.request.max_speed or UGV_SPEED
        seg, travelled, last = 0, 0.0, None
        best_rem, best_t, stalls = math.inf, time.monotonic(), 0
        fb = FollowPath.Feedback()
        self.diag = {"plan": gh.request.plan_id, "waypoints": wps, "seg": 0, "stalls": 0}
        while rclpy.ok():
            if gh.is_cancel_requested or me != self.active:
                self.stop()
                if gh.is_cancel_requested:
                    gh.canceled()
                else:
                    gh.abort()
                return FollowPath.Result(success=False, outcome="cancelled", detail="preempted", distance_travelled=travelled)
            if self.pose is None or len(wps) < 2:
                time.sleep(0.05)
                continue
            x, y, yaw = self.pose
            if last:
                travelled += math.hypot(x - last[0], y - last[1])
            last = (x, y)
            if math.hypot(wps[-1][0] - x, wps[-1][1] - y) < 1.2:
                self.stop()
                gh.succeed()
                return FollowPath.Result(success=True, outcome="reached", detail="", distance_travelled=travelled)
            # advance along the path, then pick a look-ahead point 2.5 m further on
            # track the closest segment in a short window ahead (robust to overshoot at sharp corners)
            seg = min(range(seg, min(len(wps) - 1, seg + 2)), key=lambda k: _seg_dist((x, y), wps[k], wps[k + 1]))
            while seg < len(wps) - 2 and _proj_t((x, y), wps[seg], wps[seg + 1]) >= 1.0:
                seg += 1
            # remaining distance ALONG the route (straight-line distance to the goal can grow while progressing)
            rem = math.hypot(wps[seg + 1][0] - x, wps[seg + 1][1] - y) + sum(math.hypot(wps[k + 1][0] - wps[k][0], wps[k + 1][1] - wps[k][1]) for k in range(seg + 1, len(wps) - 1))
            if rem < best_rem - 0.5:
                best_rem, best_t = rem, time.monotonic()
            elif time.monotonic() - best_t > 8.0 and seg < len(wps) - 2:
                seg, best_t, stalls = seg + 1, time.monotonic(), stalls + 1     # no progress for 6 s wall: re-target the next vertex
                self.get_logger().warning(f"no progress near ({x:.1f}, {y:.1f}); re-targeting waypoint {seg + 1}")
            self.diag.update(seg=seg, stalls=stalls, pose=[x, y, yaw], remaining=rem)
            if seg < len(wps) - 2 and math.hypot(wps[seg + 1][0] - x, wps[seg + 1][1] - y) < 1.5:
                a1 = math.atan2(wps[seg + 1][1] - wps[seg][1], wps[seg + 1][0] - wps[seg][0])
                a2 = math.atan2(wps[seg + 2][1] - wps[seg + 1][1], wps[seg + 2][0] - wps[seg + 1][0])
                if abs(wrap(a2 - a1)) > math.radians(100):
                    seg += 1                                   # pivot onto the next segment (U-turn at a junction)
            tx, ty = _lookahead((x, y), wps, seg, 2.5)
            err = wrap(math.atan2(ty - y, tx - x) - yaw)
            cmd = Twist()
            if abs(err) > 0.8:
                cmd.angular.z = math.copysign(1.0, err)
            else:
                near = math.hypot(wps[seg + 1][0] - x, wps[seg + 1][1] - y)
                cmd.linear.x = vmax * max(0.25, 1 - abs(err) / 1.2) * (0.5 if near < 3.0 and seg < len(wps) - 2 else 1.0)
                cmd.angular.z = max(-1.2, min(1.2, 2.2 * err))
            self.pub.publish(cmd)
            fb.waypoint_index, fb.state = seg, "executing"
            fb.remaining_m = float(math.hypot(wps[-1][0] - x, wps[-1][1] - y))
            gh.publish_feedback(fb)
            time.sleep(0.02)
        return FollowPath.Result(success=False, outcome="aborted", detail="shutdown", distance_travelled=travelled)


class UavController(Node):
    """Waypoint flight for UAV-1 through Gazebo VelocityControl (yaw held at 0, so body = world axes)."""

    def __init__(self):
        super().__init__("uav_controller")
        cb = ReentrantCallbackGroup()
        self.pub = self.create_publisher(Twist, "/uav/cmd_vel", 10)
        self.create_subscription(Odometry, "/uav/odom", self.on_odom, 20, callback_group=cb)
        self.pose = None
        self.active = 0
        ActionServer(self, FlyRoute, "/uav/fly_route", execute_callback=self.execute, callback_group=cb,
                     goal_callback=lambda g: GoalResponse.ACCEPT, cancel_callback=lambda h: CancelResponse.ACCEPT)

    def on_odom(self, m: Odometry):
        p = m.pose.pose
        self.pose = (p.position.x, p.position.y, p.position.z, yaw_of(p.orientation))

    def execute(self, gh):
        self.active += 1
        me = self.active
        wps = [(p.x, p.y, p.z) for p in gh.request.waypoints]
        vmax = gh.request.max_speed or UAV_SPEED
        i = 0
        fb = FlyRoute.Feedback()
        while rclpy.ok():
            if gh.is_cancel_requested or me != self.active:
                self.pub.publish(Twist())
                if gh.is_cancel_requested:
                    gh.canceled()
                else:
                    gh.abort()
                return FlyRoute.Result(success=False, outcome="cancelled", finding="")
            if self.pose is None:
                time.sleep(0.05)
                continue
            x, y, z, yaw = self.pose
            tx, ty, tz = wps[i]
            dx, dy, dz = tx - x, ty - y, tz - z
            d = math.sqrt(dx * dx + dy * dy + dz * dz)
            if d < 2.0:
                i += 1
                if i >= len(wps):
                    self.pub.publish(Twist())
                    gh.succeed()
                    return FlyRoute.Result(success=True, outcome="done", finding="")
                continue
            v = min(vmax, 0.6 * d + 0.4)
            vx, vy, vz = dx / d * v, dy / d * v, dz / d * v
            c, s = math.cos(-yaw), math.sin(-yaw)          # world -> body
            cmd = Twist()
            cmd.linear.x, cmd.linear.y, cmd.linear.z = c * vx - s * vy, s * vx + c * vy, vz
            cmd.angular.z = -1.5 * yaw
            self.pub.publish(cmd)
            fb.waypoint_index, fb.remaining_m = i, float(d)
            gh.publish_feedback(fb)
            time.sleep(0.02)
        return FlyRoute.Result(success=False, outcome="aborted", finding="")


def _seg_dist(p, a, b) -> float:
    t = max(0.0, min(1.0, _proj_t(p, a, b)))
    return math.hypot(p[0] - a[0] - t * (b[0] - a[0]), p[1] - a[1] - t * (b[1] - a[1]))


def _proj_t(p, a, b) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = dx * dx + dy * dy
    return ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L if L else 1.0


def _lookahead(p, wps, seg, ahead):
    a, b = wps[seg], wps[seg + 1]
    t = max(0.0, min(1.0, _proj_t(p, a, b)))
    cx, cy = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
    left, k, px, py = ahead, seg + 1, cx, cy
    while k < len(wps):
        L = math.hypot(wps[k][0] - px, wps[k][1] - py)
        if L >= left:
            return (px + (wps[k][0] - px) * left / L, py + (wps[k][1] - py) * left / L)
        left -= L
        px, py = wps[k]
        k += 1
    return wps[-1]


# ============================================================================ mission authority
class MissionAuthority(Node):
    def __init__(self, emit):
        super().__init__("mission_authority")
        self.emit = emit
        meta = json.load(open(os.path.join(DATA, "meta.json")))
        self.frame = Frame(*meta["center"])
        self.graph = RoadGraph(json.load(open(os.path.join(DATA, "roads.geojson"))), self.frame)
        self.core = Authority(self.graph, self.frame)
        self.lock = threading.RLock()
        cb = ReentrantCallbackGroup()
        self.create_subscription(Odometry, "/uav/odom", self.on_uav, 20, callback_group=cb)
        self.create_subscription(Odometry, "/ugv/odom", self.on_ugv, 20, callback_group=cb)
        self.create_subscription(Clock, "/clock", self.on_clock, 10, callback_group=cb)
        self.fly = ActionClient(self, FlyRoute, "/uav/fly_route", callback_group=cb)
        self.follow = ActionClient(self, FollowPath, "/ugv/follow_path", callback_group=cb)
        self.set_pose = self.create_client(SetEntityPose, f"/world/{WORLD}/set_pose", callback_group=cb)
        self.spawn = self.create_client(SpawnEntity, f"/world/{WORLD}/create", callback_group=cb)
        self.remove = self.create_client(DeleteEntity, f"/world/{WORLD}/remove", callback_group=cb)
        self.sim_t, self._clk = 0.0, []
        self.uav = {"x": 3.0, "y": 0.0, "z": 0.3, "hdg": 0.0, "speed": 0.0, "battery": 1.0, "mode": "on pad"}
        self.ugv = {"x": 0.0, "y": 0.0, "hdg": 0.0, "speed": 0.0, "battery": 1.0, "mode": "idle"}
        self._uav_prev = self._ugv_prev = None
        self.staging = (0.0, 0.0)
        self.uav_goal = self.ugv_goal = None
        self.exec = None          # {"plan", "nodes", "incident_k", "progress"}
        self.incidents = 0
        self.debris: list[str] = []
        self.incident_enabled = True

    # ------------------------------------------------------------ telemetry
    def on_clock(self, m: Clock):
        t = m.clock.sec + m.clock.nanosec * 1e-9
        dt = t - self.sim_t if self.sim_t else 0.0
        self.sim_t = t
        now = time.monotonic()
        self._clk.append((now, t))
        self._clk = [c for c in self._clk if now - c[0] < 3.0]
        with self.lock:
            if self.uav["z"] > 1.0 and dt > 0:
                self.uav["battery"] = max(0.0, self.uav["battery"] - dt / UAV_ENDURANCE_S)
            if self.ugv["speed"] > 0.05 and dt > 0:
                self.ugv["battery"] = max(0.0, self.ugv["battery"] - dt / (8 * 3600.0))

    @property
    def rtf(self) -> float:
        if len(self._clk) < 2:
            return 0.0
        (w0, s0), (w1, s1) = self._clk[0], self._clk[-1]
        return (s1 - s0) / (w1 - w0) if w1 > w0 else 0.0

    def on_uav(self, m: Odometry):
        p = m.pose.pose.position
        with self.lock:
            prev = self._uav_prev
            if prev:
                d = math.hypot(p.x - prev[0], p.y - prev[1])
                if d > 0.05:
                    self.uav["hdg"] = math.atan2(p.x - prev[0], p.y - prev[1])
            self._uav_prev = (p.x, p.y)
            self.uav.update(x=p.x, y=p.y, z=p.z, speed=math.hypot(m.twist.twist.linear.x, m.twist.twist.linear.y))
            self.core.coverage.add_pose(p.x, p.y, p.z)        # the only source of "observed"

    def on_ugv(self, m: Odometry):
        p = m.pose.pose
        with self.lock:
            self.ugv.update(x=p.position.x, y=p.position.y, hdg=math.pi / 2 - yaw_of(p.orientation),
                            speed=math.hypot(m.twist.twist.linear.x, m.twist.twist.linear.y))
            ex = self.exec
        if ex and ex.get("incident_k") is not None:
            self._watch_incident(ex)

    def telemetry(self) -> dict:
        with self.lock:
            u, g = dict(self.uav), dict(self.ugv)
            cov = {"cells": len(self.core.coverage.cells), "samples": self.core.coverage.samples}
            wv = self.core.world_version
        return {"type": "telemetry", "simTime": round(self.sim_t, 2), "rtf": round(self.rtf, 2), "worldVersion": wv, "coverage": cov,
                "uav": {"at": self.frame.to_ll((u["x"], u["y"])), "alt": round(u["z"], 1), "hdg": math.degrees(u["hdg"]), "speed": round(u["speed"], 2), "battery": round(u["battery"], 4), "mode": u["mode"]},
                "ugv": {"at": self.frame.to_ll((g["x"], g["y"])), "hdg": math.degrees(g["hdg"]), "speed": round(g["speed"], 2), "battery": round(g["battery"], 4), "mode": g["mode"]}}

    # ------------------------------------------------------------ helpers
    def _call(self, client, req, timeout=5.0):
        if not client.wait_for_service(timeout_sec=timeout):
            raise RuntimeError(f"{client.srv_name} unavailable")
        fut = client.call_async(req)
        t0 = time.monotonic()
        while not fut.done() and time.monotonic() - t0 < timeout:
            time.sleep(0.02)
        return fut.result()

    def _teleport(self, name, x, y, z):
        req = SetEntityPose.Request()
        req.entity.name, req.entity.type = name, Entity.MODEL
        req.pose.position.x, req.pose.position.y, req.pose.position.z = float(x), float(y), float(z)
        req.pose.orientation.w = 1.0
        return self._call(self.set_pose, req)

    def _send(self, client, goal, kind, on_done=None):
        if not client.wait_for_server(timeout_sec=5.0):
            raise RuntimeError(f"{kind} action server unavailable")
        fut = client.send_goal_async(goal)

        def accepted(f):
            gh = f.result()
            if kind == "uav":
                self.uav_goal = gh
            else:
                self.ugv_goal = gh
            if on_done and gh.accepted:
                gh.get_result_async().add_done_callback(lambda r: on_done(r.result().result, r.result().status))
        fut.add_done_callback(accepted)

    def _cancel(self, kind):
        gh = self.uav_goal if kind == "uav" else self.ugv_goal
        if gh is not None:
            gh.cancel_goal_async()
        if kind == "uav":
            self.uav_goal = None
        else:
            self.ugv_goal = None

    def _fly(self, pts_xyz, mode, on_done=None):
        g = FlyRoute.Goal()
        g.task_id, g.mode, g.max_speed = f"uav-{mode}-{int(time.time())}", mode, float(UAV_SPEED)
        g.waypoints = [Point(x=float(x), y=float(y), z=float(z)) for x, y, z in pts_xyz]
        with self.lock:
            self.uav["mode"] = mode
        self._send(self.fly, g, "uav", on_done)

    def _orbit(self, cx, cy, laps=40):
        pts = [(cx + 60 * math.cos(a / 12 * 2 * math.pi), cy + 60 * math.sin(a / 12 * 2 * math.pi), UAV_ALT) for a in range(12 * laps)]
        self._fly(pts, "overwatch")

    def _maybe_rtl(self):
        with self.lock:
            low = self.uav["battery"] <= 0.25 and self.uav["mode"] == "overwatch"
        if low:
            sx, sy = self.staging
            self.emit({"type": "log", "actor": "x500", "action": "Return to staging", "detail": "Battery reserve reached (25%) · overwatch handed to ground unit sensors"})
            self._fly([(self.uav["x"], self.uav["y"], UAV_ALT), (sx, sy, UAV_ALT), (sx + 3, sy, 0.4)], "rtl",
                      lambda r, s: self._set_uav_mode("landed · reserve"))

    def _set_uav_mode(self, mode):
        with self.lock:
            self.uav["mode"] = mode

    # ------------------------------------------------------------ commands
    def reset(self, staging_ll):
        self._cancel("uav")
        self._cancel("ugv")
        sx, sy = self.frame.to_xy(staging_ll)
        self.staging = (sx, sy)
        for name in self.debris:
            try:
                req = DeleteEntity.Request()
                req.entity.name, req.entity.type = name, Entity.MODEL
                self._call(self.remove, req)
            except Exception:
                pass
        self.debris.clear()
        time.sleep(0.3)
        self._teleport("rover_1", sx, sy, 0.05)
        self._teleport("drone_1", sx + 3, sy, 0.4)
        with self.lock:
            self.core.reset()
            self.exec, self.incidents = None, 0
            self.uav.update(battery=1.0, mode="on pad")
            self.ugv.update(battery=1.0, mode="ready at staging")
        return {"ok": True, "staging": [sx, sy]}

    def survey(self, path_ll, alt=UAV_ALT):
        sx, sy = self.staging
        pts = [(sx + 3, sy, alt)] + [(*self.frame.to_xy(p), alt) for p in path_ll] + [(sx + 3, sy, alt), (sx + 3, sy, 0.4)]

        def done(result, status):
            if not result.success:
                return
            with self.lock:
                self.uav.update(mode="landed · battery swapped", battery=1.0)
                cov = len(self.core.coverage.cells)
            self.emit({"type": "survey_complete", "coverageCells": cov, "success": bool(result.success)})
        self._fly(pts, "survey", done)
        return {"ok": True, "waypoints": len(pts)}

    def swap_battery(self):
        with self.lock:
            if self.uav["z"] < 1.5:
                self.uav.update(battery=1.0, mode="landed · battery swapped")
        return {"ok": True}

    def propose(self, body):
        with self.lock:
            return self.core.propose(body["planId"], int(body["version"]), body["target"], body["options"], body.get("chosen", "verified"))

    def approve(self, body):
        with self.lock:
            res = self.core.approve(body["planId"], int(body["version"]), body["hash"], body.get("approverRole", ""))
        if not res["ok"]:
            self.emit({"type": "log", "actor": "authority", "action": "Approval rejected", "detail": "; ".join(c["detail"] for c in res["checks"].values() if not c["ok"])})
            return {"ok": False, "checks": res["checks"]}
        plan = res["plan"]
        k = None
        with self.lock:
            if self.incident_enabled and self.incidents == 0:
                k = self.core.pick_incident(plan.nodes, plan.nodes[-1])
            pts = [self.graph.nodes[n] for n in plan.nodes]
            cum = [0.0]
            for i in range(len(pts) - 1):
                cum.append(cum[-1] + math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]))
            self.exec = {"plan": plan.plan_id, "nodes": plan.nodes, "incident_k": k, "progress": 0, "pts": pts, "cum": cum, "s": 0.0}
            self.ugv["mode"] = f"executing {plan.plan_id}"
        g = FollowPath.Goal()
        g.plan_id, g.plan_version, g.max_speed = plan.plan_id, plan.version, float(UGV_SPEED)
        g.waypoints = [Point(x=float(x), y=float(y), z=0.0) for x, y in plan.route_xy]

        def done(result, status):
            if result.success:
                with self.lock:
                    self.exec = None
                    self.ugv["mode"] = f"arrived · {plan.target}"
                self.emit({"type": "arrived", "plan": plan.plan_id, "target": plan.target, "travelled": round(result.distance_travelled, 1)})
        self._send(self.follow, g, "ugv", done)
        tx, ty = self.graph.nodes[plan.nodes[-1]]
        self._orbit(tx, ty)
        self.emit({"type": "log", "actor": "authority", "action": "Approval verified", "detail": f"{plan.plan_id} v{plan.version} · {len(plan.nodes) - 1} segments observed and passable · world v{plan.world_version} · FollowPath goal sent to /ugv/follow_path"})
        return {"ok": True, "checks": res["checks"], "incidentPlanned": k is not None}

    # ------------------------------------------------------------ incident (simulated, injected into Gazebo)
    def _watch_incident(self, ex):
        """Progress = rover position projected onto the route (robust to corner-cutting); fire at the incident vertex."""
        nodes, k, pts, cum = ex["nodes"], ex["incident_k"], ex["pts"], ex["cum"]
        with self.lock:
            x, y = self.ugv["x"], self.ugv["y"]
        lo, hi = ex["progress"], min(len(pts) - 1, ex["progress"] + 6)
        best = None
        for i in range(lo, hi):
            a, b = pts[i], pts[i + 1]
            dx, dy = b[0] - a[0], b[1] - a[1]
            L2 = dx * dx + dy * dy
            t = max(0.0, min(1.0, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)) if L2 else 0.0
            d = math.hypot(x - a[0] - t * dx, y - a[1] - t * dy)
            if best is None or d < best[0]:
                best = (d, i, cum[i] + t * math.sqrt(L2))
        if best and best[0] < 15.0:
            ex["progress"], ex["s"] = best[1], max(ex["s"], best[2])
        if ex["s"] >= cum[k] - 2.0:
            ex["incident_k"] = None
            threading.Thread(target=self._raise_incident, args=(nodes, k), daemon=True).start()

    def _raise_incident(self, nodes, k):
        self._cancel("ugv")
        u, v = nodes[k], nodes[k + 1]
        a, b = self.graph.nodes[u], self.graph.nodes[v]
        mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        yaw = math.atan2(b[1] - a[1], b[0] - a[0]) + math.pi / 2
        name = f"debris_incident_{self.incidents + 1}"
        sdf = (f'<sdf version="1.9"><model name="{name}"><static>true</static><link name="l">'
               f'<collision name="c"><geometry><box><size>7 2.5 1.6</size></box></geometry></collision>'
               f'<visual name="v"><geometry><box><size>7 2.5 1.6</size></box></geometry><material><ambient>0.55 0.25 0.2 1</ambient><diffuse>0.6 0.3 0.22 1</diffuse></material></visual>'
               f'</link></model></sdf>')
        req = SpawnEntity.Request()
        req.entity_factory.name, req.entity_factory.sdf = name, sdf
        req.entity_factory.pose.position.x, req.entity_factory.pose.position.y, req.entity_factory.pose.position.z = mx, my, 0.8
        req.entity_factory.pose.orientation.z, req.entity_factory.pose.orientation.w = math.sin(yaw / 2), math.cos(yaw / 2)
        try:
            self._call(self.spawn, req)
            self.debris.append(name)
        except Exception as exc:
            self.get_logger().warning(f"debris spawn failed: {exc}")
        road = self.graph.names[self.graph.edge(u, v).road] if self.graph.edge(u, v) else "a street"
        with self.lock:
            wv = self.core.close_segment(u, v, "debris reported by UAV-1 (simulated)")
            self.incidents += 1
            self.exec = None
            self.ugv["mode"] = "holding · obstruction ahead"
        self._orbit(mx, my)
        self.emit({"type": "incident", "simulated": True, "edge": [self.frame.to_ll(a), self.frame.to_ll(b)], "at": self.frame.to_ll((mx, my)),
                   "road": road, "worldVersion": wv, "holdAt": self.frame.to_ll(a), "gazeboEntity": name})


# ============================================================================ API
def build_app(auth: MissionAuthority, clients: set, loop_ref: dict):
    app = FastAPI(title="AegisLoop live link")

    async def run(fn, *a):
        return await asyncio.get_running_loop().run_in_executor(None, fn, *a)

    @app.get("/api/live/status")
    async def status():
        t = auth.telemetry()
        return {"connected": auth.sim_t > 0, "world": WORLD, "simTime": t["simTime"], "rtf": t["rtf"], "worldVersion": t["worldVersion"],
                "nodes": ["uav_controller", "ugv_controller", "mission_authority"], "actions": ["/uav/fly_route", "/ugv/follow_path"]}

    @app.get("/api/live/debug")
    async def debug():
        ugv = auth._ugv_node.diag if getattr(auth, "_ugv_node", None) else {}
        return {"ugvController": ugv, "exec": {k: v for k, v in (auth.exec or {}).items() if k != "nodes"}, "worldVersion": auth.core.world_version,
                "staging": auth.staging, "ugv": auth.ugv, "uav": auth.uav, "log": [list(map(str, e)) for e in auth.core.log[-10:]]}

    @app.post("/api/live/reset")
    async def reset(body: dict):
        return await run(auth.reset, body["staging"])

    @app.post("/api/live/survey")
    async def survey(body: dict):
        return await run(auth.survey, body["path"], float(body.get("alt", UAV_ALT)))

    @app.post("/api/live/swap")
    async def swap():
        return await run(auth.swap_battery)

    @app.post("/api/live/propose")
    async def propose(body: dict):
        return await run(auth.propose, body)

    @app.post("/api/live/approve")
    async def approve(body: dict):
        r = await run(auth.approve, body)
        return r if r["ok"] else JSONResponse(r, status_code=409)

    @app.websocket("/api/live/ws")
    async def ws(sock: WebSocket):
        await sock.accept()
        q: asyncio.Queue = asyncio.Queue(maxsize=200)
        clients.add(q)
        try:
            while True:
                msg = await q.get()
                await sock.send_text(json.dumps(msg))
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            clients.discard(q)

    @app.on_event("startup")
    async def start():
        loop_ref["loop"] = asyncio.get_running_loop()

        async def tick():
            n = 0
            while True:
                await asyncio.sleep(0.1)
                n += 1
                t = auth.telemetry()
                for q in list(clients):
                    if not q.full():
                        q.put_nowait(t)
                if n % 10 == 0:
                    await asyncio.get_running_loop().run_in_executor(None, auth._maybe_rtl)
        asyncio.create_task(tick())

    return app


def main():
    rclpy.init(args=sys.argv)
    clients: set = set()
    loop_ref: dict = {}

    def emit(msg):
        loop = loop_ref.get("loop")
        if loop:
            for q in list(clients):
                loop.call_soon_threadsafe(lambda q=q: (not q.full()) and q.put_nowait(msg))

    auth = MissionAuthority(emit)
    ugv_node = UgvController()
    auth._ugv_node = ugv_node
    nodes = [UavController(), ugv_node, auth]
    ex = MultiThreadedExecutor(num_threads=8)
    for n in nodes:
        ex.add_node(n)
    threading.Thread(target=ex.spin, daemon=True).start()
    import uvicorn
    print(f"[aegis-live] mission authority on http://127.0.0.1:{PORT} · world {WORLD} · {len(auth.graph.nodes)} road nodes", flush=True)
    uvicorn.run(build_app(auth, clients, loop_ref), host="127.0.0.1", port=PORT, log_level="warning")
    ex.shutdown()
    rclpy.shutdown()


if __name__ == "__main__":
    main()
