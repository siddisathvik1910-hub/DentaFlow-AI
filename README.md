# DentaFlow AI: AI front desk for dental clinics

A complete full-stack web product: a public website, a staff dashboard, and an AI agent that answers calls,
texts and web chats for a dental practice, books appointments, sends reminders, backfills cancellations,
handles emergencies safely, and hands off to humans.

**It runs on your computer with no accounts and no API keys.** Add keys later to switch on real
Claude AI, real phone calls and real text messages.

---

## 1. Quick start (3 minutes)

You need **Node.js 20 or 22 (LTS)** from <https://nodejs.org>. (Node 18 works; very new versions such as 24 may need build tools, see Troubleshooting.)

**Windows:** double-click `start.bat`
**macOS / Linux:** run `./start.sh`
**Or manually:**

```bash
npm install
npm start
```

Then open:

| What | Address |
|---|---|
| Marketing website | <http://localhost:3000> |
| Staff dashboard | <http://localhost:3000/app> |
| Sign-in | <http://localhost:3000/login> |

On the first start a demo clinic is created automatically.

**Demo login:** `demo@brightsmile.test` / `DentaFlow!2026`
(Also `frontdesk@brightsmile.test` with the same password, a limited "staff" role.)

### Try it in 60 seconds
1. Sign in and open **Test the agent**.
2. Click **Start new conversation**, then type (or click the microphone in Chrome/Edge): *"I need to book a cleaning"*.
3. Follow the prompts. Open **Calls & chats** to see the transcript, every action the agent took, and the outcome.
4. Try the quick-phrase buttons: Emergency (sends 911 guidance + urgent alert), Toothache, Reschedule, Cancel, Insurance, Human.
5. Open **Tasks** and **Messages sent** to see what your staff would receive.
6. On the public website (<http://localhost:3000>) click **Chat with the demo assistant** in the corner.

---

## 2. What is included (mapped to the spec)

The full specification is in `docs/DentaFlow_AI_Front_Desk_Agent_Spec.docx`.

| Spec feature | Status | Where |
|---|---|---|
| F1 Inbound voice answering | Working with Twilio (speech-gather loop) or in-browser simulator | `server/routes/webhooks.js` |
| F2 SMS + web chat + embeddable widget | Working | `server/services/inbound.js`, `web/js/widget.js` |
| F3 Identity verification (name + DOB, 2 attempts) | Working, enforced server-side | `server/agent/tools.js` |
| F4 New-patient booking | Working | `server/agent/offline.js`, `server/services/scheduling.js` |
| F5 Reschedule / cancel / confirm | Working (book-new-then-release-old, late-cancel tasks) | same |
| F6 Knowledge base Q&A (retrieval, pinned answers, "I don't know") | Working (BM25 retrieval, safe website import) | `server/services/knowledge.js` |
| F7 Emergency triage | Working (deterministic rules on every turn) | `server/services/comms.js` |
| F8 Human handoff / warm transfer / callback tasks | Working | `server/agent/tools.js` |
| F9 Reminders + reply C/R/X | Working (72h/24h/2h, quiet hours, idempotent) | `server/services/reminders.js` |
| F10 Waitlist + cancellation backfill | Working (first YES wins, offer expiry) | `server/services/waitlist.js` |
| F11 Recall campaigns | Working (marketing-consent gated) | `server/services/campaigns.js` |
| F12 Insurance questions + verification | Collect + task + **simulated** eligibility check | `server/routes/dashboard.js` |
| F13 Digital intake forms | **Not built** |  |
| F14 Multilingual | **Not built** (English only) |  |
| F15 Staff dashboard + task queue | Working (13 screens) | `web/js/app.js`, `web/js/app2.js` |
| F16 Admin configuration + rules | Working (hours, providers, types, rules, versioned settings, rollback) | Settings screen |
| F17 Analytics / ROI | Working | `server/services/analytics.js` |
| F18 Billing | Usage metering + page working; Stripe checkout needs your keys | Billing screen |
| PMS adapters | Built-in calendar working; **Open Dental adapter is an untested skeleton** | `server/services/pms/` |
| Security (encryption, RBAC, MFA, audit, rate limits, CSP) | Working | `server/` |

### How the AI works (important)
* **Built-in engine (default):** a deterministic conversation engine. No internet or key needed. It handles the core flows well, but it is rule-based, so unusual phrasing can confuse it (after repeated misunderstandings it hands off to staff).
* **Claude engine:** set `ANTHROPIC_API_KEY` in `.env`. Claude then runs the conversation using the *same guarded tools*, so it can only act through code that enforces identity checks, scheduling rules and permissions. If the API fails, the built-in engine answers.
* In both engines emergency triage runs first and cannot be overridden by the model.

---

## 3. Using real phone calls and texts (Twilio)

1. Create a Twilio account, buy a number, and put these in `.env`:
   `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`.
2. Make your server reachable from the internet over HTTPS (for testing use a tunnel such as `ngrok http 3000`) and set `BASE_URL` to that address.
3. In Twilio, set the number's webhooks (the dashboard shows these under *Settings → Integrations*):
   * Voice (POST): `BASE_URL/webhooks/twilio/voice`
   * Call status (POST): `BASE_URL/webhooks/twilio/voice/status`
   * Messaging (POST): `BASE_URL/webhooks/twilio/sms`
4. Add your Twilio number to the clinic: the demo clinic uses `+15125550100`. Change it with SQL or add a row to `phone_numbers` (a settings screen for this is not built yet).
5. In the US you must register for **A2P 10DLC** before texting at scale, and follow call-recording / AI-disclosure laws for your state.

Webhook calls are verified with Twilio's signature whenever `TWILIO_AUTH_TOKEN` is set.
Voice uses Twilio's speech recognition in a turn-taking loop (a second or two of latency per turn). For lowest latency you would swap in a streaming voice gateway; the agent code does not change.

## 4. Put the chat widget on a clinic's website

Dashboard → *Test the agent* shows a one-line snippet:

```html
<script src="https://YOUR-DOMAIN/js/widget.js" data-key="WIDGET_KEY" defer></script>
```

## 5. Going to production (checklist)

1. Create secrets and put them in `.env`:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` for **both** `JWT_SECRET` and `ENCRYPTION_KEY`. Back up `ENCRYPTION_KEY` (lose it and encrypted patient data is unrecoverable).
2. Set `NODE_ENV=production`, `BASE_URL=https://yourdomain.com`, `TRUST_PROXY=true`, and your `COMPANY_*` details.
3. Run behind HTTPS (Caddy, Nginx, Cloudflare, Render, Fly.io, etc.). Production redirects HTTP to HTTPS and sends HSTS.
4. Create your real practice and owner login (demo data is not created in production):
   ```bash
   npm run create-admin -- --email you@clinic.com --name "Dr. Jane Doe" --clinic "Smile Dental" --password "A-Long-Passw0rd" --timezone America/Chicago
   ```
5. Sign in → *Settings*: set hours, providers, appointment types, emergency policy, accepted insurance. Turn on two-step sign-in (*Settings → My security*).
6. *Knowledge base*: add your FAQs or import your website pages.
7. Run the audit: `npm test` and `npm run audit-site`.
8. **Back up the `data/` folder** (SQLite database) regularly.
9. Have a lawyer review the Privacy Policy, Terms and Cookie Statement, and put a **business associate agreement (BAA)** in place with every vendor that touches patient data (hosting, Twilio, AI provider) before using real patient information.
10. Docker files are included (`Dockerfile`, `docker-compose.yml`) but were not run while building this package.

---

## 6. Your 20-point website launch checklist

See `docs/LAUNCH-CHECKLIST.md` for where each item lives and how it is tested. In short: privacy policy, terms, cookie banner + statement, meta titles/descriptions, social preview image, favicon set, compressed images, alt text, sitemap + robots.txt, HTTPS forcing, secrets kept on the server, custom 404, form validation, bot protection, WCAG-AA contrast, mobile layout, consent-gated analytics, one clear call to action, and scripts to check links, speed, contrast and secrets.

## 7. Commands

| Command | What it does |
|---|---|
| `npm start` | Start the server |
| `npm run dev` | Start with auto-restart on file changes |
| `npm test` | Run all 60 automated tests (uses a throwaway database) |
| `npm run seed` | **Erase** the database and rebuild the demo clinic |
| `npm run create-admin -- ...` | Create a practice + owner login |
| `npm run check-links` | Crawl the site for broken links and anchors |
| `npm run perf` | Page-weight, caching and compression report |
| `npm run check-contrast` | WCAG AA colour-contrast check |
| `npm run scan-secrets` | Confirm no secrets reach the browser |
| `npm run audit-site` | All four checks above |
| `python3 scripts/make-images.py` | Regenerate favicon / social image (needs `pip install pillow`) |

For a real Lighthouse score (Chrome required): `npx lighthouse http://localhost:3000 --view`.

## 8. Project layout

```
server/            Express app
  index.js           bootstrap, security middleware, worker loop
  agent/             nlu.js, offline.js (built-in engine), llm.js (Claude), tools.js (guarded tools)
  services/          scheduling, patients, knowledge, comms (SMS + triage), reminders, waitlist, campaigns, analytics, conversations, inbound
  services/pms/      adapter interface: native calendar + Open Dental skeleton
  routes/            auth, dashboard (REST API), public (site + widget), webhooks (Twilio)
  seed.js db.js crypto.js tz.js totp.js config.js
web/               Browser code (no build step, no inline scripts, CSP-safe)
  pages/ partials/   HTML templates
  css/ js/ img/
scripts/           audit + admin tools
test/              automated tests
docs/              spec + launch checklist
data/              SQLite database (created on first run, git-ignored)
```

## 9. Known limitations (read before launch)

* **Not legal advice.** The privacy policy, terms and cookie statement are templates. HIPAA, TCPA, call-recording and AI-disclosure compliance are your responsibility; get counsel.
* **Single-process design.** Slot holds and the live-update bus live in memory, and the database is SQLite. This suits one clinic or a small group on one server. For many clinics or several servers, move holds/events to Redis and the database to Postgres.
* **Only the built-in calendar is production-ready.** There is no two-way sync with Dentrix, Eaglesoft or Open Dental yet; the Open Dental adapter is an unverified starting point.
* **Insurance eligibility is simulated.** Real verification needs a dental clearinghouse.
* **Outbound reminder *calls*, intake forms, multilingual support, and a phone-number admin screen are not built.** Reminders go by text; unconfirmed appointments create "call to confirm" tasks.
* **Voice quality:** Twilio's speech loop is serviceable, not as fluid as a streaming voice pipeline.
* **Costs shown in Billing** use placeholder unit prices; set them to your real vendor rates in `server/services/core.js`.
* **Tested here** with automated tests and a simulated browser. It has not been tested against real phone calls, real Twilio/Claude/Stripe accounts, Windows or macOS, or on real phones, and the visual design has not been reviewed in a real browser.

## 10. Troubleshooting

* **`npm install` fails on `better-sqlite3`** (common on very new Node versions or Windows without build tools): install Node 22 LTS, or install build tools (Windows: `npm i -g windows-build-tools` / Visual Studio Build Tools; macOS: `xcode-select --install`; Linux: `sudo apt install build-essential python3`), then run `npm install` again.
* **Port already in use:** set `PORT=3001` in `.env` (and `BASE_URL`).
* **Forgot the demo/admin password:** `npm run seed` resets the demo clinic (erases data), or create a new owner with `npm run create-admin`.
* **Microphone button does nothing:** use Chrome or Edge, allow microphone access, and open the site on `localhost` or HTTPS.
* **Texts say "simulated":** that is expected until Twilio keys are set; see *Messages sent* in the dashboard.
* **Start fresh:** stop the server and delete the `data/` folder.
