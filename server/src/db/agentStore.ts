import type { StorePlatform } from '../core/agent/connectors.js';
import { dbError } from '../lib/errors.js';
import type { SupabaseClient } from '../lib/supabase.js';

/** Row shapes of supabase/migrations/*_agent_and_web.sql. */

export interface StoreConnectionRow {
  id: string;
  consultant_id: string;
  user_id: string;
  platform: StorePlatform;
  store_url: string;
  store_name: string | null;
  currency: string | null;
  credentials_ciphertext: string;
  status: 'connected' | 'error';
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export type AgentActionKind = 'create_order' | 'cancel_order' | 'refund' | 'notify';
export type AgentActionStatus = 'awaiting_customer' | 'awaiting_owner' | 'done' | 'failed' | 'rejected' | 'expired' | 'simulated';

export interface AgentActionRow {
  id: string;
  consultant_id: string;
  user_id: string;
  conversation_id: string | null;
  kind: AgentActionKind;
  status: AgentActionStatus;
  summary: string;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  amount: number | string | null;
  currency: string | null;
  external_ref: string | null;
  confirm_code: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  executed_at: string | null;
}

export interface AgentOrderRow {
  id: string;
  consultant_id: string;
  user_id: string;
  conversation_id: string;
  external_id: string;
  number: string;
  status: string | null;
  notified_status: string | null;
  closed: boolean;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewAgentAction {
  consultantId: string;
  conversationId: string | null;
  kind: AgentActionKind;
  status: AgentActionStatus;
  summary: string;
  params: Record<string, unknown>;
  amount?: number | null;
  currency?: string | null;
  externalRef?: string | null;
  confirmCode?: string | null;
}

export type AgentActionPatch = Partial<Pick<AgentActionRow, 'status' | 'result' | 'error' | 'external_ref' | 'executed_at' | 'amount' | 'currency'>>;

/** Service-role data access for the agent; every method is scoped by consultant or conversation. */
export interface AgentStore {
  getConnection(consultantId: string): Promise<StoreConnectionRow | null>;
  getConnectionById(id: string): Promise<StoreConnectionRow | null>;
  saveConnection(input: Omit<StoreConnectionRow, 'id' | 'user_id' | 'created_at' | 'updated_at'>): Promise<StoreConnectionRow>;
  updateConnection(id: string, patch: Partial<Pick<StoreConnectionRow, 'status' | 'last_error' | 'store_name' | 'currency'>>): Promise<void>;
  deleteConnection(consultantId: string): Promise<void>;

  insertAction(input: NewAgentAction): Promise<AgentActionRow>;
  getAction(id: string): Promise<AgentActionRow | null>;
  findActionByCode(conversationId: string, code: string): Promise<AgentActionRow | null>;
  /** Moves an action on only from the expected status (no double execution); null if it had moved already. */
  transitionAction(id: string, from: AgentActionStatus, patch: AgentActionPatch): Promise<AgentActionRow | null>;
  listActions(consultantId: string, limit: number): Promise<AgentActionRow[]>;

  /** Follows an order for a chat; does nothing if it is followed already. */
  linkOrder(input: { consultantId: string; conversationId: string; externalId: string; number: string; status: string }): Promise<void>;
  findLinkedOrder(consultantId: string, conversationId: string, externalId: string): Promise<AgentOrderRow | null>;
  findOrder(consultantId: string, ref: string): Promise<AgentOrderRow | null>;
  /** Open orders checked least recently, for the status notifier. */
  listOrdersToCheck(olderThanIso: string, limit: number): Promise<AgentOrderRow[]>;
  updateOrder(id: string, patch: Partial<Pick<AgentOrderRow, 'status' | 'notified_status' | 'closed' | 'last_checked_at'>>): Promise<void>;
}

export function createSupabaseAgentStore(db: SupabaseClient): AgentStore {
  return {
    async getConnection(consultantId) {
      const { data, error } = await db.from('store_connections').select('*').eq('consultant_id', consultantId).maybeSingle();
      if (error) throw dbError(error, 'loading the store connection');
      return (data as StoreConnectionRow | null) ?? null;
    },

    async getConnectionById(id) {
      const { data, error } = await db.from('store_connections').select('*').eq('id', id).maybeSingle();
      if (error) throw dbError(error, 'loading the store connection');
      return (data as StoreConnectionRow | null) ?? null;
    },

    async saveConnection(input) {
      const { data, error } = await db
        .from('store_connections')
        .upsert(input, { onConflict: 'consultant_id' })
        .select('*')
        .single();
      if (error) throw dbError(error, 'saving the store connection');
      return data as StoreConnectionRow;
    },

    async updateConnection(id, patch) {
      const { error } = await db.from('store_connections').update(patch).eq('id', id);
      if (error) throw dbError(error, 'updating the store connection');
    },

    async deleteConnection(consultantId) {
      const { error } = await db.from('store_connections').delete().eq('consultant_id', consultantId);
      if (error) throw dbError(error, 'removing the store connection');
    },

    async insertAction(input) {
      const { data, error } = await db
        .from('agent_actions')
        .insert({
          consultant_id: input.consultantId,
          conversation_id: input.conversationId,
          kind: input.kind,
          status: input.status,
          summary: input.summary.slice(0, 4000),
          params: input.params,
          amount: input.amount ?? null,
          currency: input.currency ?? null,
          external_ref: input.externalRef ?? null,
          confirm_code: input.confirmCode ?? null,
        })
        .select('*')
        .single();
      if (error) throw dbError(error, 'saving an agent action');
      return data as AgentActionRow;
    },

    async getAction(id) {
      const { data, error } = await db.from('agent_actions').select('*').eq('id', id).maybeSingle();
      if (error) throw dbError(error, 'loading an agent action');
      return (data as AgentActionRow | null) ?? null;
    },

    async findActionByCode(conversationId, code) {
      const { data, error } = await db
        .from('agent_actions')
        .select('*')
        .eq('conversation_id', conversationId)
        .eq('confirm_code', code)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw dbError(error, 'loading an agent action');
      return (data as AgentActionRow | null) ?? null;
    },

    async transitionAction(id, from, patch) {
      const { data, error } = await db.from('agent_actions').update(patch).eq('id', id).eq('status', from).select('*').maybeSingle();
      if (error) throw dbError(error, 'updating an agent action');
      return (data as AgentActionRow | null) ?? null;
    },

    async listActions(consultantId, limit) {
      const { data, error } = await db
        .from('agent_actions')
        .select('*')
        .eq('consultant_id', consultantId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw dbError(error, 'loading agent actions');
      return (data ?? []) as AgentActionRow[];
    },

    async linkOrder(input) {
      const { error } = await db.from('agent_orders').upsert(
        {
          consultant_id: input.consultantId,
          conversation_id: input.conversationId,
          external_id: input.externalId,
          number: input.number,
          status: input.status,
          notified_status: input.status,
          last_checked_at: new Date().toISOString(),
        },
        { onConflict: 'consultant_id,external_id', ignoreDuplicates: true },
      );
      if (error) throw dbError(error, 'following an order');
    },

    async findLinkedOrder(consultantId, conversationId, externalId) {
      const { data, error } = await db
        .from('agent_orders')
        .select('*')
        .eq('consultant_id', consultantId)
        .eq('conversation_id', conversationId)
        .eq('external_id', externalId)
        .maybeSingle();
      if (error) throw dbError(error, 'loading an order');
      return (data as AgentOrderRow | null) ?? null;
    },

    async findOrder(consultantId, ref) {
      const { data, error } = await db
        .from('agent_orders')
        .select('*')
        .eq('consultant_id', consultantId)
        .or(`external_id.eq."${ref.replace(/"/g, '')}",number.eq."${ref.replace(/"/g, '')}"`)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw dbError(error, 'loading an order');
      return (data as AgentOrderRow | null) ?? null;
    },

    async listOrdersToCheck(olderThanIso, limit) {
      const { data, error } = await db
        .from('agent_orders')
        .select('*')
        .eq('closed', false)
        .or(`last_checked_at.is.null,last_checked_at.lt.${olderThanIso}`)
        .order('last_checked_at', { ascending: true, nullsFirst: true })
        .limit(limit);
      if (error) throw dbError(error, 'loading orders to check');
      return (data ?? []) as AgentOrderRow[];
    },

    async updateOrder(id, patch) {
      const { error } = await db.from('agent_orders').update(patch).eq('id', id);
      if (error) throw dbError(error, 'updating an order');
    },
  };
}
