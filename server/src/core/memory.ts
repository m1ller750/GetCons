import type { ConsultantRow, ConversationRow, MessageRow } from '../db/types.js';
import { errorMessage } from '../lib/errors.js';
import { buildSummaryPrompt } from '../services/prompt.js';
import type { EngineDeps } from './engine.js';

/** How many messages beyond the live history window we allow before folding them into the summary. */
export const SUMMARY_SLACK = 10;

function transcript(messages: MessageRow[]): string {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const who = m.role === 'customer' ? 'Customer' : m.role === 'operator' ? 'Team member' : 'Consultant';
      return `${who}: ${m.content.slice(0, 1500)}`;
    })
    .join('\n');
}

/**
 * Long-term conversation memory. The last `max_history_messages` messages are sent verbatim;
 * anything older is folded into a rolling summary that is included in the system instruction.
 */
export async function maybeSummarize(
  deps: EngineDeps,
  consultant: Pick<ConsultantRow, 'max_history_messages'>,
  conversation: ConversationRow,
): Promise<boolean> {
  const window = consultant.max_history_messages;
  const since =
    [conversation.memory_reset_at, conversation.summarized_until].filter((v): v is string => Boolean(v)).sort().pop() ??
    null;

  const recent = await deps.store.getRecentMessages(conversation.id, { since, limit: window + SUMMARY_SLACK + 40 });
  if (recent.length <= window + SUMMARY_SLACK) return false;

  const toFold = recent.slice(0, recent.length - window);
  const last = toFold[toFold.length - 1]!;
  const resetAfterSummary =
    conversation.memory_reset_at && (!conversation.summarized_until || conversation.memory_reset_at > conversation.summarized_until);
  const existing = resetAfterSummary ? null : conversation.summary;

  try {
    const prompt = buildSummaryPrompt(existing, transcript(toFold));
    const res = await deps.llm.generateText({
      system: prompt.system,
      messages: [{ role: 'user', parts: [{ text: prompt.user }] }],
      temperature: 0.2,
      maxOutputTokens: 1024,
    });
    const summary = res.text.trim();
    if (!summary) return false;
    await deps.store.updateConversation(conversation.id, {
      summary: summary.slice(0, 4000),
      summarized_until: last.created_at,
    });
    return true;
  } catch (err) {
    deps.logger.warn({ err: errorMessage(err), conversationId: conversation.id }, 'Conversation summary failed');
    return false;
  }
}
