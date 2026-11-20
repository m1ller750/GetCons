import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig, loadDotEnv } from './config.js';
import { Billing } from './core/billing.js';
import { KnowledgeIndexer } from './core/knowledge.js';
import { ConsultantRuntime } from './core/runtime.js';
import { PollingTransport, WebhookTransport, type TelegramTransport } from './core/transport.js';
import { WhatsAppManager } from './core/whatsapp.js';
import { createSupabaseStore } from './db/supabaseStore.js';
import { AgentService } from './core/agent/service.js';
import { OrderNotifier } from './core/agent/notifier.js';
import { createSupabaseAgentStore } from './db/agentStore.js';
import { ManagerBot } from './core/manager.js';
import { createSupabaseManagerStore } from './db/managerStore.js';
import { createApp } from './http/app.js';
import type { AppDeps } from './http/deps.js';
import { connectTelegram } from './http/routes/consultants.js';
import { errorMessage } from './lib/errors.js';
import { createLogger } from './lib/logger.js';
import { createAdminClient, createSupabaseAuthVerifier, createUserClient } from './lib/supabase.js';
import { createLlm } from './services/llm.js';
import { createTelegramClient } from './services/telegram/client.js';

async function main() {
  loadDotEnv();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n${err.message}\n\nCopy .env.example to .env and fill in the values (see README.md).\n`);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config.logLevel, config.env === 'development');
  const admin = createAdminClient(config);
  const store = createSupabaseStore(admin, logger);
  // Gemini, with the backup model (Grok) answering if Gemini fails.
  const llm = createLlm(config, logger);
  const telegram = (token: string) => createTelegramClient(token, { baseUrl: config.telegram.apiBaseUrl });
  // WhatsApp work numbers linked as devices; customer messages go to the same consultant runtime.
  const whatsapp = new WhatsAppManager({ config, store, logger, onChange: (id) => runtime.invalidate(id) });
  // Plans, monthly AI replies and card checkout (Freedom Pay).
  const billing = new Billing({ admin, config, logger });
  // Pro plan agent: works in the connected store and tells customers about their orders.
  const agentStore = createSupabaseAgentStore(admin);
  const agent = new AgentService({ agentStore, config, logger });
  const runtime = new ConsultantRuntime({ store, llm, config, logger, telegram, whatsapp, quota: billing, agent });
  const notifier = new OrderNotifier({ agent, store, runtime, quota: billing, logger });
  whatsapp.onMessage((consultantId, msg) => runtime.handleWhatsApp(consultantId, msg));
  const indexer = new KnowledgeIndexer({ store, llm, config, logger });
  const transport: TelegramTransport =
    config.telegram.mode === 'webhook'
      ? new WebhookTransport(config, store, runtime, logger)
      : new PollingTransport(store, runtime, logger);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDistPath = process.env.WEB_DIST_PATH ?? path.resolve(here, '../../web/dist');

  const deps: AppDeps = {
    config,
    logger,
    store,
    admin,
    userClient: (token) => createUserClient(config, token),
    auth: createSupabaseAuthVerifier(admin),
    llm,
    telegram,
    runtime,
    transport,
    indexer,
    whatsapp,
    billing,
    webDistPath,
    agent,
    agentStore,
  };
  // One-click bot creation through the platform's manager bot (Telegram Managed Bots).
  const manager = new ManagerBot({
    config,
    logger,
    store: createSupabaseManagerStore(admin),
    telegram,
    connect: async (consultantId, token) => {
      const consultant = await store.getConsultant(consultantId);
      if (!consultant) throw new Error('Consultant no longer exists');
      return connectTelegram(deps, consultant, token);
    },
    logEvent: (consultantId, type, message, level) => store.logEvent(consultantId, type, message, { level }),
  });
  deps.manager = manager;
  const app = createApp(deps);

  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, telegramMode: config.telegram.mode, publicUrl: config.publicUrl, model: config.gemini.model },
      'GetCons server started',
    );
  });

  // Background start-up work must not block the HTTP server (Railway health checks).
  void (async () => {
    try {
      await transport.start();
    } catch (err) {
      logger.error({ err: errorMessage(err) }, 'Telegram transport start failed');
    }
    await manager.start();
    try {
      await whatsapp.start();
    } catch (err) {
      logger.error({ err: errorMessage(err) }, 'WhatsApp start failed');
    }
    try {
      await indexer.recover();
    } catch (err) {
      logger.error({ err: errorMessage(err) }, 'Knowledge recovery failed');
    }
    notifier.start();
  })();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Shutting down: finishing in-flight replies');
    server.close();
    await transport.stop().catch(() => undefined);
    manager.stop();
    whatsapp.stop();
    notifier.stop();
    await Promise.race([Promise.all([runtime.drain(20_000), indexer.idle()]), new Promise((r) => setTimeout(r, 25_000))]);
    logger.info('Bye');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ err: errorMessage(reason) }, 'Unhandled rejection'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
