import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileUp, GraduationCap, Info, Pencil, Pin, PinOff, Plus, Search, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { toast } from 'sonner';
import { Alert, Badge, Button, Card, EmptyState, Field, IconButton, Input, Modal, PageHeader, Select, Spinner, Switch, Tabs, Textarea, cx, useConfirm } from '../components/ui';
import { api, errorText } from '../lib/api';
import { parseCsv, relativeTime } from '../lib/format';
import { fmt, useI18n } from '../lib/i18n';
import { keys, useExamples } from '../lib/queries';
import type { TrainingExample, TranscriptPreview } from '../lib/types';

type Draft = { id?: string; customer_message: string; ideal_reply: string; notes: string; is_pinned: boolean };
const EMPTY: Draft = { customer_message: '', ideal_reply: '', notes: '', is_pinned: false };

function ExampleEditor({ consultantId, draft, onClose }: { consultantId: string; draft: Draft | null; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [value, setValue] = useState<Draft>(EMPTY);
  useEffect(() => {
    if (draft) setValue(draft);
  }, [draft]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        customer_message: value.customer_message.trim(),
        ideal_reply: value.ideal_reply.trim(),
        notes: value.notes.trim() || null,
        is_pinned: value.is_pinned,
      };
      return value.id
        ? api(`/consultants/${consultantId}/examples/${value.id}`, { method: 'PATCH', body })
        : api(`/consultants/${consultantId}/examples`, { method: 'POST', body });
    },
    onSuccess: () => {
      toast.success(t.training.saved);
      void qc.invalidateQueries({ queryKey: keys.examples(consultantId) });
      void qc.invalidateQueries({ queryKey: keys.consultant(consultantId) });
      onClose();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  return (
    <Modal
      open={Boolean(draft)}
      onClose={onClose}
      title={value.id ? t.common.edit : t.training.add}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!value.customer_message.trim() || !value.ideal_reply.trim()}>
            {t.common.save}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t.training.customer}>
          {(id) => <Textarea id={id} rows={3} value={value.customer_message} onChange={(e) => setValue({ ...value, customer_message: e.target.value })} maxLength={4000} autoFocus />}
        </Field>
        <Field label={t.training.reply}>
          {(id) => <Textarea id={id} rows={6} value={value.ideal_reply} onChange={(e) => setValue({ ...value, ideal_reply: e.target.value })} maxLength={4000} />}
        </Field>
        <Field label={t.training.notes} optional>
          {(id) => <Input id={id} value={value.notes} onChange={(e) => setValue({ ...value, notes: e.target.value })} placeholder={t.training.notesPlaceholder} maxLength={1000} />}
        </Field>
        <Switch checked={value.is_pinned} onChange={(v) => setValue({ ...value, is_pinned: v })} label={t.training.pin} description={t.training.pinHint} />
      </div>
    </Modal>
  );
}

type ImportMode = 'telegram' | 'text' | 'csv';

function ImportModal({ consultantId, open, onClose }: { consultantId: string; open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [mode, setMode] = useState<ImportMode>('telegram');
  const [content, setContent] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<TranscriptPreview | null>(null);
  const [speaker, setSpeaker] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!open) {
      setContent('');
      setFileName(null);
      setPreview(null);
      setSpeaker(null);
      setSelected(new Set());
    }
  }, [open]);

  const applyPreview = (p: TranscriptPreview) => {
    setPreview(p);
    setSpeaker(p.businessSpeaker);
    setSelected(new Set(p.pairs.map((_, i) => i)));
  };

  const analyze = useMutation({
    mutationFn: async (businessSpeaker?: string | null): Promise<TranscriptPreview> => {
      if (mode === 'csv') {
        const rows = parseCsv(content);
        const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
        let qi = header.findIndex((h) => ['customer_message', 'question', 'вопрос', 'customer'].includes(h));
        let ai = header.findIndex((h) => ['ideal_reply', 'answer', 'ответ', 'reply'].includes(h));
        const body = qi >= 0 && ai >= 0 ? rows.slice(1) : rows;
        if (qi < 0 || ai < 0) [qi, ai] = [0, 1];
        const pairs = body
          .map((r) => ({ customer_message: (r[qi] ?? '').trim().slice(0, 4000), ideal_reply: (r[ai] ?? '').trim().slice(0, 4000) }))
          .filter((p) => p.customer_message && p.ideal_reply);
        return { speakers: [], businessSpeaker: null, turns: pairs.length * 2, pairs: pairs.slice(0, 500), totalPairs: pairs.length };
      }
      return api<TranscriptPreview>(`/consultants/${consultantId}/examples/parse-transcript`, {
        method: 'POST',
        body: { content, format: mode === 'telegram' ? 'telegram_json' : 'text', businessSpeaker: businessSpeaker ?? undefined },
      });
    },
    onSuccess: applyPreview,
    onError: (err) => toast.error(errorText(err)),
  });

  const importNow = useMutation({
    mutationFn: () => {
      const examples = preview!.pairs.filter((_, i) => selected.has(i));
      return api<{ imported: number }>(`/consultants/${consultantId}/examples/bulk`, { method: 'POST', body: { examples } });
    },
    onSuccess: (r) => {
      toast.success(fmt(t.training.imported, { count: r.imported }));
      void qc.invalidateQueries({ queryKey: keys.examples(consultantId) });
      void qc.invalidateQueries({ queryKey: keys.consultant(consultantId) });
      onClose();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const readFile = async (file: File) => {
    setFileName(file.name);
    setContent(await file.text());
    setPreview(null);
  };

  const hints = { telegram: t.training.importTelegramHint, text: t.training.importTextHint, csv: t.training.importCsvHint };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t.training.importTitle}
      description={t.training.importSubtitle}
      size="xl"
      footer={
        preview ? (
          <>
            <Button variant="secondary" onClick={() => setPreview(null)}>
              {t.common.back}
            </Button>
            <Button onClick={() => importNow.mutate()} loading={importNow.isPending} disabled={!selected.size}>
              {fmt(t.training.importSelected, { count: selected.size })}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              {t.common.cancel}
            </Button>
            <Button onClick={() => analyze.mutate(null)} loading={analyze.isPending} disabled={!content.trim()}>
              {t.training.analyze}
            </Button>
          </>
        )
      }
    >
      {!preview ? (
        <div className="space-y-4">
          <Tabs<ImportMode>
            value={mode}
            onChange={(m) => {
              setMode(m);
              setContent('');
              setFileName(null);
            }}
            items={[
              { value: 'telegram', label: t.training.importTelegram },
              { value: 'text', label: t.training.importText },
              { value: 'csv', label: t.training.importCsv },
            ]}
          />
          <p className="text-sm text-slate-600">{hints[mode]}</p>
          {mode === 'text' ? (
            <Textarea rows={12} value={content} onChange={(e) => setContent(e.target.value)} placeholder={'Maria: Hi! Do you deliver on Sundays?\nManager: Hello Maria! Yes, every day 9-21.'} className="font-mono text-[13px]" aria-label={t.training.importText} />
          ) : (
            <label className="flex cursor-pointer flex-col items-center rounded-2xl border-2 border-dashed border-slate-300 px-6 py-10 text-center hover:border-brand-400 hover:bg-brand-50/40">
              <FileUp className="size-8 text-brand-500" aria-hidden />
              <span className="mt-3 text-sm font-medium text-slate-800">{fileName ?? t.training.chooseFile}</span>
              <input
                type="file"
                accept={mode === 'csv' ? '.csv,.tsv,.txt' : '.json'}
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void readFile(f);
                }}
              />
            </label>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {preview.speakers.length > 1 && (
            <Field label={t.training.businessSide}>
              {(id) => (
                <Select
                  id={id}
                  value={speaker ?? ''}
                  onChange={(e) => {
                    setSpeaker(e.target.value);
                    analyze.mutate(e.target.value);
                  }}
                >
                  {preview.speakers.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {!preview.pairs.length ? (
            <Alert tone="warning">{t.training.nothingFound}</Alert>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-slate-700">{fmt(t.training.found, { count: preview.totalPairs })}</p>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    className="size-4 accent-brand-600"
                    checked={selected.size === preview.pairs.length}
                    onChange={(e) => setSelected(e.target.checked ? new Set(preview.pairs.map((_, i) => i)) : new Set())}
                  />
                  {t.training.selectAll}
                </label>
              </div>
              <ul className="max-h-[50vh] space-y-2 overflow-y-auto pr-1 scroll-thin">
                {preview.pairs.map((p, i) => (
                  <li key={i}>
                    <label className={cx('flex cursor-pointer gap-3 rounded-xl border p-3', selected.has(i) ? 'border-brand-300 bg-brand-50/40' : 'border-slate-200')}>
                      <input
                        type="checkbox"
                        className="mt-1 size-4 shrink-0 accent-brand-600"
                        checked={selected.has(i)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(i);
                          else next.delete(i);
                          setSelected(next);
                        }}
                      />
                      <div className="min-w-0 space-y-1 text-sm">
                        <p className="line-clamp-2 text-slate-900">
                          <span className="font-medium text-slate-500">{t.training.customer}: </span>
                          {p.customer_message}
                        </p>
                        <p className="line-clamp-3 text-slate-600">
                          <span className="font-medium text-slate-500">{t.training.reply}: </span>
                          {p.ideal_reply}
                        </p>
                      </div>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

export function TrainingPage() {
  const { consultantId = '' } = useParams();
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(q.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [q]);
  const examples = useExamples(consultantId, debounced, page);
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.examples(consultantId) });

  const togglePin = useMutation({
    mutationFn: (e: TrainingExample) => api(`/consultants/${consultantId}/examples/${e.id}`, { method: 'PATCH', body: { is_pinned: !e.is_pinned } }),
    onSuccess: refresh,
    onError: (err) => toast.error(errorText(err)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/consultants/${consultantId}/examples/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (err) => toast.error(errorText(err)),
  });
  const pages = examples.data ? Math.max(1, Math.ceil(examples.data.total / examples.data.pageSize)) : 1;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t.training.title}
        subtitle={t.training.subtitle}
        actions={
          <>
            <Button variant="secondary" icon={<FileUp className="size-4" />} onClick={() => setImporting(true)}>
              {t.training.import}
            </Button>
            <Button icon={<Plus className="size-4" />} onClick={() => setEditing({ ...EMPTY })}>
              {t.training.add}
            </Button>
          </>
        }
      />
      <Alert tone="info" icon={<Info className="size-5" />} title={t.training.howTitle}>
        {t.training.howText}
      </Alert>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.training.search} aria-label={t.training.search} className="pl-9" />
        </div>
        {examples.data && <p className="text-sm text-slate-500">{fmt(t.training.total, { count: examples.data.total })}</p>}
      </div>

      {examples.isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : !examples.data?.examples.length ? (
        <Card>
          <EmptyState
            icon={<GraduationCap className="size-6" />}
            title={t.training.empty}
            text={t.training.emptyHint}
            action={
              <Button icon={<Plus className="size-4" />} onClick={() => setEditing({ ...EMPTY })}>
                {t.training.add}
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {examples.data.examples.map((e) => (
            <Card key={e.id} className={cx('flex flex-col p-5', e.is_pinned && 'ring-2 ring-brand-200')}>
              <div className="mb-3 flex items-center gap-2">
                {e.is_pinned && (
                  <Badge tone="brand">
                    <Pin className="size-3" aria-hidden /> {t.training.pinned}
                  </Badge>
                )}
                <Badge>{t.training.sources[e.source]}</Badge>
                <span className="ml-auto text-xs text-slate-400">{relativeTime(e.updated_at, locale)}</span>
              </div>
              <p className="text-xs font-medium tracking-wide text-slate-400 uppercase">{t.training.customer}</p>
              <p className="mt-1 line-clamp-3 text-sm text-slate-900">{e.customer_message}</p>
              <p className="mt-3 text-xs font-medium tracking-wide text-slate-400 uppercase">{t.training.reply}</p>
              <p className="mt-1 line-clamp-5 text-sm whitespace-pre-wrap text-slate-600">{e.ideal_reply}</p>
              {e.notes && <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">{e.notes}</p>}
              <div className="mt-auto flex justify-end gap-1 pt-3">
                <IconButton label={e.is_pinned ? t.training.unpin : t.training.pin} onClick={() => togglePin.mutate(e)}>
                  {e.is_pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                </IconButton>
                <IconButton label={t.common.edit} onClick={() => setEditing({ id: e.id, customer_message: e.customer_message, ideal_reply: e.ideal_reply, notes: e.notes ?? '', is_pinned: e.is_pinned })}>
                  <Pencil className="size-4" />
                </IconButton>
                <IconButton
                  label={t.common.delete}
                  onClick={async () => {
                    if (await confirm({ title: t.training.deleteConfirm, danger: true, confirmLabel: t.common.delete })) remove.mutate(e.id);
                  }}
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
            </Card>
          ))}
        </div>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            {t.common.previous}
          </Button>
          <span className="text-sm text-slate-500">{fmt(t.common.page, { page, pages })}</span>
          <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            {t.common.next}
          </Button>
        </div>
      )}

      <ExampleEditor consultantId={consultantId} draft={editing} onClose={() => setEditing(null)} />
      <ImportModal consultantId={consultantId} open={importing} onClose={() => setImporting(false)} />
    </div>
  );
}
