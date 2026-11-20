import { describe, expect, it } from 'vitest';
import {
  buildContents,
  buildRetrievalQuery,
  buildSystemInstruction,
  decideOutcome,
  DEFAULT_FALLBACK_MESSAGE,
  formatBusinessInfo,
  parseModelReply,
} from '../src/services/prompt.js';
import { makeConsultant } from './helpers/fakes.js';

describe('system instruction', () => {
  const consultant = makeConsultant({
    name: 'Anna',
    instructions: 'Always offer gift wrapping.',
    business_info: { businessName: 'Bloom', pricing: 'Roses $5', hours: '9-21', description: '' },
    fallback_message: 'I will ask the florist.',
    use_emojis: false,
  });

  it('contains the owner instructions, business facts, knowledge and few-shot examples', () => {
    const prompt = buildSystemInstruction({
      consultant,
      knowledge: [{ id: 'c1', documentId: 'd1', documentTitle: 'Price list', content: 'Tulips cost $3.', similarity: 0.8 }],
      examples: [{ id: 'e1', customerMessage: 'Do you deliver?', idealReply: 'Yes, within 2 hours!' }],
      summary: '- Customer wants red roses',
      customer: { name: 'Maria', username: 'maria', language: 'ru' },
    });
    expect(prompt).toContain('"Anna", the AI customer-service consultant of Bloom');
    expect(prompt).toContain('Always offer gift wrapping.');
    expect(prompt).toContain('## Prices\nRoses $5');
    expect(prompt).toContain('[K1] (source: "Price list")\nTulips cost $3.');
    expect(prompt).toContain('Customer: Do you deliver?\nIdeal reply: Yes, within 2 hours!');
    expect(prompt).toContain('- Customer wants red roses');
    expect(prompt).toContain('name: Maria; username: @maria');
    expect(prompt).toContain('I will ask the florist.');
    expect(prompt).toContain('do not use emojis');
    expect(prompt).toContain('reply in the language the customer writes in');
    // empty business fields are omitted
    expect(prompt).not.toContain('About the business');
  });

  it('says so when nothing relevant was retrieved and switches strictness/handoff rules', () => {
    const strict = buildSystemInstruction({
      consultant: { ...consultant, strictness: 'strict', handoff_enabled: false, language: 'Russian' },
      knowledge: [],
      examples: [],
    });
    expect(strict).toContain('(No relevant excerpts were found.)');
    expect(strict).toContain('Stay strictly within Bloom');
    expect(strict).toContain('Do not promise that a human will join');
    expect(strict).toContain('Always reply in Russian');
    expect(strict).not.toContain('# Examples of ideal replies');
  });

  it('formats only filled business fields', () => {
    expect(formatBusinessInfo({})).toBe('');
    expect(formatBusinessInfo({ businessName: 'X', contacts: '+1 555' })).toBe('Business name: X\n\n## Contacts\n+1 555');
  });
});

describe('conversation contents (memory)', () => {
  it('maps roles, merges consecutive turns and marks human team replies', () => {
    const contents = buildContents(
      [
        { role: 'assistant', content: 'Welcome!' },
        { role: 'customer', content: 'Hi' },
        { role: 'customer', content: 'Price?' },
        { role: 'operator', content: 'It is $5' },
        { role: 'system', content: 'ignored' },
      ],
      [{ text: 'And delivery?' }],
    );
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user', 'model', 'user']);
    expect(contents[0]!.parts).toEqual([{ text: '/start' }]);
    expect(contents[2]!.parts).toEqual([{ text: 'Hi' }, { text: 'Price?' }]);
    expect(contents[3]!.parts).toEqual([{ text: '[Team member] It is $5' }]);
    expect(contents[4]!.parts).toEqual([{ text: 'And delivery?' }]);
  });

  it('puts media inline in the current turn', () => {
    const contents = buildContents([], [{ text: '', media: { mimeType: 'image/jpeg', data: 'AAAA', kind: 'photo' } }]);
    expect(contents[0]!.parts[0]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } });
    expect(contents[0]!.parts[1]).toEqual({ text: '(The customer sent a photo.)' });
  });

  it('includes the previous question for short follow-ups when retrieving', () => {
    expect(buildRetrievalQuery([{ role: 'customer', content: 'Do you sell peonies?' }], [{ text: 'how much?' }])).toBe(
      'Do you sell peonies?\nhow much?',
    );
    const long = 'I would like to order a large bouquet of white peonies for Saturday morning please';
    expect(buildRetrievalQuery([{ role: 'customer', content: 'old' }], [{ text: long }])).toBe(long);
  });
});

describe('structured output and fallback decisions', () => {
  const consultant = { fallback_message: 'Owner fallback', handoff_enabled: true };

  it('parses valid output and clamps confidence', () => {
    const r = parseModelReply({ reply: ' Hi ', answer_status: 'partial', confidence: 7, used_knowledge_ids: ['K1', 3] });
    expect(r).toEqual({ reply: 'Hi', answer_status: 'partial', confidence: 1, used_knowledge_ids: ['K1'], media_summary: '' });
  });

  it('accepts JSON in a string, plain prose, and rejects broken JSON', () => {
    expect(parseModelReply(null, '```json\n{"reply":"Yes","answer_status":"answered","confidence":0.8}\n```')?.reply).toBe('Yes');
    expect(parseModelReply(null, 'Just a plain answer')?.reply).toBe('Just a plain answer');
    expect(parseModelReply(null, '{"reply": "trunc')).toBeNull();
    expect(parseModelReply({ answer_status: 'answered' })).toBeNull();
  });

  it('decides what to send', () => {
    const base = { reply: 'R', confidence: 0.9, used_knowledge_ids: [], media_summary: '' };
    expect(decideOutcome({ ...base, answer_status: 'answered' }, consultant)).toMatchObject({ status: 'ok', needsAttention: false, text: 'R' });
    expect(decideOutcome({ ...base, answer_status: 'partial' }, consultant)).toMatchObject({ status: 'ok', needsAttention: true });
    expect(decideOutcome({ ...base, answer_status: 'unknown' }, consultant)).toMatchObject({ status: 'fallback', needsAttention: true });
    expect(decideOutcome({ ...base, answer_status: 'handoff' }, consultant)).toMatchObject({ status: 'handoff', needsAttention: true });
    expect(decideOutcome({ ...base, answer_status: 'handoff' }, { ...consultant, handoff_enabled: false })).toMatchObject({ status: 'fallback' });
    expect(decideOutcome(null, consultant)).toMatchObject({ status: 'error', text: 'Owner fallback' });
    expect(decideOutcome({ ...base, answer_status: 'answered' }, consultant, true)).toMatchObject({ status: 'error' });
    expect(decideOutcome(null, { fallback_message: '  ', handoff_enabled: true }).text).toBe(DEFAULT_FALLBACK_MESSAGE);
  });
});
