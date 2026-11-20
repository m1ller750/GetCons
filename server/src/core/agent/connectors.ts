import { createHmac, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { safeEqual } from '../../lib/crypto.js';

/**
 * Connections to the business's store, through which the agent works: Shopify (Admin API access
 * token of a custom app), WooCommerce (REST API keys) or any website that implements the small
 * signed JSON API described in the dashboard ("custom").
 */

export type StorePlatform = 'shopify' | 'woocommerce' | 'custom';
export const STORE_PLATFORMS = ['shopify', 'woocommerce', 'custom'] as const;

export interface Product {
  id: string;
  variantId: string | null;
  name: string;
  price: string | null;
  currency: string | null;
  inStock: boolean | null;
  url: string | null;
}

export interface OrderItem {
  name: string;
  quantity: number;
}

export interface Order {
  id: string;
  number: string;
  /** The platform's status code, e.g. "processing" (WooCommerce) or "FULFILLED" (Shopify). */
  status: string;
  total: string | null;
  currency: string | null;
  items: OrderItem[];
  email: string | null;
  phone: string | null;
  paymentUrl: string | null;
  trackingUrl: string | null;
  createdAt: string | null;
  /** Can still be cancelled (not shipped, completed or cancelled). */
  cancellable: boolean;
  /** Nothing more will happen to it: no more updates for the customer. */
  final: boolean;
}

export interface NewOrder {
  items: { productId: string; variantId?: string | null; quantity: number }[];
  customer: { name: string; phone?: string; email?: string; address?: string; city?: string };
  note?: string;
}

export interface RefundResult {
  id: string | null;
  amount: string | null;
  status: string;
}

export interface StoreConnector {
  readonly platform: StorePlatform;
  /** Checks the credentials; returns the store's name and currency. */
  verify(): Promise<{ name: string | null; currency: string | null }>;
  findProducts(query: string, limit: number): Promise<Product[]>;
  /** By the number customers see (or the store's id). */
  getOrder(ref: string): Promise<Order | null>;
  createOrder(order: NewOrder): Promise<Order>;
  cancelOrder(order: Order, reason: string): Promise<Order>;
  refund(order: Order, amount: number | null, reason: string): Promise<RefundResult>;
}

export type StoreCredentials =
  | { platform: 'shopify'; accessToken: string }
  | { platform: 'woocommerce'; consumerKey: string; consumerSecret: string }
  | { platform: 'custom'; secret: string };

export class StoreError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
  }
}

export interface ConnectorOptions {
  fetchImpl?: typeof fetch;
  /** DNS resolution for the public-address check (replaced in tests). */
  resolveHost?: (host: string) => Promise<string[]>;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Only public https addresses: owners type the store URL, so it must never reach the server's
// own network (cloud metadata, private services).
// ---------------------------------------------------------------------------

const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^22[4-9]\./, /^2[3-5]\d\./];

export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase();
  if (isIP(v) === 4) return PRIVATE_V4.some((r) => r.test(v));
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
}

const defaultResolve = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address);

export async function assertPublicHttpsUrl(raw: string, resolve = defaultResolve): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StoreError('The address is not a valid link');
  }
  if (url.protocol !== 'https:') throw new StoreError('The address must start with https://');
  if (url.username || url.password) throw new StoreError('Remove the login and password from the address');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home|corp)$/.test(host)) {
    throw new StoreError('The address must be a public website');
  }
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await resolve(host);
    } catch {
      throw new StoreError(`Could not find the website ${host}`);
    }
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new StoreError('The address must be a public website');
  return url;
}

interface HttpResult {
  status: number;
  body: unknown;
  text: string;
}

async function request(opts: ConnectorOptions, url: string, init: RequestInit): Promise<HttpResult> {
  await assertPublicHttpsUrl(url, opts.resolveHost);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 12_000);
  try {
    // No automatic redirects: a redirect could lead to an address that was never checked.
    const res = await (opts.fetchImpl ?? fetch)(url, { ...init, redirect: 'manual', signal: controller.signal });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (res.status >= 300 && res.status < 400) {
      throw new StoreError('The website redirected the request elsewhere: use its final address', res.status);
    }
    return { status: res.status, body, text };
  } catch (err) {
    if (err instanceof StoreError) throw err;
    if ((err as Error)?.name === 'AbortError') throw new StoreError('The store did not answer in time', 504);
    throw new StoreError(`Could not reach the store: ${(err as Error)?.message ?? 'network error'}`);
  } finally {
    clearTimeout(timer);
  }
}

const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const errorText = (body: unknown): string | null => {
  const b = body as { message?: unknown; error?: unknown } | null;
  return str(b?.message) ?? (typeof b?.error === 'string' ? b.error : null);
};

/** Strips "#" and spaces from what a customer typed as an order number. */
export function cleanOrderRef(ref: string): string {
  return ref.trim().replace(/^#+/, '').replace(/\s+/g, '').slice(0, 100);
}

const FINAL_STATUSES = new Set(['completed', 'cancelled', 'canceled', 'refunded', 'failed', 'trash', 'delivered', 'closed']);
const NOT_CANCELLABLE = new Set([...FINAL_STATUSES, 'shipped', 'fulfilled', 'partially_fulfilled', 'in_transit']);

// ---------------------------------------------------------------------------
// WooCommerce (REST API v3, keys from WooCommerce → Settings → Advanced → REST API)
// ---------------------------------------------------------------------------

interface WooProduct {
  id: number;
  name: string;
  type?: string;
  price?: string;
  stock_status?: string;
  permalink?: string;
}
interface WooVariation {
  id: number;
  price?: string;
  stock_status?: string;
  permalink?: string;
  attributes?: { name?: string; option?: string }[];
}
interface WooOrder {
  id: number;
  number?: string;
  status: string;
  total?: string;
  currency?: string;
  date_created?: string;
  payment_url?: string;
  billing?: { email?: string; phone?: string };
  line_items?: { name?: string; quantity?: number }[];
}

export class WooCommerceConnector implements StoreConnector {
  readonly platform = 'woocommerce' as const;
  private readonly auth: string;

  constructor(
    private readonly base: string,
    creds: { consumerKey: string; consumerSecret: string },
    private readonly opts: ConnectorOptions = {},
  ) {
    this.auth = `Basic ${Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString('base64')}`;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await request(this.opts, `${this.base}/wp-json/wc/v3${path}`, {
      method,
      headers: { authorization: this.auth, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (r.status === 401 || r.status === 403) {
      throw new StoreError('WooCommerce rejected the API keys (create keys with Read/Write access)', r.status);
    }
    if (r.status === 404 && /rest_no_route/.test(r.text)) throw new StoreError('WooCommerce REST API was not found at this address', 404);
    if (r.status >= 300) throw new StoreError(`WooCommerce: ${errorText(r.body) ?? `error ${r.status}`}`, r.status);
    return r.body as T;
  }

  async verify() {
    const currency = await this.call<{ code?: string }>('GET', '/data/currencies/current');
    let name: string | null = null;
    try {
      const root = await request(this.opts, `${this.base}/wp-json/`, { method: 'GET', headers: { accept: 'application/json' } });
      name = str((root.body as { name?: string } | null)?.name);
    } catch {
      /* the name is optional */
    }
    return { name, currency: str(currency?.code) };
  }

  async findProducts(query: string, limit: number): Promise<Product[]> {
    const list = await this.call<WooProduct[]>('GET', `/products?search=${encodeURIComponent(query)}&per_page=${limit}&status=publish`);
    const out: Product[] = [];
    for (const p of Array.isArray(list) ? list : []) {
      if (p.type === 'variable') {
        const variations = await this.call<WooVariation[]>('GET', `/products/${p.id}/variations?per_page=10`).catch(() => []);
        for (const v of Array.isArray(variations) ? variations : []) {
          const options = (v.attributes ?? []).map((a) => a.option).filter(Boolean).join(', ');
          out.push({
            id: String(p.id),
            variantId: String(v.id),
            name: options ? `${p.name} (${options})` : p.name,
            price: str(v.price),
            currency: null,
            inStock: v.stock_status ? v.stock_status === 'instock' : null,
            url: str(v.permalink) ?? str(p.permalink),
          });
        }
        if (Array.isArray(variations) && variations.length) continue;
      }
      out.push({
        id: String(p.id),
        variantId: null,
        name: p.name,
        price: str(p.price),
        currency: null,
        inStock: p.stock_status ? p.stock_status === 'instock' : null,
        url: str(p.permalink),
      });
    }
    return out;
  }

  private toOrder(o: WooOrder): Order {
    const status = (o.status ?? 'unknown').toLowerCase();
    return {
      id: String(o.id),
      number: String(o.number ?? o.id),
      status,
      total: str(o.total),
      currency: str(o.currency),
      items: (o.line_items ?? []).map((i) => ({ name: i.name ?? '', quantity: Number(i.quantity ?? 1) })),
      email: str(o.billing?.email),
      phone: str(o.billing?.phone),
      paymentUrl: status === 'pending' ? str(o.payment_url) : null,
      trackingUrl: null,
      createdAt: str(o.date_created),
      cancellable: ['pending', 'on-hold', 'processing'].includes(status),
      final: FINAL_STATUSES.has(status),
    };
  }

  async getOrder(ref: string): Promise<Order | null> {
    const id = cleanOrderRef(ref);
    if (!id) return null;
    if (/^\d+$/.test(id)) {
      try {
        return this.toOrder(await this.call<WooOrder>('GET', `/orders/${id}`));
      } catch (err) {
        if (!(err instanceof StoreError && err.status === 404)) throw err;
      }
    }
    const list = await this.call<WooOrder[]>('GET', `/orders?search=${encodeURIComponent(id)}&per_page=5`);
    const hit = (Array.isArray(list) ? list : []).find((o) => String(o.number ?? o.id) === id || String(o.id) === id);
    return hit ? this.toOrder(hit) : null;
  }

  async createOrder(order: NewOrder): Promise<Order> {
    const [first = '', ...rest] = order.customer.name.trim().split(/\s+/);
    const address = {
      first_name: first,
      last_name: rest.join(' '),
      address_1: order.customer.address ?? '',
      city: order.customer.city ?? '',
    };
    const lineItems = order.items.map((i) => {
      if (!/^\d+$/.test(i.productId) || (i.variantId && !/^\d+$/.test(i.variantId))) {
        throw new StoreError(`Unknown product id ${i.productId}`);
      }
      return { product_id: Number(i.productId), ...(i.variantId ? { variation_id: Number(i.variantId) } : {}), quantity: i.quantity };
    });
    const created = await this.call<WooOrder>('POST', '/orders', {
      status: 'pending',
      set_paid: false,
      billing: { ...address, phone: order.customer.phone ?? '', ...(order.customer.email ? { email: order.customer.email } : {}) },
      shipping: address,
      line_items: lineItems,
      customer_note: order.note ?? '',
      meta_data: [{ key: '_getcons_agent', value: 'yes' }],
    });
    return this.toOrder(created);
  }

  async cancelOrder(order: Order): Promise<Order> {
    return this.toOrder(await this.call<WooOrder>('PUT', `/orders/${encodeURIComponent(order.id)}`, { status: 'cancelled' }));
  }

  async refund(order: Order, amount: number | null, reason: string): Promise<RefundResult> {
    const value = (amount ?? Number(order.total ?? 0)).toFixed(2);
    // api_refund: the money goes back through the payment gateway, not just a note in the order.
    const r = await this.call<{ id?: number; amount?: string }>('POST', `/orders/${encodeURIComponent(order.id)}/refunds`, {
      amount: value,
      reason: reason.slice(0, 500),
      api_refund: true,
    });
    return { id: r?.id ? String(r.id) : null, amount: str(r?.amount) ?? value, status: 'refunded' };
  }
}

// ---------------------------------------------------------------------------
// Shopify (Admin GraphQL API; access token of a custom app made in the store's admin)
// ---------------------------------------------------------------------------

export const SHOPIFY_API_VERSION = '2026-01';

/** "mystore", "mystore.myshopify.com" or a link to it → "https://mystore.myshopify.com". */
export function shopifyBaseUrl(input: string): string {
  let host = input.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0] ?? '';
  if (/^[a-z0-9][a-z0-9-]*$/.test(host)) host = `${host}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(host)) {
    throw new StoreError('Use the store address that ends with .myshopify.com (Shopify admin → Settings → Domains)');
  }
  return `https://${host}`;
}

interface ShopifyMoney {
  shopMoney?: { amount?: string; currencyCode?: string };
}
interface ShopifyOrderNode {
  id: string;
  name: string;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  cancelledAt?: string | null;
  createdAt?: string | null;
  email?: string | null;
  phone?: string | null;
  statusPageUrl?: string | null;
  totalPriceSet?: ShopifyMoney;
  lineItems?: { nodes?: { title?: string; quantity?: number }[] };
  fulfillments?: { trackingInfo?: { number?: string | null; url?: string | null }[] }[];
}
interface ShopifyDraftNode {
  id: string;
  name: string;
  status?: string;
  invoiceUrl?: string | null;
  createdAt?: string | null;
  email?: string | null;
  phone?: string | null;
  totalPriceSet?: ShopifyMoney;
  lineItems?: { nodes?: { title?: string; quantity?: number }[] };
  order?: { id: string } | null;
}

const ORDER_FIELDS = `id name displayFinancialStatus displayFulfillmentStatus cancelledAt createdAt email phone statusPageUrl
  totalPriceSet { shopMoney { amount currencyCode } }
  lineItems(first: 20) { nodes { title quantity } }
  fulfillments(first: 5) { trackingInfo(first: 3) { number url } }`;
const DRAFT_FIELDS = `id name status invoiceUrl createdAt email phone
  totalPriceSet { shopMoney { amount currencyCode } }
  lineItems(first: 20) { nodes { title quantity } }
  order { id }`;

export class ShopifyConnector implements StoreConnector {
  readonly platform = 'shopify' as const;
  private readonly base: string;

  constructor(
    storeUrl: string,
    private readonly accessToken: string,
    private readonly opts: ConnectorOptions = {},
  ) {
    this.base = shopifyBaseUrl(storeUrl);
  }

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const r = await request(this.opts, `${this.base}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-shopify-access-token': this.accessToken },
      body: JSON.stringify({ query, variables }),
    });
    if (r.status === 401 || r.status === 403) throw new StoreError('Shopify rejected the access token', r.status);
    if (r.status === 404) throw new StoreError('Shopify store not found at this address', 404);
    if (r.status >= 300) throw new StoreError(`Shopify: ${errorText(r.body) ?? `error ${r.status}`}`, r.status);
    const body = r.body as { data?: T; errors?: { message?: string }[] | string } | null;
    if (body?.errors) {
      const first = Array.isArray(body.errors) ? body.errors[0]?.message : body.errors;
      throw new StoreError(`Shopify: ${first ?? 'request failed'}`);
    }
    return (body?.data ?? {}) as T;
  }

  private static userErrors(errors: { message?: string }[] | undefined) {
    if (errors?.length) throw new StoreError(`Shopify: ${errors.map((e) => e.message).join('; ')}`);
  }

  async verify() {
    const d = await this.gql<{ shop?: { name?: string; currencyCode?: string } }>('{ shop { name currencyCode } }');
    if (!d.shop) throw new StoreError('Shopify did not return the shop');
    return { name: str(d.shop.name), currency: str(d.shop.currencyCode) };
  }

  async findProducts(query: string, limit: number): Promise<Product[]> {
    const d = await this.gql<{
      products?: {
        nodes?: {
          id: string;
          title: string;
          onlineStoreUrl?: string | null;
          variants?: { nodes?: { id: string; title?: string; price?: string; availableForSale?: boolean }[] };
        }[];
      };
    }>(
      `query($q: String!, $n: Int!) { products(first: $n, query: $q) { nodes { id title onlineStoreUrl
        variants(first: 10) { nodes { id title price availableForSale } } } } }`,
      { q: `${query.replace(/["\\]/g, ' ')} status:active`, n: limit },
    );
    const out: Product[] = [];
    for (const p of d.products?.nodes ?? []) {
      for (const v of p.variants?.nodes ?? []) {
        out.push({
          id: p.id,
          variantId: v.id,
          name: !v.title || v.title === 'Default Title' ? p.title : `${p.title} (${v.title})`,
          price: str(v.price),
          currency: null,
          inStock: typeof v.availableForSale === 'boolean' ? v.availableForSale : null,
          url: str(p.onlineStoreUrl),
        });
      }
    }
    return out;
  }

  private toOrder(o: ShopifyOrderNode): Order {
    const financial = (o.displayFinancialStatus ?? '').toUpperCase();
    const fulfillment = (o.displayFulfillmentStatus ?? '').toUpperCase();
    const status = o.cancelledAt
      ? 'CANCELLED'
      : financial === 'REFUNDED'
        ? 'REFUNDED'
        : ['FULFILLED', 'PARTIALLY_FULFILLED', 'IN_PROGRESS'].includes(fulfillment)
          ? fulfillment
          : financial || fulfillment || 'OPEN';
    const tracking = (o.fulfillments ?? []).flatMap((f) => f.trackingInfo ?? []).find((t) => t.url);
    return {
      id: o.id,
      number: o.name,
      status,
      total: str(o.totalPriceSet?.shopMoney?.amount),
      currency: str(o.totalPriceSet?.shopMoney?.currencyCode),
      items: (o.lineItems?.nodes ?? []).map((i) => ({ name: i.title ?? '', quantity: Number(i.quantity ?? 1) })),
      email: str(o.email),
      phone: str(o.phone),
      paymentUrl: null,
      trackingUrl: str(tracking?.url) ?? (['FULFILLED', 'PARTIALLY_FULFILLED'].includes(status) ? str(o.statusPageUrl) : null),
      createdAt: str(o.createdAt),
      cancellable: !o.cancelledAt && !['FULFILLED', 'PARTIALLY_FULFILLED', 'IN_PROGRESS', 'REFUNDED'].includes(status),
      final: status === 'CANCELLED' || status === 'REFUNDED' || status === 'FULFILLED',
    };
  }

  private draftToOrder(d: ShopifyDraftNode): Order {
    const open = (d.status ?? 'OPEN').toUpperCase() !== 'COMPLETED';
    return {
      id: d.id,
      number: d.name,
      status: open ? 'OPEN' : 'COMPLETED',
      total: str(d.totalPriceSet?.shopMoney?.amount),
      currency: str(d.totalPriceSet?.shopMoney?.currencyCode),
      items: (d.lineItems?.nodes ?? []).map((i) => ({ name: i.title ?? '', quantity: Number(i.quantity ?? 1) })),
      email: str(d.email),
      phone: str(d.phone),
      paymentUrl: open ? str(d.invoiceUrl) : null,
      trackingUrl: null,
      createdAt: str(d.createdAt),
      cancellable: open,
      final: false,
    };
  }

  async getOrder(ref: string): Promise<Order | null> {
    if (ref.startsWith('gid://shopify/DraftOrder/')) {
      const d = await this.gql<{ draftOrder?: ShopifyDraftNode | null }>(`query($id: ID!) { draftOrder(id: $id) { ${DRAFT_FIELDS} } }`, { id: ref });
      if (!d.draftOrder) return null;
      // Paid draft orders become real orders: follow them from then on.
      if (d.draftOrder.order?.id) return this.getOrder(d.draftOrder.order.id);
      return this.draftToOrder(d.draftOrder);
    }
    if (ref.startsWith('gid://shopify/Order/')) {
      const d = await this.gql<{ order?: ShopifyOrderNode | null }>(`query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id: ref });
      return d.order ? this.toOrder(d.order) : null;
    }
    const number = cleanOrderRef(ref);
    if (!number) return null;
    for (const q of [`name:#${number}`, `name:${number}`]) {
      const d = await this.gql<{ orders?: { nodes?: ShopifyOrderNode[] } }>(
        `query($q: String!) { orders(first: 1, query: $q) { nodes { ${ORDER_FIELDS} } } }`,
        { q },
      );
      const hit = d.orders?.nodes?.[0];
      if (hit) return this.toOrder(hit);
    }
    return null;
  }

  private async firstVariant(productId: string): Promise<string> {
    const d = await this.gql<{ product?: { variants?: { nodes?: { id: string }[] } } | null }>(
      'query($id: ID!) { product(id: $id) { variants(first: 1) { nodes { id } } } }',
      { id: productId },
    );
    const id = d.product?.variants?.nodes?.[0]?.id;
    if (!id) throw new StoreError(`Unknown product ${productId}`);
    return id;
  }

  /** A draft order with an invoice link: the customer pays on Shopify's checkout, then it becomes an order. */
  async createOrder(order: NewOrder): Promise<Order> {
    const lineItems = [];
    for (const i of order.items) {
      lineItems.push({ variantId: i.variantId || (await this.firstVariant(i.productId)), quantity: i.quantity });
    }
    const [firstName = '', ...rest] = order.customer.name.trim().split(/\s+/);
    const input: Record<string, unknown> = {
      lineItems,
      note: [order.note, 'Placed by the GetCons agent in a customer chat'].filter(Boolean).join('\n'),
      tags: ['GetCons'],
      ...(order.customer.email ? { email: order.customer.email } : {}),
    };
    if (order.customer.address || order.customer.city) {
      input.shippingAddress = {
        firstName,
        lastName: rest.join(' ') || firstName,
        address1: order.customer.address ?? '',
        city: order.customer.city ?? '',
        ...(order.customer.phone ? { phone: order.customer.phone } : {}),
      };
    }
    const d = await this.gql<{ draftOrderCreate?: { draftOrder?: ShopifyDraftNode | null; userErrors?: { message?: string }[] } }>(
      `mutation($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { ${DRAFT_FIELDS} } userErrors { field message } } }`,
      { input },
    );
    ShopifyConnector.userErrors(d.draftOrderCreate?.userErrors);
    const draft = d.draftOrderCreate?.draftOrder;
    if (!draft) throw new StoreError('Shopify did not create the order');
    return { ...this.draftToOrder(draft), phone: order.customer.phone ?? null };
  }

  async cancelOrder(order: Order, reason: string): Promise<Order> {
    if (order.id.startsWith('gid://shopify/DraftOrder/')) {
      const d = await this.gql<{ draftOrderDelete?: { userErrors?: { message?: string }[] } }>(
        'mutation($input: DraftOrderDeleteInput!) { draftOrderDelete(input: $input) { deletedId userErrors { field message } } }',
        { input: { id: order.id } },
      );
      ShopifyConnector.userErrors(d.draftOrderDelete?.userErrors);
    } else {
      const d = await this.gql<{ orderCancel?: { orderCancelUserErrors?: { message?: string }[] } }>(
        `mutation($id: ID!, $note: String) { orderCancel(orderId: $id, reason: CUSTOMER, refund: true, restock: true, notifyCustomer: true, staffNote: $note) {
          job { id } orderCancelUserErrors { field message } } }`,
        { id: order.id, note: reason.slice(0, 250) },
      );
      ShopifyConnector.userErrors(d.orderCancel?.orderCancelUserErrors);
    }
    return { ...order, status: 'CANCELLED', cancellable: false, final: true, paymentUrl: null };
  }

  async refund(order: Order, amount: number | null, reason: string): Promise<RefundResult> {
    const d = await this.gql<{
      order?: { transactions?: { id: string; kind?: string; status?: string; gateway?: string; amountSet?: ShopifyMoney }[] } | null;
    }>('query($id: ID!) { order(id: $id) { transactions(first: 20) { id kind status gateway amountSet { shopMoney { amount currencyCode } } } } }', {
      id: order.id,
    });
    const paid = (d.order?.transactions ?? [])
      .filter((t) => ['SALE', 'CAPTURE'].includes((t.kind ?? '').toUpperCase()) && (t.status ?? '').toUpperCase() === 'SUCCESS')
      .sort((a, b) => Number(b.amountSet?.shopMoney?.amount ?? 0) - Number(a.amountSet?.shopMoney?.amount ?? 0))[0];
    if (!paid) throw new StoreError('This order has no completed payment to refund');
    const max = Number(paid.amountSet?.shopMoney?.amount ?? 0);
    const value = Math.min(amount ?? Number(order.total ?? max), max).toFixed(2);
    const r = await this.gql<{
      refundCreate?: { refund?: { id: string; totalRefundedSet?: ShopifyMoney } | null; userErrors?: { message?: string }[] };
    }>(
      `mutation($input: RefundInput!) { refundCreate(input: $input) { refund { id totalRefundedSet { shopMoney { amount } } } userErrors { field message } } }`,
      {
        input: {
          orderId: order.id,
          note: reason.slice(0, 250),
          notify: true,
          transactions: [{ orderId: order.id, parentId: paid.id, gateway: paid.gateway, kind: 'REFUND', amount: value }],
        },
      },
    );
    ShopifyConnector.userErrors(r.refundCreate?.userErrors);
    return { id: str(r.refundCreate?.refund?.id), amount: str(r.refundCreate?.refund?.totalRefundedSet?.shopMoney?.amount) ?? value, status: 'refunded' };
  }
}

// ---------------------------------------------------------------------------
// Any website: one HTTPS endpoint that answers signed JSON requests (contract in the dashboard)
// ---------------------------------------------------------------------------

/** HMAC-SHA256 of "<timestamp>.<body>", hex, prefixed "sha256=" (as in the X-GetCons-Signature header). */
export function signPayload(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Checks a signed request from the business's site (notifications), allowing 5 minutes of clock skew. */
export function verifySignature(secret: string, timestamp: string | undefined, body: string, signature: string | undefined, now = Date.now()): boolean {
  if (!timestamp || !signature || !/^\d{9,11}$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  return safeEqual(signature, signPayload(secret, timestamp, body));
}

function toCustomOrder(raw: unknown): Order {
  const o = (raw ?? {}) as Record<string, unknown>;
  const status = String(o.status ?? 'unknown');
  const lower = status.toLowerCase();
  const id = str(o.id) ?? str(o.number);
  if (!id) throw new StoreError("The site's API returned an order without an id");
  return {
    id,
    number: str(o.number) ?? id,
    status,
    total: str(o.total),
    currency: str(o.currency),
    items: Array.isArray(o.items)
      ? o.items.map((i) => ({ name: String((i as { name?: unknown }).name ?? ''), quantity: Number((i as { quantity?: unknown }).quantity ?? 1) }))
      : [],
    email: str(o.email ?? o.customer_email),
    phone: str(o.phone ?? o.customer_phone),
    paymentUrl: str(o.payment_url),
    trackingUrl: str(o.tracking_url),
    createdAt: str(o.created_at),
    cancellable: typeof o.cancellable === 'boolean' ? o.cancellable : !NOT_CANCELLABLE.has(lower),
    final: typeof o.final === 'boolean' ? o.final : FINAL_STATUSES.has(lower),
  };
}

export class CustomApiConnector implements StoreConnector {
  readonly platform = 'custom' as const;

  constructor(
    private readonly endpoint: string,
    private readonly secret: string,
    private readonly opts: ConnectorOptions = {},
  ) {}

  private async call(action: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ action, params, request_id: randomUUID(), timestamp: Number(timestamp) });
    const r = await request(this.opts, this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-getcons-timestamp': timestamp,
        'x-getcons-signature': signPayload(this.secret, timestamp, body),
      },
      body,
    });
    const data = r.body as Record<string, unknown> | null;
    if (r.status >= 300) throw new StoreError(`The site's API answered ${r.status}${errorText(data) ? `: ${errorText(data)}` : ''}`, r.status);
    if (!data || typeof data !== 'object') throw new StoreError("The site's API did not return JSON");
    if (data.ok === false) throw new StoreError(String(data.error ?? 'The site refused the request'));
    return data;
  }

  async verify() {
    const d = await this.call('ping', {});
    return { name: str(d.name), currency: str(d.currency) };
  }

  async findProducts(query: string, limit: number): Promise<Product[]> {
    const d = await this.call('find_products', { query, limit });
    return (Array.isArray(d.products) ? d.products : []).slice(0, limit * 3).map((raw) => {
      const p = raw as Record<string, unknown>;
      return {
        id: String(p.id ?? ''),
        variantId: str(p.variant_id),
        name: String(p.name ?? ''),
        price: str(p.price),
        currency: str(p.currency),
        inStock: typeof p.in_stock === 'boolean' ? p.in_stock : null,
        url: str(p.url),
      };
    });
  }

  async getOrder(ref: string): Promise<Order | null> {
    const d = await this.call('get_order', { order: cleanOrderRef(ref) || ref });
    return d.order ? toCustomOrder(d.order) : null;
  }

  async createOrder(order: NewOrder): Promise<Order> {
    const d = await this.call('create_order', {
      items: order.items.map((i) => ({ product_id: i.productId, variant_id: i.variantId ?? null, quantity: i.quantity })),
      customer: order.customer,
      note: order.note ?? '',
    });
    return toCustomOrder(d.order);
  }

  async cancelOrder(order: Order, reason: string): Promise<Order> {
    const d = await this.call('cancel_order', { order_id: order.id, reason });
    return d.order ? toCustomOrder(d.order) : { ...order, status: 'cancelled', cancellable: false, final: true };
  }

  async refund(order: Order, amount: number | null, reason: string): Promise<RefundResult> {
    const d = await this.call('refund', { order_id: order.id, amount, reason });
    const r = (d.refund ?? {}) as Record<string, unknown>;
    return { id: str(r.id), amount: str(r.amount) ?? (amount === null ? order.total : amount.toFixed(2)), status: String(r.status ?? 'refunded') };
  }
}

/** Normalises the address the owner typed (adds https://, drops a trailing slash). */
export function normalizeStoreUrl(platform: StorePlatform, input: string): string {
  const raw = input.trim();
  if (platform === 'shopify') return shopifyBaseUrl(raw);
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new StoreError('The address is not a valid link');
  }
  if (url.protocol !== 'https:') throw new StoreError('The address must start with https://');
  if (platform === 'woocommerce') return `${url.origin}${url.pathname.replace(/\/(wp-json.*)?$/, '').replace(/\/+$/, '')}`;
  return url.toString();
}

export function createConnector(platform: StorePlatform, storeUrl: string, creds: StoreCredentials, opts: ConnectorOptions = {}): StoreConnector {
  if (platform !== creds.platform) throw new StoreError('The credentials are for another platform');
  if (creds.platform === 'shopify') return new ShopifyConnector(storeUrl, creds.accessToken, opts);
  if (creds.platform === 'woocommerce') return new WooCommerceConnector(storeUrl, creds, opts);
  return new CustomApiConnector(storeUrl, creds.secret, opts);
}
