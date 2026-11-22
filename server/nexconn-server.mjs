// AegisLoop collaboration server: Nexconn Chat (App Server side), zero dependencies.
//
//   * Signs server API calls: Signature = sha1(AppSecret + Nonce + Timestamp_ms) with App-Key / Nonce / Timestamp headers.
//   * Issues per-user access tokens for the mission team roster; the App Secret never leaves this process.
//   * Owns the mission group channel and posts mission events as the AegisLoop bot.
//   * Console sign-in: every team member has their own access code (AEGIS_CODE_<ROLE> in .env, never sent to the browser).
//     A correct code returns a signed session (HMAC, 12 h); chat tokens and bot events require that session.
//
//   node server/nexconn-server.mjs          (reads ./.env or the environment: NEXCONN_APP_KEY, NEXCONN_APP_SECRET, NEXCONN_REGION,
//                                            AEGIS_SESSION_SECRET, AEGIS_CODE_<ROLE>)
// Development: the Vite dev server proxies /api/nx -> http://127.0.0.1:8787.
// Production (PORT set, e.g. on Render): this process also serves the built website from dist/, listening on 0.0.0.0.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...Object.fromEntries((existsSync(join(ROOT, ".env")) ? readFileSync(join(ROOT, ".env"), "utf8") : "")
  .split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])), ...process.env };
const APP_KEY = env.NEXCONN_APP_KEY || "", SECRET = env.NEXCONN_APP_SECRET || "", REGION = env.NEXCONN_REGION || "sg";
const PROD = Boolean(process.env.PORT);
const PORT = Number(process.env.PORT || env.NX_PORT || 8787), HOST = PROD ? "0.0.0.0" : "127.0.0.1";
const DIST = join(ROOT, "dist");
const DOMAINS = { sg: ["https://api.sg-light-api.com", "https://api-b.sg-light-api.com"], na: ["https://api.us-light-api.com", "https://api-b.us-light-api.com"], sa: ["https://api.sau-light-api.com", "https://api-b.sau-light-api.com"] }[REGION];
const AREA_CODE = { sg: 2, na: 3, sa: 5 }[REGION];

const BOT = { id: "aegisloop-bot", name: "AegisLoop" };
const CHANNEL = { id: "aegis-antakya-aoi-m1", name: "Antakya · Sector AOI-M1" };
const ROSTER = [
  { id: "ops-commander", name: "Ops Commander", role: "Approves plans" },
  { id: "field-lead", name: "Field Lead", role: "USAR team on the ground" },
  { id: "uav-pilot", name: "UAV Pilot", role: "X500 safety pilot" },
  { id: "ugv-operator", name: "UGV Operator", role: "Husky A300 supervisor" },
  { id: "medical-liaison", name: "Medical Liaison", role: "Casualty coordination" },
];
// ---------------------------------------------------------------- console sign-in
const SESSION_SECRET = env.AEGIS_SESSION_SECRET || randomBytes(32).toString("hex");   // random per run if unset: sessions die on restart
const SESSION_TTL = 12 * 3600 * 1000;
const codeOf = (id) => env["AEGIS_CODE_" + id.toUpperCase().replace(/-/g, "_")] || "";
const sha = (s) => createHash("sha256").update(String(s)).digest();
const sameCode = (a, b) => b.length > 0 && timingSafeEqual(sha(a.trim().toUpperCase()), sha(b.trim().toUpperCase()));
const b64 = (s) => Buffer.from(s).toString("base64url");
const sign = (body) => createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
const issueSession = (u) => { const body = b64(JSON.stringify({ id: u.id, exp: Date.now() + SESSION_TTL })); return `${body}.${sign(body)}`; };
function verifySession(req) {
  const t = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const [body, sig] = t.split(".");
  if (!body || !sig) return null;
  const want = sign(body);
  if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString()); if (p.exp < Date.now()) return null; return ROSTER.find((u) => u.id === p.id) ?? null; } catch { return null; }
}

const EVENT_KINDS = new Set(["survey_started", "survey_complete", "finding", "plan_proposed", "plan_approved", "arrived", "inspection_complete", "record_sealed", "mission_reset", "incident", "target_next"]);

const configured = Boolean(APP_KEY && SECRET && DOMAINS);
const state = { status: configured ? "starting" : "not_configured", error: "", tokens: new Map(), channelReady: false };
const sanitize = (s) => String(s).replace(/[A-Za-z0-9+/=_-]{40,}/g, "[redacted]").slice(0, 200);

async function nx(path, body) {
  let last = null;
  for (const base of DOMAINS) {
    const nonce = randomUUID().replace(/-/g, ""), ts = String(Date.now());
    const headers = { "App-Key": APP_KEY, Nonce: nonce, Timestamp: ts, Signature: createHash("sha1").update(SECRET + nonce + ts).digest("hex"), "X-Request-ID": randomUUID(), "Content-Type": "application/json" };
    let r;
    try { r = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) }); }
    catch (e) { last = e; continue; }
    let data; try { data = await r.json(); } catch { throw new Error(`${path}: HTTP ${r.status} non-JSON response`); }
    if (r.status !== 200 || ![0, 200].includes(data.code)) {
      const err = new Error(`${path}: HTTP ${r.status}, code ${data.code}: ${sanitize(data.msg || data.message || data.errorMessage || "request rejected")}`);
      err.code = data.code; throw err;   // never echo the body: it can carry tokens
    }
    return data;
  }
  throw new Error(`${path}: all API domains unreachable (${sanitize(last?.message || last)})`);
}
const issueToken = async (id, name) => {
  if (state.tokens.has(id)) return state.tokens.get(id);
  const d = await nx("/v4/auth/access-token/issue", { userId: id, name });
  const t = d.result?.accessToken; if (!t) throw new Error("token missing in response");
  state.tokens.set(id, t); return t;
};
async function ensureChannel() {
  if (state.channelReady) return;
  try { await nx("/v4/group-channel/create", { channelId: CHANNEL.id, name: CHANNEL.name, owner: BOT.id, userIds: [BOT.id, ...ROSTER.map((u) => u.id)] }); }
  catch (e) { if (!/exist/i.test(e.message)) throw e; }
  state.channelReady = true;
}
const say = (text) => nx("/v4/group-channel/message/send", { fromUserId: BOT.id, toChannelIds: [CHANNEL.id], messageType: "RC:TxtMsg", content: JSON.stringify({ content: text }), pushContent: text.slice(0, 80), isEchoToSender: 1, shouldPersist: 1 });

async function start() {
  if (!configured) { console.log("[nexconn] not configured: add NEXCONN_APP_KEY / NEXCONN_APP_SECRET / NEXCONN_REGION to .env"); return; }
  try {
    await issueToken(BOT.id, BOT.name);
    for (const u of ROSTER) await issueToken(u.id, u.name);
    await ensureChannel();
    state.status = "connected"; state.error = "";
    console.log(`[nexconn] ready · region ${REGION} · channel ${CHANNEL.id} · ${ROSTER.length} team members`);
  } catch (e) { state.status = "degraded"; state.error = sanitize(e.message); console.log("[nexconn] degraded:", state.error); }
}

// tiny rate limiter for bot events (per process)
const sent = []; const allowEvent = () => { const now = Date.now(); while (sent.length && now - sent[0] > 60000) sent.shift(); if (sent.length >= 40) return false; sent.push(now); return true; };
const readJson = (req) => new Promise((res) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > 4096) req.destroy(); }); req.on("end", () => { try { res(JSON.parse(b || "{}")); } catch { res({}); } }); });
const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
const info = () => ({ provider: "nexconn", configured, signin: ROSTER.every((u) => codeOf(u.id)), status: state.status, error: state.error, appKey: configured ? APP_KEY : null, areaCode: AREA_CODE, channel: CHANNEL, bot: BOT, roster: ROSTER });

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".geojson": "application/geo+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".mp4": "video/mp4", ".txt": "text/plain" };
const SECURITY = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "SAMEORIGIN" };
function serveStatic(req, res, pathname) {
  if (!existsSync(DIST)) return false;
  let rel = decodeURIComponent(pathname);
  let file = normalize(join(DIST, rel));
  if (!file.startsWith(DIST + sep) && file !== DIST) { send(res, 400, { error: "bad path" }); return true; }
  let ok = existsSync(file) && statSync(file).isFile();
  if (!ok && !extname(rel)) { file = join(DIST, "index.html"); ok = true; }          // client-side routes -> SPA
  if (!ok) return false;
  const immutable = file.includes(sep + "assets" + sep), tiles = file.includes(sep + "data" + sep);
  res.writeHead(200, { "Content-Type": TYPES[extname(file).toLowerCase()] || "application/octet-stream",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : tiles ? "public, max-age=86400" : "no-cache", ...SECURITY });
  if (req.method === "HEAD") { res.end(); return true; }
  createReadStream(file).pipe(res);
  return true;
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (!url.pathname.startsWith("/api/") && (req.method === "GET" || req.method === "HEAD") && serveStatic(req, res, url.pathname)) return;
    if (url.pathname.startsWith("/api/live")) return send(res, 503, { error: "Gazebo live mode runs only on the local simulation machine" });
    if (req.method === "GET" && url.pathname === "/api/nx/status") return send(res, 200, info());
    if (req.method === "POST" && url.pathname === "/api/nx/login") {
      const { userId, code } = await readJson(req);
      const u = ROSTER.find((r) => r.id === userId);
      if (!u || typeof code !== "string") return send(res, 400, { error: "Choose your role and enter your access code." });
      if (!codeOf(u.id)) return send(res, 503, { error: "Sign-in is not set up on the server (AEGIS_CODE_* in .env)." });
      if (!sameCode(code, codeOf(u.id))) return send(res, 401, { error: "Wrong access code for this role." });
      return send(res, 200, { session: issueSession(u), user: u, expiresIn: SESSION_TTL / 1000 });
    }
    if (req.method === "GET" && url.pathname === "/api/nx/me") {
      const u = verifySession(req);
      return u ? send(res, 200, { user: u }) : send(res, 401, { error: "not signed in" });
    }
    if (req.method === "POST" && url.pathname === "/api/nx/session") {
      const u = verifySession(req);
      if (!u) return send(res, 401, { error: "Sign in to join the mission channel." });
      if (!configured) return send(res, 503, { error: "Nexconn is not configured on the server" });
      const token = await issueToken(u.id, u.name); await ensureChannel();
      return send(res, 200, { token, user: u, ...info() });
    }
    if (req.method === "POST" && url.pathname === "/api/nx/event") {
      if (!verifySession(req)) return send(res, 401, { error: "not signed in" });
      const { kind, text } = await readJson(req);
      if (!EVENT_KINDS.has(kind) || typeof text !== "string" || !text.trim() || text.length > 600) return send(res, 400, { error: "invalid event" });
      if (!configured) return send(res, 503, { error: "Nexconn is not configured on the server" });
      if (!allowEvent()) return send(res, 429, { error: "rate limited" });
      await ensureChannel(); await say(text.trim());
      if (state.status === "degraded") { state.status = "connected"; state.error = ""; }
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: "not found" });
  } catch (e) { state.status = "degraded"; state.error = sanitize(e.message); send(res, 502, { error: state.error }); }
}).listen(PORT, HOST, () => { console.log(`[nexconn] collaboration server on http://${HOST}:${PORT}${PROD ? " (serving dist/)" : ""}`); start(); });
