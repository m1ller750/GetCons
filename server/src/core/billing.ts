import type { AppConfig } from '../config.js';
import { AppError, dbError, errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { SupabaseClient } from '../lib/supabase.js';
import { FreedomPay, resultResponse, verifyParams, type Params } from '../services/freedompay.js';
import { effectivePlan, monthStart, PERIOD_DAYS, PLANS, type PaidPlanId, type Plan, type SubscriptionRow } from './plans.js';
import { TtlCache } from './queue.js';

/** What the bot runtime asks before every AI reply. */
export interface ReplyQuota {
  check(userId: string): Promise<QuotaState>;
  record(userId: string): void;
}

export interface QuotaState {
  plan: Plan;
  used: number;
  allowed: boolean;
}

export interface PaymentRow {
  id: string;
  user_id: string;
  plan: PaidPlanId;
  amount: number | string;
  currency: string;
  provider: string;
  provider_payment_id: string | null;
  status: 'pending' | 'paid' | 'failed';
  created_at: string;
  paid_at: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY = 'USD';

export interface BillingDeps {
  admin: SupabaseClient;
  config: AppConfig;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export class Billing implements ReplyQuota {
  private readonly subs = new TtlCache<SubscriptionRow | null>(30_000);
  private readonly usage = new TtlCache<{ month: string; count: number }>(60_000);
  private readonly freedomPay: FreedomPay | null;

  constructor(private readonly deps: BillingDeps) {
    const fp = deps.config.billing.freedomPay;
    this.freedomPay = fp ? new FreedomPay(fp, deps.fetchImpl) : null;
  }

  /** Card checkout needs the merchant keys and a public https address for the callbacks. */
  get checkoutEnabled(): boolean {
    return Boolean(this.freedomPay && this.deps.config.publicUrl?.startsWith('https://'));
  }

  // ---------------------------------------------------------------------------
  // Plan and quota
  // ---------------------------------------------------------------------------

  async subscription(userId: string): Promise<SubscriptionRow | null> {
    const hit = this.subs.get(userId);
    if (hit !== undefined) return hit;
    const { data, error } = await this.deps.admin.from('subscriptions').select('*').eq('user_id', userId).maybeSingle();
    if (error) throw dbError(error, 'loading the plan');
    const row = (data as SubscriptionRow | null) ?? null;
    this.subs.set(userId, row);
    return row;
  }

  async plan(userId: string): Promise<Plan> {
    return effectivePlan(await this.subscription(userId));
  }

  invalidate(userId: string): void {
    this.subs.delete(userId);
  }

  async repliesThisMonth(userId: string): Promise<number> {
    const month = monthStart();
    const hit = this.usage.get(userId);
    if (hit && hit.month === month) return hit.count;
    const { data, error } = await this.deps.admin
      .from('ai_usage')
      .select('replies')
      .eq('user_id', userId)
      .eq('month', month.slice(0, 10))
      .maybeSingle();
    if (error) throw dbError(error, 'counting AI replies');
    const count = Number((data as { replies: number } | null)?.replies ?? 0);
    this.usage.set(userId, { month, count });
    return count;
  }

  async check(userId: string): Promise<QuotaState> {
    const [plan, used] = await Promise.all([this.plan(userId), this.repliesThisMonth(userId)]);
    return { plan, used, allowed: used < plan.monthlyReplies };
  }

  /** Counts one AI reply: durable in the database, instant in the cache. */
  record(userId: string): void {
    const hit = this.usage.get(userId);
    if (hit && hit.month === monthStart()) hit.count++;
    void Promise.resolve(this.deps.admin.rpc('record_ai_reply', { p_user_id: userId })).then(({ data, error }) => {
      if (error) this.deps.logger.warn({ err: error.message, userId }, 'Could not record an AI reply');
      else if (typeof data === 'number') this.usage.set(userId, { month: monthStart(), count: data });
    });
  }

  /** Plan, usage and recent payments for the Billing page. */
  async overview(userId: string) {
    const [sub, state] = await Promise.all([this.subscription(userId), this.check(userId)]);
    const { data, error } = await this.deps.admin
      .from('payments')
      .select('id, plan, amount, currency, status, created_at, paid_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) throw dbError(error, 'listing payments');
    return {
      plan: state.plan.id,
      periodEnd: state.plan.id === 'free' ? null : (sub?.current_period_end ?? null),
      usage: { replies: state.used, repliesLimit: state.plan.monthlyReplies, since: monthStart() },
      checkoutEnabled: this.checkoutEnabled,
      currency: CURRENCY,
      periodDays: PERIOD_DAYS,
      plans: Object.values(PLANS),
      payments: data ?? [],
    };
  }

  // ---------------------------------------------------------------------------
  // Checkout (Freedom Pay hosted page)
  // ---------------------------------------------------------------------------

  async createCheckout(user: { id: string; email: string | null }, planId: PaidPlanId, language: 'ru' | 'en'): Promise<{ redirectUrl: string }> {
    const publicUrl = this.deps.config.publicUrl;
    if (!this.freedomPay || !publicUrl?.startsWith('https://')) {
      throw new AppError(503, 'payments_unavailable', 'Card payments are not connected yet');
    }
    const plan = PLANS[planId];
    // The amount always comes from the server's price list, never from the browser.
    const amount = plan.priceUsd.toFixed(2);
    const { data, error } = await this.deps.admin
      .from('payments')
      .insert({ user_id: user.id, plan: planId, amount, currency: CURRENCY, provider: 'freedompay' })
      .select('id')
      .single();
    if (error) throw dbError(error, 'creating the payment');
    const paymentId = (data as { id: string }).id;

    try {
      const page = await this.freedomPay.initPayment({
        orderId: paymentId,
        amount,
        currency: CURRENCY,
        description: `GetCons ${planId[0]!.toUpperCase()}${planId.slice(1)}, ${PERIOD_DAYS} days`,
        resultUrl: `${publicUrl}/api/billing/freedompay/result`,
        successUrl: `${publicUrl}/app/billing?payment=success`,
        failureUrl: `${publicUrl}/app/billing?payment=failed`,
        language,
        email: user.email,
      });
      await this.deps.admin.from('payments').update({ provider_payment_id: page.paymentId }).eq('id', paymentId);
      return { redirectUrl: page.redirectUrl };
    } catch (err) {
      this.deps.logger.error({ err: errorMessage(err), paymentId }, 'Could not open the Freedom Pay page');
      await this.deps.admin.from('payments').update({ status: 'failed' }).eq('id', paymentId);
      throw new AppError(502, 'payment_provider_error', 'The payment page could not be opened. Try again in a minute.');
    }
  }

  /**
   * Freedom Pay's server-to-server result notification. The only thing that activates a plan:
   * the signature, order, amount and currency must all match what we created.
   * Returns the signed XML reply Freedom Pay expects.
   */
  async handleFreedomPayResult(params: Params, script: string): Promise<string> {
    const fp = this.freedomPay;
    if (!fp) throw new AppError(404, 'not_found', 'Unknown endpoint');
    const reply = (status: 'ok' | 'error', description: string) => resultResponse(script, status, description, fp.secretKey);
    const { logger, admin, config } = this.deps;

    if (!verifyParams(script, params, fp.secretKey)) {
      logger.warn({ order: params.pg_order_id?.slice(0, 40) }, 'Freedom Pay notification with a bad signature');
      return reply('error', 'Invalid signature');
    }
    const orderId = params.pg_order_id ?? '';
    if (!UUID.test(orderId)) return reply('error', 'Unknown order');
    const { data, error } = await admin.from('payments').select('*').eq('id', orderId).maybeSingle();
    if (error) throw dbError(error, 'loading the payment');
    const payment = data as PaymentRow | null;
    if (!payment) return reply('error', 'Unknown order');

    if (params.pg_result !== '1') {
      if (payment.status === 'pending' && params.pg_result === '0') {
        await admin.from('payments').update({ status: 'failed' }).eq('id', payment.id).eq('status', 'pending');
      }
      logger.info({ paymentId: payment.id, result: params.pg_result }, 'Payment not completed');
      return reply('ok', 'Noted');
    }

    const sameAmount = Math.abs(Number(params.pg_amount) - Number(payment.amount)) < 0.005;
    const sameCurrency = (params.pg_currency ?? '').toUpperCase() === payment.currency;
    const testPayment = params.pg_testing_mode === '1';
    if (!sameAmount || !sameCurrency || (testPayment && !config.billing.freedomPay?.testing)) {
      logger.error({ paymentId: payment.id, sameAmount, sameCurrency, testPayment }, 'Freedom Pay notification does not match the payment');
      return reply('error', 'Payment does not match the order');
    }

    const { error: activateError } = await admin.rpc('activate_payment', {
      p_payment_id: payment.id,
      p_provider_payment_id: (params.pg_payment_id ?? '').slice(0, 64) || null,
    });
    if (activateError) throw dbError(activateError, 'activating the plan');
    this.invalidate(payment.user_id);
    logger.info({ paymentId: payment.id, plan: payment.plan }, 'Plan paid');
    return reply('ok', 'Payment accepted');
  }
}
