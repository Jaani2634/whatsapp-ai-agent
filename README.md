# WhatsApp AI Agent — Junaid's personal receptionist

A WhatsApp chatbot that acts as **Junaid Nazeer's personal assistant**: it greets
people who message him, answers routine questions from a knowledge base, takes
messages for him, understands voice notes / images / videos, and hands over to
him (the human) whenever something needs his personal attention.

**Stack (all free):** [wappy-kit](https://github.com/csr1010/wappy-kit)
(official WhatsApp Cloud API — no ban risk) · Groq free tier
(`openai/gpt-oss-120b`) as the brain · Gemini free tier for image/video vision ·
Groq Whisper for voice notes · SQLite (LibSQL) for memory + handover state.

**Hosting:** built for [Botkeep](https://botkeep.cloud) Founder Free — a plain
`npm start` Node app, no Docker. `vendor/ffmpeg` is fetched automatically by
the `postinstall` hook, so the repo stays lean.

---

## 1. Meta developer setup (Junaid — one-time, ~15 min)

WhatsApp Cloud API needs a Meta app. Steps:

1. Go to [developers.facebook.com](https://developers.facebook.com) → log in
   with your Facebook account → **Create App** (type: Business).
2. In the app dashboard: **Add Product → WhatsApp** → it appears in the sidebar.
3. **API Setup** (WhatsApp → API Setup):
   - You'll get a **temporary access token** and a **test phone number** —
    copy both. (For production later: add your real business number and
    generate a permanent token.)
   - Note the **Phone number ID** (not the display number).
4. **Configuration** (WhatsApp → Configuration → Webhook):
   - **Callback URL:** `https://<your-botkeep-domain>/webhook`
   - **Verify token:** invent any random string (e.g. `junaid-wa-xyz123`) —
     paste the SAME string into this project's `VERIFY_TOKEN` env var.
   - Click **Verify and save** (the bot must already be running for this).
   - **Subscribe** to webhook field: `messages`.
5. **Settings → Basic:** copy the **App Secret** → `APP_SECRET` env var.

Meta's 2026 policy restricts open-ended general AI assistants on the Cloud
API; business-function bots (assistant, support, bookings) are allowed — this
bot is framed as Junaid's personal assistant, which fits.

## 2. Deploy on Botkeep

1. Push this repo to GitHub (or fork it), then in Botkeep: **New server →
   Import from GitHub** → pick the repo/branch.
2. Runtime: **Node.js** (22+). Start command: `npm start`.
3. In the server's **Environment / Secrets** panel, set every variable from
   `.env.sample` (values stay in Botkeep — never in git):
   - `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`
   - `VERIFY_TOKEN` (same string as in Meta), `APP_SECRET`
   - `GROQ_API_KEY` (free at [console.groq.com](https://console.groq.com))
   - `GEMINI_API_KEY` (free at [aistudio.google.com](https://aistudio.google.com)) — optional but recommended
   - `OWNER_PHONE_NUMBER` — your WhatsApp number, digits only (`923001234567`)
   - `MODEL_ID` — default `openai/gpt-oss-120b` (verified on Groq 2026-10-19)
4. Deploy. On first boot `npm install` runs the `postinstall` hook, which
   downloads the static ffmpeg binary (~80 MB) into `vendor/`.
5. Back in Meta's webhook config, click **Verify and save** — Meta will call
   `GET /webhook` and expect your verify token echoed back.
6. Message the test number from your phone. The bot should reply.

## 3. How handover works

Per-chat state (`bot_active` | `handed_over`) lives in `data/handover.db`
(SQLite — survives restarts).

| Trigger | What happens |
|---|---|
| Customer asks for a human (`human`, `agent`, `insan`, `numainda`/`numayinda`, `kisi se baat karni`, `call karo`, …) | handover |
| Topic in `HANDOVER_SENSITIVE_TOPICS` (e.g. `refund`) | handover |
| Brain emits `[[HANDOVER]]` (can't answer / out of scope) | handover |
| Chat already handed over | bot stays silent |

On handover the customer gets a Roman Urdu auto-reply
("Aapki baat hamare numainde tak pahuncha di hai…"), and **you** get a WhatsApp
message with the reason, recent messages, and the resume command.

**Owner commands** (only from `OWNER_PHONE_NUMBER`):
- `resume <number>` — e.g. `resume 923001234567` — bot takes the chat back,
  customer is notified.
- `pause <number>` — bot goes silent for that chat.
- `status` — lists handed-over chats.
- `notes` — customer messages from the last 24h across all chats (the bot's
  message-taking log).

## 4. Media understanding

| Customer sends | Bot does |
|---|---|
| Voice note / audio (ogg/opus) | ffmpeg → 16 kHz wav → Groq Whisper `whisper-large-v3-turbo` → transcript becomes the message |
| Image | Gemini vision (`gemini-flash-latest`) → 2–3 sentence description |
| Video | 3 frames → Gemini + audio track → Whisper → combined summary |
| Document / location | acknowledged as text |

Temp files are cleaned up after every message. Without `GEMINI_API_KEY`,
image/video analysis is skipped (voice notes still work).

## 5. Teaching the bot (no code changes needed)

- **Persona:** edit `config/system-prompt.txt` (loaded every reply).
- **Knowledge:** add `.md` files to `knowledge/` — auto-indexed (BM25) on
  every restart. `base.md` has confirmed facts about Junaid; `<!-- TODO -->`
  comments are never quoted to customers.
- The `[[HANDOVER]]` contract in the system prompt is load-bearing — don't
  remove it.

## 6. Project layout

```
src/index.js          entrypoint (env validation, wiring, webhook server)
src/brain.js          Groq brain: system prompt + knowledge recall + memory
src/media.js          voice/image/video → text pipeline (ffmpeg + Whisper + Gemini)
src/handover.js       handover state machine (SQLite) + keywords + owner commands
src/agent-wrapper.js  Agent impl: owner cmds → handover gate → media → brain → send
src/whatsapp.js       Cloud API channel + webhook server (from @wappy_ai/whatsapp)
src/store.js          LibSQL clients (memory.db / knowledge.db / handover.db)
scripts/fetch-ffmpeg.js  postinstall: static ffmpeg → vendor/
config/system-prompt.txt  the bot's persona (edit freely)
knowledge/            business facts (.md, auto-indexed)
tests/                node:test suites (30 tests)
```

**Why a custom brain instead of wappy-kit harness's `createAgent`:** the
harness hardcodes its system prompt (no persona hook). This bot's persona is
config-driven, so the brain is a small explicit loop on the Vercel AI SDK —
while still using wappy-kit's channel, webhook server, media download, memory
and knowledge store. `@ai-sdk/openai@2.0.135` + `ai@5.0.277` is the verified
working pair; note the code must use `groq.chat(modelId)` — the provider's
default targets OpenAI's Responses API, which Groq's endpoint rejects.

## 7. Tests

`npm test` — 30 tests, all local:
- Handover state machine (SQLite `:memory:`), EN + Roman Urdu keywords,
  owner-command parsing, alert formatting.
- Real ffmpeg conversion with the vendored static binary (ogg→wav,
  mp4→frames+audio) on synthesized media.
- Mocked Groq Whisper + Gemini request shaping.
- **Real** Groq Whisper transcription of an Urdu voice sample — verified
  2026-10-19 (transcript matched the spoken words).
- **Real** Groq chat completion through the Vercel AI SDK provider —
  verified end-to-end 2026-10-19 via `groq.chat('openai/gpt-oss-120b')`.

Not yet tested live: the Meta webhook handshake and real WhatsApp
message delivery (needs Junaid's Meta credentials).

## 8. Costs & limits (honest)

- WhatsApp Cloud API: ~1,000 conversations/month free, then per-conversation.
- Groq free tier: generous rate limits, no card. Gemini free tier: rate-limited.
- Botkeep Founder Free: 2 GB RAM / 1.5 vCore shared — this bot idles well under
  it (`node_modules` is ~550 MB because of wappy-kit's bundled ML deps; the
  running process uses a few hundred MB).
- Beta host, no uptime SLA — the bot reconnects automatically; handover state
  and memory persist in `data/`.

## 9. Security notes

- Secrets live in env vars only. `.env` is gitignored; `.env.sample`
  documents every variable with no values.
- Meta signs every webhook with `X-Hub-Signature-256` (verified against
  `APP_SECRET`); unverified requests are rejected.
- Only `OWNER_PHONE_NUMBER` can run owner commands.
