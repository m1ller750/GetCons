import { clsx } from 'clsx';
import { Languages } from 'lucide-react';
import { Link } from 'react-router';
import { useI18n } from '../lib/i18n';
import type { Channel, ConsultantStatus } from '../lib/types';
import { Badge } from './ui';

export const CHANNEL_NAMES: Record<Channel, string> = { whatsapp: 'WhatsApp', telegram: 'Telegram', web: 'Website' };

/** Channel glyph: a chat bubble with a handset (WhatsApp), a paper plane (Telegram) or a browser window (website). */
export function ChannelGlyph({ channel, className }: { channel: Channel; className?: string }) {
  if (channel === 'web') {
    return (
      <svg viewBox="0 0 24 24" className={clsx('size-5', className)} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
        <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
        <path d="M3 9h18" />
        <circle cx="6.2" cy="6.8" r=".6" fill="currentColor" stroke="none" />
        <circle cx="8.4" cy="6.8" r=".6" fill="currentColor" stroke="none" />
        <path d="M8 13.2h8M8 16h5" strokeLinecap="round" />
      </svg>
    );
  }
  if (channel === 'whatsapp') {
    return (
      <svg viewBox="0 0 24 24" className={clsx('size-5', className)} aria-hidden>
        <path d="M12 3.2a8.8 8.8 0 0 0-7.6 13.2L3.2 20.8l4.5-1.2A8.8 8.8 0 1 0 12 3.2z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path
          d="M9.2 8.1c.2-.4.4-.4.7-.4h.5c.2 0 .4.1.5.4l.7 1.6c.1.2 0 .5-.1.6l-.5.6c.4.9 1.2 1.8 2.2 2.2l.6-.5c.2-.1.4-.2.6-.1l1.6.7c.3.1.4.3.4.5v.5c0 .3-.1.6-.4.8-.6.4-1.6.6-3-.1a8.2 8.2 0 0 1-3.6-3.6c-.6-1.3-.6-2.3-.2-3.2z"
          fill="currentColor"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="10 16 42 34" className={clsx('size-5', className)} aria-hidden>
      <path
        d="M18 31.5 45.5 20.6c1.4-.5 2.6.3 2.2 2.4l-4.7 22c-.3 1.6-1.3 2-2.6 1.2l-7.1-5.2-3.4 3.3c-.4.4-.7.7-1.4.7l.5-7.3 13.2-11.9c.6-.5-.1-.8-.9-.3L23.1 35.8l-7-2.2c-1.5-.5-1.5-1.5-.1-2.1Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** The messenger's own colour, so customers' channels are recognisable at a glance. */
export function ChannelTile({ channel, className }: { channel: Channel; className?: string }) {
  return (
    <div
      className={clsx(
        'flex size-10 shrink-0 items-center justify-center rounded-xl text-white',
        channel === 'whatsapp' ? 'bg-[#25d366]' : channel === 'telegram' ? 'bg-[#2aabee]' : 'bg-ink',
        className,
      )}
    >
      <ChannelGlyph channel={channel} className={channel === 'telegram' ? 'size-5' : 'size-6'} />
    </div>
  );
}

/**
 * The mark: a "G" drawn as an open ring with a crossbar, on an ink tile, with one small square
 * in the corner, like the last message in a chat. Solid colours only.
 */
export function LogoMark({ className, inverted }: { className?: string; inverted?: boolean }) {
  return (
    <svg viewBox="0 0 64 64" className={clsx('size-8', className)} aria-hidden>
      <rect width="64" height="64" rx="15" fill={inverted ? '#fff' : '#17181c'} />
      <path d="M41.6 20.5A15 15 0 1 0 47 32H34" fill="none" stroke={inverted ? '#17181c' : '#fff'} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="45" y="45" width="8" height="8" rx="2" fill="#7c5cff" />
    </svg>
  );
}

export function Logo({ to = '/', className, dark }: { to?: string; className?: string; dark?: boolean }) {
  return (
    <Link to={to} className={clsx('inline-flex items-center gap-2.5 rounded-lg', className)}>
      <LogoMark inverted={dark} />
      <span className={clsx('text-[17px] font-semibold tracking-[-0.02em]', dark ? 'text-white' : 'text-ink')}>GetCons</span>
    </Link>
  );
}

/** EN / RU switch shown on every page. */
export function LanguageSwitch({ className, compact, dark }: { className?: string; compact?: boolean; dark?: boolean }) {
  const { lang, setLang, t } = useI18n();
  return (
    <div
      className={clsx('inline-flex items-center gap-1 rounded-lg p-1', dark ? 'bg-white/10' : 'bg-slate-100', className)}
      role="group"
      aria-label={t.common.switchLanguage}
    >
      {!compact && <Languages className={clsx('mx-1 size-4', dark ? 'text-white/60' : 'text-slate-500')} aria-hidden />}
      {(['en', 'ru'] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
          className={clsx(
            'min-h-8 min-w-9 cursor-pointer rounded-md px-2 text-xs font-semibold tracking-wide uppercase transition-colors',
            dark
              ? lang === l
                ? 'bg-white text-black'
                : 'text-white/60 hover:text-white'
              : lang === l
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-800',
          )}
        >
          {l === 'en' ? 'EN' : 'RU'}
        </button>
      ))}
    </div>
  );
}

export function ConsultantStatusBadge({ status }: { status: ConsultantStatus }) {
  const { t } = useI18n();
  const tone = { draft: 'slate', active: 'green', paused: 'amber', error: 'rose' } as const;
  return (
    <Badge tone={tone[status]} dot>
      {t.status[status]}
    </Badge>
  );
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const palette = ['bg-sky-100 text-sky-700', 'bg-violet-100 text-violet-700', 'bg-emerald-100 text-emerald-700', 'bg-amber-100 text-amber-800', 'bg-rose-100 text-rose-700', 'bg-brand-100 text-brand-700'];
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const parts = name.trim().split(/\s+/);
  const letters = ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
  return (
    <div className={clsx('flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold', palette[hash % palette.length], className)} aria-hidden>
      {letters}
    </div>
  );
}
