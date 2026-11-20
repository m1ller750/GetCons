/**
 * Re-indexes every knowledge document and re-embeds every training example.
 * Run after changing GEMINI_EMBEDDING_MODEL:  npm run reembed --workspace server
 */
import { loadConfig, loadDotEnv } from '../config.js';
import { processDocument } from '../core/knowledge.js';
import { createSupabaseStore, toVector } from '../db/supabaseStore.js';
import { createLogger } from '../lib/logger.js';
import { createAdminClient } from '../lib/supabase.js';
import { createGeminiLlm } from '../services/llm.js';

loadDotEnv();
const config = loadConfig();
const logger = createLogger(config.logLevel, true);
const admin = createAdminClient(config);
const store = createSupabaseStore(admin, logger);
const llm = createGeminiLlm(config.gemini, logger);
const deps = { store, llm, config, logger };

const { data: docs, error } = await admin.from('knowledge_documents').select('id, title');
if (error) throw error;
for (const doc of docs ?? []) {
  logger.info({ title: doc.title }, 'Re-indexing document');
  await processDocument(deps, doc.id as string);
}

let from = 0;
for (;;) {
  const { data: examples, error: exError } = await admin
    .from('training_examples')
    .select('id, customer_message')
    .order('id')
    .range(from, from + 99);
  if (exError) throw exError;
  if (!examples?.length) break;
  const vectors = await llm.embed(
    examples.map((e) => e.customer_message as string),
    'query',
  );
  for (const [i, e] of examples.entries()) {
    await admin.from('training_examples').update({ embedding: toVector(vectors[i]!) }).eq('id', e.id);
  }
  logger.info({ count: examples.length }, 'Re-embedded examples');
  from += 100;
}
logger.info('Done');
