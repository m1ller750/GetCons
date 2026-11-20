/** WhatsApp shows long messages fine, but very long ones are easier to read in parts. */
export const WHATSAPP_CHUNK = 3500;

/**
 * Converts the light Markdown Gemini produces into WhatsApp formatting:
 * *bold*, _italic_, ~strikethrough~, ```monospace```. Links become "label (url)".
 */
export function markdownToWhatsApp(markdown: string): string {
  const placeholders: string[] = [];
  const keep = (text: string) => {
    placeholders.push(text);
    return `\u0000${placeholders.length - 1}\u0000`;
  };

  let text = markdown.replace(/\r\n?/g, '\n');
  // Code keeps its content untouched.
  text = text.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_, code: string) => keep('```' + code.trimEnd() + '```'));
  text = text.replace(/`([^`\n]+)`/g, (_, code: string) => keep('```' + code + '```'));
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) =>
    keep(label === url ? url : `${label} (${url})`),
  );

  // Italic first (single markers), so the bold conversion below is not re-read as italic.
  text = text.replace(/(^|[^\w*])\*([^*\n]+?)\*(?!\w)/g, (_, pre: string, body: string) => `${pre}${keep(`_${body}_`)}`);
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_, title: string) => keep(`*${title.replace(/\*\*/g, '')}*`));
  text = text.replace(/^(\s*)[-*+]\s+/gm, '$1• ');
  text = text.replace(/\*\*([^*\n][^*]*?)\*\*/g, '*$1*');
  text = text.replace(/__([^_\n][^_]*?)__/g, '*$1*');
  text = text.replace(/~~([^~\n]+?)~~/g, '~$1~');

  // eslint-disable-next-line no-control-regex
  return text.replace(/\u0000(\d+)\u0000/g, (_, i: string) => placeholders[Number(i)] ?? '');
}
