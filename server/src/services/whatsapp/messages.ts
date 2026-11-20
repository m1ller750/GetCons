import {
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isPnUser,
  jidDecode,
  normalizeMessageContent,
  type WAMessage,
} from 'baileys';
import type { MediaRef } from '../../db/types.js';

/** A customer message from WhatsApp, reduced to what the consultant runtime needs. */
export interface IncomingWhatsApp {
  /** chat to reply to */
  jid: string;
  messageId: string;
  /** the name the customer set in WhatsApp */
  pushName: string | null;
  /** "+79991234567" when WhatsApp shares the number (privacy-hidden "@lid" chats may not) */
  phone: string | null;
  text: string;
  media: MediaRef | null;
}

/** "79991234567@s.whatsapp.net" -> "+79991234567"; other JIDs -> null. */
export function phoneFromJid(jid: string | null | undefined): string | null {
  if (!jid || !isPnUser(jid)) return null;
  const user = jidDecode(jid)?.user;
  return user && /^\d{6,16}$/.test(user) ? `+${user}` : null;
}

/** Digits of a phone number typed in any format; null if it cannot be a full international number. */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/^\s*(\+|00)/, '').replace(/[\s()\-.]/g, '');
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

/**
 * Stable numeric key for a chat (conversations are unique per consultant, channel and
 * external_chat_id). Two 32-bit hashes combined into 52 bits: exact in a JS number and in bigint.
 */
export function whatsappChatKey(jid: string): number {
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let i = 0; i < jid.length; i++) {
    const c = jid.charCodeAt(i);
    fnv = Math.imul(fnv ^ c, 0x01000193) >>> 0;
    djb = (Math.imul(djb, 33) + c) >>> 0;
  }
  return fnv * 0x100000 + (djb & 0xfffff);
}

const isCustomerChat = (jid: string) =>
  !isJidGroup(jid) && !isJidBroadcast(jid) && !isJidNewsletter(jid) && jid !== 'status@broadcast';

const sizeOf = (value: number | { toNumber(): number } | null | undefined) =>
  value == null ? undefined : typeof value === 'number' ? value : value.toNumber();

const baseMime = (mime: string | null | undefined, fallback: string) => (mime ?? fallback).split(';')[0]!.trim() || fallback;

/** Parses a Baileys message; null for anything a consultant should not answer. */
export function parseIncoming(msg: WAMessage): IncomingWhatsApp | null {
  const key = msg.key;
  const jid = key?.remoteJid;
  if (!jid || !key.id || key.fromMe || !isCustomerChat(jid)) return null;
  const content = normalizeMessageContent(msg.message);
  const type = getContentType(content);
  if (!content || !type) return null;

  const base = {
    jid,
    messageId: key.id,
    pushName: msg.pushName?.trim() || null,
    phone: phoneFromJid(jid) ?? phoneFromJid(key.remoteJidAlt),
  };
  const id = key.id;

  switch (type) {
    case 'conversation':
      return { ...base, text: content.conversation ?? '', media: null };
    case 'extendedTextMessage':
      return { ...base, text: content.extendedTextMessage?.text ?? '', media: null };
    case 'imageMessage': {
      const m = content.imageMessage!;
      return {
        ...base,
        text: m.caption ?? '',
        media: { kind: 'photo', file_id: id, mime_type: baseMime(m.mimetype, 'image/jpeg'), file_size: sizeOf(m.fileLength) },
      };
    }
    case 'audioMessage': {
      const m = content.audioMessage!;
      return {
        ...base,
        text: '',
        media: {
          kind: m.ptt ? 'voice' : 'audio',
          file_id: id,
          mime_type: baseMime(m.mimetype, 'audio/ogg'),
          file_size: sizeOf(m.fileLength),
          duration: m.seconds ?? undefined,
        },
      };
    }
    case 'documentMessage': {
      const m = content.documentMessage!;
      const mime = baseMime(m.mimetype, 'application/octet-stream');
      if (mime.startsWith('image/') || mime === 'application/pdf') {
        return { ...base, text: m.caption ?? '', media: { kind: 'document', file_id: id, mime_type: mime, file_size: sizeOf(m.fileLength) } };
      }
      return { ...base, text: `[file "${m.fileName ?? 'document'}" - not supported, ask for text]`, media: null };
    }
    case 'videoMessage':
      return { ...base, text: '[video - not supported, ask the customer to describe it in text]', media: null };
    case 'stickerMessage':
      return { ...base, text: '[sticker]', media: null };
    case 'locationMessage': {
      const m = content.locationMessage!;
      return { ...base, text: `[location: ${m.degreesLatitude}, ${m.degreesLongitude}]`, media: null };
    }
    case 'contactMessage':
      return { ...base, text: `[shared contact: ${content.contactMessage?.displayName ?? 'contact'}]`, media: null };
    case 'buttonsResponseMessage':
      return { ...base, text: content.buttonsResponseMessage?.selectedDisplayText ?? '', media: null };
    case 'listResponseMessage':
      return { ...base, text: content.listResponseMessage?.title ?? '', media: null };
    case 'templateButtonReplyMessage':
      return { ...base, text: content.templateButtonReplyMessage?.selectedDisplayText ?? '', media: null };
    case 'protocolMessage':
    case 'reactionMessage':
    case 'senderKeyDistributionMessage':
    case 'pollUpdateMessage':
    case 'keepInChatMessage':
    case 'pinInChatMessage':
    case 'editedMessage':
      return null; // service messages, edits and reactions: nothing to answer
    default:
      return { ...base, text: '[unsupported message]', media: null };
  }
}
