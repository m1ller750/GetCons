import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Brain, CheckCircle2, MessagesSquare, RotateCcw, Search, Send, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Avatar, CHANNEL_NAMES, ChannelGlyph } from '../components/brand';
import { MessageBubble } from '../components/Chat';
import { TeachModal } from '../components/TeachModal';
import { Alert, Badge, Button, Card, EmptyState, IconButton, Input, Spinner, Switch, Tabs, Textarea, cx, useConfirm } from '../components/ui';
import { api, errorText } from '../lib/api';
import { dateLabel, phone, relativeTime } from '../lib/format';
import { fmt, useI18n } from '../lib/i18n';
import { keys, useConsultant, useConversation, useConversations } from '../lib/queries';
import type { Conversation, Message } from '../lib/types';

type Filter = 'all' | 'attention' | 'ai_off';

/** "@maria" in Telegram; in WhatsApp the username field holds the phone number. */
const handleOf = (c: Conversation) =>
  c.customer_username && c.channel !== 'web' ? (c.channel === 'whatsapp' ? phone(c.customer_username) : `@${c.customer_username}`) : null;
const displayName = (c: Conversation) =>
  c.customer_name || handleOf(c) || (c.channel === 'web' ? `Visitor ${String(c.external_chat_id).slice(-4)}` : `#${c.external_chat_id}`);
const profileLink = (c: Conversation) =>
  !c.customer_username || c.channel === 'web' ? null : c.channel === 'whatsapp' ? `https://wa.me/${c.customer_username.replace(/\D/g, '')}` : `https://t.me/${c.customer_username}`;

function ChannelMark({ c }: { c: Conversation }) {
  if (c.channel === 'playground') return null;
  return (
    <span
      title={CHANNEL_NAMES[c.channel]}
      className={cx(
        'absolute -right-0.5 -bottom-0.5 flex size-[18px] items-center justify-center rounded-full text-white ring-2 ring-white',
        c.channel === 'whatsapp' ? 'bg-[#25d366]' : c.channel === 'telegram' ? 'bg-[#2aabee]' : 'bg-ink',
      )}
    >
      <ChannelGlyph channel={c.channel} className="size-3" />
    </span>
  );
}

function ConversationList({ consultantId, selected, onSelect }: { consultantId: string; selected: string | null; onSelect: (id: string) => void }) {
  const { t, locale } = useI18n();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(timer);
  }, [q]);
  const list = useConversations(consultantId, filter, debounced, 1);
  const attention = useConversations(consultantId, 'attention', '', 1);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-3 border-b border-slate-100 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.conversations.search} aria-label={t.conversations.search} className="pl-9" />
        </div>
        <Tabs<Filter>
          value={filter}
          onChange={setFilter}
          items={[
            { value: 'all', label: t.conversations.all },
            { value: 'attention', label: t.conversations.attention, count: attention.data?.total },
            { value: 'ai_off', label: t.conversations.aiOff },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        {list.isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : !list.data?.conversations.length ? (
          <EmptyState icon={<MessagesSquare className="size-6" />} title={t.conversations.empty} text={t.conversations.emptyHint} />
        ) : (
          <ul>
            {list.data.conversations.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  aria-current={selected === c.id}
                  className={cx(
                    'flex w-full cursor-pointer gap-3 border-b border-slate-100 px-3 py-3 text-left transition-colors',
                    selected === c.id ? 'bg-brand-50/70' : 'hover:bg-slate-50',
                  )}
                >
                  <span className="relative shrink-0 self-start">
                    <Avatar name={displayName(c)} />
                    <ChannelMark c={c} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="truncate text-sm font-semibold text-slate-900">{displayName(c)}</p>
                      <span className="shrink-0 text-xs text-slate-400">{relativeTime(c.last_message_at, locale)}</span>
                    </div>
                    <p className="mt-0.5 truncate text-[13px] text-slate-500">{c.last_message_preview ?? '—'}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {c.needs_attention && (
                        <Badge tone="amber">
                          <AlertTriangle className="size-3" aria-hidden /> {t.conversations.attention}
                        </Badge>
                      )}
                      {!c.ai_enabled && <Badge tone="slate">{t.conversations.aiOff}</Badge>}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Thread({
  consultantId,
  conversationId,
  onBack,
  connected,
}: {
  consultantId: string;
  conversationId: string;
  onBack: () => void;
  /** which messengers can deliver a human reply right now */
  connected: { telegram: boolean; whatsapp: boolean; web: boolean };
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const thread = useConversation(consultantId, conversationId);
  const [text, setText] = useState('');
  const [improving, setImproving] = useState<Message | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastId = thread.data?.messages.at(-1)?.id;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    // Once more after layout settles (fonts, source chips).
    const frame = requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
    return () => cancelAnimationFrame(frame);
  }, [lastId, conversationId]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.conversation(consultantId, conversationId) });
    void qc.invalidateQueries({ queryKey: keys.conversations(consultantId) });
  };
  const patch = useMutation({
    mutationFn: (body: Partial<Pick<Conversation, 'ai_enabled' | 'needs_attention'>>) =>
      api(`/consultants/${consultantId}/conversations/${conversationId}`, { method: 'PATCH', body }),
    onSuccess: (_d, body) => {
      if (body.needs_attention === false) toast.success(t.conversations.resolved);
      refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const send = useMutation({
    mutationFn: (value: string) => api(`/consultants/${consultantId}/conversations/${conversationId}/messages`, { method: 'POST', body: { text: value } }),
    onSuccess: () => {
      setText('');
      refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const resetMemory = useMutation({
    mutationFn: () => api(`/consultants/${consultantId}/conversations/${conversationId}/reset-memory`, { method: 'POST' }),
    onSuccess: () => toast.success(t.conversations.memoryReset),
  });
  const remove = useMutation({
    mutationFn: () => api(`/consultants/${consultantId}/conversations/${conversationId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.conversations(consultantId) });
      onBack();
    },
  });

  if (thread.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (thread.error || !thread.data) return <div className="p-6"><Alert tone="error">{errorText(thread.error)}</Alert></div>;
  const { conversation: c, messages } = thread.data;

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (text.trim() && !send.isPending) send.mutate(text.trim());
    }
  };

  let lastDay = '';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-3 py-3 sm:px-4">
        <IconButton label={t.common.back} onClick={onBack} className="lg:hidden">
          <ArrowLeft className="size-5" />
        </IconButton>
        <span className="relative shrink-0">
          <Avatar name={displayName(c)} />
          <ChannelMark c={c} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-slate-900">{displayName(c)}</p>
          <p className="truncate text-xs text-slate-500">
            {c.channel !== 'playground' && `${CHANNEL_NAMES[c.channel]} · `}
            {profileLink(c) ? (
              <a href={profileLink(c)!} target="_blank" rel="noreferrer" className="hover:underline">
                {handleOf(c)}
              </a>
            ) : (
              `ID ${c.external_chat_id}`
            )}
            {' · '}
            {fmt(t.conversations.messages, { count: c.message_count })}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {c.needs_attention && (
            <Button size="sm" variant="secondary" icon={<CheckCircle2 className="size-4" />} onClick={() => patch.mutate({ needs_attention: false })}>
              {t.conversations.markResolved}
            </Button>
          )}
          <IconButton label={t.conversations.resetMemory} onClick={() => resetMemory.mutate()}>
            <RotateCcw className="size-[18px]" />
          </IconButton>
          <IconButton
            label={t.conversations.deleteChat}
            onClick={async () => {
              if (await confirm({ title: t.conversations.deleteChat, text: t.conversations.deleteConfirm, danger: true, confirmLabel: t.common.delete })) remove.mutate();
            }}
          >
            <Trash2 className="size-[18px]" />
          </IconButton>
        </div>
      </div>

      <div className="border-b border-slate-100 bg-slate-50/60 px-4 py-2.5">
        <Switch
          checked={c.ai_enabled}
          onChange={(v) => patch.mutate({ ai_enabled: v })}
          label={t.conversations.aiToggle}
          description={c.ai_enabled ? t.conversations.aiOn : t.conversations.aiOffHint}
        />
        {c.needs_attention && c.attention_reason && (
          <p className="mt-2 flex items-center gap-1.5 text-[13px] text-amber-700">
            <AlertTriangle className="size-4 shrink-0" aria-hidden /> {t.conversations.reason}: {c.attention_reason}
          </p>
        )}
        {c.summary && (
          <details className="mt-2 text-[13px] text-slate-600">
            <summary className="flex cursor-pointer items-center gap-1.5 font-medium text-slate-700">
              <Brain className="size-4" aria-hidden /> {t.conversations.summary}
            </summary>
            <p className="mt-1 whitespace-pre-wrap">{c.summary}</p>
          </details>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-gradient-to-b from-slate-50 to-white px-3 py-4 sm:px-5 scroll-thin">
        {messages.map((m) => {
          const day = m.created_at.slice(0, 10);
          const separator = day !== lastDay;
          lastDay = day;
          return (
            <div key={m.id} className="space-y-3">
              {separator && (
                <div className="flex justify-center">
                  <span className="rounded-full bg-white px-3 py-1 text-xs text-slate-500 shadow-sm ring-1 ring-slate-200">{dateLabel(m.created_at, locale)}</span>
                </div>
              )}
              <MessageBubble message={m} onImprove={setImproving} />
            </div>
          );
        })}
      </div>

      <div className="border-t border-slate-100 p-3 sm:p-4">
        {(c.channel === 'whatsapp' ? connected.whatsapp : c.channel === 'web' ? connected.web : connected.telegram) ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) send.mutate(text.trim());
            }}
            className="flex items-end gap-2"
          >
            <div className="flex-1">
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKey}
                rows={2}
                placeholder={t.conversations.composer}
                aria-label={t.conversations.composer}
                maxLength={4000}
                className="resize-none"
              />
              <p className="mt-1 text-xs text-slate-400">{t.conversations.composerHint}</p>
            </div>
            <Button type="submit" loading={send.isPending} disabled={!text.trim()} icon={<Send className="size-4" />} className="mb-5">
              <span className="hidden sm:inline">{t.conversations.send}</span>
            </Button>
          </form>
        ) : (
          <p className="text-center text-sm text-slate-500">{t.conversations.noTelegram}</p>
        )}
      </div>

      <TeachModal
        consultantId={consultantId}
        open={Boolean(improving)}
        onClose={() => setImproving(null)}
        question={improving?.meta.question ?? ''}
        reply={improving?.content ?? ''}
        source="conversation"
      />
    </div>
  );
}

export function ConversationsPage() {
  const { consultantId = '' } = useParams();
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const selected = params.get('open');
  const details = useConsultant(consultantId);
  const select = (id: string | null) => setParams(id ? { open: id } : {}, { replace: true });

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold tracking-tight text-slate-900">{t.conversations.title}</h1>
      <Card className="grid h-[calc(100dvh-10.5rem)] min-h-[520px] grid-cols-1 overflow-hidden lg:grid-cols-[340px_1fr] lg:h-[calc(100dvh-9rem)] [&>*]:min-w-0">
        <div className={cx('min-h-0 border-slate-100 lg:border-r', selected ? 'hidden lg:block' : 'block')}>
          <ConversationList consultantId={consultantId} selected={selected} onSelect={select} />
        </div>
        <div className={cx('min-h-0', selected ? 'block' : 'hidden lg:block')}>
          {selected ? (
            <Thread
              key={selected}
              consultantId={consultantId}
              conversationId={selected}
              onBack={() => select(null)}
              connected={{
                telegram: Boolean(details.data?.consultant.telegram.connected),
                whatsapp: Boolean(details.data?.consultant.whatsapp.connected),
                web: Boolean(details.data?.consultant.web.enabled),
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <EmptyState icon={<MessagesSquare className="size-6" />} title={t.conversations.select} />
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
