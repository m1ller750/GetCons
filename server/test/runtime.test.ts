import { beforeEach, describe, expect, it } from 'vitest';
import { processDocument } from '../src/core/knowledge.js';
import { maybeSummarize } from '../src/core/memory.js';
import { ConsultantRuntime } from '../src/core/runtime.js';
import { silentLogger } from '../src/lib/logger.js';
import { LlmError } from '../src/services/llm.js';
import { TelegramError } from '../src/services/telegram/client.js';
import { FakeLlm, FakeStore, FakeTelegram, makeConsultant, nextTimestamp, testConfig, textUpdate } from './helpers/fakes.js';

const TOKEN = '111:AAEtesttokentesttokentesttokentest';

function setup(overrides: Parameters<typeof makeConsultant>[0] = {}) {
  const config = testConfig();
  const store = new FakeStore();
  const llm = new FakeLlm();
  const telegram = new FakeTelegram();
  const consultant = store.addConsultant(makeConsultant(overrides), TOKEN, config.encryptionKey);
  const runtime = new ConsultantRuntime({ store, llm, config, logger: silentLogger(), telegram: telegram.factory, debounceMs: 0 });
  const bot = telegram.bot(TOKEN);
  const send = async (chatId: number, text: string, from = {}, extra = {}) => {
    await runtime.handleUpdate(consultant.id, textUpdate(chatId, text, from, extra));
    await runtime.drain();
  };
  return { config, store, llm, telegram, consultant, runtime, bot, send };
}

describe('consultant runtime (Telegram -> Gemini -> Telegram)', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('answers a customer with Gemini using knowledge, examples and instructions, and stores both sides', async () => {
    t.store.knowledge.set(t.consultant.id, [
      { id: 'chunk-1', document_id: 'doc-1', document_title: 'Prices', content: 'Red roses: $5 each.', similarity: 0.82, keyword_rank: 0.1, score: 0.03 },
      { id: 'chunk-2', document_id: 'doc-1', document_title: 'Prices', content: 'Unrelated text', similarity: 0.1, keyword_rank: 0, score: 0.01 },
    ]);
    t.store.similarExamples.set(t.consultant.id, [
      { id: 'ex-1', customer_message: 'How much are roses?', ideal_reply: 'Our roses are $5 💐', notes: null, is_pinned: false, similarity: 0.9 },
    ]);
    t.llm.queue({ reply: '**Red roses** are $5 each.', answer_status: 'answered', used_knowledge_ids: ['K1'], confidence: 0.95 });

    await t.send(42, 'How much are red roses?');

    // Gemini got the consultant-specific prompt
    const call = t.llm.generateCalls[0]!;
    expect(call.system).toContain('Always offer free delivery for orders over $50.');
    expect(call.system).toContain('Red roses: $5 each.');
    expect(call.system).not.toContain('Unrelated text'); // below similarity threshold
    expect(call.system).toContain('Ideal reply: Our roses are $5 💐');
    expect(call.messages.at(-1)!.parts).toEqual([{ text: 'How much are red roses?' }]);
    expect(t.llm.embedCalls[0]).toMatchObject({ kind: 'query' });

    // Reply delivered as Telegram HTML
    expect(t.bot.sent).toEqual([{ chatId: 42, text: '<b>Red roses</b> are $5 each.', parseMode: 'HTML' }]);
    expect(t.bot.actions).toContain(42); // typing indicator

    // Stored for the dashboard with provenance
    const conv = t.store.conversations[0]!;
    const msgs = t.store.messagesOf(conv.id);
    expect(msgs.map((m) => m.role)).toEqual(['customer', 'assistant']);
    expect(msgs[1]!.status).toBe('ok');
    expect(msgs[1]!.meta.knowledge).toEqual([{ id: 'chunk-1', document_id: 'doc-1', title: 'Prices', similarity: 0.82, cited: true }]);
    expect(msgs[1]!.meta.examples).toEqual(['ex-1']);
    expect(msgs[1]!.meta.latency_ms).toBeTypeOf('number');
    expect(conv.customer_name).toBe('Maria');
    expect(conv.message_count).toBe(2);
    expect(conv.needs_attention).toBe(false);
  });

  it('remembers the conversation: earlier turns are sent as history', async () => {
    t.llm.queue({ reply: 'Yes, we have peonies.' }, { reply: 'They are $8.' });
    await t.send(7, 'Do you have peonies?');
    await t.send(7, 'How much?');
    const second = t.llm.generateCalls[1]!;
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'model', 'user']);
    expect(second.messages[0]!.parts).toEqual([{ text: 'Do you have peonies?' }]);
    expect(second.messages[1]!.parts).toEqual([{ text: 'Yes, we have peonies.' }]);
    // short follow-up: retrieval query includes the previous question
    expect(t.llm.embedCalls[1]!.texts[0]).toBe('Do you have peonies?\nHow much?');
  });

  it('/reset clears the conversation context', async () => {
    t.llm.queue({ reply: 'First answer' }, { reply: 'Fresh answer' });
    await t.send(9, 'Remember: my name is Bob');
    await t.send(9, '/reset');
    expect(t.bot.sent.at(-1)!.text).toMatch(/cleared our conversation context/);
    await t.send(9, 'What is my name?');
    const call = t.llm.generateCalls.at(-1)!;
    const allText = JSON.stringify(call.messages);
    expect(allText).not.toContain('my name is Bob');
  });

  it('replies to /start with the greeting and to Russian users in Russian for system messages', async () => {
    t.store.consultants.get(t.consultant.id)!.greeting_message = 'Hello! I am Anna from Bloom.';
    t.runtime.invalidate(t.consultant.id);
    await t.send(10, '/start');
    expect(t.bot.sent.at(-1)!.text).toBe('Hello! I am Anna from Bloom.');
    expect(t.llm.generateCalls).toHaveLength(0);
    await t.send(10, '/reset', { language_code: 'ru' });
    expect(t.bot.sent.at(-1)!.text).toMatch(/очистил контекст/);
  });

  it('falls back and escalates when the AI lacks reliable information', async () => {
    const owner = 999;
    Object.assign(t.store.consultants.get(t.consultant.id)!, { owner_chat_id: owner });
    t.runtime.invalidate(t.consultant.id);
    t.llm.queue({ reply: "I'll check with the team.", answer_status: 'unknown', confidence: 0.2 });

    await t.send(11, 'Can you ship to Mars?');

    const conv = t.store.conversations[0]!;
    const reply = t.store.messagesOf(conv.id).at(-1)!;
    expect(reply.status).toBe('fallback');
    expect(conv.needs_attention).toBe(true);
    expect(conv.attention_reason).toMatch(/Missing information/);
    expect(t.store.events.some((e) => e.type === 'fallback')).toBe(true);
    // the owner was notified in their own chat with a link to the dashboard
    const note = t.bot.sent.find((s) => s.chatId === owner)!;
    expect(note.text).toContain('needs your attention');
    expect(note.text).toContain('Can you ship to Mars?');
    expect(note.text).toContain(`https://getcons.test/app/c/${t.consultant.id}/conversations?open=${conv.id}`);
  });

  it('sends the owner fallback message when Gemini is down', async () => {
    t.llm.queue(new LlmError('Gemini API error 503', 503, true));
    await t.send(12, 'Hello?');
    expect(t.bot.sent.at(-1)!.text).toBe('Let me check with the team.');
    const reply = t.store.messages.at(-1)!;
    expect(reply.status).toBe('error');
    expect(reply.meta.error).toContain('503');
    expect(t.store.conversations[0]!.needs_attention).toBe(true);
  });

  it('keeps answering with keyword search when embeddings fail', async () => {
    t.llm.embedError = new Error('embedding quota');
    t.llm.queue({ reply: 'Answer without vectors' });
    await t.send(13, 'Opening hours?');
    expect(t.bot.sent.at(-1)!.text).toBe('Answer without vectors');
    expect(t.store.messages.at(-1)!.meta.retrieval_error).toContain('embedding quota');
  });

  it('ignores duplicate Telegram deliveries (idempotent webhooks)', async () => {
    const update = textUpdate(14, 'Hi');
    await t.runtime.handleUpdate(t.consultant.id, update);
    await t.runtime.handleUpdate(t.consultant.id, update);
    await t.runtime.drain();
    expect(t.store.messages.filter((m) => m.role === 'customer')).toHaveLength(1);
    expect(t.llm.generateCalls).toHaveLength(1);
  });

  it('collects messages without replying when AI is paused for the chat or the consultant', async () => {
    await t.send(15, 'first');
    t.store.conversations[0]!.ai_enabled = false;
    await t.send(15, 'second (human takeover)');
    expect(t.llm.generateCalls).toHaveLength(1);
    expect(t.store.messages.filter((m) => m.role === 'customer')).toHaveLength(2);

    t.store.consultants.get(t.consultant.id)!.status = 'paused';
    t.runtime.invalidate(t.consultant.id);
    await t.send(16, 'paused consultant');
    expect(t.llm.generateCalls).toHaveLength(1);
    expect(t.store.messages.some((m) => m.content === 'paused consultant')).toBe(true);
  });

  it('ignores group chats and other bots', async () => {
    await t.runtime.handleUpdate(t.consultant.id, textUpdate(-100, 'group msg', {}, { chat: { id: -100, type: 'group' } }));
    await t.runtime.handleUpdate(t.consultant.id, textUpdate(17, 'bot msg', { is_bot: true }));
    await t.runtime.drain();
    expect(t.store.messages).toHaveLength(0);
  });

  it('answers several quick messages in one turn', async () => {
    const r = setup();
    const slow = new ConsultantRuntime({
      store: r.store,
      llm: r.llm,
      config: r.config,
      logger: silentLogger(),
      telegram: r.telegram.factory,
      debounceMs: 30,
    });
    await slow.handleUpdate(r.consultant.id, textUpdate(18, 'Hi'));
    await slow.handleUpdate(r.consultant.id, textUpdate(18, 'I need flowers'));
    await slow.handleUpdate(r.consultant.id, textUpdate(18, 'for tomorrow'));
    await new Promise((res) => setTimeout(res, 80));
    await slow.drain();
    expect(r.llm.generateCalls).toHaveLength(1);
    expect(r.llm.generateCalls[0]!.messages.at(-1)!.parts.map((p) => ('text' in p ? p.text : ''))).toEqual([
      'Hi',
      'I need flowers',
      'for tomorrow',
    ]);
  });

  it('sends photos to Gemini and stores the media description for future memory', async () => {
    t.llm.queue({ reply: 'Lovely tulips! We have them.', media_summary: '(photo of yellow tulips)' });
    await t.send(19, '', {}, { text: undefined, caption: 'Do you have these?', photo: [{ file_id: 'p1', file_unique_id: 'p1', width: 10, height: 10 }] });
    const parts = t.llm.generateCalls[0]!.messages.at(-1)!.parts;
    expect(parts[0]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: Buffer.from('fake-image-bytes').toString('base64') } });
    expect(parts[1]).toEqual({ text: 'Do you have these?' });
    const customer = t.store.messages.find((m) => m.role === 'customer')!;
    expect(customer.content).toBe('Do you have these? (photo of yellow tulips)');
  });

  it('links the owner for notifications with a one-time code', async () => {
    Object.assign(t.store.consultants.get(t.consultant.id)!, { owner_link_code: 'GC-ABC234' });
    t.runtime.invalidate(t.consultant.id);
    await t.send(500, '/connect GC-WRONG1');
    expect(t.bot.sent.at(-1)!.text).toMatch(/invalid/);
    await t.send(500, '/connect gc-abc234');
    expect(t.store.consultants.get(t.consultant.id)!.owner_chat_id).toBe(500);
    expect(t.store.consultants.get(t.consultant.id)!.owner_link_code).toBeNull();
    expect(t.store.messages).toHaveLength(0); // linking is not a customer conversation
  });

  it('marks the consultant as broken when Telegram rejects the token', async () => {
    t.bot.sendError = new TelegramError('sendMessage', 401, 'Unauthorized');
    await t.send(20, 'hello');
    expect(t.store.consultants.get(t.consultant.id)!.status).toBe('error');
    expect(t.store.messages.at(-1)!.status).toBe('failed');
  });

  it('enforces the daily reply limit with the fallback message', async () => {
    t.store.repliesToday = t.config.limits.dailyReplyLimit;
    await t.send(21, 'hi');
    expect(t.llm.generateCalls).toHaveLength(0);
    expect(t.bot.sent.at(-1)!.text).toBe('Let me check with the team.');
    expect(t.store.events.some((e) => e.type === 'daily_limit')).toBe(true);
  });

  it('verifies webhook secrets', async () => {
    expect(await t.runtime.verifyWebhookSecret(t.consultant.id, `secret-${t.consultant.id}`)).toBe(true);
    expect(await t.runtime.verifyWebhookSecret(t.consultant.id, 'nope')).toBe(false);
    expect(await t.runtime.verifyWebhookSecret(t.consultant.id, undefined)).toBe(false);
    expect(await t.runtime.verifyWebhookSecret('00000000-0000-0000-0000-000000000000', 'x')).toBe(false);
  });
});

describe('playground and operator replies', () => {
  it('runs the same brain in the dashboard test chat (even without Telegram)', async () => {
    const t = setup({ status: 'draft', telegram_bot_id: null });
    t.llm.queue({ reply: 'Test reply', answer_status: 'partial', confidence: 0.6 });
    const { reply, message } = await t.runtime.playground(t.consultant.id, 'test question');
    expect(reply.text).toBe('Test reply');
    expect(reply.needsAttention).toBe(true);
    expect(message?.role).toBe('assistant');
    expect(t.store.conversations[0]!.channel).toBe('playground');
    expect(t.bot.sent).toHaveLength(0);
    expect(t.llm.generateCalls[0]!.system).toContain('the business owner is testing you');
  });

  it('delivers a human reply through the bot and clears the attention flag', async () => {
    const t = setup();
    t.llm.queue({ reply: 'unsure', answer_status: 'unknown' });
    await t.send(30, 'complex question');
    const conv = t.store.conversations[0]!;
    expect(conv.needs_attention).toBe(true);
    const saved = await t.runtime.sendOperatorMessage(t.consultant.id, conv.id, 'Hi, this is Kate from the team!', 'kate@shop.com');
    expect(saved.role).toBe('operator');
    expect(t.bot.sent.at(-1)).toMatchObject({ chatId: 30, text: 'Hi, this is Kate from the team!' });
    expect(t.store.conversations[0]!.needs_attention).toBe(false);
    await expect(t.runtime.sendOperatorMessage(t.consultant.id, 'missing', 'x', null)).rejects.toThrow(/not found/);
  });
});

describe('knowledge indexing and long-term memory', () => {
  it('chunks and embeds documents as RETRIEVAL_DOCUMENT, then marks them ready', async () => {
    const t = setup();
    t.store.documents.set('doc-1', {
      id: 'doc-1',
      consultant_id: t.consultant.id,
      user_id: t.consultant.user_id,
      title: 'Delivery',
      source_type: 'text',
      file_name: null,
      mime_type: 'text/plain',
      size_bytes: 10,
      content: 'We deliver every day.\n\n'.repeat(200),
      status: 'processing',
      error: null,
      chunk_count: 0,
      created_at: nextTimestamp(),
      updated_at: nextTimestamp(),
    });
    await processDocument({ store: t.store, llm: t.llm, config: t.config, logger: silentLogger() }, 'doc-1');
    const doc = t.store.documents.get('doc-1')!;
    expect(doc.status).toBe('ready');
    expect(doc.chunk_count).toBeGreaterThan(1);
    expect(t.store.chunks.get('doc-1')!.every((c) => c.embedding?.length === 768)).toBe(true);
    expect(t.llm.embedCalls[0]!.kind).toBe('document');
  });

  it('records indexing failures on the document', async () => {
    const t = setup();
    t.llm.embedError = new Error('quota exceeded');
    t.store.documents.set('doc-2', {
      ...structuredClone({
        id: 'doc-2',
        consultant_id: t.consultant.id,
        user_id: t.consultant.user_id,
        title: 'Broken',
        source_type: 'text' as const,
        file_name: null,
        mime_type: null,
        size_bytes: null,
        content: 'text',
        status: 'processing' as const,
        error: null,
        chunk_count: 0,
        created_at: nextTimestamp(),
        updated_at: nextTimestamp(),
      }),
    });
    await processDocument({ store: t.store, llm: t.llm, config: t.config, logger: silentLogger() }, 'doc-2');
    expect(t.store.documents.get('doc-2')).toMatchObject({ status: 'error', error: 'quota exceeded' });
    expect(t.store.events.at(-1)).toMatchObject({ type: 'knowledge_failed', level: 'error' });
  });

  it('folds old messages into a rolling summary', async () => {
    const t = setup({ max_history_messages: 4 });
    const conv = await t.store.upsertConversation({ consultantId: t.consultant.id, channel: 'telegram', externalChatId: 1 });
    for (let i = 0; i < 16; i++) {
      await t.store.insertMessage({ conversationId: conv.id, consultantId: t.consultant.id, role: i % 2 ? 'assistant' : 'customer', content: `m${i}` });
    }
    const deps = { store: t.store, llm: t.llm, config: t.config, logger: silentLogger() };
    expect(await maybeSummarize(deps, { max_history_messages: 4 }, (await t.store.getConversation(conv.id))!)).toBe(true);
    const updated = (await t.store.getConversation(conv.id))!;
    expect(updated.summary).toBe('- Customer wants roses');
    expect(t.llm.textCalls[0]!.messages[0]!.parts[0]).toMatchObject({ text: expect.stringContaining('Customer: m0') });
    expect(updated.summarized_until).toBe(t.store.messages[11]!.created_at);
    // nothing new to fold
    expect(await maybeSummarize(deps, { max_history_messages: 4 }, updated)).toBe(false);
  });
});
