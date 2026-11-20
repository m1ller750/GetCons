import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Link2Off, QrCode, RefreshCw, ShieldAlert, Smartphone, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, errorText } from '../lib/api';
import { phone as formatPhone, relativeTime } from '../lib/format';
import { fmt, useI18n } from '../lib/i18n';
import { keys, useInvalidateConsultant, useWhatsApp } from '../lib/queries';
import type { Consultant, WhatsAppView } from '../lib/types';
import { isTouchDevice, Qr } from './BotCreation';
import { ChannelGlyph, ChannelTile } from './brand';
import { Alert, Button, Card, CopyButton, Field, Input, Spinner, cx, useConfirm } from './ui';

type Method = 'qr' | 'code';

/**
 * WhatsApp in one click: the owner links a *work* number the way WhatsApp Web is linked
 * (Linked devices), by scanning a QR code or typing an 8-character code on the phone.
 * Shows the step-by-step guide, the live code, and the connected number afterwards.
 * `autoStart` (right after creating a consultant) skips the button: a computer shows the QR code at
 * once; a phone, which can't scan its own screen, gets the code for its number.
 */
export function WhatsAppConnectPanel({ consultant, autoStart, initialPhone }: { consultant: Consultant; autoStart?: boolean; initialPhone?: string }) {
  const { t, locale } = useI18n();
  const w = t.whatsapp;
  const qc = useQueryClient();
  const confirm = useConfirm();
  const invalidate = useInvalidateConsultant();
  const state = useWhatsApp(consultant.id);
  const touch = isTouchDevice();
  const [method, setMethod] = useState<Method>(touch ? 'code' : 'qr');
  const [phone, setPhone] = useState(initialPhone ?? '');
  const announced = useRef(false);
  const started = useRef(false);
  const view = state.data;
  const phoneOk = phone.replace(/\D/g, '').length >= 8;

  const connect = useMutation({
    mutationFn: () =>
      api<{ whatsapp: WhatsAppView }>(`/consultants/${consultant.id}/whatsapp/connect`, {
        method: 'POST',
        body: { method, ...(method === 'code' ? { phone: phone.trim() } : {}) },
      }),
    onSuccess: ({ whatsapp }) => {
      announced.current = false;
      qc.setQueryData(keys.whatsapp(consultant.id), whatsapp);
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const unlink = useMutation({
    mutationFn: () => api(`/consultants/${consultant.id}/whatsapp`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate(consultant.id);
      void state.refetch();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  // Straight after creation: start linking without waiting for a click.
  useEffect(() => {
    if (!autoStart || started.current || !view?.enabled || connect.isPending) return;
    if (!['disconnected', 'logged_out'].includes(view.status)) return;
    if (method === 'code' && !phoneOk) return;
    started.current = true;
    connect.mutate();
  }, [autoStart, view, method, phoneOk, connect]);

  // Linking finished on the phone: refresh the consultant and celebrate once.
  useEffect(() => {
    if (view?.status === 'connected' && !consultant.whatsapp.connected && !announced.current) {
      announced.current = true;
      invalidate(consultant.id);
      toast.success(fmt(w.liveToast, { phone: formatPhone(view.phone) }));
    }
  }, [view, consultant.whatsapp.connected, consultant.id, invalidate, w.liveToast]);

  if (state.isLoading || !view) {
    return (
      <Card className="flex justify-center p-8">
        <Spinner />
      </Card>
    );
  }
  if (!view.enabled) return <Alert tone="warning">{w.disabled}</Alert>;

  const unlinkButton = (label = w.unlink) => (
    <Button
      variant="danger-ghost"
      icon={<Link2Off className="size-4" />}
      loading={unlink.isPending}
      onClick={async () => {
        if (await confirm({ title: w.unlink, text: w.unlinkConfirm, danger: true, confirmLabel: w.unlink })) {
          unlink.mutate(undefined, { onSuccess: () => toast.success(w.unlinked) });
        }
      }}
    >
      {label}
    </Button>
  );

  // ---- Connected ------------------------------------------------------------
  if (view.status === 'connected' || view.status === 'connecting') {
    return (
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-4">
          <ChannelTile channel="whatsapp" className="size-12" />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-sm text-slate-500">
              {view.status === 'connected' ? <CheckCircle2 className="size-4 text-emerald-500" aria-hidden /> : <Spinner className="size-4" />}
              {view.status === 'connected' ? w.liveTitle : w.reconnecting}
            </p>
            <p className="text-lg font-semibold text-slate-900">
              {formatPhone(view.phone ?? consultant.whatsapp.phone) || w.linkedAs}
              {view.name && <span className="font-normal text-slate-500"> · {view.name}</span>}
            </p>
            {view.connectedAt && <p className="text-xs text-slate-500">{relativeTime(view.connectedAt, locale)}</p>}
          </div>
          {view.phone && (
            <a
              href={`https://wa.me/${view.phone.replace(/\D/g, '')}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#25d366] px-4 text-sm font-medium text-white hover:opacity-90"
            >
              {w.openChat}
            </a>
          )}
        </div>
        <p className="mt-4 text-[13px] leading-relaxed text-slate-500">
          {w.deviceName} {w.keepOnline}
        </p>
        <div className="mt-3">{unlinkButton()}</div>
      </Card>
    );
  }

  // ---- Waiting for the phone --------------------------------------------------
  if (view.status === 'pairing') {
    const code = view.pairingCode;
    return (
      <Card className="overflow-hidden">
        <div className="grid gap-6 p-6 md:grid-cols-[auto_1fr] md:items-center">
          <div className="flex flex-col items-center gap-2 text-center">
            {view.qr ? (
              <Qr value={view.qr} className="size-56" label={w.scanTitle} />
            ) : code ? (
              <div className="rounded-2xl bg-slate-900 px-6 py-5">
                <p className="font-mono text-[2rem] font-semibold tracking-[0.18em] text-white" aria-label={code.split('').join(' ')}>
                  {code}
                </p>
              </div>
            ) : (
              <div className="flex size-56 items-center justify-center rounded-xl bg-slate-50">
                <Spinner />
              </div>
            )}
            {view.qr && <p className="text-xs text-slate-500">{w.qrRefresh}</p>}
            {code && <CopyButton value={code.replace('-', '')} />}
          </div>
          <div>
            <p className="inline-flex items-center gap-2 text-sm font-medium text-brand-700">
              <Spinner className="size-4" /> {w.waiting}
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-900">{code ? w.codeTitle : w.scanTitle}</h2>
            {code && <p className="mt-2 text-[15px] font-medium text-slate-700">{w.codeNotification}</p>}
            <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[15px] text-slate-600">
              {(code ? w.codeSteps : w.scanSteps).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <div className="mt-5 flex flex-wrap gap-2">
              {code && touch && (
                <a
                  href="whatsapp://"
                  className="inline-flex h-11 items-center gap-2 rounded-lg bg-[#25d366] px-5 text-[15px] font-semibold text-white shadow-sm hover:opacity-90"
                >
                  <ChannelGlyph channel="whatsapp" className="size-5" /> {w.openWhatsApp}
                </a>
              )}
              <Button variant="secondary" icon={<RefreshCw className="size-4" />} loading={connect.isPending} onClick={() => connect.mutate()}>
                {w.newCode}
              </Button>
              <Button variant="ghost" icon={<X className="size-4" />} loading={unlink.isPending} onClick={() => unlink.mutate()}>
                {w.cancel}
              </Button>
            </div>
          </div>
        </div>
      </Card>
    );
  }

  // ---- Step-by-step guide -------------------------------------------------------
  const submit = (e: FormEvent) => {
    e.preventDefault();
    connect.mutate();
  };
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-4 border-b border-slate-100 p-5">
        <ChannelTile channel="whatsapp" className="size-12" />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-slate-900">{w.title}</h2>
          <p className="mt-0.5 text-sm text-slate-500">{w.subtitle}</p>
        </div>
      </div>
      <div className="grid gap-6 p-5 lg:grid-cols-[1.15fr_1fr]">
        <div className="space-y-4">
          {view.status === 'logged_out' && <Alert tone="warning">{w.loggedOut}</Alert>}
          {view.error === 'expired' && <Alert tone="warning">{w.expired}</Alert>}
          {view.status === 'error' && view.error && <Alert tone="error">{view.error}</Alert>}
          <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{w.stepsTitle}</p>
          <ol className="space-y-4">
            {w.steps.map((s, i) => (
              <li key={s.title} className="flex gap-3">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-sm font-semibold text-brand-700">{i + 1}</span>
                <div>
                  <p className="font-medium text-slate-800">{s.title}</p>
                  <p className="mt-0.5 text-sm leading-relaxed text-slate-500">{s.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <form onSubmit={submit} className="order-first space-y-4 rounded-xl bg-slate-50 p-5 lg:order-last">
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-white p-1 ring-1 ring-slate-200" role="radiogroup" aria-label={w.stepsTitle}>
            {(['qr', 'code'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={method === m}
                onClick={() => setMethod(m)}
                className={cx(
                  'inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors',
                  method === m ? 'bg-brand-600 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100',
                )}
              >
                {m === 'qr' ? <QrCode className="size-4" aria-hidden /> : <Smartphone className="size-4" aria-hidden />}
                {m === 'qr' ? w.methodQr : w.methodCode}
              </button>
            ))}
          </div>
          {method === 'code' && (
            <Field label={w.phone} hint={w.phoneHint}>
              {(id) => (
                <Input id={id} type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={w.phonePlaceholder} required />
              )}
            </Field>
          )}
          <Button
            type="submit"
            size="lg"
            className="w-full !bg-[#25d366] hover:!bg-[#1fb957]"
            loading={connect.isPending}
            disabled={method === 'code' && !phoneOk}
            icon={<ChannelGlyph channel="whatsapp" className="size-5" />}
          >
            {connect.isPending ? w.connecting : w.connect}
          </Button>
          <div className="flex gap-2.5 rounded-lg bg-amber-50 p-3 text-[13px] leading-relaxed text-amber-900 ring-1 ring-amber-200">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              <span className="font-semibold">{w.warningTitle}.</span> {w.warning}
            </p>
          </div>
        </form>
      </div>
    </Card>
  );
}
