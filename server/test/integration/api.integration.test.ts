/**
 * End-to-end isolation test against a REAL Supabase project (with the migration applied).
 * Gemini and Telegram are faked so it costs nothing. Run with:
 *
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... npm run test:integration
 *
 * Creates two throwaway users and deletes them afterwards.
 */
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDotEnv } from '../../src/config.js';
import { KnowledgeIndexer } from '../../src/core/knowledge.js';
import { ConsultantRuntime } from '../../src/core/runtime.js';
import type { TelegramTransport } from '../../src/core/transport.js';
import { createSupabaseStore } from '../../src/db/supabaseStore.js';
import { createApp } from '../../src/http/app.js';
import { silentLogger } from '../../src/lib/logger.js';
import { createAdminClient, createSupabaseAuthVerifier, createUserClient } from '../../src/lib/supabase.js';
import { FakeLlm, FakeTelegram, testConfig } from '../helpers/fakes.js';

loadDotEnv();
const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
const enabled = Boolean(url && anonKey && serviceKey);

function buildApp() {
  const config = testConfig({ supabase: { url: url!, anonKey: anonKey!, serviceRoleKey: serviceKey! } });
  const logger = silentLogger();
  const admin = createAdminClient(config);
  const llm = new FakeLlm();
  const store = createSupabaseStore(admin, logger);
  const indexer = new KnowledgeIndexer({ store, llm, config, logger });
  const telegram = new FakeTelegram().factory;
  const runtime = new ConsultantRuntime({ store, llm, config, logger, telegram, debounceMs: 0 });
  const transport: TelegramTransport = { mode: 'webhook', attach: async () => {}, detach: async () => {}, start: async () => {}, stop: async () => {} };
  const app = createApp({
    config,
    logger,
    store,
    admin,
    userClient: (t) => createUserClient(config, t),
    auth: createSupabaseAuthVerifier(admin),
    llm,
    telegram,
    runtime,
    transport,
    indexer,
  });
  return { app, admin, config, llm, indexer };
}

describe.skipIf(!enabled)('live Supabase: end-to-end tenant isolation', () => {
  let ctx: ReturnType<typeof buildApp>;
  const users: { id: string; token: string; client: SupabaseClient }[] = [];

  beforeAll(async () => {
    ctx = buildApp();
    const { admin, config } = ctx;
    for (const name of ['alice', 'bob']) {
      const email = `getcons-test-${name}-${randomUUID().slice(0, 8)}@example.com`;
      const password = `Pw-${randomUUID()}`;
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error) throw created.error;
      const anon = createClient(url!, anonKey!, { auth: { persistSession: false } });
      const session = await anon.auth.signInWithPassword({ email, password });
      if (session.error) throw session.error;
      users.push({ id: created.data.user!.id, token: session.data.session!.access_token, client: createUserClient(config, session.data.session!.access_token) });
    }
  });

  afterAll(async () => {
    for (const u of users) await ctx.admin.auth.admin.deleteUser(u.id);
  });

  it('keeps every consultant, document and conversation private to its owner', async () => {
    const { app, indexer, llm } = ctx;
    const [alice, bob] = users as [(typeof users)[0], (typeof users)[0]];
    const auth = (u: typeof alice) => ({ Authorization: `Bearer ${u.token}` });

    const created = await request(app).post('/api/consultants').set(auth(alice)).send({ name: 'Anna', businessName: 'Bloom' });
    expect(created.status).toBe(201);
    const id = created.body.consultant.id as string;

    const doc = await request(app)
      .post(`/api/consultants/${id}/knowledge/text`)
      .set(auth(alice))
      .send({ title: 'Prices', content: 'Red roses cost $5 each. Delivery is free over $50.' });
    expect(doc.status).toBe(201);
    await indexer.idle();

    const search = await request(app).post(`/api/consultants/${id}/knowledge/search`).set(auth(alice)).send({ query: 'roses price' });
    expect(search.body.results.length).toBeGreaterThan(0);

    llm.queue({ reply: 'Roses are $5.' });
    const chat = await request(app).post(`/api/consultants/${id}/playground`).set(auth(alice)).send({ text: 'Price of roses?' });
    expect(chat.body.message.content).toBe('Roses are $5.');

    // Bob sees nothing of Alice's, through the API...
    expect((await request(app).get('/api/consultants').set(auth(bob))).body.consultants).toEqual([]);
    for (const path of ['', '/knowledge', '/playground', '/analytics']) {
      expect((await request(app).get(`/api/consultants/${id}${path}`).set(auth(bob))).status, path).toBe(404);
    }
    expect((await request(app).delete(`/api/consultants/${id}`).set(auth(bob))).status).toBe(404);

    // ...or directly through Supabase with his own JWT and the public key.
    expect((await bob.client.from('consultants').select('*')).data).toEqual([]);
    expect((await bob.client.from('knowledge_chunks').select('*')).data).toEqual([]);
    expect((await bob.client.from('messages').select('*')).data).toEqual([]);
    const secrets = await bob.client.from('consultant_secrets').select('*');
    expect(secrets.error ?? (secrets.data?.length === 0 ? 'empty' : null)).toBeTruthy();
    const write = await bob.client.from('consultants').update({ name: 'hacked' }).eq('id', id).select();
    expect(write.error || write.data?.length === 0).toBeTruthy();
    const rpc = await bob.client.rpc('match_knowledge_chunks', { p_consultant_id: id, p_embedding: null, p_query: 'roses', p_match_count: 5 });
    expect(rpc.data ?? []).toEqual([]);

    // Alice herself can read but not write directly (writes go through the backend).
    expect((await alice.client.from('consultants').select('id')).data).toEqual([{ id }]);
    const aliceWrite = await alice.client.from('consultants').update({ name: 'direct' }).eq('id', id).select();
    expect(aliceWrite.error || aliceWrite.data?.length === 0).toBeTruthy();
  });
});
