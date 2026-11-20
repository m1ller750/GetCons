import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../lib/i18n';
import { useMe } from '../lib/queries';
import type { Channel, Consultant } from '../lib/types';
import { BotCreationPanel } from './BotCreation';
import type { ConnectIntent } from './CreateConsultant';
import { CHANNEL_NAMES, ChannelTile } from './brand';
import { Card, CardHeader, cx } from './ui';
import { WebChannelPanel } from './WebChannel';
import { WhatsAppConnectPanel } from './WhatsAppConnect';

/** Where customers write: WhatsApp (a linked work number), Telegram (a new bot) or the website (widget + link). */
export function ChannelChoice({ value, onChange }: { value: Channel; onChange: (c: Channel) => void }) {
  const { t } = useI18n();
  return (
    <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label={t.channels.title}>
      {(['whatsapp', 'telegram', 'web'] as const).map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          onClick={() => onChange(c)}
          className={cx(
            'flex cursor-pointer items-start gap-3 rounded-xl border-2 p-4 text-left transition-colors',
            value === c ? 'border-ink bg-white' : 'border-slate-200 bg-white hover:border-slate-300',
          )}
        >
          <ChannelTile channel={c} />
          <span className="min-w-0">
            <span className="block font-semibold text-slate-900">{CHANNEL_NAMES[c]}</span>
            <span className="mt-0.5 block text-[13px] leading-snug text-slate-500">{c === 'whatsapp' ? t.channels.whatsappText : c === 'telegram' ? t.channels.telegramText : t.channels.webText}</span>
          </span>
          <span
            className={cx('ml-auto mt-0.5 size-4 shrink-0 rounded-full border-2', value === c ? 'border-ink bg-ink ring-2 ring-white ring-inset' : 'border-slate-300')}
            aria-hidden
          />
        </button>
      ))}
    </div>
  );
}

/** Shown on the overview while no messenger is connected: pick one and connect it right here. */
export function ChannelSetup({ consultant, intent }: { consultant: Consultant; intent?: ConnectIntent | null }) {
  const { t } = useI18n();
  const me = useMe();
  const [channel, setChannel] = useState<Channel>(intent?.channel ?? 'whatsapp');
  return (
    <Card>
      <CardHeader title={t.channels.connectTitle} subtitle={t.channels.connectSubtitle} />
      <div className="space-y-4 p-5">
        <ChannelChoice value={channel} onChange={setChannel} />
        {channel === 'web' ? (
          <WebChannelPanel consultant={consultant} compact />
        ) : channel === 'whatsapp' ? (
          // Just created with WhatsApp chosen: the QR code (or the code for the number) starts at once.
          <WhatsAppConnectPanel consultant={consultant} autoStart={intent?.channel === 'whatsapp'} initialPhone={intent?.phone} />
        ) : me.data?.managerBot.enabled ? (
          <BotCreationPanel consultantId={consultant.id} />
        ) : (
          <Link
            to={`/app/c/${consultant.id}/settings?tab=channels`}
            className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            {t.channels.telegramToken} <ArrowRight className="size-4" aria-hidden />
          </Link>
        )}
      </div>
    </Card>
  );
}
