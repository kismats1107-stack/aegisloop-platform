/**
 * Mission team channel on the official Nexconn Web Chat SDK (@nexconn/chat).
 * Tokens are issued per team member by our collaboration server (server/nexconn-server.mjs);
 * the App Secret never reaches the browser. Chat carries discussion only — approval stays a separate, hash-bound action.
 */
import {
  BaseChannel, ConnectionStatus, ConnectionStatusHandler, GroupChannel, GroupChannelIdentifier,
  MessageHandler, NCEngine, SendTextMessageParams, type Message,
} from "@nexconn/chat";
import { useEffect, useRef, useState } from "react";
import { Lock, Send } from "lucide-react";
import { authHeaders, getSession } from "./SignIn";

export interface TeamMember { id: string; name: string; role: string }
interface NxInfo { configured: boolean; status: string; error: string; appKey: string | null; areaCode: number; channel: { id: string; name: string }; bot: { id: string; name: string }; roster: TeamMember[] }
interface ChatMsg { id: string; from: string; text: string; at: number; channel: string }
type Link = "idle" | "connecting" | "connected" | "disconnected" | "error";

// The SDK is a singleton: initialise once per page, fan events out to mounted panels.
let initialisedKey: string | null = null, connectedAs: string | null = null;
const msgSubs = new Set<(m: Message[]) => void>(), statusSubs = new Set<(s: Link) => void>();
const toMsg = (m: Message): ChatMsg => {
  const c = (m.content ?? {}) as { text?: string; content?: string };
  return { id: m.messageId || `${m.senderUserId}-${m.sentTime}`, from: m.senderUserId, text: c.text ?? c.content ?? `[${m.messageType}]`, at: m.sentTime,
    channel: (m.channelIdentifier as unknown as { channelId?: string })?.channelId ?? "" };
};
const QUICK = ["Copy.", "Hold position.", "Clear to proceed once approved.", "Medical team standing by."];

/** Posts a mission event to the channel as the AegisLoop bot (server-signed). */
export function postMissionEvent(kind: string, text: string) {
  fetch("/api/nx/event", { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify({ kind, text }) }).catch(() => {});
}

export function TeamChat({ active, onUnread }: { active: boolean; onUnread: (n: number) => void }) {
  const [info, setInfo] = useState<NxInfo | null>(null);
  const me: TeamMember | null = getSession()?.user ?? null;   // the signed-in member
  const [link, setLink] = useState<Link>(connectedAs ? "connected" : "idle");
  const [err, setErr] = useState("");
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState("");
  const [unread, setUnread] = useState(0);
  const end = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active); activeRef.current = active;

  useEffect(() => { fetch("/api/nx/status").then((r) => r.json()).then((j: NxInfo) => {
    setInfo(j);
  }).catch(() => setErr("Collaboration server unreachable (npm run nexconn)")); }, []);
  useEffect(() => { if (active) setUnread(0); }, [active]);
  useEffect(() => { onUnread(unread); }, [unread, onUnread]);

  // connect as the chosen team member
  useEffect(() => {
    if (!info?.configured || !me || connectedAs === me.id) return;
    let cancelled = false;
    (async () => {
      setLink("connecting"); setErr("");
      try {
        const r = await fetch("/api/nx/session", { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify({}) });
        const s = await r.json(); if (!r.ok) throw new Error(s.error || `HTTP ${r.status}`);
        if (initialisedKey !== s.appKey) {
          NCEngine.initialize({ appKey: s.appKey, ...(s.areaCode ? { areaCode: s.areaCode as never } : {}) });
          initialisedKey = s.appKey;
          NCEngine.addConnectionStatusHandler("aegis", new ConnectionStatusHandler({ onConnectionStatusChanged({ status }) {
            const m: Link = status === ConnectionStatus.CONNECTED ? "connected" : status === ConnectionStatus.CONNECTING ? "connecting" : "disconnected";
            statusSubs.forEach((f) => f(m));
          } }));
          NCEngine.addMessageHandler("aegis", new MessageHandler({ onMessageReceived({ messages }) { msgSubs.forEach((f) => f(messages)); } }));
        }
        if (connectedAs && connectedAs !== me.id) await NCEngine.disconnect();
        const c = await NCEngine.connect({ token: s.token });
        if (!c.isOk) throw new Error(`connect failed (code ${c.code})`);
        connectedAs = me.id;
        if (!cancelled) setLink("connected");
      } catch (e) { if (!cancelled) { setLink("error"); setErr(e instanceof Error ? e.message : String(e)); } }
    })();
    return () => { cancelled = true; };
  }, [info?.configured, me?.id]);

  useEffect(() => {
    const onMsgs = (ms: Message[]) => setMsgs((prev) => {
      const add = ms.map(toMsg).filter((m) => !prev.some((p) => p.id === m.id));
      if (add.length && !activeRef.current) setUnread((u) => u + add.length);
      return [...prev, ...add].slice(-300);
    });
    const onStatus = (s: Link) => setLink(s);
    msgSubs.add(onMsgs); statusSubs.add(onStatus);
    return () => { msgSubs.delete(onMsgs); statusSubs.delete(onStatus); };
  }, []);

  // channel history
  useEffect(() => {
    if (link !== "connected" || !info) return;
    (async () => {
      const q = BaseChannel.createMessagesQuery({ channelIdentifier: new GroupChannelIdentifier(info.channel.id), pageSize: 40 });
      const r = await q.loadNextPage();
      if (r.isOk && r.data) setMsgs((prev) => { const hist = r.data!.data.map(toMsg); const ids = new Set(hist.map((h) => h.id)); return [...hist, ...prev.filter((p) => !ids.has(p.id))].sort((a, b) => a.at - b.at); });
    })().catch(() => {});
  }, [link, info]);
  useEffect(() => { if (active) end.current?.scrollIntoView({ block: "end" }); }, [msgs.length, active]);

  async function send(body: string) {
    const t = body.trim(); if (!t || !info) return;
    setText("");
    const r = await new GroupChannel(info.channel.id).sendMessage(new SendTextMessageParams({ text: t }));
    if (r.isOk && r.data) setMsgs((p) => [...p, toMsg(r.data!)]); else setErr(`send failed (code ${r.code})`);
  }

  if (!active) return null;
  if (err && !info) return <div className="tc-off"><h3>Team channel offline</h3><p>{err}</p></div>;
  if (!info) return <div className="tc-off"><p>Connecting to Nexconn…</p></div>;
  if (!info.configured) return <div className="tc-off"><h3>Nexconn not configured</h3><p>Add NEXCONN_APP_KEY, NEXCONN_APP_SECRET and NEXCONN_REGION to the server .env. The secret never reaches the browser.</p></div>;
  if (!me) return <div className="tc-off"><h3>Not signed in</h3><p>Sign in to the console to join the mission channel.</p></div>;
  const names = Object.fromEntries([...info.roster.map((r) => [r.id, r.name]), [info.bot.id, info.bot.name]]);
  const visible = msgs.filter((m) => !m.channel || m.channel === info.channel.id);
  return (
    <div className="tc">
      <div className="tc-head">
        <div><b>{info.channel.name}</b><small>Nexconn · {visible.length} messages · you are {me.name}</small></div>
        <span className={`tc-link is-${link}`}>{link}</span>
      </div>
      {err && <div className="tc-err">{err}</div>}
      <div className="tc-list">
        {visible.length === 0 && <p className="tc-empty">No messages yet. Mission events from the AegisLoop bot will appear here.</p>}
        {visible.map((m) => m.from === info.bot.id ? (
          <div key={m.id} className="tc-event"><span className="tc-event-h">AegisLoop · {time(m.at)}</span><p>{m.text}</p></div>
        ) : (
          <div key={m.id} className={`tc-msg ${m.from === me.id ? "mine" : ""}`}>
            <span className="tc-av sm">{initials(names[m.from] ?? m.from)}</span>
            <div><span className="tc-meta"><b>{names[m.from] ?? m.from}</b> · {time(m.at)}</span><p>{m.text}</p></div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="tc-quick">{QUICK.map((q) => <button key={q} onClick={() => send(q)} disabled={link !== "connected"}>{q}</button>)}</div>
      <form className="tc-form" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={link === "connected" ? "Message the mission team" : "Connecting…"} disabled={link !== "connected"} maxLength={1000} aria-label="Message" />
        <button type="submit" disabled={link !== "connected" || !text.trim()} aria-label="Send"><Send size={16} /></button>
      </form>
      <div className="tc-rule"><Lock size={12} aria-hidden /> Chat is discussion only. Approval is a separate action bound to the plan hash.</div>
    </div>
  );
}
const initials = (n: string) => n.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const time = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
