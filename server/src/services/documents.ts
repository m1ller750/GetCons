import path from 'node:path';
import mammoth from 'mammoth';
import { extractText as extractPdfText } from 'unpdf';
import { badRequest, unprocessable } from '../lib/errors.js';
import type { Llm } from './llm.js';
import { normalizeText } from './chunking.js';

export const MAX_DOCUMENT_CHARS = 400_000;

type Kind = 'pdf' | 'docx' | 'text' | 'csv' | 'json' | 'html' | 'image';

const EXTENSIONS: Record<string, Kind> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.txt': 'text',
  '.md': 'text',
  '.markdown': 'text',
  '.csv': 'csv',
  '.tsv': 'csv',
  '.json': 'json',
  '.html': 'html',
  '.htm': 'html',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
};

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export const SUPPORTED_UPLOAD_EXTENSIONS = Object.keys(EXTENSIONS);

export interface ExtractedDocument {
  text: string;
  method: 'native' | 'gemini-ocr';
  mimeType: string;
  pages?: number;
}

function detectKind(fileName: string): { kind: Kind; ext: string } {
  const ext = path.extname(fileName).toLowerCase();
  const kind = EXTENSIONS[ext];
  if (!kind) {
    throw badRequest(`Unsupported file type "${ext || fileName}". Supported: ${SUPPORTED_UPLOAD_EXTENSIONS.join(', ')}`);
  }
  return { kind, ext };
}

function decodeUtf8(buffer: Buffer): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ');
}

/**
 * Extracts plain text from an uploaded file. Native parsers first; scanned PDFs and
 * images fall back to Gemini's multimodal transcription.
 */
/** What a .docx may unpack to: real documents are a few MB; zip bombs are gigabytes. */
export const MAX_UNZIPPED_BYTES = 60 * 1024 * 1024;

/**
 * Reads the zip central directory (no decompression) and rejects archives whose files would
 * unpack to more than `limit` bytes, or that hide sizes behind Zip64.
 */
export function assertSafeZip(buf: Buffer, limit = MAX_UNZIPPED_BYTES): void {
  const bad = () => badRequest('This .docx file is damaged or too large when unpacked');
  // End of central directory: signature 0x06054b50, within the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad();
  const entries = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || offset === 0xffffffff || entries > 5000) throw bad();
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) throw bad();
    const size = buf.readUInt32LE(offset + 24);
    if (size === 0xffffffff) throw bad();
    total += size;
    if (total > limit) throw bad();
    offset += 46 + buf.readUInt16LE(offset + 28) + buf.readUInt16LE(offset + 30) + buf.readUInt16LE(offset + 32);
  }
}

export async function extractDocument(
  file: { buffer: Buffer; originalName: string },
  llm: Pick<Llm, 'extractDocumentText'>,
): Promise<ExtractedDocument> {
  const { kind, ext } = detectKind(file.originalName);
  const buf = file.buffer;
  if (!buf.length) throw badRequest('The file is empty');

  let result: ExtractedDocument;
  switch (kind) {
    case 'pdf': {
      if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw badRequest('This file is not a valid PDF');
      let text = '';
      let pages = 0;
      try {
        const out = await extractPdfText(new Uint8Array(buf), { mergePages: true });
        text = out.text;
        pages = out.totalPages;
      } catch {
        text = '';
      }
      // Very little text per page usually means a scanned PDF: ask Gemini to read it.
      if (normalizeText(text).length < Math.max(80, pages * 40)) {
        const ocr = await llm.extractDocumentText(buf, 'application/pdf');
        result = { text: ocr, method: 'gemini-ocr', mimeType: 'application/pdf', pages };
      } else {
        result = { text, method: 'native', mimeType: 'application/pdf', pages };
      }
      break;
    }
    case 'docx': {
      if (buf.subarray(0, 2).toString('latin1') !== 'PK') throw badRequest('This file is not a valid .docx document');
      assertSafeZip(buf);
      const out = await mammoth.extractRawText({ buffer: buf });
      result = {
        text: out.value,
        method: 'native',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      };
      break;
    }
    case 'text':
      result = { text: decodeUtf8(buf), method: 'native', mimeType: 'text/plain' };
      break;
    case 'csv':
      result = { text: decodeUtf8(buf), method: 'native', mimeType: 'text/csv' };
      break;
    case 'json': {
      const raw = decodeUtf8(buf);
      let text = raw;
      try {
        text = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        throw badRequest('The JSON file could not be parsed');
      }
      result = { text, method: 'native', mimeType: 'application/json' };
      break;
    }
    case 'html':
      result = { text: htmlToText(decodeUtf8(buf)), method: 'native', mimeType: 'text/html' };
      break;
    case 'image': {
      const mime = IMAGE_MIME[ext]!;
      const ocr = await llm.extractDocumentText(buf, mime);
      result = { text: ocr, method: 'gemini-ocr', mimeType: mime };
      break;
    }
  }

  const text = normalizeText(result.text);
  if (!text) throw unprocessable('No readable text was found in this file');
  if (text.length > MAX_DOCUMENT_CHARS) {
    throw unprocessable(
      `The document is too long (${text.length.toLocaleString('en')} characters). Split it into files under ${MAX_DOCUMENT_CHARS.toLocaleString('en')} characters.`,
    );
  }
  return { ...result, text };
}
