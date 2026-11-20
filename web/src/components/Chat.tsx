import { Bot, FileText, GraduationCap, Image as ImageIcon, Mic, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { duration, renderLight, timeOfDay } from '../lib/format';
import { fmt, useI18n } from '../lib/i18n';
import type { Message } from '../lib/types';
import { Badge, cx } from './ui';

export function RichText({ text }: { text: string }) {
  return (
    <p className="text-[14.5px] leading-relaxed break-words whitespace-pre-wrap">
      {renderLight(text).map((s, i) =>
        s.type === 'bold' ? <strong key={i}>{s.value}</strong> : s.type === 'italic' ? <em key={i}>{s.value}</em> : <span key={i}>{s.value}</span>,
      )}
    </p>
  );
}

const STATUS_TONE = { ok: 'green', fallback: 'amber', handoff: 'violet', error: 'rose', failed: 'rose', skipped: 'slate' } as const;

/** One chat bubble. Business-side messages (AI, team) are on the right. */
export function MessageBubble({ message, onImprove, showDetails = true }: { message: Message; onImprove?: (m: Message) => void; showDetails?: boolean }) {
  const { t, locale } = useI18n();
  const m = message;
  const business = m.role === 'assistant' || m.role === 'operator';
  const media = m.meta?.media?.kind;
  const sources = m.meta?.knowledge ?? [];

  let author: ReactNode;
  if (m.role === 'assistant') author = <span className="inline-flex items-center gap-1"><Bot className="size-3.5" aria-hidden />{t.conversations.consultant}</span>;
  else if (m.role === 'operator') author = <span className="inline-flex items-center gap-1"><UserRound className="size-3.5" aria-hidden />{m.meta?.author ?? t.conversations.operator}</span>;
  else author = t.conversations.customer;

  return (
    <div className={cx('flex', business ? 'justify-end' : 'justify-start')}>
      <div className={cx('flex max-w-[88%] flex-col sm:max-w-[75%]', business ? 'items-end' : 'items-start')}>
        <div
          className={cx(
            'rounded-2xl px-3.5 py-2.5 shadow-sm',
            m.role === 'customer' && 'rounded-bl-md bg-white text-slate-800 ring-1 ring-slate-200',
            m.role === 'assistant' && 'rounded-br-md bg-brand-600 text-white',
            m.role === 'operator' && 'rounded-br-md bg-emerald-600 text-white',
            m.status === 'failed' && 'opacity-70',
          )}
        >
          {media && (
            <p className={cx('mb-1 inline-flex items-center gap-1 text-xs', business ? 'text-white/80' : 'text-slate-500')}>
              {media === 'voice' || media === 'audio' ? <Mic className="size-3.5" aria-hidden /> : media === 'document' ? <FileText className="size-3.5" aria-hidden /> : <ImageIcon className="size-3.5" aria-hidden />}
              {media}
            </p>
          )}
          <RichText text={m.content} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[11.5px] text-slate-500">
          <span>{author}</span>
          <span aria-hidden>·</span>
          <time dateTime={m.created_at}>{timeOfDay(m.created_at, locale)}</time>
          {m.role === 'assistant' && m.status !== 'ok' && (
            <Badge tone={STATUS_TONE[m.status]}>{t.status[m.status as keyof typeof t.status] ?? m.status}</Badge>
          )}
          {showDetails && m.role === 'assistant' && m.meta?.latency_ms !== undefined && <span>{duration(m.meta.latency_ms)}</span>}
          {showDetails && m.role === 'assistant' && onImprove && m.meta?.question && (
            <button type="button" onClick={() => onImprove(m)} className="inline-flex cursor-pointer items-center gap-1 font-medium text-brand-700 hover:underline">
              <GraduationCap className="size-3.5" aria-hidden /> {t.conversations.improve}
            </button>
          )}
        </div>
        {showDetails && m.role === 'assistant' && (sources.length > 0 || (m.meta?.examples?.length ?? 0) > 0) && (
          <div className="mt-1 flex max-w-full flex-wrap justify-end gap-1 px-1">
            {sources
              .filter((s, i, arr) => arr.findIndex((x) => x.document_id === s.document_id) === i)
              .slice(0, 4)
              .map((s) => (
                <span key={s.id} className={cx('inline-flex max-w-52 items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-[11px]', s.cited ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-500')} title={`${s.title} · ${Math.round(s.similarity * 100)}%`}>
                  <FileText className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">{s.title}</span>
                </span>
              ))}
            {(m.meta?.examples?.length ?? 0) > 0 && (
              <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">{fmt(t.conversations.examplesUsed, { count: m.meta.examples!.length })}</span>
            )}
          </div>
        )}
        {m.status === 'failed' && m.meta?.send_error && <p className="mt-1 px-1 text-[11.5px] text-rose-600">{m.meta.send_error}</p>}
      </div>
    </div>
  );
}

export function TypingBubble() {
  return (
    <div className="flex justify-end">
      <div className="flex items-center gap-1 rounded-2xl rounded-br-md bg-brand-100 px-4 py-3" aria-label="typing">
        {[0, 150, 300].map((d) => (
          <span key={d} className="size-1.5 animate-bounce rounded-full bg-brand-500" style={{ animationDelay: `${d}ms` }} />
        ))}
      </div>
    </div>
  );
}
