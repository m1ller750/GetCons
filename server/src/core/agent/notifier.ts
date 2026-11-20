import type { Store } from '../../db/store.js';
import { errorMessage } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { ReplyQuota } from '../billing.js';
import type { ConsultantRuntime } from '../runtime.js';
import { conversationLang, type AgentService } from './service.js';

/** Every few minutes: tells customers in their chat when an order they placed or checked changes. */
export class OrderNotifier {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly deps: {
      agent: AgentService;
      store: Store;
      runtime: Pick<ConsultantRuntime, 'notifyCustomer'>;
      quota: ReplyQuota | null;
      logger: Logger;
      intervalMs?: number;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? 5 * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    const { agent, store, runtime, quota, logger } = this.deps;
    try {
      return await agent.checkOrders({
        allowed: async (row) => {
          const consultant = await store.getConsultant(row.consultant_id);
          if (!consultant || consultant.status !== 'active' || !quota) return null;
          const settings = agent.settings(consultant);
          if (!settings.enabled || !settings.permissions.notify) return null;
          if (!(await quota.check(consultant.user_id)).plan.agent) return null;
          const conversation = await store.getConversation(row.conversation_id);
          return conversation ? conversationLang(store, conversation) : null;
        },
        deliver: (row, text) => runtime.notifyCustomer(row.consultant_id, row.conversation_id, text, { order: row.number }),
      });
    } catch (err) {
      logger.warn({ err: errorMessage(err) }, 'Order update check failed');
      return 0;
    } finally {
      this.running = false;
    }
  }
}
