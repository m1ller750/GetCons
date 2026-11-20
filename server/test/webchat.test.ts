import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { KnowledgeIndexer } from '../src/core/knowledge.js';
import { ConsultantRuntime } from '../src/core/runtime.js';
import type { TelegramTransport } from '../src/core/transport.js';
import { createApp } from '../src/http/app.js';
import { visitorHash, webView } from '../src/http/routes/webchat.js';
import { silentLogger } from '../src/lib/logger.js';
import type { SupabaseClient } from '../src/lib/supabase.js';
import { FakeLlm, FakeStore, FakeTelegram, makeConsultant, testConfig } from './helpers/fakes.js';

type Row = Record<string, unknown>;

/** Service-role stand-in over the fake store's arrays (no row level security). */
function adminClient(tables: () => Record<string, Row[]>): SupabaseClient {
  class Query {
    private filters: ((r: Row) => boolean)[] = [];
    private single = false;
    private sort: { col: string; asc: boolean } | null = null;
    private max = Infinity;
    constructor(private table: string) {}
    select() {
      return this;
    }
    eq(col: string, value: unknown) {
      this.filters.push((r) => r[col] === value);
      return this;
    }
    in(col: string, values: unknown[]) {
      this.filters.push((r) => values.includes(r[col]));
      return this;
    }
    gt(col: string, value: string) {
      this.filters.push((r) => String(r[col]) > value);
      return this;
    }
    order(col: string, opts?: { ascending?: boolean }) {
      this.sort = { col, asc: opts?.ascending !== false };
      return this;
    }
    limit(n: number) {
      this.max = n;
      return this;
    }
    maybeSingle() {
      this.single = true;
      return this;
    }
    then(resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      let rows = (tables()[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)));
      if (this.sort) {
        const { col, asc } = this.sort;
        rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
      }
      rows = rows.slice(0, this.max);
      const result = this.single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
      return Promise.resolve(result).then(resolve, reject);
    }
  }
  return { from: (table: string) => new Query(table) } as unknown as SupabaseClient;
}

function setup() {
  const config = testConfig();
  const store = new FakeStore();
  const llm = new FakeLlm();
  const telegram = new FakeTelegram();
  const logger = silentLogger();
  const consultant = store.addConsultant(
    makeConsultant({ web_enabled: true, web_key: 'shopChat_123', greeting_message: 'Hi! Ask me anything.' }),
    null,
    config.encryptionKey,
  );
  const off = store.addConsultant(makeConsultant({ web_enabled: false, web_key: 'closedChat_1' }), null, config.encryptionKey);
  const runtime = new ConsultantRuntime({ store, llm, config, logger, telegram: telegram.factory, debounceMs: 0 });
  const transport: TelegramTransport = { mode: 'webhook', attach: async () => undefined, detach: async () => undefined, start: async () => undefined, stop: async () => undefined };
  const app = createApp({
    config,
    logger,
    store,
    admin: adminClient(() => ({
      consultants: [...store.consultants.values()] as unknown as Row[],
      conversations: store.conversations as unknown as Row[],
      messages: store.messages as unknown as Row[],
    })),
    userClient: () => ({}) as SupabaseClient,
    auth: { verify: async () => null },
    llm,
    telegram: telegram.factory,
    runtime,
    transport,
    indexer: new KnowledgeIndexer({ store, llm, config, logger }),
    webDistPath: null,
  });
  return { app, store, llm, runtime, consultant, off };
}

const VISITOR = 'f3a9c2d4e5b6a7980123456789abcdef';

describe('website chat (public)', () => {
  it('serves the chat page and widget so that any site can embed them', async () => {
    const { app } = setup();
    const page = await request(app).get('/c/shopChat_123');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/html/);
    expect(page.headers['content-security-policy']).toContain('frame-ancestors *');
    expect(page.headers['x-frame-options']).toBeUndefined();
    expect(page.text).toContain('data-key="shopChat_123"');
    expect(page.text).toContain('/c-assets/chat.js');

    const injected = await request(app).get('/c/%22%3E%3Cscript%3E');
    expect(injected.text).not.toContain('"><script>');

    const widget = await request(app).get('/widget.js');
    expect(widget.headers['content-type']).toMatch(/javascript/);
    expect(widget.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(widget.text).toContain("'/c/'");

    // The dashboard keeps its strict framing rules.
    expect((await request(app).get('/api/health')).headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('runs a conversation for an anonymous visitor and never stores their id', async () => {
    const { app, store, llm, runtime } = setup();
    const cfg = await request(app).get('/api/public/chat/shopChat_123');
    expect(cfg.status).toBe(200);
    expect(cfg.body).toEqual({ name: 'Anna', businessName: 'Flower Shop', greeting: 'Hi! Ask me anything.', poweredBy: true });

    expect((await request(app).post('/api/public/chat/shopChat_123/messages').send({ visitor: 'short', text: 'hi' })).status).toBe(400);
    expect((await request(app).post('/api/public/chat/shopChat_123/messages').send({ visitor: VISITOR, text: '' })).status).toBe(400);

    llm.queue({ reply: 'We have red roses for $5.' });
    const sent = await request(app).post('/api/public/chat/shopChat_123/messages').send({ visitor: VISITOR, text: 'Do you have roses?', clientId: 'msg_0001' });
    expect(sent.status).toBe(202);
    await runtime.drain();

    const conv = store.conversations[0]!;
    expect(conv).toMatchObject({ channel: 'web', external_jid: `web:${visitorHash(VISITOR)}` });
    expect(JSON.stringify(store.conversations)).not.toContain(VISITOR);

    const polled = await request(app).get(`/api/public/chat/shopChat_123/messages?visitor=${VISITOR}`);
    expect(polled.body.messages.map((m: { role: string; text: string }) => [m.role, m.text])).toEqual([
      ['customer', 'Do you have roses?'],
      ['assistant', 'We have red roses for $5.'],
    ]);
    const after = polled.body.messages[0].at;
    const since = await request(app).get(`/api/public/chat/shopChat_123/messages?visitor=${VISITOR}&after=${encodeURIComponent(after)}`);
    expect(since.body.messages).toHaveLength(1);

    // Another visitor sees nothing of it.
    const stranger = await request(app).get('/api/public/chat/shopChat_123/messages?visitor=0000000000000000000000000000beef');
    expect(stranger.body).toEqual({ messages: [], typing: false });
  });

  it('hides chats that are switched off or unknown', async () => {
    const { app } = setup();
    expect((await request(app).get('/api/public/chat/closedChat_1')).status).toBe(404);
    expect((await request(app).get('/api/public/chat/nope_nope_nope')).status).toBe(404);
    expect((await request(app).post('/api/public/chat/closedChat_1/messages').send({ visitor: VISITOR, text: 'hi' })).status).toBe(404);
  });

  it('gives the owner a link and a one-line widget code', () => {
    expect(webView({ web_enabled: true, web_key: 'abcDEF123456' }, 'https://getcons.test')).toEqual({
      enabled: true,
      key: 'abcDEF123456',
      link: 'https://getcons.test/c/abcDEF123456',
      widgetSnippet: '<script src="https://getcons.test/widget.js" data-key="abcDEF123456" async></script>',
    });
  });
});
