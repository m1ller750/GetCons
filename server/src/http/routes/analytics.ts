import { Router } from 'express';
import { z } from 'zod';
import type { MessageRow } from '../../db/types.js';
import { dbError } from '../../lib/errors.js';
import { owned, type AppDeps } from '../deps.js';
import { parse } from '../middleware.js';
import { planOf } from '../plan.js';

const overviewQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  chartDays: z.coerce.number().int().min(7).max(90).default(14),
  tz: z
    .string()
    .max(64)
    .regex(/^[A-Za-z0-9_+\-/]+$/)
    .default('UTC'),
});

const limitQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function analyticsRouter(deps: AppDeps): Router {
  const router = Router({ mergeParams: true });

  router.get('/', async (req, res) => {
    const { consultant, db, user } = owned(req);
    const q = parse(overviewQuery, req.query);
    const tz = isValidTimeZone(q.tz) ? q.tz : 'UTC';
    // History depth depends on the plan (Free 7 days, Start 30, Business/Pro 90).
    const maxDays = (await planOf(deps, user.id)).analyticsDays;
    q.days = Math.min(q.days, maxDays);
    q.chartDays = Math.max(7, Math.min(q.chartDays, maxDays));

    const [overview, daily, docs, examples] = await Promise.all([
      db.rpc('consultant_overview', { p_consultant_id: consultant.id, p_days: q.days }),
      db.rpc('consultant_daily_stats', { p_consultant_id: consultant.id, p_days: q.chartDays, p_tz: tz }),
      db.from('knowledge_documents').select('id, status, chunk_count').eq('consultant_id', consultant.id),
      db.from('training_examples').select('id', { count: 'exact', head: true }).eq('consultant_id', consultant.id),
    ]);
    if (overview.error) throw dbError(overview.error, 'loading analytics');
    if (daily.error) throw dbError(daily.error, 'loading daily stats');
    if (docs.error) throw dbError(docs.error, 'loading documents');

    const o = ((overview.data as Record<string, number | null>[] | null) ?? [])[0] ?? {};
    const num = (v: unknown) => Number(v ?? 0);
    const aiReplies = num(o.ai_replies);
    const docRows = (docs.data ?? []) as { status: string; chunk_count: number }[];

    res.json({
      periodDays: q.days,
      kpis: {
        conversations: num(o.conversations),
        activeConversations: num(o.active_conversations),
        customerMessages: num(o.customer_messages),
        aiReplies,
        fallbacks: num(o.fallbacks),
        handoffs: num(o.handoffs),
        errors: num(o.errors),
        operatorReplies: num(o.operator_replies),
        needsAttention: num(o.needs_attention),
        avgLatencyMs: o.avg_latency_ms === null || o.avg_latency_ms === undefined ? null : Math.round(Number(o.avg_latency_ms)),
        automationRate: aiReplies ? Math.round(((aiReplies - num(o.fallbacks) - num(o.handoffs)) / aiReplies) * 1000) / 10 : null,
      },
      daily: ((daily.data ?? []) as Record<string, unknown>[]).map((d) => ({
        day: String(d.day),
        customerMessages: num(d.customer_messages),
        aiReplies: num(d.ai_replies),
        fallbacks: num(d.fallbacks),
        operatorReplies: num(d.operator_replies),
        conversations: num(d.conversations),
      })),
      knowledge: {
        documents: docRows.length,
        ready: docRows.filter((d) => d.status === 'ready').length,
        chunks: docRows.reduce((n, d) => n + (d.chunk_count ?? 0), 0),
        examples: examples.count ?? 0,
      },
    });
  });

  // "Knowledge gaps": questions the consultant could not answer. One click turns them into examples.
  router.get('/gaps', async (req, res) => {
    const { consultant, db } = owned(req);
    const { limit } = parse(limitQuery, req.query);
    const { data, error } = await db
      .from('messages')
      .select('id, conversation_id, content, status, meta, created_at')
      .eq('consultant_id', consultant.id)
      .eq('role', 'assistant')
      .in('status', ['fallback', 'handoff', 'error'])
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw dbError(error, 'loading knowledge gaps');
    res.json({
      gaps: ((data ?? []) as Pick<MessageRow, 'id' | 'conversation_id' | 'content' | 'status' | 'meta' | 'created_at'>[])
        .filter((m) => m.meta?.question)
        .map((m) => ({
          id: m.id,
          conversationId: m.conversation_id,
          question: m.meta.question,
          reply: m.content,
          status: m.status,
          reason: (m.meta.attention_reason as string | undefined) ?? null,
          createdAt: m.created_at,
        })),
    });
  });

  return router;
}

export function activityRouter(_deps: AppDeps): Router {
  const router = Router({ mergeParams: true });
  router.get('/', async (req, res) => {
    const { consultant, db } = owned(req);
    const { limit } = parse(limitQuery, req.query);
    const { data, error } = await db
      .from('activity_events')
      .select('id, type, level, message, meta, created_at')
      .eq('consultant_id', consultant.id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw dbError(error, 'loading activity');
    res.json({ events: data ?? [] });
  });
  return router;
}
