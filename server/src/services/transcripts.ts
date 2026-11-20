/**
 * Turns real customer-service conversations into training examples
 * (customer message -> ideal reply pairs) for dynamic few-shot prompting.
 *
 * Supported inputs:
 *  - Telegram Desktop JSON export (single chat `result.json`, or a full export with chats.list)
 *  - Plain-text transcripts: "Name: message" lines (optionally prefixed with a timestamp,
 *    as in WhatsApp exports). Lines without a speaker continue the previous message.
 */

export interface TranscriptTurn {
  speaker: string;
  text: string;
}

export interface TrainingPair {
  customer_message: string;
  ideal_reply: string;
}

export interface ParsedTranscript {
  speakers: string[];
  businessSpeaker: string | null;
  turns: number;
  pairs: TrainingPair[];
}

const MAX_FIELD = 4000;
const BUSINESS_HINTS =
  /^(manager|operator|support|agent|admin|consultant|business|shop|store|sales|we|staff|assistant|менеджер|оператор|поддержка|консультант|администратор|магазин|продавец)\b/i;

const TIMESTAMP_PREFIX =
  /^\s*(?:\[[^\]]{4,30}\]|\d{1,4}[./-]\d{1,2}[./-]\d{1,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\s*[-–]?)\s*/i;
const SPEAKER_LINE = /^([^:\n]{1,40}):\s+(.*)$/;

type TgText = string | Array<string | { type?: string; text?: string }>;

interface TgMessage {
  type?: string;
  from?: string;
  text?: TgText;
  sticker_emoji?: string;
}

function tgText(text: TgText | undefined): string {
  if (!text) return '';
  if (typeof text === 'string') return text;
  return text.map((t) => (typeof t === 'string' ? t : (t.text ?? ''))).join('');
}

function parseTelegramExport(json: unknown): TranscriptTurn[][] {
  const root = json as { messages?: TgMessage[]; chats?: { list?: { messages?: TgMessage[] }[] } };
  const chats: TgMessage[][] = [];
  if (Array.isArray(root?.messages)) chats.push(root.messages);
  if (Array.isArray(root?.chats?.list)) {
    for (const chat of root.chats.list) if (Array.isArray(chat.messages)) chats.push(chat.messages);
  }
  return chats.map((messages) =>
    messages
      .filter((m) => m.type === 'message' && m.from)
      .map((m) => ({ speaker: String(m.from).trim(), text: tgText(m.text).trim() }))
      .filter((t) => t.text.length > 0),
  );
}

export function parsePlainTranscript(content: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const rawLine of content.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(TIMESTAMP_PREFIX, '');
    if (!line.trim()) continue;
    const match = line.match(SPEAKER_LINE);
    if (match && !/^https?$/i.test(match[1]!.trim())) {
      turns.push({ speaker: match[1]!.trim(), text: match[2]!.trim() });
    } else if (turns.length) {
      turns[turns.length - 1]!.text += `\n${line.trim()}`;
    }
  }
  return turns.filter((t) => t.text.trim());
}

function uniqueSpeakers(chats: TranscriptTurn[][]): string[] {
  const counts = new Map<string, number>();
  for (const turns of chats) for (const t of turns) counts.set(t.speaker, (counts.get(t.speaker) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
}

/** Guess which participant is the business: a name hint, else whoever talks in the most chats. */
export function guessBusinessSpeaker(chats: TranscriptTurn[][]): string | null {
  const speakers = uniqueSpeakers(chats);
  const hinted = speakers.find((s) => BUSINESS_HINTS.test(s));
  if (hinted) return hinted;
  if (chats.length > 1) {
    const presence = new Map<string, number>();
    for (const turns of chats) for (const s of new Set(turns.map((t) => t.speaker))) presence.set(s, (presence.get(s) ?? 0) + 1);
    const top = [...presence.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] > 1) return top[0];
  }
  // In a single chat the first speaker is usually the customer who reached out.
  const first = chats[0]?.[0]?.speaker;
  return speakers.find((s) => s !== first) ?? null;
}

export function buildPairs(turns: TranscriptTurn[], businessSpeaker: string): TrainingPair[] {
  const pairs: TrainingPair[] = [];
  let customer: string[] = [];
  let business: string[] = [];
  const flush = () => {
    if (customer.length && business.length) {
      pairs.push({
        customer_message: customer.join('\n').slice(0, MAX_FIELD),
        ideal_reply: business.join('\n').slice(0, MAX_FIELD),
      });
    }
    customer = [];
    business = [];
  };
  for (const turn of turns) {
    if (turn.speaker === businessSpeaker) {
      if (customer.length) business.push(turn.text);
    } else {
      if (business.length) flush();
      customer.push(turn.text);
    }
  }
  flush();
  return pairs;
}

export function parseTranscript(
  content: string,
  options: { format?: 'auto' | 'telegram_json' | 'text'; businessSpeaker?: string | null } = {},
): ParsedTranscript {
  const format = options.format ?? 'auto';
  let chats: TranscriptTurn[][] = [];

  if (format === 'telegram_json' || (format === 'auto' && content.trimStart().startsWith('{'))) {
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      throw new Error('The file is not valid JSON. Export the chat from Telegram Desktop as "Machine-readable JSON".');
    }
    chats = parseTelegramExport(json);
    if (!chats.length) throw new Error('No messages found in the Telegram export');
  } else {
    chats = [parsePlainTranscript(content)];
  }

  const speakers = uniqueSpeakers(chats);
  const businessSpeaker =
    options.businessSpeaker && speakers.includes(options.businessSpeaker)
      ? options.businessSpeaker
      : guessBusinessSpeaker(chats);

  const pairs = businessSpeaker ? chats.flatMap((turns) => buildPairs(turns, businessSpeaker)) : [];
  return { speakers, businessSpeaker, turns: chats.reduce((n, t) => n + t.length, 0), pairs };
}
