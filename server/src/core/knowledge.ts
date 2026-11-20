import { errorMessage } from '../lib/errors.js';
import { chunkText } from '../services/chunking.js';
import type { EngineDeps } from './engine.js';

/**
 * Indexes one knowledge document: chunk -> embed (Gemini) -> store vectors + full-text.
 * Saving knowledge does NOT retrain Gemini; the chunks are retrieved at answer time (RAG).
 */
export async function processDocument(deps: EngineDeps, documentId: string): Promise<void> {
  const { store, llm, logger } = deps;
  const doc = await store.getDocument(documentId);
  if (!doc) return;

  try {
    const chunks = chunkText(doc.content);
    if (!chunks.length) throw new Error('The document has no text to index');
    const embeddings = await llm.embed(
      chunks,
      'document',
      chunks.map(() => doc.title),
    );
    await store.replaceChunks(
      doc.id,
      doc.consultant_id,
      chunks.map((content, index) => ({ index, content, embedding: embeddings[index] ?? null })),
    );
    await store.updateDocument(doc.id, { status: 'ready', error: null, chunk_count: chunks.length });
    await store.logEvent(doc.consultant_id, 'knowledge_indexed', `"${doc.title}" is ready (${chunks.length} chunks)`, {
      meta: { document_id: doc.id, chunks: chunks.length },
    });
  } catch (err) {
    const message = errorMessage(err);
    logger.error({ err: message, documentId }, 'Document indexing failed');
    await store.updateDocument(doc.id, { status: 'error', error: message.slice(0, 500) }).catch(() => undefined);
    await store.logEvent(doc.consultant_id, 'knowledge_failed', `Could not index "${doc.title}": ${message}`, {
      level: 'error',
      meta: { document_id: doc.id },
    });
  }
}

/** Background indexing with bounded concurrency (documents are processed after the upload request returns). */
export class KnowledgeIndexer {
  private queue: string[] = [];
  private queued = new Set<string>();
  private active = 0;
  private idleResolvers: (() => void)[] = [];

  constructor(
    private readonly deps: EngineDeps,
    private readonly concurrency = 2,
  ) {}

  enqueue(documentId: string): void {
    if (this.queued.has(documentId)) return;
    this.queued.add(documentId);
    this.queue.push(documentId);
    this.pump();
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const id = this.queue.shift()!;
      this.active++;
      void processDocument(this.deps, id)
        .catch((err) => this.deps.logger.error({ err: errorMessage(err), id }, 'Indexer crashed'))
        .finally(() => {
          this.active--;
          this.queued.delete(id);
          this.pump();
          if (this.active === 0 && !this.queue.length) this.idleResolvers.splice(0).forEach((r) => r());
        });
    }
  }

  /** Resolves when the queue is empty (used by tests and graceful shutdown). */
  idle(): Promise<void> {
    if (this.active === 0 && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  /** Re-queues work interrupted by a restart and embeds examples saved while Gemini was down. */
  async recover(): Promise<void> {
    const ids = await this.deps.store.listDocumentIdsByStatus('processing', 200);
    ids.forEach((id) => this.enqueue(id));
    if (ids.length) this.deps.logger.info({ count: ids.length }, 'Re-queued unfinished documents');

    const examples = await this.deps.store.listExamplesMissingEmbedding(500);
    for (let i = 0; i < examples.length; i += 50) {
      const batch = examples.slice(i, i + 50);
      try {
        const vectors = await this.deps.llm.embed(
          batch.map((e) => e.customer_message),
          'query',
        );
        await Promise.all(batch.map((e, j) => this.deps.store.setExampleEmbedding(e.id, vectors[j]!)));
      } catch (err) {
        this.deps.logger.warn({ err: errorMessage(err) }, 'Example embedding backfill failed');
        break;
      }
    }
  }
}
