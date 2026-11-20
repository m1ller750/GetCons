import { useMutation } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Circle,
  Clock,
  ExternalLink,
  GraduationCap,
  MessageCircle,
  Pause,
  Play,
  Gauge,
  ListChecks,
  Timer,
  Users,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import type { ConnectIntent } from '../components/CreateConsultant';
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { toast } from 'sonner';
import { ChannelGlyph, ConsultantStatusBadge } from '../components/brand';
import { ChannelSetup } from '../components/Channels';
import { WebChannelPanel } from '../components/WebChannel';
import { TeachModal } from '../components/TeachModal';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, PageLoader, Select, Skeleton, cx } from '../components/ui';
import { api, errorText } from '../lib/api';
import { duration, number, phone, relativeTime, shortDay } from '../lib/format';
import { fmt, useI18n } from '../lib/i18n';
import { useActivity, useAnalytics, useConsultant, useGaps, useInvalidateConsultant, usePlayground } from '../lib/queries';
import type { Gap } from '../lib/types';

function Kpi({ icon, label, value, hint, tone = 'brand' }: { icon: ReactNode; label: string; value: ReactNode; hint?: string; tone?: 'brand' | 'amber' | 'green' | 'sky' }) {
  const tones = { brand: 'bg-brand-50 text-brand-600', amber: 'bg-amber-50 text-amber-600', green: 'bg-emerald-50 text-emerald-600', sky: 'bg-sky-50 text-sky-600' };
  return (
    <Card className="p-5">
      <div className="flex items-center gap-3">
        <div className={cx('flex size-9 shrink-0 items-center justify-center rounded-lg', tones[tone])}>{icon}</div>
        <p className="min-w-0 truncate text-sm font-medium text-slate-500" title={label}>
          {label}
        </p>
      </div>
      <p className="mt-3 text-[1.75rem] leading-none font-semibold tracking-tight text-slate-900 tabular-nums">{value}</p>
      {hint && <p className="mt-2 text-xs text-slate-500">{hint}</p>}
    </Card>
  );
}

function SetupChecklist({ consultantId }: { consultantId: string }) {
  const { t } = useI18n();
  const details = useConsultant(consultantId);
  const playground = usePlayground(consultantId);
  if (!details.data) return null;
  const { consultant: c, counts } = details.data;
  const info = c.business_info ?? {};
  const base = `/app/c/${consultantId}`;
  const steps = [
    { done: Boolean(info.description?.trim() || info.products?.trim() || info.pricing?.trim()), label: t.overview.steps.business, to: `${base}/settings?tab=business` },
    { done: counts.documents > 0, label: t.overview.steps.knowledge, to: `${base}/knowledge` },
    { done: counts.examples > 0, label: t.overview.steps.examples, to: `${base}/training` },
    { done: (playground.data?.length ?? 0) > 0, label: t.overview.steps.test, to: `${base}/playground` },
    { done: c.telegram.connected || c.whatsapp.connected || c.web.enabled, label: t.overview.steps.telegram, to: `${base}/settings?tab=channels` },
    { done: c.telegram.ownerNotifications || c.whatsapp.ownerNotifications, label: t.overview.steps.notify, to: `${base}/settings?tab=channels` },
  ];
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  return (
    <Card>
      <CardHeader
        icon={<ListChecks className="size-5" />}
        title={t.overview.setupTitle}
        subtitle={fmt(t.overview.setupSubtitle, { done, total: steps.length })}
        action={
          <div className="h-2 w-32 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={steps.length}>
            <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${(done / steps.length) * 100}%` }} />
          </div>
        }
      />
      <ul className="grid gap-1 p-3 sm:grid-cols-2 lg:grid-cols-3">
        {steps.map((s) => (
          <li key={s.label}>
            <Link to={s.to} className="flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-slate-50">
              {s.done ? <CheckCircle2 className="size-5 shrink-0 text-emerald-500" aria-hidden /> : <Circle className="size-5 shrink-0 text-slate-300" aria-hidden />}
              <span className={cx(s.done ? 'text-slate-400 line-through' : 'font-medium text-slate-700')}>{s.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function OverviewPage() {
  const { consultantId = '' } = useParams();
  const { t, locale } = useI18n();
  const [days, setDays] = useState(30);
  const [teaching, setTeaching] = useState<Gap | null>(null);
  const details = useConsultant(consultantId);
  const analytics = useAnalytics(consultantId, days);
  const gaps = useGaps(consultantId);
  const activity = useActivity(consultantId);
  const invalidate = useInvalidateConsultant();
  const [params] = useSearchParams();
  const location = useLocation();
  // Set by the create form (router state, so the phone number never lands in the URL).
  const fromState = (location.state as { connect?: ConnectIntent } | null)?.connect;
  const connectParam = params.get('connect');
  const intent: ConnectIntent | null =
    fromState ?? (connectParam === 'telegram' || connectParam === 'whatsapp' ? { channel: connectParam } : null);

  const toggle = useMutation({
    mutationFn: (status: 'active' | 'paused') => api(`/consultants/${consultantId}/status`, { method: 'POST', body: { status } }),
    onSuccess: (_d, status) => {
      toast.success(status === 'active' ? t.overview.resumed : t.overview.paused);
      invalidate(consultantId);
    },
    onError: (err) => toast.error(errorText(err)),
  });

  if (details.isLoading) return <PageLoader />;
  if (details.error || !details.data) return <Alert tone="error" title={t.common.error}>{errorText(details.error)}</Alert>;
  const c = details.data.consultant;
  const k = analytics.data?.kpis;
  const anyChannel = c.telegram.connected || c.whatsapp.connected || c.web.enabled;
  const pill = 'inline-flex h-10 items-center gap-2 rounded-lg bg-white px-4 text-sm font-medium text-slate-800 ring-1 ring-slate-300 ring-inset hover:bg-slate-50';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{c.name}</h1>
            <ConsultantStatusBadge status={c.status} />
          </div>
          <p className="mt-1 text-[15px] text-slate-500">{fmt(t.overview.greeting, { name: c.name })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="period">
            {t.overview.period}
          </label>
          <Select id="period" value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-auto">
            {[7, 30, 90].map((d) => (
              <option key={d} value={d}>
                {fmt(t.overview.days, { days: d })}
              </option>
            ))}
          </Select>
          {c.whatsapp.connected && c.whatsapp.phone && (
            <a href={`https://wa.me/${c.whatsapp.phone.replace(/\D/g, '')}`} target="_blank" rel="noreferrer" className={pill}>
              <ChannelGlyph channel="whatsapp" className="size-4 text-[#25d366]" /> {phone(c.whatsapp.phone)}
            </a>
          )}
          {c.web.enabled && c.web.link && (
            <a href={c.web.link} target="_blank" rel="noreferrer" className={pill}>
              <ChannelGlyph channel="web" className="size-4" /> {t.web.chatLink}
            </a>
          )}
          {c.telegram_bot_username && (
            <a href={`https://t.me/${c.telegram_bot_username}`} target="_blank" rel="noreferrer" className={pill}>
              <ExternalLink className="size-4" aria-hidden /> @{c.telegram_bot_username}
            </a>
          )}
          {anyChannel && (
            <Button
              variant={c.status === 'active' ? 'secondary' : 'primary'}
              icon={c.status === 'active' ? <Pause className="size-4" /> : <Play className="size-4" />}
              loading={toggle.isPending}
              onClick={() => toggle.mutate(c.status === 'active' ? 'paused' : 'active')}
            >
              {c.status === 'active' ? t.overview.pause : t.overview.resume}
            </Button>
          )}
        </div>
      </div>

      {c.status === 'error' && c.last_error && (
        <Alert tone="error" icon={<AlertTriangle className="size-5" />} title={t.overview.statusError}>
          {c.last_error}{' '}
          <Link to={`/app/c/${consultantId}/settings?tab=channels`} className="font-semibold underline">
            {t.nav.settings}
          </Link>
        </Alert>
      )}

      {!anyChannel && (
        <ChannelSetup consultant={c} intent={intent} />
      )}
      {/* Just created with the website chat: the link and the widget code come first. */}
      {anyChannel && intent?.channel === 'web' && <WebChannelPanel consultant={c} />}

      <SetupChecklist consultantId={consultantId} />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 2xl:grid-cols-6">
        {analytics.isLoading || !k ? (
          Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[118px] rounded-xl" />)
        ) : (
          <>
            <Kpi icon={<MessageCircle className="size-[18px]" />} label={t.overview.kpi.customerMessages} value={number(k.customerMessages, locale)} />
            <Kpi icon={<Bot className="size-[18px]" />} label={t.overview.kpi.aiReplies} value={number(k.aiReplies, locale)} />
            <Kpi
              icon={<Gauge className="size-[18px]" />}
              tone="green"
              label={t.overview.kpi.automation}
              value={k.automationRate === null ? '—' : `${k.automationRate}%`}
              hint={t.overview.kpi.automationHint}
            />
            <Kpi icon={<AlertTriangle className="size-[18px]" />} tone="amber" label={t.overview.kpi.attention} value={number(k.needsAttention, locale)} />
            <Kpi icon={<Timer className="size-[18px]" />} tone="sky" label={t.overview.kpi.latency} value={duration(k.avgLatencyMs)} />
            <Kpi icon={<Users className="size-[18px]" />} label={t.overview.kpi.conversations} value={number(k.activeConversations, locale)} />
          </>
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-3 [&>*]:min-w-0">
        <Card className="xl:col-span-2">
          <CardHeader
            title={t.overview.chartTitle}
            subtitle={
              analytics.data
                ? fmt(t.overview.knowledgeStat, {
                    docs: analytics.data.knowledge.documents,
                    chunks: analytics.data.knowledge.chunks,
                    examples: analytics.data.knowledge.examples,
                  })
                : undefined
            }
          />
          <div className="h-72 px-2 py-4 sm:px-4">
            {analytics.data ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={analytics.data.daily.map((d) => ({ ...d, label: shortDay(d.day, locale) }))} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                  <defs>
                    <linearGradient id="ai" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#7c3aed" stopOpacity={0.28} />
                      <stop offset="100%" stopColor="#7c3aed" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="cust" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#c084fc" stopOpacity={0.22} />
                      <stop offset="100%" stopColor="#c084fc" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={false} minTickGap={16} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 13 }} />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 13 }} />
                  <Area type="monotone" dataKey="customerMessages" name={t.overview.chartCustomer} stroke="#c084fc" strokeWidth={2} fill="url(#cust)" />
                  <Area type="monotone" dataKey="aiReplies" name={t.overview.chartAi} stroke="#7c3aed" strokeWidth={2} fill="url(#ai)" />
                  <Area type="monotone" dataKey="fallbacks" name={t.overview.chartFallback} stroke="#f59e0b" strokeWidth={2} strokeDasharray="5 3" fill="transparent" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <Skeleton className="h-full w-full" />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader icon={<Clock className="size-5" />} title={t.overview.activityTitle} />
          <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto scroll-thin">
            {activity.data?.length ? (
              activity.data.map((e) => (
                <li key={e.id} className="flex gap-3 px-5 py-3">
                  <span
                    className={cx('mt-1.5 size-2 shrink-0 rounded-full', e.level === 'error' ? 'bg-rose-500' : e.level === 'warning' ? 'bg-amber-500' : 'bg-emerald-500')}
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <p className="text-sm text-slate-700">{t.events[e.type as keyof typeof t.events] ?? e.type}</p>
                    <p className="truncate text-xs text-slate-500" title={e.message}>
                      {e.message}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-400">{relativeTime(e.created_at, locale)}</p>
                  </div>
                </li>
              ))
            ) : (
              <li className="px-5 py-8 text-center text-sm text-slate-500">{t.overview.activityEmpty}</li>
            )}
          </ul>
        </Card>
      </div>

      <Card>
        <CardHeader icon={<GraduationCap className="size-5" />} title={t.overview.gapsTitle} subtitle={t.overview.gapsSubtitle} />
        {gaps.data?.length ? (
          <ul className="divide-y divide-slate-100">
            {gaps.data.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-900">В«{g.question}В»</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <Badge tone={g.status === 'handoff' ? 'violet' : g.status === 'error' ? 'rose' : 'amber'}>
                      {t.status[g.status as keyof typeof t.status] ?? g.status}
                    </Badge>
                    <span>{relativeTime(g.createdAt, locale)}</span>
                    <Link to={`/app/c/${consultantId}/conversations?open=${g.conversationId}`} className="text-brand-700 hover:underline">
                      {t.common.open}
                    </Link>
                  </div>
                </div>
                <Button variant="subtle" size="sm" icon={<GraduationCap className="size-4" />} onClick={() => setTeaching(g)}>
                  {t.overview.teach}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={t.overview.gapsEmpty} />
        )}
      </Card>

      <TeachModal consultantId={consultantId} open={Boolean(teaching)} onClose={() => setTeaching(null)} question={teaching?.question ?? ''} source="gap" />
    </div>
  );
}
