// Starts the collaboration server (Nexconn) and the web app together:  node start.mjs
import { spawn } from "node:child_process";
const run = (cmd, args, tag) => { const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  const out = (d) => process.stdout.write(String(d).split(/\r?\n/).filter(Boolean).map((l) => `[${tag}] ${l}`).join("\n") + "\n");
  p.stdout.on("data", out); p.stderr.on("data", out); return p; };
const kids = [run("node", ["server/nexconn-server.mjs"], "nexconn"), run("npx", ["vite", "--port", "5180"], "web")];
const stop = () => { kids.forEach((k) => k.kill()); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
