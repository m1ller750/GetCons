import { describe, expect, it } from 'vitest';
import { assertSafeZip, extractDocument, htmlToText } from '../src/services/documents.js';

/** A zip with only a central directory (enough for the size check): each entry claims `size` bytes unpacked. */
function zipClaiming(sizes: number[]): Buffer {
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  const entries = sizes.map((size, i) => {
    const name = Buffer.from(`word/part${i}.xml`);
    const e = Buffer.alloc(46);
    e.writeUInt32LE(0x02014b50, 0);
    e.writeUInt32LE(size, 24);
    e.writeUInt16LE(name.length, 28);
    return Buffer.concat([e, name]);
  });
  const cd = Buffer.concat(entries);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(sizes.length, 8);
  eocd.writeUInt16LE(sizes.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, cd, eocd]);
}
import { AppError } from '../src/lib/errors.js';

/** Builds a tiny but valid one-page PDF with the given text lines (Helvetica). */
function makePdf(lines: string[]): Buffer {
  const stream = lines.length
    ? `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => `${i ? '0 -18 Td ' : ''}(${l.replace(/[()\\]/g, '\\$&')}) Tj`).join(' ')} ET`
    : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const ocr = {
  calls: 0,
  async extractDocumentText() {
    this.calls++;
    return 'Scanned menu: soup $4';
  },
};

describe('document extraction', () => {
  it('extracts text from a PDF natively', async () => {
    const pdf = makePdf([
      'Price list: red roses cost 5 dollars each, white tulips 3 dollars.',
      'Delivery is free for orders over 50 dollars in the city center.',
    ]);
    const out = await extractDocument({ buffer: pdf, originalName: 'prices.pdf' }, ocr);
    expect(out.method).toBe('native');
    expect(out.text).toContain('red roses cost 5 dollars');
    expect(out.text).toContain('Delivery is free');
  });

  it('falls back to Gemini OCR for scanned PDFs and images', async () => {
    const before = ocr.calls;
    const scanned = await extractDocument({ buffer: makePdf([]), originalName: 'scan.pdf' }, ocr);
    expect(scanned).toMatchObject({ method: 'gemini-ocr', text: 'Scanned menu: soup $4' });
    const image = await extractDocument({ buffer: Buffer.from([0x89, 0x50]), originalName: 'menu.JPG' }, ocr);
    expect(image.mimeType).toBe('image/jpeg');
    expect(ocr.calls).toBe(before + 2);
  });

  it('handles text, CSV, JSON and HTML', async () => {
    const txt = await extractDocument({ buffer: Buffer.from('﻿Hello\r\nworld'), originalName: 'a.md' }, ocr);
    expect(txt.text).toBe('Hello\nworld');
    const json = await extractDocument({ buffer: Buffer.from('{"a":1}'), originalName: 'faq.json' }, ocr);
    expect(json.text).toBe('{\n  "a": 1\n}');
    expect(htmlToText('<p>Hi&nbsp;<b>there</b></p><script>x()</script><ul><li>One</li></ul>')).toContain('Hi there');
  });

  it('rejects unsupported, empty and disguised files', async () => {
    await expect(extractDocument({ buffer: Buffer.from('x'), originalName: 'virus.exe' }, ocr)).rejects.toThrow(/Unsupported/);
    await expect(extractDocument({ buffer: Buffer.alloc(0), originalName: 'a.txt' }, ocr)).rejects.toThrow(/empty/);
    await expect(extractDocument({ buffer: Buffer.from('hello'), originalName: 'a.pdf' }, ocr)).rejects.toThrow(/valid PDF/);
    await expect(extractDocument({ buffer: Buffer.from('hello'), originalName: 'a.docx' }, ocr)).rejects.toThrow(/valid .docx/);
    await expect(extractDocument({ buffer: Buffer.from('{bad'), originalName: 'a.json' }, ocr)).rejects.toBeInstanceOf(AppError);
  });

  it('refuses .docx zip bombs before unpacking them', async () => {
    expect(() => assertSafeZip(zipClaiming([20_000, 3_000]))).not.toThrow();
    expect(() => assertSafeZip(zipClaiming([40 * 1024 * 1024, 40 * 1024 * 1024]))).toThrow(/too large when unpacked/);
    expect(() => assertSafeZip(zipClaiming([0xffffffff]))).toThrow(/too large when unpacked/); // Zip64 hides the size
    await expect(extractDocument({ buffer: zipClaiming([4 * 1024 * 1024 * 1024 - 2]), originalName: 'bomb.docx' }, ocr)).rejects.toThrow(
      /too large when unpacked/,
    );
  });
});
