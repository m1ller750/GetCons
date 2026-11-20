import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  makeCacheableSignalKeyStore,
  type ConnectionState,
  type WAMessage,
  type WASocket,
  type WAVersion,
} from 'baileys';
import type { AppConfig } from '../config.js';
import type { Store } from '../db/store.js';
import type { ConsultantRow, MediaRef, WhatsAppStatus } from '../db/types.js';
import { AppError, badRequest, errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { useDbAuthState, type DbAuthState } from '../services/whatsapp/authState.js';
import { normalizePhone, parseIncoming, phoneFromJid, type IncomingWhatsApp } from '../services/whatsapp/messages.js';
import type { WhatsAppGateway } from './runtime.js';

/**
 * WhatsApp channel: the consultant answers from the business's *work* number, linked to the
 * server the same way WhatsApp Web is ("Linked devices"), by scanning a QR code or entering an
 * 8-character code on the phone. No Meta business verification is needed, which makes setup
 * take a minute; the trade-off is that this is not Meta's official Cloud API, so the dashboard
 * tells owners to use a separate work number rather than their personal one.
 */

export type PairingMethod = 'qr' | 'code';
export type SessionStatus = WhatsAppStatus | 'connecting';

/** The part of a Baileys socket we use, so tests can plug in a fake. */
export type WaSocket = Pick<WASocket, 'ev' | 'user' | 'requestPairingCode' | 'sendMessage' | 'sendPresenceUpdate' | 'readMessages' | 'logout' | 'end'>;
export type WaSocketFactory = (auth: DbAuthState['state'], logger: Logger) => Promise<WaSocket>;

/** What the dashboard shows while linking and afterwards. */
export interface WhatsAppView {
  enabled: boolean;
  status: SessionStatus;
  method: PairingMethod | null;
  /** QR payload to render (method "qr") */
  qr: string | null;
  /** "ABCD-1234" to type on the phone (method "code") */
  pairingCode: string | null;
  phone: string | null;
  name: string | null;
  connectedAt: string | null;
  error: string | null;
}

interface Session {
  consultantId: string;
  auth: DbAuthState;
  sock: WaSocket | null;
  method: PairingMethod;
  /** digits, for the pairing code */
  phone: string | null;
  status: SessionStatus;
  qr: string | null;
  pairingCode: string | null;
  error: string | null;
  retries: number;
  /** set when we close it on purpose: no reconnect */
  closed: boolean;
  timer: NodeJS.Timeout | null;
  waiters: Set<() => void>;
}

export interface WhatsAppManagerDeps {
  config: AppConfig;
  store: Store;
  logger: Logger;
  createSocket?: WaSocketFactory;
  download?: (msg: WAMessage) => Promise<Buffer>;
  /** Called when the consultant row changed (the runtime drops its cached copy). */
  onChange?: (consultantId: string) => void;
}

const MEDIA_TTL_MS = 15 * 60_000;
const MEDIA_CACHE_MAX = 500;

let latestVersion: Promise<WAVersion | undefined> | null = null;
/** WhatsApp rejects outdated web clients; fetch the current version once (fall back to Baileys' own). */
function waVersion(logger: Logger): Promise<WAVersion | undefined> {
  latestVersion ??= fetchLatestBaileysVersion({ signal: AbortSignal.timeout(5_000) })
    .then((v) => v.version)
    .catch((err) => {
      logger.warn({ err: errorMessage(err) }, 'Could not fetch the latest WhatsApp Web version; using the bundled one');
      return undefined;
    });
  return latestVersion;
}

export const createBaileysSocket: WaSocketFactory = async (auth, logger) => {
  const quiet = logger.child({ module: 'baileys' }, { level: 'error' });
  const version = await waVersion(logger);
  return makeWASocket({
    ...(version ? { version } : {}),
    auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, quiet) },
    logger: quiet,
    // Shown on the phone under Linked devices as "Chrome (GetCons AI)".
    browser: ['GetCons AI', 'Chrome', '1.0.0'],
    // Staying "offline" keeps notifications on the owner's phone.
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    shouldIgnoreJid: (jid) => Boolean(isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)),
    getMessage: async () => undefined,
  });
};

const statusCodeOf = (error: unknown): number | undefined =>
  (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;

const formatCode = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

export class WhatsAppManager implements WhatsAppGateway {
  readonly enabled: boolean;
  private readonly sessions = new Map<string, Session>();
  private readonly media = new Map<string, { msg: WAMessage; at: number }>();
  private readonly createSocket: WaSocketFactory;
  private readonly download: (msg: WAMessage) => Promise<Buffer>;
  private handler: ((consultantId: string, msg: IncomingWhatsApp) => Promise<void>) | null = null;

  constructor(private readonly deps: WhatsAppManagerDeps) {
    this.enabled = deps.config.whatsapp.enabled;
    this.createSocket = deps.createSocket ?? createBaileysSocket;
    this.download = deps.download ?? ((msg) => downloadMediaMessage(msg, 'buffer', {}));
  }

  /** Where incoming customer messages go (the consultant runtime). */
  onMessage(handler: (consultantId: string, msg: IncomingWhatsApp) => Promise<void>): void {
    this.handler = handler;
  }

  // ---------------------------------------------------------------------------
  // Linking a work number
  // ---------------------------------------------------------------------------

  /** Starts linking: returns as soon as the QR code or pairing code is ready. */
  async connect(consultant: ConsultantRow, opts: { method: PairingMethod; phone?: string | null }): Promise<WhatsAppView> {
    if (!this.enabled) throw new AppError(409, 'whatsapp_disabled', 'WhatsApp is turned off on this server (WHATSAPP_ENABLED=false)');
    const phone = opts.method === 'code' ? normalizePhone(opts.phone ?? '') : null;
    if (opts.method === 'code' && !phone) {
      throw badRequest('Enter the work number in international format, for example +7 999 123-45-67');
    }
    const existing = this.sessions.get(consultant.id);
    if (existing?.status === 'connected') return this.view(consultant);
    if (existing) this.close(existing);

    // A fresh pairing always starts from clean credentials.
    await this.deps.store.clearWhatsAppAuth(consultant.id);
    const auth = await useDbAuthState(this.deps.store, consultant.id, this.deps.config.encryptionKey);
    const session = this.newSession(consultant.id, auth, opts.method, phone);
    this.sessions.set(consultant.id, session);
    await this.updateRow(consultant.id, { whatsapp_status: 'pairing' });
    await this.open(session);
    await this.waitFor(session, (s) => Boolean(s.qr || s.pairingCode || s.error || s.status === 'connected'), 15_000);
    return this.view((await this.deps.store.getConsultant(consultant.id)) ?? consultant);
  }

  /** Unlinks the device on the phone too and forgets the session. */
  async disconnect(consultantId: string): Promise<void> {
    const session = this.sessions.get(consultantId);
    if (session) {
      if (session.sock && session.status === 'connected') await session.sock.logout().catch(() => undefined);
      this.close(session);
    }
    await this.deps.store.clearWhatsAppAuth(consultantId);
    await this.updateRow(consultantId, {
      whatsapp_status: 'disconnected',
      whatsapp_phone: null,
      whatsapp_name: null,
      whatsapp_connected_at: null,
      owner_whatsapp_jid: null,
    });
  }

  view(consultant: ConsultantRow): WhatsAppView {
    const s = this.sessions.get(consultant.id);
    // A "pairing" row without a live session is a leftover from a restart.
    const rowStatus: SessionStatus = consultant.whatsapp_status === 'pairing' ? 'disconnected' : consultant.whatsapp_status;
    return {
      enabled: this.enabled,
      status: s?.status ?? rowStatus,
      method: s && s.status !== 'connected' ? s.method : null,
      qr: s?.qr ?? null,
      pairingCode: s?.pairingCode ?? null,
      phone: consultant.whatsapp_phone,
      name: consultant.whatsapp_name,
      connectedAt: consultant.whatsapp_connected_at,
      error: s?.error ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Gateway used by the consultant runtime
  // ---------------------------------------------------------------------------

  isConnected(consultantId: string): boolean {
    const s = this.sessions.get(consultantId);
    return Boolean(s?.sock && s.status === 'connected');
  }

  async sendText(consultantId: string, jid: string, text: string): Promise<string | null> {
    const s = this.sessions.get(consultantId);
    if (!s?.sock || s.status !== 'connected') throw new Error('The WhatsApp number is not connected');
    const sent = await s.sock.sendMessage(jid, { text });
    return sent?.key?.id ?? null;
  }

  async setTyping(consultantId: string, jid: string, typing: boolean): Promise<void> {
    const s = this.sessions.get(consultantId);
    if (s?.sock && s.status === 'connected') await s.sock.sendPresenceUpdate(typing ? 'composing' : 'paused', jid);
  }

  async markRead(consultantId: string, jid: string, messageIds: string[]): Promise<void> {
    const s = this.sessions.get(consultantId);
    if (s?.sock && s.status === 'connected' && messageIds.length) {
      await s.sock.readMessages(messageIds.map((id) => ({ remoteJid: jid, id, fromMe: false })));
    }
  }

  async downloadMedia(consultantId: string, media: MediaRef): Promise<Buffer> {
    const cached = this.media.get(`${consultantId}:${media.file_id}`);
    if (!cached) throw new Error('The file is no longer available');
    return this.download(cached.msg);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Reconnects every linked number after a restart or deploy. */
  async start(): Promise<void> {
    if (!this.enabled) return;
    const consultants = await this.deps.store.listWhatsAppConsultants();
    for (const c of consultants) {
      try {
        const auth = await useDbAuthState(this.deps.store, c.id, this.deps.config.encryptionKey);
        if (!auth.state.creds.registered) {
          await this.updateRow(c.id, { whatsapp_status: 'disconnected' });
          continue;
        }
        const session = this.newSession(c.id, auth, 'qr', null);
        session.status = 'connecting';
        this.sessions.set(c.id, session);
        await this.open(session);
      } catch (err) {
        this.deps.logger.warn({ consultantId: c.id, err: errorMessage(err) }, 'Could not restore the WhatsApp session');
      }
    }
    if (consultants.length) this.deps.logger.info({ numbers: consultants.length }, 'WhatsApp sessions restored');
  }

  /** Closes the sockets without unlinking, so the next start reconnects. */
  stop(): void {
    for (const session of this.sessions.values()) this.close(session);
    this.sessions.clear();
  }

  private newSession(consultantId: string, auth: DbAuthState, method: PairingMethod, phone: string | null): Session {
    return {
      consultantId,
      auth,
      sock: null,
      method,
      phone,
      status: 'pairing',
      qr: null,
      pairingCode: null,
      error: null,
      retries: 0,
      closed: false,
      timer: null,
      waiters: new Set(),
    };
  }

  /** Ends the socket. `keep` leaves the (dead) session visible so the dashboard can show why it ended. */
  private close(session: Session, keep = false): void {
    session.closed = true;
    if (session.timer) clearTimeout(session.timer);
    session.sock?.end(undefined);
    session.sock = null;
    if (!keep && this.sessions.get(session.consultantId) === session) this.sessions.delete(session.consultantId);
    this.notify(session);
  }

  private async open(session: Session): Promise<void> {
    if (session.closed) return;
    const sock = await this.createSocket(session.auth.state, this.deps.logger);
    if (session.closed) {
      sock.end(undefined);
      return;
    }
    session.sock = sock;
    sock.ev.on('creds.update', () => {
      void session.auth.saveCreds().catch((err) =>
        this.deps.logger.error({ consultantId: session.consultantId, err: errorMessage(err) }, 'Could not save the WhatsApp session'),
      );
    });
    sock.ev.on('connection.update', (update) => {
      void this.onConnection(session, sock, update).catch((err) =>
        this.deps.logger.error({ consultantId: session.consultantId, err: errorMessage(err) }, 'WhatsApp connection handling failed'),
      );
    });
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify' || session.sock !== sock) return;
      for (const msg of messages) this.onIncoming(session.consultantId, msg);
    });
  }

  private async onConnection(session: Session, sock: WaSocket, update: Partial<ConnectionState>): Promise<void> {
    if (session.sock !== sock || session.closed) return;
    const { logger, store } = this.deps;
    const id = session.consultantId;

    if (update.qr) {
      if (session.method === 'code') {
        if (!session.pairingCode && session.phone && !session.auth.state.creds.registered) {
          try {
            session.pairingCode = formatCode(await sock.requestPairingCode(session.phone));
          } catch (err) {
            session.error = `WhatsApp did not issue a code: ${errorMessage(err)}`;
          }
        }
      } else {
        session.qr = update.qr;
      }
      session.status = 'pairing';
      this.notify(session);
    }

    if (update.connection === 'open') {
      session.status = 'connected';
      session.qr = null;
      session.pairingCode = null;
      session.error = null;
      session.retries = 0;
      const me = sock.user;
      const consultant = await store.getConsultant(id);
      const firstLink = consultant?.whatsapp_status !== 'connected';
      const phone = phoneFromJid(me?.id ? me.id.replace(/:\d+@/, '@') : null);
      await this.updateRow(id, {
        whatsapp_status: 'connected',
        whatsapp_phone: phone ?? consultant?.whatsapp_phone ?? null,
        whatsapp_name: me?.name || me?.notify || consultant?.whatsapp_name || null,
        ...(firstLink ? { whatsapp_connected_at: new Date().toISOString() } : {}),
        // A consultant with a live channel answers right away.
        ...(consultant && ['draft', 'error'].includes(consultant.status) ? { status: 'active' as const, last_error: null } : {}),
      });
      if (firstLink) await store.logEvent(id, 'whatsapp_connected', `WhatsApp linked: ${phone ?? 'work number'}`);
      logger.info({ consultantId: id }, 'WhatsApp connected');
      this.notify(session);
      return;
    }

    if (update.connection !== 'close') return;
    session.sock = null;
    const code = statusCodeOf(update.lastDisconnect?.error);

    if (code === DisconnectReason.loggedOut) {
      // Unlinked from the phone (or WhatsApp ended the session).
      this.close(session);
      await store.clearWhatsAppAuth(id);
      await this.updateRow(id, { whatsapp_status: 'logged_out', owner_whatsapp_jid: null });
      await store.logEvent(id, 'whatsapp_logged_out', 'The WhatsApp number was unlinked on the phone. Link it again to keep answering.', {
        level: 'warning',
      });
      return;
    }
    if (code === DisconnectReason.connectionReplaced) {
      // Another server took the session over: normally the new deployment during a rollout.
      // It now owns the number, so this one just lets go without touching the shared row.
      session.error = 'This WhatsApp session was opened by another GetCons server.';
      this.close(session);
      logger.warn({ consultantId: id }, 'WhatsApp session taken over by another server; closing it here');
      return;
    }
    if (!session.auth.state.creds.registered && code !== DisconnectReason.restartRequired) {
      // The QR code / pairing code expired before it was used.
      session.status = 'disconnected';
      session.error = 'expired';
      this.close(session, true);
      await this.updateRow(id, { whatsapp_status: 'disconnected' });
      return;
    }
    // restartRequired comes right after a successful link; anything else is a network hiccup.
    const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(60_000, 1_000 * 2 ** session.retries++);
    session.status = session.status === 'pairing' ? 'pairing' : 'connecting';
    this.notify(session);
    logger.info({ consultantId: id, code, delay }, 'WhatsApp reconnecting');
    session.timer = setTimeout(() => {
      session.timer = null;
      void this.open(session).catch((err) => {
        logger.warn({ consultantId: id, err: errorMessage(err) }, 'WhatsApp reconnect failed');
      });
    }, delay);
    session.timer.unref?.();
  }

  private onIncoming(consultantId: string, msg: WAMessage): void {
    const incoming = parseIncoming(msg);
    if (!incoming || !this.handler) return;
    if (incoming.media) this.rememberMedia(consultantId, incoming.messageId, msg);
    void this.handler(consultantId, incoming).catch((err) =>
      this.deps.logger.error({ consultantId, err: errorMessage(err) }, 'WhatsApp message handling failed'),
    );
  }

  private rememberMedia(consultantId: string, messageId: string, msg: WAMessage): void {
    const now = Date.now();
    if (this.media.size >= MEDIA_CACHE_MAX) {
      for (const [key, item] of this.media) if (now - item.at > MEDIA_TTL_MS || this.media.size >= MEDIA_CACHE_MAX) this.media.delete(key);
    }
    this.media.set(`${consultantId}:${messageId}`, { msg, at: now });
  }

  private async updateRow(consultantId: string, patch: Partial<ConsultantRow>): Promise<void> {
    await this.deps.store.updateConsultant(consultantId, patch);
    this.deps.onChange?.(consultantId);
  }

  private notify(session: Session): void {
    for (const wake of [...session.waiters]) wake();
  }

  private waitFor(session: Session, done: (s: Session) => boolean, timeoutMs: number): Promise<void> {
    if (done(session) || session.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        session.waiters.delete(check);
        resolve();
      };
      const check = () => {
        if (done(session) || session.closed) finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      session.waiters.add(check);
    });
  }
}
