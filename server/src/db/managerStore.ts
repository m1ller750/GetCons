import { dbError } from '../lib/errors.js';
import type { SupabaseClient } from '../lib/supabase.js';

export type BotRequestStatus = 'pending' | 'completed' | 'failed' | 'expired';

export interface BotRequestRow {
  id: string;
  consultant_id: string;
  user_id: string;
  nonce: string;
  suggested_username: string;
  suggested_name: string;
  telegram_user_id: number | null;
  status: BotRequestStatus;
  bot_id: number | null;
  bot_username: string | null;
  error: string | null;
  expires_at: string;
  created_at: string;
  completed_at: string | null;
}

export interface ManagedBotRow {
  bot_id: number;
  username: string | null;
  name: string | null;
  creator_telegram_id: number;
  consultant_id: string | null;
  created_at: string;
  claimed_at: string | null;
}

/** Service-role data access for one-click bot creation. */
export interface ManagerStore {
  createRequest(input: {
    consultantId: string;
    nonce: string;
    suggestedUsername: string;
    suggestedName: string;
    expiresAt: string;
  }): Promise<BotRequestRow>;
  getRequestByNonce(nonce: string): Promise<BotRequestRow | null>;
  /** Pending, unexpired request whose suggested username matches (case-insensitive). */
  findPendingByUsername(username: string, nowIso: string): Promise<BotRequestRow | null>;
  /** Latest pending, unexpired request already tied to this Telegram account. */
  findPendingByTelegramUser(telegramUserId: number, nowIso: string): Promise<BotRequestRow | null>;
  updateRequest(id: string, patch: Partial<BotRequestRow>): Promise<void>;

  upsertManagedBot(row: Pick<ManagedBotRow, 'bot_id' | 'username' | 'name' | 'creator_telegram_id'>): Promise<ManagedBotRow>;
  claimManagedBot(botId: number, consultantId: string): Promise<void>;
  listUnclaimedByCreator(telegramUserId: number, sinceIso: string): Promise<ManagedBotRow[]>;
}

export function createSupabaseManagerStore(admin: SupabaseClient): ManagerStore {
  return {
    async createRequest(input) {
      const { data, error } = await admin
        .from('bot_creation_requests')
        .insert({
          consultant_id: input.consultantId,
          nonce: input.nonce,
          suggested_username: input.suggestedUsername,
          suggested_name: input.suggestedName,
          expires_at: input.expiresAt,
        })
        .select('*')
        .single();
      if (error) throw dbError(error, 'creating bot request');
      return data as BotRequestRow;
    },

    async getRequestByNonce(nonce) {
      const { data, error } = await admin.from('bot_creation_requests').select('*').eq('nonce', nonce).maybeSingle();
      if (error) throw dbError(error, 'loading bot request');
      return (data as BotRequestRow | null) ?? null;
    },

    async findPendingByUsername(username, nowIso) {
      const { data, error } = await admin
        .from('bot_creation_requests')
        .select('*')
        .eq('status', 'pending')
        .ilike('suggested_username', username.replace(/[%_\\]/g, (c) => `\\${c}`))
        .gt('expires_at', nowIso)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw dbError(error, 'matching bot request');
      return (data as BotRequestRow | null) ?? null;
    },

    async findPendingByTelegramUser(telegramUserId, nowIso) {
      const { data, error } = await admin
        .from('bot_creation_requests')
        .select('*')
        .eq('status', 'pending')
        .eq('telegram_user_id', telegramUserId)
        .gt('expires_at', nowIso)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw dbError(error, 'matching bot request');
      return (data as BotRequestRow | null) ?? null;
    },

    async updateRequest(id, patch) {
      const { error } = await admin.from('bot_creation_requests').update(patch).eq('id', id);
      if (error) throw dbError(error, 'updating bot request');
    },

    async upsertManagedBot(row) {
      const { data, error } = await admin.from('managed_bots').upsert(row, { onConflict: 'bot_id' }).select('*').single();
      if (error) throw dbError(error, 'saving managed bot');
      return data as ManagedBotRow;
    },

    async claimManagedBot(botId, consultantId) {
      const { error } = await admin
        .from('managed_bots')
        .update({ consultant_id: consultantId, claimed_at: new Date().toISOString() })
        .eq('bot_id', botId);
      if (error) throw dbError(error, 'claiming managed bot');
    },

    async listUnclaimedByCreator(telegramUserId, sinceIso) {
      const { data, error } = await admin
        .from('managed_bots')
        .select('*')
        .eq('creator_telegram_id', telegramUserId)
        .is('consultant_id', null)
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false });
      if (error) throw dbError(error, 'listing managed bots');
      return (data ?? []) as ManagedBotRow[];
    },
  };
}
