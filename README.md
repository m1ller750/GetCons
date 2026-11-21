# GetCons

GetCons - AI powered platform that allows to create AI agents for business in one click and edit them.

**Live:** https://getcons-production-edd162a8.up.railway.app · **Pitch deck:** [pitch-deck/GetCons-Pitch-Deck.pdf](pitch-deck/GetCons-Pitch-Deck.pdf)

A business creates its own AI consultant in one click and puts it in **WhatsApp, Telegram or on its website**. The consultant is trained on the business's own information (instructions, business details, documents, examples of real conversations), understands text, photos and voice, answers in the customer's language, remembers each customer and calls a human when it is not sure.

## Plans

- **Free ($0)** — an AI consultant that answers customers 24/7 in WhatsApp, Telegram and the website chat.
- **Pro ($25/month)** — an AI agent that does the business's online work: it places orders, cancels them, handles returns and refunds, tells customers their order status and messages them when an order changes, right in the same chat. It works in the business's store (Shopify, WooCommerce or any site through a signed API); every action is confirmed by the customer, and refunds above the owner's limit wait for the owner.
- **Max ($150/month)** — everything in Pro without a monthly reply limit.

## Features

- **Three channels:** WhatsApp (work number linked with a QR code), Telegram (a new bot in one tap via Managed Bots), website chat (one-line widget, chat link and QR code). One inbox and one analytics view for all of them.
- **Knowledge base (RAG):** PDF, DOCX, CSV, web pages and photos; scanned documents read by Gemini; hybrid search (embeddings + full-text, fused with RRF).
- **Training on real chats:** imported conversations and owner examples guide every reply (few-shot).
- **Memory, honest fallback and human handoff:** unsure chats are flagged and the owner gets an alert in WhatsApp or Telegram.
- **Dashboard:** KPIs, knowledge gaps with "Teach answer", live inbox with human takeover, test chat with "why this answer", AI agent settings and action log. English and Russian.
- **Landing page:** a three.js particle robot made from a 3D model.

## Stack

| Part | Technology |
|---|---|
| Frontend | React 19, Vite, Tailwind CSS 4, TanStack Query, three.js |
| Backend | Node.js 24, Express 5, TypeScript, Zod |
| AI | Google Gemini (`@google/genai`): chat, function calling for the agent, embeddings, OCR; Grok (OpenAI-compatible) as a reserve provider |
| Data | Supabase: Postgres, pgvector, Auth, Row Level Security |
| Channels | WhatsApp linked device (Baileys), Telegram Bot API (webhooks, Managed Bots), embeddable web chat |
| Stores (Pro) | Shopify Admin GraphQL, WooCommerce REST, signed custom JSON API |
| Payments | Freedom Pay |
| Hosting | Railway (Docker) |
| Tests | Vitest, Supertest, PGlite (real migrations in Postgres compiled to WASM) |

```
WhatsApp ──linked device──┐
Telegram ──webhook────────┤
Website  ──widget / link──┴▶ Express (Railway) ──▶ Supabase (Postgres + pgvector + Auth)
                                │
                                ├──▶ Google Gemini (replies, tools, embeddings, OCR), Grok as reserve
                                └──▶ Store API (Shopify / WooCommerce / custom), Pro agent
Browser ── dashboard (React) ──▶ /api (JWT, RLS-scoped)
```

## Code

```
server/                 API, WhatsApp/Telegram/web runtime, Gemini engine (TypeScript)
  src/core/             reply engine, channel runtime, memory, knowledge indexer, plans
  src/core/agent/       Pro agent: permissions, store connectors, tools, confirmations, order updates
  src/services/         Gemini/Grok client, prompt builder, documents, WhatsApp, Telegram
  src/http/             routes, auth, website chat widget
  test/                 unit, pipeline, HTTP and database (RLS) tests
web/                    dashboard + landing page
  src/components/landing/   particle robot (robot-cloud.bin is generated from the 3D model)
supabase/migrations/    schema, Row Level Security, search and analytics functions
scripts/robot-cloud/    converts the robot 3D model into the landing's particle cloud
pitch-deck/             investor deck (HTML source and PDF)
docs/                   architecture and the training approach
Dockerfile              production image
```
