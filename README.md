# Haq (हक़): an AI lawyer for everyday problems in India

Talk to Meera, an animated legal helper, by text or voice in 11 Indian languages. She turns a messy story into a case file (facts, deadlines, proof checklist, timeline), explains your options at the depth you choose, drafts the notice or complaint, and tells you when you need a real lawyer.

**Modes:** Lawyer (chat + case file) · Practice (the other side plays landlord, HR, bank or police; conversation or scored competition) · Courtroom beta (two AIs argue your case, a third judges) · Hire check (compare lawyers on skill vs fee, Bar Council red flags) · Verified law (every fact Haq may state, with its official source).

## How it avoids invented law
1. **A verified library.** The model may state a legal fact only from a list of 33 entries, each checked against an official source (gazette, RBI, NALSA, court sites). Anything else must be said as "I don't have verified information".
2. **A code checker on every answer.** Sections, case names, deadlines, amounts and helplines are matched against the library. Unknown items are removed or flagged, and old IPC/CrPC references are marked as replaced by BNS/BNSS. The person sees what was changed.
3. **Fixed escalation rules.** Arrest, summons, violence and large amounts always get "talk to a lawyer", decided by rules, not the model.
4. **Works with no AI.** If the model is down, answers fall back to the verified rules only.

## Architecture
```
browser (public/index.html: UI, engine, checker, knowledge base)
   │  POST /api/llm  {system, messages}
   ▼
server.js (Node, zero dependencies) ── Gemini API (key stays on the server)
   • rate limit per IP + daily cap   • model fallback chain   • input size checks
```
The model is easy to swap: change `GEMINI_MODELS`, or in Settings pick your own Gemini key or any OpenAI-compatible API (Groq, OpenRouter, OpenAI).

## Run it locally
```bash
cp .env.example .env        # then paste your GEMINI_API_KEY into .env
node server.js              # http://localhost:8080
npm test                    # offline checks: topic sorting, checker, server validation
```
No `npm install` needed: there are no dependencies. Node 18+.

## Deploy (free)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/shubham-nare/haq-ai-lawyer)

Render reads `render.yaml` and asks for `GEMINI_API_KEY`. Free services sleep after 15 idle minutes and then take about a minute to wake. To avoid that, the server pings its own `/healthz` every 10 minutes when it runs on Render (it uses `RENDER_EXTERNAL_URL`, which Render sets). It pings all day and stops after 3 Dec (optional night break: `KEEP_AWAKE_IST_HOURS=8-24`). A GitHub Actions workflow (`.github/workflows/keepalive.yml`) and cron-job.org ping too, as backups. Set `KEEP_AWAKE=0` to turn the self-ping off. One always-awake service uses about 744 of the 750 free hours Render gives each workspace per month, so keep only one free service awake at a time.

## Raw outputs
Settings ⚙ → **Run test cases** runs the 41 built-in cases through the live AI and downloads every raw reply, the checked reply and the checker's report as JSON.

## Known limits
- Covers consumer refunds, rental deposits, unpaid salary, bounced cheques, online/UPI fraud, legal notices and theft/police complaints in depth; everything else gets labelled general guidance.
- Topic sorting without AI gets 29/29 on the main set but 5/12 on held-out cases written after tuning; misses fall back to general guidance or asking the person to pick a topic.
- Voice input needs Chrome or Edge.

Legal information, not legal advice. Free legal aid: NALSA 15100.
