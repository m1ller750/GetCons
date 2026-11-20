import type { AppConfig } from '../config.js';
import type { Store } from '../db/store.js';
import { errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { TelegramError, type TelegramClient } from '../services/telegram/client.js';
import type { ConsultantRuntime } from './runtime.js';

/**
 * How updates reach us from Telegram.
 *  - webhook (production on Railway): Telegram POSTs to /telegram/webhook/:consultantId
 *  - polling (local development without a public URL): we long-poll getUpdates per bot
 */
export interface TelegramTransport {
  readonly mode: 'webhook' | 'polling';
  attach(consultantId: string, client: TelegramClient, webhookSecret: string): Promise<void>;
  detach(consultantId: string, client: TelegramClient): Promise<void>;
  /** Re-attaches every connected bot on boot. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

export const ALLOWED_UPDATES = ['message'];

export function webhookUrl(publicUrl: string, consultantId: string): string {
  return `${publicUrl}/telegram/webhook/${consultantId}`;
}

export class WebhookTransport implements TelegramTransport {
  readonly mode = 'webhook' as const;

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly runtime: ConsultantRuntime,
    private readonly logger: Logger,
  ) {}

  async attach(consultantId: string, client: TelegramClient, webhookSecret: string): Promise<void> {
    await client.setWebhook(webhookUrl(this.config.publicUrl!, consultantId), webhookSecret, ALLOWED_UPDATES);
  }

  async detach(_consultantId: string, client: TelegramClient): Promise<void> {
    await client.deleteWebhook(false);
  }

  /** Makes sure every bot points at this deployment (e.g. after the Railway domain changed). */
  async start(): Promise<void> {
    const consultants = await this.store.listTelegramConsultants();
    for (const c of consultants) {
      try {
        const ctx = await this.runtime.getContext(c.id);
        const secret = ctx?.secrets?.webhook_secret;
        if (!ctx?.client || !secret) continue;
        const expected = webhookUrl(this.config.publicUrl!, c.id);
        const info = await ctx.client.getWebhookInfo();
        if (info.url !== expected) {
          await this.attach(c.id, ctx.client, secret);
          this.logger.info({ consultantId: c.id }, 'Webhook re-registered');
        }
      } catch (err) {
        if (err instanceof TelegramError && err.isUnauthorized) await this.runtime.markTokenInvalid(c.id);
        else this.logger.warn({ consultantId: c.id, err: errorMessage(err) }, 'Webhook sync failed');
      }
    }
    this.logger.info({ bots: consultants.length }, 'Telegram webhooks synced');
  }

  async stop(): Promise<void> {
    /* webhooks keep working across restarts; nothing to stop */
  }
}

export class PollingTransport implements TelegramTransport {
  readonly mode = 'polling' as const;
  private loops = new Map<string, AbortController>();

  constructor(
    private readonly store: Store,
    private readonly runtime: ConsultantRuntime,
    private readonly logger: Logger,
    private readonly pollTimeoutSec = 25,
  ) {}

  async attach(consultantId: string, client: TelegramClient): Promise<void> {
    await client.deleteWebhook(false); // getUpdates does not work while a webhook is set
    this.loops.get(consultantId)?.abort();
    const controller = new AbortController();
    this.loops.set(consultantId, controller);
    void this.loop(consultantId, client, controller.signal);
  }

  async detach(consultantId: string, client: TelegramClient): Promise<void> {
    this.loops.get(consultantId)?.abort();
    this.loops.delete(consultantId);
    await client.deleteWebhook(false).catch(() => undefined);
  }

  private async loop(consultantId: string, client: TelegramClient, signal: AbortSignal): Promise<void> {
    let offset = 0;
    let backoff = 1_000;
    this.logger.info({ consultantId }, 'Polling Telegram for updates');
    while (!signal.aborted) {
      try {
        const updates = await client.getUpdates(offset, this.pollTimeoutSec, signal);
        backoff = 1_000;
        for (const update of updates) {
          offset = update.update_id + 1;
          // Do not await: one slow chat must not block the others. Storage is idempotent.
          void this.runtime
            .handleUpdate(consultantId, update)
            .catch((err) => this.logger.error({ err: errorMessage(err), consultantId }, 'Update handling failed'));
        }
      } catch (err) {
        if (signal.aborted) break;
        if (err instanceof TelegramError && err.isUnauthorized) {
          await this.runtime.markTokenInvalid(consultantId);
          break;
        }
        const conflict = err instanceof TelegramError && err.code === 409;
        this.logger.warn(
          { consultantId, err: errorMessage(err) },
          conflict ? 'Another process is polling this bot (or a webhook is set)' : 'Polling error',
        );
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
    this.logger.info({ consultantId }, 'Stopped polling');
  }

  async start(): Promise<void> {
    const consultants = await this.store.listTelegramConsultants();
    for (const c of consultants) {
      const ctx = await this.runtime.getContext(c.id).catch(() => null);
      if (!ctx?.client) continue;
      await this.attach(c.id, ctx.client).catch((err) => {
        this.logger.warn({ consultantId: c.id, err: errorMessage(err) }, 'Could not start polling');
      });
    }
  }

  async stop(): Promise<void> {
    for (const controller of this.loops.values()) controller.abort();
    this.loops.clear();
  }
}
