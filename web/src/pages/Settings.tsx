import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, BellRing, Bot, CheckCircle2, ExternalLink, KeyRound, Link2Off, Lock, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { LANGUAGE_OPTIONS } from '../components/CreateConsultant';
import { Alert, Badge, Button, Card, CardHeader, CopyButton, Field, Input, PageHeader, PageLoader, Select, Switch, Tabs, Textarea, cx, useConfirm } from '../components/ui';
import { api, errorText } from '../lib/api';
import { phone, relativeTime } from '../lib/format';
import { fmt, useI18n } from '../lib/i18n';
import { useConsultant, useInvalidateConsultant, useMe, useTelegramStatus } from '../lib/queries';
import { BotCreationPanel } from '../components/BotCreation';
import { ChannelTile } from '../components/brand';
import { WebChannelPanel } from '../components/WebChannel';
import { WhatsAppConnectPanel } from '../components/WhatsAppConnect';
import type { BusinessInfo, Consultant } from '../lib/types';

type Tab = 'persona' | 'business' | 'channels' | 'danger';

function SaveBar({ dirty, saving, onSave, onReset }: { dirty: boolean; saving: boolean; onSave: () => void; onReset: () => void }) {
  const { t } = useI18n();
  return (
    <div
      className={cx(
        'sticky bottom-4 z-10 mt-6 flex items-center justify-between gap-3 rounded-xl border bg-white/95 px-4 py-3 shadow-pop backdrop-blur transition-all',
        dirty ? 'border-brand-200 opacity-100' : 'pointer-events-none translate-y-2 border-transparent opacity-0',
      )}
      aria-hidden={!dirty}
    >
      <p className="text-sm font-medium text-slate-700">{t.common.unsavedChanges}</p>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={onReset} disabled={saving}>
          {t.common.discard}
        </Button>
        <Button onClick={onSave} loading={saving}>
          {saving ? t.common.saving : t.common.save}
        </Button>
      </div>
    </div>
  );
}

function useSettingsForm<T extends object>(initial: T, consultantId: string, toBody: (v: T) => Record<string, unknown>) {
  const { t } = useI18n();
  const invalidate = useInvalidateConsultant();
  const [value, setValue] = useState<T>(initial);
  const initialJson = JSON.stringify(initial);
  useEffect(() => setValue(JSON.parse(initialJson) as T), [initialJson]);
  const dirty = JSON.stringify(value) !== initialJson;
  const save = useMutation({
    mutationFn: () => api(`/consultants/${consultantId}`, { method: 'PATCH', body: toBody(value) }),
    onSuccess: () => {
      toast.success(t.common.saved);
      invalidate(consultantId);
    },
    onError: (err) => toast.error(errorText(err)),
  });
  return { value, setValue, dirty, save, reset: () => setValue(JSON.parse(initialJson) as T) };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} />
      <div className="space-y-5 p-5">{children}</div>
    </Card>
  );
}

function PersonaTab({ c }: { c: Consultant }) {
  const { t } = useI18n();
  const initial = useMemo(
    () => ({
      name: c.name,
      tone: c.tone,
      language: c.language,
      use_emojis: c.use_emojis,
      instructions: c.instructions,
      strictness: c.strictness,
      greeting_message: c.greeting_message,
      fallback_message: c.fallback_message,
      handoff_enabled: c.handoff_enabled,
      temperature: c.temperature,
      max_history_messages: c.max_history_messages,
    }),
    [c],
  );
  const form = useSettingsForm(initial, c.id, (v) => ({ ...v, temperature: Math.round(v.temperature * 100) / 100 }));
  const v = form.value;
  const set = <K extends keyof typeof v>(key: K, value: (typeof v)[K]) => form.setValue({ ...v, [key]: value });
  const languages = LANGUAGE_OPTIONS.includes(v.language as (typeof LANGUAGE_OPTIONS)[number]) ? LANGUAGE_OPTIONS : [...LANGUAGE_OPTIONS, v.language];

  return (
    <div className="space-y-6">
      <Section title={t.settings.personaTitle}>
        <div className="grid gap-5 sm:grid-cols-3">
          <Field label={t.settings.name}>{(id) => <Input id={id} value={v.name} onChange={(e) => set('name', e.target.value)} maxLength={80} />}</Field>
          <Field label={t.settings.tone}>
            {(id) => (
              <Select id={id} value={v.tone} onChange={(e) => set('tone', e.target.value as Consultant['tone'])}>
                {(Object.keys(t.settings.tones) as (keyof typeof t.settings.tones)[]).map((tone) => (
                  <option key={tone} value={tone}>
                    {t.settings.tones[tone]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t.settings.language}>
            {(id) => (
              <Select id={id} value={v.language} onChange={(e) => set('language', e.target.value)}>
                {languages.map((l) => (
                  <option key={l} value={l}>
                    {t.languages[l as keyof typeof t.languages] ?? l}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Switch checked={v.use_emojis} onChange={(x) => set('use_emojis', x)} label={t.settings.emojis} description={t.settings.emojisHint} />
        <Field label={t.settings.instructions} hint={t.settings.instructionsHint} aside={<span className="text-xs text-slate-400 tabular-nums">{v.instructions.length}/12000</span>}>
          {(id) => <Textarea id={id} rows={8} value={v.instructions} onChange={(e) => set('instructions', e.target.value)} placeholder={t.settings.instructionsPlaceholder} maxLength={12000} />}
        </Field>
      </Section>

      <Section title={t.settings.behaviourTitle}>
        <fieldset>
          <legend className="text-sm font-medium text-slate-800">{t.settings.strictness}</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {(['balanced', 'strict'] as const).map((s) => (
              <label key={s} className={cx('flex cursor-pointer gap-3 rounded-xl border p-3.5 text-sm', v.strictness === s ? 'border-brand-400 bg-brand-50/50' : 'border-slate-200 hover:border-slate-300')}>
                <input type="radio" name="strictness" className="mt-0.5 size-4 accent-brand-600" checked={v.strictness === s} onChange={() => set('strictness', s)} />
                <span className="text-slate-700">{t.settings[s]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field label={t.settings.greeting} hint={t.settings.greetingHint}>
          {(id) => <Textarea id={id} rows={2} value={v.greeting_message} onChange={(e) => set('greeting_message', e.target.value)} maxLength={2000} />}
        </Field>
        <Field label={t.settings.fallback} hint={t.settings.fallbackHint}>
          {(id) => <Textarea id={id} rows={2} value={v.fallback_message} onChange={(e) => set('fallback_message', e.target.value)} maxLength={2000} />}
        </Field>
        <Switch checked={v.handoff_enabled} onChange={(x) => set('handoff_enabled', x)} label={t.settings.handoff} description={t.settings.handoffHint} />
      </Section>

      <Section title={t.settings.advanced}>
        <div className="grid gap-6 sm:grid-cols-2">
          <Field label={`${t.settings.temperature}: ${v.temperature.toFixed(2)}`} hint={t.settings.temperatureHint}>
            {(id) => <input id={id} type="range" min={0} max={1.2} step={0.05} value={v.temperature} onChange={(e) => set('temperature', Number(e.target.value))} className="w-full accent-brand-600" />}
          </Field>
          <Field label={`${t.settings.history}: ${v.max_history_messages}`} hint={fmt(t.settings.historyHint, { count: v.max_history_messages })}>
            {(id) => <input id={id} type="range" min={4} max={60} step={2} value={v.max_history_messages} onChange={(e) => set('max_history_messages', Number(e.target.value))} className="w-full accent-brand-600" />}
          </Field>
        </div>
      </Section>

      <SaveBar dirty={form.dirty} saving={form.save.isPending} onSave={() => form.save.mutate()} onReset={form.reset} />
    </div>
  );
}

const BUSINESS_FIELDS: { key: keyof BusinessInfo; rows: number }[] = [
  { key: 'businessName', rows: 1 },
  { key: 'description', rows: 4 },
  { key: 'products', rows: 5 },
  { key: 'pricing', rows: 5 },
  { key: 'hours', rows: 2 },
  { key: 'location', rows: 2 },
  { key: 'contacts', rows: 2 },
  { key: 'delivery', rows: 3 },
  { key: 'policies', rows: 4 },
  { key: 'website', rows: 1 },
  { key: 'extra', rows: 3 },
];

function BusinessTab({ c }: { c: Consultant }) {
  const { t } = useI18n();
  const initial = useMemo(() => Object.fromEntries(BUSINESS_FIELDS.map(({ key }) => [key, c.business_info?.[key] ?? ''])) as Record<keyof BusinessInfo, string>, [c]);
  const form = useSettingsForm(initial, c.id, (v) => ({
    business_info: Object.fromEntries(Object.entries(v).map(([k, val]) => [k, val.trim()]).filter(([, val]) => val)),
  }));

  return (
    <div>
      <Card>
        <CardHeader title={t.settings.businessTitle} subtitle={t.settings.businessSubtitle} />
        <div className="grid gap-5 p-5 md:grid-cols-2">
          {BUSINESS_FIELDS.map(({ key, rows }) => (
            <Field key={key} label={t.settings.fields[key]} className={rows > 2 ? 'md:col-span-2' : undefined}>
              {(id) =>
                rows === 1 ? (
                  <Input id={id} value={form.value[key]} onChange={(e) => form.setValue({ ...form.value, [key]: e.target.value })} maxLength={key === 'website' ? 1000 : 200} />
                ) : (
                  <Textarea id={id} rows={rows} value={form.value[key]} onChange={(e) => form.setValue({ ...form.value, [key]: e.target.value })} maxLength={8000} />
                )
              }
            </Field>
          ))}
        </div>
      </Card>
      <SaveBar dirty={form.dirty} saving={form.save.isPending} onSave={() => form.save.mutate()} onReset={form.reset} />
    </div>
  );
}

function ChannelsTab({ c }: { c: Consultant }) {
  const { t, locale } = useI18n();
  const confirm = useConfirm();
  const invalidate = useInvalidateConsultant();
  const status = useTelegramStatus(c.id, c.telegram.connected);
  const me = useMe();
  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const ownerNotifications = c.telegram.ownerNotifications || c.whatsapp.ownerNotifications;
  const anyChannel = c.telegram.connected || c.whatsapp.connected || c.web.enabled;

  const connect = useMutation({
    mutationFn: () => api(`/consultants/${c.id}/telegram`, { method: 'POST', body: { botToken: token.trim() } }),
    onSuccess: () => {
      toast.success(t.settings.connected);
      setToken('');
      setReplacing(false);
      invalidate(c.id);
      void status.refetch();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const disconnect = useMutation({
    mutationFn: () => api(`/consultants/${c.id}/telegram`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(t.settings.disconnected);
      invalidate(c.id);
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const link = useMutation({
    mutationFn: () => api<{ code: string; command: string }>(`/consultants/${c.id}/owner-link`, { method: 'POST' }),
    onSuccess: (r) => setLinkCode(r.command),
    onError: (err) => toast.error(errorText(err)),
  });
  const unlink = useMutation({
    mutationFn: () => api(`/consultants/${c.id}/owner-link`, { method: 'DELETE' }),
    onSuccess: () => invalidate(c.id),
  });

  // While waiting for the owner to send /connect, poll until notifications switch on.
  useEffect(() => {
    if (!linkCode || ownerNotifications) {
      if (ownerNotifications) setLinkCode(null);
      return;
    }
    const timer = setInterval(() => invalidate(c.id), 3000);
    return () => clearInterval(timer);
  }, [linkCode, ownerNotifications, c.id, invalidate]);

  const tokenForm = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        connect.mutate();
      }}
      className="space-y-3"
    >
      <Field label={t.settings.token} hint={<span className="inline-flex items-center gap-1"><Lock className="size-3.5" aria-hidden /> {t.settings.tokenSafety}</span>}>
        {(id) => (
          <div className="flex gap-2">
            <Input id={id} value={token} onChange={(e) => setToken(e.target.value)} placeholder={t.settings.tokenPlaceholder} autoComplete="off" spellCheck={false} className="font-mono text-sm" />
            <Button type="submit" loading={connect.isPending} disabled={!token.trim()} icon={<KeyRound className="size-4" />}>
              {connect.isPending ? t.settings.connecting : t.settings.connect}
            </Button>
          </div>
        )}
      </Field>
    </form>
  );

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="flex items-center gap-2.5 text-base font-semibold text-slate-900">
          <ChannelTile channel="whatsapp" className="size-8 rounded-lg" /> WhatsApp
        </h2>
        <WhatsAppConnectPanel consultant={c} />
      </section>

      <WebChannelPanel consultant={c} />

      <Card>
        <CardHeader
          icon={<ChannelTile channel="telegram" className="size-8 rounded-lg" />}
          title={t.settings.telegramTitle}
          action={c.telegram.connected ? <Badge tone="green" dot>{t.status.active}</Badge> : <Badge>{t.settings.notConnected}</Badge>}
        />
        <div className="space-y-5 p-5">
          {c.telegram.connected ? (
            <>
              <div className="flex flex-wrap items-center gap-4 rounded-xl bg-slate-50 p-4">
                <div className="flex size-12 items-center justify-center rounded-xl bg-tg text-white">
                  <Bot className="size-6" aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-slate-500">{t.settings.connectedAs}</p>
                  <p className="font-semibold text-slate-900">
                    {c.telegram.botName} · @{c.telegram.botUsername}
                  </p>
                  <p className="text-xs text-slate-500">{relativeTime(c.telegram.connectedAt, locale)}</p>
                </div>
                <a
                  href={`https://t.me/${c.telegram.botUsername}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white px-3 text-sm font-medium text-slate-800 ring-1 ring-slate-300 ring-inset hover:bg-slate-50"
                >
                  <ExternalLink className="size-4" aria-hidden /> {t.common.open}
                </a>
              </div>
              <dl className="grid gap-4 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-slate-500">{t.settings.mode}</dt>
                  <dd className="mt-0.5 font-medium text-slate-800">{t.settings.modes[c.telegram.mode]}</dd>
                </div>
                {status.data?.webhook && (
                  <div>
                    <dt className="text-xs text-slate-500">{t.settings.pending}</dt>
                    <dd className="mt-0.5 font-medium text-slate-800 tabular-nums">{status.data.webhook.pendingUpdates}</dd>
                  </div>
                )}
              </dl>
              {status.data?.problem || status.data?.webhook?.lastErrorMessage ? (
                <Alert tone="warning" icon={<AlertTriangle className="size-5" />} title={t.settings.lastError}>
                  {status.data.problem ?? status.data.webhook?.lastErrorMessage}
                </Alert>
              ) : status.data ? (
                <p className="flex items-center gap-2 text-sm text-emerald-700">
                  <CheckCircle2 className="size-4" aria-hidden /> {t.settings.healthy}
                </p>
              ) : null}
              {replacing && tokenForm}
              <div className="flex flex-wrap gap-2">
                {!replacing && (
                  <Button variant="secondary" icon={<KeyRound className="size-4" />} onClick={() => setReplacing(true)}>
                    {t.settings.replaceToken}
                  </Button>
                )}
                <Button
                  variant="danger-ghost"
                  icon={<Link2Off className="size-4" />}
                  loading={disconnect.isPending}
                  onClick={async () => {
                    if (await confirm({ title: t.settings.disconnect, text: t.settings.disconnectConfirm, danger: true, confirmLabel: t.settings.disconnect })) disconnect.mutate();
                  }}
                >
                  {t.settings.disconnect}
                </Button>
              </div>
            </>
          ) : me.data?.managerBot.enabled ? (
            <>
              <BotCreationPanel consultantId={c.id} />
              <details className="rounded-xl border border-slate-200 px-4 py-3">
                <summary className="cursor-pointer text-sm font-medium text-slate-700">{t.oneClick.haveBot}</summary>
                <div className="mt-4">{tokenForm}</div>
              </details>
            </>
          ) : (
            <>
              <div className="rounded-xl bg-slate-50 p-4">
                <p className="text-sm font-semibold text-slate-800">{t.settings.botfather}</p>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-600">
                  {t.settings.botfatherSteps.map((s) => (
                    <li key={s}>
                      {s.includes('@BotFather') ? (
                        <>
                          {s.split('@BotFather')[0]}
                          <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline">
                            @BotFather
                          </a>
                          {s.split('@BotFather')[1]}
                        </>
                      ) : (
                        s
                      )}
                    </li>
                  ))}
                </ol>
              </div>
              {tokenForm}
            </>
          )}
        </div>
      </Card>

      {anyChannel && (
        <Card>
          <CardHeader
            icon={<BellRing className="size-5" />}
            title={t.settings.notifyTitle}
            subtitle={t.settings.notifySubtitle}
            action={ownerNotifications ? <Badge tone="green" dot>{t.settings.notifyOn}</Badge> : <Badge>{t.settings.notifyOff}</Badge>}
          />
          <div className="space-y-4 p-5">
            {ownerNotifications ? (
              <Button variant="secondary" onClick={() => unlink.mutate()} loading={unlink.isPending}>
                {t.settings.notifyDisable}
              </Button>
            ) : linkCode ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded-lg bg-slate-900 px-3 py-2 font-mono text-sm text-white">{linkCode}</code>
                  <CopyButton value={linkCode} />
                </div>
                {c.telegram.connected && (
                  <div className="space-y-2">
                    <p className="text-sm text-slate-600">{fmt(t.settings.notifyStep, { bot: c.telegram.botUsername ?? '' })}</p>
                    <a
                      href={`https://t.me/${c.telegram.botUsername}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#2aabee] px-3 text-sm font-medium text-white hover:opacity-90"
                    >
                      <ExternalLink className="size-4" aria-hidden /> {fmt(t.settings.notifyOpenBot, { bot: c.telegram.botUsername ?? '' })}
                    </a>
                  </div>
                )}
                {c.whatsapp.connected && c.whatsapp.phone && (
                  <div className="space-y-2">
                    <p className="text-sm text-slate-600">{fmt(t.settings.notifyStepWhatsApp, { phone: phone(c.whatsapp.phone) })}</p>
                    <a
                      href={`https://wa.me/${c.whatsapp.phone.replace(/\D/g, '')}?text=${encodeURIComponent(linkCode)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#25d366] px-3 text-sm font-medium text-white hover:opacity-90"
                    >
                      <ExternalLink className="size-4" aria-hidden /> {t.settings.notifyOpenWhatsApp}
                    </a>
                  </div>
                )}
                <p className="text-xs text-slate-500">{t.settings.notifyWaiting}</p>
              </div>
            ) : (
              <Button icon={<BellRing className="size-4" />} onClick={() => link.mutate()} loading={link.isPending}>
                {t.settings.notifyEnable}
              </Button>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

function DangerTab({ c }: { c: Consultant }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const invalidate = useInvalidateConsultant();
  const [typed, setTyped] = useState('');
  const remove = useMutation({
    mutationFn: () => api(`/consultants/${c.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(t.settings.deletedToast);
      invalidate(c.id);
      navigate('/app', { replace: true });
    },
    onError: (err) => toast.error(errorText(err)),
  });
  return (
    <Card className="border-rose-200">
      <CardHeader icon={<ShieldAlert className="size-5 text-rose-600" />} title={t.settings.dangerTitle} subtitle={t.settings.dangerText} />
      <div className="space-y-4 p-5">
        <Field label={fmt(t.settings.dangerConfirm, { name: c.name })}>{(id) => <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}</Field>
        <Button variant="danger" disabled={typed !== c.name} loading={remove.isPending} onClick={() => remove.mutate()}>
          {t.settings.deleteButton}
        </Button>
      </div>
    </Card>
  );
}

export function SettingsPage() {
  const { consultantId = '' } = useParams();
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab') === 'telegram' ? 'channels' : params.get('tab'); // old links
  const tab = (['persona', 'business', 'channels', 'danger'].includes(requested ?? '') ? requested : 'persona') as Tab;
  const details = useConsultant(consultantId);
  if (details.isLoading) return <PageLoader />;
  if (!details.data) return <Alert tone="error">{errorText(details.error)}</Alert>;
  const c = details.data.consultant;

  return (
    <div>
      <PageHeader title={t.settings.title} />
      <Tabs<Tab>
        className="mb-6 w-fit max-w-full"
        value={tab}
        onChange={(v) => setParams({ tab: v }, { replace: true })}
        items={[
          { value: 'persona', label: t.settings.tabs.persona },
          { value: 'business', label: t.settings.tabs.business },
          { value: 'channels', label: t.settings.tabs.channels },
          { value: 'danger', label: t.settings.tabs.danger },
        ]}
      />
      {tab === 'persona' && <PersonaTab c={c} />}
      {tab === 'business' && <BusinessTab c={c} />}
      {tab === 'channels' && <ChannelsTab c={c} />}
      {tab === 'danger' && <DangerTab c={c} />}
    </div>
  );
}
