import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, CheckCircle2, ExternalLink, Link2, RefreshCw, Send, Smartphone } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, errorText } from '../lib/api';
import { fmt, useI18n } from '../lib/i18n';
import { useBotRequest, useInvalidateConsultant } from '../lib/queries';
import type { BotRequest } from '../lib/types';
import { Alert, Button, Card, Spinner } from './ui';

export function Qr({ value, className = 'size-44', label = '' }: { value: string; className?: string; label?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void QRCode.toDataURL(value, { margin: 1, width: 480, color: { dark: '#0f172a', light: '#ffffff' } }).then((url) => alive && setSrc(url));
    return () => {
      alive = false;
    };
  }, [value]);
  return src ? (
    <img src={src} alt={label} className={`${className} rounded-xl ring-1 ring-slate-200`} />
  ) : (
    <div className={`${className} animate-pulse rounded-xl bg-slate-100`} />
  );
}

/** Phones and tablets: Telegram/WhatsApp run on this very device, so we open them instead of showing a QR. */
export function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches && window.matchMedia('(hover: none)').matches;
}

/** Opens a tab synchronously (inside the click) so popup blockers allow it, then points it at Telegram. */
export function openPendingTab(): Window | null {
  try {
    return window.open('', '_blank');
  } catch {
    return null;
  }
}

export function navigateTab(tab: Window | null, url: string | null) {
  if (!tab) return;
  if (url) tab.location.href = url;
  else tab.close();
}

/**
 * One-click Telegram bot creation with Telegram's own "create bot" sheet (Telegram always asks the
 * owner to confirm): a QR code on the page for computers (scan, tap Create on the phone), Telegram
 * itself on phones. The page notices the new bot and updates by itself.
 */
export function BotCreationPanel({ consultantId, connectedUsername }: { consultantId: string; connectedUsername?: string | null }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const invalidate = useInvalidateConsultant();
  const request = useBotRequest(consultantId, true);
  const announced = useRef<string | null>(null);
  const r = request.data;
  const touch = isTouchDevice();

  const create = useMutation({
    // Phones go to Telegram: open the tab inside the click so it isn't blocked.
    onMutate: () => ({ tab: touch ? openPendingTab() : null }),
    mutationFn: () => api<{ request: BotRequest }>(`/consultants/${consultantId}/telegram/create-bot`, { method: 'POST' }),
    onSuccess: (result, _v, context) => {
      qc.setQueryData(['botRequest', consultantId], result.request);
      navigateTab(context?.tab ?? null, result.request?.link ?? null);
    },
    onError: (err, _v, context) => {
      context?.tab?.close();
      toast.error(errorText(err));
    },
  });

  useEffect(() => {
    if (r?.status === 'completed' && r.botUsername && announced.current !== r.id) {
      announced.current = r.id;
      invalidate(consultantId);
      void qc.invalidateQueries({ queryKey: ['telegram', consultantId] });
      toast.success(fmt(t.oneClick.liveToast, { bot: r.botUsername }));
    }
  }, [r, consultantId, invalidate, qc, t]);

  if (request.isLoading) {
    return (
      <Card className="flex justify-center p-8">
        <Spinner />
      </Card>
    );
  }

  const liveUsername = connectedUsername ?? (r?.status === 'completed' ? r.botUsername : null);
  if (liveUsername) {
    return (
      <Card className="flex flex-wrap items-center gap-4 p-5">
        <div className="flex size-12 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
          <CheckCircle2 className="size-6" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-slate-500">{t.oneClick.liveTitle}</p>
          <p className="text-lg font-semibold text-slate-900">@{liveUsername}</p>
        </div>
        <a href={`https://t.me/${liveUsername}`} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#2aabee] px-4 text-sm font-medium text-white hover:opacity-90">
          <ExternalLink className="size-4" aria-hidden /> {t.oneClick.openBot}
        </a>
      </Card>
    );
  }

  if (r?.status === 'pending' && r.link) {
    return (
      <Card className="overflow-hidden">
        <div className="grid gap-6 p-6 md:grid-cols-[auto_1fr] md:items-center">
          {!touch && (
            <div className="flex flex-col items-center gap-2 text-center">
              <Qr value={r.link} className="size-52" label={t.oneClick.scan} />
              <p className="flex items-center gap-1.5 text-xs text-slate-500">
                <Smartphone className="size-3.5" aria-hidden /> {t.oneClick.scan}
              </p>
            </div>
          )}
          <div>
            <p className="inline-flex items-center gap-2 text-sm font-medium text-brand-700">
              <Spinner className="size-4" /> {t.oneClick.waiting}
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-900">{touch ? t.oneClick.confirmTitle : t.oneClick.scanTitle}</h2>
            <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[15px] text-slate-600">
              <li>{touch ? t.oneClick.step1 : t.oneClick.scanStep1}</li>
              <li>{t.oneClick.step3}</li>
            </ol>
            <div className="mt-5 flex flex-wrap gap-2">
              <a
                href={r.link}
                target="_blank"
                rel="noreferrer"
                className={
                  touch
                    ? 'inline-flex h-12 items-center gap-2 rounded-lg bg-[#2aabee] px-6 text-base font-semibold text-white shadow-sm hover:opacity-90'
                    : 'inline-flex h-10 items-center gap-2 rounded-lg bg-white px-4 text-sm font-medium text-slate-800 ring-1 ring-slate-300 ring-inset hover:bg-slate-50'
                }
              >
                <Bot className="size-5" aria-hidden /> {touch ? t.oneClick.openTelegram : t.oneClick.openDesktop}
              </a>
              <Button variant="ghost" icon={<RefreshCw className="size-4" />} onClick={() => create.mutate()} loading={create.isPending}>
                {t.oneClick.newLink}
              </Button>
            </div>
            {r.fallbackLink && (
              <div className="mt-5 rounded-lg bg-slate-50 p-4 text-[13px] text-slate-600 ring-1 ring-slate-200 ring-inset">
                <p className="flex items-center gap-2 font-medium text-slate-800">
                  <Link2 className="size-4 shrink-0" aria-hidden /> {t.oneClick.notOpening}
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  <li>{t.oneClick.notOpeningUpdate}</li>
                  <li>{t.oneClick.notOpeningChat}</li>
                </ul>
                <a
                  href={r.fallbackLink}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg bg-white px-3 text-sm font-medium text-slate-800 ring-1 ring-slate-300 ring-inset hover:bg-slate-50"
                >
                  <ExternalLink className="size-4" aria-hidden /> {t.oneClick.openChat}
                </a>
              </div>
            )}
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      {r?.status === 'failed' && (
        <div className="mb-4">
          <Alert tone="error">{fmt(t.oneClick.failed, { error: r.error ?? '' })}</Alert>
        </div>
      )}
      {r?.status === 'expired' && (
        <div className="mb-4">
          <Alert tone="warning">{t.oneClick.expired}</Alert>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-5">
        <div className="flex size-12 items-center justify-center rounded-xl bg-tg text-white">
          <Send className="size-6" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-slate-900">{t.oneClick.title}</h2>
          <p className="mt-0.5 text-sm text-slate-500">{t.oneClick.subtitle}</p>
        </div>
        <Button size="lg" icon={<Bot className="size-5" />} loading={create.isPending} onClick={() => create.mutate()}>
          {t.oneClick.button}
        </Button>
      </div>
    </Card>
  );
}
