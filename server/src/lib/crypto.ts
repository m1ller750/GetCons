import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Accepts a 32-byte key encoded as base64 (44 chars) or hex (64 chars). */
export function parseEncryptionKey(raw: string): Buffer {
  const value = raw.trim();
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, 'hex');
  } else {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 32) key = decoded;
  }
  if (!key || key.length !== 32) {
    throw new Error('must be exactly 32 bytes, base64- or hex-encoded (generate with: openssl rand -base64 32)');
  }
  return key;
}

/** AES-256-GCM. Output: "v1:" + base64(iv | authTag | ciphertext). */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`;
}

export function decryptSecret(payload: string, key: Buffer): string {
  const [version, body] = payload.split(':', 2);
  if (version !== VERSION || !body) throw new Error('Unsupported secret format');
  const raw = Buffer.from(body, 'base64');
  if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error('Corrupted secret');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/** Human-friendly one-time code, e.g. "GC-7K3QXM". No ambiguous characters. */
export function randomCode(length = 6, prefix = 'GC-'): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i]! % alphabet.length];
  return prefix + out;
}

/** Constant-time comparison that doesn't leak length differences through early exit. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Shows only the bot id part of a token: "123456:•••••". */
export function maskBotToken(token: string): string {
  const [id] = token.split(':');
  return `${id ?? '?'}:${'•'.repeat(8)}`;
}
