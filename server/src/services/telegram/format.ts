/** Telegram allows 4096 characters per message; leave headroom for HTML tags. */
export const TELEGRAM_CHUNK = 3800;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

/**
 * Converts the light Markdown Gemini produces into Telegram's HTML subset
 * (b, i, s, code, pre, a). Everything else is escaped, so the output is always safe.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const placeholders: string[] = [];
  const keep = (html: string) => {
    placeholders.push(html);
    return `\u0000${placeholders.length - 1}\u0000`;
  };

  let text = markdown.replace(/\r\n?/g, '\n');

  // Fenced code first, then inline code: their content must not be formatted.
  text = text.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_, code: string) => keep(`<pre>${escapeHtml(code.trimEnd())}</pre>`));
  text = text.replace(/`([^`\n]+)`/g, (_, code: string) => keep(`<code>${escapeHtml(code)}</code>`));
  // Links (http/https only).
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) =>
    keep(`<a href="${escapeAttr(url)}">${escapeHtml(label)}</a>`),
  );

  text = escapeHtml(text);

  // Headings -> bold lines; bullets -> "•".
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  text = text.replace(/^(\s*)[-*+]\s+/gm, '$1• ');
  // Bold, italic, strikethrough.
  text = text.replace(/\*\*([^*\n][^*]*?)\*\*/g, '<b>$1</b>');
  text = text.replace(/__([^_\n][^_]*?)__/g, '<b>$1</b>');
  text = text.replace(/(^|[^\w*])\*([^*\n]+?)\*(?!\w)/g, '$1<i>$2</i>');
  text = text.replace(/(^|[^\w_])_([^_\n]+?)_(?!\w)/g, '$1<i>$2</i>');
  text = text.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');

  // eslint-disable-next-line no-control-regex
  return text.replace(/\u0000(\d+)\u0000/g, (_, i: string) => placeholders[Number(i)] ?? '');
}

/** Removes Markdown markers for the plain-text fallback. */
export function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1');
}

/** Splits long text on paragraph, line, sentence or word boundaries. */
export function splitMessage(text: string, max = TELEGRAM_CHUNK): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed ? [trimmed] : [];
  const parts: string[] = [];
  let rest = trimmed;
  const minCut = max * 0.4;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    // `end` is where the current part stops (exclusive).
    let end = window.lastIndexOf('\n\n');
    if (end < minCut) end = window.lastIndexOf('\n');
    if (end < minCut) {
      const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
      end = sentence >= minCut ? sentence + 1 : -1;
    }
    if (end < minCut) end = window.lastIndexOf(' ');
    if (end < minCut) end = max;
    parts.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}
