import type { WAMessage } from 'baileys';
import { describe, expect, it } from 'vitest';
import { ConsultantRuntime, type WhatsAppGateway } from '../src/core/runtime.js';
import { WhatsAppManager, type WaSocket } from '../src/core/whatsapp.js';
import type { MediaRef } from '../src/db/types.js';
import { silentLogger } from '../src/lib/logger.js';
import { useDbAuthState, type DbAuthState } from '../src/services/whatsapp/authState.js';
import { markdownToWhatsApp } from '../src/services/whatsapp/format.js';
import {
  normalizePhone,
  parseIncoming,
  phoneFromJid,
  whatsappChatKey,
  type IncomingWhatsApp,
} from '../src/services/whatsapp/messages.js';
import { FakeLlm, FakeStore, FakeTelegram, makeConsultant, testConfig } from './helpers/fakes.js';

const CUSTOMER = '79991234567@s.whatsapp.net';
const flush = () => new Promise((r) => setTimeout(r, 10));
const wa = (message: Record<string, unknown>, key: Record<string, unknown> = {}, pushName = 'Maria') =>
  ({ key: { remoteJid: CUSTOMER, id: 'MSG1', fromMe: false, ...key }, pushName, message }) as unknown as WAMessage;

describe('WhatsApp message parsing and formatting', () => {
  it('reads text, captions, voice notes and documents from customer chats', () => {
    expect(parseIncoming(wa({ conversation: 'Hi there' }))).toEqual({
      jid: CUSTOMER,
      messageId: 'MSG1',
      pushName: 'Maria',
      phone: '+79991234567',
      text: 'Hi there',
      media: null,
    });
    expect(parseIncoming(wa({ extendedTextMessage: { text: 'Do you deliver?' } }))?.text).toBe('Do you deliver?');
    expect(parseIncoming(wa({ imageMessage: { caption: 'These?', mimetype: 'image/jpeg', fileLength: 2048 } }))).toMatchObject({
      text: 'These?',
      media: { kind: 'photo', file_id: 'MSG1', mime_type: 'image/jpeg', file_size: 2048 },
    });
    expect(parseIncoming(wa({ audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus', seconds: 7 } }))?.media).toEqual({
      kind: 'voice',
      file_id: 'MSG1',
      mime_type: 'audio/ogg',
      file_size: undefined,
      duration: 7,
    });
    expect(parseIncoming(wa({ documentMessage: { mimetype: 'application/zip', fileName: 'a.zip' } }))?.text).toMatch(/not supported/);
  });

  it('ignores our own messages, groups, statuses, reactions and service messages', () => {
    expect(parseIncoming(wa({ conversation: 'mine' }, { fromMe: true }))).toBeNull();
    expect(parseIncoming(wa({ conversation: 'group' }, { remoteJid: '120363000000000000@g.us' }))).toBeNull();
    expect(parseIncoming(wa({ conversation: 'story' }, { remoteJid: 'status@broadcast' }))).toBeNull();
    expect(parseIncoming(wa({ reactionMessage: { text: '👍' } }))).toBeNull();
    expect(parseIncoming(wa({ protocolMessage: { type: 0 } }))).toBeNull();
  });

  it('finds the phone number of privacy-hidden (@lid) chats when WhatsApp shares it', () => {
    const msg = parseIncoming(wa({ conversation: 'hi' }, { remoteJid: '123456789012345@lid', remoteJidAlt: CUSTOMER }));
    expect(msg).toMatchObject({ jid: '123456789012345@lid', phone: '+79991234567' });
    expect(phoneFromJid('123456789012345@lid')).toBeNull();
  });

  it('normalises phone numbers and derives a stable numeric chat key', () => {
    expect(normalizePhone('+7 (999) 123-45-67')).toBe('79991234567');
    expect(normalizePhone('00 44 20 7946 0958')).toBe('442079460958');
    expect(normalizePhone('12345')).toBeNull();
    const key = whatsappChatKey(CUSTOMER);
    expect(key).toBe(whatsappChatKey(CUSTOMER));
    expect(key).not.toBe(whatsappChatKey('79991234568@s.whatsapp.net'));
    expect(Number.isSafeInteger(key) && key > 0).toBe(true);
  });

  it('converts Gemini Markdown into WhatsApp formatting', () => {
    expect(markdownToWhatsApp('**Roses** are *fresh*, ~~cheap~~ ok')).toBe('*Roses* are _fresh_, ~cheap~ ok');
    expect(markdownToWhatsApp('## Prices\n- roses $5\n- tulips $3')).toBe('*Prices*\n• roses $5\n• tulips $3');
    expect(markdownToWhatsApp('[Order](https://shop.example/o) and `code`')).toBe('Order (https://shop.example/o) and ```code```');
  });
});

describe('WhatsApp session storage', () => {
  it('keeps the linked-device session encrypted in the database and restores it', async () => {
    const store = new FakeStore();
    const key = testConfig().encryptionKey;
    const first = await useDbAuthState(store, 'c1', key);
    first.state.creds.registered = true;
    await first.saveCreds();
    await first.state.keys.set({ 'pre-key': { '1': { public: Buffer.from('pub'), private: Buffer.from('priv') } }, session: { a: Buffer.from('s') } });
    await first.state.keys.set({ session: { a: null } });

    const stored = store.whatsappAuth.get('c1')!;
    expect([...stored.keys()].sort()).toEqual(['creds', 'pre-key:1']);
    for (const value of stored.values()) expect(value).toMatch(/^v1:/); // AES-GCM, no plaintext keys
    expect([...stored.values()].join()).not.toContain('priv');

    const again = await useDbAuthState(store, 'c1', key);
    expect(again.state.creds.registered).toBe(true);
    expect(again.state.creds.registrationId).toBe(first.state.creds.registrationId);
    const keys = await again.state.keys.get('pre-key', ['1', '2']);
    expect(Buffer.from(keys['1']!.private).toString()).toBe('priv');
    expect(keys['2']).toBeUndefined();
    expect(await again.state.keys.get('session', ['a'])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Linking a work number (fake Baileys socket)
// ---------------------------------------------------------------------------

class FakeSocket {
  private handlers = new Map<string, ((arg: never) => void)[]>();
  ev = {
    on: (event: string, cb: (arg: never) => void) => {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
    },
  };
  user: { id: string; name?: string } | undefined;
  sent: { jid: string; text: string }[] = [];
  presence: string[] = [];
  read: unknown[] = [];
  pairingPhone: string | null = null;
  loggedOut = false;
  ended = false;

  constructor(readonly auth: DbAuthState['state']) {}

  emit(event: string, arg: unknown) {
    for (const cb of this.handlers.get(event) ?? []) cb(arg as never);
  }
  async requestPairingCode(phone: string) {
    this.pairingPhone = phone;
    return 'ABCD1234';
  }
  async sendMessage(jid: string, content: { text: string }) {
    this.sent.push({ jid, text: content.text });
    return { key: { id: `OUT${this.sent.length}` } };
  }
  async sendPresenceUpdate(type: string) {
    this.presence.push(type);
  }
  async readMessages(keys: unknown[]) {
    this.read.push(...keys);
  }
  async logout() {
    this.loggedOut = true;
  }
  end() {
    this.ended = true;
  }
}

function managerSetup() {
  const config = testConfig();
  const store = new FakeStore();
  const consultant = store.addConsultant(makeConsultant({ status: 'draft', telegram_bot_id: null }), null, config.encryptionKey);
  const sockets: FakeSocket[] = [];
  const incoming: IncomingWhatsApp[] = [];
  const manager = new WhatsAppManager({
    config,
    store,
    logger: silentLogger(),
    createSocket: async (auth) => {
      const sock = new FakeSocket(auth);
      sockets.push(sock);
      // WhatsApp offers a QR code to devices that are not linked yet.
      if (!auth.creds.registered) setTimeout(() => sock.emit('connection.update', { qr: `qr-${sockets.length}` }), 0);
      return sock as unknown as WaSocket;
    },
    download: async () => Buffer.from('image-bytes'),
  });
  manager.onMessage(async (_id, msg) => {
    incoming.push(msg);
  });
  const close = (sock: FakeSocket, statusCode: number) =>
    sock.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode } } } });
  return { config, store, consultant, sockets, incoming, manager, close, row: () => store.consultants.get(consultant.id)! };
}

describe('WhatsApp linking (linked device)', () => {
  it('links with a QR code: pairing, restart after the scan, then connected', async () => {
    const t = managerSetup();
    const view = await t.manager.connect(t.consultant, { method: 'qr' });
    expect(view).toMatchObject({ status: 'pairing', method: 'qr', qr: 'qr-1', pairingCode: null });
    expect(t.row().whatsapp_status).toBe('pairing');

    // The phone scanned the code: credentials are saved, WhatsApp asks for a restart.
    t.sockets[0]!.auth.creds.registered = true;
    t.sockets[0]!.emit('creds.update', {});
    t.close(t.sockets[0]!, 515);
    await flush();
    expect(t.sockets).toHaveLength(2);
    expect(t.store.whatsappAuth.get(t.consultant.id)?.has('creds')).toBe(true);

    t.sockets[1]!.user = { id: '79991234567:4@s.whatsapp.net', name: 'Bloom Flowers' };
    t.sockets[1]!.emit('connection.update', { connection: 'open' });
    await flush();
    expect(t.manager.isConnected(t.consultant.id)).toBe(true);
    expect(t.row()).toMatchObject({
      whatsapp_status: 'connected',
      whatsapp_phone: '+79991234567',
      whatsapp_name: 'Bloom Flowers',
      status: 'active', // a draft consultant starts answering as soon as a channel is live
    });
    expect(t.store.events.some((e) => e.type === 'whatsapp_connected')).toBe(true);
    expect(t.manager.view(t.row())).toMatchObject({ status: 'connected', qr: null, phone: '+79991234567' });
  });

  it('links with an 8-character code for the work number', async () => {
    const t = managerSetup();
    const view = await t.manager.connect(t.consultant, { method: 'code', phone: '+7 (999) 123-45-67' });
    expect(view).toMatchObject({ status: 'pairing', method: 'code', pairingCode: 'ABCD-1234', qr: null });
    expect(t.sockets[0]!.pairingPhone).toBe('79991234567');
    await expect(t.manager.connect(t.consultant, { method: 'code', phone: '123' })).rejects.toThrow(/international format/);
  });

  it('reports an expired code, and an unlink on the phone', async () => {
    const t = managerSetup();
    await t.manager.connect(t.consultant, { method: 'qr' });
    t.close(t.sockets[0]!, 408);
    await flush();
    expect(t.manager.view(t.row())).toMatchObject({ status: 'disconnected', error: 'expired' });

    const u = managerSetup();
    await u.manager.connect(u.consultant, { method: 'qr' });
    u.sockets[0]!.auth.creds.registered = true;
    u.sockets[0]!.emit('connection.update', { connection: 'open' });
    await flush();
    u.close(u.sockets[0]!, 401);
    await flush();
    expect(u.manager.isConnected(u.consultant.id)).toBe(false);
    expect(u.row().whatsapp_status).toBe('logged_out');
    expect(u.store.whatsappAuth.has(u.consultant.id)).toBe(false);
    expect(u.store.events.some((e) => e.type === 'whatsapp_logged_out')).toBe(true);
  });

  it('lets go quietly when a new deployment takes the session over', async () => {
    const t = managerSetup();
    await t.manager.connect(t.consultant, { method: 'qr' });
    t.sockets[0]!.auth.creds.registered = true;
    t.sockets[0]!.emit('connection.update', { connection: 'open' });
    await flush();
    t.close(t.sockets[0]!, 440);
    await flush();
    expect(t.manager.isConnected(t.consultant.id)).toBe(false);
    expect(t.sockets).toHaveLength(1); // no reconnect fight with the new server
    expect(t.row().whatsapp_status).toBe('connected'); // the new server owns it; the row stays as is
  });

  it('passes customer messages on, reconnects after a restart and unlinks on request', async () => {
    const t = managerSetup();
    await t.manager.connect(t.consultant, { method: 'qr' });
    t.sockets[0]!.auth.creds.registered = true;
    t.sockets[0]!.emit('creds.update', {});
    t.sockets[0]!.emit('connection.update', { connection: 'open' });
    await flush();

    t.sockets[0]!.emit('messages.upsert', { type: 'notify', messages: [wa({ imageMessage: { caption: 'Hi', mimetype: 'image/jpeg' } })] });
    t.sockets[0]!.emit('messages.upsert', { type: 'append', messages: [wa({ conversation: 'history' }, { id: 'OLD' })] });
    await flush();
    expect(t.incoming.map((m) => m.text)).toEqual(['Hi']);
    expect((await t.manager.downloadMedia(t.consultant.id, t.incoming[0]!.media as MediaRef)).toString()).toBe('image-bytes');
    expect(await t.manager.sendText(t.consultant.id, CUSTOMER, 'Hello!')).toBe('OUT1');

    // Server restart: the saved session reconnects without a new QR code.
    t.manager.stop();
    const restarted = new WhatsAppManager({
      config: t.config,
      store: t.store,
      logger: silentLogger(),
      createSocket: async (auth) => {
        const sock = new FakeSocket(auth);
        t.sockets.push(sock);
        return sock as unknown as WaSocket;
      },
    });
    t.sockets.length = 0;
    await restarted.start();
    expect(t.sockets).toHaveLength(1);
    expect(t.sockets[0]!.auth.creds.registered).toBe(true);
    t.sockets[0]!.emit('connection.update', { connection: 'open' });
    await flush();
    expect(restarted.isConnected(t.consultant.id)).toBe(true);

    await restarted.disconnect(t.consultant.id);
    expect(t.sockets[0]!.loggedOut).toBe(true);
    expect(restarted.isConnected(t.consultant.id)).toBe(false);
    expect(t.row()).toMatchObject({ whatsapp_status: 'disconnected', whatsapp_phone: null });
    expect(t.store.whatsappAuth.has(t.consultant.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Customer -> Gemini -> WhatsApp
// ---------------------------------------------------------------------------

class FakeWhatsApp implements WhatsAppGateway {
  connected = true;
  sent: { jid: string; text: string }[] = [];
  typing: boolean[] = [];
  read: string[][] = [];
  async sendText(_consultantId: string, jid: string, text: string) {
    this.sent.push({ jid, text });
    return `OUT${this.sent.length}`;
  }
  isConnected() {
    return this.connected;
  }
  async setTyping(_c: string, _j: string, typing: boolean) {
    this.typing.push(typing);
  }
  async markRead(_c: string, _j: string, ids: string[]) {
    this.read.push(ids);
  }
  async downloadMedia() {
    return Buffer.from('wa-photo');
  }
}

function runtimeSetup() {
  const config = testConfig();
  const store = new FakeStore();
  const llm = new FakeLlm();
  const whatsapp = new FakeWhatsApp();
  const consultant = store.addConsultant(
    makeConsultant({ telegram_bot_id: null, telegram_bot_username: null, whatsapp_status: 'connected', whatsapp_phone: '+77010000000' }),
    null,
    config.encryptionKey,
  );
  const runtime = new ConsultantRuntime({ store, llm, config, logger: silentLogger(), telegram: new FakeTelegram().factory, whatsapp, debounceMs: 0 });
  let n = 0;
  const send = async (text: string, extra: Partial<IncomingWhatsApp> = {}) => {
    await runtime.handleWhatsApp(consultant.id, {
      jid: CUSTOMER,
      messageId: `IN${++n}`,
      pushName: 'Maria',
      phone: '+79991234567',
      text,
      media: null,
      ...extra,
    });
    await runtime.drain();
  };
  return { config, store, llm, whatsapp, consultant, runtime, send };
}

describe('consultant runtime (WhatsApp -> Gemini -> WhatsApp)', () => {
  it('answers in WhatsApp with WhatsApp formatting, typing and read receipts', async () => {
    const t = runtimeSetup();
    t.llm.queue({ reply: '**Roses** are $5. [Order](https://shop.example/order)' });
    await t.send('How much are roses?');

    expect(t.llm.generateCalls[0]!.system).toContain('in WhatsApp');
    expect(t.llm.generateCalls[0]!.system).toContain('phone: +79991234567');
    expect(t.whatsapp.sent).toEqual([{ jid: CUSTOMER, text: '*Roses* are $5. Order (https://shop.example/order)' }]);
    expect(t.whatsapp.read).toEqual([['IN1']]);
    expect(t.whatsapp.typing).toEqual([true, false]);

    const conv = t.store.conversations[0]!;
    expect(conv).toMatchObject({ channel: 'whatsapp', external_jid: CUSTOMER, customer_name: 'Maria', customer_username: '+79991234567' });
    const msgs = t.store.messagesOf(conv.id);
    expect(msgs.map((m) => [m.role, m.external_message_id])).toEqual([
      ['customer', 'IN1'],
      ['assistant', 'OUT1'],
    ]);
  });

  it('ignores redelivered messages and keeps messages when the number is offline', async () => {
    const t = runtimeSetup();
    const msg = { jid: CUSTOMER, messageId: 'SAME', pushName: 'Maria', phone: null, text: 'Hi', media: null };
    await t.runtime.handleWhatsApp(t.consultant.id, msg);
    await t.runtime.handleWhatsApp(t.consultant.id, msg);
    await t.runtime.drain();
    expect(t.store.messages.filter((m) => m.role === 'customer')).toHaveLength(1);
    expect(t.llm.generateCalls).toHaveLength(1);

    t.whatsapp.connected = false;
    await t.send('Are you there?');
    expect(t.llm.generateCalls).toHaveLength(1);
    expect(t.store.messages.some((m) => m.content === 'Are you there?')).toBe(true);
  });

  it('sends photos to Gemini', async () => {
    const t = runtimeSetup();
    t.llm.queue({ reply: 'Yes, we have tulips.' });
    await t.send('Do you have these?', { media: { kind: 'photo', file_id: 'IMG', mime_type: 'image/jpeg' } });
    const parts = t.llm.generateCalls[0]!.messages.at(-1)!.parts;
    expect(parts[0]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: Buffer.from('wa-photo').toString('base64') } });
  });

  it('links the owner in WhatsApp and alerts them there when a customer needs a human', async () => {
    const t = runtimeSetup();
    const owner = '77001112233@s.whatsapp.net';
    Object.assign(t.store.consultants.get(t.consultant.id)!, { owner_link_code: 'GC-ABC234' });
    t.runtime.invalidate(t.consultant.id);
    await t.runtime.handleWhatsApp(t.consultant.id, { jid: owner, messageId: 'O1', pushName: 'Owner', phone: null, text: '/connect gc-abc234', media: null });
    expect(t.store.consultants.get(t.consultant.id)!.owner_whatsapp_jid).toBe(owner);
    expect(t.whatsapp.sent.at(-1)).toMatchObject({ jid: owner, text: expect.stringMatching(/Notifications are on/) });
    expect(t.store.messages).toHaveLength(0);

    t.runtime.invalidate(t.consultant.id);
    t.llm.queue({ reply: "I'll check with the team.", answer_status: 'unknown', confidence: 0.2 });
    await t.send('Can you ship to Mars?');
    const alert = t.whatsapp.sent.find((s) => s.jid === owner && s.text.includes('needs your attention'))!;
    expect(alert.text).toContain('(WhatsApp)');
    expect(alert.text).toContain('Can you ship to Mars?');
  });

  it('delivers a human reply from the dashboard through WhatsApp', async () => {
    const t = runtimeSetup();
    await t.send('complex question');
    const conv = t.store.conversations[0]!;
    const saved = await t.runtime.sendOperatorMessage(t.consultant.id, conv.id, 'Hi, this is **Kate**', 'kate@shop.com');
    expect(saved).toMatchObject({ role: 'operator', external_message_id: 'OUT2' });
    expect(t.whatsapp.sent.at(-1)).toEqual({ jid: CUSTOMER, text: 'Hi, this is *Kate*' });

    t.whatsapp.connected = false;
    await expect(t.runtime.sendOperatorMessage(t.consultant.id, conv.id, 'hello?', null)).rejects.toMatchObject({ code: 'whatsapp_not_connected' });
  });

  it('/reset clears the context in WhatsApp too', async () => {
    const t = runtimeSetup();
    await t.send('Привет');
    await t.send('/reset');
    expect(t.whatsapp.sent.at(-1)!.text).toMatch(/cleared our conversation/);
    expect(t.store.conversations[0]!.memory_reset_at).not.toBeNull();
  });
});
