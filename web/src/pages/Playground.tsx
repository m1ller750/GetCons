import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileText, FlaskConical, Info, RotateCcw, Send } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { toast } from 'sonner';
import { MessageBubble, TypingBubble } from '../components/Chat';
import { Alert, Badge, Button, Card, EmptyState, Input, PageHeader, Spinner, cx } from '../components/ui';
import { api, errorText } from '../lib/api';
import { duration } from '../lib/format';
import { fmt, useI18n } from '../lib/i18n';
import { keys, usePlayground } from '../lib/queries';
import type { Message, MessageMeta } from '../lib/types';

interface PlaygroundReply {
  message: Message;
  status: string;
  meta: MessageMeta;
  needsAttention: boolean;
  attentionReason: string | null;
}

function Details({ reply }: { reply: PlaygroundReply }) {
  const { t } = useI18n();
  const m = reply.meta;
  const status = (m.answer_status ?? 'none') as keyof typeof t.playground.answerStatus;
  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <Info className="size-4 text-brand-600" aria-hidden /> {t.playground.details}
      </h2>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-slate-500">{t.playground.status}</dt>
          <dd className="mt-0.5 font-medium text-slate-900">{t.playground.answerStatus[status] ?? status}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">{t.playground.confidence}</dt>
          <dd className="mt-0.5 font-medium text-slate-900">{m.confidence !== undefined ? `${Math.round(m.confidence * 100)}%` : '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">{t.playground.latency}</dt>
          <dd className="mt-0.5 font-medium text-slate-900">{duration(m.latency_ms)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-slate-500">{t.playground.model}</dt>
          <dd className="mt-0.5 truncate font-medium text-slate-900" title={m.model}>
            {m.model ?? '—'}
          </dd>
        </div>
      </dl>
      {reply.needsAttention && reply.attentionReason && (
        <div className="mt-4">
          <Alert tone="warning">{fmt(t.playground.attention, { reason: reply.attentionReason })}</Alert>
        </div>
      )}
      {m.error && (
        <div className="mt-4">
          <Alert tone="error">{m.error}</Alert>
        </div>
      )}
      <h3 className="mt-5 text-xs font-medium tracking-wide text-slate-500 uppercase">{t.playground.knowledgeUsed}</h3>
      {m.knowledge?.length ? (
        <ul className="mt-2 space-y-1.5">
          {m.knowledge.map((k) => (
            <li key={k.id} className="flex items-center gap-2 text-sm">
              <FileText className="size-4 shrink-0 text-slate-400" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-slate-700">{k.title}</span>
              <span className="text-xs text-slate-400 tabular-nums">{Math.round(k.similarity * 100)}%</span>
              {k.cited && (
                <Badge tone="green">
                  <CheckCircle2 className="size-3" aria-hidden /> {t.playground.cited}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-slate-500">{t.playground.noKnowledge}</p>
      )}
      {(m.examples?.length ?? 0) > 0 && <p className="mt-3 text-sm text-slate-600">{fmt(t.conversations.examplesUsed, { count: m.examples!.length })}</p>}
    </Card>
  );
}

export function PlaygroundPage() {
  const { consultantId = '' } = useParams();
  const { t } = useI18n();
  const qc = useQueryClient();
  const history = usePlayground(consultantId);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [last, setLast] = useState<PlaygroundReply | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const send = useMutation({
    mutationFn: (value: string) => api<PlaygroundReply>(`/consultants/${consultantId}/playground`, { method: 'POST', body: { text: value } }),
    onMutate: (value) => {
      setPending(value);
      setText('');
    },
    onSuccess: (reply) => {
      setLast(reply);
      void qc.invalidateQueries({ queryKey: keys.playground(consultantId) }).then(() => setPending(null));
    },
    onError: (err, value) => {
      setPending(null);
      setText(value);
      toast.error(errorText(err));
    },
  });
  const reset = useMutation({
    mutationFn: () => api(`/consultants/${consultantId}/playground/reset`, { method: 'POST' }),
    onSuccess: () => {
      setLast(null);
      toast.success(t.playground.resetDone);
      void qc.invalidateQueries({ queryKey: keys.playground(consultantId) });
    },
  });

  const messages = history.data ?? [];
  // After a reload, explain the latest stored answer.
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const shown: PlaygroundReply | null =
    last ??
    (lastAssistant
      ? {
          message: lastAssistant,
          status: lastAssistant.status,
          meta: lastAssistant.meta,
          needsAttention: Boolean(lastAssistant.meta.attention_reason),
          attentionReason: lastAssistant.meta.attention_reason ?? null,
        }
      : null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages.length, pending]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const value = text.trim();
    if (value && !send.isPending) send.mutate(value);
  };

  return (
    <div>
      <PageHeader
        title={t.playground.title}
        subtitle={t.playground.subtitle}
        actions={
          <Button variant="secondary" icon={<RotateCcw className="size-4" />} onClick={() => reset.mutate()} loading={reset.isPending}>
            {t.playground.reset}
          </Button>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card className="flex h-[calc(100dvh-14rem)] min-h-[480px] flex-col overflow-hidden">
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-slate-50 px-3 py-5 sm:px-6 scroll-thin">
            {history.isLoading ? (
              <div className="flex justify-center py-10">
                <Spinner />
              </div>
            ) : !messages.length && !pending ? (
              <EmptyState icon={<FlaskConical className="size-6" />} title={t.playground.empty} />
            ) : (
              messages.map((m) => <MessageBubble key={m.id} message={m} />)
            )}
            {pending && (
              <>
                {!messages.some((m) => m.role === 'customer' && m.content === pending && Date.now() - new Date(m.created_at).getTime() < 60_000) && (
                  <MessageBubble message={{ id: 'pending', conversation_id: '', role: 'customer', content: pending, status: 'ok', meta: {}, created_at: new Date().toISOString() }} showDetails={false} />
                )}
                {send.isPending && <TypingBubble />}
              </>
            )}
            <div ref={bottomRef} />
          </div>
          <div className="border-t border-slate-100 bg-white p-3 sm:p-4">
            {!messages.length && !pending && (
              <div className="mb-3 flex flex-wrap gap-2">
                {t.playground.suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => send.mutate(s)}
                    className="min-h-9 cursor-pointer rounded-full border border-slate-200 bg-white px-3 text-sm text-slate-700 hover:border-brand-300 hover:bg-brand-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            <form onSubmit={submit} className="flex gap-2">
              <Input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t.playground.placeholder}
                aria-label={t.playground.placeholder}
                maxLength={4000}
                disabled={send.isPending}
                autoFocus
              />
              <Button type="submit" loading={send.isPending} disabled={!text.trim()} icon={<Send className="size-4" />} aria-label={t.conversations.send}>
                <span className="hidden sm:inline">{t.conversations.send}</span>
              </Button>
            </form>
          </div>
        </Card>
        <div className={cx('space-y-4', !shown && 'hidden lg:block')}>
          {shown ? (
            <Details reply={shown} />
          ) : (
            <Card className="p-5 text-sm text-slate-500">
              <p className="flex items-center gap-2 font-semibold text-slate-900">
                <Info className="size-4 text-brand-600" aria-hidden /> {t.playground.details}
              </p>
              <p className="mt-2">{t.playground.subtitle}</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
