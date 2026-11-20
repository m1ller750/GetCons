import { describe, expect, it } from 'vitest';
import { silentLogger } from '../src/lib/logger.js';
import { backendOrder, createOpenAiCompatibleLlm, isKeyRejected, LlmError, toChatMessages, toGeminiSchema } from '../src/services/llm.js';
import { REPLY_SCHEMA } from '../src/services/prompt.js';

describe('Gemini keys and endpoints', () => {
  it('sends Google Cloud keys to Vertex AI first and AI Studio keys to the Gemini API first', () => {
    expect(backendOrder('AQ.Ab8RN6-example', 'auto')).toEqual(['vertex', 'gemini-api']);
    expect(backendOrder('AIzaSy-example', 'auto')).toEqual(['gemini-api', 'vertex']);
    expect(backendOrder('AQ.Ab8RN6-example', 'gemini-api')).toEqual(['gemini-api']);
    expect(backendOrder('AIzaSy-example', 'vertex')).toEqual(['vertex']);
  });

  it('switches endpoints only when the key itself is refused', () => {
    expect(isKeyRejected(new LlmError('Gemini API error 400: API key not valid. Please pass a valid API key.', 400, false))).toBe(true);
    expect(isKeyRejected(new LlmError('Gemini API error 401: UNAUTHENTICATED', 401, false))).toBe(true);
    expect(isKeyRejected(new LlmError('Gemini API error 403: PERMISSION_DENIED', 403, false))).toBe(true);
    expect(isKeyRejected(new LlmError('Gemini API error 400: Invalid JSON payload', 400, false))).toBe(false);
    expect(isKeyRejected(new LlmError('Gemini API error 503: overloaded', 503, true))).toBe(false);
  });

  it('converts JSON Schema to the schema every Gemini endpoint accepts', () => {
    const s = toGeminiSchema(REPLY_SCHEMA) as Record<string, unknown> & { properties: Record<string, Record<string, unknown>> };
    expect(s.type).toBe('OBJECT');
    expect(s.properties.used_knowledge_ids).toMatchObject({ type: 'ARRAY', items: { type: 'STRING' } });
    expect(s.properties.answer_status).toMatchObject({ type: 'STRING', enum: ['answered', 'partial', 'unknown', 'handoff'] });
    expect(s.required).toEqual(['used_knowledge_ids', 'answer_status', 'reply', 'confidence', 'media_summary']);
  });
});

describe('backup model (Grok, OpenAI-compatible)', () => {
  const config = { apiKey: 'xai-test', baseUrl: 'https://api.x.ai/v1', model: 'grok-test', timeoutMs: 5000 };

  it('runs a tool-using turn: calls tools, feeds results back, ends with the final tool', async () => {
    const bodies: Record<string, unknown>[] = [];
    let auth = '';
    const answers = [
      { choices: [{ message: { content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'find_products', arguments: '{"query":"roses"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
      { choices: [{ message: { content: null, tool_calls: [{ id: 't2', type: 'function', function: { name: 'reply', arguments: '{"reply":"Roses are $5","answer_status":"answered"}' } }] } }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
    ];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      auth = new Headers(init.headers).get('authorization') ?? '';
      return new Response(JSON.stringify(answers.shift()), { status: 200 });
    }) as typeof fetch;
    const grok = createOpenAiCompatibleLlm(config, silentLogger(), fetchImpl);
    const executed: string[] = [];
    const result = await grok.runAgent({
      system: 'You are Anna.',
      messages: [{ role: 'user', parts: [{ text: 'Roses?' }] }],
      tools: [{ name: 'find_products', description: 'search', parameters: { type: 'object', properties: { query: { type: 'string' } } } }],
      finalTool: { name: 'reply', description: 'reply', parameters: REPLY_SCHEMA },
      execute: async (name, args) => {
        executed.push(`${name}:${JSON.stringify(args)}`);
        return { ok: true, products: [{ name: 'Roses', price: '5' }] };
      },
    });
    expect(auth).toBe('Bearer xai-test');
    expect(executed).toEqual(['find_products:{"query":"roses"}']);
    expect(result.final).toEqual({ reply: 'Roses are $5', answer_status: 'answered' });
    expect(result.usage.totalTokens).toBe(37);
    expect(bodies[0]).toMatchObject({ model: 'grok-test', tool_choice: 'required' });
    expect((bodies[1]!.messages as { role: string }[]).map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
  });

  it('answers JSON requests and reports API errors with their status', async () => {
    const ok = createOpenAiCompatibleLlm(
      config,
      silentLogger(),
      (async () => new Response(JSON.stringify({ model: 'grok-x', choices: [{ message: { content: '```json\n{"reply":"Hi"}\n```' } }] }))) as typeof fetch,
    );
    const res = await ok.generateJson<{ reply: string }>({ system: 's', messages: [{ role: 'user', parts: [{ text: 'hi' }] }], schema: REPLY_SCHEMA });
    expect(res.data).toEqual({ reply: 'Hi' });
    expect(res.model).toBe('grok-x');

    const bad = createOpenAiCompatibleLlm(config, silentLogger(), (async () => new Response('{"error":"bad key"}', { status: 401 })) as typeof fetch);
    await expect(bad.generateText({ system: 's', messages: [] })).rejects.toMatchObject({ status: 401 });
    await expect(bad.embed(['x'], 'query')).rejects.toThrow(/not available/);
  });

  it('keeps images and replaces other media with a note', () => {
    const messages = toChatMessages({
      system: 'sys',
      messages: [
        { role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'AAA' } }, { text: 'What is this?' }] },
        { role: 'model', parts: [{ text: 'A rose.' }] },
        { role: 'user', parts: [{ inlineData: { mimeType: 'audio/ogg', data: 'BBB' } }] },
      ],
    });
    expect(messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } },
        { type: 'text', text: 'What is this?' },
      ],
    });
    expect(messages[2]).toEqual({ role: 'assistant', content: 'A rose.' });
    expect(messages[3]).toEqual({ role: 'user', content: '[audio attachment that cannot be opened here]' });
  });
});
