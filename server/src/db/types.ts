/** Row shapes mirroring supabase/migrations/*_init.sql. */

export type ConsultantStatus = 'draft' | 'active' | 'paused' | 'error';
export type WhatsAppStatus = 'disconnected' | 'pairing' | 'connected' | 'logged_out' | 'error';
export type Strictness = 'strict' | 'balanced';
export type Tone = 'friendly' | 'professional' | 'formal' | 'playful' | 'concise';

export interface BusinessInfo {
  businessName?: string;
  description?: string;
  products?: string;
  pricing?: string;
  hours?: string;
  location?: string;
  contacts?: string;
  delivery?: string;
  policies?: string;
  website?: string;
  extra?: string;
}

export interface ConsultantRow {
  id: string;
  user_id: string;
  name: string;
  status: ConsultantStatus;
  template: string;
  instructions: string;
  tone: string;
  language: string;
  use_emojis: boolean;
  strictness: Strictness;
  business_info: BusinessInfo;
  greeting_message: string;
  fallback_message: string;
  temperature: number;
  max_history_messages: number;
  handoff_enabled: boolean;
  telegram_bot_id: number | null;
  telegram_bot_username: string | null;
  telegram_bot_name: string | null;
  telegram_connected_at: string | null;
  owner_chat_id: number | null;
  owner_link_code: string | null;
  whatsapp_status: WhatsAppStatus;
  whatsapp_phone: string | null;
  whatsapp_name: string | null;
  whatsapp_connected_at: string | null;
  owner_whatsapp_jid: string | null;
  /** Website channel: chat widget and shareable chat link. */
  web_enabled: boolean;
  web_key: string | null;
  /** Pro plan agent settings (see core/agent/settings.ts). */
  agent: Record<string, unknown>;
  last_error: string | null;
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SecretsRow {
  consultant_id: string;
  bot_token_ciphertext: string | null;
  webhook_secret: string | null;
  updated_at: string;
}

export type DocumentStatus = 'processing' | 'ready' | 'error';

export interface DocumentRow {
  id: string;
  consultant_id: string;
  user_id: string;
  title: string;
  source_type: 'file' | 'text' | 'faq';
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  content: string;
  status: DocumentStatus;
  error: string | null;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

export interface ExampleRow {
  id: string;
  consultant_id: string;
  user_id: string;
  customer_message: string;
  ideal_reply: string;
  notes: string | null;
  is_pinned: boolean;
  source: 'manual' | 'import' | 'conversation' | 'gap';
  created_at: string;
  updated_at: string;
}

export type Channel = 'telegram' | 'whatsapp' | 'web' | 'playground';

export interface ConversationRow {
  id: string;
  consultant_id: string;
  user_id: string;
  channel: Channel;
  external_chat_id: number;
  /** WhatsApp chat JID, or "web:<visitor hash>" on the website (null for Telegram) */
  external_jid: string | null;
  customer_name: string | null;
  customer_username: string | null;
  customer_language: string | null;
  summary: string | null;
  summarized_until: string | null;
  memory_reset_at: string | null;
  ai_enabled: boolean;
  needs_attention: boolean;
  attention_reason: string | null;
  message_count: number;
  last_message_at: string | null;
  last_message_preview: string | null;
  created_at: string;
  updated_at: string;
}

export type MessageRole = 'customer' | 'assistant' | 'operator' | 'system';
export type MessageStatus = 'ok' | 'fallback' | 'handoff' | 'error' | 'failed' | 'skipped';

export interface MediaRef {
  kind: 'photo' | 'voice' | 'audio' | 'video_note' | 'document';
  /** Telegram file_id, or the WhatsApp message id the media came with */
  file_id: string;
  mime_type: string;
  file_size?: number;
  duration?: number;
}

export interface MessageMeta {
  media?: MediaRef;
  command?: string;
  kind?: 'greeting' | 'reset' | 'limit' | 'unsupported' | 'rate_limited' | 'notification';
  latency_ms?: number;
  model?: string;
  answer_status?: string;
  confidence?: number;
  usage?: { promptTokens?: number; outputTokens?: number; totalTokens?: number };
  knowledge?: { id: string; document_id: string; title: string; similarity: number }[];
  examples?: string[];
  question?: string;
  error?: string;
  author?: string;
  parts?: number;
  [key: string]: unknown;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  consultant_id: string;
  user_id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  telegram_message_id: number | null;
  telegram_update_id: number | null;
  /** WhatsApp message id */
  external_message_id: string | null;
  meta: MessageMeta;
  created_at: string;
}

export interface KnowledgeMatch {
  id: string;
  document_id: string;
  document_title: string;
  content: string;
  similarity: number;
  keyword_rank: number;
  score: number;
}

export interface ExampleMatch {
  id: string;
  customer_message: string;
  ideal_reply: string;
  notes: string | null;
  is_pinned: boolean;
  similarity: number;
}

export type EventLevel = 'info' | 'warning' | 'error';
