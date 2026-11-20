import { useMutation } from '@tanstack/react-query';
import { Download, ExternalLink, RefreshCw } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, errorText } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useInvalidateConsultant } from '../lib/queries';
import type { Consultant } from '../lib/types';
import { ChannelTile } from './brand';
import { Badge, Button, Card, CardHeader, CopyButton, Tabs, useConfirm } from './ui';

type Guide = 'any' | 'tilda' | 'wordpress' | 'shopify' | 'wix';
const GUIDES: Guide[] = ['any', 'tilda', 'wordpress', 'shopify', 'wix'];

/** Website chat: a shareable link with a QR code, and one line of code for any site. */
export function WebChannelPanel({ consultant, compact }: { consultant: Consultant; compact?: boolean }) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const invalidate = useInvalidateConsultant();
  const [guide, setGuide] = useState<Guide>('any');
  const [qr, setQr] = useState<string | null>(null);
  const web = consultant.web;

  useEffect(() => {
    if (!web.link) return setQr(null);
    let alive = true;
    void QRCode.toDataURL(web.link, { margin: 1, width: 320, color: { dark: '#17181c', light: '#ffffff' } }).then((url) => alive && setQr(url));
    return () => {
      alive = false;
    };
  }, [web.link]);

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api(`/consultants/${consultant.id}/web`, { method: 'POST', body: { enabled } }),
    onSuccess: (_r, enabled) => {
      toast.success(enabled ? t.web.enabledToast : t.web.disabledToast);
      invalidate(consultant.id);
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const rotate = useMutation({
    mutationFn: () => api(`/consultants/${consultant.id}/web/rotate`, { method: 'POST' }),
    onSuccess: () => invalidate(consultant.id),
    onError: (err) => toast.error(errorText(err)),
  });

  if (!web.enabled) {
    return (
      <Card>
        <div className="flex flex-wrap items-center gap-4 p-5">
          <ChannelTile channel="web" className="size-12" />
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-slate-900">{t.web.title}</h3>
            <p className="mt-0.5 text-sm text-slate-500">{t.web.subtitle}</p>
          </div>
          <Button loading={toggle.isPending} onClick={() => toggle.mutate(true)}>
            {t.web.turnOn}
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        icon={<ChannelTile channel="web" className="size-8 rounded-lg" />}
        title={t.web.title}
        subtitle={compact ? undefined : t.web.subtitle}
        action={<Badge tone="green" dot>{t.web.on}</Badge>}
      />
      <div className="space-y-6 p-5">
        <div className="grid gap-5 md:grid-cols-[1fr_auto]">
          <div className="space-y-2">
            <p className="text-sm font-semibold text-slate-900">{t.web.link}</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-slate-50 px-3 py-2 font-mono text-[13px] text-slate-800 ring-1 ring-slate-200">{web.link}</code>
              <CopyButton value={web.link ?? ''} />
              <a href={web.link ?? '#'} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-slate-700 ring-1 ring-slate-300 ring-inset hover:bg-slate-50">
                {t.common.open} <ExternalLink className="size-3.5" aria-hidden />
              </a>
            </div>
            <p className="text-[13px] text-slate-500">{t.web.linkHint}</p>
          </div>
          {qr && (
            <div className="flex items-center gap-3 md:flex-col md:items-center">
              <img src={qr} alt={t.web.qr} className="size-28 rounded-lg ring-1 ring-slate-200" />
              <a href={qr} download="getcons-chat-qr.png" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-brand-700 hover:underline">
                <Download className="size-3.5" aria-hidden /> {t.web.download}
              </a>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-slate-900">{t.web.widget}</p>
            <CopyButton value={web.widgetSnippet ?? ''} />
          </div>
          <pre className="overflow-x-auto rounded-lg bg-ink px-4 py-3 font-mono text-[12.5px] text-slate-100 scroll-thin">{web.widgetSnippet}</pre>
          <p className="text-[13px] text-slate-500">{t.web.widgetHint}</p>
        </div>

        <div className="space-y-3">
          <p className="text-sm font-semibold text-slate-900">{t.web.install}</p>
          <Tabs value={guide} onChange={setGuide} items={GUIDES.map((g) => ({ value: g, label: t.web.guides[g].name }))} />
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-slate-600 marker:text-slate-400">
            {t.web.guides[guide].steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw className="size-4" />}
            loading={rotate.isPending}
            onClick={async () => {
              if (await confirm({ title: t.web.rotate, text: t.web.rotateConfirm, confirmLabel: t.web.rotate })) rotate.mutate();
            }}
          >
            {t.web.rotate}
          </Button>
          <Button variant="danger-ghost" size="sm" loading={toggle.isPending} onClick={() => toggle.mutate(false)}>
            {t.web.turnOff}
          </Button>
        </div>
      </div>
    </Card>
  );
}
