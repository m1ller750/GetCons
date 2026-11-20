import type { ConsultantRow, ConversationRow, MediaRef, MessageRow, SecretsRow } from '../db/types.js';
import { decryptSecret, safeEqual } from '../lib/crypto.js';
import { AppError, errorMessage, notFound, upstream } from '../lib/errors.js';
import { DEFAULT_FALLBACK_MESSAGE, type PendingMessage } from '../services/prompt.js';
import { TelegramError, type TelegramClient, type TelegramClientFactory } from '../services/telegram/client.js';
import { escapeHtml, markdownToTelegramHtml, splitMessage, stripMarkdown } from '../services/telegram/format.js';
import type { TgMessage, TgUpdate } from '../services/telegram/types.js';
import { markdownToWhatsApp, WHATSAPP_CHUNK } from '../services/whatsapp/format.js';
import { whatsappChatKey, type IncomingWhatsApp } from '../services/whatsapp/messages.js';
import type { AgentService } from './agent/service.js';
import type { AgentTurn } from './agent/tools.js';
import type { QuotaState, ReplyQuota } from './billing.js';
import { generateReply, type EngineDeps, type GeneratedReply } from './engine.js';
import { maybeSummarize } from './memory.js';
import { POWERED_BY } from './plans.js';
import { Debouncer, KeyedQueue, RateLimiter, TtlCache } from './queue.js';

/** The linked WhatsApp work numbers, as the runtime sees them (implemented by WhatsAppManager). */
export interface WhatsAppGateway {
  isConnected(consultantId: string): boolean;
  /** Returns the WhatsApp message id. */
  sendText(consultantId: string, jid: string, text: string): Promise<string | null>;
  setTyping(consultantId: string, jid: string, typing: boolean): Promise<void>;
  markRead(consultantId: string, jid: string, messageIds: string[]): Promise<void>;
  downloadMedia(consultantId: string, media: MediaRef): Promise<Buffer>;
}

export interface RuntimeDeps extends EngineDeps {
  telegram: TelegramClientFactory;
  whatsapp?: WhatsAppGateway | null;
  /** The owner's plan: monthly AI reply quota, "Powered by GetCons", owner alerts. */
  quota?: ReplyQuota | null;
  /** Wait this long for follow-up messages before answering (customers often send several short messages). */
  debounceMs?: number;
  /** Pro plan agent: store actions (orders, returns) and order updates. */
  agent?: AgentService | null;
}

/** A message from the chat on the business's website (widget or chat link). */
export interface IncomingWeb {
  /** Hash of the visitor's random id: the conversation key (the id itself is never stored). */
  visitor: string;
  text: string;
  name?: string | null;
  /** Client-generated message id: a retried send is stored once. */
  clientId?: string | null;
}

/** Free plan replies carry the GetCons signature. */
function signReply(text: string, quota: QuotaState | null): string {
  return quota?.plan.poweredBy ? `${text}\n\n— ${POWERED_BY}` : text;
}

/** A failed delivery; `telegram` carries Telegram's error for the token/blocked handling. */
interface DeliveryError {
  description: string;
  telegram?: TelegramError;
}

/** How replies reach a customer: one implementation per messenger. */
interface ChannelIO {
  send(text: string): Promise<{ ids: string[]; error: DeliveryError | null }>;
  /** Shows "typing…" until the returned function is called. */
  typing(): () => void;
  loadMedia(media: MediaRef): Promise<Buffer>;
  /** Marks customer messages as read (blue ticks in WhatsApp). */
  seen(messageIds: string[]): void;
}

const CYRILLIC = /[Ѐ-ӿ]/;

export interface ConsultantContext {
  consultant: ConsultantRow;
  secrets: SecretsRow | null;
  client: TelegramClient | null;
}

const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
const MAX_MEDIA_PER_TURN = 3;
const OWNER_CODE = /^\/connect(?:@\w+)?\s+(GC-[A-Z0-9]{6})\s*$/i;

const SYSTEM_TEXT = {
  en: {
    reset: "Done - I've cleared our conversation context. How can I help you?",
    linked:
      "✅ Notifications are on. I'll message you here when a customer needs a human or I can't answer something reliably.",
    badCode: '❌ This code is invalid or has expired. Generate a new one in the GetCons dashboard.',
    slowDown: 'You are sending messages too quickly. Please wait a minute and try again.',
  },
  ru: {
    reset: 'Готово — я очистил контекст нашего разговора. Чем могу помочь?',
    linked:
      '✅ Уведомления включены. Я напишу вам сюда, когда клиенту понадобится человек или я не смогу надёжно ответить.',
    badCode: '❌ Код неверный или устарел. Создайте новый в панели GetCons.',
    slowDown: 'Вы отправляете сообщения слишком быстро. Подождите минуту и попробуйте снова.',
  },
};

function systemText(languageCode: string | null | undefined) {
  return /^(ru|uk|be|kk)/i.test(languageCode ?? '') ? SYSTEM_TEXT.ru : SYSTEM_TEXT.en;
}

function mediaOf(msg: TgMessage): MediaRef | null {
  if (msg.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1]!;
    return { kind: 'photo', file_id: largest.file_id, mime_type: 'image/jpeg', file_size: largest.file_size };
  }
  if (msg.voice) {
    return { kind: 'voice', file_id: msg.voice.file_id, mime_type: msg.voice.mime_type ?? 'audio/ogg', file_size: msg.voice.file_size, duration: msg.voice.duration };
  }
  if (msg.audio) {
    return { kind: 'audio', file_id: msg.audio.file_id, mime_type: msg.audio.mime_type ?? 'audio/mpeg', file_size: msg.audio.file_size, duration: msg.audio.duration };
  }
  if (msg.video_note) {
    return { kind: 'video_note', file_id: msg.video_note.file_id, mime_type: 'video/mp4', file_size: msg.video_note.file_size, duration: msg.video_note.duration };
  }
  const docMime = msg.document?.mime_type ?? '';
  if (msg.document && (docMime.startsWith('image/') || docMime === 'application/pdf')) {
    return { kind: 'document', file_id: msg.document.file_id, mime_type: docMime, file_size: msg.document.file_size };
  }
  return null;
}

function describeNonText(msg: TgMessage, media: MediaRef | null): string {
  if (media) return `[${media.kind.replace('_', ' ')}]`;
  if (msg.sticker) return `${msg.sticker.emoji ?? ''} [sticker]`.trim();
  if (msg.location) return `[location: ${msg.location.latitude}, ${msg.location.longitude}]`;
  if (msg.contact) return `[shared contact: ${msg.contact.first_name} ${msg.contact.phone_number}]`;
  if (msg.video) return '[video - not supported, ask the customer to describe it in text]';
  if (msg.document) return `[file "${msg.document.file_name ?? 'document'}" - not supported, ask for text]`;
  return '[unsupported message]';
}

/** "@maria" for Telegram, the phone number for WhatsApp. */
function customerHandle(conversation: ConversationRow): string | null {
  const handle = conversation.customer_username;
  if (!handle) return null;
  return conversation.channel === 'telegram' ? `@${handle}` : handle;
}

const CHANNEL_LABELS: Record<ConversationRow['channel'], string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  web: 'Website',
  playground: 'Test chat',
};

/** Conversation key of a website visitor (same hashing as WhatsApp chat ids). */
export function webChatKey(visitor: string): number {
  return whatsappChatKey(`web:${visitor}`);
}

export class ConsultantRuntime {
  private readonly contexts = new TtlCache<ConsultantContext>(30_000);
  private readonly chats = new KeyedQueue();
  private readonly debouncer: Debouncer;
  private readonly chatLimiter: RateLimiter;
  private readonly replyCounts = new TtlCache<{ day: string; count: number }>(60_000);
  private readonly throttles = new TtlCache<true>(10 * 60_000);
  private readonly background = new Set<Promise<unknown>>();
  /** Website chats where a reply is being written (the widget shows "typing…"). */
  private readonly webTyping = new TtlCache<true>(60_000);

  constructor(private readonly deps: RuntimeDeps) {
    this.debouncer = new Debouncer(deps.debounceMs ?? 800);
    this.chatLimiter = new RateLimiter(deps.config.limits.messagesPerChatPerMinute, 60_000);
  }

  // ---------------------------------------------------------------------------
  // Consultant context (consultant row + decrypted bot client), cached briefly.
  // ---------------------------------------------------------------------------

  invalidate(consultantId: string): void {
    this.contexts.delete(consultantId);
  }

  async getContext(consultantId: string): Promise<ConsultantContext | null> {
    const cached = this.contexts.get(consultantId);
    if (cached) return cached;
    const consultant = await this.deps.store.getConsultant(consultantId);
    if (!consultant) return null;
    const secrets = await this.deps.store.getSecrets(consultantId);
    let client: TelegramClient | null = null;
    if (secrets?.bot_token_ciphertext) {
      try {
        client = this.deps.telegram(decryptSecret(secrets.bot_token_ciphertext, this.deps.config.encryptionKey));
      } catch (err) {
        this.deps.logger.error({ consultantId, err: errorMessage(err) }, 'Could not decrypt bot token (wrong ENCRYPTION_KEY?)');
      }
    }
    const ctx = { consultant, secrets, client };
    this.contexts.set(consultantId, ctx);
    return ctx;
  }

  async verifyWebhookSecret(consultantId: string, provided: string | undefined): Promise<boolean> {
    if (!provided) return false;
    const ctx = await this.getContext(consultantId);
    const expected = ctx?.secrets?.webhook_secret;
    return Boolean(expected && ctx?.client && safeEqual(provided, expected));
  }

  /** Queue key per customer chat: replies in one chat are strictly sequential. */
  private chatKey(conversation: ConversationRow): string {
    if (conversation.channel === 'whatsapp') return `${conversation.consultant_id}:wa:${conversation.external_jid}`;
    if (conversation.channel === 'web') return `${conversation.consultant_id}:${conversation.external_jid}`;
    return `${conversation.consultant_id}:${conversation.external_chat_id}`;
  }

  /** The website widget polls this while waiting for a reply. */
  isTyping(conversationId: string): boolean {
    return Boolean(this.webTyping.get(conversationId));
  }

  /** The messenger a conversation lives in, or null when it is not connected right now. */
  private channelFor(ctx: ConsultantContext, conversation: ConversationRow): ChannelIO | null {
    const consultantId = ctx.consultant.id;
    if (conversation.channel === 'web') {
      // The website chat reads stored messages: delivering a reply is storing it.
      if (!ctx.consultant.web_enabled) return null;
      return {
        send: async () => ({ ids: [], error: null }),
        typing: () => {
          this.webTyping.set(conversation.id, true);
          return () => this.webTyping.delete(conversation.id);
        },
        loadMedia: async () => {
          throw new Error('The website chat sends text only');
        },
        seen: () => undefined,
      };
    }
    if (conversation.channel === 'whatsapp') {
      const wa = this.deps.whatsapp;
      const jid = conversation.external_jid;
      if (!wa || !jid || !wa.isConnected(consultantId)) return null;
      const quiet = (p: Promise<unknown>) => void p.catch(() => undefined);
      return {
        send: async (text) => {
          const ids: string[] = [];
          for (const part of splitMessage(markdownToWhatsApp(text), WHATSAPP_CHUNK)) {
            try {
              const id = await wa.sendText(consultantId, jid, part);
              if (id) ids.push(id);
            } catch (err) {
              return { ids, error: { description: errorMessage(err) } };
            }
          }
          return { ids, error: null };
        },
        typing: () => {
          quiet(wa.setTyping(consultantId, jid, true));
          const timer = setInterval(() => quiet(wa.setTyping(consultantId, jid, true)), 8_000);
          timer.unref?.();
          return () => {
            clearInterval(timer);
            quiet(wa.setTyping(consultantId, jid, false));
          };
        },
        loadMedia: (media) => wa.downloadMedia(consultantId, media),
        seen: (ids) => {
          if (ids.length) quiet(wa.markRead(consultantId, jid, ids));
        },
      };
    }
    if (conversation.channel !== 'telegram' || !ctx.client) return null;
    const client = ctx.client;
    const chatId = conversation.external_chat_id;
    return {
      send: async (text) => {
        const { ids, error } = await this.sendText(client, chatId, text);
        return { ids: ids.map(String), error: error ? { description: error.description, telegram: error } : null };
      },
      typing: () => this.startTyping(client, chatId),
      loadMedia: async (media) => {
        const file = await client.getFile(media.file_id);
        if (!file.file_path) throw new Error('no file path');
        return client.downloadFile(file.file_path, MAX_MEDIA_BYTES);
      },
      seen: () => undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Incoming Telegram updates
  // ---------------------------------------------------------------------------

  /** Stores the incoming message and schedules an AI reply. Resolves once the message is stored. */
  async handleUpdate(consultantId: string, update: TgUpdate): Promise<void> {
    const msg = update.message;
    if (!msg) return;
    if (msg.chat.type !== 'private' || msg.from?.is_bot) return; // consultants work in 1:1 chats only
    const ctx = await this.getContext(consultantId);
    if (!ctx?.client) return;
    const key = `${consultantId}:${msg.chat.id}`;
    await this.chats.run(key, () => this.processIncoming(ctx, update.update_id, msg, key));
  }

  private async processIncoming(ctx: ConsultantContext, updateId: number, msg: TgMessage, key: string): Promise<void> {
    const { store, logger } = this.deps;
    const { consultant } = ctx;
    const client = ctx.client!;
    const text = (msg.text ?? msg.caption ?? '').trim();
    const lang = msg.from?.language_code ?? null;
    const t = systemText(lang);

    const ownerCode = text.match(OWNER_CODE);
    if (ownerCode) {
      await this.linkOwner(ctx, msg.chat.id, ownerCode[1]!.toUpperCase(), lang);
      return;
    }

    if (!this.chatLimiter.hit(key)) {
      if (!this.throttles.get(`slow:${key}`)) {
        this.throttles.set(`slow:${key}`, true);
        await client.sendMessage(msg.chat.id, t.slowDown).catch(() => undefined);
      }
      logger.warn({ consultantId: consultant.id, chatId: msg.chat.id }, 'Chat rate limit exceeded');
      return;
    }

    const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || null;
    const conversation = await store.upsertConversation({
      consultantId: consultant.id,
      channel: 'telegram',
      externalChatId: msg.chat.id,
      customerName: name,
      customerUsername: msg.from?.username ?? null,
      customerLanguage: lang,
    });

    const command = text.match(/^\/(start|reset)(?:@\w+)?\b/i)?.[1]?.toLowerCase();
    const media = command ? null : mediaOf(msg);
    const content = command ? `/${command}` : text || describeNonText(msg, media);

    const stored = await store.insertMessage({
      conversationId: conversation.id,
      consultantId: consultant.id,
      role: 'customer',
      content,
      telegramMessageId: msg.message_id,
      telegramUpdateId: updateId,
      meta: { ...(media ? { media } : {}), ...(command ? { command } : {}) },
    });
    if (!stored) return; // duplicate delivery of the same update

    await this.touchConversation(conversation, content, 1);
    this.touchConsultantActivity(consultant.id);

    if (command === 'reset') {
      await store.updateConversation(conversation.id, { memory_reset_at: stored.created_at });
      await this.sendAndStore(ctx, { ...conversation, message_count: conversation.message_count + 1 }, t.reset, {
        status: 'ok',
        meta: { kind: 'reset' },
      });
      return;
    }

    if (consultant.status !== 'active' || !conversation.ai_enabled) return; // stored for the dashboard; a human can reply

    if (command === 'start' && consultant.greeting_message.trim()) {
      await this.sendAndStore(ctx, { ...conversation, message_count: conversation.message_count + 1 }, consultant.greeting_message, {
        status: 'ok',
        meta: { kind: 'greeting' },
      });
      return;
    }

    this.scheduleReply(consultant.id, conversation.id, key);
  }

  // ---------------------------------------------------------------------------
  // Incoming WhatsApp messages (from the linked work number)
  // ---------------------------------------------------------------------------

  /** Stores a customer's WhatsApp message and schedules an AI reply. */
  async handleWhatsApp(consultantId: string, msg: IncomingWhatsApp): Promise<void> {
    if (!this.deps.whatsapp) return;
    const ctx = await this.getContext(consultantId);
    if (!ctx) return;
    const key = `${consultantId}:wa:${msg.jid}`;
    await this.chats.run(key, () => this.processWhatsApp(ctx, msg, key));
  }

  private async processWhatsApp(ctx: ConsultantContext, msg: IncomingWhatsApp, key: string): Promise<void> {
    const { store, logger } = this.deps;
    const wa = this.deps.whatsapp!;
    const { consultant } = ctx;
    const text = msg.text.trim();
    // WhatsApp does not tell us the customer's language; system texts follow the alphabet they write in.
    const lang = CYRILLIC.test(text) ? 'ru' : null;
    const t = systemText(lang);

    const ownerCode = text.match(OWNER_CODE);
    if (ownerCode) {
      await this.linkOwnerWhatsApp(ctx, msg.jid, ownerCode[1]!.toUpperCase(), lang);
      return;
    }

    if (!this.chatLimiter.hit(key)) {
      if (!this.throttles.get(`slow:${key}`)) {
        this.throttles.set(`slow:${key}`, true);
        await wa.sendText(consultant.id, msg.jid, t.slowDown).catch(() => undefined);
      }
      logger.warn({ consultantId: consultant.id }, 'WhatsApp chat rate limit exceeded');
      return;
    }

    const conversation = await store.upsertConversation({
      consultantId: consultant.id,
      channel: 'whatsapp',
      externalChatId: whatsappChatKey(msg.jid),
      externalJid: msg.jid,
      customerName: msg.pushName,
      ...(msg.phone ? { customerUsername: msg.phone } : {}),
    });

    const command = text.match(/^\/(reset)\b/i)?.[1]?.toLowerCase();
    const media = command ? null : msg.media;
    const content = command ? `/${command}` : text || (media ? `[${media.kind.replace('_', ' ')}]` : '[unsupported message]');

    const stored = await store.insertMessage({
      conversationId: conversation.id,
      consultantId: consultant.id,
      role: 'customer',
      content,
      externalMessageId: msg.messageId,
      meta: { ...(media ? { media } : {}), ...(command ? { command } : {}) },
    });
    if (!stored) return; // the same message delivered twice

    await this.touchConversation(conversation, content, 1);
    this.touchConsultantActivity(consultant.id);

    if (command === 'reset') {
      await store.updateConversation(conversation.id, { memory_reset_at: stored.created_at });
      await this.sendAndStore(ctx, { ...conversation, message_count: conversation.message_count + 1 }, t.reset, {
        status: 'ok',
        meta: { kind: 'reset' },
      });
      return;
    }

    if (consultant.status !== 'active' || !conversation.ai_enabled) return; // stored for the dashboard; a human can reply
    this.scheduleReply(consultant.id, conversation.id, key);
  }

  // ---------------------------------------------------------------------------
  // Incoming website chat messages (widget / chat link)
  // ---------------------------------------------------------------------------

  /** Stores a visitor's message and schedules the reply. Returns the conversation and the stored message. */
  async handleWeb(consultantId: string, msg: IncomingWeb): Promise<{ conversation: ConversationRow; message: MessageRow | null } | null> {
    const ctx = await this.getContext(consultantId);
    if (!ctx?.consultant.web_enabled) return null;
    const key = `${consultantId}:web:${msg.visitor}`;
    return this.chats.run(key, () => this.processWeb(ctx, msg, key));
  }

  private async processWeb(ctx: ConsultantContext, msg: IncomingWeb, key: string) {
    const { store, logger } = this.deps;
    const { consultant } = ctx;
    const text = msg.text.trim().slice(0, 4000);
    if (!this.chatLimiter.hit(key)) {
      logger.warn({ consultantId: consultant.id }, 'Website chat rate limit exceeded');
      throw new AppError(429, 'rate_limited', 'You are sending messages too quickly. Please wait a minute.');
    }
    const conversation = await store.upsertConversation({
      consultantId: consultant.id,
      channel: 'web',
      externalChatId: webChatKey(msg.visitor),
      externalJid: `web:${msg.visitor}`,
      ...(msg.name ? { customerName: msg.name.slice(0, 80) } : {}),
    });
    const command = text.match(/^\/(reset)\b/i)?.[1]?.toLowerCase();
    const content = command ? `/${command}` : text;
    const stored = await store.insertMessage({
      conversationId: conversation.id,
      consultantId: consultant.id,
      role: 'customer',
      content,
      externalMessageId: msg.clientId ? `web:${msg.clientId}` : null,
      meta: command ? { command } : {},
    });
    if (!stored) return { conversation, message: null }; // the same message sent twice
    await this.touchConversation(conversation, content, 1);
    this.touchConsultantActivity(consultant.id);
    if (command === 'reset') {
      await store.updateConversation(conversation.id, { memory_reset_at: stored.created_at });
      await this.sendAndStore(ctx, { ...conversation, message_count: conversation.message_count + 1 }, systemText(CYRILLIC.test(text) ? 'ru' : null).reset, {
        status: 'ok',
        meta: { kind: 'reset' },
      });
      return { conversation, message: stored };
    }
    if (consultant.status === 'active' && conversation.ai_enabled) {
      this.webTyping.set(conversation.id, true);
      this.scheduleReply(consultant.id, conversation.id, key);
    }
    return { conversation, message: stored };
  }

  private scheduleReply(consultantId: string, conversationId: string, key: string): void {
    this.debouncer.schedule(key, () => {
      this.track(this.chats.run(key, () => this.respond(consultantId, conversationId)));
    });
  }

  /** Answers every customer message that arrived since the last reply, as one turn. */
  async respond(consultantId: string, conversationId: string): Promise<void> {
    const { store, logger } = this.deps;
    const ctx = await this.getContext(consultantId);
    if (!ctx || ctx.consultant.status !== 'active') return;
    const { consultant } = ctx;

    const conversation = await store.getConversation(conversationId);
    if (!conversation || conversation.consultant_id !== consultantId || !conversation.ai_enabled) return;
    const io = this.channelFor(ctx, conversation);
    if (!io) return; // the messenger is disconnected: messages stay on the dashboard

    const recent = await store.getRecentMessages(conversation.id, {
      since: conversation.memory_reset_at,
      limit: consultant.max_history_messages + 10,
    });
    let split = recent.length;
    while (split > 0 && recent[split - 1]!.role === 'customer') split--;
    const pendingRows = recent.slice(split);
    if (!pendingRows.length) return; // already answered
    const history = recent.slice(0, split);

    if (await this.overDailyLimit(consultant)) {
      await this.handleDailyLimit(ctx, conversation);
      return;
    }
    const quota = await this.quotaFor(consultant);
    if (quota && !quota.allowed) {
      await this.handleDailyLimit(ctx, conversation, quota);
      return;
    }

    io.seen(pendingRows.map((r) => r.external_message_id).filter((id): id is string => Boolean(id)));
    const stopTyping = io.typing();
    try {
      const pending = await this.loadPending(io, pendingRows);
      const agent = await this.agentTurn(ctx, conversation, quota, pendingRows, false);
      const reply = await generateReply(this.deps, { consultant, conversation, history, pending, agent });
      const saved = await this.sendAndStore(ctx, conversation, signReply(reply.text, quota), {
        status: reply.status,
        meta: reply.meta,
        attention: reply.needsAttention ? reply.attentionReason : null,
      });
      this.countReply(consultant.id);
      this.deps.quota?.record(consultant.user_id);

      const mediaSummary = reply.modelReply?.media_summary;
      const mediaRow = [...pendingRows].reverse().find((r) => r.meta?.media);
      if (mediaSummary && mediaRow) {
        await store
          .updateMessage(mediaRow.id, { content: `${mediaRow.content} ${mediaSummary}`.slice(0, 4000) })
          .catch(() => undefined);
      }

      if (saved && reply.needsAttention) await this.onNeedsAttention(ctx, conversation, reply, quota);
      this.track(maybeSummarize(this.deps, consultant, conversation));
    } catch (err) {
      logger.error({ err: errorMessage(err), consultantId, conversationId }, 'Failed to respond');
    } finally {
      stopTyping();
    }
  }

  private async loadPending(io: ChannelIO, rows: MessageRow[]): Promise<PendingMessage[]> {
    const withMedia = new Set(
      rows
        .filter((r) => r.meta?.media)
        .slice(-MAX_MEDIA_PER_TURN)
        .map((r) => r.id),
    );
    return Promise.all(
      rows.map(async (row) => {
        const text = row.meta?.command === 'start' ? 'Hello!' : row.content;
        const media = row.meta?.media;
        if (!media || !withMedia.has(row.id)) return { text };
        try {
          if ((media.file_size ?? 0) > MAX_MEDIA_BYTES) throw new Error('file too large');
          const data = await io.loadMedia(media);
          if (data.length > MAX_MEDIA_BYTES) throw new Error('file too large');
          // A bare "[photo]" placeholder is replaced by the media itself.
          const caption = /^\[[a-z ]+\]$/.test(row.content) ? '' : row.content;
          return { text: caption, media: { mimeType: media.mime_type, data: data.toString('base64'), kind: media.kind } };
        } catch (err) {
          this.deps.logger.warn({ err: errorMessage(err), kind: media.kind }, 'Could not load media; continuing with text');
          return { text: `${row.content} (the file could not be opened)` };
        }
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  private startTyping(client: TelegramClient, chatId: number): () => void {
    const ping = () => void client.sendChatAction(chatId, 'typing').catch(() => undefined);
    ping();
    const timer = setInterval(ping, 4_500);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** Sends Markdown-ish text as Telegram HTML (falls back to plain text), split into ≤4096-char parts. */
  async sendText(client: TelegramClient, chatId: number, text: string): Promise<{ ids: number[]; error: TelegramError | null }> {
    const ids: number[] = [];
    for (const part of splitMessage(text)) {
      try {
        try {
          ids.push((await client.sendMessage(chatId, markdownToTelegramHtml(part), { parseMode: 'HTML' })).message_id);
        } catch (err) {
          if (!(err instanceof TelegramError) || !err.isParseError) throw err;
          ids.push((await client.sendMessage(chatId, stripMarkdown(part))).message_id);
        }
      } catch (err) {
        return { ids, error: err instanceof TelegramError ? err : new TelegramError('sendMessage', 0, errorMessage(err)) };
      }
    }
    return { ids, error: null };
  }

  private async sendAndStore(
    ctx: ConsultantContext,
    conversation: ConversationRow,
    text: string,
    opts: { status: GeneratedReply['status']; meta: MessageRow['meta']; attention?: string | null },
  ): Promise<MessageRow | null> {
    const { store } = this.deps;
    const io = this.channelFor(ctx, conversation);
    const { ids, error } = io ? await io.send(text) : { ids: [], error: { description: 'The messenger is not connected' } };
    const saved = await store.insertMessage({
      conversationId: conversation.id,
      consultantId: ctx.consultant.id,
      role: 'assistant',
      content: text,
      status: error ? 'failed' : opts.status,
      ...this.deliveredIds(conversation, ids),
      meta: { ...opts.meta, parts: ids.length, ...(error ? { send_error: error.description } : {}) },
    });
    await store.updateConversation(conversation.id, {
      last_message_at: new Date().toISOString(),
      last_message_preview: text.slice(0, 160),
      message_count: conversation.message_count + 1,
      ...(opts.attention ? { needs_attention: true, attention_reason: opts.attention } : {}),
    });
    if (error) await this.onSendError(ctx, error);
    return error ? null : saved;
  }

  /** Where the delivered message id is stored: Telegram ids are numbers, WhatsApp ids are strings. */
  private deliveredIds(conversation: ConversationRow, ids: string[]) {
    const last = ids[ids.length - 1] ?? null;
    return conversation.channel === 'whatsapp'
      ? { externalMessageId: last }
      : { telegramMessageId: last === null ? null : Number(last) };
  }

  private async onSendError(ctx: ConsultantContext, failure: DeliveryError): Promise<void> {
    const { store, logger } = this.deps;
    const error = failure.telegram;
    if (!error) {
      logger.warn({ consultantId: ctx.consultant.id, description: failure.description }, 'WhatsApp send failed');
      await store.logEvent(ctx.consultant.id, 'send_failed', `WhatsApp did not deliver a reply: ${failure.description}`, { level: 'error' });
      return;
    }
    logger.warn({ consultantId: ctx.consultant.id, code: error.code, description: error.description }, 'Telegram send failed');
    if (error.isUnauthorized) {
      await this.markTokenInvalid(ctx.consultant.id);
    } else if (error.isBlocked) {
      await store.logEvent(ctx.consultant.id, 'customer_blocked_bot', 'A customer blocked the bot; the reply was not delivered', { level: 'warning' });
    } else {
      await store.logEvent(ctx.consultant.id, 'send_failed', `Telegram rejected a reply: ${error.description}`, { level: 'error' });
    }
  }

  async markTokenInvalid(consultantId: string): Promise<void> {
    const { store } = this.deps;
    await store.updateConsultant(consultantId, {
      status: 'error',
      last_error: 'Telegram rejected the bot token. Reconnect the bot with a valid token from @BotFather.',
    });
    await store.logEvent(consultantId, 'telegram_token_invalid', 'Telegram rejected the bot token', { level: 'error' });
    this.invalidate(consultantId);
  }

  private async touchConversation(conversation: ConversationRow, preview: string, added: number): Promise<void> {
    await this.deps.store.updateConversation(conversation.id, {
      last_message_at: new Date().toISOString(),
      last_message_preview: preview.slice(0, 160),
      message_count: conversation.message_count + added,
    });
  }

  private touchConsultantActivity(consultantId: string): void {
    const key = `activity:${consultantId}`;
    if (this.throttles.get(key)) return;
    this.throttles.set(key, true);
    void this.deps.store
      .updateConsultant(consultantId, { last_activity_at: new Date().toISOString() })
      .catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Fallback escalation, owner notifications, limits
  // ---------------------------------------------------------------------------

  private async onNeedsAttention(
    ctx: ConsultantContext,
    conversation: ConversationRow,
    reply: GeneratedReply,
    quota: QuotaState | null,
  ): Promise<void> {
    const { store } = this.deps;
    const level = reply.status === 'error' ? 'error' : 'warning';
    const type = reply.status === 'handoff' ? 'handoff_requested' : reply.status === 'error' ? 'ai_error' : 'fallback';
    const who = conversation.customer_name ?? customerHandle(conversation) ?? 'A customer';
    await store.logEvent(ctx.consultant.id, type, `${who}: ${reply.attentionReason ?? 'needs attention'}`, {
      level,
      meta: { conversation_id: conversation.id, question: reply.meta.question },
    });
    // Alerts in the owner's own chat are a Business/Pro feature; the dashboard flag works on every plan.
    if (quota && !quota.plan.ownerAlerts) return;
    await this.notifyOwner(ctx, conversation, reply.attentionReason ?? 'Needs attention', reply.meta.question ?? '');
  }

  /** Alerts the owner in their own Telegram and/or WhatsApp chat (whichever they linked). */
  async notifyOwner(ctx: ConsultantContext, conversation: ConversationRow, reason: string, question: string): Promise<void> {
    const { consultant } = ctx;
    const wa = this.deps.whatsapp;
    const tgOwner = consultant.owner_chat_id;
    const waOwner = consultant.owner_whatsapp_jid;
    // Never alert the owner inside the very chat that needs attention.
    const viaTelegram = Boolean(
      tgOwner && ctx.client && !(conversation.channel === 'telegram' && tgOwner === conversation.external_chat_id),
    );
    const viaWhatsApp = Boolean(
      waOwner && wa?.isConnected(consultant.id) && !(conversation.channel === 'whatsapp' && waOwner === conversation.external_jid),
    );
    if (!viaTelegram && !viaWhatsApp) return;
    const key = `notify:${conversation.id}`;
    if (this.throttles.get(key)) return;
    this.throttles.set(key, true);

    const who = [conversation.customer_name, customerHandle(conversation)].filter(Boolean).join(' ') || 'unknown';
    const url = this.deps.config.publicUrl
      ? `${this.deps.config.publicUrl}/app/c/${consultant.id}/conversations?open=${conversation.id}`
      : null;
    const channelName = CHANNEL_LABELS[conversation.channel];
    const warn = (err: unknown) => this.deps.logger.warn({ err: errorMessage(err) }, 'Owner notification failed');

    if (viaTelegram) {
      const html =
        `🔔 <b>A customer needs your attention</b> (${channelName})\n` +
        `Reason: ${escapeHtml(reason)}\n` +
        `Customer: ${escapeHtml(who)}\n` +
        (question ? `Message: «${escapeHtml(question.slice(0, 500))}»` : '') +
        (url ? `\n\n<a href="${escapeHtml(url)}">Open the conversation</a>` : '');
      await ctx.client!.sendMessage(tgOwner!, html, { parseMode: 'HTML' }).catch(warn);
    }
    if (viaWhatsApp) {
      const text =
        `🔔 *A customer needs your attention* (${channelName})\n` +
        `Reason: ${reason}\n` +
        `Customer: ${who}\n` +
        (question ? `Message: «${question.slice(0, 500)}»` : '') +
        (url ? `\n\nOpen the conversation: ${url}` : '');
      await wa!.sendText(consultant.id, waOwner!, text).catch(warn);
    }
  }

  /** The owner sends "/connect GC-XXXXXX" to the work number from their own WhatsApp. */
  private async linkOwnerWhatsApp(ctx: ConsultantContext, jid: string, code: string, lang: string | null): Promise<void> {
    const { store } = this.deps;
    const t = systemText(lang);
    const expected = ctx.consultant.owner_link_code;
    const ok = Boolean(expected && safeEqual(code, expected));
    if (ok) {
      await store.updateConsultant(ctx.consultant.id, { owner_whatsapp_jid: jid, owner_link_code: null });
      this.invalidate(ctx.consultant.id);
      await store.logEvent(ctx.consultant.id, 'owner_linked', 'Owner notifications connected in WhatsApp');
    }
    await this.deps.whatsapp!.sendText(ctx.consultant.id, jid, ok ? t.linked : t.badCode).catch(() => undefined);
  }

  private async linkOwner(ctx: ConsultantContext, chatId: number, code: string, lang: string | null): Promise<void> {
    const { store } = this.deps;
    const t = systemText(lang);
    const expected = ctx.consultant.owner_link_code;
    if (expected && safeEqual(code, expected)) {
      await store.updateConsultant(ctx.consultant.id, { owner_chat_id: chatId, owner_link_code: null });
      this.invalidate(ctx.consultant.id);
      await store.logEvent(ctx.consultant.id, 'owner_linked', 'Owner notifications connected in Telegram');
      await ctx.client!.sendMessage(chatId, t.linked).catch(() => undefined);
    } else {
      await ctx.client!.sendMessage(chatId, t.badCode).catch(() => undefined);
    }
  }

  private dayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private async overDailyLimit(consultant: ConsultantRow): Promise<boolean> {
    const day = this.dayKey();
    let entry = this.replyCounts.get(consultant.id);
    if (!entry || entry.day !== day) {
      const count = await this.deps.store.countAssistantRepliesSince(consultant.id, `${day}T00:00:00.000Z`);
      entry = { day, count };
      this.replyCounts.set(consultant.id, entry);
    }
    return entry.count >= this.deps.config.limits.dailyReplyLimit;
  }

  private countReply(consultantId: string): void {
    const entry = this.replyCounts.get(consultantId);
    if (entry && entry.day === this.dayKey()) entry.count++;
  }

  /** The owner's plan; a billing outage must not silence every bot, so it fails open. */
  private async quotaFor(consultant: ConsultantRow): Promise<QuotaState | null> {
    if (!this.deps.quota) return null;
    try {
      return await this.deps.quota.check(consultant.user_id);
    } catch (err) {
      this.deps.logger.warn({ err: errorMessage(err), consultantId: consultant.id }, 'Plan check failed; replying anyway');
      return null;
    }
  }

  /** Daily safety cap, or (with `quota`) the plan's monthly AI replies: customers get the fallback. */
  private async handleDailyLimit(ctx: ConsultantContext, conversation: ConversationRow, quota?: QuotaState): Promise<void> {
    const { store } = this.deps;
    const period = quota ? new Date().toISOString().slice(0, 7) : this.dayKey();
    const reason = quota
      ? `Monthly AI reply limit of the ${quota.plan.id} plan (${quota.plan.monthlyReplies}) reached`
      : 'Daily AI reply limit reached';
    if (!this.throttles.get(`limit:${ctx.consultant.id}:${period}`)) {
      this.throttles.set(`limit:${ctx.consultant.id}:${period}`, true);
      await store.logEvent(
        ctx.consultant.id,
        quota ? 'plan_limit' : 'daily_limit',
        quota
          ? `${reason}; customers get the fallback message. Choose a bigger plan on the Billing page.`
          : `Daily AI reply limit (${this.deps.config.limits.dailyReplyLimit}) reached; customers get the fallback message`,
        { level: 'warning' },
      );
    }
    if (this.throttles.get(`limit:${conversation.id}`)) return;
    this.throttles.set(`limit:${conversation.id}`, true);
    await this.sendAndStore(ctx, conversation, ctx.consultant.fallback_message.trim() || DEFAULT_FALLBACK_MESSAGE, {
      status: 'fallback',
      meta: { kind: 'limit' },
      attention: reason,
    });
  }

  // ---------------------------------------------------------------------------
  // Dashboard features
  // ---------------------------------------------------------------------------

  /** Test chat in the dashboard: same brain, no messenger. Works even before a channel is connected. */
  async playground(consultantId: string, text: string): Promise<{ reply: GeneratedReply; message: MessageRow | null }> {
    return this.chats.run(`${consultantId}:playground`, async () => {
      const { store } = this.deps;
      const consultant = await store.getConsultant(consultantId);
      if (!consultant) throw notFound('Consultant');
      // Test replies use the same AI, so they count toward the plan's monthly replies.
      const quota = await this.quotaFor(consultant);
      if (quota && !quota.allowed) {
        throw new AppError(402, 'reply_limit_reached', `This month's ${quota.plan.monthlyReplies} AI replies are used up. Choose a bigger plan.`, {
          plan: quota.plan.id,
        });
      }
      const conversation = await store.upsertConversation({
        consultantId,
        channel: 'playground',
        externalChatId: 0,
        customerName: 'Owner (test chat)',
      });
      await store.insertMessage({ conversationId: conversation.id, consultantId, role: 'customer', content: text });
      const recent = await store.getRecentMessages(conversation.id, {
        since: conversation.memory_reset_at,
        limit: consultant.max_history_messages + 10,
      });
      let split = recent.length;
      while (split > 0 && recent[split - 1]!.role === 'customer') split--;
      const ctx = (await this.getContext(consultantId)) ?? { consultant, secrets: null, client: null };
      const agent = await this.agentTurn(ctx, conversation, quota, recent.slice(split), true);
      const reply = await generateReply(this.deps, {
        consultant,
        conversation,
        history: recent.slice(0, split),
        pending: recent.slice(split).map((m) => ({ text: m.content })),
        agent,
      });
      reply.text = signReply(reply.text, quota);
      const message = await store.insertMessage({
        conversationId: conversation.id,
        consultantId,
        role: 'assistant',
        content: reply.text,
        status: reply.status,
        meta: reply.meta,
      });
      this.deps.quota?.record(consultant.user_id);
      await store.updateConversation(conversation.id, {
        last_message_at: new Date().toISOString(),
        last_message_preview: reply.text.slice(0, 160),
        message_count: conversation.message_count + 2,
      });
      this.track(maybeSummarize(this.deps, consultant, conversation));
      return { reply, message };
    });
  }

  /** A human reply from the dashboard, delivered through the consultant's bot or WhatsApp number. */
  async sendOperatorMessage(consultantId: string, conversationId: string, text: string, author: string | null): Promise<MessageRow> {
    const { store } = this.deps;
    const ctx = await this.getContext(consultantId);
    const conversation = await store.getConversation(conversationId);
    if (!ctx || !conversation || conversation.consultant_id !== consultantId) throw notFound('Conversation');
    if (conversation.channel === 'playground') throw new AppError(400, 'bad_request', 'This is the test chat, not a customer conversation');
    const whatsapp = conversation.channel === 'whatsapp';
    const io = this.channelFor(ctx, conversation);
    if (!io) {
      if (conversation.channel === 'web') throw new AppError(409, 'web_not_enabled', 'Turn the website chat on first');
      throw whatsapp
        ? new AppError(409, 'whatsapp_not_connected', 'Link the WhatsApp work number first')
        : new AppError(409, 'telegram_not_connected', 'Connect a Telegram bot first');
    }

    return this.chats.run(this.chatKey(conversation), async () => {
      const { ids, error } = await io.send(text);
      if (error) {
        await this.onSendError(ctx, error);
        throw upstream(
          error.telegram?.isBlocked
            ? 'The customer has blocked the bot'
            : `${whatsapp ? 'WhatsApp' : 'Telegram'} rejected the message: ${error.description}`,
        );
      }
      const saved = await store.insertMessage({
        conversationId,
        consultantId,
        role: 'operator',
        content: text,
        ...this.deliveredIds(conversation, ids),
        meta: { author: author ?? undefined, parts: ids.length },
      });
      const fresh = (await store.getConversation(conversationId)) ?? conversation;
      await store.updateConversation(conversationId, {
        last_message_at: new Date().toISOString(),
        last_message_preview: text.slice(0, 160),
        message_count: fresh.message_count + 1,
        needs_attention: false,
        attention_reason: null,
      });
      return saved!;
    });
  }

  // ---------------------------------------------------------------------------
  // Pro plan agent
  // ---------------------------------------------------------------------------

  /** The agent's tools for this turn, when the plan includes it and the owner turned it on. */
  private async agentTurn(
    ctx: ConsultantContext,
    conversation: ConversationRow,
    quota: QuotaState | null,
    pendingRows: MessageRow[],
    simulate: boolean,
  ): Promise<AgentTurn | null> {
    const agent = this.deps.agent;
    if (!agent || !quota?.plan.agent) return null;
    const latest = pendingRows[pendingRows.length - 1]?.created_at ?? new Date().toISOString();
    try {
      return await agent.turn({
        consultant: ctx.consultant,
        conversation,
        latestCustomerAt: latest,
        simulate,
        ownerTask: (reason, detail) => this.ownerTask(ctx, conversation, reason, detail),
      });
    } catch (err) {
      this.deps.logger.warn({ err: errorMessage(err), consultantId: ctx.consultant.id }, 'Agent unavailable; answering without tools');
      return null;
    }
  }

  /** Something only the owner can finish (approve a refund, confirm an order): flag the chat and alert them. */
  async ownerTask(ctx: ConsultantContext, conversation: ConversationRow, reason: string, detail: string): Promise<void> {
    const { store } = this.deps;
    await store.updateConversation(conversation.id, { needs_attention: true, attention_reason: reason.slice(0, 300) });
    const who = conversation.customer_name ?? customerHandle(conversation) ?? 'A customer';
    await store.logEvent(ctx.consultant.id, 'agent_owner_task', `${who}: ${reason}`, {
      level: 'warning',
      meta: { conversation_id: conversation.id },
    });
    await this.notifyOwner(ctx, conversation, reason, detail);
  }

  /** A message the business sends first (order updates, the owner's decision on a refund). */
  async notifyCustomer(consultantId: string, conversationId: string, text: string, meta: MessageRow['meta'] = {}): Promise<boolean> {
    const { store } = this.deps;
    const ctx = await this.getContext(consultantId);
    const conversation = await store.getConversation(conversationId);
    if (!ctx || !conversation || conversation.consultant_id !== consultantId || conversation.channel === 'playground') return false;
    if (!this.channelFor(ctx, conversation)) return false;
    return this.chats.run(this.chatKey(conversation), async () => {
      const fresh = (await store.getConversation(conversationId)) ?? conversation;
      const saved = await this.sendAndStore(ctx, fresh, text, { status: 'ok', meta: { kind: 'notification', ...meta } });
      return Boolean(saved);
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  private track(promise: Promise<unknown>): void {
    const p = promise.catch((err) => this.deps.logger.error({ err: errorMessage(err) }, 'Background task failed'));
    this.background.add(p);
    void p.finally(() => this.background.delete(p));
  }

  /** Flushes pending replies and waits for in-flight work (graceful shutdown, tests). */
  async drain(timeoutMs = 15_000): Promise<void> {
    this.debouncer.flush();
    const deadline = Date.now() + timeoutMs;
    while ((this.background.size || this.chats.size) && Date.now() < deadline) {
      await Promise.race([Promise.allSettled([...this.background]), new Promise((r) => setTimeout(r, 50))]);
    }
  }
}
