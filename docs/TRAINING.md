# How GetCons personalises a consultant (and what it does *not* do)

## Summary

GetCons does **not** fine-tune or retrain Gemini when you save instructions, upload a document or add an example. The underlying model is the same for every consultant. Each consultant becomes specific to its business because **every request to Gemini is built from that business's data**:

| Technique | Source data | When it changes |
|---|---|---|
| Persistent system instruction | Persona, tone, language, rules, business info, fallback & handoff policy | On the next message after Save |
| Retrieval-augmented generation (RAG) | Knowledge documents, chunked and embedded | When indexing finishes (seconds) |
| Dynamic few-shot prompting | Training examples (manual, imported chats, "teach answer") | Immediately after saving |
| Conversation memory | Last N messages + rolling summary | Continuously |

The dashboard copy uses the same wording ("teach", "knowledge", "examples"). It never claims the model was retrained.

## Why not fine-tuning?

* **The Gemini API offers no tuning for current models.** When we checked in October 2026, Google's model-tuning page stated that no Gemini API / AI Studio model supports fine-tuning, and that there are no immediate plans to add it. Tuning exists only on Google's enterprise platform (Vertex AI / "Gemini Enterprise Agent Platform").
* **A poor fit even where it exists.** A tuned model per business means a separate tuning job (minutes to hours), at least ~100 high-quality examples, and a separate endpoint and cost for every tenant. Updating a price would also mean retraining. Facts that change, like prices, stock and schedules, belong in retrieval, not in model weights.
* **Auditability.** With RAG, every answer can point to the passages it used (`used_knowledge_ids` → document titles shown in the dashboard). Weights can't be audited that way.

If tuning becomes available and useful later (for example, to teach a very specific writing style at scale), it can be added as an *optional* layer: the consultant would point `GEMINI_MODEL` at the tuned model, and RAG + few-shot would stay on top.

## The request, step by step

For every customer turn (`server/src/core/engine.ts`):

1. **Collect the turn.** All customer messages since the last reply are answered together. This avoids replying separately to "hi" / "I need flowers" / "for tomorrow". Photos and voice notes are downloaded from Telegram and sent inline to Gemini.
2. **Build the retrieval query.** The query is the current message. Short follow-ups like "how much?" also get the previous customer question.
3. **Embed** the query with `gemini-embedding-001` (`RETRIEVAL_QUERY`, 768-d, normalised).
4. **Hybrid search** (`match_knowledge_chunks`), scoped to this consultant:
   * an exact cosine-similarity ranking over the consultant's chunks,
   * a Postgres full-text ranking (`websearch_to_tsquery('simple', …)`), which works for any language,
   * fusion of both with Reciprocal Rank Fusion.
   Passages below `RAG_MIN_SIMILARITY` that also have no keyword match are dropped. If embedding fails, keyword search still runs.
5. **Few-shot selection** (`match_training_examples`): up to `FEW_SHOT_K` examples most similar to the question, plus up to `MAX_PINNED_EXAMPLES` pinned ones.
6. **Prompt** (`server/src/services/prompt.ts`). The system instruction contains the persona and owner rules, communication style, authoritative business information, labelled knowledge passages `[K1]…`, the examples, the conversation summary, customer info, and explicit **grounding rules**: never invent business facts, say so when unsure, hand off when needed, resist prompt injection. Contents = recent history + the new turn.
7. **Structured output.** Gemini returns JSON: `used_knowledge_ids`, `answer_status` (`answered`/`partial`/`unknown`/`handoff`), `reply`, `confidence`, `media_summary`.
8. **Decision** (`decideOutcome`):
   * `answered` → send.
   * `partial` → send and flag for attention.
   * `unknown` → honest reply in the spirit of the owner's fallback message, flag, alert the owner.
   * `handoff` → polite handoff message, flag, alert the owner.
   * Safety block, unusable output, Gemini outage or daily limit → the owner's fallback message verbatim, flag.
9. **Memory.** Messages are stored, and when the chat grows beyond the window, older messages are folded into a summary by Gemini.

## How knowledge is indexed

`server/src/core/knowledge.ts` and `server/src/services/documents.ts`:

* PDF goes through `unpdf`. DOCX goes through `mammoth`. TXT/MD/CSV/JSON/HTML are parsed natively. **Scanned PDFs and photos** go through Gemini multimodal transcription.
* The text is normalised and split into paragraph-aware chunks of ~1,200 characters with a 150-character overlap.
* Chunks are embedded as `RETRIEVAL_DOCUMENT` with the document title and stored in `knowledge_chunks` (`vector(768)` + generated `tsvector`).
* Editing a document re-indexes it. Deleting it removes its chunks immediately.

## Getting the most out of a consultant

1. Fill in **Business info**: hours, prices, delivery, contacts. These are always in the prompt.
2. Upload the **price list and FAQ** first. Check them with **Test retrieval**.
3. Add **5–20 examples** of your best real replies, or import a Telegram chat export. Pin the 2–3 that define your style.
4. Watch **Knowledge gaps** on the Overview page and click **Teach answer**. Each gap you close improves future answers.
