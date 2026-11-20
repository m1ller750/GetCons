import type { AppConfig } from '../config.js';
import type { StoreConnector, StoreCredentials, StorePlatform } from '../core/agent/connectors.js';
import type { AgentService } from '../core/agent/service.js';
import type { AgentStore } from '../db/agentStore.js';
import type { Billing } from '../core/billing.js';
import type { KnowledgeIndexer } from '../core/knowledge.js';
import type { ManagerBot } from '../core/manager.js';
import type { ConsultantRuntime } from '../core/runtime.js';
import type { TelegramTransport } from '../core/transport.js';
import type { WhatsAppManager } from '../core/whatsapp.js';
import type { Store } from '../db/store.js';
import type { ConsultantRow } from '../db/types.js';
import { unauthorized } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { AuthUser, AuthVerifier, SupabaseClient } from '../lib/supabase.js';
import type { Llm } from '../services/llm.js';
import type { TelegramClientFactory } from '../services/telegram/client.js';

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  /** Service-role data access for the bot runtime. */
  store: Store;
  /** Service-role client: writes, after ownership has been verified. */
  admin: SupabaseClient;
  /** RLS-enforced client acting as the signed-in user: all dashboard reads. */
  userClient: (accessToken: string) => SupabaseClient;
  auth: AuthVerifier;
  llm: Llm;
  telegram: TelegramClientFactory;
  runtime: ConsultantRuntime;
  transport: TelegramTransport;
  indexer: KnowledgeIndexer;
  /** Platform bot that creates customers' bots in one click (optional). */
  manager?: ManagerBot | null;
  /** Linked WhatsApp work numbers (optional). */
  whatsapp?: WhatsAppManager | null;
  /** Plans, AI reply quota and card checkout. */
  billing?: Pick<Billing, 'plan' | 'check' | 'overview' | 'createCheckout' | 'handleFreedomPayResult' | 'checkoutEnabled'> | null;
  webDistPath?: string | null;
  /** Pro plan agent (store actions, approvals, order updates). */
  agent?: AgentService | null;
  agentStore?: AgentStore | null;
  /** Store clients for connection checks (replaced in tests). */
  agentConnector?: (platform: StorePlatform, storeUrl: string, creds: StoreCredentials) => StoreConnector;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      db?: SupabaseClient;
      consultant?: ConsultantRow;
    }
  }
}

export interface AuthedContext {
  user: AuthUser;
  db: SupabaseClient;
}

export function authed(req: Express.Request): AuthedContext {
  if (!req.user || !req.db) throw unauthorized();
  return { user: req.user, db: req.db };
}

export function owned(req: Express.Request): AuthedContext & { consultant: ConsultantRow } {
  const base = authed(req);
  if (!req.consultant) throw unauthorized();
  return { ...base, consultant: req.consultant };
}
