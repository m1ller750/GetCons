import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, BookOpen, FilePlus2, FileText, Info, RefreshCw, Search, Trash2, UploadCloud } from 'lucide-react';
import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { toast } from 'sonner';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, IconButton, Input, Modal, PageHeader, Spinner, Textarea, cx, useConfirm } from '../components/ui';
import { api, errorText } from '../lib/api';
import { fileSize, relativeTime } from '../lib/format';
import { fmt, useI18n } from '../lib/i18n';
import { keys, useDocuments, useMe } from '../lib/queries';
import type { KnowledgeDocument, SearchResult } from '../lib/types';

const ACCEPT = '.pdf,.docx,.txt,.md,.markdown,.csv,.tsv,.json,.html,.htm,.png,.jpg,.jpeg,.webp';

function StatusBadge({ doc }: { doc: KnowledgeDocument }) {
  const { t } = useI18n();
  if (doc.status === 'processing')
    return (
      <Badge tone="sky">
        <Spinner className="size-3 text-sky-600" /> {t.status.processing}
      </Badge>
    );
  if (doc.status === 'error')
    return (
      <span title={doc.error ?? ''}>
        <Badge tone="rose">
          <AlertCircle className="size-3" aria-hidden /> {t.status.error}
        </Badge>
      </span>
    );
  return <Badge tone="green" dot>{t.status.ready}</Badge>;
}

function DocumentEditor({ consultantId, docId, onClose }: { consultantId: string; docId: string | null; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const doc = useQuery({
    queryKey: ['document', docId],
    queryFn: () => api<{ document: KnowledgeDocument }>(`/consultants/${consultantId}/knowledge/${docId}`).then((r) => r.document),
    enabled: Boolean(docId),
  });
  const [draft, setDraft] = useState<{ title: string; content: string } | null>(null);
  const value = draft ?? (doc.data ? { title: doc.data.title, content: doc.data.content ?? '' } : null);

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, string> = {};
      if (value && doc.data) {
        if (value.title !== doc.data.title) body.title = value.title;
        if (value.content !== doc.data.content) body.content = value.content;
      }
      return api(`/consultants/${consultantId}/knowledge/${docId}`, { method: 'PATCH', body });
    },
    onSuccess: () => {
      toast.success(t.knowledge.savedReindex);
      void qc.invalidateQueries({ queryKey: keys.documents(consultantId) });
      void qc.invalidateQueries({ queryKey: ['document', docId] });
      setDraft(null);
      onClose();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const dirty = Boolean(draft && doc.data && (draft.title !== doc.data.title || draft.content !== doc.data.content));

  return (
    <Modal
      open={Boolean(docId)}
      onClose={() => {
        setDraft(null);
        onClose();
      }}
      title={doc.data?.title ?? t.common.loading}
      description={doc.data?.file_name ?? undefined}
      size="xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t.common.close}
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
            {t.common.save}
          </Button>
        </>
      }
    >
      {!value ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4">
          <Field label={t.knowledge.textTitle}>{(id) => <Input id={id} value={value.title} onChange={(e) => setDraft({ ...value, title: e.target.value })} maxLength={200} />}</Field>
          <Field label={t.knowledge.textContent} hint={fmt(t.common.characters, { count: value.content.length.toLocaleString() })}>
            {(id) => <Textarea id={id} rows={18} value={value.content} onChange={(e) => setDraft({ ...value, content: e.target.value })} className="font-mono text-[13px]" />}
          </Field>
        </div>
      )}
    </Modal>
  );
}

function RetrievalTester({ consultantId }: { consultantId: string }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const search = useMutation({
    mutationFn: (q: string) => api<{ results: SearchResult[]; warning: string | null; minSimilarity: number }>(`/consultants/${consultantId}/knowledge/search`, { method: 'POST', body: { query: q } }),
    onError: (err) => toast.error(errorText(err)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim()) search.mutate(query.trim());
  };
  const data = search.data;

  return (
    <Card>
      <CardHeader icon={<Search className="size-5" />} title={t.knowledge.testTitle} subtitle={t.knowledge.testSubtitle} />
      <div className="space-y-4 p-5">
        <form onSubmit={submit} className="flex gap-2">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.knowledge.testPlaceholder} aria-label={t.knowledge.testTitle} />
          <Button type="submit" loading={search.isPending} disabled={!query.trim()}>
            {t.knowledge.testButton}
          </Button>
        </form>
        {data?.warning && <Alert tone="warning">{data.warning}</Alert>}
        {data && !data.results.length && <p className="text-sm text-slate-500">{t.knowledge.noResults}</p>}
        <ul className="space-y-3">
          {data?.results.map((r) => {
            const used = r.similarity >= data.minSimilarity || r.keyword_rank > 0;
            const pct = Math.max(0, Math.round(r.similarity * 100));
            return (
              <li key={r.id} className={cx('rounded-xl border p-4', used ? 'border-slate-200' : 'border-dashed border-slate-200 opacity-60')}>
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span className="inline-flex items-center gap-1 font-medium text-slate-700">
                    <FileText className="size-3.5" aria-hidden /> {r.document_title}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100">
                      <span className="block h-full rounded-full bg-brand-500" style={{ width: `${pct}%` }} />
                    </span>
                    {pct}% {t.knowledge.similarity}
                  </span>
                  {r.keyword_rank > 0 && <Badge tone="sky">{t.knowledge.keywordMatch}</Badge>}
                  {!used && <Badge>{t.knowledge.belowThreshold}</Badge>}
                </div>
                <p className="line-clamp-4 text-sm whitespace-pre-wrap text-slate-700">{r.content}</p>
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}

export function KnowledgePage() {
  const { consultantId = '' } = useParams();
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const me = useMe();
  const docs = useDocuments(consultantId);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [textOpen, setTextOpen] = useState(false);
  const [text, setText] = useState({ title: '', content: '' });
  const [editing, setEditing] = useState<string | null>(null);
  const maxMb = Math.round((me.data?.limits.maxUploadBytes ?? 10 * 1024 * 1024) / 1024 / 1024);
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.documents(consultantId) });

  const uploadFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      setUploading(file.name);
      const form = new FormData();
      form.append('file', file);
      try {
        await api(`/consultants/${consultantId}/knowledge/upload`, { method: 'POST', form });
        toast.success(fmt(t.knowledge.uploaded, { name: file.name }));
      } catch (err) {
        toast.error(`${file.name}: ${errorText(err)}`);
      }
      refresh();
    }
    setUploading(null);
    void qc.invalidateQueries({ queryKey: keys.consultant(consultantId) });
  };

  const addText = useMutation({
    mutationFn: () => api(`/consultants/${consultantId}/knowledge/text`, { method: 'POST', body: { ...text, kind: /^\s*(q|в)\s*:/im.test(text.content) ? 'faq' : 'text' } }),
    onSuccess: () => {
      setTextOpen(false);
      setText({ title: '', content: '' });
      refresh();
      void qc.invalidateQueries({ queryKey: keys.consultant(consultantId) });
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const reprocess = useMutation({
    mutationFn: (id: string) => api(`/consultants/${consultantId}/knowledge/${id}/reprocess`, { method: 'POST' }),
    onSuccess: refresh,
    onError: (err) => toast.error(errorText(err)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/consultants/${consultantId}/knowledge/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(t.knowledge.deleted);
      refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t.knowledge.title}
        subtitle={t.knowledge.subtitle}
        actions={
          <Button variant="secondary" icon={<FilePlus2 className="size-4" />} onClick={() => setTextOpen(true)}>
            {t.knowledge.addText}
          </Button>
        }
      />

      <Alert tone="info" icon={<Info className="size-5" />} title={t.knowledge.howTitle}>
        {t.knowledge.howText}
      </Alert>

      <button
        type="button"
        onClick={() => fileInput.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        disabled={Boolean(uploading)}
        className={cx(
          'flex w-full cursor-pointer flex-col items-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors',
          dragging ? 'border-brand-500 bg-brand-50' : 'border-slate-300 bg-white hover:border-brand-400 hover:bg-brand-50/40',
        )}
      >
        {uploading ? <Spinner className="size-8" /> : <UploadCloud className="size-9 text-brand-500" aria-hidden />}
        <p className="mt-3 text-[15px] font-medium text-slate-800">{uploading ? fmt(t.knowledge.uploading, { name: uploading }) : t.knowledge.dropHere}</p>
        <p className="mt-1 max-w-xl text-sm text-slate-500">{fmt(t.knowledge.formats, { mb: maxMb })}</p>
      </button>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) void uploadFiles(e.target.files);
          e.target.value = '';
        }}
      />

      <Card>
        {docs.isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : !docs.data?.length ? (
          <EmptyState icon={<BookOpen className="size-6" />} title={t.knowledge.empty} text={t.knowledge.emptyHint} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-100 text-xs font-medium tracking-wide text-slate-500 uppercase">
                <tr>
                  <th className="px-5 py-3">{t.knowledge.columns.title}</th>
                  <th className="px-3 py-3">{t.knowledge.columns.status}</th>
                  <th className="hidden px-3 py-3 sm:table-cell">{t.knowledge.columns.chunks}</th>
                  <th className="hidden px-3 py-3 md:table-cell">{t.knowledge.columns.size}</th>
                  <th className="hidden px-3 py-3 md:table-cell">{t.knowledge.columns.updated}</th>
                  <th className="px-3 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {docs.data.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50/60">
                    <td className="max-w-xs px-5 py-3">
                      <button type="button" onClick={() => setEditing(d.id)} className="flex cursor-pointer items-center gap-3 text-left">
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                          <FileText className="size-4" aria-hidden />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-slate-900 hover:text-brand-700">{d.title}</span>
                          <span className="block truncate text-xs text-slate-500">{d.file_name ?? t.knowledge.types[d.source_type]}</span>
                        </span>
                      </button>
                      {d.status === 'error' && d.error && <p className="mt-1 text-xs text-rose-600">{d.error}</p>}
                    </td>
                    <td className="px-3 py-3">
                      <StatusBadge doc={d} />
                    </td>
                    <td className="hidden px-3 py-3 text-slate-600 tabular-nums sm:table-cell">{d.chunk_count}</td>
                    <td className="hidden px-3 py-3 text-slate-600 md:table-cell">{fileSize(d.size_bytes)}</td>
                    <td className="hidden px-3 py-3 text-slate-500 md:table-cell">{relativeTime(d.updated_at, locale)}</td>
                    <td className="px-3 py-3">
                      <div className="flex justify-end">
                        <IconButton label={t.knowledge.reprocess} onClick={() => reprocess.mutate(d.id)} disabled={d.status === 'processing'}>
                          <RefreshCw className="size-4" />
                        </IconButton>
                        <IconButton
                          label={t.common.delete}
                          onClick={async () => {
                            if (await confirm({ title: t.common.delete, text: fmt(t.knowledge.deleteConfirm, { title: d.title }), danger: true, confirmLabel: t.common.delete }))
                              remove.mutate(d.id);
                          }}
                        >
                          <Trash2 className="size-4" />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <RetrievalTester consultantId={consultantId} />

      <Modal
        open={textOpen}
        onClose={() => setTextOpen(false)}
        title={t.knowledge.addText}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setTextOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button onClick={() => addText.mutate()} loading={addText.isPending} disabled={!text.title.trim() || !text.content.trim()}>
              {t.common.add}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label={t.knowledge.textTitle}>
            {(id) => <Input id={id} value={text.title} onChange={(e) => setText({ ...text, title: e.target.value })} placeholder={t.knowledge.textTitlePlaceholder} maxLength={200} autoFocus />}
          </Field>
          <Field label={t.knowledge.textContent}>
            {(id) => <Textarea id={id} rows={12} value={text.content} onChange={(e) => setText({ ...text, content: e.target.value })} placeholder={t.knowledge.textContentPlaceholder} />}
          </Field>
        </div>
      </Modal>

      <DocumentEditor consultantId={consultantId} docId={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
