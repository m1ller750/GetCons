import type {
  Channel,
  ConsultantRow,
  ConversationRow,
  DocumentRow,
  EventLevel,
  ExampleMatch,
  ExampleRow,
  KnowledgeMatch,
  MessageMeta,
  MessageRole,
  MessageRow,
  MessageStatus,
  SecretsRow,
} from './types.js';

export interface UpsertConversationInput {
  consultantId: string;
  channel: Channel;
  externalChatId: number;
  /** WhatsApp chat JID */
  externalJid?: string | null;
  customerName?: string | null;
  customerUsername?: string | null;
  customerLanguage?: string | null;
}

export interface InsertMessageInput {
  conversationId: string;
  consultantId: string;
  role: MessageRole;
  content: string;
  status?: MessageStatus;
  telegramMessageId?: number | null;
  telegramUpdateId?: number | null;
  /** WhatsApp message id (unique per consultant, like telegramUpdateId) */
  externalMessageId?: string | null;
  meta?: MessageMeta;
}

export interface ChunkInput {
  index: number;
  content: string;
  embedding: number[] | null;
}

/**
 * Data access used by the bot runtime and background jobs. Runs with the service role,
 * so every method is explicitly scoped by consultant/conversation id.
 */
export interface Store {
  getConsultant(id: string): Promise<ConsultantRow | null>;
  getSecrets(consultantId: string): Promise<SecretsRow | null>;
  listTelegramConsultants(): Promise<ConsultantRow[]>;
  /** Consultants whose WhatsApp work number is linked (reconnected on boot). */
  listWhatsAppConsultants(): Promise<ConsultantRow[]>;
  updateConsultant(id: string, patch: Partial<ConsultantRow>): Promise<void>;

  /** Encrypted WhatsApp linked-device session: key -> ciphertext. */
  loadWhatsAppAuth(consultantId: string): Promise<Record<string, string>>;
  /** Upserts the given keys; a null value deletes the key. */
  saveWhatsAppAuth(consultantId: string, entries: Record<string, string | null>): Promise<void>;
  clearWhatsAppAuth(consultantId: string): Promise<void>;

  upsertConversation(input: UpsertConversationInput): Promise<ConversationRow>;
  getConversation(id: string): Promise<ConversationRow | null>;
  updateConversation(id: string, patch: Partial<ConversationRow>): Promise<void>;

  /** Returns null when the Telegram update / WhatsApp message was already stored (idempotency). */
  insertMessage(input: InsertMessageInput): Promise<MessageRow | null>;
  updateMessage(id: string, patch: Partial<Pick<MessageRow, 'content' | 'status' | 'meta'>>): Promise<void>;
  /** Most recent messages, returned in chronological order. */
  getRecentMessages(conversationId: string, opts: { since?: string | null; limit: number }): Promise<MessageRow[]>;
  countAssistantRepliesSince(consultantId: string, sinceIso: string): Promise<number>;

  searchKnowledge(consultantId: string, embedding: number[] | null, query: string, k: number): Promise<KnowledgeMatch[]>;
  searchExamples(consultantId: string, embedding: number[], k: number): Promise<ExampleMatch[]>;
  getPinnedExamples(consultantId: string, limit: number): Promise<ExampleRow[]>;

  getDocument(id: string): Promise<DocumentRow | null>;
  updateDocument(id: string, patch: Partial<DocumentRow>): Promise<void>;
  replaceChunks(documentId: string, consultantId: string, chunks: ChunkInput[]): Promise<void>;
  listDocumentIdsByStatus(status: DocumentRow['status'], limit: number): Promise<string[]>;
  listExamplesMissingEmbedding(limit: number): Promise<Pick<ExampleRow, 'id' | 'customer_message'>[]>;
  setExampleEmbedding(id: string, embedding: number[]): Promise<void>;

  logEvent(
    consultantId: string,
    type: string,
    message: string,
    options?: { level?: EventLevel; meta?: Record<string, unknown> },
  ): Promise<void>;
}
