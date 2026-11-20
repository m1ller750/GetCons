import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { KnowledgeIndexer } from '../src/core/knowledge.js';
import { ConsultantRuntime } from '../src/core/runtime.js';
import type { TelegramTransport } from '../src/core/transport.js';
import { createApp } from '../src/http/app.js';
import { silentLogger } from '../src/lib/logger.js';
import type { SupabaseClient } from '../src/lib/supabase.js';
import { FakeLlm, FakeStore, FakeTelegram, makeConsultant, testConfig, textUpdate } from './helpers/fakes.js';

type Row = Record<string, unknown>;

/**
 * Minimal stand-in for an RLS-scoped Supabase client: rows owned by other users are invisible,
 * exactly like Postgres row level security behaves for the `authenticated` role.
 */
function rlsClient(tables: Record<string, Row[]>, userId: string): SupabaseClient {
  class Query {
    private filters: ((r: Row) => boolean)[] = [];
    private head = false;
    private single = false;
    constructor(private rows: Row[]) {}
    select(_cols?: string, opts?: { head?: boolean }) {
      if (opts?.head) this.head = true;
      return this;
    }
    eq(col: string, value: unknown) {
      this.filters.push((r) => r[col] === value);
      return this;
    }
    neq(col: string, value: unknown) {
      this.filters.push((r) => r[col] !== value);
      return this;
    }
    in(col: string, values: unknown[]) {
      this.filters.push((r) => values.includes(r[col]));
      return this;
    }
    order() {
      return this;
    }
    range() {
      return this;
    }
    limit() {
      return this;
    }
    maybeSingle() {
      this.single = true;
      return this;
    }
    // Thenable, like supabase-js query builders.
    then(resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      const rows = this.rows.filter((r) => r.user_id === userId && this.filters.every((f) => f(r)));
      const result = this.head
        ? { count: rows.length, error: null }
        : this.single
          ? { data: rows[0] ?? null, error: null }
          : { data: rows, count: rows.length, error: null };
      return Promise.resolve(result).then(resolve, reject);
    }
  }
  return { from: (table: string) => new Query(tables[table] ?? []) } as unknown as SupabaseClient;
}

const TOKEN = '111:AAEtesttokentesttokentesttokentest';

function setup() {
  const config = testConfig();
  const store = new FakeStore();
  const llm = new FakeLlm();
  const telegram = new FakeTelegram();
  const logger = silentLogger();
  const alice = 'aaaaaaaa-0000-4000-8000-000000000001';
  const bob = 'bbbbbbbb-0000-4000-8000-000000000002';
  const aliceConsultant = store.addConsultant(makeConsultant({ user_id: alice }), TOKEN, config.encryptionKey);
  const bobConsultant = store.addConsultant(makeConsultant({ user_id: bob, telegram_bot_id: 222 }), null, config.encryptionKey);
  const tables = { consultants: [aliceConsultant, bobConsultant] as unknown as Row[] };

  const runtime = new ConsultantRuntime({ store, llm, config, logger, telegram: telegram.factory, debounceMs: 0 });
  const transport: TelegramTransport = {
    mode: 'webhook',
    attach: async () => undefined,
    detach: async () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
  };
  const users: Record<string, { id: string; email: string }> = {
    'token-alice': { id: alice, email: 'alice@example.com' },
    'token-bob': { id: bob, email: 'bob@example.com' },
  };
  const app = createApp({
    config,
    logger,
    store,
    admin: {} as SupabaseClient,
    userClient: (token) => rlsClient(tables, users[token]!.id),
    auth: { verify: async (token) => users[token] ?? null },
    llm,
    telegram: telegram.factory,
    runtime,
    transport,
    indexer: new KnowledgeIndexer({ store, llm, config, logger }),
    webDistPath: null,
  });
  return { app, store, runtime, telegram, aliceConsultant, bobConsultant, llm };
}

describe('HTTP API', () => {
  it('serves health and public config without auth, never exposing server secrets', async () => {
    const { app } = setup();
    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ ok: true, telegramMode: 'webhook' });

    const cfg = await request(app).get('/api/public-config');
    expect(cfg.body).toEqual({
      supabaseUrl: 'https://example.supabase.co',
      supabaseAnonKey: 'anon-key-for-tests-000000',
      telegramMode: 'webhook',
    });
    expect(JSON.stringify(cfg.body)).not.toContain('service-key');
    expect(JSON.stringify(cfg.body)).not.toContain('gemini');
  });

  it('requires a valid session for the dashboard API', async () => {
    const { app } = setup();
    expect((await request(app).get('/api/consultants')).status).toBe(401);
    const bad = await request(app).get('/api/me').set('Authorization', 'Bearer forged');
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('unauthorized');
    const me = await request(app).get('/api/me').set('Authorization', 'Bearer token-alice');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('alice@example.com');
  });

  it("isolates tenants: a user cannot open another user's consultant", async () => {
    const { app, aliceConsultant, bobConsultant } = setup();
    const own = await request(app).get(`/api/consultants/${aliceConsultant.id}`).set('Authorization', 'Bearer token-alice');
    expect(own.status).toBe(200);
    expect(own.body.consultant.id).toBe(aliceConsultant.id);
    expect(own.body.consultant).not.toHaveProperty('bot_token_ciphertext');

    for (const path of ['', '/knowledge', '/conversations', '/examples', '/analytics', '/playground']) {
      const res = await request(app).get(`/api/consultants/${bobConsultant.id}${path}`).set('Authorization', 'Bearer token-alice');
      expect(res.status, path).toBe(404);
    }
    const write = await request(app)
      .patch(`/api/consultants/${bobConsultant.id}`)
      .set('Authorization', 'Bearer token-alice')
      .send({ instructions: 'hijack' });
    expect(write.status).toBe(404);
    const invalid = await request(app).get('/api/consultants/not-a-uuid').set('Authorization', 'Bearer token-alice');
    expect(invalid.status).toBe(400);
  });

  it('accepts Telegram webhooks only with the per-bot secret, then replies asynchronously', async () => {
    const { app, store, runtime, telegram, aliceConsultant, llm } = setup();
    llm.queue({ reply: 'Hello from Gemini!' });
    const update = textUpdate(77, 'Hi there');

    const wrong = await request(app)
      .post(`/telegram/webhook/${aliceConsultant.id}`)
      .set('X-Telegram-Bot-Api-Secret-Token', 'guess')
      .send(update);
    expect(wrong.status).toBe(401);
    const missing = await request(app).post(`/telegram/webhook/${aliceConsultant.id}`).send(update);
    expect(missing.status).toBe(401);
    expect(store.messages).toHaveLength(0);

    const ok = await request(app)
      .post(`/telegram/webhook/${aliceConsultant.id}`)
      .set('X-Telegram-Bot-Api-Secret-Token', `secret-${aliceConsultant.id}`)
      .send(update);
    expect(ok.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    await runtime.drain();
    expect(telegram.bot(TOKEN).sent.at(-1)).toMatchObject({ chatId: 77, text: 'Hello from Gemini!' });
    expect(store.messages.map((m) => m.role)).toEqual(['customer', 'assistant']);
  });

  it('rejects webhooks for consultants without a bot and malformed ids', async () => {
    const { app, bobConsultant } = setup();
    const res = await request(app)
      .post(`/telegram/webhook/${bobConsultant.id}`)
      .set('X-Telegram-Bot-Api-Secret-Token', `secret-${bobConsultant.id}`)
      .send(textUpdate(1, 'x'));
    expect(res.status).toBe(401);
    expect((await request(app).post('/telegram/webhook/../../etc').send({})).status).toBe(404);
  });

  it('returns JSON errors for bad input', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/api/consultants')
      .set('Authorization', 'Bearer token-alice')
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_json');
    const unknown = await request(app).get('/api/nope').set('Authorization', 'Bearer token-alice');
    expect(unknown.status).toBe(404);
  });
});
