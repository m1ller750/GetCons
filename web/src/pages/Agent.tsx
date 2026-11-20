import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, Check, ExternalLink, PackageCheck, PackageX, RotateCcw, Store, Truck, Unplug } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { ChannelGlyph } from '../components/brand';
import { Alert, Badge, Button, Card, CardHeader, CopyButton, EmptyState, Field, Input, PageHeader, PageLoader, Switch, Tabs, cx, useConfirm } from '../components/ui';
import { api, errorText } from '../lib/api';
import { relativeTime } from '../lib/format';
import { fmt, useI18n } from '../lib/i18n';
import { keys, useAgent, useAgentActions } from '../lib/queries';
import type { AgentAction, AgentOverview, AgentPermissions, AgentSettings, StoreConnection, StorePlatform } from '../lib/types';

const PLATFORMS: StorePlatform[] = ['shopify', 'woocommerce', 'custom'];

const CONTRACT = `POST <your endpoint>
Headers:
  X-GetCons-Timestamp: 1763600000
  X-GetCons-Signature: sha256=HMAC_SHA256(secret, timestamp + "." + body)
Body: { "action": "...", "params": { ... }, "request_id": "...", "timestamp": 1763600000 }

action           params                                   answer
ping             {}                                       { "ok": true, "name": "My shop", "currency": "USD" }
find_products    { "query": "roses", "limit": 5 }         { "products": [{ "id", "variant_id", "name", "price", "currency", "in_stock", "url" }] }
get_order        { "order": "1024" }                      { "order": { "id", "number", "status", "total", "currency",
                                                                       "items": [{ "name", "quantity" }], "email", "phone",
                                                                       "payment_url", "tracking_url" } }   or { "order": null }
create_order     { "items": [{ "product_id", "variant_id", "quantity" }],
                   "customer": { "name", "phone", "email", "address", "city" }, "note" }   { "order": { ... } }
cancel_order     { "order_id": "...", "reason": "..." }   { "order": { ... } }
refund           { "order_id": "...", "amount": 20, "reason": "..." }   { "refund": { "id", "amount", "status" } }
Errors: { "ok": false, "error": "Text the customer may see" }

Tell a customer about their order (optional), signed the same way:
POST <notify URL>   { "order_id": "...", "message": "Your order has shipped: https://..." }`;

export function AgentPage() {
  const { consultantId = '' } = useParams();
  const { t } = useI18n();
  const agent = useAgent(consultantId);

  if (agent.isLoading) return <PageLoader />;
  if (agent.error || !agent.data) return <Alert tone="error" title={t.common.error}>{errorText(agent.error)}</Alert>;
  const data = agent.data;

  return (
    <div className="space-y-6">
      <PageHeader title={t.agent.title} subtitle={t.agent.subtitle} />
      {!data.available ? (
        <Upsell />
      ) : (
        <>
          <MasterSwitch consultantId={consultantId} data={data} />
          <ConnectionCard consultantId={consultantId} data={data} />
          <PermissionsCard consultantId={consultantId} data={data} />
          <ActionsCard consultantId={consultantId} />
        </>
      )}
    </div>
  );
}

function Upsell() {
  const { t } = useI18n();
  return (
    <Card>
      <div className="grid gap-8 p-6 md:grid-cols-[1.2fr_1fr] md:p-8">
        <div>
          <Badge tone="brand">Pro</Badge>
          <h2 className="mt-3 text-xl font-semibold tracking-tight text-slate-900">{t.agent.proTitle}</h2>
          <p className="mt-2 text-[15px] leading-relaxed text-slate-600">{t.agent.proText}</p>
          <Link to="/app/billing" className="mt-5 inline-flex h-10 items-center rounded-lg bg-ink px-4 text-sm font-semibold text-white hover:bg-black">
            {t.agent.upgrade}
          </Link>
        </div>
        <ul className="space-y-3">
          {t.agent.proPoints.map((p, i) => (
            <li key={p.title} className="flex gap-3">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-slate-100 text-xs font-semibold text-slate-600">{i + 1}</span>
              <span>
                <span className="block text-sm font-semibold text-slate-900">{p.title}</span>
                <span className="block text-[13px] leading-snug text-slate-500">{p.text}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function useSaveSettings(consultantId: string) {
  const qc = useQueryClient();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (patch: Partial<Omit<AgentSettings, 'permissions'>> & { permissions?: Partial<AgentPermissions> }) =>
      api<{ settings: AgentSettings }>(`/consultants/${consultantId}/agent`, { method: 'PUT', body: patch }),
    onSuccess: ({ settings }) => {
      qc.setQueryData<AgentOverview>(keys.agent(consultantId), (old) => (old ? { ...old, settings } : old));
      void qc.invalidateQueries({ queryKey: keys.consultant(consultantId) });
      toast.success(t.common.saved);
    },
    onError: (err) => toast.error(errorText(err)),
  });
}

function MasterSwitch({ consultantId, data }: { consultantId: string; data: AgentOverview }) {
  const { t } = useI18n();
  const save = useSaveSettings(consultantId);
  return (
    <Card className="p-5">
      <Switch
        checked={data.settings.enabled}
        disabled={save.isPending}
        onChange={(enabled) => save.mutate({ enabled })}
        label={<span className="text-base font-semibold text-slate-900">{t.agent.enable}</span>}
        description={data.settings.enabled ? t.agent.enabledHint : t.agent.enableHint}
      />
    </Card>
  );
}

function ConnectionCard({ consultantId, data }: { consultantId: string; data: AgentOverview }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [platform, setPlatform] = useState<StorePlatform>(data.connection?.platform ?? 'woocommerce');
  const [form, setForm] = useState({ storeUrl: '', accessToken: '', consumerKey: '', consumerSecret: '' });
  const [secret, setSecret] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const connect = useMutation({
    mutationFn: () =>
      api<{ connection: StoreConnection; secret: string | null; notifyUrl: string | null }>(`/consultants/${consultantId}/agent/connection`, {
        method: 'POST',
        body:
          platform === 'shopify'
            ? { platform, storeUrl: form.storeUrl, accessToken: form.accessToken }
            : platform === 'woocommerce'
              ? { platform, storeUrl: form.storeUrl, consumerKey: form.consumerKey, consumerSecret: form.consumerSecret }
              : { platform, storeUrl: form.storeUrl },
      }),
    onSuccess: (r) => {
      setSecret(r.secret);
      setEditing(false);
      setForm({ storeUrl: '', accessToken: '', consumerKey: '', consumerSecret: '' });
      void qc.invalidateQueries({ queryKey: keys.agent(consultantId) });
      if (r.connection.status === 'connected') toast.success(t.agent.connected);
      else toast.warning(t.agent.savedWithProblem);
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const disconnect = useMutation({
    mutationFn: () => api(`/consultants/${consultantId}/agent/connection`, { method: 'DELETE' }),
    onSuccess: () => {
      setSecret(null);
      void qc.invalidateQueries({ queryKey: keys.agent(consultantId) });
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const reveal = useMutation({
    mutationFn: () => api<{ secret: string | null }>(`/consultants/${consultantId}/agent/connection/secret`),
    onSuccess: (r) => setSecret(r.secret),
    onError: (err) => toast.error(errorText(err)),
  });

  const c = data.connection;
  const showForm = !c || editing;
  const p = t.agent.platforms[platform];

  return (
    <Card>
      <CardHeader
        icon={<Store className="size-5" />}
        title={t.agent.connectTitle}
        subtitle={t.agent.connectSubtitle}
        action={c ? <Badge tone={c.status === 'connected' ? 'green' : 'amber'} dot>{c.status === 'connected' ? t.agent.statusConnected : t.agent.statusProblem}</Badge> : <Badge>{t.agent.notConnected}</Badge>}
      />
      <div className="space-y-5 p-5">
        {c && !editing && (
          <div className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-200 p-4">
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-slate-900">{c.storeName || c.storeUrl}</p>
              <p className="truncate text-sm text-slate-500">
                {t.agent.platforms[c.platform].name} · {c.storeUrl}
                {c.currency ? ` · ${c.currency}` : ''}
              </p>
              {c.lastError && <p className="mt-1 text-sm text-amber-700">{c.lastError}</p>}
            </div>
            <Button variant="secondary" size="sm" onClick={() => { setPlatform(c.platform); setEditing(true); }}>
              {t.agent.change}
            </Button>
            <Button
              variant="danger-ghost"
              size="sm"
              icon={<Unplug className="size-4" />}
              loading={disconnect.isPending}
              onClick={async () => {
                if (await confirm({ title: t.agent.disconnect, text: t.agent.disconnectConfirm, confirmLabel: t.agent.disconnect, danger: true })) disconnect.mutate();
              }}
            >
              {t.agent.disconnect}
            </Button>
          </div>
        )}

        {c?.platform === 'custom' && !editing && (
          <div className="space-y-3 rounded-xl bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-900">{t.agent.forDeveloper}</p>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-slate-500">{t.agent.secret}:</span>
              {secret ? (
                <>
                  <code className="rounded bg-white px-2 py-1 font-mono text-[13px] ring-1 ring-slate-200">{secret}</code>
                  <CopyButton value={secret} />
                </>
              ) : (
                <Button variant="secondary" size="sm" loading={reveal.isPending} onClick={() => reveal.mutate()}>
                  {t.agent.showSecret}
                </Button>
              )}
            </div>
            {data.notifyUrl && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-slate-500">{t.agent.notifyUrl}:</span>
                <code className="break-all rounded bg-white px-2 py-1 font-mono text-[13px] ring-1 ring-slate-200">{data.notifyUrl}</code>
                <CopyButton value={data.notifyUrl} />
              </div>
            )}
            <details>
              <summary className="cursor-pointer text-sm font-medium text-brand-700">{t.agent.apiDocs}</summary>
              <pre className="mt-3 overflow-x-auto rounded-lg bg-ink p-4 font-mono text-[12px] leading-relaxed text-slate-100 scroll-thin">{CONTRACT}</pre>
            </details>
          </div>
        )}

        {showForm && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              connect.mutate();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label={t.agent.connectTitle}>
              {PLATFORMS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={platform === id}
                  onClick={() => setPlatform(id)}
                  className={cx(
                    'cursor-pointer rounded-xl border-2 p-3.5 text-left transition-colors',
                    platform === id ? 'border-ink bg-white' : 'border-slate-200 bg-white hover:border-slate-300',
                  )}
                >
                  <span className="block text-sm font-semibold text-slate-900">{t.agent.platforms[id].name}</span>
                  <span className="mt-0.5 block text-[12.5px] leading-snug text-slate-500">{t.agent.platforms[id].short}</span>
                </button>
              ))}
            </div>
            <Alert tone="info">{p.hint}</Alert>
            <Field label={p.urlLabel}>
              {(id) => <Input id={id} value={form.storeUrl} onChange={set('storeUrl')} placeholder={p.urlPlaceholder} autoComplete="off" spellCheck={false} required />}
            </Field>
            {platform === 'shopify' && (
              <Field label={t.agent.accessToken}>
                {(id) => <Input id={id} value={form.accessToken} onChange={set('accessToken')} placeholder="shpat_…" autoComplete="off" spellCheck={false} className="font-mono text-sm" required />}
              </Field>
            )}
            {platform === 'woocommerce' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t.agent.consumerKey}>
                  {(id) => <Input id={id} value={form.consumerKey} onChange={set('consumerKey')} placeholder="ck_…" autoComplete="off" spellCheck={false} className="font-mono text-sm" required />}
                </Field>
                <Field label={t.agent.consumerSecret}>
                  {(id) => <Input id={id} value={form.consumerSecret} onChange={set('consumerSecret')} placeholder="cs_…" autoComplete="off" spellCheck={false} className="font-mono text-sm" required />}
                </Field>
              </div>
            )}
            <p className="text-[13px] text-slate-500">{t.agent.keysSafe}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" loading={connect.isPending}>
                {connect.isPending ? t.agent.connecting : t.agent.connect}
              </Button>
              {editing && (
                <Button variant="ghost" onClick={() => setEditing(false)}>
                  {t.common.cancel}
                </Button>
              )}
            </div>
            {!c && <p className="text-[13px] text-slate-500">{t.agent.noStore}</p>}
          </form>
        )}
      </div>
    </Card>
  );
}

function PermissionsCard({ consultantId, data }: { consultantId: string; data: AgentOverview }) {
  const { t } = useI18n();
  const save = useSaveSettings(consultantId);
  const [limit, setLimit] = useState(String(data.settings.refundAutoLimit));
  const connected = Boolean(data.connection);
  const perms = data.settings.permissions;
  const rows: { key: keyof AgentPermissions; needsStore: boolean }[] = [
    { key: 'catalog', needsStore: true },
    { key: 'orderStatus', needsStore: true },
    { key: 'createOrders', needsStore: false },
    { key: 'cancelOrders', needsStore: true },
    { key: 'returns', needsStore: false },
    { key: 'notify', needsStore: true },
  ];
  return (
    <Card>
      <CardHeader icon={<PackageCheck className="size-5" />} title={t.agent.permissionsTitle} subtitle={t.agent.permissionsSubtitle} />
      <div className="divide-y divide-slate-100">
        {rows.map(({ key, needsStore }) => (
          <div key={key} className="px-5 py-4">
            <Switch
              checked={perms[key]}
              disabled={save.isPending}
              onChange={(v) => save.mutate({ permissions: { [key]: v } })}
              label={t.agent.perms[key].label}
              description={
                <>
                  {t.agent.perms[key].text}
                  {needsStore && !connected && <span className="mt-1 block text-amber-700">{t.agent.needsStore}</span>}
                </>
              }
            />
            {key === 'returns' && perms.returns && (
              <form
                className="mt-3 flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const value = Math.max(0, Number(limit) || 0);
                  save.mutate({ refundAutoLimit: value });
                }}
              >
                <Field label={t.agent.refundLimit} hint={t.agent.refundLimitHint} className="max-w-xs flex-1">
                  {(id) => (
                    <Input id={id} type="number" min={0} step="0.01" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} />
                  )}
                </Field>
                <Button type="submit" variant="secondary" loading={save.isPending} className="mb-[26px]">
                  {t.common.save}
                </Button>
              </form>
            )}
          </div>
        ))}
      </div>
      <p className="border-t border-slate-100 px-5 py-4 text-[13px] text-slate-500">{t.agent.safety}</p>
    </Card>
  );
}

const KIND_ICON = { create_order: PackageCheck, cancel_order: PackageX, refund: RotateCcw, notify: Truck } as const;
const STATUS_TONE: Record<AgentAction['status'], 'slate' | 'green' | 'amber' | 'rose' | 'brand'> = {
  awaiting_customer: 'slate',
  awaiting_owner: 'amber',
  done: 'green',
  failed: 'rose',
  rejected: 'slate',
  expired: 'slate',
  simulated: 'brand',
};

function ActionsCard({ consultantId }: { consultantId: string }) {
  const { t, locale } = useI18n();
  const actions = useAgentActions(consultantId);
  const [filter, setFilter] = useState<'owner' | 'all'>('owner');
  const qc = useQueryClient();
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) =>
      api<{ action: AgentAction; delivered: boolean }>(`/consultants/${consultantId}/agent/actions/${id}/${approve ? 'approve' : 'reject'}`, {
        method: 'POST',
        body: approve ? {} : { reason },
      }),
    onSuccess: (r, v) => {
      toast.success(v.approve ? t.agent.approved : t.agent.declined, { description: r.delivered ? t.agent.customerTold : t.agent.customerNotTold });
      setDeclining(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: keys.agentActions(consultantId) });
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const all = actions.data ?? [];
  const pending = all.filter((a) => a.status === 'awaiting_owner');
  const list = filter === 'owner' ? pending : all;

  return (
    <Card>
      <CardHeader
        title={t.agent.actionsTitle}
        subtitle={t.agent.actionsSubtitle}
        action={
          <Tabs
            value={filter}
            onChange={setFilter}
            items={[
              { value: 'owner', label: t.agent.filterOwner, count: pending.length },
              { value: 'all', label: t.agent.filterAll },
            ]}
          />
        }
      />
      {actions.isLoading ? (
        <div className="p-5">
          <PageLoader />
        </div>
      ) : !list.length ? (
        <EmptyState icon={<PackageCheck className="size-6" />} title={filter === 'owner' ? t.agent.nothingPending : t.agent.noActions} text={t.agent.noActionsText} />
      ) : (
        <ul className="divide-y divide-slate-100">
          {list.map((a) => {
            const Icon = KIND_ICON[a.kind];
            return (
              <li key={a.id} className="flex gap-4 px-5 py-4">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                  <Icon className="size-[18px]" aria-hidden />
                </div>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900">{t.agent.kinds[a.kind]}</span>
                    {a.externalRef && <span className="font-mono text-[13px] text-slate-500">#{a.externalRef.replace(/^#/, '')}</span>}
                    <Badge tone={STATUS_TONE[a.status]}>{t.agent.statuses[a.status]}</Badge>
                    {a.channel === 'playground' && <Badge>{t.agent.testChat}</Badge>}
                  </div>
                  <p className="text-[13px] leading-snug whitespace-pre-wrap text-slate-600">{a.summary}</p>
                  {a.error && <p className="text-[13px] text-rose-700">{a.error}</p>}
                  <p className="flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
                    {a.channel && a.channel !== 'playground' && <ChannelGlyph channel={a.channel} className="size-3.5" />}
                    {a.customerName ?? t.agent.customer}
                    <span aria-hidden>·</span>
                    {relativeTime(a.createdAt, locale)}
                    {a.conversationId && a.channel !== 'playground' && (
                      <Link to={`/app/c/${consultantId}/conversations?open=${a.conversationId}`} className="inline-flex items-center gap-1 text-brand-700 hover:underline">
                        {t.agent.openChat} <ExternalLink className="size-3" aria-hidden />
                      </Link>
                    )}
                  </p>
                  {a.status === 'awaiting_owner' &&
                    (declining === a.id ? (
                      <form
                        className="flex flex-wrap items-center gap-2 pt-1"
                        onSubmit={(e) => {
                          e.preventDefault();
                          decide.mutate({ id: a.id, approve: false });
                        }}
                      >
                        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t.agent.declineReason} className="h-9 min-w-56 flex-1 text-sm" maxLength={500} />
                        <Button type="submit" size="sm" variant="danger" loading={decide.isPending}>
                          {t.agent.decline}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeclining(null)}>
                          {t.common.cancel}
                        </Button>
                      </form>
                    ) : (
                      <div className="flex flex-wrap gap-2 pt-1">
                        <Button size="sm" icon={<Check className="size-4" />} loading={decide.isPending && decide.variables?.id === a.id} onClick={() => decide.mutate({ id: a.id, approve: true })}>
                          {a.kind === 'refund' ? t.agent.approveRefund : t.agent.approve}
                        </Button>
                        <Button size="sm" variant="secondary" icon={<Ban className="size-4" />} onClick={() => setDeclining(a.id)}>
                          {t.agent.decline}
                        </Button>
                      </div>
                    ))}
                </div>
                {a.amount !== null && (
                  <div className="shrink-0 text-right text-sm font-semibold text-slate-900 tabular-nums">
                    {fmt(t.agent.amount, { amount: a.amount.toLocaleString(locale), currency: a.currency ?? '' }).trim()}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
