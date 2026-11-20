import type { AppConfig } from '../../config.js';
import type { AgentActionRow, AgentOrderRow, AgentStore, StoreConnectionRow } from '../../db/agentStore.js';
import type { Store } from '../../db/store.js';
import type { ConsultantRow, ConversationRow } from '../../db/types.js';
import { decryptSecret, randomCode } from '../../lib/crypto.js';
import { AppError, errorMessage, notFound } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { TtlCache } from '../queue.js';
import {
  cleanOrderRef,
  createConnector,
  StoreError,
  type NewOrder,
  type Order,
  type StoreConnector,
  type StoreCredentials,
} from './connectors.js';
import { readAgentSettings, type AgentSettings } from './settings.js';
import { agentInstructions, allowedTools, orderUpdateText, statusText, type AgentTurn } from './tools.js';

/** A prepared action waits this long for the customer's "yes". */
const CONFIRM_TTL_MS = 2 * 60 * 60_000;
/** Orders are followed for notifications at most this long. */
const FOLLOW_ORDERS_DAYS = 45;

export type CustomerLang = 'en' | 'ru';

/** The customer's language for system texts: Telegram's app language or the alphabet they write in. */
export function customerLang(conversation: Pick<ConversationRow, 'customer_language' | 'last_message_preview'>, sample = ''): CustomerLang {
  const code = (conversation.customer_language ?? '').toLowerCase();
  if (/^(ru|uk|be|kk|ky|uz|tg)/.test(code)) return 'ru';
  if (code) return 'en';
  return /[Ѐ-ӿ]/.test(sample.trim() ? sample : (conversation.last_message_preview ?? '')) ? 'ru' : 'en';
}

/** The language of what the customer wrote last (the preview may be our own reply). */
export async function conversationLang(store: Pick<Store, 'getRecentMessages'>, conversation: ConversationRow): Promise<CustomerLang> {
  const recent = await store.getRecentMessages(conversation.id, { limit: 8 }).catch(() => []);
  const sample = recent
    .filter((m) => m.role === 'customer')
    .map((m) => m.content)
    .join(' ');
  return customerLang(conversation, sample);
}

export interface AgentServiceDeps {
  agentStore: AgentStore;
  config: Pick<AppConfig, 'encryptionKey'>;
  logger: Logger;
  /** Builds the store client for a connection (replaced in tests). */
  connector?: (connection: StoreConnectionRow, creds: StoreCredentials) => StoreConnector;
}

export interface AgentTurnInput {
  consultant: ConsultantRow;
  conversation: ConversationRow;
  /** When the newest customer message of this turn was written: confirmations must come after a preparation. */
  latestCustomerAt: string;
  /** The owner's test chat: nothing changes in the store and nobody is alerted. */
  simulate: boolean;
  /** The owner has to act (approve a refund, finish an order): flags the chat and alerts the owner. */
  ownerTask(reason: string, detail: string): Promise<void>;
}

interface PriceInfo {
  name: string;
  price: string | null;
  currency: string | null;
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const digits = (v: string) => v.replace(/\D/g, '');

/** The phone number or email the customer gave matches the order's. */
export function contactMatches(order: Pick<Order, 'email' | 'phone'>, contact: string): boolean {
  const c = contact.trim().toLowerCase();
  if (!c) return false;
  if (c.includes('@')) return Boolean(order.email && order.email.trim().toLowerCase() === c);
  const d = digits(c);
  const p = digits(order.phone ?? '');
  return d.length >= 6 && p.length >= 6 && d.slice(-10) === p.slice(-10);
}

/** What the model may tell the customer about an order (no contact details). */
function publicOrder(order: Order) {
  return {
    number: order.number,
    status: order.status,
    status_text: statusText(order.status, 'en'),
    total: order.total,
    currency: order.currency,
    items: order.items,
    payment_url: order.paymentUrl,
    tracking_url: order.trackingUrl,
    created_at: order.createdAt,
    can_be_cancelled: order.cancellable,
  };
}

function money(amount: number | string | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return '';
  const n = Number(amount);
  const value = Number.isFinite(n) ? n.toFixed(2).replace(/\.00$/, '') : String(amount);
  return currency ? `${value} ${currency}` : value;
}

export class AgentService {
  private readonly connections = new TtlCache<{ row: StoreConnectionRow | null }>(30_000);
  /** Prices from the catalog searches in a chat, to total up the order the customer then places. */
  private readonly prices = new TtlCache<Map<string, PriceInfo>>(60 * 60_000);

  constructor(private readonly deps: AgentServiceDeps) {}

  settings(consultant: Pick<ConsultantRow, 'agent'>): AgentSettings {
    return readAgentSettings(consultant.agent);
  }

  invalidate(consultantId: string): void {
    this.connections.delete(consultantId);
  }

  async connection(consultantId: string): Promise<StoreConnectionRow | null> {
    const hit = this.connections.get(consultantId);
    if (hit) return hit.row;
    const row = await this.deps.agentStore.getConnection(consultantId);
    this.connections.set(consultantId, { row });
    return row;
  }

  credentials(connection: StoreConnectionRow): StoreCredentials {
    return JSON.parse(decryptSecret(connection.credentials_ciphertext, this.deps.config.encryptionKey)) as StoreCredentials;
  }

  connectorFor(connection: StoreConnectionRow | null): StoreConnector | null {
    if (!connection) return null;
    try {
      const creds = this.credentials(connection);
      return this.deps.connector ? this.deps.connector(connection, creds) : createConnector(connection.platform, connection.store_url, creds);
    } catch (err) {
      this.deps.logger.error({ err: errorMessage(err), consultantId: connection.consultant_id }, 'Could not open the store connection');
      return null;
    }
  }

  /** Tools for one turn, or null when the agent is off. The caller checks the plan. */
  async turn(input: AgentTurnInput): Promise<AgentTurn | null> {
    const settings = this.settings(input.consultant);
    if (!settings.enabled) return null;
    const connection = await this.connection(input.consultant.id);
    const connector = this.connectorFor(connection);
    const tools = allowedTools(settings.permissions, Boolean(connector));
    if (!tools.length) return null;
    const executor = new TurnExecutor(this, this.deps, input, settings, connection, connector);
    return {
      tools,
      instructions: agentInstructions(tools, { connected: Boolean(connector), storeName: connection?.store_name ?? null, simulate: input.simulate }),
      execute: (name, args) => executor.execute(name, args),
    };
  }

  rememberPrices(conversationId: string, items: { key: string; info: PriceInfo }[]): void {
    const map = this.prices.get(conversationId) ?? new Map<string, PriceInfo>();
    for (const i of items) map.set(i.key, i.info);
    this.prices.set(conversationId, map);
  }

  pricesFor(conversationId: string): Map<string, PriceInfo> | undefined {
    return this.prices.get(conversationId);
  }

  // ---------------------------------------------------------------------------
  // The owner's decisions on actions waiting for them (dashboard)
  // ---------------------------------------------------------------------------

  /**
   * Carries out an action the owner approved and returns the message for the customer.
   * Without a connected store the owner did it by hand; the customer is just told it is done.
   */
  async approve(consultant: ConsultantRow, actionId: string, lang: CustomerLang): Promise<{ action: AgentActionRow; message: string }> {
    const { agentStore } = this.deps;
    const action = await agentStore.getAction(actionId);
    if (!action || action.consultant_id !== consultant.id) throw notFound('Action');
    if (action.status !== 'awaiting_owner') throw new AppError(409, 'not_pending', 'This action is no longer waiting for approval');
    const connector = this.connectorFor(await this.connection(consultant.id));
    const ru = lang === 'ru';
    try {
      let result: Record<string, unknown> = { approved_by_owner: true };
      let message: string;
      let externalRef = action.external_ref;
      if (action.kind === 'create_order') {
        if (connector) {
          const order = await connector.createOrder(action.params.order as NewOrder);
          result = { order: publicOrder(order) };
          externalRef = order.number;
          if (action.conversation_id) {
            await agentStore.linkOrder({ consultantId: consultant.id, conversationId: action.conversation_id, externalId: order.id, number: order.number, status: order.status });
          }
          message = ru
            ? `Ваш заказ ${order.number} подтверждён${order.total ? ` на сумму ${money(order.total, order.currency)}` : ''}.${order.paymentUrl ? `\nОплатить: ${order.paymentUrl}` : ''}`
            : `Your order ${order.number} is confirmed${order.total ? ` (${money(order.total, order.currency)})` : ''}.${order.paymentUrl ? `\nPay here: ${order.paymentUrl}` : ''}`;
        } else {
          message = ru ? 'Ваш заказ подтверждён. Спасибо!' : 'Your order is confirmed. Thank you!';
        }
      } else if (action.kind === 'refund') {
        const number = String(action.params.order_number ?? action.external_ref ?? '');
        if (connector) {
          const order = await connector.getOrder(String(action.params.order_id ?? number));
          if (!order) throw new StoreError('The order no longer exists in the store');
          const refund = await connector.refund(order, action.amount === null ? null : Number(action.amount), String(action.params.reason ?? ''));
          result = { refund };
          message = ru
            ? `Возврат по заказу ${order.number} оформлен${refund.amount ? `: ${money(refund.amount, order.currency)}` : ''}. Деньги поступят тем же способом, которым вы платили.`
            : `The refund for order ${order.number} is done${refund.amount ? `: ${money(refund.amount, order.currency)}` : ''}. The money goes back the way you paid.`;
        } else {
          message = ru ? `Возврат по заказу ${number} одобрен. Мы свяжемся с вами по деталям.` : `Your return for order ${number} is approved. We'll be in touch with the details.`;
        }
      } else if (action.kind === 'cancel_order' && connector) {
        const order = await connector.getOrder(String(action.params.order_id ?? action.external_ref ?? ''));
        if (!order) throw new StoreError('The order no longer exists in the store');
        await connector.cancelOrder(order, String(action.params.reason ?? ''));
        message = ru ? `Заказ ${order.number} отменён.` : `Order ${order.number} is cancelled.`;
      } else {
        message = ru ? 'Готово!' : 'Done!';
      }
      const updated = await agentStore.transitionAction(action.id, 'awaiting_owner', {
        status: 'done',
        result,
        external_ref: externalRef,
        executed_at: new Date().toISOString(),
      });
      if (!updated) throw new AppError(409, 'not_pending', 'This action is no longer waiting for approval');
      return { action: updated, message };
    } catch (err) {
      if (err instanceof AppError) throw err;
      const reason = errorMessage(err).slice(0, 900);
      await agentStore.transitionAction(action.id, 'awaiting_owner', { status: 'failed', error: reason }).catch(() => null);
      throw new AppError(502, 'store_error', `The store did not accept it: ${reason}`);
    }
  }

  async reject(consultant: ConsultantRow, actionId: string, lang: CustomerLang, reason: string): Promise<{ action: AgentActionRow; message: string }> {
    const action = await this.deps.agentStore.getAction(actionId);
    if (!action || action.consultant_id !== consultant.id) throw notFound('Action');
    const updated = await this.deps.agentStore.transitionAction(action.id, 'awaiting_owner', {
      status: 'rejected',
      error: reason.slice(0, 900) || null,
    });
    if (!updated) throw new AppError(409, 'not_pending', 'This action is no longer waiting for approval');
    const what =
      action.kind === 'create_order'
        ? lang === 'ru' ? 'заказ' : 'the order'
        : action.kind === 'refund'
          ? lang === 'ru' ? 'возврат' : 'the return'
          : lang === 'ru' ? 'запрос' : 'the request';
    const message =
      lang === 'ru'
        ? `К сожалению, мы не можем подтвердить ${what}.${reason ? ` Причина: ${reason}` : ''} Напишите, если есть вопросы.`
        : `Unfortunately we can't approve ${what}.${reason ? ` Reason: ${reason}` : ''} Let us know if you have any questions.`;
    return { action: updated, message };
  }

  // ---------------------------------------------------------------------------
  // Order updates for customers
  // ---------------------------------------------------------------------------

  /**
   * Checks followed orders and tells customers when one changes. `allowed` returns the language
   * to write in, or null when this consultant must not send updates (agent off, plan, permission).
   */
  async checkOrders(opts: {
    allowed(row: AgentOrderRow): Promise<CustomerLang | null>;
    deliver(row: AgentOrderRow, text: string): Promise<boolean>;
    now?: number;
    limit?: number;
  }): Promise<number> {
    const { agentStore, logger } = this.deps;
    const now = opts.now ?? Date.now();
    const rows = await agentStore.listOrdersToCheck(new Date(now - 10 * 60_000).toISOString(), opts.limit ?? 40);
    let sent = 0;
    for (const row of rows) {
      const checkedAt = new Date(now).toISOString();
      try {
        if (Date.parse(row.created_at) < now - FOLLOW_ORDERS_DAYS * 86_400_000) {
          await agentStore.updateOrder(row.id, { closed: true, last_checked_at: checkedAt });
          continue;
        }
        const lang = await opts.allowed(row);
        const connector = lang ? this.connectorFor(await this.connection(row.consultant_id)) : null;
        if (!lang || !connector) {
          await agentStore.updateOrder(row.id, { last_checked_at: checkedAt });
          continue;
        }
        const order = await connector.getOrder(row.external_id);
        if (!order) {
          await agentStore.updateOrder(row.id, { closed: true, last_checked_at: checkedAt });
          continue;
        }
        const patch: Parameters<AgentStore['updateOrder']>[1] = { last_checked_at: checkedAt, status: order.status };
        if (order.status.toLowerCase() !== (row.notified_status ?? '').toLowerCase()) {
          const message = orderUpdateText(order, lang);
          if (await opts.deliver(row, message)) {
            patch.notified_status = order.status;
            sent++;
            await agentStore
              .insertAction({
                consultantId: row.consultant_id,
                conversationId: row.conversation_id,
                kind: 'notify',
                status: 'done',
                summary: message,
                params: { order: order.number, status: order.status },
                externalRef: order.number,
              })
              .catch(() => undefined);
          }
        }
        if (order.final) patch.closed = true;
        await agentStore.updateOrder(row.id, patch);
      } catch (err) {
        logger.warn({ err: errorMessage(err), orderId: row.id }, 'Order status check failed');
        await agentStore.updateOrder(row.id, { last_checked_at: checkedAt }).catch(() => undefined);
      }
    }
    return sent;
  }
}

/** Runs the tools of one turn. Results are cached by arguments, so a retried turn never acts twice. */
class TurnExecutor {
  private readonly cache = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly service: AgentService,
    private readonly deps: AgentServiceDeps,
    private readonly input: AgentTurnInput,
    private readonly settings: AgentSettings,
    private readonly connection: StoreConnectionRow | null,
    private readonly connector: StoreConnector | null,
  ) {}

  async execute(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const key = `${name}:${JSON.stringify(args)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    let result: Record<string, unknown>;
    try {
      result = await this.run(name, args);
    } catch (err) {
      this.deps.logger.warn({ err: errorMessage(err), tool: name, consultantId: this.input.consultant.id }, 'Agent tool failed');
      result = {
        ok: false,
        error: err instanceof StoreError ? `The store did not accept the request (${err.message.slice(0, 200)})` : 'Something went wrong on our side',
      };
    }
    this.cache.set(key, result);
    return result;
  }

  private get currency(): string | null {
    return this.connection?.currency ?? null;
  }

  private async run(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const p = this.settings.permissions;
    switch (name) {
      case 'find_products':
        if (!p.catalog || !this.connector) return { ok: false, error: 'Not allowed' };
        return this.findProducts(text(args.query, 200));
      case 'get_order':
        if (!p.orderStatus || !this.connector) return { ok: false, error: 'Not allowed' };
        return this.getOrder(text(args.order_number, 100), text(args.contact, 200));
      case 'prepare_order':
        if (!p.createOrders) return { ok: false, error: 'Not allowed' };
        return this.prepareOrder(args);
      case 'prepare_cancellation':
        if (!p.cancelOrders || !this.connector) return { ok: false, error: 'Not allowed' };
        return this.prepareCancellation(text(args.order_number, 100), text(args.reason, 500));
      case 'prepare_return':
        if (!p.returns) return { ok: false, error: 'Not allowed' };
        return this.prepareReturn(text(args.order_number, 100), text(args.reason, 500), args.amount);
      case 'confirm_action':
        return this.confirm(text(args.confirmation_code, 20).toUpperCase());
      case 'cancel_pending_action':
        return this.dropPending(text(args.confirmation_code, 20).toUpperCase());
      default:
        return { ok: false, error: `Unknown tool ${name}` };
    }
  }

  private async findProducts(query: string) {
    if (!query) return { ok: false, error: 'Say what to search for' };
    const found = (await this.connector!.findProducts(query, 5)).slice(0, 10);
    this.service.rememberPrices(
      this.input.conversation.id,
      found.map((f) => ({ key: `${f.id}:${f.variantId ?? ''}`, info: { name: f.name, price: f.price, currency: f.currency ?? this.currency } })),
    );
    return {
      ok: true,
      products: found.map((f) => ({
        product_id: f.id,
        variant_id: f.variantId,
        name: f.name,
        price: f.price,
        currency: f.currency ?? this.currency,
        in_stock: f.inStock,
        url: f.url,
      })),
      ...(found.length ? {} : { note: 'Nothing found. Try other words, or ask the customer to describe it differently.' }),
    };
  }

  /** The order, if it is this customer's: placed in this chat, or they gave its phone/email. */
  private async ownOrder(ref: string, contact: string): Promise<{ order: Order } | { error: Record<string, unknown> }> {
    const { consultant, conversation, simulate } = this.input;
    if (!cleanOrderRef(ref)) return { error: { ok: false, error: 'Ask the customer for the order number' } };
    const order = await this.connector!.getOrder(ref);
    if (!order) return { error: { ok: false, error: 'There is no order with this number. Ask the customer to check it.' } };
    const linked = await this.deps.agentStore.findLinkedOrder(consultant.id, conversation.id, order.id);
    if (!linked) {
      if (!contact) {
        return {
          error: {
            ok: false,
            needs_contact: true,
            error: 'Ask for the phone number or email the order was placed with, then call get_order again with contact.',
          },
        };
      }
      if (!contactMatches(order, contact)) {
        return { error: { ok: false, error: 'The contact does not match this order. Share no details of it.' } };
      }
      if (!simulate) {
        await this.deps.agentStore.linkOrder({ consultantId: consultant.id, conversationId: conversation.id, externalId: order.id, number: order.number, status: order.status });
      }
    }
    return { order };
  }

  private async getOrder(ref: string, contact: string) {
    const own = await this.ownOrder(ref, contact);
    if ('error' in own) return own.error;
    return { ok: true, order: publicOrder(own.order) };
  }

  private newCode(): string {
    return randomCode(6, '');
  }

  private async prepareOrder(args: Record<string, unknown>) {
    const rawItems = Array.isArray(args.items) ? args.items.slice(0, 20) : [];
    const prices = this.service.pricesFor(this.input.conversation.id);
    const items: { productId: string; variantId: string | null; name: string; quantity: number; price: string | null }[] = [];
    for (const raw of rawItems) {
      const i = (raw ?? {}) as Record<string, unknown>;
      const quantity = Math.floor(Number(i.quantity));
      const productId = text(i.product_id, 200);
      const variantId = text(i.variant_id, 200) || null;
      const known = prices?.get(`${productId}:${variantId ?? ''}`) ?? prices?.get(`${productId}:`);
      const name = known?.name || text(i.name, 200);
      if (!name || !Number.isFinite(quantity) || quantity < 1 || quantity > 999) {
        return { ok: false, error: 'Every item needs a name and a quantity from 1 to 999' };
      }
      if (this.connector && !productId) return { ok: false, error: `Use find_products to get the product_id of "${name}" first` };
      items.push({ productId, variantId, name, quantity, price: known?.price ?? null });
    }
    if (!items.length) return { ok: false, error: 'Add at least one item' };
    const customerName = text(args.customer_name, 100);
    const phone = text(args.phone, 40);
    if (!customerName) return { ok: false, error: "Ask for the customer's name" };
    if (digits(phone).length < 6) return { ok: false, error: 'Ask for a contact phone number' };
    const email = text(args.email, 200);
    const address = text(args.address, 300);
    const city = text(args.city, 100);
    const note = text(args.note, 500);

    const priced = items.every((i) => i.price !== null && Number.isFinite(Number(i.price)));
    const total = priced ? items.reduce((s, i) => s + Number(i.price) * i.quantity, 0) : null;
    const currency = (prices && [...prices.values()].find((v) => v.currency)?.currency) ?? this.currency;
    const summary = [
      ...items.map((i) => `- ${i.name} × ${i.quantity}${i.price ? ` (${money(i.price, currency)})` : ''}`),
      total !== null ? `Total: ${money(total, currency)}${this.connector ? ' (the store confirms the final amount, with delivery if any)' : ''}` : null,
      `Name: ${customerName}; phone: ${phone}${email ? `; email: ${email}` : ''}`,
      address || city ? `Delivery: ${[address, city].filter(Boolean).join(', ')}` : null,
      note ? `Note: ${note}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    const order: NewOrder = {
      items: items.map((i) => ({ productId: i.productId, variantId: i.variantId, quantity: i.quantity })),
      customer: { name: customerName, phone, ...(email ? { email } : {}), ...(address ? { address } : {}), ...(city ? { city } : {}) },
      ...(note ? { note } : {}),
    };
    const code = this.newCode();
    await this.deps.agentStore.insertAction({
      consultantId: this.input.consultant.id,
      conversationId: this.input.conversation.id,
      kind: 'create_order',
      status: 'awaiting_customer',
      summary,
      params: { order, items: items.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price })) },
      amount: total,
      currency,
      confirmCode: code,
    });
    return {
      ok: true,
      confirmation_code: code,
      summary,
      next_step: 'Show this summary and ask the customer to confirm. Call confirm_action only after they agree in their next message.',
    };
  }

  private async prepareCancellation(ref: string, reason: string) {
    const own = await this.ownOrder(ref, '');
    if ('error' in own) {
      return own.error.needs_contact
        ? { ok: false, error: 'First check the order with get_order (with the phone/email it was placed with) to confirm it is theirs.' }
        : own.error;
    }
    const order = own.order;
    if (!order.cancellable) return { ok: false, error: `This order can no longer be cancelled (status: ${statusText(order.status, 'en')}).` };
    const code = this.newCode();
    const summary = `Cancel order ${order.number}${order.total ? ` (${money(order.total, order.currency)})` : ''}. Reason: ${reason || '—'}`;
    await this.deps.agentStore.insertAction({
      consultantId: this.input.consultant.id,
      conversationId: this.input.conversation.id,
      kind: 'cancel_order',
      status: 'awaiting_customer',
      summary,
      params: { order_id: order.id, order_number: order.number, reason },
      amount: order.total === null ? null : Number(order.total),
      currency: order.currency,
      externalRef: order.number,
      confirmCode: code,
    });
    return { ok: true, confirmation_code: code, summary, next_step: 'Ask the customer to confirm the cancellation.' };
  }

  private async prepareReturn(ref: string, reason: string, rawAmount: unknown) {
    let orderId: string | null = null;
    let number = cleanOrderRef(ref);
    let currency = this.currency;
    let total: number | null = null;
    if (this.connector) {
      const own = await this.ownOrder(ref, '');
      if ('error' in own) {
        return own.error.needs_contact
          ? { ok: false, error: 'First check the order with get_order (with the phone/email it was placed with) to confirm it is theirs.' }
          : own.error;
      }
      orderId = own.order.id;
      number = own.order.number;
      currency = own.order.currency ?? currency;
      total = own.order.total === null ? null : Number(own.order.total);
    } else if (!number) {
      return { ok: false, error: 'Ask the customer for the order number' };
    }
    const requested = typeof rawAmount === 'number' && Number.isFinite(rawAmount) && rawAmount > 0 ? rawAmount : null;
    if (requested !== null && total !== null && requested > total) {
      return { ok: false, error: `The refund cannot be more than the order total (${money(total, currency)})` };
    }
    const amount = requested ?? total;
    const limit = this.settings.refundAutoLimit;
    const needsOwner = !this.connector || !(limit > 0 && amount !== null && amount <= limit);
    const code = this.newCode();
    const summary = `Return / refund for order ${number}${amount !== null ? `: ${money(amount, currency)}` : ''}. Reason: ${reason || '—'}`;
    await this.deps.agentStore.insertAction({
      consultantId: this.input.consultant.id,
      conversationId: this.input.conversation.id,
      kind: 'refund',
      status: 'awaiting_customer',
      summary,
      params: { order_id: orderId, order_number: number, reason, needs_owner: needsOwner },
      amount,
      currency,
      externalRef: number,
      confirmCode: code,
    });
    return {
      ok: true,
      confirmation_code: code,
      summary,
      needs_manager_approval: needsOwner,
      next_step: needsOwner
        ? 'Ask the customer to confirm; after that a manager approves the refund (say so).'
        : 'Ask the customer to confirm; the refund then goes through right away.',
    };
  }

  private async confirm(code: string) {
    const { agentStore } = this.deps;
    const { conversation, consultant, simulate } = this.input;
    if (!code) return { ok: false, error: 'Missing confirmation_code' };
    const action = await agentStore.findActionByCode(conversation.id, code);
    if (!action) return { ok: false, error: 'Unknown confirmation code. Prepare the action again.' };
    if (action.status === 'done' || action.status === 'simulated' || action.status === 'awaiting_owner') {
      return { ok: true, already_done: true, status: action.status, result: action.result };
    }
    if (action.status !== 'awaiting_customer') return { ok: false, error: `This action is ${action.status.replace('_', ' ')}. Prepare it again if needed.` };
    const preparedAt = Date.parse(action.created_at);
    const answeredAt = Date.parse(this.input.latestCustomerAt);
    if (!(answeredAt > preparedAt)) {
      return { ok: false, error: 'Not yet: show the summary and wait for the customer to confirm in their next message.' };
    }
    if (answeredAt - preparedAt > CONFIRM_TTL_MS) {
      await agentStore.transitionAction(action.id, 'awaiting_customer', { status: 'expired' });
      return { ok: false, error: 'This confirmation expired. Prepare the action again and ask the customer to confirm.' };
    }

    if (simulate) {
      const fake = action.kind === 'create_order' ? { order_number: `TEST-${code.slice(0, 4)}`, payment_url: null } : {};
      await agentStore.transitionAction(action.id, 'awaiting_customer', { status: 'simulated', result: { test: true, ...fake }, executed_at: new Date().toISOString() });
      return { ok: true, test_mode: true, ...fake, note: 'Test chat: simulated, nothing changed in the store.' };
    }

    const toOwner = async (reason: string) => {
      await agentStore.transitionAction(action.id, 'awaiting_customer', { status: 'awaiting_owner' });
      await this.input.ownerTask(reason, action.summary).catch(() => undefined);
      return { ok: true, sent_to_team: true, note: 'The team got it and will finish it shortly. Tell the customer so.' };
    };

    try {
      if (action.kind === 'create_order') {
        if (!this.connector) return toOwner('New order from the chat: confirm it');
        const order = await this.connector.createOrder(action.params.order as NewOrder);
        await agentStore.transitionAction(action.id, 'awaiting_customer', {
          status: 'done',
          result: { order: publicOrder(order) },
          external_ref: order.number,
          amount: order.total === null ? (action.amount as number | null) : Number(order.total),
          currency: order.currency ?? action.currency,
          executed_at: new Date().toISOString(),
        });
        await agentStore.linkOrder({ consultantId: consultant.id, conversationId: conversation.id, externalId: order.id, number: order.number, status: order.status });
        return { ok: true, order: publicOrder(order) };
      }
      if (action.kind === 'cancel_order') {
        const order = await this.connector!.getOrder(String(action.params.order_id ?? action.external_ref ?? ''));
        if (!order) throw new StoreError('The order was not found');
        if (!order.cancellable) {
          await agentStore.transitionAction(action.id, 'awaiting_customer', { status: 'failed', error: `Not cancellable: ${order.status}` });
          return { ok: false, error: `The order can no longer be cancelled (status: ${statusText(order.status, 'en')}).` };
        }
        const cancelled = await this.connector!.cancelOrder(order, String(action.params.reason ?? ''));
        await agentStore.transitionAction(action.id, 'awaiting_customer', { status: 'done', result: { order: publicOrder(cancelled) }, executed_at: new Date().toISOString() });
        return { ok: true, order: publicOrder(cancelled) };
      }
      if (action.kind === 'refund') {
        if (action.params.needs_owner || !this.connector) return toOwner('A customer asks for a refund: approve it');
        const order = await this.connector.getOrder(String(action.params.order_id ?? action.external_ref ?? ''));
        if (!order) throw new StoreError('The order was not found');
        const refund = await this.connector.refund(order, action.amount === null ? null : Number(action.amount), String(action.params.reason ?? ''));
        await agentStore.transitionAction(action.id, 'awaiting_customer', { status: 'done', result: { refund }, executed_at: new Date().toISOString() });
        return { ok: true, refund: { amount: refund.amount, currency: order.currency, status: refund.status } };
      }
      return { ok: false, error: 'Unknown action' };
    } catch (err) {
      const reason = errorMessage(err).slice(0, 900);
      await agentStore.transitionAction(action.id, 'awaiting_customer', { status: 'failed', error: reason }).catch(() => null);
      await this.input.ownerTask('The agent could not finish an action', `${action.summary}\nError: ${reason}`).catch(() => undefined);
      return { ok: false, error: 'The store did not accept it. A team member was notified and will take care of it.' };
    }
  }

  private async dropPending(code: string) {
    const action = code ? await this.deps.agentStore.findActionByCode(this.input.conversation.id, code) : null;
    if (!action) return { ok: false, error: 'Unknown confirmation code' };
    if (action.status !== 'awaiting_customer') return { ok: true, note: `It is already ${action.status.replace('_', ' ')}` };
    await this.deps.agentStore.transitionAction(action.id, 'awaiting_customer', { status: 'rejected', error: 'Dropped in the chat' });
    return { ok: true };
  }
}
