export function relativeTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return '—';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 45) return rtf.format(0, 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 7 * 86_400) return rtf.format(Math.round(diff / 86_400), 'day');
  return new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: abs > 300 * 86_400 ? 'numeric' : undefined });
}

export function timeOfDay(iso: string, locale: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

export function dateLabel(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
}

export function shortDay(day: string, locale: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

export function fileSize(bytes: number | null | undefined): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function number(n: number | null | undefined, locale: string): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString(locale);
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** "+79165550101" -> "+7 916 555-01-01" (Russia/Kazakhstan); other numbers in groups of three. */
export function phone(value: string | null | undefined): string {
  const digits = (value ?? '').replace(/\D/g, '');
  if (!digits) return value ?? '';
  if (digits.length === 11 && digits.startsWith('7')) {
    return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`;
  }
  return `+${digits.replace(/(\d{3})(?=\d{4,})/g, '$1 ')}`;
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? '?').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** Very small markdown renderer for chat bubbles: **bold**, *italic*, bullet lines. Returns safe segments. */
export function renderLight(input: string): { type: 'text' | 'bold' | 'italic'; value: string }[] {
  // Bullets first, on whole lines, so "- **Name** - $5" keeps its inner dash.
  const text = input.replace(/^(\s*)[-*]\s+/gm, '$1• ');
  const out: { type: 'text' | 'bold' | 'italic'; value: string }[] = [];
  const re = /\*\*([^*]+)\*\*|(?<![\w*])\*([^*\n]+)\*(?!\w)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ type: 'text', value: text.slice(last, m.index) });
    if (m[1]) out.push({ type: 'bold', value: m[1] });
    else if (m[2]) out.push({ type: 'italic', value: m[2] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

/** Minimal CSV parser (quotes, escaped quotes, commas/semicolons, newlines in quotes). */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const firstLine = text.split('\n')[0] ?? '';
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}
