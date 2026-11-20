import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { decryptSecret, encryptSecret, maskBotToken, parseEncryptionKey, randomCode, safeEqual } from '../src/lib/crypto.js';
import { chunkText, normalizeText } from '../src/services/chunking.js';
import { normalizeVector, parseJsonLoose, thinkingFor, withRetry, LlmError } from '../src/services/llm.js';
import { escapeHtml, markdownToTelegramHtml, splitMessage, stripMarkdown } from '../src/services/telegram/format.js';
import { buildPairs, parsePlainTranscript, parseTranscript } from '../src/services/transcripts.js';
import { sanitizeSearch } from '../src/http/routes/examples.js';

describe('crypto', () => {
  const key = randomBytes(32);

  it('round-trips secrets with AES-256-GCM', () => {
    const token = '123456789:AAEexampleexampleexampleexample_abc';
    const enc = encryptSecret(token, key);
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain(token);
    expect(decryptSecret(enc, key)).toBe(token);
  });

  it('produces a different ciphertext every time', () => {
    expect(encryptSecret('x', key)).not.toBe(encryptSecret('x', key));
  });

  it('detects tampering and wrong keys', () => {
    const enc = encryptSecret('secret', key);
    const raw = Buffer.from(enc.slice(3), 'base64');
    raw.writeUInt8(raw.readUInt8(raw.length - 1) ^ 1, raw.length - 1);
    expect(() => decryptSecret(`v1:${raw.toString('base64')}`, key)).toThrow();
    expect(() => decryptSecret(enc, randomBytes(32))).toThrow();
    expect(() => decryptSecret('v0:abc', key)).toThrow(/Unsupported/);
  });

  it('parses base64 and hex keys and rejects weak ones', () => {
    const k = randomBytes(32);
    expect(parseEncryptionKey(k.toString('base64')).equals(k)).toBe(true);
    expect(parseEncryptionKey(k.toString('hex')).equals(k)).toBe(true);
    expect(() => parseEncryptionKey('too-short')).toThrow(/32 bytes/);
  });

  it('compares in constant time and masks tokens', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(maskBotToken('12345:SECRET')).toBe('12345:••••••••');
    expect(randomCode()).toMatch(/^GC-[A-Z2-9]{6}$/);
  });
});

describe('config', () => {
  const base = {
    SUPABASE_URL: 'https://abc.supabase.co',
    SUPABASE_ANON_KEY: 'anon-key-000000000000000000',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key-00000000000000000',
    GEMINI_API_KEY: 'gemini-key-123',
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  };

  it('uses polling without a public URL and webhooks on Railway', () => {
    expect(loadConfig({ ...base }).telegram.mode).toBe('polling');
    const railway = loadConfig({ ...base, RAILWAY_PUBLIC_DOMAIN: 'getcons.up.railway.app' });
    expect(railway.telegram.mode).toBe('webhook');
    expect(railway.publicUrl).toBe('https://getcons.up.railway.app');
  });

  it('accepts the new Supabase key names', () => {
    const cfg = loadConfig({
      ...base,
      SUPABASE_ANON_KEY: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_xxxxxxxxxxxxxxxx',
      SUPABASE_SECRET_KEY: 'sb_secret_xxxxxxxxxxxxxxxxxxxxx',
    });
    expect(cfg.supabase.anonKey).toBe('sb_publishable_xxxxxxxxxxxxxxxx');
    expect(cfg.gemini.model).toBe('gemini-3.1-flash-lite');
    expect(cfg.gemini.thinkingLevel).toBe('LOW');
  });

  it('reports every missing variable', () => {
    try {
      loadConfig({});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as Error).message;
      expect(msg).toContain('GEMINI_API_KEY');
      expect(msg).toContain('SUPABASE_URL');
    }
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY: 'short' })).toThrow(/ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...base, TELEGRAM_MODE: 'webhook' })).toThrow(/https PUBLIC_URL/);
  });
});

describe('chunking', () => {
  it('normalises text', () => {
    expect(normalizeText('﻿a\r\nb\u0000\n\n\n\nc  \n')).toBe('a\nb\n\nc');
  });

  it('keeps short documents in one chunk', () => {
    expect(chunkText('Hello world.\n\nSecond paragraph.')).toEqual(['Hello world.\n\nSecond paragraph.']);
    expect(chunkText('   ')).toEqual([]);
  });

  it('splits long documents under the size limit with overlap', () => {
    const paragraph = (i: number) => `Paragraph ${i}. ` + 'Roses are red and violets are blue. '.repeat(8);
    const text = Array.from({ length: 12 }, (_, i) => paragraph(i)).join('\n\n');
    const chunks = chunkText(text, { maxChars: 800, overlapChars: 100 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(800);
    // every paragraph start is somewhere in the chunks
    for (let i = 0; i < 12; i++) expect(chunks.some((c) => c.includes(`Paragraph ${i}.`))).toBe(true);
  });

  it('hard-splits a single huge paragraph', () => {
    const chunks = chunkText('word '.repeat(2000), { maxChars: 500, overlapChars: 50 });
    expect(chunks.length).toBeGreaterThan(10);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
  });
});

describe('telegram formatting', () => {
  it('escapes HTML and converts light markdown', () => {
    expect(escapeHtml('<b>&')).toBe('&lt;b&gt;&amp;');
    const html = markdownToTelegramHtml('**Price:** 5 < 6 & *fresh*\n- roses\n- tulips\n`code <x>`');
    expect(html).toContain('<b>Price:</b> 5 &lt; 6 &amp; <i>fresh</i>');
    expect(html).toContain('• roses\n• tulips');
    expect(html).toContain('<code>code &lt;x&gt;</code>');
  });

  it('keeps only http(s) links and never emits raw tags from input', () => {
    expect(markdownToTelegramHtml('[site](https://ex.com/a?b=1&c=2)')).toBe('<a href="https://ex.com/a?b=1&amp;c=2">site</a>');
    expect(markdownToTelegramHtml('[x](javascript:alert(1))')).not.toContain('<a');
    expect(markdownToTelegramHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(markdownToTelegramHtml('snake_case_name stays')).toBe('snake_case_name stays');
  });

  it('strips markdown for the plain-text fallback', () => {
    expect(stripMarkdown('**Bold** and [link](https://a.b)')).toBe('Bold and link (https://a.b)');
  });

  it('splits long messages without losing text', () => {
    const text = Array.from({ length: 50 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const parts = splitMessage(text, 200);
    expect(parts.every((p) => p.length <= 200)).toBe(true);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(text);
    expect(splitMessage('x'.repeat(450), 200).join('')).toBe('x'.repeat(450));
    expect(splitMessage('   ')).toEqual([]);
  });
});

describe('llm helpers', () => {
  it('parses JSON loosely', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseJsonLoose('Sure! {"a":3} hope it helps')).toEqual({ a: 3 });
    expect(parseJsonLoose('not json')).toBeNull();
  });

  it('uses thinking levels for Gemini 3+ and token budgets for Gemini 2.x', () => {
    expect(thinkingFor('gemini-3.5-flash-lite', 'LOW')).toEqual({ thinkingConfig: { thinkingLevel: 'LOW' } });
    expect(thinkingFor('gemini-2.5-flash', 'LOW')).toEqual({ thinkingConfig: { thinkingBudget: 512 } });
    expect(thinkingFor('gemini-2.5-pro', 'MINIMAL')).toEqual({ thinkingConfig: { thinkingBudget: 128 } });
    expect(thinkingFor('gemini-3.8-flash', null)).toEqual({});
  });

  it('normalises vectors', () => {
    const v = normalizeVector([3, 4]);
    expect(v[0]).toBeCloseTo(0.6);
    expect(v[1]).toBeCloseTo(0.8);
  });

  it('retries only retryable errors', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new LlmError('overloaded', 503, true);
        return 'ok';
      },
      { baseDelayMs: 1 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);

    calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new LlmError('bad request', 400, false);
        },
        { baseDelayMs: 1 },
      ),
    ).rejects.toThrow('bad request');
    expect(calls).toBe(1);
  });
});

describe('transcripts -> training examples', () => {
  it('parses plain-text transcripts, including timestamps and multi-line messages', () => {
    const turns = parsePlainTranscript(
      [
        '[12.03.2026, 10:01] Maria: Hi! Do you deliver on Sundays?',
        'Also to the suburbs?',
        '[12.03.2026, 10:02] Manager: Hello Maria! Yes, every day 9-21.',
        'Suburbs cost $5 extra.',
      ].join('\n'),
    );
    expect(turns).toEqual([
      { speaker: 'Maria', text: 'Hi! Do you deliver on Sundays?\nAlso to the suburbs?' },
      { speaker: 'Manager', text: 'Hello Maria! Yes, every day 9-21.\nSuburbs cost $5 extra.' },
    ]);
  });

  it('pairs consecutive customer messages with the business reply', () => {
    const pairs = buildPairs(
      [
        { speaker: 'Shop', text: 'Welcome!' }, // business first: skipped
        { speaker: 'Ann', text: 'Price of roses?' },
        { speaker: 'Ann', text: 'Red ones' },
        { speaker: 'Shop', text: '$5 each' },
        { speaker: 'Shop', text: 'We also have bouquets' },
        { speaker: 'Ann', text: 'Thanks' },
      ],
      'Shop',
    );
    expect(pairs).toEqual([{ customer_message: 'Price of roses?\nRed ones', ideal_reply: '$5 each\nWe also have bouquets' }]);
  });

  it('reads Telegram Desktop JSON exports and guesses the business side', () => {
    const exportJson = JSON.stringify({
      name: 'Maria',
      type: 'personal_chat',
      messages: [
        { id: 1, type: 'service', action: 'phone_call' },
        { id: 2, type: 'message', from: 'Maria', text: 'Do you have tulips?' },
        { id: 3, type: 'message', from: 'Bloom Store', text: ['Yes! ', { type: 'bold', text: '$3' }, ' each'] },
      ],
    });
    const parsed = parseTranscript(exportJson);
    expect(parsed.speakers).toEqual(expect.arrayContaining(['Maria', 'Bloom Store']));
    expect(parsed.businessSpeaker).toBe('Bloom Store');
    expect(parsed.pairs).toEqual([{ customer_message: 'Do you have tulips?', ideal_reply: 'Yes! $3 each' }]);

    const manual = parseTranscript(exportJson, { businessSpeaker: 'Maria' });
    expect(manual.businessSpeaker).toBe('Maria');
    expect(() => parseTranscript('{broken', { format: 'telegram_json' })).toThrow(/not valid JSON/);
  });

  it('sanitises search terms for PostgREST filters', () => {
    expect(sanitizeSearch('roses,(red)*%')).toBe('roses  red');
  });
});
