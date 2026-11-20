import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, CreditCard, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Alert, Badge, Button, Card, CardHeader, cx, PageHeader, PageLoader } from '../components/ui';
import { api, errorText } from '../lib/api';
import { fmt, useI18n } from '../lib/i18n';
import { keys, useBilling } from '../lib/queries';
import type { BillingOverview, PlanId } from '../lib/types';

const ORDER: PlanId[] = ['free', 'start', 'business', 'pro'];

/** Plans from the pitch deck, current usage and card checkout (Freedom Pay's hosted page). */
export function BillingPage() {
  const { t, lang, locale } = useI18n();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const result = params.get('payment');
  // After returning from the payment page, poll until the result notification has switched the plan.
  const [waiting, setWaiting] = useState(result === 'success');
  const billing = useBilling(waiting);

  useEffect(() => {
    if (!waiting) return;
    const stop = setTimeout(() => setWaiting(false), 60_000);
    return () => clearTimeout(stop);
  }, [waiting]);

  const lastPaid = billing.data?.payments.find((p) => p.status === 'paid');
  useEffect(() => {
    if (waiting && lastPaid && Date.now() - new Date(lastPaid.paid_at ?? 0).getTime() < 10 * 60_000) {
      setWaiting(false);
      void qc.invalidateQueries({ queryKey: keys.me });
    }
  }, [waiting, lastPaid, qc]);

  const checkout = useMutation({
    mutationFn: (plan: PlanId) => api<{ redirectUrl: string }>('/billing/checkout', { method: 'POST', body: { plan, language: lang } }),
    onSuccess: ({ redirectUrl }) => {
      toast.loading(t.billing.redirecting);
      window.location.assign(redirectUrl);
    },
    onError: (err) => toast.error(errorText(err)),
  });

  if (billing.isLoading) return <PageLoader />;
  if (billing.error || !billing.data) return <Alert tone="error" title={t.common.error}>{errorText(billing.error)}</Alert>;
  const data = billing.data;
  const date = (iso: string) => new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title={t.billing.title} subtitle={t.billing.subtitle} />

      {result === 'success' && (
        <div className="mb-5">
          <Alert tone="success">{t.billing.paidOk}</Alert>
        </div>
      )}
      {result === 'failed' && (
        <div className="mb-5">
          <Alert tone="error">{t.billing.paidFailed}</Alert>
        </div>
      )}

      <CurrentPlan data={data} date={date} />

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4 [&>*]:min-w-0">
        {ORDER.map((id) => {
          const plan = data.plans.find((p) => p.id === id);
          if (!plan) return null;
          const copy = t.billing.plans[id];
          const current = data.plan === id;
          const popular = id === 'business';
          return (
            <Card key={id} className={cx('flex flex-col p-5', popular && 'ring-2 ring-brand-500')}>
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-slate-900">{copy.name}</h2>
                {current ? <Badge tone="green">{t.billing.yourPlan}</Badge> : popular ? <Badge tone="brand">{t.billing.popular}</Badge> : null}
              </div>
              <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-900">
                ${plan.priceUsd}
                <span className="text-base font-normal text-slate-500">{t.billing.perMonth}</span>
              </p>
              <ul className="mt-4 flex-1 space-y-2 text-sm text-slate-600">
                {copy.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              {id !== 'free' && (
                <Button
                  className="mt-5 w-full"
                  variant={popular ? 'primary' : 'secondary'}
                  icon={<CreditCard className="size-4" />}
                  disabled={!data.checkoutEnabled || (checkout.isPending && checkout.variables !== id)}
                  loading={checkout.isPending && checkout.variables === id}
                  onClick={() => checkout.mutate(id)}
                >
                  {current ? t.billing.renew : fmt(t.billing.choose, { plan: copy.name })}
                </Button>
              )}
            </Card>
          );
        })}
      </div>

      <div className="mt-4 space-y-2">
        {data.checkoutEnabled ? (
          <p className="flex items-center gap-2 text-[13px] text-slate-500">
            <ShieldCheck className="size-4 shrink-0 text-emerald-600" aria-hidden /> {t.billing.secure}
          </p>
        ) : (
          <Alert tone="info">{t.billing.unavailable}</Alert>
        )}
        <p className="text-[13px] text-slate-500">{t.billing.periodNote}</p>
      </div>

      <Card className="mt-6">
        <CardHeader title={t.billing.history} />
        {data.payments.length ? (
          <ul className="divide-y divide-slate-100">
            {data.payments.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                <span className="text-slate-700">
                  {t.billing.plans[p.plan].name} · {date(p.created_at)}
                </span>
                <span className="flex items-center gap-3">
                  <span className="font-medium text-slate-900">
                    {Number(p.amount).toLocaleString(locale, { style: 'currency', currency: p.currency })}
                  </span>
                  <Badge tone={p.status === 'paid' ? 'green' : p.status === 'failed' ? 'rose' : 'amber'}>
                    {p.status === 'paid' ? t.billing.statusPaid : p.status === 'failed' ? t.billing.statusFailed : t.billing.statusPending}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-4 text-sm text-slate-500">{t.billing.noPayments}</p>
        )}
      </Card>
    </div>
  );
}

function CurrentPlan({ data, date }: { data: BillingOverview; date: (iso: string) => string }) {
  const { t, locale } = useI18n();
  const { replies, repliesLimit } = data.usage;
  const share = Math.min(100, Math.round((replies / Math.max(1, repliesLimit)) * 100));
  return (
    <Card className="grid gap-5 p-5 sm:grid-cols-2">
      <div>
        <p className="text-sm text-slate-500">{t.billing.current}</p>
        <p className="mt-1 text-2xl font-semibold text-slate-900">{t.billing.plans[data.plan].name}</p>
        <p className="mt-1 text-sm text-slate-500">
          {data.periodEnd ? fmt(t.billing.until, { date: date(data.periodEnd) }) : t.billing.freeForever}
        </p>
      </div>
      <div>
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="text-slate-500">{t.billing.usage}</span>
          <span className="font-medium text-slate-900">
            {fmt(t.billing.usageOf, { used: replies.toLocaleString(locale), limit: repliesLimit.toLocaleString(locale) })}
          </span>
        </div>
        <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={share} aria-valuemin={0} aria-valuemax={100}>
          <div className={cx('h-full rounded-full', share >= 90 ? 'bg-rose-500' : share >= 70 ? 'bg-amber-500' : 'bg-brand-600')} style={{ width: `${share}%` }} />
        </div>
      </div>
    </Card>
  );
}
