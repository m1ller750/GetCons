import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { api, ApiError, errorText } from '../lib/api';
import { fmt, useI18n } from '../lib/i18n';
import { keys, useMe, useTemplates } from '../lib/queries';
import type { BotRequest, Channel, Consultant } from '../lib/types';
import { isTouchDevice, navigateTab, openPendingTab } from './BotCreation';
import { ChannelChoice } from './Channels';
import { Alert, Button, Field, Input, Select, Textarea } from './ui';

export const LANGUAGE_OPTIONS = ['auto', 'English', 'Russian', 'Ukrainian', 'Kazakh', 'Uzbek', 'Spanish', 'German'] as const;

/** Handed to the overview, which then connects the chosen messenger straight away. */
export interface ConnectIntent {
  channel: Channel;
  /** WhatsApp on a phone: the work number for the pairing code */
  phone?: string;
}

/**
 * One-click consultant creation: pick the messenger, name the business, press the button.
 * Everything else has sensible defaults and sits under "More settings".
 */
export function CreateConsultantForm({ onCreated }: { onCreated?: () => void }) {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const templates = useTemplates();
  const [form, setForm] = useState({
    businessName: '',
    name: lang === 'ru' ? 'Анна' : 'Alex',
    template: 'general',
    description: '',
    language: 'auto',
    botToken: '',
    phone: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<Channel>('whatsapp');

  const me = useMe();
  const touch = isTouchDevice();
  const telegram = channel === 'telegram';
  const web = channel === 'web';
  const oneClick = telegram && Boolean(me.data?.managerBot.enabled) && !form.botToken.trim();

  const create = useMutation({
    // Phones continue in Telegram: open the tab inside the click so it isn't blocked.
    onMutate: () => ({ tab: oneClick && touch ? openPendingTab() : null }),
    mutationFn: () =>
      api<{ consultant: Consultant; telegramError: string | null; botRequest: BotRequest | null }>('/consultants', {
        method: 'POST',
        body: {
          name: form.name.trim() || 'Alex',
          businessName: form.businessName.trim() || undefined,
          description: form.description.trim() || undefined,
          template: form.template,
          language: form.language,
          botToken: (telegram && form.botToken.trim()) || undefined,
          createBot: oneClick,
        },
      }),
    onSuccess: async ({ consultant, telegramError, botRequest }, _v, context) => {
      // Website chat: switched on right away, so the link and the widget code are ready.
      if (web) await api(`/consultants/${consultant.id}/web`, { method: 'POST', body: { enabled: true } }).catch(() => undefined);
      void qc.invalidateQueries({ queryKey: keys.consultants });
      void qc.invalidateQueries({ queryKey: keys.me });
      if (botRequest) qc.setQueryData(['botRequest', consultant.id], botRequest);
      navigateTab(context?.tab ?? null, botRequest?.link ?? null);
      if (telegramError) toast.warning(fmt(t.create.tokenFailed, { error: telegramError }));
      else toast.success(botRequest ? t.oneClick.createdOpenTelegram : telegram ? t.create.created : web ? t.channels.createdWeb : t.channels.createdWhatsApp);
      onCreated?.();
      // The overview opens on the chosen messenger and connects it right away.
      const intent: ConnectIntent = { channel, ...(form.phone.trim() ? { phone: form.phone.trim() } : {}) };
      navigate(`/app/c/${consultant.id}`, { state: { connect: intent } });
    },
    onError: (err, _v, context) => {
      context?.tab?.close();
      setError(err instanceof ApiError && err.code === 'limit_reached' ? t.create.limit : errorText(err));
    },
  });

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    create.mutate();
  };

  const tokenField = (hint: string) => (
    <Field label={t.create.botToken} hint={hint} optional>
      {(id) => (
        <Input id={id} value={form.botToken} onChange={set('botToken')} placeholder="123456789:AAE..." autoComplete="off" spellCheck={false} className="font-mono text-sm" />
      )}
    </Field>
  );

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert tone="error">{error}</Alert>}
      <div>
        <p className="mb-2 text-sm font-medium text-slate-800">{t.channels.title}</p>
        <ChannelChoice value={channel} onChange={setChannel} />
      </div>
      <Field label={t.create.businessName}>
        {(id) => <Input id={id} value={form.businessName} onChange={set('businessName')} placeholder={t.create.businessNamePlaceholder} maxLength={200} autoFocus />}
      </Field>
      {/* On a phone the QR code can't be scanned by the same phone: WhatsApp links by a code for the number instead. */}
      {channel === 'whatsapp' && touch && (
        <Field label={t.whatsapp.phone} hint={t.whatsapp.phoneHint}>
          {(id) => <Input id={id} type="tel" inputMode="tel" autoComplete="tel" value={form.phone} onChange={set('phone')} placeholder={t.whatsapp.phonePlaceholder} />}
        </Field>
      )}
      <details className="rounded-lg border border-slate-200 px-4 py-3 text-sm">
        <summary className="cursor-pointer font-medium text-slate-700">{t.create.more}</summary>
        <div className="mt-4 space-y-4">
          <Field label={t.create.template}>
            {(id) => (
              <Select id={id} value={form.template} onChange={set('template')}>
                {(templates.data?.templates ?? [{ id: 'general', label: 'General' }]).map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {t.templates[tpl.id as keyof typeof t.templates] ?? tpl.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t.create.description} optional>
            {(id) => <Textarea id={id} rows={3} value={form.description} onChange={set('description')} placeholder={t.create.descriptionPlaceholder} maxLength={8000} />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t.create.consultantName} hint={t.create.consultantNameHint}>
              {(id) => <Input id={id} value={form.name} onChange={set('name')} maxLength={80} />}
            </Field>
            <Field label={t.create.language}>
              {(id) => (
                <Select id={id} value={form.language} onChange={set('language')}>
                  {LANGUAGE_OPTIONS.map((l) => (
                    <option key={l} value={l}>
                      {t.languages[l]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          {telegram && tokenField(me.data?.managerBot.enabled ? t.oneClick.haveBotHint : t.create.botTokenHint)}
        </div>
      </details>
      <Button type="submit" size="lg" className="w-full" loading={create.isPending} icon={<Plus className="size-5" />}>
        {create.isPending ? t.create.creating : web ? t.channels.createWithWeb : !telegram ? t.channels.createWithWhatsApp : oneClick ? t.oneClick.createWithBot : t.create.submit}
      </Button>
      <p className="text-center text-[13px] text-slate-500">
        {web ? t.channels.webFormHint : !telegram ? t.channels.whatsappFormHint : oneClick ? t.oneClick.formHint : t.create.tokenHintShort}
      </p>
    </form>
  );
}
