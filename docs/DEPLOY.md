# Deploying GetCons on Railway + Supabase

The production setup is **one Railway service** (always on) plus **one Supabase project**.

## 1. Supabase

1. Create a project at [supabase.com](https://supabase.com). Pick a region close to your Railway region.
2. **Database.** Open SQL Editor в†’ New query, paste [`supabase/migrations/20261024000000_init.sql`](../supabase/migrations/20261024000000_init.sql), and run it. This enables `pgvector` and creates the tables, RLS policies and search/analytics functions.
   * With the CLI instead: `supabase link --project-ref <ref>`, then `supabase db push`.
3. **Keys** (Project Settings в†’ API keys):
   * `SUPABASE_URL`: the project URL.
   * `SUPABASE_ANON_KEY`: the *publishable* (or legacy *anon*) key. It is public.
   * `SUPABASE_SERVICE_ROLE_KEY`: the *secret* (or legacy *service_role*) key. **Server only.**
4. **Auth** (Authentication в†’ URL Configuration): set *Site URL* to `https://<your-app>.up.railway.app` and add `https://<your-app>.up.railway.app/**` to *Redirect URLs*. That makes email confirmation and password-reset links come back to the dashboard. For production, configure a custom SMTP sender under Authentication в†’ Emails.

## 2. Gemini

Create an API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Enable billing for production traffic, because the free tier has low rate limits. The defaults are:

* `GEMINI_MODEL=gemini-3.5-flash-lite`: fast and cheap. Use `gemini-3.8-flash` for harder reasoning.
* `GEMINI_FALLBACK_MODEL=gemini-3.1-flash-lite`: used automatically if the primary model errors.
* `GEMINI_EMBEDDING_MODEL=gemini-embedding-001`: 768 dimensions (fixed by the schema).

The key is read only by the server. It never reaches the browser.

## 2b. Manager bot (one-click bot creation), done once for the whole platform

Your customers never touch @BotFather. The platform has **one** bot of its own that creates their bots through Telegram **Managed Bots** (Bot API 9.6+).

1. In Telegram, open @BotFather and send `/newbot`. Create the platform bot, for example `@GetConsBot`.
2. Open the **@BotFather mini app**, select that bot, and enable **Bot Management**. This allows the bot to create and manage other bots.
3. Put its token in the `MANAGER_BOT_TOKEN` variable (Railway and `.env`).
4. On start, the server checks `getMe().can_manage_bots`, registers `https://<domain>/telegram/manager` as the manager's webhook, and enables the **Create consultant & Telegram bot** button. If something is missing, `/api/me` в†’ `managerBot.problem` says what.

How a customer's bot is created:
1. The dashboard opens `https://t.me/newbot/<manager>/<suggested_username>?name=<name>`. On desktop, a QR code is shown.
2. Telegram shows the pre-filled "Create bot" sheet and the customer taps **Create**. Telegram always asks the owner to confirm.
3. The manager receives a `managed_bot` update, calls `getManagedBotToken`, encrypts the token, sets the webhook and profile, and activates the consultant. The dashboard shows `@username`.
4. If the customer edited the username, the "Link it" link (`t.me/<manager>?start=claim_вЂ¦`) proves their Telegram account and attaches the bot.

## 3. Railway

1. Push this repository to GitHub.
2. In Railway, choose **New Project в†’ Deploy from GitHub repo**. Railway detects the root `Dockerfile`.
3. Under **Variables**, add:

   | Variable | Value |
   |---|---|
   | `SUPABASE_URL` | from step 1 |
   | `SUPABASE_ANON_KEY` | from step 1 |
   | `SUPABASE_SERVICE_ROLE_KEY` | from step 1 |
   | `GEMINI_API_KEY` | from step 2 |
   | `MANAGER_BOT_TOKEN` | token of the platform manager bot (step 2b) |
   | `ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Keep it forever: changing it invalidates stored bot tokens. |
   | `NODE_ENV` | `production` (already set in the Dockerfile) |

4. Under **Settings в†’ Networking**, click **Generate Domain**. Railway injects `RAILWAY_PUBLIC_DOMAIN`. On boot the server switches to **webhook mode** and registers `https://<domain>/telegram/webhook/<consultantId>` for every connected bot.
5. Under **Settings в†’ Deploy**:
   * Healthcheck path: `/api/health`
   * Restart policy: *Always*
   * **Serverless (app sleeping): off.** Bots must be reachable 24/7.
   * Replicas: 1. See the scaling note in the README.
6. Deploy, open the domain, sign up, create a consultant and connect a bot.

### Infrastructure as Code (optional)

[`.railway/railway.ts`](../.railway/railway.ts) declares the same service. Set your GitHub repo in it, then run:

```bash
npx railway login
npx railway link
npx railway config plan
npx railway config apply
```

Secrets are declared with `preserve()`, so their values stay in Railway and never go into git. Railway's older `railway.json` "Config as Code" is deprecated, so it isn't used.

## 4. Verify

* `GET https://<domain>/api/health` returns `{"ok":true,"telegramMode":"webhook"}`.
* Settings в†’ Telegram shows "Telegram is delivering messages" with no pending updates.
* Send `/start` to your bot. The reply appears in **Conversations** within seconds.
* Turn on **Alerts for you** so you get a Telegram message whenever the AI needs help.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Server exits with `Invalid configuration` | The log lists every missing or invalid variable. |
| Bot doesn't answer | Check Settings в†’ Telegram for the last Telegram error, the consultant status (paused?), and the per-chat AI switch. |
| `Telegram rejected the bot token` | The token was revoked in BotFather. Paste a new token under Settings в†’ Telegram. |
| Answers say "I'll check with the team" too often | Add the missing facts to Business info or the Knowledge base, and use **Test retrieval** to confirm they are found. |
| Gemini 429 errors | Enable billing or raise quota. Set `GEMINI_FALLBACK_MODEL`. |
| Sign-up emails link to localhost | Fix the Supabase Auth *Site URL*. |
