export type ConsultantStatus = 'draft' | 'active' | 'paused' | 'error';
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

export interface Consultant {
  id: string;
  name: string;
  status: ConsultantStatus;
  template: string;
  instructions: string;
  tone: Tone;
  language: string;
  use_emojis: boolean;
  strictness: 'strict' | 'balanced';
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
  whatsapp_status: WhatsAppStatus;
  whatsapp_phone: string | null;
  whatsapp_name: string | null;
  whatsapp_connected_at: string | null;
  last_error: string | null;
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
  telegram: {
    connected: boolean;
    mode: 'webhook' | 'polling';
    botUsername: string | null;
    botName: string | null;
    connectedAt: string | null;
    ownerNotifications: boolean;
  };
  whatsapp: {
    enabled: boolean;
    connected: boolean;
    status: WhatsAppStatus;
    phone: string | null;
    name: string | null;
    connectedAt: string | null;
    ownerNotifications: boolean;
  };
  /** Website chat: the widget for the business's site and a shareable link. */
  web: { enabled: boolean; key: string | null; link: string | null; widgetSnippet: string | null };
  agent: AgentSettings;
}

export type Channel = 'whatsapp' | 'telegram' | 'web';

export interface AgentPermissions {
  catalog: boolean;
  orderStatus: boolean;
  createOrders: boolean;
  cancelOrders: boolean;
  returns: boolean;
  notify: boolean;
}

export interface AgentSettings {
  enabled: boolean;
  permissions: AgentPermissions;
  refundAutoLimit: number;
}

export type StorePlatform = 'shopify' | 'woocommerce' | 'custom';

export interface StoreConnection {
  id: string;
  platform: StorePlatform;
  storeUrl: string;
  storeName: string | null;
  currency: string | null;
  status: 'connected' | 'error';
  lastError: string | null;
  connectedAt: string;
}

export interface AgentOverview {
  available: boolean;
  settings: AgentSettings;
  connection: StoreConnection | null;
  notifyUrl: string | null;
}

export type AgentActionStatus = 'awaiting_customer' | 'awaiting_owner' | 'done' | 'failed' | 'rejected' | 'expired' | 'simulated';

export interface AgentAction {
  id: string;
  kind: 'create_order' | 'cancel_order' | 'refund' | 'notify';
  status: AgentActionStatus;
  summary: string;
  amount: number | null;
  currency: string | null;
  externalRef: string | null;
  error: string | null;
  conversationId: string | null;
  customerName: string | null;
  channel: 'telegram' | 'whatsapp' | 'web' | 'playground' | null;
  createdAt: string;
  executedAt: string | null;
}
export type WhatsAppStatus = 'disconnected' | 'pairing' | 'connected' | 'logged_out' | 'error';

/** Live linking state of a WhatsApp work number. */
export interface WhatsAppView {
  enabled: boolean;
  status: WhatsAppStatus | 'connecting';
  method: 'qr' | 'code' | null;
  qr: string | null;
  pairingCode: string | null;
  phone: string | null;
  name: string | null;
  connectedAt: string | null;
  error: string | null;
}

export interface ConsultantDetails {
  consultant: Consultant;
  counts: { documents: number; examples: number; conversations: number };
}

export interface Template {
  id: string;
  label: string;
  tone: Tone;
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  source_type: 'file' | 'text' | 'faq';
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  status: 'processing' | 'ready' | 'error';
  error: string | null;
  chunk_count: number;
  content?: string;
  created_at: string;
  updated_at: string;
}

export interface SearchResult {
  id: string;
  document_id: string;
  document_title: string;
  content: string;
  similarity: number;
  keyword_rank: number;
  score: number;
}

export interface TrainingExample {
  id: string;
  customer_message: string;
  ideal_reply: string;
  notes: string | null;
  is_pinned: boolean;
  source: 'manual' | 'import' | 'conversation' | 'gap';
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  channel: 'telegram' | 'whatsapp' | 'web' | 'playground';
  external_chat_id: number;
  external_jid: string | null;
  customer_name: string | null;
  customer_username: string | null;
  customer_language: string | null;
  summary: string | null;
  ai_enabled: boolean;
  needs_attention: boolean;
  attention_reason: string | null;
  message_count: number;
  last_message_at: string | null;
  last_message_preview: string | null;
  memory_reset_at: string | null;
  created_at: string;
}

export interface MessageMeta {
  media?: { kind: string };
  command?: string;
  kind?: string;
  latency_ms?: number;
  model?: string;
  answer_status?: string;
  confidence?: number;
  knowledge?: { id: string; document_id: string; title: string; similarity: number; cited?: boolean }[];
  examples?: string[];
  question?: string;
  error?: string;
  author?: string;
  attention_reason?: string;
  send_error?: string;
  retrieval_error?: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'customer' | 'assistant' | 'operator' | 'system';
  content: string;
  status: 'ok' | 'fallback' | 'handoff' | 'error' | 'failed' | 'skipped';
  meta: MessageMeta;
  created_at: string;
}

export interface Analytics {
  periodDays: number;
  kpis: {
    conversations: number;
    activeConversations: number;
    customerMessages: number;
    aiReplies: number;
    fallbacks: number;
    handoffs: number;
    errors: number;
    operatorReplies: number;
    needsAttention: number;
    avgLatencyMs: number | null;
    automationRate: number | null;
  };
  daily: { day: string; customerMessages: number; aiReplies: number; fallbacks: number; operatorReplies: number; conversations: number }[];
  knowledge: { documents: number; ready: number; chunks: number; examples: number };
}

export interface Gap {
  id: string;
  conversationId: string;
  question: string;
  reply: string;
  status: string;
  reason: string | null;
  createdAt: string;
}

export interface ActivityEvent {
  id: string;
  type: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  created_at: string;
}

export interface TelegramStatus {
  connected: boolean;
  mode: 'webhook' | 'polling';
  bot?: { id: number; username: string | null; name: string | null };
  webhook?: { ok: boolean; pendingUpdates: number; lastErrorMessage: string | null; lastErrorAt: string | null } | null;
  problem?: string | null;
}

export interface TranscriptPreview {
  speakers: string[];
  businessSpeaker: string | null;
  turns: number;
  pairs: { customer_message: string; ideal_reply: string }[];
  totalPairs: number;
}

export type PlanId = 'free' | 'start' | 'business' | 'pro';

export interface Plan {
  id: PlanId;
  priceUsd: number;
  maxConsultants: number;
  monthlyReplies: number;
  maxDocumentsPerConsultant: number;
  maxExamplesPerConsultant: number;
  dailyUploads: number;
  chatImport: boolean;
  ownerAlerts: boolean;
  analyticsDays: number;
  poweredBy: boolean;
  /** The AI agent: works in the connected store (orders, returns) and sends order updates. */
  agent: boolean;
}

export interface BillingOverview {
  plan: PlanId;
  periodEnd: string | null;
  usage: { replies: number; repliesLimit: number; since: string };
  checkoutEnabled: boolean;
  currency: string;
  periodDays: number;
  plans: Plan[];
  payments: { id: string; plan: PlanId; amount: number | string; currency: string; status: 'pending' | 'paid' | 'failed'; created_at: string; paid_at: string | null }[];
}

export interface Me {
  user: { id: string; email: string | null };
  plan?: Plan;
  limits: { maxConsultantsPerUser: number; maxUploadBytes: number; dailyReplyLimit: number };
  telegramMode: 'webhook' | 'polling';
  models: { chat: string; embeddings: string };
  managerBot: { enabled: boolean; username: string | null; problem: string | null };
  whatsapp?: { enabled: boolean };
}

/** One-click bot creation through Telegram Managed Bots. */
export interface BotRequest {
  id: string;
  status: 'pending' | 'completed' | 'failed' | 'expired';
  suggestedUsername: string;
  suggestedName: string;
  botUsername: string | null;
  error: string | null;
  expiresAt: string;
  createdAt: string;
  link: string | null;
  fallbackLink: string | null;
}
