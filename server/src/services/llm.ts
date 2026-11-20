import {
  ApiError,
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type FunctionDeclaration,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Part,
  type Schema,
} from '@google/genai';
import type { AppConfig } from '../config.js';
import type { Logger } from '../lib/logger.js';

export type LlmPart = { text: string } | { inlineData: { mimeType: string; data: string } };

export interface LlmMessage {
  role: 'user' | 'model';
  parts: LlmPart[];
}

export interface GenerateRequest {
  system: string;
  messages: LlmMessage[];
  temperature?: number;
  maxOutputTokens?: number;
}

export interface GenerateJsonRequest extends GenerateRequest {
  /** JSON Schema for the response (Gemini structured output). */
  schema: Record<string, unknown>;
}

export interface LlmUsage {
  promptTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface GenerateResult<T = unknown> {
  /** Parsed JSON when a schema was requested and the output parsed. */
  data: T | null;
  text: string;
  model: string;
  finishReason: string | null;
  /** True when Gemini refused/blocked the prompt or the answer for safety reasons. */
  blocked: boolean;
  usage: LlmUsage;
}

export type EmbeddingKind = 'query' | 'document';

/** A function the model may call (JSON Schema parameters). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
}

/**
 * One agent turn: the model calls tools (each executed by `execute`) until it calls `finalTool`,
 * whose arguments are the turn's result (e.g. the reply to send). Tools must be safe to run again
 * with the same arguments: a failed turn may be retried from the start on the backup model.
 */
export interface AgentRunRequest extends GenerateRequest {
  tools: ToolSpec[];
  finalTool: ToolSpec;
  execute(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  maxSteps?: number;
}

export interface AgentRunResult {
  /** Arguments of the final tool call; null if the model never produced one. */
  final: Record<string, unknown> | null;
  /** Free text the model returned instead of calling the final tool (rare). */
  text: string;
  calls: ToolCallRecord[];
  model: string;
  finishReason: string | null;
  blocked: boolean;
  usage: LlmUsage;
}

/** The model-facing contract used by the rest of the app (and faked in tests). */
export interface Llm {
  generateJson<T>(req: GenerateJsonRequest): Promise<GenerateResult<T>>;
  generateText(req: GenerateRequest): Promise<GenerateResult<never>>;
  /** Tool-using turn (the Pro plan agent). */
  runAgent(req: AgentRunRequest): Promise<AgentRunResult>;
  embed(texts: string[], kind: EmbeddingKind, titles?: (string | undefined)[]): Promise<number[][]>;
  /** OCR / transcription for scanned PDFs and images uploaded to the knowledge base. */
  extractDocumentText(data: Buffer, mimeType: string): Promise<string>;
}

export class LlmError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  constructor(message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retryable = retryable;
  }
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const BLOCK_REASONS = new Set(['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);
const EMBED_BATCH = 50;
const DEFAULT_AGENT_STEPS = 6;

export function toLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof ApiError) {
    return new LlmError(`Gemini API error ${err.status}: ${err.message}`, err.status, RETRYABLE_STATUS.has(err.status));
  }
  const e = err as { name?: string; message?: string; code?: string };
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
    return new LlmError('Gemini request timed out', 408, true);
  }
  const network = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(e?.code ?? '');
  return new LlmError(e?.message ?? 'Unknown Gemini error', null, network || /fetch failed/i.test(e?.message ?? ''));
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; logger?: Logger; label?: string } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 600;
  let lastError: LlmError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = toLlmError(err);
      if (!lastError.retryable || attempt === attempts) break;
      const delay = base * 2 ** (attempt - 1) + Math.random() * base;
      opts.logger?.warn({ attempt, status: lastError.status, label: opts.label }, 'Gemini call failed, retrying');
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError ?? new LlmError('Gemini call failed', null, false);
}

export function normalizeVector(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  return norm > 0 ? v.map((x) => x / norm) : v;
}

/** Best-effort JSON extraction: plain JSON, fenced ```json blocks, or the first {...} span. */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try next */
    }
  }
  return null;
}

const THINKING_BUDGETS = { MINIMAL: 0, LOW: 512, MEDIUM: 2048, HIGH: 8192 } as const;

/**
 * Gemini 3+ models take a thinking level; Gemini 2.x models take a token budget instead
 * (and reject thinkingLevel). Lower thinking = much faster chat replies.
 */
export function thinkingFor(model: string, level: AppConfig['gemini']['thinkingLevel']): Partial<GenerateContentConfig> {
  if (!level) return {};
  if (/^gemini-2\./.test(model)) {
    const budget = model.includes('pro') ? Math.max(128, THINKING_BUDGETS[level]) : THINKING_BUDGETS[level];
    return { thinkingConfig: { thinkingBudget: budget } };
  }
  return { thinkingConfig: { thinkingLevel: ThinkingLevel[level] } };
}

// ---------------------------------------------------------------------------
// Which Google endpoint a key belongs to
// ---------------------------------------------------------------------------

/** Gemini Developer API (AI Studio keys) or Vertex AI in express mode (Google Cloud keys). */
export type GeminiBackend = 'gemini-api' | 'vertex';

/**
 * Google Cloud keys bound to a service account ("AQ." prefix) work with Vertex AI; AI Studio
 * keys ("AIza") with the Gemini API. Either may also be the other kind, so both are tried.
 */
export function backendOrder(apiKey: string, preference: AppConfig['gemini']['backend']): GeminiBackend[] {
  if (preference === 'gemini-api' || preference === 'vertex') return [preference];
  return apiKey.startsWith('AQ.') ? ['vertex', 'gemini-api'] : ['gemini-api', 'vertex'];
}

/** The key itself was refused (wrong backend), as opposed to an overloaded or broken request. */
export function isKeyRejected(err: LlmError): boolean {
  if (err.status === 401 || err.status === 403) return true;
  return err.status === 400 && /api[ _-]?key|API_KEY_INVALID|credential|unauthenticated|permission/i.test(err.message);
}

/** JSON Schema → the OpenAPI-style Schema that every Gemini endpoint and model accepts. */
export function toGeminiSchema(schema: Record<string, unknown>): Schema {
  const out: Record<string, unknown> = {};
  if (typeof schema.type === 'string') out.type = schema.type.toUpperCase();
  for (const key of ['description', 'enum', 'required', 'format', 'nullable', 'minimum', 'maximum', 'minItems', 'maxItems'] as const) {
    if (schema[key] !== undefined) out[key] = schema[key];
  }
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties as Record<string, Record<string, unknown>>).map(([k, v]) => [k, toGeminiSchema(v)]),
    );
  }
  if (schema.items && typeof schema.items === 'object') out.items = toGeminiSchema(schema.items as Record<string, unknown>);
  return out as Schema;
}

function resultMeta(response: GenerateContentResponse, model: string) {
  const candidate = response.candidates?.[0];
  const finishReason = (candidate?.finishReason as string | undefined) ?? null;
  const blockReason = (response.promptFeedback?.blockReason as string | undefined) ?? null;
  return {
    model: response.modelVersion ?? model,
    finishReason: finishReason ?? blockReason,
    blocked: Boolean(blockReason) || (finishReason !== null && BLOCK_REASONS.has(finishReason)),
    usage: {
      promptTokens: response.usageMetadata?.promptTokenCount,
      outputTokens: response.usageMetadata?.candidatesTokenCount,
      totalTokens: response.usageMetadata?.totalTokenCount,
    },
  };
}

function addUsage(total: LlmUsage, more: LlmUsage): LlmUsage {
  const sum = (a?: number, b?: number) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
  return {
    promptTokens: sum(total.promptTokens, more.promptTokens),
    outputTokens: sum(total.outputTokens, more.outputTokens),
    totalTokens: sum(total.totalTokens, more.totalTokens),
  };
}

const FINAL_TOOL_DEFERRED = {
  ok: false,
  note: 'Not sent: other tools were called in the same step. Read their results, then call this tool again with the final reply.',
};

export function createGeminiLlm(config: AppConfig['gemini'], logger: Logger): Llm {
  const isEmbedding2 = config.embeddingModel.startsWith('gemini-embedding-2');
  const order = backendOrder(config.apiKey, config.backend);
  const clients = new Map<GeminiBackend, GoogleGenAI>();
  let active = 0;

  const clientFor = (backend: GeminiBackend) => {
    let ai = clients.get(backend);
    if (!ai) {
      ai = new GoogleGenAI(backend === 'vertex' ? { vertexai: true, apiKey: config.apiKey } : { apiKey: config.apiKey });
      clients.set(backend, ai);
    }
    return ai;
  };

  /** Runs `fn` on the endpoint that accepts the key, remembering which one did. */
  async function onBackend<T>(fn: (ai: GoogleGenAI, backend: GeminiBackend) => Promise<T>): Promise<T> {
    for (let i = 0; i < order.length; i++) {
      const index = (active + i) % order.length;
      const backend = order[index]!;
      try {
        const result = await fn(clientFor(backend), backend);
        if (index !== active) {
          active = index;
          logger.info({ backend }, 'Gemini key works with this endpoint; using it from now on');
        }
        return result;
      } catch (err) {
        const e = toLlmError(err);
        if (i === order.length - 1 || !isKeyRejected(e)) throw e;
        logger.warn({ backend, status: e.status }, 'Gemini endpoint rejected the key; trying the other endpoint');
      }
    }
    throw new LlmError('No Gemini endpoint accepted the key', 401, false);
  }

  /** Retries transient errors, then fails over to the backup model for retired/overloaded models. */
  async function call<T>(fn: (ai: GoogleGenAI, backend: GeminiBackend, model: string) => Promise<T>): Promise<T> {
    const attempt = (model: string, attempts: number, baseDelayMs: number) =>
      withRetry(() => onBackend((ai, backend) => fn(ai, backend, model)), { logger, label: model, attempts, baseDelayMs });
    try {
      // With a backup model configured, fail over quickly instead of waiting out long backoffs:
      // overloaded (503) primary calls otherwise stretch a chat reply to 30 s+.
      return await attempt(config.model, config.fallbackModel ? 2 : 3, config.fallbackModel ? 300 : 600);
    } catch (err) {
      const e = toLlmError(err);
      if (config.fallbackModel && (e.status === 404 || e.status === 429 || e.status === 503 || e.status === 500)) {
        logger.warn({ status: e.status, fallback: config.fallbackModel }, 'Primary Gemini model failed; using fallback model');
        return await attempt(config.fallbackModel, 2, 600);
      }
      throw e;
    }
  }

  async function withTimeout<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async function generate(req: GenerateRequest, schema: Record<string, unknown> | null, timeoutMs = config.timeoutMs) {
    return call((ai, backend, model) =>
      withTimeout(timeoutMs, async (signal) => {
        const response = await ai.models.generateContent({
          model,
          contents: req.messages as Content[],
          config: {
            systemInstruction: req.system,
            temperature: req.temperature,
            maxOutputTokens: req.maxOutputTokens ?? 4096,
            abortSignal: signal,
            ...thinkingFor(model, config.thinkingLevel),
            ...(schema
              ? backend === 'vertex'
                ? { responseMimeType: 'application/json', responseSchema: toGeminiSchema(schema) }
                : { responseMimeType: 'application/json', responseJsonSchema: schema }
              : {}),
          },
        });
        const text = response.text ?? '';
        return { data: null, text, ...resultMeta(response, model) } satisfies GenerateResult<never>;
      }),
    );
  }

  async function runAgent(req: AgentRunRequest): Promise<AgentRunResult> {
    const contents: Content[] = [...(req.messages as Content[])];
    const all = [...req.tools, req.finalTool];
    const calls: ToolCallRecord[] = [];
    let usage: LlmUsage = {};
    let model = config.model;
    const maxSteps = req.maxSteps ?? DEFAULT_AGENT_STEPS;

    for (let step = 0; step <= maxSteps; step++) {
      // Out of steps: only the final tool is allowed, so the turn always ends with a reply.
      const onlyFinal = step === maxSteps;
      const response = await call((ai, backend, m) =>
        withTimeout(config.timeoutMs, async (signal) => {
          const declarations: FunctionDeclaration[] = all.map((t) =>
            backend === 'vertex'
              ? { name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) }
              : { name: t.name, description: t.description, parametersJsonSchema: t.parameters },
          );
          const r = await ai.models.generateContent({
            model: m,
            contents,
            config: {
              systemInstruction: req.system,
              temperature: req.temperature,
              maxOutputTokens: req.maxOutputTokens ?? 4096,
              abortSignal: signal,
              ...thinkingFor(m, config.thinkingLevel),
              tools: [{ functionDeclarations: declarations }],
              toolConfig: {
                functionCallingConfig: {
                  mode: FunctionCallingConfigMode.ANY,
                  ...(onlyFinal ? { allowedFunctionNames: [req.finalTool.name] } : {}),
                },
              },
            },
          });
          model = m;
          return r;
        }),
      );
      const meta = resultMeta(response, model);
      usage = addUsage(usage, meta.usage);
      if (meta.blocked) return { final: null, text: '', calls, model: meta.model, finishReason: meta.finishReason, blocked: true, usage };

      const fnCalls = response.functionCalls ?? [];
      const finalCall = fnCalls.find((c) => c.name === req.finalTool.name);
      const actionCalls = fnCalls.filter((c) => c.name !== req.finalTool.name);
      if (finalCall && (!actionCalls.length || onlyFinal)) {
        return { final: (finalCall.args ?? {}) as Record<string, unknown>, text: '', calls, model: meta.model, finishReason: meta.finishReason, blocked: false, usage };
      }
      if (!fnCalls.length) {
        return { final: null, text: response.text ?? '', calls, model: meta.model, finishReason: meta.finishReason, blocked: false, usage };
      }

      // Keep the model's own turn verbatim: Gemini 3 needs its thought signatures back.
      const modelTurn = response.candidates?.[0]?.content;
      contents.push(modelTurn ?? { role: 'model', parts: fnCalls.map((c) => ({ functionCall: c }) as Part) });
      const responses: Part[] = [];
      for (const c of fnCalls) {
        const name = c.name ?? '';
        const args = (c.args ?? {}) as Record<string, unknown>;
        let result: Record<string, unknown>;
        if (name === req.finalTool.name) {
          result = FINAL_TOOL_DEFERRED;
        } else if (!req.tools.some((t) => t.name === name)) {
          result = { ok: false, error: `Unknown tool ${name}` };
        } else {
          result = await req.execute(name, args);
          calls.push({ name, args, result });
        }
        responses.push({ functionResponse: { ...(c.id ? { id: c.id } : {}), name, response: result } });
      }
      contents.push({ role: 'user', parts: responses });
    }
    return { final: null, text: '', calls, model, finishReason: 'MAX_STEPS', blocked: false, usage };
  }

  async function embedBatch(texts: string[], kind: EmbeddingKind, titles?: (string | undefined)[]): Promise<number[][]> {
    const response = await withRetry(
      () =>
        onBackend((ai) => {
          if (isEmbedding2) {
            // gemini-embedding-2 takes the task as a text prefix and aggregates parts inside one
            // Content, so every input is wrapped in its own Content.
            return ai.models.embedContent({
              model: config.embeddingModel,
              contents: texts.map((t, i) => ({
                parts: [
                  {
                    text:
                      kind === 'query'
                        ? `task: search result | query: ${t}`
                        : `title: ${titles?.[i] || 'none'} | text: ${t}`,
                  },
                ],
              })),
              config: { outputDimensionality: config.embeddingDimensions },
            });
          }
          return ai.models.embedContent({
            model: config.embeddingModel,
            contents: texts,
            config: {
              taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
              outputDimensionality: config.embeddingDimensions,
            },
          });
        }),
      { logger, label: config.embeddingModel },
    );
    const vectors = (response.embeddings ?? []).map((e) => e.values ?? []);
    if (vectors.length !== texts.length) {
      throw new LlmError(`Embedding count mismatch: expected ${texts.length}, got ${vectors.length}`, null, false);
    }
    return vectors.map((v) => {
      if (v.length !== config.embeddingDimensions) {
        throw new LlmError(
          `Embedding has ${v.length} dimensions, expected ${config.embeddingDimensions}`,
          null,
          false,
        );
      }
      return normalizeVector(v);
    });
  }

  return {
    async generateJson<T>(req: GenerateJsonRequest): Promise<GenerateResult<T>> {
      const res = await generate(req, req.schema);
      return { ...res, data: parseJsonLoose(res.text) as T | null };
    },

    async generateText(req: GenerateRequest) {
      return generate(req, null);
    },

    runAgent,

    async embed(texts, kind, titles) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const slice = texts.slice(i, i + EMBED_BATCH).map((t) => t.slice(0, 8_000));
        out.push(...(await embedBatch(slice, kind, titles?.slice(i, i + EMBED_BATCH))));
      }
      return out;
    },

    async extractDocumentText(data, mimeType) {
      const res = await generate(
        {
          system:
            'You convert documents into clean text for a search index. Transcribe all readable text faithfully, ' +
            'in the original language. Keep structure: headings, lists, and tables as Markdown. ' +
            'Do not summarise, translate, or add commentary. If there is no readable text, reply with an empty string.',
          messages: [
            {
              role: 'user',
              parts: [{ inlineData: { mimeType, data: data.toString('base64') } }, { text: 'Transcribe this document.' }],
            },
          ],
          temperature: 0,
          maxOutputTokens: 32_000,
        },
        null,
        // Transcribing a long scanned PDF legitimately takes much longer than a chat reply.
        Math.max(config.timeoutMs, 180_000),
      );
      return res.text.trim();
    },
  };
}

// ---------------------------------------------------------------------------
// Backup model: Grok (or any OpenAI-compatible chat completions API)
// ---------------------------------------------------------------------------

type ChatContent = string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
type ChatMessage =
  | { role: 'system' | 'user'; content: ChatContent }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
interface ChatResponse {
  model?: string;
  choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: ChatToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** Customer messages in the chat-completions format; only images survive as media. */
export function toChatMessages(req: GenerateRequest, systemSuffix = ''): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: req.system + systemSuffix }];
  for (const m of req.messages) {
    const parts: Exclude<ChatContent, string> = m.parts.map((p) => {
      if ('text' in p) return { type: 'text' as const, text: p.text };
      if (p.inlineData.mimeType.startsWith('image/') && m.role === 'user') {
        return { type: 'image_url' as const, image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } };
      }
      return { type: 'text' as const, text: `[${p.inlineData.mimeType.split('/')[0]} attachment that cannot be opened here]` };
    });
    const onlyText = parts.every((p) => p.type === 'text');
    const text = parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
    if (m.role === 'model') out.push({ role: 'assistant', content: text });
    else out.push({ role: 'user', content: onlyText ? text : parts });
  }
  return out;
}

export function createOpenAiCompatibleLlm(
  config: NonNullable<AppConfig['grok']>,
  logger: Logger,
  fetchImpl: typeof fetch = fetch,
): Llm {
  async function chat(body: Record<string, unknown>): Promise<ChatResponse> {
    return withRetry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeoutMs);
        try {
          const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
            body: JSON.stringify({ model: config.model, ...body }),
            signal: controller.signal,
          });
          const raw = await res.text();
          if (!res.ok) {
            throw new LlmError(`Grok API error ${res.status}: ${raw.slice(0, 300)}`, res.status, RETRYABLE_STATUS.has(res.status));
          }
          return JSON.parse(raw) as ChatResponse;
        } catch (err) {
          if ((err as Error)?.name === 'AbortError') throw new LlmError('Grok request timed out', 408, true);
          throw err;
        } finally {
          clearTimeout(timer);
        }
      },
      { logger, label: config.model, attempts: 2 },
    );
  }

  const usageOf = (r: ChatResponse): LlmUsage => ({
    promptTokens: r.usage?.prompt_tokens,
    outputTokens: r.usage?.completion_tokens,
    totalTokens: r.usage?.total_tokens,
  });

  async function generate(req: GenerateRequest, schema: Record<string, unknown> | null): Promise<GenerateResult<never>> {
    const suffix = schema
      ? `\n\nReply with a single JSON object (no Markdown fences) that follows this JSON Schema:\n${JSON.stringify(schema)}`
      : '';
    const r = await chat({
      messages: toChatMessages(req, suffix),
      temperature: req.temperature,
      max_tokens: req.maxOutputTokens ?? 4096,
    });
    const choice = r.choices?.[0];
    return {
      data: null,
      text: choice?.message?.content ?? '',
      model: r.model ?? config.model,
      finishReason: choice?.finish_reason ?? null,
      blocked: choice?.finish_reason === 'content_filter',
      usage: usageOf(r),
    };
  }

  const unsupported = (what: string) => new LlmError(`${what} is not available on the backup model`, null, false);

  return {
    async generateJson<T>(req: GenerateJsonRequest) {
      const res = await generate(req, req.schema);
      return { ...res, data: parseJsonLoose(res.text) as T | null };
    },
    generateText: (req) => generate(req, null),
    async runAgent(req) {
      const messages = toChatMessages(req);
      const tools = [...req.tools, req.finalTool].map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      const calls: ToolCallRecord[] = [];
      let usage: LlmUsage = {};
      let model = config.model;
      const maxSteps = req.maxSteps ?? DEFAULT_AGENT_STEPS;
      for (let step = 0; step <= maxSteps; step++) {
        const onlyFinal = step === maxSteps;
        const r = await chat({
          messages,
          tools,
          tool_choice: onlyFinal ? { type: 'function', function: { name: req.finalTool.name } } : 'required',
          temperature: req.temperature,
          max_tokens: req.maxOutputTokens ?? 4096,
        });
        model = r.model ?? model;
        usage = addUsage(usage, usageOf(r));
        const message = r.choices?.[0]?.message;
        const toolCalls = message?.tool_calls ?? [];
        const parsed = toolCalls.map((c) => ({ call: c, args: (parseJsonLoose(c.function.arguments) ?? {}) as Record<string, unknown> }));
        const finalCall = parsed.find((p) => p.call.function.name === req.finalTool.name);
        const actions = parsed.filter((p) => p.call.function.name !== req.finalTool.name);
        if (finalCall && (!actions.length || onlyFinal)) {
          return { final: finalCall.args, text: '', calls, model, finishReason: 'STOP', blocked: false, usage };
        }
        if (!toolCalls.length) {
          return { final: null, text: message?.content ?? '', calls, model, finishReason: r.choices?.[0]?.finish_reason ?? null, blocked: false, usage };
        }
        messages.push({ role: 'assistant', content: message?.content ?? null, tool_calls: toolCalls });
        for (const { call: c, args } of parsed) {
          const name = c.function.name;
          let result: Record<string, unknown>;
          if (name === req.finalTool.name) result = FINAL_TOOL_DEFERRED;
          else if (!req.tools.some((t) => t.name === name)) result = { ok: false, error: `Unknown tool ${name}` };
          else {
            result = await req.execute(name, args);
            calls.push({ name, args, result });
          }
          messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) });
        }
      }
      return { final: null, text: '', calls, model, finishReason: 'MAX_STEPS', blocked: false, usage };
    },
    async embed() {
      throw unsupported('Embedding');
    },
    async extractDocumentText() {
      throw unsupported('Document reading');
    },
  };
}

/**
 * The app's model: Gemini, with Grok (when configured) answering whenever Gemini fails after its
 * own retries and backup model. Embeddings and document reading stay on Gemini.
 */
export function createLlm(config: Pick<AppConfig, 'gemini' | 'grok'>, logger: Logger, fetchImpl?: typeof fetch): Llm {
  const gemini = createGeminiLlm(config.gemini, logger);
  if (!config.grok) return gemini;
  const grok = createOpenAiCompatibleLlm(config.grok, logger, fetchImpl);
  async function withBackup<T>(label: string, primary: () => Promise<T>, backup: () => Promise<T>): Promise<T> {
    try {
      return await primary();
    } catch (err) {
      logger.warn({ err: toLlmError(err).message.slice(0, 300), label }, 'Gemini failed; answering with the backup model');
      return backup();
    }
  }
  return {
    generateJson: (req) => withBackup('json', () => gemini.generateJson(req), () => grok.generateJson(req)),
    generateText: (req) => withBackup('text', () => gemini.generateText(req), () => grok.generateText(req)),
    runAgent: (req) => withBackup('agent', () => gemini.runAgent(req), () => grok.runAgent(req)),
    embed: (texts, kind, titles) => gemini.embed(texts, kind, titles),
    extractDocumentText: (data, mimeType) => gemini.extractDocumentText(data, mimeType),
  };
}
