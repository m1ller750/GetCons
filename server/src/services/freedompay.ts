import { createHash, randomBytes } from 'node:crypto';
import { safeEqual } from '../lib/crypto.js';

/**
 * Freedom Pay (Kazakhstan) Merchant API with its hosted payment page: the customer enters the
 * card on Freedom Pay's page, never on ours. We only create the payment and accept its signed
 * result notification. Docs: https://freedompay.kz/docs-en/merchant-api/intro
 */

export interface FreedomPayConfig {
  merchantId: string;
  secretKey: string;
  apiUrl: string;
  /** Test payments (no money moves). */
  testing: boolean;
}

export type Params = Record<string, string>;

/** pg_sig: md5 of "script;values sorted by key;secret". Flat params only (that is all we send). */
export function signParams(script: string, params: Params, secretKey: string): string {
  const values = Object.keys(params)
    .filter((k) => k !== 'pg_sig')
    .sort()
    .map((k) => params[k] ?? '');
  return createHash('md5').update([script, ...values, secretKey].join(';'), 'utf8').digest('hex');
}

export function verifyParams(script: string, params: Params, secretKey: string): boolean {
  const sig = params.pg_sig;
  return typeof sig === 'string' && sig.length === 32 && safeEqual(sig.toLowerCase(), signParams(script, params, secretKey));
}

function salt(): string {
  return randomBytes(12).toString('hex');
}

/** Values of simple <tag>value</tag> pairs in Freedom Pay's flat XML responses. */
export function parseFlatXml(xml: string): Params {
  const out: Params = {};
  for (const m of xml.matchAll(/<(pg_[a-z_]+)>([\s\S]*?)<\/\1>/g)) {
    out[m[1]!] = m[2]!.replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();
  }
  return out;
}

function xmlEscape(value: string): string {
  return value.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

/** Signed reply to a result notification ("ok" or "error"). */
export function resultResponse(script: string, status: 'ok' | 'error' | 'rejected', description: string, secretKey: string): string {
  const params: Params = { pg_status: status, pg_description: description, pg_salt: salt() };
  params.pg_sig = signParams(script, params, secretKey);
  const body = Object.entries(params)
    .map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`)
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?><response>${body}</response>`;
}

export interface InitPaymentInput {
  orderId: string;
  amount: string;
  currency: string;
  description: string;
  resultUrl: string;
  successUrl: string;
  failureUrl: string;
  language: 'ru' | 'en';
  email?: string | null;
}

export class FreedomPayError extends Error {}

export class FreedomPay {
  constructor(
    private readonly config: FreedomPayConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get secretKey(): string {
    return this.config.secretKey;
  }

  /** Creates the payment and returns the hosted page the customer is sent to. */
  async initPayment(input: InitPaymentInput): Promise<{ paymentId: string; redirectUrl: string }> {
    const script = 'init_payment.php';
    const params: Params = {
      pg_order_id: input.orderId,
      pg_merchant_id: this.config.merchantId,
      pg_amount: input.amount,
      pg_currency: input.currency,
      pg_description: input.description.slice(0, 250),
      pg_salt: salt(),
      pg_result_url: input.resultUrl,
      pg_success_url: input.successUrl,
      pg_failure_url: input.failureUrl,
      pg_request_method: 'POST',
      pg_language: input.language,
      pg_lifetime: '3600',
      pg_testing_mode: this.config.testing ? '1' : '0',
      ...(input.email ? { pg_user_contact_email: input.email } : {}),
    };
    params.pg_sig = signParams(script, params, this.config.secretKey);

    const res = await this.fetchImpl(`${this.config.apiUrl}/${script}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const reply = parseFlatXml(await res.text());
    if (reply.pg_status !== 'ok' || !reply.pg_redirect_url || !reply.pg_payment_id) {
      throw new FreedomPayError(reply.pg_error_description || `Freedom Pay refused the payment (HTTP ${res.status})`);
    }
    if (reply.pg_sig && !verifyParams(script, reply, this.config.secretKey)) {
      throw new FreedomPayError('Freedom Pay response signature mismatch');
    }
    const redirect = new URL(reply.pg_redirect_url);
    if (redirect.protocol !== 'https:') throw new FreedomPayError('Unexpected payment page address');
    return { paymentId: reply.pg_payment_id, redirectUrl: redirect.toString() };
  }
}
