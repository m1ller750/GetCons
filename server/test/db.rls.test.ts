/**
 * Runs the real Supabase migration inside PGlite (Postgres compiled to WASM, with pgvector)
 * and proves tenant isolation at the database level: RLS, revoked writes, hidden secrets,
 * owner-deriving triggers and tenant-scoped search functions.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../supabase/migrations');
// Every migration, in the order Supabase applies them.
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(path.join(migrationsDir, f), 'utf8'));

// What Supabase provides out of the box (roles, auth schema, default grants).
const SUPABASE_BOOTSTRAP = `
  create schema if not exists extensions;
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email text);
  create or replace function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public, auth, extensions to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  set search_path = public, extensions;
`;

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const vec = (hot: number) => `[${Array.from({ length: 768 }, (_, i) => (i === hot ? 1 : 0)).join(',')}]`;

let db: PGlite;
let consultantA: string;
let consultantB: string;

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const res = await db.query<T>(sql, params);
  return res.rows[0]!;
}

async function as<T>(role: 'authenticated' | 'anon', uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}

async function seedTenant(userId: string, name: string, botId: number) {
  const c = await one<{ id: string }>(
    `insert into consultants (user_id, name, telegram_bot_id) values ($1, $2, $3) returning id`,
    [userId, name, botId],
  );
  await db.query(`insert into consultant_secrets (consultant_id, bot_token_ciphertext, webhook_secret) values ($1, 'v1:cipher', 'hook')`, [c.id]);
  const doc = await one<{ id: string }>(
    `insert into knowledge_documents (consultant_id, user_id, title, source_type, content, status)
     values ($1, gen_random_uuid(), $2, 'text', $3, 'ready') returning id`,
    [c.id, `${name} prices`, `${name} roses cost 5 dollars`],
  );
  await db.query(
    `insert into knowledge_chunks (document_id, consultant_id, user_id, chunk_index, content, embedding)
     values ($1, $2, gen_random_uuid(), 0, $3, $4::extensions.vector),
            ($1, $2, gen_random_uuid(), 1, $5, $6::extensions.vector)`,
    [doc.id, c.id, `${name} red roses cost 5 dollars each`, vec(1), `${name} opening hours 9 to 21`, vec(2)],
  );
  await db.query(
    `insert into training_examples (consultant_id, user_id, customer_message, ideal_reply, embedding)
     values ($1, gen_random_uuid(), 'How much are roses?', $2, $3::extensions.vector)`,
    [c.id, `${name}: $5`, vec(1)],
  );
  const conv = await one<{ id: string }>(
    `insert into conversations (consultant_id, user_id, channel, external_chat_id) values ($1, gen_random_uuid(), 'telegram', 100) returning id`,
    [c.id],
  );
  await db.query(
    `insert into messages (conversation_id, consultant_id, user_id, role, content, telegram_update_id, status, meta)
     values ($1, $2, gen_random_uuid(), 'customer', 'hi', 1, 'ok', '{}'),
            ($1, $2, gen_random_uuid(), 'assistant', 'hello', null, 'fallback', '{"latency_ms": 1200}')`,
    [conv.id, c.id],
  );
  await db.query(`insert into activity_events (consultant_id, user_id, type, message) values ($1, gen_random_uuid(), 'test', 'x')`, [c.id]);
  return c.id;
}

beforeAll(async () => {
  db = new PGlite({ extensions: { vector } });
  await db.exec(SUPABASE_BOOTSTRAP);
  for (const sql of migrations) await db.exec(sql);
  await db.query(`insert into auth.users (id, email) values ($1, 'a@x.com'), ($2, 'b@x.com')`, [A, B]);
  consultantA = await seedTenant(A, 'Alpha', 1001);
  consultantB = await seedTenant(B, 'Beta', 1002);
});

afterAll(async () => {
  await db?.close();
});

describe('database tenant isolation (RLS)', () => {
  it('derives user_id from the consultant, ignoring whatever the writer sent', async () => {
    const rows = await db.query<{ user_id: string; consultant_id: string }>(
      `select user_id, consultant_id from knowledge_chunks union all select user_id, consultant_id from messages`,
    );
    for (const r of rows.rows) expect(r.user_id).toBe(r.consultant_id === consultantA ? A : B);
  });

  it('lets a signed-in user read only their own rows', async () => {
    await as('authenticated', A, async () => {
      for (const table of ['consultants', 'knowledge_documents', 'knowledge_chunks', 'training_examples', 'conversations', 'messages', 'activity_events']) {
        const res = await db.query<{ user_id: string }>(`select user_id from ${table}`);
        expect(res.rows.length, table).toBeGreaterThan(0);
        expect(res.rows.every((r) => r.user_id === A), table).toBe(true);
      }
      const other = await db.query(`select * from consultants where id = $1`, [consultantB]);
      expect(other.rows).toHaveLength(0);
    });
  });

  it('never exposes bot tokens, webhook secrets or WhatsApp sessions to client roles', async () => {
    const c = await one<{ id: string }>(`select id from consultants limit 1`);
    await db.query(`insert into whatsapp_auth (consultant_id, key, value_ciphertext) values ($1, 'creds', 'v1:cipher')`, [c.id]);
    for (const table of ['consultant_secrets', 'whatsapp_auth']) {
      await as('authenticated', A, async () => {
        await expect(db.query(`select * from ${table}`)).rejects.toThrow(/permission denied/);
      });
      await as('anon', null, async () => {
        await expect(db.query(`select * from ${table}`)).rejects.toThrow(/permission denied/);
      });
    }
  });

  it('accepts WhatsApp conversations and keeps WhatsApp message ids unique', async () => {
    const c = await one<{ id: string }>(`select id from consultants limit 1`);
    const conv = await one<{ id: string }>(
      `insert into conversations (consultant_id, user_id, channel, external_chat_id, external_jid)
       values ($1, gen_random_uuid(), 'whatsapp', 4242, '79991234567@s.whatsapp.net') returning id`,
      [c.id],
    );
    const insert = () =>
      db.query(
        `insert into messages (conversation_id, consultant_id, user_id, role, content, external_message_id)
         values ($1, $2, gen_random_uuid(), 'customer', 'hi', 'WAMSG1')`,
        [conv.id, c.id],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key/);
    await expect(
      db.query(`insert into conversations (consultant_id, user_id, channel, external_chat_id) values ($1, gen_random_uuid(), 'viber', 1)`, [c.id]),
    ).rejects.toThrow(/check constraint/);
    await db.query(`delete from conversations where id = $1`, [conv.id]); // keep the shared fixtures intact
  });

  it('blocks all direct writes from client roles (writes go through the backend)', async () => {
    await as('authenticated', A, async () => {
      await expect(db.query(`insert into consultants (user_id, name) values ($1, 'x')`, [A])).rejects.toThrow(/permission denied/);
      await expect(db.query(`update consultants set name = 'hacked' where id = $1`, [consultantA])).rejects.toThrow(/permission denied/);
      await expect(db.query(`delete from messages`)).rejects.toThrow(/permission denied/);
      await expect(
        db.query(`insert into training_examples (consultant_id, user_id, customer_message, ideal_reply) values ($1, $2, 'q', 'a')`, [consultantB, A]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it('keeps trigger functions private but still fires them for the server role', async () => {
    await as('authenticated', A, async () => {
      await expect(db.query('select public.set_owner_from_consultant()')).rejects.toThrow(/permission denied/);
    });
    await db.exec('set role service_role');
    try {
      const row = await one<{ user_id: string }>(
        `insert into training_examples (consultant_id, user_id, customer_message, ideal_reply) values ($1, $2, 'q', 'a') returning user_id`,
        [consultantA, B],
      );
      expect(row.user_id).toBe(A);
    } finally {
      await db.exec('reset role');
    }
  });

  it('gives anonymous visitors nothing', async () => {
    await as('anon', null, async () => {
      await expect(db.query('select * from consultants')).rejects.toThrow(/permission denied/);
    });
  });

  it("scopes search functions to the caller's tenant", async () => {
    await as('authenticated', A, async () => {
      const own = await db.query<{ content: string }>(
        `select * from match_knowledge_chunks($1, $2::extensions.vector, 'roses', 5)`,
        [consultantA, vec(1)],
      );
      expect(own.rows.length).toBeGreaterThan(0);
      const foreign = await db.query(`select * from match_knowledge_chunks($1, $2::extensions.vector, 'roses', 5)`, [consultantB, vec(1)]);
      expect(foreign.rows).toHaveLength(0);
      const examples = await db.query(`select * from match_training_examples($1, $2::extensions.vector, 5)`, [consultantB, vec(1)]);
      expect(examples.rows).toHaveLength(0);
      const stats = await db.query(`select * from consultant_overview($1, 30)`, [consultantB]);
      expect(stats.rows[0]).toMatchObject({ customer_messages: 0 });
    });
  });

  it('prevents cross-tenant references even for the service role', async () => {
    const convA = await one<{ id: string }>(`select id from conversations where consultant_id = $1`, [consultantA]);
    // message claims consultant B but points at A's conversation
    await expect(
      db.query(`insert into messages (conversation_id, consultant_id, user_id, role, content) values ($1, $2, $3, 'customer', 'x')`, [
        convA.id,
        consultantB,
        B,
      ]),
    ).rejects.toThrow(/foreign key/);
    // moving a row to another consultant re-derives its owner
    const ex = await one<{ id: string }>(`select id from training_examples where consultant_id = $1`, [consultantA]);
    const moved = await one<{ user_id: string }>(
      `update training_examples set consultant_id = $1 where id = $2 returning user_id`,
      [consultantB, ex.id],
    );
    expect(moved.user_id).toBe(B);
    await db.query(`update training_examples set consultant_id = $1 where id = $2`, [consultantA, ex.id]);
  });

  it('makes Telegram update processing idempotent and bots unique', async () => {
    const conv = await one<{ id: string }>(`select id from conversations where consultant_id = $1`, [consultantA]);
    await expect(
      db.query(`insert into messages (conversation_id, consultant_id, user_id, role, content, telegram_update_id) values ($1, $2, $3, 'customer', 'dup', 1)`, [
        conv.id,
        consultantA,
        A,
      ]),
    ).rejects.toThrow(/duplicate key/);
    await expect(db.query(`update consultants set telegram_bot_id = 1002 where id = $1`, [consultantA])).rejects.toThrow(/duplicate key/);
  });
});

describe('plans and payments', () => {
  it('caps consultants by plan in the database itself, even for the server role', async () => {
    // A is on Free (1 consultant) and already has one.
    await expect(db.query(`insert into consultants (user_id, name) values ($1, 'second')`, [A])).rejects.toThrow(/limit reached/);
    await db.exec('set role service_role');
    try {
      await expect(db.query(`insert into consultants (user_id, name) values ($1, 'second')`, [A])).rejects.toThrow(/limit reached/);
    } finally {
      await db.exec('reset role');
    }
  });

  it('lets clients read only their own plan and payments, never write or activate them', async () => {
    const pay = await one<{ id: string }>(`insert into payments (user_id, plan, amount, currency) values ($1, 'business', 49, 'USD') returning id`, [B]);
    await as('authenticated', A, async () => {
      expect((await db.query(`select * from payments`)).rows).toHaveLength(0);
      await expect(db.query(`insert into subscriptions (user_id, plan, current_period_end) values ($1, 'pro', now() + interval '1 year')`, [A])).rejects.toThrow(
        /permission denied/,
      );
      await expect(db.query(`update payments set status = 'paid' where id = $1`, [pay.id])).rejects.toThrow(/permission denied/);
      await expect(db.query(`select public.activate_payment($1, 'x')`, [pay.id])).rejects.toThrow(/permission denied/);
      await expect(db.query(`select public.effective_plan($1)`, [A])).rejects.toThrow(/permission denied/);
    });
    await as('anon', null, async () => {
      await expect(db.query(`select * from subscriptions`)).rejects.toThrow(/permission denied/);
    });
    await as('authenticated', B, async () => {
      expect((await db.query(`select * from payments`)).rows).toHaveLength(1);
    });
  });

  it('activates a paid plan exactly once and extends it when the same plan is paid again', async () => {
    const pay = await one<{ id: string }>(`insert into payments (user_id, plan, amount, currency) values ($1, 'business', 49, 'USD') returning id`, [A]);
    const first = await one<{ plan: string; current_period_end: string }>(`select * from activate_payment($1, 'fp-1')`, [pay.id]);
    expect(first.plan).toBe('business');
    // Freedom Pay retries notifications: a repeat must not add more days.
    const again = await one<{ current_period_end: string }>(`select * from activate_payment($1, 'fp-1')`, [pay.id]);
    expect(new Date(again.current_period_end).getTime()).toBe(new Date(first.current_period_end).getTime());
    expect((await one<{ status: string }>(`select status from payments where id = $1`, [pay.id])).status).toBe('paid');
    expect((await one<{ p: string }>(`select effective_plan($1) as p`, [A])).p).toBe('business');

    const renew = await one<{ id: string }>(`insert into payments (user_id, plan, amount, currency) values ($1, 'business', 49, 'USD') returning id`, [A]);
    const extended = await one<{ current_period_end: string }>(`select * from activate_payment($1, 'fp-2')`, [renew.id]);
    const days = (new Date(extended.current_period_end).getTime() - new Date(first.current_period_end).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);

    // Business allows 3 consultants now.
    const second = await one<{ id: string }>(`insert into consultants (user_id, name) values ($1, 'second') returning id`, [A]);
    await db.query(`delete from consultants where id = $1`, [second.id]);

    // An expired plan falls back to Free.
    await db.query(`update subscriptions set current_period_end = now() - interval '1 day' where user_id = $1`, [A]);
    expect((await one<{ p: string }>(`select effective_plan($1) as p`, [A])).p).toBe('free');
  });

  it('keeps the monthly AI reply counter even when chats are deleted, and only the server may bump it', async () => {
    expect((await one<{ n: number }>(`select record_ai_reply($1) as n`, [A])).n).toBe(1);
    expect((await one<{ n: number }>(`select record_ai_reply($1) as n`, [A])).n).toBe(2);
    // Deleting conversations used to be a way to reset a quota derived from messages.
    const conv = await one<{ id: string }>(
      `insert into conversations (consultant_id, user_id, channel, external_chat_id) values ($1, gen_random_uuid(), 'telegram', 777) returning id`,
      [consultantA],
    );
    await db.query(`delete from conversations where id = $1`, [conv.id]);
    expect((await one<{ replies: number }>(`select replies from ai_usage where user_id = $1`, [A])).replies).toBe(2);
    await as('authenticated', A, async () => {
      await expect(db.query(`select record_ai_reply($1)`, [A])).rejects.toThrow(/permission denied/);
      await expect(db.query(`update ai_usage set replies = 0`)).rejects.toThrow(/permission denied/);
      expect((await db.query(`select * from ai_usage`)).rows).toHaveLength(1);
    });
    await as('authenticated', B, async () => {
      expect((await db.query(`select * from ai_usage`)).rows).toHaveLength(0);
    });
  });

  it('gives anonymous callers no database functions at all', async () => {
    await as('anon', null, async () => {
      // Denied at the function itself, not just at the tables it reads.
      await expect(db.query(`select * from consultant_overview($1, 30)`, [consultantA])).rejects.toThrow(/permission denied for function/);
      await expect(db.query(`select * from match_knowledge_chunks($1, null, 'roses', 3)`, [consultantA])).rejects.toThrow(
        /permission denied for function/,
      );
    });
    // Signed-in users keep them (under RLS).
    await as('authenticated', A, async () => {
      await expect(db.query(`select * from consultant_overview($1, 30)`, [consultantA])).resolves.toBeTruthy();
    });
  });
});

describe('retrieval and analytics functions', () => {
  it('ranks by semantic similarity and full-text (hybrid RRF) and returns document titles', async () => {
    const hours = await db.query<{ content: string; document_title: string; similarity: number }>(
      `select * from match_knowledge_chunks($1, $2::extensions.vector, 'opening hours', 2)`,
      [consultantA, vec(2)],
    );
    expect(hours.rows[0]!.content).toContain('opening hours');
    expect(hours.rows[0]!.document_title).toBe('Alpha prices');
    expect(hours.rows[0]!.similarity).toBeCloseTo(1);

    // keyword-only search (no embedding available) still works
    const keyword = await db.query<{ content: string; similarity: number }>(
      `select * from match_knowledge_chunks($1, null, 'roses', 3)`,
      [consultantA],
    );
    expect(keyword.rows.length).toBeGreaterThan(0);
    expect(keyword.rows.every((r) => r.content.includes('roses'))).toBe(true);
  });

  it('finds the most similar training example', async () => {
    const res = await db.query<{ ideal_reply: string; similarity: number }>(
      `select * from match_training_examples($1, $2::extensions.vector, 1)`,
      [consultantA, vec(1)],
    );
    expect(res.rows[0]).toMatchObject({ ideal_reply: 'Alpha: $5' });
    expect(res.rows[0]!.similarity).toBeCloseTo(1);
  });

  it('computes daily stats and KPIs for Telegram traffic', async () => {
    const daily = await db.query<{ customer_messages: number; ai_replies: number; fallbacks: number }>(
      `select * from consultant_daily_stats($1, 7, 'Europe/Moscow')`,
      [consultantA],
    );
    expect(daily.rows).toHaveLength(7);
    const today = daily.rows.at(-1)!;
    expect(Number(today.customer_messages)).toBe(1);
    expect(Number(today.ai_replies)).toBe(1);
    expect(Number(today.fallbacks)).toBe(1);

    const kpi = await one<{ conversations: number; fallbacks: number; avg_latency_ms: number }>(
      `select * from consultant_overview($1, 30)`,
      [consultantA],
    );
    expect(Number(kpi.conversations)).toBe(1);
    expect(Number(kpi.fallbacks)).toBe(1);
    expect(Number(kpi.avg_latency_ms)).toBe(1200);
  });
});

describe('agent and website chat tables', () => {
  it('accepts website chats, keeps store credentials server-only and shows owners only their agent actions', async () => {
    const conv = await one<{ id: string }>(
      `insert into conversations (consultant_id, user_id, channel, external_chat_id, external_jid)
       values ($1, gen_random_uuid(), 'web', 919191, 'web:abc') returning id`,
      [consultantA],
    );
    await db.query(
      `insert into store_connections (consultant_id, user_id, platform, store_url, credentials_ciphertext)
       values ($1, gen_random_uuid(), 'woocommerce', 'https://shop.test', 'v1:secret')`,
      [consultantA],
    );
    const action = await one<{ user_id: string }>(
      `insert into agent_actions (consultant_id, user_id, conversation_id, kind, status, confirm_code)
       values ($1, gen_random_uuid(), $2, 'create_order', 'awaiting_customer', 'ABC123') returning user_id`,
      [consultantA, conv.id],
    );
    expect(action.user_id).toBe(A);

    await as('authenticated', A, async () => {
      await expect(db.query('select * from store_connections')).rejects.toThrow(/permission denied/);
      expect((await db.query('select * from agent_actions')).rows).toHaveLength(1);
      await expect(db.query(`update agent_actions set status = 'done'`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`update consultants set agent = '{"enabled":true}'`)).rejects.toThrow(/permission denied/);
    });
    await as('authenticated', B, async () => {
      expect((await db.query('select * from agent_actions')).rows).toHaveLength(0);
    });
    await as('anon', null, async () => {
      await expect(db.query('select * from agent_actions')).rejects.toThrow(/permission denied/);
      await expect(db.query('select * from agent_orders')).rejects.toThrow(/permission denied/);
    });
    // Another tenant's action can never point at this conversation.
    await expect(
      db.query(
        `insert into agent_actions (consultant_id, user_id, conversation_id, kind, status) values ($1, gen_random_uuid(), $2, 'refund', 'awaiting_owner')`,
        [consultantB, conv.id],
      ),
    ).rejects.toThrow(/foreign key/);
    await expect(db.query(`update consultants set web_key = 'bad key!' where id = $1`, [consultantA])).rejects.toThrow(/check constraint/);

    await db.query('delete from conversations where id = $1', [conv.id]);
    await db.query('delete from store_connections where consultant_id = $1', [consultantA]);
  });
});
