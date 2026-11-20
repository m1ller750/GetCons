import type { ToolSpec } from '../../services/llm.js';
import type { AgentPermissions } from './settings.js';

/** What the reply engine needs for one agent turn. */
export interface AgentTurn {
  tools: ToolSpec[];
  /** Appended to the system instruction. */
  instructions: string;
  execute(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const codeParam = {
  type: 'object',
  properties: {
    confirmation_code: { type: 'string', description: 'The confirmation_code returned by a prepare_* tool.' },
  },
  required: ['confirmation_code'],
};

export const TOOL_SPECS: Record<string, ToolSpec> = {
  find_products: {
    name: 'find_products',
    description: "Search the store's catalog: product ids, prices and stock. Use it before quoting a price or placing an order.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for: product name, type or keywords (one or two words work best).' },
      },
      required: ['query'],
    },
  },
  get_order: {
    name: 'get_order',
    description:
      "Look up an order's status, items, total, payment and tracking links. Orders not placed in this chat are shown only after the customer gives the phone number or email used for the order.",
    parameters: {
      type: 'object',
      properties: {
        order_number: { type: 'string', description: 'The order number the customer gave, e.g. 1024 or #1024.' },
        contact: { type: 'string', description: 'Phone number or email the order was placed with, exactly as the customer wrote it.' },
      },
      required: ['order_number'],
    },
  },
  prepare_order: {
    name: 'prepare_order',
    description:
      'Prepare a new order from what the customer wants. Returns a summary and a confirmation_code. Nothing is ordered until confirm_action is called after the customer agrees.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'string', description: 'product_id from find_products (leave empty if the catalog is not available).' },
              variant_id: { type: 'string', description: 'variant_id from find_products, if it has one.' },
              name: { type: 'string', description: 'Product name as the customer sees it.' },
              quantity: { type: 'integer', description: 'How many.' },
            },
            required: ['name', 'quantity'],
          },
        },
        customer_name: { type: 'string', description: "Customer's name for the order." },
        phone: { type: 'string', description: 'Contact phone number.' },
        email: { type: 'string', description: 'Email, if the customer gave one.' },
        address: { type: 'string', description: 'Delivery address (street, house, apartment), if delivery is needed.' },
        city: { type: 'string', description: 'City, if delivery is needed.' },
        note: { type: 'string', description: 'Delivery time or other wishes.' },
      },
      required: ['items', 'customer_name', 'phone'],
    },
  },
  prepare_cancellation: {
    name: 'prepare_cancellation',
    description: 'Prepare cancelling one of the customer’s orders. Returns a summary and a confirmation_code.',
    parameters: {
      type: 'object',
      properties: {
        order_number: { type: 'string', description: 'The order number.' },
        reason: { type: 'string', description: 'Why the customer cancels, in their words.' },
      },
      required: ['order_number', 'reason'],
    },
  },
  prepare_return: {
    name: 'prepare_return',
    description:
      'Prepare a return / refund for one of the customer’s orders. Returns a summary, whether a manager must approve it, and a confirmation_code.',
    parameters: {
      type: 'object',
      properties: {
        order_number: { type: 'string', description: 'The order number.' },
        reason: { type: 'string', description: 'Why the customer returns it, in their words.' },
        amount: { type: 'number', description: 'Only for a partial refund: the amount. Leave empty to refund the whole order.' },
      },
      required: ['order_number', 'reason'],
    },
  },
  confirm_action: {
    name: 'confirm_action',
    description:
      'Carry out a prepared order, cancellation or return. Call it ONLY after the customer has clearly agreed to the summary in a new message.',
    parameters: codeParam,
  },
  cancel_pending_action: {
    name: 'cancel_pending_action',
    description: 'Drop a prepared action the customer does not want (or that you are replacing with a corrected one).',
    parameters: codeParam,
  },
};

/** Tools the owner allowed. Without a connected store, orders and returns go to the team instead. */
export function allowedTools(p: AgentPermissions, connected: boolean): ToolSpec[] {
  const names: string[] = [];
  if (connected && p.catalog) names.push('find_products');
  if (connected && p.orderStatus) names.push('get_order');
  if (p.createOrders) names.push('prepare_order');
  if (connected && p.cancelOrders) names.push('prepare_cancellation');
  if (p.returns) names.push('prepare_return');
  if (names.some((n) => n.startsWith('prepare_'))) names.push('confirm_action', 'cancel_pending_action');
  return names.map((n) => TOOL_SPECS[n]!);
}

export function agentInstructions(tools: ToolSpec[], opts: { connected: boolean; storeName: string | null; simulate: boolean }): string {
  const has = (name: string) => tools.some((t) => t.name === name);
  const lines = [
    '# You are an agent: you do the work, not only answer',
    `You can act for the business with tools${opts.connected ? ` connected to its store${opts.storeName ? ` ("${opts.storeName}")` : ''}` : ''}. Every turn ends with the "reply" tool, whose arguments are your message to the customer.`,
  ];
  if (has('find_products')) lines.push('- Prices, stock and product ids: use find_products instead of guessing. Mention only products it returns.');
  if (!opts.connected) {
    lines.push('- The store is not connected: take prices and products from the business information and knowledge excerpts.');
  }
  if (has('get_order')) {
    lines.push(
      '- Order status: use get_order. Share only what it returns. If it says a contact is needed, ask for the phone number or email the order was placed with, then call it again.',
    );
  }
  if (has('prepare_order')) {
    lines.push(
      `- Placing an order: collect the items${opts.connected ? ' (with product ids from find_products)' : ''}, the customer's name, phone and, if delivery is needed, the address. Then call prepare_order.`,
    );
  }
  if (has('prepare_cancellation')) lines.push('- Cancelling an order: call prepare_cancellation.');
  if (has('prepare_return')) lines.push('- Returns and refunds: ask what is wrong, then call prepare_return.');
  if (has('confirm_action')) {
    lines.push(
      '- After any prepare_* tool: show the customer the summary it returned (items, total, delivery details, amount) and ask them to confirm with a clear yes. Only when the customer agrees in their NEXT message, call confirm_action with the confirmation_code. Never call confirm_action in the same turn as the preparation, never make up codes, and if they want changes, prepare again and drop the old one with cancel_pending_action.',
      '- Never say an order is placed, cancelled or refunded unless confirm_action returned ok. If it returns a payment link, send it. If it says the team will approve or finish it, say exactly that.',
    );
  }
  lines.push(
    '- If a tool fails, apologise briefly, do not repeat it more than once, and offer help from the team (answer_status "handoff" when a person must take over).',
    '- Returns, refunds and order changes that your tools handle are your job: do not hand them off just because they involve money.',
  );
  if (opts.simulate) lines.push('- This is the owner’s test chat: store changes are simulated, nothing is really ordered or refunded. Behave exactly as with a real customer.');
  return lines.join('\n');
}

/** The final tool: its arguments are the reply engine's structured answer. */
export function replyTool(schema: Record<string, unknown>): ToolSpec {
  return {
    name: 'reply',
    description: 'Send your message to the customer and end the turn. Call it exactly once, last.',
    parameters: schema,
  };
}

// ---------------------------------------------------------------------------
// Order statuses in words, for customers (notifications) and for the model
// ---------------------------------------------------------------------------

const STATUS_TEXT: Record<string, { en: string; ru: string }> = {
  pending: { en: 'waiting for payment', ru: 'ожидает оплаты' },
  open: { en: 'waiting for payment', ru: 'ожидает оплаты' },
  invoice_sent: { en: 'waiting for payment', ru: 'ожидает оплаты' },
  'on-hold': { en: 'on hold, waiting for confirmation', ru: 'ожидает подтверждения' },
  on_hold: { en: 'on hold', ru: 'приостановлен' },
  processing: { en: 'accepted and being prepared', ru: 'принят и собирается' },
  in_progress: { en: 'being prepared', ru: 'собирается' },
  unfulfilled: { en: 'accepted', ru: 'принят' },
  paid: { en: 'paid', ru: 'оплачен' },
  authorized: { en: 'payment being confirmed', ru: 'оплата подтверждается' },
  partially_paid: { en: 'partly paid', ru: 'оплачен частично' },
  shipped: { en: 'shipped', ru: 'отправлен' },
  fulfilled: { en: 'shipped', ru: 'отправлен' },
  partially_fulfilled: { en: 'partly shipped', ru: 'частично отправлен' },
  delivered: { en: 'delivered', ru: 'доставлен' },
  completed: { en: 'completed', ru: 'выполнен' },
  cancelled: { en: 'cancelled', ru: 'отменён' },
  canceled: { en: 'cancelled', ru: 'отменён' },
  refunded: { en: 'refunded', ru: 'деньги возвращены' },
  partially_refunded: { en: 'partly refunded', ru: 'деньги частично возвращены' },
  failed: { en: 'payment failed', ru: 'оплата не прошла' },
};

export function statusText(status: string, lang: 'en' | 'ru'): string {
  const key = status.trim().toLowerCase();
  return STATUS_TEXT[key]?.[lang] ?? key.replace(/[_-]+/g, ' ');
}

export function orderUpdateText(
  order: { number: string; status: string; trackingUrl: string | null; paymentUrl: string | null },
  lang: 'en' | 'ru',
): string {
  const number = order.number.startsWith('#') ? order.number : `#${order.number}`;
  const lines = [
    lang === 'ru'
      ? `Обновление по вашему заказу ${number}: ${statusText(order.status, 'ru')}.`
      : `Update on your order ${number}: ${statusText(order.status, 'en')}.`,
  ];
  if (order.trackingUrl) lines.push(lang === 'ru' ? `Отследить: ${order.trackingUrl}` : `Track it: ${order.trackingUrl}`);
  if (order.paymentUrl) lines.push(lang === 'ru' ? `Оплатить: ${order.paymentUrl}` : `Pay here: ${order.paymentUrl}`);
  return lines.join('\n');
}
