import type { SupabaseClient } from '../lib/supabase.js';
import { dbError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { ChunkInput, InsertMessageInput, Store, UpsertConversationInput } from './store.js';
import type {
  ConsultantRow,
  ConversationRow,
  DocumentRow,
  ExampleMatch,
  ExampleRow,
  KnowledgeMatch,
  MessageRow,
  SecretsRow,
} from './types.js';

const UNIQUE_VIOLATION = '23505';
const CHUNK_INSERT_BATCH = 100;

/** pgvector accepts the "[1,2,3]" text form for vector parameters. */
export const toVector = (v: number[]) => `[${v.join(',')}]`;

export function createSupabaseStore(admin: SupabaseClient, logger: Logger): Store {
  return {
    async getConsultant(id) {
      const { data, error } = await admin.from('consultants').select('*').eq('id', id).maybeSingle();
      if (error) throw dbError(error, 'loading consultant');
      return (data as ConsultantRow | null) ?? null;
    },

    async getSecrets(consultantId) {
      const { data, error } = await admin
        .from('consultant_secrets')
        .select('*')
        .eq('consultant_id', consultantId)
        .maybeSingle();
      if (error) throw dbError(error, 'loading secrets');
      return (data as SecretsRow | null) ?? null;
    },

    async listTelegramConsultants() {
      const { data, error } = await admin
        .from('consultants')
        .select('*')
        .not('telegram_bot_id', 'is', null)
        .in('status', ['active', 'paused']);
      if (error) throw dbError(error, 'listing connected consultants');
      return (data ?? []) as ConsultantRow[];
    },

    async listWhatsAppConsultants() {
      const { data, error } = await admin.from('consultants').select('*').eq('whatsapp_status', 'connected');
      if (error) throw dbError(error, 'listing WhatsApp consultants');
      return (data ?? []) as ConsultantRow[];
    },

    async updateConsultant(id, patch) {
      const { error } = await admin.from('consultants').update(patch).eq('id', id);
      if (error) throw dbError(error, 'updating consultant');
    },

    async loadWhatsAppAuth(consultantId) {
      const { data, error } = await admin
        .from('whatsapp_auth')
        .select('key, value_ciphertext')
        .eq('consultant_id', consultantId);
      if (error) throw dbError(error, 'loading WhatsApp session');
      return Object.fromEntries(
        ((data ?? []) as { key: string; value_ciphertext: string }[]).map((r) => [r.key, r.value_ciphertext]),
      );
    },

    async saveWhatsAppAuth(consultantId, entries) {
      const upserts = Object.entries(entries)
        .filter((e): e is [string, string] => e[1] !== null)
        .map(([key, value]) => ({ consultant_id: consultantId, key, value_ciphertext: value }));
      const deletes = Object.keys(entries).filter((k) => entries[k] === null);
      for (let i = 0; i < upserts.length; i += CHUNK_INSERT_BATCH) {
        const { error } = await admin.from('whatsapp_auth').upsert(upserts.slice(i, i + CHUNK_INSERT_BATCH));
        if (error) throw dbError(error, 'saving WhatsApp session');
      }
      for (let i = 0; i < deletes.length; i += CHUNK_INSERT_BATCH) {
        const { error } = await admin
          .from('whatsapp_auth')
          .delete()
          .eq('consultant_id', consultantId)
          .in('key', deletes.slice(i, i + CHUNK_INSERT_BATCH));
        if (error) throw dbError(error, 'deleting WhatsApp session keys');
      }
    },

    async clearWhatsAppAuth(consultantId) {
      const { error } = await admin.from('whatsapp_auth').delete().eq('consultant_id', consultantId);
      if (error) throw dbError(error, 'clearing WhatsApp session');
    },

    async upsertConversation(input: UpsertConversationInput) {
      const profile: Record<string, unknown> = {};
      if (input.externalJid !== undefined) profile.external_jid = input.externalJid;
      if (input.customerName !== undefined) profile.customer_name = input.customerName;
      if (input.customerUsername !== undefined) profile.customer_username = input.customerUsername;
      if (input.customerLanguage !== undefined) profile.customer_language = input.customerLanguage;

      const { data, error } = await admin
        .from('conversations')
        .upsert(
          {
            consultant_id: input.consultantId,
            channel: input.channel,
            external_chat_id: input.externalChatId,
            ...profile,
          },
          { onConflict: 'consultant_id,channel,external_chat_id' },
        )
        .select('*')
        .single();
      if (error) throw dbError(error, 'saving conversation');
      return data as ConversationRow;
    },

    async getConversation(id) {
      const { data, error } = await admin.from('conversations').select('*').eq('id', id).maybeSingle();
      if (error) throw dbError(error, 'loading conversation');
      return (data as ConversationRow | null) ?? null;
    },

    async updateConversation(id, patch) {
      const { error } = await admin.from('conversations').update(patch).eq('id', id);
      if (error) throw dbError(error, 'updating conversation');
    },

    async insertMessage(input: InsertMessageInput) {
      const { data, error } = await admin
        .from('messages')
        .insert({
          conversation_id: input.conversationId,
          consultant_id: input.consultantId,
          role: input.role,
          content: input.content,
          status: input.status ?? 'ok',
          telegram_message_id: input.telegramMessageId ?? null,
          telegram_update_id: input.telegramUpdateId ?? null,
          external_message_id: input.externalMessageId ?? null,
          meta: input.meta ?? {},
        })
        .select('*')
        .single();
      if (error) {
        if (error.code === UNIQUE_VIOLATION) return null;
        throw dbError(error, 'saving message');
      }
      return data as MessageRow;
    },

    async updateMessage(id, patch) {
      const { error } = await admin.from('messages').update(patch).eq('id', id);
      if (error) throw dbError(error, 'updating message');
    },

    async getRecentMessages(conversationId, { since, limit }) {
      let query = admin
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (since) query = query.gt('created_at', since);
      const { data, error } = await query;
      if (error) throw dbError(error, 'loading history');
      return ((data ?? []) as MessageRow[]).reverse();
    },

    async countAssistantRepliesSince(consultantId, sinceIso) {
      const { count, error } = await admin
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('consultant_id', consultantId)
        .eq('role', 'assistant')
        .gte('created_at', sinceIso);
      if (error) throw dbError(error, 'counting replies');
      return count ?? 0;
    },

    async searchKnowledge(consultantId, embedding, query, k) {
      const { data, error } = await admin.rpc('match_knowledge_chunks', {
        p_consultant_id: consultantId,
        p_embedding: embedding ? toVector(embedding) : null,
        p_query: query,
        p_match_count: k,
      });
      if (error) throw dbError(error, 'searching knowledge');
      return (data ?? []) as KnowledgeMatch[];
    },

    async searchExamples(consultantId, embedding, k) {
      const { data, error } = await admin.rpc('match_training_examples', {
        p_consultant_id: consultantId,
        p_embedding: toVector(embedding),
        p_match_count: k,
      });
      if (error) throw dbError(error, 'searching examples');
      return (data ?? []) as ExampleMatch[];
    },

    async getPinnedExamples(consultantId, limit) {
      if (limit <= 0) return [];
      const { data, error } = await admin
        .from('training_examples')
        .select('id, consultant_id, user_id, customer_message, ideal_reply, notes, is_pinned, source, created_at, updated_at')
        .eq('consultant_id', consultantId)
        .eq('is_pinned', true)
        .order('updated_at', { ascending: false })
        .limit(limit);
      if (error) throw dbError(error, 'loading pinned examples');
      return (data ?? []) as ExampleRow[];
    },

    async getDocument(id) {
      const { data, error } = await admin.from('knowledge_documents').select('*').eq('id', id).maybeSingle();
      if (error) throw dbError(error, 'loading document');
      return (data as DocumentRow | null) ?? null;
    },

    async updateDocument(id, patch) {
      const { error } = await admin.from('knowledge_documents').update(patch).eq('id', id);
      if (error) throw dbError(error, 'updating document');
    },

    async replaceChunks(documentId, consultantId, chunks: ChunkInput[]) {
      const del = await admin.from('knowledge_chunks').delete().eq('document_id', documentId);
      if (del.error) throw dbError(del.error, 'deleting old chunks');
      for (let i = 0; i < chunks.length; i += CHUNK_INSERT_BATCH) {
        const rows = chunks.slice(i, i + CHUNK_INSERT_BATCH).map((c) => ({
          document_id: documentId,
          consultant_id: consultantId,
          chunk_index: c.index,
          content: c.content,
          embedding: c.embedding ? toVector(c.embedding) : null,
        }));
        const { error } = await admin.from('knowledge_chunks').insert(rows);
        if (error) throw dbError(error, 'saving chunks');
      }
    },

    async listDocumentIdsByStatus(status, limit) {
      const { data, error } = await admin
        .from('knowledge_documents')
        .select('id')
        .eq('status', status)
        .order('created_at', { ascending: true })
        .limit(limit);
      if (error) throw dbError(error, 'listing documents');
      return (data ?? []).map((d: { id: string }) => d.id);
    },

    async listExamplesMissingEmbedding(limit) {
      const { data, error } = await admin
        .from('training_examples')
        .select('id, customer_message')
        .is('embedding', null)
        .limit(limit);
      if (error) throw dbError(error, 'listing examples');
      return (data ?? []) as Pick<ExampleRow, 'id' | 'customer_message'>[];
    },

    async setExampleEmbedding(id, embedding) {
      const { error } = await admin.from('training_examples').update({ embedding: toVector(embedding) }).eq('id', id);
      if (error) throw dbError(error, 'saving example embedding');
    },

    async logEvent(consultantId, type, message, options = {}) {
      const { error } = await admin.from('activity_events').insert({
        consultant_id: consultantId,
        type,
        message: message.slice(0, 1000),
        level: options.level ?? 'info',
        meta: options.meta ?? {},
      });
      // Logging must never break the main flow.
      if (error) logger.warn({ err: error, type }, 'Failed to write activity event');
    },
  };
}
