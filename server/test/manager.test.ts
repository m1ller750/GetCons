import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ManagerBot, suggestBotName, suggestBotUsername } from '../src/core/manager.js';
import type { BotRequestRow, ManagedBotRow, ManagerStore } from '../src/db/managerStore.js';
import type { ConsultantRow } from '../src/db/types.js';
import { silentLogger } from '../src/lib/logger.js';
import { FakeTelegram, makeConsultant, testConfig } from './helpers/fakes.js';

const MANAGER_TOKEN = '999999:AAEmanagermanagermanagermanagermanager';
const CREATOR = { id: 4242, is_bot: false, first_name: 'Olga', language_code: 'en' };

class FakeManagerStore implements ManagerStore {
  requests: BotRequestRow[] = [];
  bots = new Map<number, ManagedBotRow>();
  async createRequest(input: Parameters<ManagerStore['createRequest']>[0]) {
    const row: BotRequestRow = {
      id: randomUUID(),
      consultant_id: input.consultantId,
      user_id: 'owner',
      nonce: input.nonce,
      suggested_username: input.suggestedUsername,
      suggested_name: input.suggestedName,
      telegram_user_id: null,
      status: 'pending',
      bot_id: null,
      bot_username: null,
      error: null,
      expires_at: input.expiresAt,
      created_at: new Date().toISOString(),
      completed_at: null,
    };
    this.requests.push(row);
    return row;
  }
  async getRequestByNonce(nonce: string) {
    return this.requests.find((r) => r.nonce === nonce) ?? null;
  }
  async findPendingByUsername(username: string, now: string) {
    return this.requests.find((r) => r.status === 'pending' && r.expires_at > now && r.suggested_username.toLowerCase() === username.toLowerCase()) ?? null;
  }
  async findPendingByTelegramUser(id: number, now: string) {
    return [...this.requests].reverse().find((r) => r.status === 'pending' && r.expires_at > now && r.telegram_user_id === id) ?? null;
  }
  async updateRequest(id: string, patch: Partial<BotRequestRow>) {
    Object.assign(this.requests.find((r) => r.id === id)!, patch);
  }
  async upsertManagedBot(row: Pick<ManagedBotRow, 'bot_id' | 'username' | 'name' | 'creator_telegram_id'>) {
    const existing = this.bots.get(row.bot_id);
    const next: ManagedBotRow = {
      consultant_id: null,
      created_at: new Date().toISOString(),
      claimed_at: null,
      ...existing,
      ...row,
    };
    this.bots.set(row.bot_id, next);
    return next;
  }
  async claimManagedBot(botId: number, consultantId: string) {
    Object.assign(this.bots.get(botId)!, { consultant_id: consultantId, claimed_at: new Date().toISOString() });
  }
  async listUnclaimedByCreator(id: number, since: string) {
    return [...this.bots.values()].filter((b) => b.creator_telegram_id === id && !b.consultant_id && b.created_at >= since);
  }
}

function setup() {
  const config = testConfig({ telegram: { mode: 'webhook', apiBaseUrl: 'https://api.telegram.test', managerBotToken: MANAGER_TOKEN } });
  const telegram = new FakeTelegram();
  const managerBot = telegram.bot(MANAGER_TOKEN);
  Object.assign(managerBot.me, { username: 'GetConsBot', can_manage_bots: true });
  const store = new FakeManagerStore();
  const consultant: ConsultantRow = makeConsultant({ business_info: { businessName: 'Цветы Блум' }, telegram_bot_id: null, status: 'draft' });
  const connected: { consultantId: string; token: string }[] = [];
  const events: string[] = [];
  const manager = new ManagerBot({
    config,
    logger: silentLogger(),
    store,
    telegram: telegram.factory,
    connect: async (consultantId, token) => {
      connected.push({ consultantId, token });
      return consultant;
    },
    logEvent: async (_id, type) => {
      events.push(type);
    },
  });
  return { config, telegram, managerBot, store, consultant, connected, events, manager };
}

describe('one-click bot creation (Telegram Managed Bots)', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await t.manager.start();
  });

  it('suggests valid Telegram bot usernames and names', () => {
    expect(suggestBotUsername('Цветы Блум', 'a1b2')).toBe('tsvety_blum_a1b2_bot');
    expect(suggestBotUsername('123 Pizza!', 'ffff')).toBe('ai_123_pizza_ffff_bot');
    expect(suggestBotUsername('', '0000')).toBe('ai_0000_bot');
    const long = suggestBotUsername('A very long business name that goes on and on');
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long).toMatch(/^[a-z][a-z0-9_]{3,}bot$/);
    expect(suggestBotName({ name: 'Anna', business_info: { businessName: 'Bloom' } })).toBe('Bloom · AI');
  });

  it('is enabled only when the manager bot may manage bots, and registers its webhook', async () => {
    expect(t.manager.enabled).toBe(true);
    expect(t.manager.botUsername).toBe('GetConsBot');
    expect(t.managerBot.webhook?.url).toBe('https://getcons.test/telegram/manager');
    expect(t.manager.verifyWebhookSecret(t.manager.webhookSecret())).toBe(true);
    expect(t.manager.verifyWebhookSecret('nope')).toBe(false);

    const off = setup();
    Object.assign(off.managerBot.me, { can_manage_bots: false });
    await off.manager.start();
    expect(off.manager.enabled).toBe(false);
    expect(off.manager.status.problem).toMatch(/Bot Management/);
  });

  it('builds a t.me/newbot link with pre-filled username and name', async () => {
    const { link, fallbackLink, request } = await t.manager.createLink(t.consultant);
    expect(link).toBe(`https://t.me/newbot/GetConsBot/${request.suggested_username}?name=${encodeURIComponent('Цветы Блум · AI')}`);
    expect(fallbackLink).toBe(`https://t.me/GetConsBot?start=claim_${request.nonce}`);
    expect(request.suggested_username).toMatch(/^tsvety_blum_[a-f0-9]{4}_bot$/);
  });

  it('connects the bot Telegram created: matched by username, token from getManagedBotToken', async () => {
    const { request } = await t.manager.createLink(t.consultant);
    t.managerBot.managedTokens.set(777, '777:AAEnewbotnewbotnewbotnewbotnewbotnew');
    await t.manager.handleUpdate({
      update_id: 1,
      managed_bot: { user: CREATOR, bot: { id: 777, is_bot: true, first_name: 'Цветы Блум · AI', username: request.suggested_username } },
    });
    expect(t.connected).toEqual([{ consultantId: t.consultant.id, token: '777:AAEnewbotnewbotnewbotnewbotnewbotnew' }]);
    expect(t.store.requests[0]).toMatchObject({ status: 'completed', bot_id: 777, bot_username: request.suggested_username, telegram_user_id: CREATOR.id });
    expect(t.store.bots.get(777)?.consultant_id).toBe(t.consultant.id);
    expect(t.events).toContain('bot_created');
    expect(t.managerBot.sent.at(-1)).toMatchObject({ chatId: CREATOR.id, text: expect.stringContaining('is live') });
  });

  it('links a bot whose username was edited once the user opens the fallback link', async () => {
    const { request } = await t.manager.createLink(t.consultant);
    t.managerBot.managedTokens.set(888, '888:AAEeditededitededitededitededitedited');
    await t.manager.handleUpdate({
      update_id: 2,
      managed_bot: { user: CREATOR, bot: { id: 888, is_bot: true, first_name: 'Mine', username: 'my_own_name_bot' } },
    });
    expect(t.connected).toHaveLength(0); // no proof yet that this Telegram user owns the request
    await t.manager.handleUpdate({
      update_id: 3,
      message: { message_id: 1, date: 0, chat: { id: CREATOR.id, type: 'private' }, from: CREATOR, text: `/start claim_${request.nonce}` },
    });
    expect(t.connected).toEqual([{ consultantId: t.consultant.id, token: '888:AAEeditededitededitededitededitedited' }]);
    expect(t.store.requests[0]!.status).toBe('completed');
  });

  it('offers the native "create bot" button when nothing was created yet, then matches by Telegram account', async () => {
    const { request } = await t.manager.createLink(t.consultant);
    await t.manager.handleUpdate({
      update_id: 4,
      message: { message_id: 2, date: 0, chat: { id: CREATOR.id, type: 'private' }, from: CREATOR, text: `/start new_${request.nonce}` },
    });
    const markup = t.managerBot.markups.at(-1) as { keyboard: { request_managed_bot: { suggested_username: string } }[][] };
    expect(markup.keyboard[0]![0]!.request_managed_bot.suggested_username).toBe(request.suggested_username);
    expect(t.store.requests[0]!.telegram_user_id).toBe(CREATOR.id);

    t.managerBot.managedTokens.set(999001, '999001:AAEbuttonbuttonbuttonbuttonbuttonbutto');
    await t.manager.handleUpdate({
      update_id: 5,
      managed_bot: { user: CREATOR, bot: { id: 999001, is_bot: true, first_name: 'X', username: 'renamed_again_bot' } },
    });
    expect(t.connected.at(-1)?.consultantId).toBe(t.consultant.id);
  });

  it('refuses expired links and refreshes the token when Telegram reports a token change', async () => {
    const { request } = await t.manager.createLink(t.consultant);
    request.expires_at = new Date(Date.now() - 1000).toISOString();
    await t.manager.handleUpdate({
      update_id: 6,
      message: { message_id: 3, date: 0, chat: { id: CREATOR.id, type: 'private' }, from: CREATOR, text: `/start claim_${request.nonce}` },
    });
    expect(t.managerBot.sent.at(-1)!.text).toMatch(/expired/);

    // a bot that already powers a consultant gets a new token
    await t.store.upsertManagedBot({ bot_id: 555, username: 'live_bot', name: 'Live', creator_telegram_id: CREATOR.id });
    await t.store.claimManagedBot(555, t.consultant.id);
    t.managerBot.managedTokens.set(555, '555:AAErotatedrotatedrotatedrotatedrotated');
    await t.manager.handleUpdate({ update_id: 7, managed_bot: { user: CREATOR, bot: { id: 555, is_bot: true, first_name: 'Live', username: 'live_bot' } } });
    expect(t.connected.at(-1)).toEqual({ consultantId: t.consultant.id, token: '555:AAErotatedrotatedrotatedrotatedrotated' });
  });

  it('accepts a @BotFather token pasted into the manager chat (Telegram apps without managed bots)', async () => {
    const TOKEN = '9990001:AAEpastedpastedpastedpastedpastedpast';
    // No request tied to this Telegram account yet: ask to open the link from the website first.
    await t.manager.handleUpdate({ update_id: 30, message: { message_id: 40, date: 0, chat: { id: CREATOR.id, type: 'private' }, from: CREATOR, text: TOKEN } });
    expect(t.connected).toHaveLength(0);
    expect(t.managerBot.deleted).toContainEqual({ chatId: CREATOR.id, messageId: 40 });

    const { request } = await t.manager.createLink(t.consultant);
    await t.manager.handleUpdate({ update_id: 31, message: { message_id: 41, date: 0, chat: { id: CREATOR.id, type: 'private' }, from: CREATOR, text: `/start claim_${request.nonce}` } });
    expect(t.managerBot.sent.at(-1)!.text).toMatch(/@BotFather/);
    await t.manager.handleUpdate({ update_id: 32, message: { message_id: 42, date: 0, chat: { id: CREATOR.id, type: 'private' }, from: CREATOR, text: TOKEN } });
    expect(t.connected).toEqual([{ consultantId: t.consultant.id, token: TOKEN }]);
    expect(t.managerBot.deleted).toContainEqual({ chatId: CREATOR.id, messageId: 42 });
    expect(t.store.requests[0]).toMatchObject({ status: 'completed' });
    expect(t.events).toContain('bot_created');
  });

  it('marks the request failed when connecting does not work', async () => {
    const { request } = await t.manager.createLink(t.consultant);
    await t.manager.handleUpdate({
      update_id: 8,
      managed_bot: { user: CREATOR, bot: { id: 123, is_bot: true, first_name: 'X', username: request.suggested_username } },
    });
    expect(t.store.requests[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('not managed') });
    expect(t.events).toContain('bot_create_failed');
  });
});
