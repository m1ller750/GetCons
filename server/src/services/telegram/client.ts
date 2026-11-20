import type { TgBotCommand, TgFile, TgMessage, TgUpdate, TgUser, TgWebhookInfo } from './types.js';

export class TelegramError extends Error {
  readonly method: string;
  readonly code: number;
  readonly description: string;
  readonly retryAfter: number | null;

  constructor(method: string, code: number, description: string, retryAfter: number | null = null) {
    super(`Telegram ${method} failed (${code}): ${description}`);
    this.name = 'TelegramError';
    this.method = method;
    this.code = code;
    this.description = description;
    this.retryAfter = retryAfter;
  }

  /** The bot token was revoked or is wrong. */
  get isUnauthorized() {
    return this.code === 401 || this.code === 404;
  }

  /** The user blocked the bot or deleted the chat. */
  get isBlocked() {
    return this.code === 403;
  }

  get isParseError() {
    return this.code === 400 && /parse entities|can't find end|unsupported start tag/i.test(this.description);
  }
}

export interface SendMessageOptions {
  parseMode?: 'HTML';
  disablePreview?: boolean;
  /** Raw Telegram reply_markup (inline keyboard, reply keyboard, remove_keyboard). */
  replyMarkup?: Record<string, unknown>;
}

export interface TelegramClient {
  getMe(): Promise<TgUser>;
  setWebhook(url: string, secretToken: string, allowedUpdates?: string[]): Promise<boolean>;
  deleteWebhook(dropPendingUpdates?: boolean): Promise<boolean>;
  getWebhookInfo(): Promise<TgWebhookInfo>;
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal, allowedUpdates?: string[]): Promise<TgUpdate[]>;
  /** Manager bots only (Bot API 9.6): token of a bot created under this manager. */
  getManagedBotToken(botUserId: number): Promise<string>;
  sendMessage(chatId: number, text: string, options?: SendMessageOptions): Promise<TgMessage>;
  /** Bots may delete incoming messages in private chats (e.g. a pasted token). */
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  sendChatAction(chatId: number, action?: 'typing'): Promise<void>;
  getFile(fileId: string): Promise<TgFile>;
  downloadFile(filePath: string, maxBytes: number): Promise<Buffer>;
  setMyCommands(commands: TgBotCommand[]): Promise<void>;
  setMyDescription(description: string): Promise<void>;
  setMyShortDescription(shortDescription: string): Promise<void>;
}

export type TelegramClientFactory = (token: string) => TelegramClient;

export const BOT_TOKEN_PATTERN = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export function createTelegramClient(
  token: string,
  options: { baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): TelegramClient {
  const baseUrl = options.baseUrl ?? 'https://api.telegram.org';
  const doFetch = options.fetchImpl ?? fetch;
  const defaultTimeout = options.timeoutMs ?? 20_000;

  async function call<T>(method: string, params: Record<string, unknown> = {}, opts: { signal?: AbortSignal; timeoutMs?: number; retries?: number } = {}): Promise<T> {
    const retries = opts.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      const signal = opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? defaultTimeout)])
        : AbortSignal.timeout(opts.timeoutMs ?? defaultTimeout);
      let res: Response;
      try {
        // The token is part of the URL: never include the URL in errors or logs.
        res = await doFetch(`${baseUrl}/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          signal,
        });
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        throw new TelegramError(method, 0, `Network error: ${(err as Error).name}`);
      }
      let body: ApiResponse<T>;
      try {
        body = (await res.json()) as ApiResponse<T>;
      } catch {
        throw new TelegramError(method, res.status, 'Invalid response from Telegram');
      }
      if (body.ok) return body.result as T;
      const code = body.error_code ?? res.status;
      const retryAfter = body.parameters?.retry_after ?? null;
      if (code === 429 && retryAfter !== null && retryAfter <= 10 && attempt < retries) {
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      if (code >= 500 && attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw new TelegramError(method, code, body.description ?? 'Unknown error', retryAfter);
    }
  }

  return {
    getMe: () => call<TgUser>('getMe', {}, { retries: 1 }),
    setWebhook: (url, secretToken, allowedUpdates = ['message']) =>
      call<boolean>('setWebhook', {
        url,
        secret_token: secretToken,
        allowed_updates: allowedUpdates,
        max_connections: 40,
      }),
    deleteWebhook: (dropPendingUpdates = false) =>
      call<boolean>('deleteWebhook', { drop_pending_updates: dropPendingUpdates }),
    getWebhookInfo: () => call<TgWebhookInfo>('getWebhookInfo'),
    getUpdates: (offset, timeoutSec, signal, allowedUpdates = ['message']) =>
      call<TgUpdate[]>(
        'getUpdates',
        { offset, timeout: timeoutSec, allowed_updates: allowedUpdates },
        { signal, timeoutMs: (timeoutSec + 10) * 1000, retries: 0 },
      ),
    getManagedBotToken: (botUserId) => call<string>('getManagedBotToken', { user_id: botUserId }),
    sendMessage: (chatId, text, opts = {}) =>
      call<TgMessage>('sendMessage', {
        chat_id: chatId,
        text,
        ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
        ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
        link_preview_options: { is_disabled: opts.disablePreview ?? true },
      }),
    deleteMessage: async (chatId, messageId) => {
      await call<boolean>('deleteMessage', { chat_id: chatId, message_id: messageId }, { retries: 0 });
    },
    sendChatAction: async (chatId, action = 'typing') => {
      await call<boolean>('sendChatAction', { chat_id: chatId, action }, { retries: 0, timeoutMs: 5_000 });
    },
    getFile: (fileId) => call<TgFile>('getFile', { file_id: fileId }),
    downloadFile: async (filePath, maxBytes) => {
      const res = await doFetch(`${baseUrl}/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new TelegramError('downloadFile', res.status, 'File download failed');
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > maxBytes) throw new TelegramError('downloadFile', 413, 'File is too large');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new TelegramError('downloadFile', 413, 'File is too large');
      return buf;
    },
    setMyCommands: async (commands) => {
      await call<boolean>('setMyCommands', { commands });
    },
    setMyDescription: async (description) => {
      await call<boolean>('setMyDescription', { description: description.slice(0, 512) });
    },
    setMyShortDescription: async (shortDescription) => {
      await call<boolean>('setMyShortDescription', { short_description: shortDescription.slice(0, 120) });
    },
  };
}
