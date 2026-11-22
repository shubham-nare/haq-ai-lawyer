// Haq web server: serves the single-page app and proxies AI calls to Gemini
// so the API key stays on the server and visitors never need their own.
// Zero dependencies (Node 18+). Run: GEMINI_API_KEY=... node server.js
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

loadDotEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 8080);
const KEY = (process.env.GEMINI_API_KEY || "").trim();
// Tried in order: when one model is overloaded or out of quota, the next one answers.
const MODELS = (process.env.GEMINI_MODELS || "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-flash-latest,gemini-2.5-flash-lite")
  .split(",").map((s) => s.trim()).filter(Boolean);
const PER_IP_PER_HOUR = Number(process.env.PER_IP_PER_HOUR || 150);
const DAILY_CAP = Number(process.env.DAILY_CAP || 1500); // protects the free quota from one heavy visitor
const PUBLIC = path.join(__dirname, "public");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8" };

// ------------------------------------------------------------------ rate limits (in memory; one instance)
const hits = new Map(); // ip -> [timestamps]
let day = today(), dayCount = 0;
function today() { return new Date().toISOString().slice(0, 10); }
function allow(ip) {
  if (today() !== day) { day = today(); dayCount = 0; hits.clear(); }
  if (dayCount >= DAILY_CAP) return "Haq's shared AI has hit today's limit. It resets at midnight UTC. Offline mode still works.";
  const now = Date.now(), list = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (list.length >= PER_IP_PER_HOUR) return "You've sent a lot of requests this hour. Wait a few minutes and try again.";
  list.push(now); hits.set(ip, list); dayCount++;
  return null;
}
function clientIp(req) { return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(); }

// ------------------------------------------------------------------ Gemini
async function gemini({ system, messages, json }) {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    generationConfig: Object.assign({ temperature: 0.3, maxOutputTokens: 8192 }, json ? { responseMimeType: "application/json" } : {}),
  });
  let last = "";
  for (const model of MODELS) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 90e3);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": KEY }, body, signal: ctl.signal,
      });
      if (r.ok) {
        const j = await r.json();
        const text = ((j.candidates || [])[0]?.content?.parts || []).map((x) => x.text || "").join("");
        if (text) return { text, model };
        last = `${model}: empty reply (${(j.candidates || [])[0]?.finishReason || j.promptFeedback?.blockReason || "no candidates"})`;
        continue;
      }
      last = `${model}: ${r.status}`;
      // 429 quota, 5xx overload, 404 retired model -> try the next one. Other 4xx are our fault: stop.
      if (!(r.status === 429 || r.status >= 500 || r.status === 404)) break;
    } catch (e) { last = `${model}: ${e.name === "AbortError" ? "timed out" : "network error"}`; }
    finally { clearTimeout(timer); }
  }
  const err = new Error("The AI didn't answer (" + last + "). Try again in a minute.");
  err.status = 502; throw err;
}

function validate(p) {
  if (!p || typeof p.system !== "string" || !Array.isArray(p.messages)) return "Bad request.";
  if (p.system.length > 60000) return "Request too large.";
  if (p.messages.length < 1 || p.messages.length > 60) return "Bad conversation length.";
  let total = p.system.length;
  for (const m of p.messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return "Bad message.";
    total += m.content.length;
  }
  if (total > 150000) return "Request too large.";
  return null;
}

// ------------------------------------------------------------------ http
function send(res, status, data, type = "application/json") {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === "string" ? data : JSON.stringify(data));
  res.writeHead(status, {
    "Content-Type": type, "Content-Length": buf.length,
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "microphone=(self), camera=()",
    "Cache-Control": type.startsWith("text/html") || type === "application/json" ? "no-cache" : "public, max-age=3600",
  });
  res.end(buf);
}
function readBody(req, limit = 400e3) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error("Request too large."), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/healthz") return send(res, 200, { ok: true });
    if (url.pathname === "/api/health") return send(res, 200, { ok: true, ai: !!KEY, provider: "gemini", model: MODELS[0] });
    if (url.pathname === "/api/llm") {
      if (req.method !== "POST") return send(res, 405, { error: "POST only." });
      if (!KEY) return send(res, 503, { error: "No AI key is set on this server." });
      const p = JSON.parse(await readBody(req));
      const bad = validate(p); if (bad) return send(res, 400, { error: bad });
      const limited = allow(clientIp(req)); if (limited) return send(res, 429, { error: limited });
      const out = await gemini({ system: p.system, messages: p.messages, json: p.json !== false });
      return send(res, 200, out);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed." });
    // static files from public/, no path escape
    const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, "Not found", "text/plain");
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, "Not found", "text/plain");
      send(res, 200, data, TYPES[path.extname(file)] || "application/octet-stream");
    });
  } catch (e) {
    const status = e.status || (e instanceof SyntaxError ? 400 : 500);
    if (status >= 500) console.error(new Date().toISOString(), e.message);
    send(res, status, { error: status === 400 ? "Bad request." : e.message || "Server error." });
  }
});

// ------------------------------------------------------------------ keep awake
// Render's free plan puts a service to sleep after 15 minutes with no incoming
// traffic, and the next visitor then waits about a minute. Pinging our own
// public URL every few minutes counts as incoming traffic, so it never sleeps.
// RENDER_EXTERNAL_URL is set by Render automatically; locally nothing happens.
// Turn it off with KEEP_AWAKE=0 (Render's free plan gives 750 hours a month per
// workspace, and one service awake all month uses about 744 of them).
// KEEP_AWAKE_UNTIL: stop pinging after this moment (the review window ends 3 Dec).
// Optional night break: until KEEP_AWAKE_HOURS_UNTIL (end of 30 Nov IST) it can ping only during
// KEEP_AWAKE_IST_HOURS (e.g. "8-24" India time), so it sleeps at night and the
// free hours last. Default "" = all day, every day.
const KEEP_AWAKE_UNTIL = Date.parse(process.env.KEEP_AWAKE_UNTIL || "2026-12-04T00:00:00+05:30");
const KEEP_AWAKE_IST_HOURS = process.env.KEEP_AWAKE_IST_HOURS ?? ""; // all day (Shubham, 22 Nov: no night break)
const KEEP_AWAKE_HOURS_UNTIL = Date.parse(process.env.KEEP_AWAKE_HOURS_UNTIL || "2026-12-01T00:00:00+05:30");
function istHourAllowed(now, spec) {
  const m = String(spec || "").match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
  if (!m) return true;
  const h = new Date(now + 5.5 * 3600e3).getUTCHours(), from = +m[1], to = +m[2];
  return from <= to ? h >= from && h < to : h >= from || h < to;
}
function keepAwake() {
  const base = (process.env.KEEP_AWAKE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
  const minutes = Number(process.env.KEEP_AWAKE_MINUTES || 10);
  if (!base || process.env.KEEP_AWAKE === "0" || !(minutes > 0)) return null;
  let fails = 0;
  const ping = async () => {
    const now = Date.now();
    if (now >= KEEP_AWAKE_UNTIL) { clearInterval(timer); console.log("keep-awake: end date reached, stopped"); return; }
    if (now < KEEP_AWAKE_HOURS_UNTIL && !istHourAllowed(now, KEEP_AWAKE_IST_HOURS)) return; // night break: let it sleep
    try {
      const r = await fetch(base + "/healthz", { headers: { "User-Agent": "haq-keep-awake" }, signal: AbortSignal.timeout(30e3) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      if (fails) console.log(new Date().toISOString(), "keep-awake: ping OK again");
      fails = 0;
    } catch (e) {
      fails++;
      if (fails === 1 || fails % 6 === 0) console.error(new Date().toISOString(), "keep-awake: ping failed (" + fails + "):", e.message);
    }
  };
  const timer = setInterval(ping, minutes * 60e3);
  timer.unref();
  console.log(`keep-awake: pinging ${base}/healthz every ${minutes} min until ${new Date(KEEP_AWAKE_UNTIL).toISOString()}${KEEP_AWAKE_IST_HOURS ? ", only " + KEEP_AWAKE_IST_HOURS + " IST until " + new Date(KEEP_AWAKE_HOURS_UNTIL).toISOString() : ""}`);
  return timer;
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Haq on http://localhost:${PORT}  AI: ${KEY ? "Gemini (" + MODELS.join(" > ") + ")" : "OFF (no GEMINI_API_KEY)"}`);
    keepAwake();
  });
}
module.exports = { server, validate, istHourAllowed };

function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch (e) { /* no .env: use real environment */ }
}
