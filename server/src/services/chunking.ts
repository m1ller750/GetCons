/** Normalises extracted text before chunking/storing. */
export function normalizeText(input: string): string {
  return input
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    // drop control chars except tab/newline (PDF extraction artefacts, NULs break Postgres)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
}

function splitLong(text: string, maxChars: number): string[] {
  // Prefer sentence boundaries, then whitespace, then a hard cut.
  const sentences = text.split(/(?<=[.!?…。])\s+/u);
  const out: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current) {
        out.push(current);
        current = '';
      }
      let rest = sentence;
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf(' ', maxChars);
        if (cut < maxChars * 0.5) cut = maxChars;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      current = rest;
      continue;
    }
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > maxChars) {
      out.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out.filter(Boolean);
}

function overlapTail(text: string, overlapChars: number): string {
  if (overlapChars <= 0 || text.length <= overlapChars) return '';
  const tail = text.slice(-overlapChars);
  const space = tail.indexOf(' ');
  return (space > 0 && space < tail.length - 1 ? tail.slice(space + 1) : tail).trim();
}

/**
 * Paragraph-aware chunker. Chunks stay under `maxChars` (≈ 300 tokens by default, well
 * inside gemini-embedding-001's 2,048-token input) and carry a small overlap so facts
 * spanning a boundary are still retrievable.
 */
export function chunkText(input: string, options: ChunkOptions = {}): string[] {
  const maxChars = options.maxChars ?? 1200;
  const overlapChars = Math.min(options.overlapChars ?? 150, Math.floor(maxChars / 3));
  const text = normalizeText(input);
  if (!text) return [];

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => (p.length > maxChars ? splitLong(p, maxChars - overlapChars) : [p]));

  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    const tail = overlapTail(current, overlapChars);
    current = tail && tail.length + paragraph.length + 2 <= maxChars ? `${tail}\n\n${paragraph}` : paragraph;
  }
  if (current) chunks.push(current);
  return chunks;
}
