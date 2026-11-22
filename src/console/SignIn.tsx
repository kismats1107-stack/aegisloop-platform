// Console sign-in: each team member has their own access code (kept on the server). Asked every time the console opens;
// the signed session lives only in memory for this visit.
import { useEffect, useState } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import { Logo } from "../components/Shell";
import type { TeamMember } from "./TeamChat";

export interface Session { token: string; user: TeamMember }
let current: Session | null = null;
/** Session of the signed-in member (used by the chat and mission-event calls). */
export const getSession = () => current;
export const setSession = (s: Session | null) => { current = s; };
export const authHeaders = (): Record<string, string> => (current ? { Authorization: `Bearer ${current.token}` } : {});

const NOTE: Record<string, string> = {
  "ops-commander": "Approves or rejects plans",
  "field-lead": "Leads the USAR team on the ground",
  "uav-pilot": "Safety pilot for the X500",
  "ugv-operator": "Supervises the Husky A300",
  "medical-liaison": "Coordinates casualties",
};
const initials = (n: string) => n.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();

export function SignIn({ onSignedIn }: { onSignedIn: (s: Session) => void }) {
  const [roster, setRoster] = useState<TeamMember[]>([]);
  const [pick, setPick] = useState("ops-commander");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    fetch("/api/nx/status").then((r) => r.json()).then((j: { roster: TeamMember[]; signin?: boolean }) => {
      setRoster(j.roster);
      if (j.signin === false) setErr("Sign-in is not set up on the server: add AEGIS_CODE_* to .env.");
    }).catch(() => setOffline(true));
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      const r = await fetch("/api/nx/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: pick, code }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Sign-in failed (${r.status})`);
      const s = { token: j.session as string, user: j.user as TeamMember };
      setSession(s); onSignedIn(s);
    } catch (ex) { setErr(ex instanceof Error ? ex.message : "Sign-in failed"); setCode(""); }
    finally { setBusy(false); }
  };
  return (
    <div className="si" role="dialog" aria-modal="true" aria-labelledby="si-title">
      <form className="si-card" onSubmit={submit}>
        <div className="si-head"><Logo size={26} /><span className="si-chip"><ShieldCheck size={13} aria-hidden />Operations console</span></div>
        <h1 id="si-title">Sign in to the mission</h1>
        <p className="si-sub">Choose your role and enter your personal access code. Every command, approval and message is recorded under your name.</p>
        {offline ? <p className="si-err" role="alert">The team server is not reachable. Start it with <code>npm start</code>.</p> : (
          <div className="si-roles" role="radiogroup" aria-label="Your role">
            {roster.map((m) => (
              <label key={m.id} className={`si-role ${pick === m.id ? "on" : ""}`}>
                <input type="radio" name="role" value={m.id} checked={pick === m.id} onChange={() => { setPick(m.id); setErr(""); }} />
                <span className={`si-av r-${m.id}`}>{initials(m.name)}</span>
                <span><b>{m.name}</b><small>{NOTE[m.id] ?? m.role}</small></span>
                {m.id === "ops-commander" && <em>Approver</em>}
              </label>
            ))}
          </div>
        )}
        <label className="si-field"><span>Access code</span>
          <input type="password" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. ORION-4821-7F3A" autoComplete="current-password" autoFocus required disabled={offline} />
        </label>
        {err && <p className="si-err" role="alert">{err}</p>}
        <button className="btn btn-primary si-btn" disabled={busy || offline || !roster.length || !code.trim()}><Lock size={15} aria-hidden />{busy ? "Checking…" : "Sign in"}</button>
        <p className="si-foot">Codes are issued per person by the mission administrator and checked on the server. You are asked again each time the console opens.</p>
      </form>
    </div>
  );
}
