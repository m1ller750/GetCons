import { createHash, randomBytes } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { BotRequestRow, ManagerStore } from '../db/managerStore.js';
import type { ConsultantRow } from '../db/types.js';
import { safeEqual } from '../lib/crypto.js';
import { errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { BOT_TOKEN_PATTERN, TelegramError, type TelegramClient, type TelegramClientFactory } from '../services/telegram/client.js';
import type { TgMessage, TgUpdate, TgUser } from '../services/telegram/types.js';

/**
 * One-click bot creation with Telegram Managed Bots (Bot API 9.6+).
 *
 *  1. The dashboard asks for a creation link: https://t.me/newbot/<manager>/<suggested_username>?name=<name>
 *  2. The user taps "Create" in Telegram (Telegram always asks the owner to confirm).
 *  3. Telegram sends the manager bot a `managed_bot` update; we fetch the new bot's token with
 *     getManagedBotToken and connect it to the consultant exactly like a pasted token.
 *
 * Matching the new bot to the dashboard request: by the suggested username, or — if the user edited
 * it — by their Telegram account, which they prove by opening the manager bot via a /start link.
 */

export const REQUEST_TTL_MS = 30 * 60_000;
export const MANAGER_ALLOWED_UPDATES = ['message', 'managed_bot'];

export interface ManagerDeps {
  config: AppConfig;
  logger: Logger;
  store: ManagerStore;
  telegram: TelegramClientFactory;
  /** Connects a bot token to a consultant (validates, encrypts, registers the webhook). */
  connect: (consultantId: string, botToken: string) => Promise<ConsultantRow>;
  logEvent?: (consultantId: string, type: string, message: string, level?: 'info' | 'warning' | 'error') => Promise<void>;
}

export interface CreationLink {
  request: BotRequestRow;
  /** Opens Telegram's "create bot" sheet with name and username pre-filled. */
  link: string;
  /** Fallback when the user changed the username: opens the manager bot, which links by Telegram account. */
  fallbackLink: string;
}

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g', қ: 'k', ң: 'n', ү: 'u', ұ: 'u',
  ө: 'o', ә: 'a', ғ: 'g', һ: 'h',
};

/** Telegram usernames: 5-32 chars, [a-z0-9_], start with a letter, bots end with "bot". */
export function suggestBotUsername(source: string, random = randomBytes(3).toString('hex').slice(0, 4)): string {
  const latin = [...source.toLowerCase()].map((ch) => CYRILLIC[ch] ?? ch).join('');
  let slug = latin
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 20)
    .replace(/_+$/, '');
  if (!/^[a-z]/.test(slug)) slug = `ai${slug ? `_${slug}` : ''}`.slice(0, 20);
  return `${slug}_${random}_bot`;
}

export function suggestBotName(consultant: Pick<ConsultantRow, 'name' | 'business_info'>): string {
  const business = consultant.business_info?.businessName?.trim();
  return (business ? `${business} · AI` : `${consultant.name} · AI consultant`).slice(0, 64);
}

export class ManagerBot {
  private client: TelegramClient | null;
  private username: string | null = null;
  private canManage = false;
  private polling: AbortController | null = null;

  constructor(private readonly deps: ManagerDeps) {
    this.client = deps.config.telegram.managerBotToken ? deps.telegram(deps.config.telegram.managerBotToken) : null;
  }

  get enabled(): boolean {
    return Boolean(this.client && this.username && this.canManage);
  }

  get botUsername(): string | null {
    return this.username;
  }

  /** Status for the dashboard: why one-click creation is or isn't available. */
  get status(): { enabled: boolean; username: string | null; problem: string | null } {
    let problem: string | null = null;
    if (!this.client) problem = 'MANAGER_BOT_TOKEN is not configured';
    else if (!this.username) problem = 'The manager bot could not be reached';
    else if (!this.canManage) problem = `Enable "Bot Management" for @${this.username} in the @BotFather mini app`;
    return { enabled: this.enabled, username: this.username, problem };
  }

  /** Secret Telegram must send with every manager webhook call. */
  webhookSecret(): string {
    return createHash('sha256').update(this.deps.config.encryptionKey).update('getcons-manager-webhook').digest('hex');
  }

  verifyWebhookSecret(provided: string | undefined): boolean {
    return Boolean(this.client && provided && safeEqual(provided, this.webhookSecret()));
  }

  async start(): Promise<void> {
    if (!this.client) return;
    const { logger, config } = this.deps;
    try {
      const me = await this.client.getMe();
      this.username = me.username ?? null;
      this.canManage = Boolean(me.can_manage_bots);
      if (!this.canManage) logger.warn({ bot: me.username }, this.status.problem ?? 'Manager bot cannot manage bots');
      if (config.telegram.mode === 'webhook' && config.publicUrl) {
        await this.client.setWebhook(`${config.publicUrl}/telegram/manager`, this.webhookSecret(), MANAGER_ALLOWED_UPDATES);
      } else {
        await this.client.deleteWebhook(false);
        this.startPolling();
      }
      logger.info({ bot: this.username, canManage: this.canManage, mode: config.telegram.mode }, 'Manager bot ready');
    } catch (err) {
      logger.error({ err: errorMessage(err) }, 'Manager bot start failed');
    }
  }

  stop(): void {
    this.polling?.abort();
    this.polling = null;
  }

  private startPolling(): void {
    const controller = new AbortController();
    this.polling = controller;
    void (async () => {
      let offset = 0;
      let backoff = 1_000;
      while (!controller.signal.aborted) {
        try {
          const updates = await this.client!.getUpdates(offset, 25, controller.signal, MANAGER_ALLOWED_UPDATES);
          backoff = 1_000;
          for (const update of updates) {
            offset = update.update_id + 1;
            await this.handleUpdate(update).catch((err) =>
              this.deps.logger.error({ err: errorMessage(err) }, 'Manager update failed'),
            );
          }
        } catch (err) {
          if (controller.signal.aborted) break;
          this.deps.logger.warn({ err: errorMessage(err) }, 'Manager polling error');
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    })();
  }

  // ---------------------------------------------------------------------------
  // Dashboard side
  // ---------------------------------------------------------------------------

  async createLink(consultant: ConsultantRow): Promise<CreationLink> {
    if (!this.client || !this.username) throw new Error(this.status.problem ?? 'One-click creation is unavailable');
    const suggestedUsername = suggestBotUsername(consultant.business_info?.businessName || consultant.name);
    const suggestedName = suggestBotName(consultant);
    const request = await this.deps.store.createRequest({
      consultantId: consultant.id,
      nonce: randomBytes(12).toString('hex'),
      suggestedUsername,
      suggestedName,
      expiresAt: new Date(Date.now() + REQUEST_TTL_MS).toISOString(),
    });
    return { request, ...this.linksFor(request) };
  }

  linksFor(request: Pick<BotRequestRow, 'suggested_username' | 'suggested_name' | 'nonce'>): { link: string; fallbackLink: string } {
    const manager = this.username ?? '';
    return {
      link: `https://t.me/newbot/${manager}/${request.suggested_username}?name=${encodeURIComponent(request.suggested_name)}`,
      fallbackLink: `https://t.me/${manager}?start=claim_${request.nonce}`,
    };
  }

  // ---------------------------------------------------------------------------
  // Telegram side
  // ---------------------------------------------------------------------------

  async handleUpdate(update: TgUpdate): Promise<void> {
    if (update.managed_bot) await this.onManagedBot(update.managed_bot.user, update.managed_bot.bot);
    else if (update.message) await this.onMessage(update.message);
  }

  private async onManagedBot(creator: TgUser, bot: TgUser): Promise<void> {
    const { store, logger } = this.deps;
    const record = await store.upsertManagedBot({
      bot_id: bot.id,
      username: bot.username ?? null,
      name: bot.first_name,
      creator_telegram_id: creator.id,
    });

    // Already powering a consultant: this is a token or owner change. Refresh the token.
    if (record.consultant_id) {
      try {
        const token = await this.client!.getManagedBotToken(bot.id);
        await this.deps.connect(record.consultant_id, token);
        logger.info({ bot: bot.username }, 'Managed bot token refreshed');
      } catch (err) {
        logger.warn({ err: errorMessage(err), bot: bot.username }, 'Could not refresh managed bot token');
      }
      return;
    }

    const now = new Date().toISOString();
    const request =
      (bot.username ? await store.findPendingByUsername(bot.username, now) : null) ??
      (await store.findPendingByTelegramUser(creator.id, now));
    if (request) {
      await this.claim(request, bot, creator.id);
      return;
    }
    logger.info({ bot: bot.username, creator: creator.id }, 'Managed bot created without a matching request; waiting for claim');
    await this.tell(creator.id, `Your bot @${bot.username} is created. Open the GetCons dashboard and press "Link my bot" to connect it.`);
  }

  private async claim(request: BotRequestRow, bot: Pick<TgUser, 'id' | 'username'>, creatorId: number): Promise<boolean> {
    const { store, logger } = this.deps;
    try {
      const token = await this.client!.getManagedBotToken(bot.id);
      await this.deps.connect(request.consultant_id, token);
      await store.claimManagedBot(bot.id, request.consultant_id);
      await store.updateRequest(request.id, {
        status: 'completed',
        bot_id: bot.id,
        bot_username: bot.username ?? null,
        telegram_user_id: creatorId,
        error: null,
        completed_at: new Date().toISOString(),
      });
      await this.deps.logEvent?.(request.consultant_id, 'bot_created', `Telegram bot @${bot.username} created in one click`);
      const site = this.deps.config.publicUrl ? `\n\nDashboard: ${this.deps.config.publicUrl}/app/c/${request.consultant_id}` : '';
      await this.tell(creatorId, `✅ @${bot.username} is live and answering customers with AI.${site}`);
      return true;
    } catch (err) {
      const message = err instanceof TelegramError ? err.description : errorMessage(err);
      logger.error({ err: message, bot: bot.username }, 'Connecting managed bot failed');
      await store.updateRequest(request.id, { status: 'failed', error: message.slice(0, 300) });
      await this.deps.logEvent?.(request.consultant_id, 'bot_create_failed', `Could not connect @${bot.username}: ${message}`, 'error');
      return false;
    }
  }

  private async onMessage(msg: TgMessage): Promise<void> {
    if (msg.chat.type !== 'private' || !msg.from || msg.from.is_bot) return;
    if (msg.managed_bot_created) return; // the managed_bot update does the work
    const text = (msg.text ?? '').trim();
    const payload = text.match(/^\/start(?:@\w+)?\s+(claim|new)_([a-f0-9]{24})$/i);
    const ru = /^(ru|uk|be|kk)/i.test(msg.from.language_code ?? '');

    // Fallback for Telegram apps without managed bots: a token from @BotFather pasted here.
    if (BOT_TOKEN_PATTERN.test(text)) {
      await this.connectPastedToken(msg, text, ru);
      return;
    }

    if (!payload) {
      await this.tell(
        msg.chat.id,
        ru
          ? 'Привет! Я бот платформы GetCons. Создайте AI-консультанта на сайте — я помогу выпустить его в Telegram в один клик.'
          : "Hi! I'm the GetCons platform bot. Create your AI consultant on the website and I'll launch it in Telegram in one click.",
      );
      return;
    }

    const request = await this.deps.store.getRequestByNonce(payload[2]!.toLowerCase());
    if (!request || request.status !== 'pending' || request.expires_at < new Date().toISOString()) {
      await this.tell(msg.chat.id, ru ? 'Ссылка устарела. Нажмите «Создать бота» на сайте ещё раз.' : 'This link has expired. Press "Create bot" on the website again.');
      return;
    }
    // Opening this link proves which Telegram account belongs to the dashboard request.
    await this.deps.store.updateRequest(request.id, { telegram_user_id: msg.from.id });

    const unclaimed = await this.deps.store.listUnclaimedByCreator(
      msg.from.id,
      new Date(new Date(request.created_at).getTime() - 5 * 60_000).toISOString(),
    );
    if (unclaimed[0] && (await this.claim(request, { id: unclaimed[0].bot_id, username: unclaimed[0].username ?? undefined }, msg.from.id))) {
      return;
    }

    // Nothing to link yet: offer Telegram's native "create bot" button right here.
    await this.client!.sendMessage(
      msg.chat.id,
      ru
        ? 'Нажмите кнопку ниже — Telegram создаст вашего бота-консультанта.\n\nКнопки нет или ничего не происходит? Обновите Telegram до последней версии. Или создайте бота в @BotFather (команда /newbot) и пришлите мне его токен — я подключу его сам.'
        : 'Tap the button below and Telegram will create your consultant bot.\n\nNo button, or nothing happens? Update Telegram to the latest version. Or create a bot with @BotFather (/newbot) and send me its token: I will connect it for you.',
      {
        replyMarkup: {
          keyboard: [
            [
              {
                text: ru ? '🤖 Создать бота' : '🤖 Create my bot',
                request_managed_bot: {
                  request_id: Math.floor(Math.random() * 2_000_000_000),
                  suggested_name: request.suggested_name,
                  suggested_username: request.suggested_username,
                },
              },
            ],
          ],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      },
    );
  }

  /** Connects a bot token pasted into the manager chat to the request this Telegram account opened. */
  private async connectPastedToken(msg: TgMessage, token: string, ru: boolean): Promise<void> {
    const { store, logger } = this.deps;
    // The token is a secret: remove it from the chat history right away.
    await this.client?.deleteMessage(msg.chat.id, msg.message_id).catch(() => undefined);
    const request = await store.findPendingByTelegramUser(msg.from!.id, new Date().toISOString());
    if (!request) {
      await this.tell(
        msg.chat.id,
        ru
          ? 'Сначала нажмите «Создать Telegram-бота» на сайте и откройте ссылку оттуда, затем пришлите токен ещё раз.'
          : 'First press "Create Telegram bot" on the website and open the link from there, then send the token again.',
      );
      return;
    }
    try {
      const consultant = await this.deps.connect(request.consultant_id, token);
      await store.updateRequest(request.id, {
        status: 'completed',
        bot_id: consultant.telegram_bot_id,
        bot_username: consultant.telegram_bot_username,
        error: null,
        completed_at: new Date().toISOString(),
      });
      await this.deps.logEvent?.(request.consultant_id, 'bot_created', `Telegram bot @${consultant.telegram_bot_username} connected by token`);
      await this.tell(msg.chat.id, ru ? `✅ @${consultant.telegram_bot_username} подключён и отвечает клиентам.` : `✅ @${consultant.telegram_bot_username} is connected and answering customers.`);
    } catch (err) {
      logger.warn({ err: errorMessage(err) }, 'Pasted bot token rejected');
      await this.tell(
        msg.chat.id,
        ru ? 'Telegram не принял этот токен. Скопируйте его из @BotFather целиком и пришлите ещё раз.' : 'Telegram rejected this token. Copy it from @BotFather in full and send it again.',
      );
    }
  }

  private async tell(chatId: number, text: string): Promise<void> {
    // The creator may never have opened the manager bot; Telegram then refuses (403). That's fine.
    await this.client?.sendMessage(chatId, text, { replyMarkup: { remove_keyboard: true } }).catch(() => undefined);
  }
}
