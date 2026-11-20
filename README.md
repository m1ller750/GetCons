# GetCons: AI consultants and agents for WhatsApp, Telegram and websites

GetCons - AI powered platform that allows to create AI agents for business in one click and edit them.

Any business creates its own **Gemini-powered AI consultant** in one click and puts it in **WhatsApp, Telegram or on its website**. It is trained on the business's own information: instructions, business details, uploaded documents and examples of real customer conversations. The consultant reads and understands customer messages (text, photos, voice), answers in the customer's language, remembers the conversation, and escalates to a human when it lacks reliable information.

On the **Pro** plan the consultant becomes an **AI agent**: connected to the business's store (Shopify, WooCommerce or any site through a small signed API), it places orders, cancels them, handles returns and refunds, and tells customers in the same chat when their order changes. Every store action needs the customer's confirmation in the chat, and refunds above the owner's limit wait for the owner.

* **Frontend:** React 19, Vite 8, Tailwind CSS 4, TanStack Query. English/Russian UI switch. Landing page with a three.js particle robot.
* **Backend:** Node.js 24, Express 5, TypeScript, Zod.
* **AI:** Google Gemini (`@google/genai`, Gemini API or Vertex AI express keys). Chat model `gemini-3.1-flash-lite` with a `gemini-3.5-flash-lite` backup, embeddings `gemini-embedding-001` (768-d), function calling for the agent. Optional reserve provider: xAI Grok or any OpenAI-compatible API (`GROK_API_KEY`).
* **Channels:** WhatsApp through a linked work number ([Baileys](https://github.com/WhiskeySockets/Baileys), like WhatsApp Web), the Telegram Bot API, and a website chat (embeddable widget + shareable chat link with a QR code).
* **Data:** Supabase Postgres + pgvector, Supabase Auth, Row Level Security.
* **Hosting:** Railway, one always-on container (API + WhatsApp sessions + Telegram webhooks + web chat + dashboard).

```
WhatsApp ──linked device (websocket)──┐
Telegram ──webhook────────────────────┤
Website  ──widget / chat link (/c/…)──┴▶ Railway (Express) ──▶ Supabase (Postgres + pgvector + Auth)
                          │    ▲              │
                          ▼    │              └──▶ Store API (Shopify / WooCommerce / custom), Pro agent only
                       Google Gemini (generation, tools, embeddings, OCR), Grok as reserve
Browser ── dashboard (React SPA, same origin) ──▶ /api (JWT, RLS-scoped)
```

## Features

| Area | What you get |
|---|---|
| Three channels | When creating a consultant the owner picks **WhatsApp**, **Telegram** or **Website** (the others can be connected later in **Settings → Channels**). Conversations from all of them land in one inbox and one set of analytics. |
| Website chat | One line of code (`<script src=".../widget.js" data-key="…">`) adds a chat button to any site (Tilda, WordPress, Shopify, Wix…). The same chat opens from a link and a downloadable QR code for Instagram bios, Google Maps or the counter. Visitors are identified only by a hashed browser id. |
| AI agent (Pro) | Connect the store under **AI agent**: Shopify (Admin GraphQL), WooCommerce (REST) or any site through a signed JSON API (HMAC-SHA256, contract shown on the page). Switch each permission on or off: catalog lookup, order status, placing orders, cancellations, returns/refunds (with an automatic refund limit), order-update notifications. The agent prepares an action, the customer confirms it in the chat, and only then does it run; refunds above the limit go to the owner's **Approve / Decline** list. Without a store connection, orders and returns come to the owner. All actions are logged. |
| One-click WhatsApp | The owner links a **work number** (not a personal one) the way WhatsApp Web is linked: **Settings → Linked devices → Link a device**, then scans the QR code or types the 8-character code shown on the dashboard, with a step-by-step guide. No Meta approval or paid API. The session (Signal keys) is stored AES-256-GCM encrypted in Supabase, so it survives deploys, and reconnects on boot. The consultant answers customers who write first, marks messages read, shows "typing…", reads photos, voice notes and PDFs, and uses WhatsApp formatting. Note: this is not Meta's official Cloud API, so owners should use a separate work number and avoid mass mailings. |
| One-click Telegram bot | Click **Create consultant & Telegram bot**. Telegram opens a pre-filled "Create bot" sheet (Telegram **Managed Bots**, Bot API 9.6). The user taps Create, the platform's manager bot receives the new bot's token via `getManagedBotToken`, and the consultant is live. Its `@username` appears on the dashboard. No BotFather and no tokens for your customers; a QR code covers desktop users. Telegram apps that are too old for Managed Bots get a fallback: the manager bot's chat offers the native button and also accepts a token from @BotFather (the message with the token is deleted right away). Pasting an existing token on the dashboard still works. |
| Plans & payments | Free / Start / Business / Pro, as in the pitch deck: consultants, monthly AI replies, documents and examples per consultant, chat import, owner alerts, analytics depth, a "Powered by GetCons" line under Free replies, and the AI agent on Pro. Limits are enforced on the server (the consultant cap also by a database trigger, so parallel requests can't slip past it). **Plan & billing** sends the customer to Freedom Pay's hosted card page; only the signed server-to-server result notification (`/api/billing/freedompay/result`, amount and currency checked) activates a plan for 30 days, exactly once. Card details never reach GetCons. Set `FREEDOMPAY_MERCHANT_ID` / `FREEDOMPAY_SECRET_KEY` to enable checkout. |
| Real AI | Each message goes to Gemini with the consultant's instructions, business info, retrieved knowledge, few-shot examples and conversation memory. The reply comes back as structured output (`answer_status`, confidence, citations). |
| Personalisation | Persona, tone, language, emoji use, strictness, greeting, fallback message, handoff rules, temperature, memory length. All are editable and take effect on the next message. |
| Knowledge base (RAG) | Upload PDF/DOCX/TXT/MD/CSV/JSON/HTML/images, or paste text/FAQ. Scanned PDFs and photos go through Gemini OCR. Text is chunked and embedded, then searched with **hybrid search** (cosine similarity + Postgres full-text, fused with Reciprocal Rank Fusion). A retrieval tester shows what the consultant would find. |
| Training examples | Add examples by hand, from a knowledge gap, or from a weak AI reply ("Improve answer"). You can also **import real chats**: Telegram Desktop JSON export, plain-text transcripts, or CSV. For each message, the most similar examples (plus pinned ones) are used as few-shot references. |
| Memory | The last N messages are sent verbatim. Older messages are folded into a rolling summary. `/reset` clears the context. |
| Fallback & handoff | If the AI isn't sure (`unknown`/`partial`/`handoff`, safety block, Gemini outage, daily limit), the customer gets an honest reply or the owner's fallback message. The chat is flagged "Needs attention" and the owner gets an alert with a dashboard link in their own Telegram or WhatsApp (linked by sending `/connect GC-XXXXXX` to the bot or the work number). |
| Dashboard | KPIs, a daily chart, automation rate, response time, knowledge gaps with a one-click "Teach answer", an activity log, a live conversations inbox with human takeover (AI on/off per chat, reply from the dashboard), and a test chat that shows "why this answer" (sources, confidence, latency). |
| Telegram | Webhooks in production (a secret per bot, idempotent updates, async processing, typing indicator, HTML formatting with plain-text fallback, long-message splitting). Long polling for local development. Rapid consecutive messages are answered as one turn. Supports text, photos, voice, audio, video notes and image/PDF documents. |
| Security | Supabase Auth JWTs and **strict tenant isolation** (details below). Bot tokens and store keys are encrypted with AES-256-GCM. API keys never reach the browser. Rate limits, upload limits and a daily reply cap. |

## Honest note on "training"

Saving information or editing instructions **does not retrain Gemini**. The Gemini API has no fine-tuning for current models. Per-business fine-tuning would also be slow, costly, and couldn't be edited instantly. GetCons personalises every consultant with **retrieval-augmented generation (RAG)** and **dynamic few-shot prompting**, and every change applies to the very next message. See [docs/TRAINING.md](docs/TRAINING.md).

## Repository layout

```
server/                 Express API, WhatsApp/Telegram/web runtime, Gemini engine (TypeScript)
  src/core/             engine.ts (reply brain), runtime.ts (channel flow), memory, knowledge indexer, transports
  src/core/agent/       Pro agent: permissions, store connectors, tools, confirmations, order notifier
  src/services/         Gemini client, prompt builder, chunking, document extraction, transcripts, Telegram API
  src/http/             app, auth middleware, routes
  test/                 unit + pipeline + HTTP + PGlite RLS tests; test/integration (live Supabase)
web/                    React dashboard + landing page (EN/RU)
supabase/migrations/    schema, RLS policies, hybrid search & analytics functions
.railway/railway.ts     Railway Infrastructure-as-Code
Dockerfile              production image (API + built SPA)
pitch-deck/             investor deck (HTML source + GetCons-Pitch-Deck.pdf)
docs/                   architecture, deployment, training approach
```

## Quick start (local)

Prerequisites: Node.js ≥ 22.12 (24 LTS recommended), a Supabase project, a Gemini API key, and a Telegram bot token from [@BotFather](https://t.me/BotFather).

1. **Install**

   ```bash
   npm install
   ```

2. **Create the database.** In Supabase, open **SQL Editor** and run [`supabase/migrations/20261024000000_init.sql`](supabase/migrations/20261024000000_init.sql). With the Supabase CLI you can run `supabase link` and then `supabase db push` instead.

3. **Configure Auth.** Under Supabase → Authentication → URL Configuration, set *Site URL* to `http://localhost:5173` (later your Railway URL) and add `http://localhost:5173/**` to the redirect URLs. For quick local testing you can turn off "Confirm email".

4. **Environment.** Copy `.env.example` to `.env` and fill in `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY` and `ENCRYPTION_KEY`. Generate the key with:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

5. **Run**

   ```bash
   npm run dev
   ```

   The API runs on `http://localhost:8080` and the dashboard on `http://localhost:5173`. Without a public https URL the server uses **long polling**, so your bot works locally with no tunnel. WhatsApp needs no public URL either.

   Always open the site through the server (`http://localhost:8080` after `npm run build && npm start`, or `:5173` in dev). Double-clicking `web/index.html` cannot work: browsers block an app's scripts on `file://` pages.

6. Sign up, create a consultant, add knowledge and examples, try it in **Test chat**, then connect WhatsApp (QR code) or Telegram under **Settings → WhatsApp & Telegram**.

## Deploy (Railway + Supabase)

Full guide: [docs/DEPLOY.md](docs/DEPLOY.md). In short:

1. Push the repo to GitHub, then create a Railway service from it. The root `Dockerfile` is used.
2. Set variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `ENCRYPTION_KEY` (optional: `GEMINI_MODEL`, limits).
3. **Settings → Networking → Generate Domain.** Railway sets `RAILWAY_PUBLIC_DOMAIN`, and the app switches to webhook mode and points every bot at itself on boot.
4. Keep **Serverless / App Sleeping off** and use **exactly one replica** so bots are always on (a WhatsApp number can only be connected to one server at a time). The healthcheck is `/api/health`.
5. Set the Supabase Auth *Site URL* to the Railway domain.

You can apply the same settings as code with [`.railway/railway.ts`](.railway/railway.ts) (`npx railway config plan` / `apply`).

## Tests

```bash
npm test                    # 148 tests: unit, prompt, documents, WhatsApp/Telegram/web → Gemini → reply pipelines, the Pro agent and store connectors, LLM backends, WhatsApp linking, HTTP, plans & payments, Postgres RLS
npm run test:integration    # optional, against a real Supabase project (see below)
npm run typecheck
```

* `server/test/db.rls.test.ts` runs the **real migration** inside PGlite (Postgres compiled to WASM, with pgvector). It proves that users read only their own rows, that client roles can't write or see secrets, that search functions are scoped to the tenant, and that triggers keep ownership consistent.
* `server/test/runtime.test.ts` covers the consultant pipeline with fakes: RAG and few-shot in the prompt, memory, `/reset`, fallback with owner alert, Gemini outage, idempotent webhooks, human takeover, media, owner linking, limits.
* `server/test/integration/api.integration.test.ts` creates two real users in a Supabase project and checks isolation through both the API and direct PostgREST access. It needs `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` for a **test** project with the migration applied. Gemini and Telegram are faked, so the test costs nothing.

## Data isolation model

* Every tenant row has `user_id`, **derived by a trigger from the consultant**, so the caller can't forge it. Composite foreign keys stop a row from pointing at another tenant's conversation or document.
* The `authenticated` role can only **SELECT its own rows** (RLS). The dashboard API reads through a client that acts as the signed-in user, so Postgres enforces isolation even if application code forgets a filter.
* Client roles can't insert, update or delete anything. Writes go through the backend, which verifies ownership first and then uses the service role scoped to the verified consultant.
* `consultant_secrets` (encrypted bot tokens, webhook secrets), `whatsapp_auth` (encrypted WhatsApp sessions) and `store_connections` (encrypted store keys for the agent) have no policies and are revoked from client roles.
* Store requests from the agent go only to public HTTPS addresses (no private IPs, no redirects), and custom-API calls are signed with a per-store HMAC secret.
* Webhooks are authenticated with a per-bot `X-Telegram-Bot-Api-Secret-Token`, compared in constant time.

## Environment variables

See [`.env.example`](.env.example) for every variable with comments. Required: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (or `SUPABASE_PUBLISHABLE_KEY`), `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEY`), `GEMINI_API_KEY`, `ENCRYPTION_KEY`. In production, `PUBLIC_URL` comes from `RAILWAY_PUBLIC_DOMAIN` automatically. Optional: `GEMINI_BACKEND` (`auto`, `gemini-api` or `vertex`; `auto` picks Vertex AI express mode for `AQ.` keys), and `GROK_API_KEY` / `GROK_BASE_URL` / `GROK_MODEL` for the reserve provider (any OpenAI-compatible chat-completions API).

## Operations

* **Changing the embedding model:** set `GEMINI_EMBEDDING_MODEL` (it must output 768 dimensions), then run `npm run reembed --workspace server`.
* **Restarts:** documents interrupted mid-indexing are re-queued on boot, and examples saved while Gemini was down are embedded on boot. On `SIGTERM` the server finishes in-flight replies first.
* **Scaling:** one replica handles a large number of bots, because webhook handling is async and per-chat queues keep replies in order. Rate-limit counters and WhatsApp sockets live in memory, so add Redis and shard numbers across instances before running several replicas.
* **WhatsApp sessions:** WhatsApp unlinks a device when its phone has not been online for about 14 days; the dashboard then shows "unlinked on the phone" and the owner links it again. `WHATSAPP_ENABLED=false` turns the channel off.

---

## Быстрый старт (RU)

1. `npm install`
2. В Supabase → SQL Editor выполните по порядку все файлы из `supabase/migrations/`.
3. Скопируйте `.env.example` в `.env` и заполните ключи Supabase, `GEMINI_API_KEY` и `ENCRYPTION_KEY`.
4. `npm run dev`, затем откройте http://localhost:5173, зарегистрируйтесь и создайте консультанта. Сайт открывается только через сервер: двойной щелчок по `web/index.html` работать не будет.
5. Выберите WhatsApp (привязка рабочего номера по QR-коду: WhatsApp → Настройки → Связанные устройства), Telegram (бот создаётся в одно нажатие) или сайт (одна строка кода или ссылка на чат с QR-кодом).
6. На тарифе Pro откройте раздел «ИИ-агент»: подключите магазин (Shopify, WooCommerce или любой сайт через API) и включите, что агенту можно делать — оформлять заказы, отменять их, делать возвраты и сообщать клиентам об изменениях заказа.
7. Для продакшна разверните репозиторий на Railway (Dockerfile подхватится сам), задайте те же переменные и сгенерируйте домен. Бот переключится на webhook и будет работать 24/7. Держите ровно одну реплику: номер WhatsApp может быть подключён только к одному серверу. Подробно: [docs/DEPLOY.md](docs/DEPLOY.md).

«Обучение» устроено честно: модель не переобучается, а получает ваши знания через RAG и примеры ответов через few-shot. Изменения работают со следующего сообщения ([docs/TRAINING.md](docs/TRAINING.md)).
