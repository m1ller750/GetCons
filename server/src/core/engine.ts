import type { AppConfig } from '../config.js';
import type { Store } from '../db/store.js';
import type { ConsultantRow, ConversationRow, MessageMeta, MessageRow } from '../db/types.js';
import { errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { AgentRunResult, GenerateResult, Llm } from '../services/llm.js';
import { replyTool, type AgentTurn } from './agent/tools.js';
import {
  REPLY_SCHEMA,
  buildContents,
  buildRetrievalQuery,
  buildSystemInstruction,
  decideOutcome,
  parseModelReply,
  type FewShotExample,
  type KnowledgeSnippet,
  type ModelReply,
  type PendingMessage,
  type ReplyOutcome,
} from '../services/prompt.js';

export interface EngineDeps {
  store: Store;
  llm: Llm;
  config: AppConfig;
  logger: Logger;
}

export interface GenerateReplyInput {
  consultant: ConsultantRow;
  conversation: ConversationRow;
  /** Chronological history that precedes the pending messages. */
  history: MessageRow[];
  /** Customer messages that have not been answered yet (text + optional media). */
  pending: PendingMessage[];
  /** Pro plan agent: tools it may use this turn (null = a consultant that only answers). */
  agent?: AgentTurn | null;
}

export interface GeneratedReply {
  text: string;
  status: ReplyOutcome;
  needsAttention: boolean;
  attentionReason: string | null;
  modelReply: ModelReply | null;
  meta: MessageMeta;
}

/**
 * The consultant's "brain" for one turn:
 *   1. embed the customer's question
 *   2. retrieve relevant knowledge chunks (hybrid RAG) and similar owner-written examples (few-shot)
 *   3. build a consultant-specific system instruction + conversation memory
 *   4. ask Gemini for a structured answer and decide whether to answer, fall back, or hand off
 * Never throws: on any failure it returns the owner's fallback message with status "error".
 */
export async function generateReply(deps: EngineDeps, input: GenerateReplyInput): Promise<GeneratedReply> {
  const { store, llm, config, logger } = deps;
  const { consultant, conversation, pending } = input;
  const started = Date.now();
  const window = Math.max(2, consultant.max_history_messages);
  const history = input.history.slice(-window);
  const question = pending.map((p) => p.text).filter(Boolean).join('\n').slice(0, 1000);

  // 1-2. Retrieval. Failures degrade gracefully to "no knowledge" instead of failing the reply.
  const query = buildRetrievalQuery(history, pending);
  let embedding: number[] | null = null;
  let retrievalError: string | null = null;
  if (query) {
    try {
      [embedding = null] = await llm.embed([query], 'query');
    } catch (err) {
      retrievalError = errorMessage(err);
      logger.warn({ err: retrievalError, consultantId: consultant.id }, 'Query embedding failed; using keyword search only');
    }
  }

  const [knowledgeMatches, similarExamples, pinnedExamples] = await Promise.all([
    query
      ? store.searchKnowledge(consultant.id, embedding, query, config.rag.topK).catch((err) => {
          retrievalError = errorMessage(err);
          return [];
        })
      : Promise.resolve([]),
    embedding && config.rag.fewShotK > 0
      ? store.searchExamples(consultant.id, embedding, config.rag.fewShotK).catch(() => [])
      : Promise.resolve([]),
    store.getPinnedExamples(consultant.id, config.rag.maxPinnedExamples).catch(() => []),
  ]);

  const knowledge: KnowledgeSnippet[] = knowledgeMatches
    .filter((k) => k.similarity >= config.rag.minSimilarity || k.keyword_rank > 0)
    .map((k) => ({
      id: k.id,
      documentId: k.document_id,
      documentTitle: k.document_title,
      content: k.content,
      similarity: k.similarity,
    }));

  const seen = new Set<string>();
  const examples: FewShotExample[] = [];
  for (const e of [...pinnedExamples, ...similarExamples]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    examples.push({ id: e.id, customerMessage: e.customer_message, idealReply: e.ideal_reply, notes: e.notes });
  }

  // 3. Prompt.
  const hasSummary = Boolean(
    conversation.summary &&
      (!conversation.memory_reset_at ||
        (conversation.summarized_until && conversation.summarized_until > conversation.memory_reset_at)),
  );
  const system = buildSystemInstruction({
    consultant,
    knowledge,
    examples: examples.slice(0, config.rag.fewShotK + config.rag.maxPinnedExamples),
    summary: hasSummary ? conversation.summary : null,
    customer: {
      name: conversation.customer_name,
      username: conversation.customer_username,
      language: conversation.customer_language,
    },
    channel: conversation.channel,
    agent: input.agent?.instructions ?? null,
  });
  const messages = buildContents(history, pending);

  const baseMeta: MessageMeta = {
    question,
    knowledge: knowledge.map((k) => ({
      id: k.id,
      document_id: k.documentId,
      title: k.documentTitle,
      similarity: Math.round(k.similarity * 1000) / 1000,
    })),
    examples: examples.map((e) => e.id),
    ...(retrievalError ? { retrieval_error: retrievalError.slice(0, 300) } : {}),
  };

  // 4. Generation (the agent may first use its tools: orders, returns, catalog).
  try {
    let agentRun: AgentRunResult | null = null;
    let result: Pick<GenerateResult<unknown>, 'data' | 'text' | 'model' | 'usage' | 'blocked' | 'finishReason'>;
    if (input.agent) {
      agentRun = await llm.runAgent({
        system,
        messages,
        tools: input.agent.tools,
        finalTool: replyTool(REPLY_SCHEMA),
        execute: input.agent.execute,
        temperature: consultant.temperature,
        maxOutputTokens: 4096,
      });
      result = { data: agentRun.final, text: agentRun.text, model: agentRun.model, usage: agentRun.usage, blocked: agentRun.blocked, finishReason: agentRun.finishReason };
    } else {
      result = await llm.generateJson<ModelReply>({
        system,
        messages,
        schema: REPLY_SCHEMA,
        temperature: consultant.temperature,
        maxOutputTokens: 4096,
      });
    }
    const modelReply = parseModelReply(result.data, result.text);
    const decision = decideOutcome(modelReply, consultant, result.blocked);

    // Map "K2" style citations back to chunk ids.
    const cited = new Set(
      (modelReply?.used_knowledge_ids ?? [])
        .map((label) => Number(label.replace(/[^0-9]/g, '')) - 1)
        .filter((i) => i >= 0 && i < knowledge.length)
        .map((i) => knowledge[i]!.id),
    );

    return {
      ...decision,
      modelReply,
      meta: {
        ...baseMeta,
        knowledge: baseMeta.knowledge?.map((k) => ({ ...k, cited: cited.has(k.id) })),
        latency_ms: Date.now() - started,
        model: result.model,
        usage: result.usage,
        answer_status: modelReply?.answer_status ?? 'none',
        confidence: modelReply?.confidence,
        finish_reason: result.finishReason ?? undefined,
        ...(decision.attentionReason ? { attention_reason: decision.attentionReason } : {}),
        ...(agentRun
          ? {
              agent_tools: agentRun.calls.map((c) => ({
                tool: c.name,
                ok: c.result.ok !== false,
                ...(typeof c.result.error === 'string' ? { error: c.result.error.slice(0, 200) } : {}),
              })),
            }
          : {}),
      },
    };
  } catch (err) {
    const message = errorMessage(err);
    logger.error({ err: message, consultantId: consultant.id }, 'Gemini generation failed; sending fallback');
    const decision = decideOutcome(null, consultant);
    return {
      ...decision,
      attentionReason: 'The AI service was unavailable',
      modelReply: null,
      meta: { ...baseMeta, latency_ms: Date.now() - started, error: message.slice(0, 500), attention_reason: 'The AI service was unavailable' },
    };
  }
}
