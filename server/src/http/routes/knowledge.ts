import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { DocumentRow } from '../../db/types.js';
import { toVector } from '../../db/supabaseStore.js';
import { AppError, badRequest, dbError, errorMessage, notFound, upstream } from '../../lib/errors.js';
import { normalizeText } from '../../services/chunking.js';
import { extractDocument, MAX_DOCUMENT_CHARS } from '../../services/documents.js';
import { owned, type AppDeps } from '../deps.js';
import { parse, uuidParam } from '../middleware.js';
import { planOf } from '../plan.js';

const DOC_LIST_COLUMNS =
  'id, consultant_id, title, source_type, file_name, mime_type, size_bytes, status, error, chunk_count, created_at, updated_at';

const textSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(MAX_DOCUMENT_CHARS),
  kind: z.enum(['text', 'faq']).default('text'),
});

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    content: z.string().min(1).max(MAX_DOCUMENT_CHARS),
  })
  .partial();

const searchSchema = z.object({ query: z.string().trim().min(1).max(1000), limit: z.number().int().min(1).max(20).default(6) });

/** Multer decodes multipart filenames as latin1; recover UTF-8 names (e.g. Cyrillic). */
function fixFileName(name: string): string {
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  return utf8.includes('�') ? name : utf8;
}

export function knowledgeRouter(deps: AppDeps): Router {
  const router = Router({ mergeParams: true });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: deps.config.limits.maxUploadBytes, files: 1 },
  });

  async function assertCapacity(consultantId: string, { db, user }: Pick<ReturnType<typeof owned>, 'db' | 'user'>) {
    const plan = await planOf(deps, user.id);
    const max = Math.min(plan.maxDocumentsPerConsultant, deps.config.limits.maxDocumentsPerConsultant);
    const { count, error } = await db
      .from('knowledge_documents')
      .select('id', { count: 'exact', head: true })
      .eq('consultant_id', consultantId);
    if (error) throw dbError(error, 'counting documents');
    if ((count ?? 0) >= max) {
      throw new AppError(403, 'limit_reached', `Your plan allows up to ${max} documents per consultant`, { plan: plan.id, max });
    }
  }

  // Uploads per user and UTC day; reading scans and photos goes through Gemini.
  const uploadsToday = new Map<string, { day: string; count: number }>();
  async function assertUploadQuota(userId: string) {
    const day = new Date().toISOString().slice(0, 10);
    const entry = uploadsToday.get(userId);
    const count = entry?.day === day ? entry.count : 0;
    const max = (await planOf(deps, userId)).dailyUploads;
    if (count >= max) {
      throw new AppError(429, 'rate_limited', `Your plan allows ${max} file uploads a day. Try again tomorrow or choose a bigger plan.`);
    }
    if (uploadsToday.size > 10_000) uploadsToday.clear();
    uploadsToday.set(userId, { day, count: count + 1 });
  }

  async function insertDocument(row: Partial<DocumentRow> & { consultant_id: string }): Promise<DocumentRow> {
    const { data, error } = await deps.admin.from('knowledge_documents').insert(row).select(DOC_LIST_COLUMNS).single();
    if (error) throw dbError(error, 'saving document');
    const doc = data as unknown as DocumentRow;
    deps.indexer.enqueue(doc.id);
    return doc;
  }

  router.get('/', async (req, res) => {
    const { consultant, db } = owned(req);
    const { data, error } = await db
      .from('knowledge_documents')
      .select(DOC_LIST_COLUMNS)
      .eq('consultant_id', consultant.id)
      .order('created_at', { ascending: false });
    if (error) throw dbError(error, 'listing documents');
    res.json({ documents: data ?? [] });
  });

  router.post('/upload', upload.single('file'), async (req, res) => {
    const ctx = owned(req);
    const { consultant } = ctx;
    if (!req.file) throw badRequest('Attach a file in the "file" field');
    await assertCapacity(consultant.id, ctx);
    await assertUploadQuota(ctx.user.id);

    const fileName = fixFileName(req.file.originalname);
    const extracted = await extractDocument({ buffer: req.file.buffer, originalName: fileName }, deps.llm).catch((err) => {
      if (err instanceof AppError) throw err;
      throw upstream(`Could not read the file: ${errorMessage(err)}`);
    });
    const title =
      typeof req.body?.title === 'string' && req.body.title.trim()
        ? req.body.title.trim().slice(0, 200)
        : fileName.replace(/\.[^.]+$/, '').slice(0, 200) || 'Document';

    const doc = await insertDocument({
      consultant_id: consultant.id,
      title,
      source_type: 'file',
      file_name: fileName.slice(0, 255),
      mime_type: extracted.mimeType,
      size_bytes: req.file.size,
      content: extracted.text,
      status: 'processing',
    });
    await deps.store.logEvent(consultant.id, 'knowledge_uploaded', `Uploaded "${title}"`, {
      meta: { document_id: doc.id, method: extracted.method },
    });
    res.status(201).json({ document: doc, extraction: { method: extracted.method, characters: extracted.text.length } });
  });

  router.post('/text', async (req, res) => {
    const ctx = owned(req);
    const { consultant } = ctx;
    const body = parse(textSchema, req.body ?? {});
    await assertCapacity(consultant.id, ctx);
    const content = normalizeText(body.content);
    if (!content) throw badRequest('Content is empty');
    const doc = await insertDocument({
      consultant_id: consultant.id,
      title: body.title,
      source_type: body.kind,
      mime_type: 'text/plain',
      size_bytes: Buffer.byteLength(content),
      content,
      status: 'processing',
    });
    res.status(201).json({ document: doc });
  });

  router.post('/search', async (req, res) => {
    const { consultant, db } = owned(req);
    const { query, limit } = parse(searchSchema, req.body ?? {});
    let embedding: number[] | null = null;
    let warning: string | null = null;
    try {
      [embedding = null] = await deps.llm.embed([query], 'query');
    } catch (err) {
      warning = `Semantic search unavailable (${errorMessage(err)}); showing keyword matches only`;
    }
    // Through the user's RLS client: the function only sees this user's rows.
    const { data, error } = await db.rpc('match_knowledge_chunks', {
      p_consultant_id: consultant.id,
      p_embedding: embedding ? toVector(embedding) : null,
      p_query: query,
      p_match_count: limit,
    });
    if (error) throw dbError(error, 'searching knowledge');
    res.json({ results: data ?? [], warning, minSimilarity: deps.config.rag.minSimilarity });
  });

  router.get('/:documentId', async (req, res) => {
    const { consultant, db } = owned(req);
    const id = parse(uuidParam, req.params.documentId);
    const { data, error } = await db
      .from('knowledge_documents')
      .select('*')
      .eq('id', id)
      .eq('consultant_id', consultant.id)
      .maybeSingle();
    if (error) throw dbError(error, 'loading document');
    if (!data) throw notFound('Document');
    res.json({ document: data });
  });

  router.patch('/:documentId', async (req, res) => {
    const { consultant } = owned(req);
    const id = parse(uuidParam, req.params.documentId);
    const body = parse(updateSchema, req.body ?? {});
    const patch: Partial<DocumentRow> = {};
    if (body.title) patch.title = body.title;
    if (body.content !== undefined) {
      const content = normalizeText(body.content);
      if (!content) throw badRequest('Content is empty');
      Object.assign(patch, { content, size_bytes: Buffer.byteLength(content), status: 'processing', error: null });
    }
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');
    const { data, error } = await deps.admin
      .from('knowledge_documents')
      .update(patch)
      .eq('id', id)
      .eq('consultant_id', consultant.id)
      .select(DOC_LIST_COLUMNS)
      .maybeSingle();
    if (error) throw dbError(error, 'updating document');
    if (!data) throw notFound('Document');
    if (patch.content) deps.indexer.enqueue(id);
    res.json({ document: data });
  });

  router.post('/:documentId/reprocess', async (req, res) => {
    const { consultant } = owned(req);
    const id = parse(uuidParam, req.params.documentId);
    const { data, error } = await deps.admin
      .from('knowledge_documents')
      .update({ status: 'processing', error: null })
      .eq('id', id)
      .eq('consultant_id', consultant.id)
      .select(DOC_LIST_COLUMNS)
      .maybeSingle();
    if (error) throw dbError(error, 'reprocessing document');
    if (!data) throw notFound('Document');
    deps.indexer.enqueue(id);
    res.json({ document: data });
  });

  router.delete('/:documentId', async (req, res) => {
    const { consultant } = owned(req);
    const id = parse(uuidParam, req.params.documentId);
    const { data, error } = await deps.admin
      .from('knowledge_documents')
      .delete()
      .eq('id', id)
      .eq('consultant_id', consultant.id)
      .select('id, title');
    if (error) throw dbError(error, 'deleting document');
    if (!data?.length) throw notFound('Document');
    await deps.store.logEvent(consultant.id, 'knowledge_deleted', `Deleted "${(data[0] as { title: string }).title}"`);
    res.status(204).end();
  });

  return router;
}
