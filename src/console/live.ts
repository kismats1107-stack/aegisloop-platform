// Client for the AegisLoop live link (sim/live/aegis_live.py): ROS 2 + Gazebo behind a mission authority.
// Telemetry and events arrive over a WebSocket; commands are REST calls. The authority, not the browser, decides
// whether a plan may be executed.
import type { LngLat } from "../lib/geo";

export interface Check { ok: boolean; detail: string }
export interface LiveUnit { at: LngLat; alt?: number; hdg: number; speed: number; battery: number; mode: string }
export interface Telemetry { simTime: number; rtf: number; worldVersion: number; coverage: { cells: number; samples: number }; uav: LiveUnit; ugv: LiveUnit }
export interface ProposeResult { hash: string; worldVersion: number; options: Record<string, { ok: boolean; checks: Record<string, Check>; length: number }> }
export interface ApproveResult { ok: boolean; checks: Record<string, Check>; incidentPlanned?: boolean }
export type LiveEvent =
  | { type: "survey_complete"; coverageCells: number; success: boolean }
  | { type: "incident"; simulated: true; edge: [LngLat, LngLat]; at: LngLat; road: string; worldVersion: number; holdAt: LngLat; gazeboEntity: string }
  | { type: "arrived"; plan: string; target: string; travelled: number }
  | { type: "log"; actor: string; action: string; detail: string };

export interface LiveStatus { connected: boolean; world: string; simTime: number; rtf: number; worldVersion: number; nodes: string[]; actions: string[] }

const post = async <T>(path: string, body: unknown = {}): Promise<T> => {
  const r = await fetch(`/api/live/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 409) throw new Error(j.detail || `live ${path}: HTTP ${r.status}`);
  return j as T;
};

export async function liveStatus(): Promise<LiveStatus | null> {
  try {
    const r = await fetch("/api/live/status", { signal: AbortSignal.timeout(2500) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

export class LiveLink {
  telemetry: Telemetry | null = null;
  private ws: WebSocket | null = null;
  private subs = new Set<(e: LiveEvent) => void>();
  private closed = false;

  connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const open = () => {
      if (this.closed) return;
      this.ws = new WebSocket(`${proto}://${location.host}/api/live/ws`);
      this.ws.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.type === "telemetry") this.telemetry = d as Telemetry;
        else this.subs.forEach((f) => f(d as LiveEvent));
      };
      this.ws.onclose = () => { if (!this.closed) setTimeout(open, 1000); };
    };
    open();
    return this;
  }
  close() { this.closed = true; this.ws?.close(); }
  on(f: (e: LiveEvent) => void) { this.subs.add(f); return () => this.subs.delete(f); }

  reset(staging: LngLat) { return post<{ ok: boolean }>("reset", { staging }); }
  survey(path: LngLat[], alt: number) { return post<{ ok: boolean }>("survey", { path, alt }); }
  swap() { return post<{ ok: boolean }>("swap"); }
  propose(body: { planId: string; version: number; target: string; options: { id: string; route: LngLat[] }[]; chosen: string }) { return post<ProposeResult>("propose", body); }
  approve(body: { planId: string; version: number; hash: string; approverRole: string }) { return post<ApproveResult>("approve", body); }
}
