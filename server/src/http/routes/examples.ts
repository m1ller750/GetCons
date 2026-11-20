import { Router } from 'express';
import { z } from 'zod';
import { toVector } from '../../db/supabaseStore.js';
import { AppError, badRequest, dbError, errorMessage, notFound } from '../../lib/errors.js';
import { parseTranscript } from '../../services/transcripts.js';
import { owned, type AppDeps } from '../deps.js';
import { parse, uuidParam } from '../middleware.js';
import { planOf, planRequired } from '../plan.js';

const COLUMNS = 'id, consultant_id, customer_message, ideal_reply, notes, is_pinned, source, created_at, updated_at';
const PAGE_SIZE = 50;

const exampleSchema = z.object({
  customer_message: z.string().trim().min(1).max(4000),
  ideal_reply: z.string().trim().min(1).max(4000),
  notes: z.string().trim().max(1000).nullish(),
  is_pinned: z.boolean().default(false),
  source: z.enum(['manual', 'conversation', 'gap']).default('manual'),
});

const updateSchema = z
  .object({
    customer_message: z.string().trim().min(1).max(4000),
    ideal_reply: z.string().trim().min(1).max(4000),
    notes: z.string().trim().max(1000).nullable(),
    is_pinned: z.boolean(),
  })
  .partial();

const bulkSchema = z.object({
  examples: z
    .array(
      z.object({
        customer_message: z.string().trim().min(1).max(4000),
        ideal_reply: z.string().trim().min(1).max(4000),
        notes: z.string().trim().max(1000).nullish(),
      }),
    )
    .min(1)
    .max(500),
});

const transcriptSchema = z.object({
  content: z.string().min(1).max(5_000_000),
  format: z.enum(['auto', 'telegram_json', 'text']).default('auto'),
  businessSpeaker: z.string().max(100).nullish(),
});

const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pinned: z.enum(['true', 'false']).optional(),
});

/** Removes characters that have meaning in PostgREST filter syntax. */
export function sanitizeSearch(q: string): string {
  return q.replace(/[,()%*\\:"']/g, ' ').trim();
}

export function examplesRouter(deps: AppDeps): Router {
  const router = Router({ mergeParams: true });

  async function embedQuestions(texts: string[]): Promise<(number[] | null)[]> {
    try {
      return await deps.llm.embed(texts, 'query');
    } catch (err) {
      // Saved anyway; embeddings are backfilled on the next start. Pinned examples work without them.
      deps.logger.warn({ err: errorMessage(err) }, 'Embedding training examples failed');
      return texts.map(() => null);
    }
  }

  async function assertCapacity(consultantId: string, { db, user }: Pick<ReturnType<typeof owned>, 'db' | 'user'>, adding: number) {
    const plan = await planOf(deps, user.id);
    const max = Math.min(plan.maxExamplesPerConsultant, deps.config.limits.maxExamplesPerConsultant);
    const { count, error } = await db
      .from('training_examples')
      .select('id', { count: 'exact', head: true })
      .eq('consultant_id', consultantId);
    if (error) throw dbError(error, 'counting examples');
    if ((count ?? 0) + adding > max) {
      throw new AppError(403, 'limit_reached', `Your plan allows up to ${max} examples per consultant`, { plan: plan.id, max });
    }
  }

  /** Importing real chats is a Business/Pro feature. */
  async function assertChatImport(userId: string) {
    if (!(await planOf(deps, userId)).chatImport) {
      throw planRequired('chatImport', 'Chat import is included in the Business and Pro plans');
    }
  }

  router.get('/', async (req, res) => {
    const { consultant, db } = owned(req);
    const { q, page, pinned } = parse(listQuery, req.query);
    let query = db
      .from('training_examples')
      .select(COLUMNS, { count: 'exact' })
      .eq('consultant_id', consultant.id)
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
    if (pinned) query = query.eq('is_pinned', pinned === 'true');
    const term = q ? sanitizeSearch(q) : '';
    if (term) query = query.or(`customer_message.ilike.*${term}*,ideal_reply.ilike.*${term}*`);
    const { data, error, count } = await query;
    if (error) throw dbError(error, 'listing examples');
    res.json({ examples: data ?? [], total: count ?? 0, page, pageSize: PAGE_SIZE });
  });

  router.post('/', async (req, res) => {
    const ctx = owned(req);
    const { consultant } = ctx;
    const body = parse(exampleSchema, req.body ?? {});
    await assertCapacity(consultant.id, ctx, 1);
    const [embedding] = await embedQuestions([body.customer_message]);
    const { data, error } = await deps.admin
      .from('training_examples')
      .insert({ ...body, consultant_id: consultant.id, embedding: embedding ? toVector(embedding) : null })
      .select(COLUMNS)
      .single();
    if (error) throw dbError(error, 'saving example');
    await deps.store.logEvent(consultant.id, 'example_added', 'Training example added', { meta: { source: body.source } });
    res.status(201).json({ example: data });
  });

  router.post('/bulk', async (req, res) => {
    const ctx = owned(req);
    const { consultant } = ctx;
    const { examples } = parse(bulkSchema, req.body ?? {});
    await assertChatImport(ctx.user.id);
    await assertCapacity(consultant.id, ctx, examples.length);
    const embeddings = await embedQuestions(examples.map((e) => e.customer_message));
    const rows = examples.map((e, i) => ({
      consultant_id: consultant.id,
      customer_message: e.customer_message,
      ideal_reply: e.ideal_reply,
      notes: e.notes ?? null,
      source: 'import' as const,
      embedding: embeddings[i] ? toVector(embeddings[i]!) : null,
    }));
    const { error } = await deps.admin.from('training_examples').insert(rows);
    if (error) throw dbError(error, 'importing examples');
    await deps.store.logEvent(consultant.id, 'examples_imported', `Imported ${rows.length} training examples`);
    res.status(201).json({ imported: rows.length });
  });

  router.post('/parse-transcript', async (req, res) => {
    const { user } = owned(req);
    await assertChatImport(user.id);
    const body = parse(transcriptSchema, req.body ?? {});
    try {
      const parsed = parseTranscript(body.content, { format: body.format, businessSpeaker: body.businessSpeaker });
      res.json({ ...parsed, pairs: parsed.pairs.slice(0, 500), totalPairs: parsed.pairs.length });
    } catch (err) {
      throw badRequest(errorMessage(err));
    }
  });

  router.patch('/:exampleId', async (req, res) => {
    const { consultant } = owned(req);
    const id = parse(uuidParam, req.params.exampleId);
    const body = parse(updateSchema, req.body ?? {});
    if (!Object.keys(body).length) throw badRequest('Nothing to update');
    const patch: Record<string, unknown> = { ...body };
    if (body.customer_message) {
      const [embedding] = await embedQuestions([body.customer_message]);
      patch.embedding = embedding ? toVector(embedding) : null;
    }
    const { data, error } = await deps.admin
      .from('training_examples')
      .update(patch)
      .eq('id', id)
      .eq('consultant_id', consultant.id)
      .select(COLUMNS)
      .maybeSingle();
    if (error) throw dbError(error, 'updating example');
    if (!data) throw notFound('Example');
    res.json({ example: data });
  });

  router.delete('/:exampleId', async (req, res) => {
    const { consultant } = owned(req);
    const id = parse(uuidParam, req.params.exampleId);
    const { data, error } = await deps.admin
      .from('training_examples')
      .delete()
      .eq('id', id)
      .eq('consultant_id', consultant.id)
      .select('id');
    if (error) throw dbError(error, 'deleting example');
    if (!data?.length) throw notFound('Example');
    res.status(204).end();
  });

  return router;
}
