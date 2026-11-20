import { describe, expect, it } from 'vitest';
import { OrderNotifier } from '../src/core/agent/notifier.js';
import { AgentService, contactMatches, customerLang } from '../src/core/agent/service.js';
import type { ReplyQuota } from '../src/core/billing.js';
import { PLANS, type PlanId } from '../src/core/plans.js';
import { ConsultantRuntime } from '../src/core/runtime.js';
import { encryptSecret } from '../src/lib/crypto.js';
import { silentLogger } from '../src/lib/logger.js';
import { FakeAgentStore, FakeLlm, FakeShop, FakeStore, FakeTelegram, makeConsultant, testConfig } from './helpers/fakes.js';

const TOKEN = '111:AAEtesttokentesttokentesttokentest';
const VISITOR = 'visitorhash0000000000000000000001';

async function setup(opts: { plan?: PlanId; shop?: boolean; agent?: Record<string, unknown> } = {}) {
  const config = testConfig();
  const store = new FakeStore();
  const llm = new FakeLlm();
  const telegram = new FakeTelegram();
  const consultant = store.addConsultant(
    makeConsultant({ web_enabled: true, web_key: 'testkey12345', owner_chat_id: 777, agent: { enabled: true, ...opts.agent } }),
    TOKEN,
    config.encryptionKey,
  );
  const agentStore = new FakeAgentStore(() => consultant.user_id);
  const shop = new FakeShop();
  const agent = new AgentService({ agentStore, config, logger: silentLogger(), connector: () => shop });
  if (opts.shop !== false) {
    await agentStore.saveConnection({
      consultant_id: consultant.id,
      platform: 'woocommerce',
      store_url: 'https://shop.test',
      store_name: 'Flower Shop',
      currency: 'USD',
      credentials_ciphertext: encryptSecret(JSON.stringify({ platform: 'woocommerce', consumerKey: 'ck_x', consumerSecret: 'cs_y' }), config.encryptionKey),
      status: 'connected',
      last_error: null,
    });
  }
  const plan = PLANS[opts.plan ?? 'pro'];
  const quota: ReplyQuota = { check: async () => ({ plan, used: 0, allowed: true }), record: () => undefined };
  const runtime = new ConsultantRuntime({ store, llm, config, logger: silentLogger(), telegram: telegram.factory, debounceMs: 0, quota, agent });
  const say = async (text: string, visitor = VISITOR) => {
    await runtime.handleWeb(consultant.id, { visitor, text });
    await runtime.drain();
  };
  const conversation = () => store.conversations.find((c) => c.channel === 'web')!;
  const lastReply = () => store.messagesOf(conversation().id).filter((m) => m.role === 'assistant').at(-1)!;
  return { config, store, llm, telegram, consultant, agentStore, shop, agent, runtime, say, conversation, lastReply, bot: telegram.bot(TOKEN) };
}

describe('Pro plan agent', () => {
  it('places an order only after the customer confirms it in a new message', async () => {
    const t = await setup();
    t.llm.queueAgent(
      {
        tools: [
          { name: 'find_products', args: { query: 'roses' } },
          {
            name: 'prepare_order',
            args: { items: [{ product_id: '11', name: 'Red roses', quantity: 2 }], customer_name: 'Maria', phone: '+7 701 555 12 34', address: 'Abay 10', city: 'Almaty' },
          },
          // A model that tries to confirm in the same turn is refused.
          { name: 'confirm_action', args: (calls) => ({ confirmation_code: calls[1]!.result.confirmation_code }) },
        ],
        reply: (calls) => ({ reply: `Please confirm:\n${calls[1]!.result.summary}` }),
      },
      {
        tools: [{ name: 'confirm_action', args: () => ({ confirmation_code: t.agentStore.actions[0]!.confirm_code }) }],
        reply: (calls) => ({ reply: `Done! Pay here: ${(calls[0]!.result.order as { payment_url: string }).payment_url}` }),
      },
    );

    await t.say('I want two bunches of red roses to Abay 10, Almaty. Maria, +7 701 555 12 34');
    const first = t.llm.agentCalls[0]!;
    expect(first.tools.map((x) => x.name)).toEqual(['find_products', 'get_order', 'prepare_order', 'prepare_cancellation', 'prepare_return', 'confirm_action', 'cancel_pending_action']);
    expect(first.system).toContain('You are an agent');
    expect(first.system).toContain('"reply" tool');
    expect(t.shop.created).toHaveLength(0);
    expect(t.agentStore.actions[0]).toMatchObject({ kind: 'create_order', status: 'awaiting_customer', amount: 90, currency: 'USD' });
    expect(t.lastReply().content).toContain('Red roses, 11 stems × 2 (45 USD)');
    expect(t.lastReply().content).toContain('Total: 90 USD');
    expect(t.lastReply().meta.agent_tools).toEqual([
      { tool: 'find_products', ok: true },
      { tool: 'prepare_order', ok: true },
      { tool: 'confirm_action', ok: false, error: expect.stringContaining('wait for the customer') },
    ]);

    await t.say('Yes, confirm');
    expect(t.shop.created).toEqual([
      {
        items: [{ productId: '11', variantId: null, quantity: 2 }],
        customer: { name: 'Maria', phone: '+7 701 555 12 34', address: 'Abay 10', city: 'Almaty' },
      },
    ]);
    expect(t.agentStore.actions[0]).toMatchObject({ status: 'done', external_ref: '1001' });
    expect(t.agentStore.orders).toMatchObject([{ external_id: '1001', conversation_id: t.conversation().id, notified_status: 'pending' }]);
    expect(t.lastReply().content).toBe('Done! Pay here: https://shop.test/pay/1001');
  });

  it('is a plain consultant on plans without the agent, and when the owner turns it off', async () => {
    const free = await setup({ plan: 'business' });
    await free.say('Do you have roses?');
    expect(free.llm.agentCalls).toHaveLength(0);
    expect(free.llm.generateCalls).toHaveLength(1);

    const off = await setup({ agent: { enabled: false } });
    await off.say('Do you have roses?');
    expect(off.llm.agentCalls).toHaveLength(0);
  });

  it('shows an order only to its owner: placed in this chat, or with the matching phone or email', async () => {
    const t = await setup();
    t.shop.addOrder({ number: '2001', status: 'processing' });
    t.llm.queueAgent({
      tools: [
        { name: 'get_order', args: { order_number: '#2001' } },
        { name: 'get_order', args: { order_number: '2001', contact: 'thief@example.com' } },
        { name: 'get_order', args: { order_number: '2001', contact: '8 (701) 555-12-34' } },
      ],
      reply: { reply: 'Your order is being prepared.' },
    });
    await t.say('Where is my order 2001?');
    const calls = t.llm.agentCalls.length;
    expect(calls).toBe(1);
    const tools = t.lastReply().meta.agent_tools as { ok: boolean }[];
    expect(tools.map((x) => x.ok)).toEqual([false, false, true]);
    expect(t.agentStore.orders).toMatchObject([{ external_id: '2001', conversation_id: t.conversation().id }]);
  });

  it('sends refunds above the automatic limit to the owner, who approves them in the dashboard', async () => {
    const t = await setup({ agent: { refundAutoLimit: 20 } });
    t.shop.addOrder({ number: '2001', status: 'completed', total: '45.00', cancellable: false, final: true });
    await t.agentStore.linkOrder({ consultantId: t.consultant.id, conversationId: 'none', externalId: 'x', number: 'x', status: 'x' });
    t.llm.queueAgent(
      {
        tools: [
          { name: 'get_order', args: { order_number: '2001', contact: 'maria@example.com' } },
          { name: 'prepare_return', args: { order_number: '2001', reason: 'The flowers wilted' } },
        ],
        reply: { reply: 'I can arrange a refund of 45 USD. Shall I?' },
      },
      { tools: [{ name: 'confirm_action', args: () => ({ confirmation_code: t.agentStore.actions[0]!.confirm_code }) }], reply: { reply: 'A manager will approve it shortly.' } },
    );
    await t.say('The roses from order 2001 wilted, I want my money back');
    expect(t.agentStore.actions[0]).toMatchObject({ kind: 'refund', status: 'awaiting_customer', amount: 45 });
    await t.say('yes');
    expect(t.shop.refunds).toHaveLength(0);
    expect(t.agentStore.actions[0]!.status).toBe('awaiting_owner');
    expect(t.conversation()).toMatchObject({ needs_attention: true, attention_reason: 'A customer asks for a refund: approve it' });
    expect(t.store.events.some((e) => e.type === 'agent_owner_task')).toBe(true);
    expect(t.bot.sent.some((m) => m.chatId === 777 && m.text.includes('refund'))).toBe(true);

    const outcome = await t.agent.approve((await t.store.getConsultant(t.consultant.id))!, t.agentStore.actions[0]!.id, 'en');
    expect(t.shop.refunds).toEqual([{ orderId: '2001', amount: 45 }]);
    expect(outcome.action.status).toBe('done');
    expect(outcome.message).toContain('refund for order 2001 is done: 45 USD');
    await expect(t.agent.approve((await t.store.getConsultant(t.consultant.id))!, t.agentStore.actions[0]!.id, 'en')).rejects.toThrow(/no longer waiting/);
  });

  it('refunds small amounts right away when the owner allowed it', async () => {
    const t = await setup({ agent: { refundAutoLimit: 50 } });
    t.shop.addOrder({ number: '2001', status: 'completed', total: '45.00' });
    t.llm.queueAgent(
      {
        tools: [
          { name: 'get_order', args: { order_number: '2001', contact: 'maria@example.com' } },
          { name: 'prepare_return', args: { order_number: '2001', reason: 'Wrong colour', amount: 20 } },
        ],
        reply: { reply: 'Refund 20 USD?' },
      },
      { tools: [{ name: 'confirm_action', args: () => ({ confirmation_code: t.agentStore.actions[0]!.confirm_code }) }], reply: { reply: 'Refunded.' } },
    );
    await t.say('Wrong colour in order 2001, refund 20 please');
    await t.say('Yes');
    expect(t.shop.refunds).toEqual([{ orderId: '2001', amount: 20 }]);
    expect(t.agentStore.actions[0]!.status).toBe('done');
  });

  it('without a connected store takes the order and passes it to the team', async () => {
    const t = await setup({ shop: false });
    t.llm.queueAgent(
      {
        tools: [{ name: 'prepare_order', args: { items: [{ name: 'Bouquet "Spring"', quantity: 1 }], customer_name: 'Ivan', phone: '+77011112233' } }],
        reply: { reply: 'Confirm?' },
      },
      { tools: [{ name: 'confirm_action', args: () => ({ confirmation_code: t.agentStore.actions[0]!.confirm_code }) }], reply: { reply: 'The team will confirm it.' } },
    );
    await t.say('One bouquet Spring please, Ivan +77011112233');
    expect(t.llm.agentCalls[0]!.tools.map((x) => x.name)).toEqual(['prepare_order', 'prepare_return', 'confirm_action', 'cancel_pending_action']);
    await t.say('Yes');
    expect(t.agentStore.actions[0]!.status).toBe('awaiting_owner');
    expect(t.conversation().needs_attention).toBe(true);
  });

  it('simulates store changes in the owner test chat', async () => {
    const t = await setup();
    t.llm.queueAgent(
      { tools: [{ name: 'prepare_order', args: { items: [{ product_id: '12', name: 'Tulips', quantity: 1 }], customer_name: 'Owner', phone: '+77010000000' } }], reply: { reply: 'Confirm?' } },
      { tools: [{ name: 'confirm_action', args: () => ({ confirmation_code: t.agentStore.actions[0]!.confirm_code }) }], reply: (c) => ({ reply: JSON.stringify(c[0]!.result) }) },
    );
    await t.runtime.playground(t.consultant.id, 'Tulips for me');
    const { reply } = await t.runtime.playground(t.consultant.id, 'yes');
    expect(t.shop.created).toHaveLength(0);
    expect(t.agentStore.actions[0]!.status).toBe('simulated');
    expect(reply.text).toContain('"test_mode":true');
    expect(t.llm.agentCalls[0]!.system).toContain('test chat');
  });

  it('caches tool results within a turn so a retried turn never acts twice', async () => {
    const t = await setup();
    t.shop.addOrder({ number: '2001' });
    await t.agentStore.linkOrder({ consultantId: t.consultant.id, conversationId: 'c', externalId: 'zzz', number: 'zzz', status: 'x' });
    const turn = await t.agent.turn({
      consultant: (await t.store.getConsultant(t.consultant.id))!,
      conversation: { ...t.store.conversations[0], id: 'conv-1', channel: 'web' } as never,
      latestCustomerAt: new Date().toISOString(),
      simulate: false,
      ownerTask: async () => undefined,
    });
    const a = await turn!.execute('find_products', { query: 'roses' });
    t.shop.failNext = new Error('boom');
    const b = await turn!.execute('find_products', { query: 'roses' });
    expect(b).toBe(a);
  });

  it('tells customers in their chat when an order changes, then stops following finished orders', async () => {
    const t = await setup();
    t.llm.queueAgent({ tools: [{ name: 'get_order', args: { order_number: '2001', contact: 'maria@example.com' } }], reply: { reply: 'It is being prepared.' } });
    t.shop.addOrder({ number: '2001', status: 'processing' });
    await t.say('Где мой заказ 2001? maria@example.com');
    const notifier = new OrderNotifier({ agent: t.agent, store: t.store, runtime: t.runtime, quota: { check: async () => ({ plan: PLANS.pro, used: 0, allowed: true }), record: () => undefined }, logger: silentLogger() });

    // No change yet: nothing is sent.
    t.agentStore.orders[0]!.last_checked_at = '2000-01-01T00:00:00.000Z';
    expect(await notifier.tick()).toBe(0);

    t.shop.orders.get('2001')!.status = 'completed';
    t.shop.orders.get('2001')!.final = true;
    t.agentStore.orders[0]!.last_checked_at = '2000-01-01T00:00:00.000Z';
    expect(await notifier.tick()).toBe(1);
    expect(t.lastReply()).toMatchObject({ content: 'Обновление по вашему заказу #2001: выполнен.', meta: { kind: 'notification' } });
    expect(t.agentStore.orders[0]).toMatchObject({ closed: true, notified_status: 'completed' });
    expect(t.agentStore.actions.find((a) => a.kind === 'notify')).toMatchObject({ status: 'done' });
  });
});

describe('website chat', () => {
  it('answers website visitors, keeps one conversation per visitor and ignores disabled chats', async () => {
    const t = await setup({ plan: 'free' });
    t.llm.queue({ reply: 'Hello! We have roses.' }, { reply: 'Delivery is free over $50.' }, { reply: 'Hi second visitor' });
    await t.say('Hi, do you have roses?');
    await t.say('And delivery?');
    await t.say('Hello', 'another-visitor-hash-000000000000');
    const web = t.store.conversations.filter((c) => c.channel === 'web');
    expect(web).toHaveLength(2);
    expect(web[0]!.external_jid).toBe(`web:${VISITOR}`);
    expect(t.store.messagesOf(web[0]!.id).map((m) => [m.role, m.content])).toEqual([
      ['customer', 'Hi, do you have roses?'],
      ['assistant', 'Hello! We have roses.\n\n— Powered by GetCons'],
      ['customer', 'And delivery?'],
      ['assistant', 'Delivery is free over $50.\n\n— Powered by GetCons'],
    ]);
    expect(t.llm.generateCalls[0]!.system).toContain("the chat on the business's website");

    await t.store.updateConsultant(t.consultant.id, { web_enabled: false });
    t.runtime.invalidate(t.consultant.id);
    expect(await t.runtime.handleWeb(t.consultant.id, { visitor: VISITOR, text: 'still there?' })).toBeNull();
  });

  it('stores a retried message once', async () => {
    const t = await setup({ plan: 'free' });
    await t.runtime.handleWeb(t.consultant.id, { visitor: VISITOR, text: 'Hi', clientId: 'abc123' });
    const again = await t.runtime.handleWeb(t.consultant.id, { visitor: VISITOR, text: 'Hi', clientId: 'abc123' });
    await t.runtime.drain();
    expect(again?.message).toBeNull();
    expect(t.store.messagesOf(t.conversation().id).filter((m) => m.role === 'customer')).toHaveLength(1);
  });
});

describe('agent helpers', () => {
  it('matches the contact of an order by email or the last digits of the phone', () => {
    const order = { email: 'Maria@Example.com', phone: '+7 (701) 555-12-34' };
    expect(contactMatches(order, 'maria@example.com')).toBe(true);
    expect(contactMatches(order, '87015551234')).toBe(true);
    expect(contactMatches(order, '7015551235')).toBe(false);
    expect(contactMatches(order, 'other@example.com')).toBe(false);
    expect(contactMatches({ email: null, phone: null }, '12345')).toBe(false);
  });

  it('picks the customer language for system messages', () => {
    expect(customerLang({ customer_language: 'ru', last_message_preview: null })).toBe('ru');
    expect(customerLang({ customer_language: 'en', last_message_preview: 'Привет' })).toBe('en');
    expect(customerLang({ customer_language: null, last_message_preview: 'Где мой заказ?' })).toBe('ru');
    expect(customerLang({ customer_language: null, last_message_preview: 'Where is it?' })).toBe('en');
  });
});
