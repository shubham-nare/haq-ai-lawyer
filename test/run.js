// Offline checks: no AI, no network. Loads Haq's engine straight out of public/index.html
// so the tested code is exactly the code that ships. Run: npm test
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const ctx = { console }; ctx.globalThis = ctx; ctx.window = ctx; vm.createContext(ctx);
for (const src of scripts.filter((s) => /Haq knowledge base|Haq engine|HAQ_TESTS/.test(s.slice(0, 300)))) vm.runInContext(src.replace(/typeof window !== "undefined" \? window : globalThis/g, "globalThis"), ctx);
const H = ctx.HAQ, TESTS = ctx.HAQ_TESTS;
if (!H || !TESTS) { console.error("Couldn't load the engine from index.html"); process.exit(1); }

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail++; console.log("FAIL", msg); } };
const topicOf = (r) => (r && (r.topic || r.best || (r[0] && r[0].topic))) || r;

// 1. topic sorting on the main set (held-out set is reported, not required)
const sets = {};
for (const t of TESTS) {
  if (!t.expect_topic) continue;
  const got = topicOf(H.triage(t.text));
  const s = (sets[t.set] = sets[t.set] || { pass: 0, n: 0, miss: [] });
  s.n++; if (got === t.expect_topic) s.pass++; else s.miss.push(`${t.id}: expected ${t.expect_topic}, got ${got}`);
}
for (const [k, s] of Object.entries(sets)) console.log(`triage ${k}: ${s.pass}/${s.n}` + (s.miss.length ? "\n  " + s.miss.join("\n  ") : ""));
ok(sets.main && sets.main.pass === sets.main.n, "every main-set case should sort to the expected topic");

// 2. the checker must catch invented law
const bad = [
  "Under Section 420 IPC the landlord is guilty.",
  "As held in Sharma v. Union of India (2019), you win.",
  "Call the tenant helpline 1800-000-1111 today.",
];
for (const b of bad) { const g = H.guard(b, { topic: "rent" }); ok(g.report && g.report.ok === false, "checker should flag: " + b); }

// 3. server input validation
const { validate } = require("../server.js");
ok(validate({ system: "x", messages: [{ role: "user", content: "hi" }] }) === null, "valid request accepted");
ok(validate({ system: "x", messages: [{ role: "system", content: "hi" }] }) !== null, "bad role rejected");
ok(validate({ system: 1, messages: [] }) !== null, "bad shape rejected");

console.log(fail ? `\n${fail} check(s) failed` : "\nAll checks passed");
process.exit(fail ? 1 : 0);
