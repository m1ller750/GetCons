import { describe, expect, it } from 'vitest';
import {
  assertPublicHttpsUrl,
  CustomApiConnector,
  isPrivateAddress,
  normalizeStoreUrl,
  shopifyBaseUrl,
  ShopifyConnector,
  signPayload,
  verifySignature,
  WooCommerceConnector,
} from '../src/core/agent/connectors.js';

type Call = { url: string; init: RequestInit };

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const publicDns = async () => ['93.184.216.34'];

describe('store addresses', () => {
  it('reaches only public https websites', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    await expect(assertPublicHttpsUrl('http://shop.example.com', publicDns)).rejects.toThrow(/https/);
    await expect(assertPublicHttpsUrl('https://localhost/x', publicDns)).rejects.toThrow(/public/);
    await expect(assertPublicHttpsUrl('https://db.railway.internal', publicDns)).rejects.toThrow(/public/);
    await expect(assertPublicHttpsUrl('https://169.254.169.254/latest', publicDns)).rejects.toThrow(/public/);
    await expect(assertPublicHttpsUrl('https://evil.example.com', async () => ['10.0.0.5'])).rejects.toThrow(/public/);
    await expect(assertPublicHttpsUrl('https://user:pw@shop.example.com', publicDns)).rejects.toThrow(/password/);
    expect((await assertPublicHttpsUrl('https://shop.example.com/api', publicDns)).hostname).toBe('shop.example.com');
  });

  it('normalises what owners type', () => {
    expect(shopifyBaseUrl('My-Store')).toBe('https://my-store.myshopify.com');
    expect(shopifyBaseUrl('https://my-store.myshopify.com/admin/products')).toBe('https://my-store.myshopify.com');
    expect(() => shopifyBaseUrl('flowers.kz')).toThrow(/myshopify/);
    expect(normalizeStoreUrl('woocommerce', 'flowers.kz/')).toBe('https://flowers.kz');
    expect(normalizeStoreUrl('woocommerce', 'https://flowers.kz/shop/wp-json/wc/v3')).toBe('https://flowers.kz/shop');
    expect(() => normalizeStoreUrl('custom', 'http://flowers.kz/api')).toThrow(/https/);
    expect(normalizeStoreUrl('custom', 'https://flowers.kz/api/getcons')).toBe('https://flowers.kz/api/getcons');
  });
});

describe('WooCommerce', () => {
  const creds = { consumerKey: 'ck_123', consumerSecret: 'cs_456' };

  it('authenticates with the REST API keys and maps orders', async () => {
    const { calls, fetchImpl } = fakeFetch((url) => {
      if (url.endsWith('/data/currencies/current')) return { body: { code: 'KZT' } };
      if (url.endsWith('/wp-json/')) return { body: { name: 'Flowers KZ' } };
      if (url.includes('/orders/1024')) {
        return {
          body: { id: 1024, number: '1024', status: 'pending', total: '15000.00', currency: 'KZT', payment_url: 'https://flowers.kz/pay/1024', billing: { email: 'm@x.kz', phone: '+77015551234' }, line_items: [{ name: 'Roses', quantity: 3 }] },
        };
      }
      return { status: 404, body: { code: 'woocommerce_rest_shop_order_invalid_id', message: 'Invalid ID.' } };
    });
    const woo = new WooCommerceConnector('https://flowers.kz', creds, { fetchImpl, resolveHost: publicDns });
    expect(await woo.verify()).toEqual({ name: 'Flowers KZ', currency: 'KZT' });
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe(`Basic ${Buffer.from('ck_123:cs_456').toString('base64')}`);
    expect(calls[0]!.init.redirect).toBe('manual');

    const order = await woo.getOrder('#1024');
    expect(order).toMatchObject({ id: '1024', number: '1024', status: 'pending', total: '15000.00', paymentUrl: 'https://flowers.kz/pay/1024', cancellable: true, final: false });
  });

  it('creates pending orders, cancels and refunds through the payment gateway', async () => {
    const { calls, fetchImpl } = fakeFetch((url, init) => {
      if (url.endsWith('/orders') && init.method === 'POST') return { body: { id: 77, number: '77', status: 'pending', total: '90.00', currency: 'USD' } };
      if (url.endsWith('/orders/77') && init.method === 'PUT') return { body: { id: 77, status: 'cancelled' } };
      if (url.endsWith('/orders/77/refunds')) return { body: { id: 5, amount: '20.00' } };
      return { status: 500, body: {} };
    });
    const woo = new WooCommerceConnector('https://flowers.kz', creds, { fetchImpl, resolveHost: publicDns });
    const order = await woo.createOrder({ items: [{ productId: '11', variantId: '15', quantity: 2 }], customer: { name: 'Maria Ivanova', phone: '+7701', address: 'Abay 10', city: 'Almaty' }, note: 'evening' });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({
      status: 'pending',
      set_paid: false,
      billing: { first_name: 'Maria', last_name: 'Ivanova', phone: '+7701', address_1: 'Abay 10', city: 'Almaty' },
      line_items: [{ product_id: 11, variation_id: 15, quantity: 2 }],
      customer_note: 'evening',
    });
    expect(order.number).toBe('77');
    expect((await woo.cancelOrder(order)).status).toBe('cancelled');
    expect(await woo.refund(order, 20, 'wilted')).toEqual({ id: '5', amount: '20.00', status: 'refunded' });
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ amount: '20.00', reason: 'wilted', api_refund: true });
    await expect(woo.createOrder({ items: [{ productId: 'gid://x', quantity: 1 }], customer: { name: 'x' } })).rejects.toThrow(/Unknown product/);
  });

  it('explains rejected keys', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 401, body: { code: 'woocommerce_rest_cannot_view' } }));
    const woo = new WooCommerceConnector('https://flowers.kz', creds, { fetchImpl, resolveHost: publicDns });
    await expect(woo.verify()).rejects.toThrow(/rejected the API keys/);
  });
});

describe('Shopify', () => {
  it('uses the Admin GraphQL API with the access token and invoices draft orders', async () => {
    const { calls, fetchImpl } = fakeFetch((_url, init) => {
      const q = JSON.parse(String(init.body)).query as string;
      if (q.includes('shop {')) return { body: { data: { shop: { name: 'Bloom', currencyCode: 'USD' } } } };
      if (q.includes('draftOrderCreate')) {
        return {
          body: { data: { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/9', name: '#D9', status: 'OPEN', invoiceUrl: 'https://bloom.myshopify.com/inv/9', totalPriceSet: { shopMoney: { amount: '50.0', currencyCode: 'USD' } }, lineItems: { nodes: [{ title: 'Roses', quantity: 1 }] } }, userErrors: [] } } },
        };
      }
      return { body: { errors: [{ message: 'unexpected' }] } };
    });
    const shop = new ShopifyConnector('bloom', 'shpat_test', { fetchImpl, resolveHost: publicDns });
    expect(await shop.verify()).toEqual({ name: 'Bloom', currency: 'USD' });
    expect(calls[0]!.url).toMatch(/^https:\/\/bloom\.myshopify\.com\/admin\/api\/\d{4}-\d{2}\/graphql\.json$/);
    expect(new Headers(calls[0]!.init.headers).get('x-shopify-access-token')).toBe('shpat_test');

    const order = await shop.createOrder({ items: [{ productId: 'gid://shopify/Product/1', variantId: 'gid://shopify/ProductVariant/2', quantity: 1 }], customer: { name: 'Ann', phone: '+1555' } });
    expect(order).toMatchObject({ id: 'gid://shopify/DraftOrder/9', number: '#D9', paymentUrl: 'https://bloom.myshopify.com/inv/9', total: '50.0', status: 'OPEN' });
    const input = JSON.parse(String(calls[1]!.init.body)).variables.input;
    expect(input).toMatchObject({ lineItems: [{ variantId: 'gid://shopify/ProductVariant/2', quantity: 1 }], tags: ['GetCons'] });
    await expect(shop.getOrder('1001')).rejects.toThrow(/Shopify: unexpected/);
  });
});

describe('any website (signed JSON API)', () => {
  it('signs every request and reads the documented answers', async () => {
    const secret = 'gcs_secret';
    const { calls, fetchImpl } = fakeFetch((_url, init) => {
      const body = String(init.body);
      const h = new Headers(init.headers);
      if (!verifySignature(secret, h.get('x-getcons-timestamp') ?? undefined, body, h.get('x-getcons-signature') ?? undefined)) {
        return { status: 401, body: { ok: false, error: 'bad signature' } };
      }
      const { action } = JSON.parse(body);
      if (action === 'ping') return { body: { ok: true, name: 'My site', currency: 'EUR' } };
      if (action === 'get_order') return { body: { ok: true, order: { id: 'A1', number: '501', status: 'shipped', total: 12.5, tracking_url: 'https://track/1' } } };
      if (action === 'cancel_order') return { body: { ok: false, error: 'Already shipped' } };
      return { body: { ok: true, products: [] } };
    });
    const api = new CustomApiConnector('https://my.site/getcons', secret, { fetchImpl, resolveHost: publicDns });
    expect(await api.verify()).toEqual({ name: 'My site', currency: 'EUR' });
    const order = await api.getOrder('#501');
    expect(order).toMatchObject({ id: 'A1', number: '501', status: 'shipped', total: '12.5', trackingUrl: 'https://track/1', cancellable: false, final: false });
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({ action: 'get_order', params: { order: '501' } });
    await expect(api.cancelOrder(order!, 'changed mind')).rejects.toThrow('Already shipped');
  });

  it('rejects forged or stale signatures', () => {
    const now = Date.now();
    const ts = String(Math.floor(now / 1000));
    const sig = signPayload('s', ts, '{}');
    expect(verifySignature('s', ts, '{}', sig, now)).toBe(true);
    expect(verifySignature('s', ts, '{"x":1}', sig, now)).toBe(false);
    expect(verifySignature('other', ts, '{}', sig, now)).toBe(false);
    expect(verifySignature('s', ts, '{}', sig, now + 10 * 60_000)).toBe(false);
    expect(verifySignature('s', undefined, '{}', sig, now)).toBe(false);
  });
});
