// NuNu Bridge, local half.
// Runs on this machine only. Foundry's browser tab polls it for jobs and posts
// back answers; local tooling submits jobs through it. No dependencies.
//
// Trust model: every route requires the token. The only cross-origin access
// granted is to the Foundry origin itself, for the two routes it needs, and the
// Host header is pinned so a hostile name resolving to 127.0.0.1 is refused.

import { createServer } from "node:http";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.NUNU_BRIDGE_PORT || 7777);

// The token lives outside the module tree so it can never be committed or
// zipped into a release.
const TOKEN_DIR = join(homedir(), ".config", "nunu-bridge");
const TOKEN_FILE = join(TOKEN_DIR, "token");
if (!existsSync(TOKEN_FILE)) {
  mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_FILE, randomBytes(24).toString("hex"), { mode: 0o600 });
}
const TOKEN = readFileSync(TOKEN_FILE, "utf8").trim();

// Which page origins may talk to us. Anything else gets no CORS headers at all,
// so a browser refuses to let the page read the reply.
const ORIGIN_OK = (origin) => {
  if (!origin) return false;
  if (process.env.NUNU_BRIDGE_ORIGIN) return origin === process.env.NUNU_BRIDGE_ORIGIN;
  return /^https:\/\/[a-z0-9-]+\.forge-vtt\.com$/i.test(origin) || /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
};
const CORS_ROUTES = new Set(["/next", "/result"]);

const POLL_HOLD_MS = 25_000;
const STALE_MS = 70_000;
const MAX_QUEUE = 50;
const MAX_ASK_BODY = 256 * 1024;        // a job description is small
const MAX_RESULT_BODY = 32 * 1024 * 1024; // an answer can be a whole scene

const queue = [];
const pending = new Map();   // job id -> {resolve, timer}
const inFlight = new Map();  // job id -> client id that was handed the job
let waitingPoll = null;
let lastPollAt = 0;

const sameToken = (given) => {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

// A hostile DNS name pointing at 127.0.0.1 would be same-origin to the browser,
// so the Host header has to be pinned as well.
const hostOk = (req) => {
  const h = String(req.headers.host || "");
  return h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}`;
};

const send = (res, code, body, origin = null) => {
  try {
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    res.writeHead(code, { "content-type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  } catch {
    /* socket already gone */
  }
};

const readBody = (req, limit) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { chunks.length = 0; req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const deliver = (res, clientId) => {
  const job = queue.shift();
  inFlight.set(job.id, clientId);
  send(res, 200, job, res.__origin);
};

const handOff = () => {
  if (!waitingPoll || !queue.length) return;
  const { res, timer, clientId } = waitingPoll;
  clearTimeout(timer);
  waitingPoll = null;
  deliver(res, clientId);
};

async function route(req, res, url) {
  const origin = req.headers.origin;
  const corsOrigin = CORS_ROUTES.has(url.pathname) && ORIGIN_OK(origin) ? origin : null;
  res.__origin = corsOrigin;

  if (req.method === "OPTIONS") {
    if (!corsOrigin) { res.writeHead(403); res.end(); return; }
    res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Access-Control-Max-Age", "600");
    res.writeHead(204);
    res.end();
    return;
  }

  // Everything below needs the token.
  if (!sameToken(url.searchParams.get("token"))) return send(res, 403, { error: "bad token" }, corsOrigin);

  if (url.pathname === "/health" && req.method === "GET") {
    return send(res, 200, {
      ok: true,
      connected: Date.now() - lastPollAt < STALE_MS,
      lastPollAt: lastPollAt || null,
      queued: queue.length,
      pending: pending.size,
    });
  }

  // Foundry asks for work.
  if (url.pathname === "/next" && req.method === "GET") {
    lastPollAt = Date.now();
    const clientId = url.searchParams.get("client") || "unknown";
    if (queue.length) return deliver(res, clientId);
    if (waitingPoll) { clearTimeout(waitingPoll.timer); send(waitingPoll.res, 204, "", waitingPoll.res.__origin); waitingPoll = null; }
    const timer = setTimeout(() => { waitingPoll = null; send(res, 204, "", corsOrigin); }, POLL_HOLD_MS);
    waitingPoll = { res, timer, clientId };
    res.on("close", () => {
      if (waitingPoll && waitingPoll.res === res) { clearTimeout(timer); waitingPoll = null; }
    });
    return;
  }

  // Foundry returns an answer. Only the client that was handed the job may answer it.
  if (url.pathname === "/result" && req.method === "POST") {
    lastPollAt = Date.now();
    let payload;
    try { payload = JSON.parse(await readBody(req, MAX_RESULT_BODY)); } catch { return send(res, 400, { error: "bad body" }, corsOrigin); }
    if (!payload || typeof payload !== "object") return send(res, 400, { error: "bad body" }, corsOrigin);
    const owner = inFlight.get(payload.id);
    const claimed = url.searchParams.get("client") || "unknown";
    if (owner !== undefined && owner !== claimed) return send(res, 409, { error: "not your job" }, corsOrigin);
    inFlight.delete(payload.id);
    const slot = pending.get(payload.id);
    if (slot) { clearTimeout(slot.timer); pending.delete(payload.id); slot.resolve(payload); }
    return send(res, 200, { ok: true }, corsOrigin);
  }

  // Local tooling submits a job. No CORS headers on this route, ever.
  if (url.pathname === "/ask" && req.method === "POST") {
    if (Date.now() - lastPollAt > STALE_MS) {
      return send(res, 503, { error: "Foundry is not connected. Open the world in a browser tab with the bridge enabled." });
    }
    if (queue.length >= MAX_QUEUE) return send(res, 429, { error: "queue full" });
    let q;
    try { q = JSON.parse(await readBody(req, MAX_ASK_BODY)); } catch { return send(res, 400, { error: "bad body" }); }
    if (!q || typeof q !== "object" || typeof q.op !== "string") return send(res, 400, { error: "no op" });

    const wait = Math.min(Math.max(Number(q.timeout) || 60_000, 1_000), 120_000);
    const id = randomUUID();
    let settled = false;
    const answer = await new Promise((resolve) => {
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const timer = setTimeout(() => {
        pending.delete(id);
        inFlight.delete(id);
        const i = queue.findIndex((j) => j.id === id); // never let a dead job run later
        if (i !== -1) queue.splice(i, 1);
        done({ ok: false, error: "timed out waiting for Foundry" });
      }, wait);
      pending.set(id, { resolve: (v) => { clearTimeout(timer); done(v); }, timer });
      res.on("close", () => {
        if (settled) return;
        clearTimeout(timer);
        pending.delete(id);
        const i = queue.findIndex((j) => j.id === id);
        if (i !== -1) queue.splice(i, 1);
        done({ ok: false, error: "caller went away" });
      });
      queue.push({ id, op: q.op, args: q.args && typeof q.args === "object" ? q.args : {} });
      handOff();
    });
    if (res.writableEnded || res.destroyed) return;
    return send(res, answer.ok === false ? 500 : 200, answer);
  }

  send(res, 404, { error: "no such path" }, corsOrigin);
}

const server = createServer((req, res) => {
  if (!hostOk(req)) { try { res.writeHead(421); res.end(); } catch { /* gone */ } return; }
  let url;
  try { url = new URL(req.url, `http://127.0.0.1:${PORT}`); } catch { try { res.writeHead(400); res.end(); } catch { /* gone */ } return; }
  route(req, res, url).catch((err) => send(res, 500, { error: String(err?.message ?? err) }));
});

server.on("error", (err) => {
  console.error(err.code === "EADDRINUSE" ? `port ${PORT} is already in use` : err.message);
  process.exit(1);
});

process.on("unhandledRejection", (e) => console.error("unhandled rejection:", e));
process.on("uncaughtException", (e) => console.error("uncaught exception:", e));

server.listen(PORT, "127.0.0.1", () => {
  console.log(`nunu-bridge listening on http://127.0.0.1:${PORT}`);
  console.log(`token file: ${TOKEN_FILE}`);
});
