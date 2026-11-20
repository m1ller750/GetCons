import { randomBytes, randomUUID } from 'node:crypto';
import type { AppConfig } from '../../src/config.js';
import type { ChunkInput, InsertMessageInput, Store, UpsertConversationInput } from '../../src/db/store.js';
import type {
  ConsultantRow,
  ConversationRow,
  DocumentRow,
  ExampleMatch,
  ExampleRow,
  KnowledgeMatch,
  MessageRow,
  SecretsRow,
} from '../../src/db/types.js';
import { encryptSecret } from '../../src/lib/crypto.js';
import type {
  AgentRunRequest,
  AgentRunResult,
  EmbeddingKind,
  GenerateJsonRequest,
  GenerateRequest,
  GenerateResult,
  Llm,
} from '../../src/services/llm.js';
import type {
  AgentActionRow,
  AgentOrderRow,
  AgentStore,
  NewAgentAction,
  StoreConnectionRow,
} from '../../src/db/agentStore.js';
import type { NewOrder, Order, Product, RefundResult, StoreConnector } from '../../src/core/agent/connectors.js';
import type { ModelReply } from '../../src/services/prompt.js';
import { TelegramError, type TelegramClient } from '../../src/services/telegram/client.js';
import type { TgFile, TgMessage, TgUpdate, TgUser, TgWebhookInfo } from '../../src/services/telegram/types.js';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    env: 'test',
    port: 0,
    publicUrl: 'https://getcons.test',
    corsOrigins: [],
    logLevel: 'silent',
    supabase: { url: 'https://example.supabase.co', anonKey: 'anon-key-for-tests-000000', serviceRoleKey: 'service-key-for-tests-0000' },
    gemini: {
      apiKey: 'test',
      model: 'gemini-test',
      fallbackModel: null,
      embeddingModel: 'gemini-embedding-001',
      embeddingDimensions: 768,
      thinkingLevel: null,
      timeoutMs: 10_000,
      backend: 'auto',
    },
    grok: null,
    encryptionKey: randomBytes(32),
    telegram: { mode: 'webhook', apiBaseUrl: 'https://api.telegram.test', managerBotToken: null },
    whatsapp: { enabled: true },
    billing: { freedomPay: null },
    limits: {
      maxConsultantsPerUser: 3,
      maxUploadBytes: 1024 * 1024,
      maxDocumentsPerConsultant: 10,
      maxExamplesPerConsultant: 100,
      dailyReplyLimit: 1000,
      messagesPerChatPerMinute: 30,
    },
    rag: { topK: 6, minSimilarity: 0.3, fewShotK: 4, maxPinnedExamples: 3 },
    ...overrides,
  };
}

let tick = Date.parse('2026-10-24T10:00:00.000Z');
/** Strictly increasing timestamps so ordering in the fake store is deterministic. */
export const nextTimestamp = () => new Date((tick += 1000)).toISOString();

export function makeConsultant(overrides: Partial<ConsultantRow> = {}): ConsultantRow {
  const now = nextTimestamp();
  return {
    id: randomUUID(),
    user_id: randomUUID(),
    name: 'Anna',
    status: 'active',
    template: 'general',
    instructions: 'Always offer free delivery for orders over $50.',
    tone: 'friendly',
    language: 'auto',
    use_emojis: false,
    strictness: 'balanced',
    business_info: { businessName: 'Flower Shop', hours: 'Mon-Sat 9:00-20:00' },
    greeting_message: '',
    fallback_message: 'Let me check with the team.',
    temperature: 0.4,
    max_history_messages: 20,
    handoff_enabled: true,
    telegram_bot_id: 111,
    telegram_bot_username: 'flower_bot',
    telegram_bot_name: 'Flower Bot',
    telegram_connected_at: now,
    owner_chat_id: null,
    owner_link_code: null,
    whatsapp_status: 'disconnected',
    whatsapp_phone: null,
    whatsapp_name: null,
    whatsapp_connected_at: null,
    owner_whatsapp_jid: null,
    web_enabled: false,
    web_key: null,
    agent: {},
    last_error: null,
    last_activity_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

export class FakeStore implements Store {
  consultants = new Map<string, ConsultantRow>();
  secrets = new Map<string, SecretsRow>();
  conversations: ConversationRow[] = [];
  messages: MessageRow[] = [];
  documents = new Map<string, DocumentRow>();
  chunks = new Map<string, ChunkInput[]>();
  events: { consultantId: string; type: string; message: string; level: string }[] = [];
  knowledge = new Map<string, KnowledgeMatch[]>();
  similarExamples = new Map<string, ExampleMatch[]>();
  pinned = new Map<string, ExampleRow[]>();
  repliesToday = 0;

  addConsultant(c: ConsultantRow, token: string | null, key: Buffer, webhookSecret = 'secret-' + c.id): ConsultantRow {
    this.consultants.set(c.id, c);
    this.secrets.set(c.id, {
      consultant_id: c.id,
      bot_token_ciphertext: token ? encryptSecret(token, key) : null,
      webhook_secret: webhookSecret,
      updated_at: nextTimestamp(),
    });
    return c;
  }

  async getConsultant(id: string) {
    const c = this.consultants.get(id);
    return c ? structuredClone(c) : null;
  }
  async getSecrets(id: string) {
    return this.secrets.get(id) ?? null;
  }
  async listTelegramConsultants() {
    return [...this.consultants.values()].filter((c) => c.telegram_bot_id && ['active', 'paused'].includes(c.status));
  }
  async listWhatsAppConsultants() {
    return [...this.consultants.values()].filter((c) => c.whatsapp_status === 'connected');
  }
  async updateConsultant(id: string, patch: Partial<ConsultantRow>) {
    const c = this.consultants.get(id);
    if (c) Object.assign(c, patch);
  }

  /** consultantId -> key -> ciphertext */
  whatsappAuth = new Map<string, Map<string, string>>();
  async loadWhatsAppAuth(consultantId: string) {
    return Object.fromEntries(this.whatsappAuth.get(consultantId) ?? []);
  }
  async saveWhatsAppAuth(consultantId: string, entries: Record<string, string | null>) {
    const rows = this.whatsappAuth.get(consultantId) ?? new Map<string, string>();
    for (const [key, value] of Object.entries(entries)) {
      if (value === null) rows.delete(key);
      else rows.set(key, value);
    }
    this.whatsappAuth.set(consultantId, rows);
  }
  async clearWhatsAppAuth(consultantId: string) {
    this.whatsappAuth.delete(consultantId);
  }

  async upsertConversation(input: UpsertConversationInput) {
    let conv = this.conversations.find(
      (c) => c.consultant_id === input.consultantId && c.channel === input.channel && c.external_chat_id === input.externalChatId,
    );
    if (!conv) {
      const now = nextTimestamp();
      conv = {
        id: randomUUID(),
        consultant_id: input.consultantId,
        user_id: this.consultants.get(input.consultantId)?.user_id ?? 'unknown',
        channel: input.channel,
        external_chat_id: input.externalChatId,
        external_jid: null,
        customer_name: null,
        customer_username: null,
        customer_language: null,
        summary: null,
        summarized_until: null,
        memory_reset_at: null,
        ai_enabled: true,
        needs_attention: false,
        attention_reason: null,
        message_count: 0,
        last_message_at: null,
        last_message_preview: null,
        created_at: now,
        updated_at: now,
      };
      this.conversations.push(conv);
    }
    if (input.externalJid !== undefined) conv.external_jid = input.externalJid;
    if (input.customerName !== undefined) conv.customer_name = input.customerName;
    if (input.customerUsername !== undefined) conv.customer_username = input.customerUsername;
    if (input.customerLanguage !== undefined) conv.customer_language = input.customerLanguage;
    return structuredClone(conv);
  }
  async getConversation(id: string) {
    const c = this.conversations.find((x) => x.id === id);
    return c ? structuredClone(c) : null;
  }
  async updateConversation(id: string, patch: Partial<ConversationRow>) {
    const c = this.conversations.find((x) => x.id === id);
    if (c) Object.assign(c, patch);
  }

  async insertMessage(input: InsertMessageInput) {
    if (
      input.telegramUpdateId != null &&
      this.messages.some((m) => m.consultant_id === input.consultantId && m.telegram_update_id === input.telegramUpdateId)
    ) {
      return null;
    }
    if (
      input.externalMessageId != null &&
      this.messages.some((m) => m.consultant_id === input.consultantId && m.external_message_id === input.externalMessageId)
    ) {
      return null;
    }
    const row: MessageRow = {
      id: randomUUID(),
      conversation_id: input.conversationId,
      consultant_id: input.consultantId,
      user_id: this.consultants.get(input.consultantId)?.user_id ?? 'unknown',
      role: input.role,
      content: input.content,
      status: input.status ?? 'ok',
      telegram_message_id: input.telegramMessageId ?? null,
      telegram_update_id: input.telegramUpdateId ?? null,
      external_message_id: input.externalMessageId ?? null,
      meta: input.meta ?? {},
      created_at: nextTimestamp(),
    };
    this.messages.push(row);
    return structuredClone(row);
  }
  async updateMessage(id: string, patch: Partial<Pick<MessageRow, 'content' | 'status' | 'meta'>>) {
    const m = this.messages.find((x) => x.id === id);
    if (m) Object.assign(m, patch);
  }
  async getRecentMessages(conversationId: string, { since, limit }: { since?: string | null; limit: number }) {
    return this.messages
      .filter((m) => m.conversation_id === conversationId && (!since || m.created_at > since))
      .slice(-limit)
      .map((m) => structuredClone(m));
  }
  async countAssistantRepliesSince() {
    return this.repliesToday;
  }

  async searchKnowledge(consultantId: string) {
    return this.knowledge.get(consultantId) ?? [];
  }
  async searchExamples(consultantId: string) {
    return this.similarExamples.get(consultantId) ?? [];
  }
  async getPinnedExamples(consultantId: string) {
    return this.pinned.get(consultantId) ?? [];
  }

  async getDocument(id: string) {
    return this.documents.get(id) ?? null;
  }
  async updateDocument(id: string, patch: Partial<DocumentRow>) {
    const d = this.documents.get(id);
    if (d) Object.assign(d, patch);
  }
  async replaceChunks(documentId: string, _consultantId: string, chunks: ChunkInput[]) {
    this.chunks.set(documentId, chunks);
  }
  async listDocumentIdsByStatus(status: DocumentRow['status']) {
    return [...this.documents.values()].filter((d) => d.status === status).map((d) => d.id);
  }
  async listExamplesMissingEmbedding() {
    return [];
  }
  async setExampleEmbedding() {}

  async logEvent(consultantId: string, type: string, message: string, options: { level?: string } = {}) {
    this.events.push({ consultantId, type, message, level: options.level ?? 'info' });
  }

  messagesOf(conversationId: string) {
    return this.messages.filter((m) => m.conversation_id === conversationId);
  }
}

type ScriptedReply = Partial<ModelReply> | Error | ((req: GenerateJsonRequest) => Partial<ModelReply>);

export class FakeLlm implements Llm {
  replies: ScriptedReply[] = [];
  generateCalls: GenerateJsonRequest[] = [];
  textCalls: GenerateRequest[] = [];
  embedCalls: { texts: string[]; kind: EmbeddingKind }[] = [];
  embedError: Error | null = null;

  queue(...replies: ScriptedReply[]) {
    this.replies.push(...replies);
    return this;
  }

  async generateJson<T>(req: GenerateJsonRequest): Promise<GenerateResult<T>> {
    this.generateCalls.push(req);
    const next = this.replies.shift() ?? { reply: 'Default answer', answer_status: 'answered' };
    if (next instanceof Error) throw next;
    const value = typeof next === 'function' ? next(req) : next;
    const full: ModelReply = {
      used_knowledge_ids: [],
      answer_status: 'answered',
      reply: '',
      confidence: 0.9,
      media_summary: '',
      ...value,
    };
    return {
      data: full as T,
      text: JSON.stringify(full),
      model: 'gemini-test',
      finishReason: 'STOP',
      blocked: false,
      usage: { promptTokens: 100, outputTokens: 20, totalTokens: 120 },
    };
  }

  async generateText(req: GenerateRequest): Promise<GenerateResult<never>> {
    this.textCalls.push(req);
    return { data: null, text: '- Customer wants roses', model: 'gemini-test', finishReason: 'STOP', blocked: false, usage: {} };
  }

  async embed(texts: string[], kind: EmbeddingKind) {
    this.embedCalls.push({ texts, kind });
    if (this.embedError) throw this.embedError;
    return texts.map((t) => {
      const v = new Array(768).fill(0);
      for (let i = 0; i < t.length; i++) v[(t.charCodeAt(i) * 31 + i) % 768] += 1;
      return v;
    });
  }

  async extractDocumentText() {
    return 'Scanned price list: roses $5';
  }

  /** Scripted agent turns: the tools to call, then the reply (may depend on the tool results). */
  agentTurns: AgentScript[] = [];
  agentCalls: AgentRunRequest[] = [];

  queueAgent(...turns: AgentScript[]) {
    this.agentTurns.push(...turns);
    return this;
  }

  async runAgent(req: AgentRunRequest): Promise<AgentRunResult> {
    this.agentCalls.push(req);
    const turn = this.agentTurns.shift();
    if (!turn) {
      const res = await this.generateJson<ModelReply>(req as unknown as GenerateJsonRequest);
      return { final: res.data as unknown as Record<string, unknown>, text: '', calls: [], model: 'gemini-test', finishReason: 'STOP', blocked: false, usage: {} };
    }
    const calls: AgentRunResult['calls'] = [];
    for (const call of turn.tools ?? []) {
      const args = typeof call.args === 'function' ? call.args(calls) : call.args;
      if (!req.tools.some((t) => t.name === call.name)) {
        calls.push({ name: call.name, args, result: { ok: false, error: 'tool not offered' } });
        continue;
      }
      calls.push({ name: call.name, args, result: await req.execute(call.name, args) });
    }
    const reply = typeof turn.reply === 'function' ? turn.reply(calls) : turn.reply;
    return {
      final: { used_knowledge_ids: [], answer_status: 'answered', confidence: 0.9, media_summary: '', reply: 'Done', ...reply },
      text: '',
      calls,
      model: 'gemini-test',
      finishReason: 'STOP',
      blocked: false,
      usage: {},
    };
  }
}

export interface AgentScript {
  tools?: { name: string; args: Record<string, unknown> | ((calls: AgentRunResult['calls']) => Record<string, unknown>) }[];
  reply: Partial<ModelReply> | ((calls: AgentRunResult['calls']) => Partial<ModelReply>);
}

export class FakeAgentStore implements AgentStore {
  connections = new Map<string, StoreConnectionRow>();
  actions: AgentActionRow[] = [];
  orders: AgentOrderRow[] = [];

  constructor(private readonly ownerOf: (consultantId: string) => string = () => randomUUID()) {}

  async getConnection(consultantId: string) {
    return this.connections.get(consultantId) ?? null;
  }
  async getConnectionById(id: string) {
    return [...this.connections.values()].find((c) => c.id === id) ?? null;
  }
  async saveConnection(input: Omit<StoreConnectionRow, 'id' | 'user_id' | 'created_at' | 'updated_at'>) {
    const now = nextTimestamp();
    const existing = this.connections.get(input.consultant_id);
    const row: StoreConnectionRow = {
      id: existing?.id ?? randomUUID(),
      user_id: this.ownerOf(input.consultant_id),
      created_at: existing?.created_at ?? now,
      updated_at: now,
      ...input,
    };
    this.connections.set(input.consultant_id, row);
    return row;
  }
  async updateConnection(id: string, patch: Partial<StoreConnectionRow>) {
    for (const c of this.connections.values()) if (c.id === id) Object.assign(c, patch);
  }
  async deleteConnection(consultantId: string) {
    this.connections.delete(consultantId);
  }
  async insertAction(input: NewAgentAction) {
    const now = nextTimestamp();
    const row: AgentActionRow = {
      id: randomUUID(),
      consultant_id: input.consultantId,
      user_id: this.ownerOf(input.consultantId),
      conversation_id: input.conversationId,
      kind: input.kind,
      status: input.status,
      summary: input.summary,
      params: structuredClone(input.params),
      result: null,
      amount: input.amount ?? null,
      currency: input.currency ?? null,
      external_ref: input.externalRef ?? null,
      confirm_code: input.confirmCode ?? null,
      error: null,
      created_at: now,
      updated_at: now,
      executed_at: null,
    };
    this.actions.push(row);
    return structuredClone(row);
  }
  async getAction(id: string) {
    const a = this.actions.find((x) => x.id === id);
    return a ? structuredClone(a) : null;
  }
  async findActionByCode(conversationId: string, code: string) {
    const a = [...this.actions].reverse().find((x) => x.conversation_id === conversationId && x.confirm_code === code);
    return a ? structuredClone(a) : null;
  }
  async transitionAction(id: string, from: AgentActionRow['status'], patch: Partial<AgentActionRow>) {
    const a = this.actions.find((x) => x.id === id && x.status === from);
    if (!a) return null;
    Object.assign(a, patch, { updated_at: nextTimestamp() });
    return structuredClone(a);
  }
  async listActions(consultantId: string, limit: number) {
    return this.actions.filter((a) => a.consultant_id === consultantId).reverse().slice(0, limit);
  }
  async linkOrder(input: { consultantId: string; conversationId: string; externalId: string; number: string; status: string }) {
    if (this.orders.some((o) => o.consultant_id === input.consultantId && o.external_id === input.externalId)) return;
    const now = nextTimestamp();
    this.orders.push({
      id: randomUUID(),
      consultant_id: input.consultantId,
      user_id: this.ownerOf(input.consultantId),
      conversation_id: input.conversationId,
      external_id: input.externalId,
      number: input.number,
      status: input.status,
      notified_status: input.status,
      closed: false,
      last_checked_at: now,
      created_at: now,
      updated_at: now,
    });
  }
  async findLinkedOrder(consultantId: string, conversationId: string, externalId: string) {
    return this.orders.find((o) => o.consultant_id === consultantId && o.conversation_id === conversationId && o.external_id === externalId) ?? null;
  }
  async findOrder(consultantId: string, ref: string) {
    return this.orders.find((o) => o.consultant_id === consultantId && (o.external_id === ref || o.number === ref)) ?? null;
  }
  async listOrdersToCheck(olderThanIso: string, limit: number) {
    return this.orders.filter((o) => !o.closed && (!o.last_checked_at || o.last_checked_at < olderThanIso)).slice(0, limit);
  }
  async updateOrder(id: string, patch: Partial<AgentOrderRow>) {
    const o = this.orders.find((x) => x.id === id);
    if (o) Object.assign(o, patch);
  }
}

/** An in-memory store (shop) the agent works in. */
export class FakeShop implements StoreConnector {
  readonly platform = 'woocommerce' as const;
  products: Product[] = [
    { id: '11', variantId: null, name: 'Red roses, 11 stems', price: '45.00', currency: 'USD', inStock: true, url: 'https://shop.test/roses' },
    { id: '12', variantId: null, name: 'White tulips, 15 stems', price: '30.00', currency: 'USD', inStock: true, url: 'https://shop.test/tulips' },
  ];
  orders = new Map<string, Order>();
  created: NewOrder[] = [];
  cancelled: string[] = [];
  refunds: { orderId: string; amount: number | null }[] = [];
  failNext: Error | null = null;
  private seq = 1000;

  addOrder(partial: Partial<Order> & { number: string }): Order {
    const order: Order = {
      id: partial.number,
      status: 'processing',
      total: '45.00',
      currency: 'USD',
      items: [{ name: 'Red roses, 11 stems', quantity: 1 }],
      email: 'maria@example.com',
      phone: '+7 701 555 12 34',
      paymentUrl: null,
      trackingUrl: null,
      createdAt: nextTimestamp(),
      cancellable: true,
      final: false,
      ...partial,
    };
    this.orders.set(order.id, order);
    return order;
  }

  private check() {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
  }

  async verify() {
    return { name: 'Flower Shop', currency: 'USD' };
  }
  async findProducts(query: string) {
    this.check();
    const q = query.toLowerCase();
    return this.products.filter((p) => p.name.toLowerCase().includes(q.split(' ')[0]!));
  }
  async getOrder(ref: string) {
    this.check();
    return this.orders.get(ref.replace(/^#/, '')) ?? null;
  }
  async createOrder(order: NewOrder) {
    this.check();
    this.created.push(order);
    const total = order.items.reduce((s, i) => s + Number(this.products.find((p) => p.id === i.productId)?.price ?? 0) * i.quantity, 0);
    return this.addOrder({
      number: String(++this.seq),
      status: 'pending',
      total: total.toFixed(2),
      items: order.items.map((i) => ({ name: this.products.find((p) => p.id === i.productId)?.name ?? '?', quantity: i.quantity })),
      phone: order.customer.phone ?? null,
      email: order.customer.email ?? null,
      paymentUrl: 'https://shop.test/pay/' + this.seq,
    });
  }
  async cancelOrder(order: Order) {
    this.check();
    this.cancelled.push(order.id);
    const updated = { ...order, status: 'cancelled', cancellable: false, final: true };
    this.orders.set(order.id, updated);
    return updated;
  }
  async refund(order: Order, amount: number | null): Promise<RefundResult> {
    this.check();
    this.refunds.push({ orderId: order.id, amount });
    return { id: 'r1', amount: (amount ?? Number(order.total)).toFixed(2), status: 'refunded' };
  }
}

export class FakeBot implements TelegramClient {
  sent: { chatId: number; text: string; parseMode?: string }[] = [];
  actions: number[] = [];
  webhook: { url: string; secret: string } | null = null;
  sendError: TelegramError | null = null;
  files = new Map<string, Buffer>();
  private nextId = 1000;

  constructor(
    readonly token: string,
    readonly me: TgUser = { id: Number(token.split(':')[0]), is_bot: true, first_name: 'Test Bot', username: 'test_bot' },
  ) {}

  async getMe() {
    if (this.token.includes('INVALID')) throw new TelegramError('getMe', 401, 'Unauthorized');
    return this.me;
  }
  async setWebhook(url: string, secret: string) {
    this.webhook = { url, secret };
    return true;
  }
  async deleteWebhook() {
    this.webhook = null;
    return true;
  }
  async getWebhookInfo(): Promise<TgWebhookInfo> {
    return { url: this.webhook?.url ?? '', has_custom_certificate: false, pending_update_count: 0 };
  }
  async getUpdates(): Promise<TgUpdate[]> {
    return [];
  }
  /** Managed bots this (manager) bot may hand out tokens for: bot user id -> token. */
  managedTokens = new Map<number, string>();
  async getManagedBotToken(botUserId: number) {
    const token = this.managedTokens.get(botUserId);
    if (!token) throw new TelegramError('getManagedBotToken', 400, 'Bad Request: bot not managed');
    return token;
  }
  markups: (Record<string, unknown> | undefined)[] = [];
  async sendMessage(chatId: number, text: string, options: { parseMode?: 'HTML'; replyMarkup?: Record<string, unknown> } = {}): Promise<TgMessage> {
    if (this.sendError) throw this.sendError;
    this.markups.push(options.replyMarkup);
    this.sent.push({ chatId, text, parseMode: options.parseMode });
    return { message_id: this.nextId++, date: 0, chat: { id: chatId, type: 'private' } };
  }
  deleted: { chatId: number; messageId: number }[] = [];
  async deleteMessage(chatId: number, messageId: number) {
    this.deleted.push({ chatId, messageId });
  }
  async sendChatAction(chatId: number) {
    this.actions.push(chatId);
  }
  async getFile(fileId: string): Promise<TgFile> {
    return { file_id: fileId, file_unique_id: fileId, file_path: `photos/${fileId}.jpg`, file_size: 10 };
  }
  async downloadFile(filePath: string) {
    return this.files.get(filePath) ?? Buffer.from('fake-image-bytes');
  }
  async setMyCommands() {}
  async setMyDescription() {}
  async setMyShortDescription() {}
}

export class FakeTelegram {
  bots = new Map<string, FakeBot>();
  factory = (token: string): TelegramClient => {
    let bot = this.bots.get(token);
    if (!bot) {
      bot = new FakeBot(token);
      this.bots.set(token, bot);
    }
    return bot;
  };
  bot(token: string): FakeBot {
    return this.factory(token) as FakeBot;
  }
}

let updateId = 5000;
export function textUpdate(
  chatId: number,
  text: string,
  from: Partial<TgUser> = {},
  extra: Partial<TgMessage> = {},
): TgUpdate {
  updateId++;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, is_bot: false, first_name: 'Maria', username: 'maria', language_code: 'en', ...from },
      text,
      ...extra,
    },
  };
}
