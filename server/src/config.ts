import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parseEncryptionKey } from './lib/crypto.js';

/** Must match the vector(768) columns in supabase/migrations. */
export const EMBEDDING_DIMENSIONS = 768;

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  port: number;
  publicUrl: string | null;
  corsOrigins: string[];
  logLevel: string;
  supabase: {
    url: string;
    anonKey: string;
    serviceRoleKey: string;
  };
  gemini: {
    apiKey: string;
    model: string;
    fallbackModel: string | null;
    embeddingModel: string;
    embeddingDimensions: number;
    thinkingLevel: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' | null;
    timeoutMs: number;
    /** auto = by the key: Google Cloud keys ("AQ.") go to Vertex AI, AI Studio keys to the Gemini API. */
    backend: 'auto' | 'gemini-api' | 'vertex';
  };
  /** Backup model (Grok or any OpenAI-compatible API), used when Gemini fails. */
  grok: { apiKey: string; baseUrl: string; model: string; timeoutMs: number } | null;
  encryptionKey: Buffer;
  telegram: {
    mode: 'webhook' | 'polling';
    apiBaseUrl: string;
    /** Platform "manager" bot that creates customers' bots in one click (Managed Bots). */
    managerBotToken: string | null;
  };
  whatsapp: {
    /** Linking WhatsApp work numbers (linked devices). */
    enabled: boolean;
  };
  billing: {
    /** Card payments through Freedom Pay's hosted page; null until the merchant keys are set. */
    freedomPay: { merchantId: string; secretKey: string; apiUrl: string; testing: boolean } | null;
  };
  /** Global ceilings; plans (core/plans.ts) set the per-account limits below them. */
  limits: {
    maxConsultantsPerUser: number;
    maxUploadBytes: number;
    maxDocumentsPerConsultant: number;
    maxExamplesPerConsultant: number;
    dailyReplyLimit: number;
    messagesPerChatPerMinute: number;
  };
  rag: {
    topK: number;
    minSimilarity: number;
    fewShotK: number;
    maxPinnedExamples: number;
  };
}

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  PUBLIC_URL: optionalString.pipe(z.url().optional()),
  RAILWAY_PUBLIC_DOMAIN: optionalString,
  CORS_ORIGINS: optionalString,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  SUPABASE_URL: z.url({ error: 'SUPABASE_URL must be your project URL, e.g. https://xyz.supabase.co' }),
  SUPABASE_ANON_KEY: z.string({ error: 'SUPABASE_ANON_KEY (or SUPABASE_PUBLISHABLE_KEY) is required' }).min(20),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string({ error: 'SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) is required' })
    .min(20),

  GEMINI_API_KEY: z.string({ error: 'GEMINI_API_KEY is required' }).min(10),
  GEMINI_MODEL: z.string().default('gemini-3.1-flash-lite'),
  GEMINI_FALLBACK_MODEL: optionalString,
  GEMINI_EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),
  // LOW keeps replies around 3 s; the model's default thinking made chat replies take ~10 s.
  GEMINI_THINKING_LEVEL: optionalString.pipe(z.enum(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'DEFAULT']).optional()).transform((v) => v ?? 'LOW'),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(300_000).default(15_000),
  GEMINI_BACKEND: z.enum(['auto', 'gemini-api', 'vertex']).default('auto'),

  GROK_API_KEY: optionalString.pipe(z.string().min(10).optional()),
  GROK_BASE_URL: z.url().default('https://api.x.ai/v1'),
  GROK_MODEL: z.string().min(2).default('grok-4-fast-non-reasoning'),

  ENCRYPTION_KEY: z.string({ error: 'ENCRYPTION_KEY is required (32 random bytes, base64 or hex)' }),

  TELEGRAM_MODE: z.enum(['auto', 'webhook', 'polling']).default('auto'),
  TELEGRAM_API_BASE_URL: z.url().default('https://api.telegram.org'),
  MANAGER_BOT_TOKEN: optionalString.pipe(
    z
      .string()
      .regex(/^\d{5,15}:[A-Za-z0-9_-]{30,64}$/, { error: 'MANAGER_BOT_TOKEN must be a bot token from @BotFather' })
      .optional(),
  ),

  WHATSAPP_ENABLED: z
    .enum(['true', 'false', '1', '0'])
    .default('true')
    .transform((v) => v === 'true' || v === '1'),

  FREEDOMPAY_MERCHANT_ID: optionalString.pipe(z.string().regex(/^\d{1,12}$/, { error: 'FREEDOMPAY_MERCHANT_ID must be the numeric merchant id' }).optional()),
  FREEDOMPAY_SECRET_KEY: optionalString.pipe(z.string().min(8).optional()),
  FREEDOMPAY_API_URL: z.url().default('https://api.freedompay.kz'),
  FREEDOMPAY_TESTING: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  MAX_CONSULTANTS_PER_USER: z.coerce.number().int().min(1).default(10),
  MAX_UPLOAD_MB: z.coerce.number().min(1).max(50).default(10),
  MAX_DOCUMENTS_PER_CONSULTANT: z.coerce.number().int().min(1).default(200),
  MAX_EXAMPLES_PER_CONSULTANT: z.coerce.number().int().min(1).default(2000),
  DAILY_REPLY_LIMIT: z.coerce.number().int().min(1).default(2000),
  MESSAGES_PER_CHAT_PER_MINUTE: z.coerce.number().int().min(1).default(20),

  RAG_TOP_K: z.coerce.number().int().min(1).max(20).default(6),
  RAG_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.3),
  FEW_SHOT_K: z.coerce.number().int().min(0).max(12).default(4),
  MAX_PINNED_EXAMPLES: z.coerce.number().int().min(0).max(10).default(3),
});

/** Loads .env from the working directory or its parent (monorepo root) for local development. */
export function loadDotEnv(cwd = process.cwd()): void {
  for (const candidate of [path.join(cwd, '.env'), path.join(cwd, '..', '.env')]) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
  }
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export function loadConfig(input: NodeJS.ProcessEnv = process.env): AppConfig {
  // Values pasted into dashboards often carry an invisible byte-order mark or stray spaces.
  const rawEnv = Object.fromEntries(
    Object.entries(input).map(([k, v]) => [k, typeof v === 'string' ? v.replace(/^﻿/, '').trim() : v]),
  ) as NodeJS.ProcessEnv;
  // Accept Supabase's newer key names as aliases.
  const env = {
    ...rawEnv,
    SUPABASE_ANON_KEY: rawEnv.SUPABASE_ANON_KEY || rawEnv.SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_SERVICE_ROLE_KEY: rawEnv.SUPABASE_SERVICE_ROLE_KEY || rawEnv.SUPABASE_SECRET_KEY,
  };

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;

  let encryptionKey: Buffer;
  try {
    encryptionKey = parseEncryptionKey(e.ENCRYPTION_KEY);
  } catch (err) {
    throw new ConfigError([`ENCRYPTION_KEY: ${(err as Error).message}`]);
  }

  const publicUrl = (e.PUBLIC_URL ?? (e.RAILWAY_PUBLIC_DOMAIN ? `https://${e.RAILWAY_PUBLIC_DOMAIN}` : null))?.replace(
    /\/+$/,
    '',
  ) ?? null;

  let mode: 'webhook' | 'polling';
  if (e.TELEGRAM_MODE === 'auto') {
    mode = publicUrl?.startsWith('https://') ? 'webhook' : 'polling';
  } else {
    mode = e.TELEGRAM_MODE;
  }
  if (mode === 'webhook' && !publicUrl?.startsWith('https://')) {
    throw new ConfigError(['TELEGRAM_MODE=webhook requires an https PUBLIC_URL (or RAILWAY_PUBLIC_DOMAIN)']);
  }
  if (Boolean(e.FREEDOMPAY_MERCHANT_ID) !== Boolean(e.FREEDOMPAY_SECRET_KEY)) {
    throw new ConfigError(['FREEDOMPAY_MERCHANT_ID and FREEDOMPAY_SECRET_KEY must be set together']);
  }
  if (e.GROK_API_KEY && !e.GROK_BASE_URL.startsWith('https://')) throw new ConfigError(['GROK_BASE_URL must be https']);
  const apiUrl = new URL(e.FREEDOMPAY_API_URL);
  if (apiUrl.protocol !== 'https:') throw new ConfigError(['FREEDOMPAY_API_URL must be https']);

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    publicUrl,
    corsOrigins: (e.CORS_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    logLevel: e.LOG_LEVEL,
    supabase: {
      url: e.SUPABASE_URL.replace(/\/+$/, ''),
      anonKey: e.SUPABASE_ANON_KEY,
      serviceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
    },
    gemini: {
      apiKey: e.GEMINI_API_KEY,
      model: e.GEMINI_MODEL,
      fallbackModel: e.GEMINI_FALLBACK_MODEL ?? null,
      embeddingModel: e.GEMINI_EMBEDDING_MODEL,
      embeddingDimensions: EMBEDDING_DIMENSIONS,
      thinkingLevel: e.GEMINI_THINKING_LEVEL === 'DEFAULT' ? null : e.GEMINI_THINKING_LEVEL,
      timeoutMs: e.GEMINI_TIMEOUT_MS,
      backend: e.GEMINI_BACKEND,
    },
    grok: e.GROK_API_KEY
      ? {
          apiKey: e.GROK_API_KEY,
          baseUrl: e.GROK_BASE_URL.replace(/\/+$/, ''),
          model: e.GROK_MODEL,
          timeoutMs: Math.max(e.GEMINI_TIMEOUT_MS, 30_000),
        }
      : null,
    encryptionKey,
    telegram: {
      mode,
      apiBaseUrl: e.TELEGRAM_API_BASE_URL.replace(/\/+$/, ''),
      managerBotToken: e.MANAGER_BOT_TOKEN ?? null,
    },
    whatsapp: { enabled: e.WHATSAPP_ENABLED },
    billing: {
      freedomPay:
        e.FREEDOMPAY_MERCHANT_ID && e.FREEDOMPAY_SECRET_KEY
          ? {
              merchantId: e.FREEDOMPAY_MERCHANT_ID,
              secretKey: e.FREEDOMPAY_SECRET_KEY,
              apiUrl: apiUrl.origin,
              testing: e.FREEDOMPAY_TESTING,
            }
          : null,
    },
    limits: {
      maxConsultantsPerUser: e.MAX_CONSULTANTS_PER_USER,
      maxUploadBytes: Math.round(e.MAX_UPLOAD_MB * 1024 * 1024),
      maxDocumentsPerConsultant: e.MAX_DOCUMENTS_PER_CONSULTANT,
      maxExamplesPerConsultant: e.MAX_EXAMPLES_PER_CONSULTANT,
      dailyReplyLimit: e.DAILY_REPLY_LIMIT,
      messagesPerChatPerMinute: e.MESSAGES_PER_CHAT_PER_MINUTE,
    },
    rag: {
      topK: e.RAG_TOP_K,
      minSimilarity: e.RAG_MIN_SIMILARITY,
      fewShotK: e.FEW_SHOT_K,
      maxPinnedExamples: e.MAX_PINNED_EXAMPLES,
    },
  };
}
