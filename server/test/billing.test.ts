import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Billing } from '../src/core/billing.js';
import { effectivePlan, PLANS } from '../src/core/plans.js';
import { silentLogger } from '../src/lib/logger.js';
import type { SupabaseClient } from '../src/lib/supabase.js';
import { parseFlatXml, signParams, verifyParams } from '../src/services/freedompay.js';
import { testConfig } from './helpers/fakes.js';

const SECRET = 'test-secret-key';
const PAYMENT_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/** Just enough of supabase-js for Billing: payments lookup/update and the activate_payment RPC. */
function fakeAdmin(payment: Record<string, unknown>) {
  const calls = { activated: 0, updates: [] as Record<string, unknown>[] };
  const builder = () => {
    const q = {
      select: () => q,
      eq: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: payment, error: null }),
      update: (patch: Record<string, unknown>) => {
        calls.updates.push(patch);
        return q;
      },
      then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
    };
    return q;
  };
  const admin = {
    from: () => builder(),
    rpc: async (name: string) => {
      if (name === 'activate_payment') calls.activated++;
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;
  return { admin, calls };
}

function billingWith(payment: Record<string, unknown>, testing = false) {
  const config = testConfig({
    publicUrl: 'https://getcons.test',
    billing: { freedomPay: { merchantId: '123', secretKey: SECRET, apiUrl: 'https://api.freedompay.test', testing } },
  });
  const fake = fakeAdmin(payment);
  return { billing: new Billing({ admin: fake.admin, config, logger: silentLogger() }), calls: fake.calls };
}

function notification(overrides: Record<string, string> = {}, secret = SECRET) {
  const params: Record<string, string> = {
    pg_order_id: PAYMENT_ID,
    pg_payment_id: '987654',
    pg_amount: '49',
    pg_currency: 'USD',
    pg_result: '1',
    pg_testing_mode: '0',
    pg_salt: 'abc',
    ...overrides,
  };
  params.pg_sig = signParams('result', params, secret);
  return params;
}

const pending = { id: PAYMENT_ID, user_id: 'u1', plan: 'business', amount: '49.00', currency: 'USD', status: 'pending' };

describe('Freedom Pay signatures', () => {
  it('matches the documented example: script;values sorted by key;secret', () => {
    const params = { pg_order_id: '23', pg_merchant_id: '777', pg_amount: '25', pg_salt: 'molbulak', pg_description: 'test' };
    const expected = createHash('md5').update('init_payment.php;25;test;777;23;molbulak;secret').digest('hex');
    expect(signParams('init_payment.php', params, 'secret')).toBe(expected);
    expect(verifyParams('init_payment.php', { ...params, pg_sig: expected }, 'secret')).toBe(true);
    expect(verifyParams('init_payment.php', { ...params, pg_amount: '1', pg_sig: expected }, 'secret')).toBe(false);
  });

  it('reads flat XML replies', () => {
    expect(parseFlatXml('<response><pg_status>ok</pg_status><pg_redirect_url><![CDATA[https://pay.test/x?a=1]]></pg_redirect_url></response>')).toEqual({
      pg_status: 'ok',
      pg_redirect_url: 'https://pay.test/x?a=1',
    });
  });
});

describe('payment notifications', () => {
  it('activates the plan for a correctly signed, matching notification and answers with a signed ok', async () => {
    const { billing, calls } = billingWith(pending);
    const xml = await billing.handleFreedomPayResult(notification(), 'result');
    const reply = parseFlatXml(xml);
    expect(reply.pg_status).toBe('ok');
    expect(verifyParams('result', reply, SECRET)).toBe(true);
    expect(calls.activated).toBe(1);
  });

  it('rejects forged signatures, other amounts or currencies, and test payments in production', async () => {
    const cases = [
      notification({}, 'wrong-secret'),
      notification({ pg_amount: '1' }),
      notification({ pg_currency: 'KZT' }),
      notification({ pg_testing_mode: '1' }),
    ];
    for (const params of cases) {
      const { billing, calls } = billingWith(pending);
      expect(parseFlatXml(await billing.handleFreedomPayResult(params, 'result')).pg_status).toBe('error');
      expect(calls.activated).toBe(0);
    }
    // a tampered field after signing
    const { billing, calls } = billingWith(pending);
    const tampered = { ...notification(), pg_order_id: '11111111-1111-4111-8111-111111111111' };
    expect(parseFlatXml(await billing.handleFreedomPayResult(tampered, 'result')).pg_status).toBe('error');
    expect(calls.activated).toBe(0);
  });

  it('records a failed payment without activating anything', async () => {
    const { billing, calls } = billingWith(pending);
    const reply = parseFlatXml(await billing.handleFreedomPayResult(notification({ pg_result: '0' }), 'result'));
    expect(reply.pg_status).toBe('ok');
    expect(calls.activated).toBe(0);
    expect(calls.updates).toContainEqual({ status: 'failed' });
  });

  it('refuses checkout until the merchant keys are configured', async () => {
    const billing = new Billing({ admin: fakeAdmin(pending).admin, config: testConfig(), logger: silentLogger() });
    expect(billing.checkoutEnabled).toBe(false);
    await expect(billing.createCheckout({ id: 'u1', email: null }, 'start', 'ru')).rejects.toMatchObject({ code: 'payments_unavailable' });
  });
});

describe('plans', () => {
  it('match the pitch deck and fall back to Free when a period ends', () => {
    expect([PLANS.free, PLANS.start, PLANS.business, PLANS.pro].map((p) => [p.priceUsd, p.maxConsultants, p.monthlyReplies])).toEqual([
      [0, 1, 100],
      [19, 1, 1500],
      [49, 3, 5000],
      [129, 10, 20000],
    ]);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 1000).toISOString();
    expect(effectivePlan({ plan: 'pro', current_period_end: future }).id).toBe('pro');
    expect(effectivePlan({ plan: 'pro', current_period_end: past }).id).toBe('free');
    expect(effectivePlan(null).id).toBe('free');
  });
});
