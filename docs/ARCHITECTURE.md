# Architecture

## Components

```
                 ┌──────────────────────── Railway (1 always-on container) ────────────────────────┐
 Telegram ──────▶│ POST /telegram/webhook/:consultantId  ── verify per-bot secret ── 200 OK at once │
 (per-bot        │        │                                                                        │
  webhooks)      │        ▼                                                                        │
                 │  ConsultantRuntime  (per-chat queue, debounce, rate limit, daily cap)            │
                 │        │ store message (idempotent on update_id)                                │
                 │        ▼                                                                        │
                 │  Engine.generateReply ── embed ─▶ Gemini embeddings                             │
                 │        │               ── hybrid search + few-shot ─▶ Supabase RPC              │
                 │        │               ── structured generation ─▶ Gemini                       │
                 │        ▼                                                                        │
                 │  send via Bot API (HTML, split) · store reply · flag/alert · summarise memory    │
                 │                                                                                 │
 Browser ───────▶│ /api/*  (Supabase JWT → RLS-scoped client for reads, service role for writes)   │
                 │ /*      built React SPA                                                         │
                 └─────────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
                          Supabase: Postgres + pgvector + Auth
```

## Server modules

| Path | Responsibility |
|---|---|
| `src/config.ts` | Zod-validated environment. Supabase key aliases. Webhook vs polling auto-selection. |
| `src/core/engine.ts` | One AI turn: retrieval, few-shot, prompt, Gemini, decision. Never throws: on any failure it returns the owner's fallback message. |
| `src/core/runtime.ts` | Telegram update handling, commands (`/start`, `/reset`, `/connect`), media, sending, owner alerts, limits, playground, operator replies. |
| `src/core/transport.ts` | `WebhookTransport` (production, re-syncs webhooks on boot) and `PollingTransport` (local dev). |
| `src/core/knowledge.ts` | Background indexer: chunk → embed → store. Recovery after restart. |
| `src/core/memory.ts` | Rolling conversation summaries. |
| `src/services/llm.ts` | Gemini client: retries with backoff, timeouts, fallback model, JSON parsing, embeddings, OCR. |
| `src/services/prompt.ts` | System instruction, contents, output schema, outcome decision. |
| `src/services/telegram/*` | Minimal typed Bot API client. Markdown → Telegram HTML. Message splitting. |
| `src/db/supabaseStore.ts` | Service-role data access for the runtime, always scoped by consultant/conversation. |
| `src/http/*` | Express app, auth middleware, routes for consultants, knowledge, examples, conversations, analytics, playground. |

## Request flows

**Customer message:** Telegram → webhook (secret checked, 200 returned immediately) → `handleUpdate` stores the message in a per-chat queue → a debounced `respond` collects every unanswered message → `generateReply` → Telegram `sendMessage` → stored with metadata (latency, model, tokens, sources, examples, status) → flag + owner alert if needed → summary.

**Dashboard read:** browser (Supabase session) → `/api/...` with `Authorization: Bearer <jwt>` → `requireAuth` verifies the token with Supabase Auth → `req.db` = a Supabase client acting *as the user* → Postgres RLS returns only that user's rows.

**Dashboard write:** ownership is verified via `req.db` (`loadConsultant`) → the service-role client writes, filtered by the verified `consultant_id` → triggers derive `user_id` from the consultant.

## Reliability

* Idempotent webhooks: `unique (consultant_id, telegram_update_id)`.
* Gemini: 3 attempts with exponential backoff on 408/429/5xx/network errors, a 45 s timeout, and a fallback model on 404/429/5xx.
* Telegram: retries on 429 (`retry_after`) and 5xx. Plain-text fallback when HTML parsing fails. A revoked token marks the consultant `error` and shows it in the dashboard.
* Graceful shutdown on `SIGTERM`: pending debounced replies are flushed and in-flight work is drained.
* Boot recovery: documents interrupted mid-indexing are re-queued, missing example embeddings are backfilled, and webhooks are re-registered if the domain changed.

## Limits & cost control

`DAILY_REPLY_LIMIT` per consultant, `MESSAGES_PER_CHAT_PER_MINUTE` per chat, 600 API requests per minute per IP, 40 AI requests per minute per user for playground and uploads, and limits on upload size, document count and example count.
