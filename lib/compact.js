// Long chats are compacted, never cut off. The same file in TSS-Watson, Ledger,
// TSS-Sherlock and Gatsby (tss-events); Rook-E has the TypeScript twin
// (packages/agent-core/src/compaction.ts).
//
// Once a chat passes COMPACT_AT_TOKENS (500,000), its older messages are
// summarized into one note kept on the chat (`compaction`), the newest
// messages (about KEEP_RECENT_TOKENS) stay word for word, and the model sees
// the note followed by everything after it. Stored messages never change:
// staff still scroll the whole chat, and the export carries it whole.
//
// A message is { role: 'user' | 'assistant', text }. The app passes
// `summarize(prompt) -> text`, its own model call.

export const COMPACT_AT_TOKENS = 500_000;
export const KEEP_RECENT_TOKENS = 40_000;
// Characters per token for an estimate, on the high side so compaction comes early rather than late.
const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

const textOf = (m) => String(m?.text ?? '');

// The messages the model still sees word for word.
export function liveMessages(messages, compaction) {
  return (messages || []).slice(compaction?.through || 0);
}

// What the chat costs the model now: the summary and every live message.
export function chatTokens(messages, compaction) {
  return estimateTokens(compaction?.summary || '') + liveMessages(messages, compaction).reduce((n, m) => n + estimateTokens(textOf(m)), 0);
}

export function needsCompaction(messages, compaction, at = COMPACT_AT_TOKENS) {
  return chatTokens(messages, compaction) >= at;
}

// Where the kept messages start: the earliest staff message such that it
// and everything after fit in `keep`. Always after `from`; the newest staff
// message is kept even when it alone is bigger.
export function keepFrom(messages, from, keep = KEEP_RECENT_TOKENS) {
  let tokens = 0;
  let cut = messages.length;
  for (let i = messages.length - 1; i > from; i--) {
    tokens += estimateTokens(textOf(messages[i]));
    if (tokens > keep && cut < messages.length) break;
    if (messages[i].role === 'user') cut = i;
  }
  return cut;
}

export function transcript(messages, names = { user: 'PERSON', assistant: 'ASSISTANT' }) {
  return messages.map((m) => `${m.role === 'user' ? names.user : names.assistant}:\n${textOf(m)}`).join('\n\n');
}

export const SUMMARY_INSTRUCTIONS = 'Summarize the transcript inside <summary></summary> tags. Include relevant information in the summary such that this conversation '
  + 'will be continued by a new context window without needing to redo work or be reprovided with relevant constraints or context. '
  + 'Be sure to preserve: (1) any difficulties or problems that came up, and how they were handled or resolved; (2) any possibilities, '
  + 'options, or approaches that were raised, tried, or set aside, and why; (3) anything that was asked for, decided, agreed, ruled out, '
  + 'or established as a preference, constraint, or boundary, stated exactly; (4) exactly where things stand now: what has been covered, '
  + 'settled, or completed so far; (5) anything still open, unresolved, promised, or expected to happen next; (6) specific details that '
  + 'would be hard to reconstruct (names, numbers, dates, exact wording, links, ids), kept exactly. Be complete on these even at '
  + 'the cost of length; keep everything else concise. Keep what the person said, asked for, shared, or established carefully and close '
  + "to their own words; the assistant's explanations can be condensed much further, to what they concluded or produced. If an earlier "
  + 'summary is given, fold it in: nothing in it may be lost. Respond with text only.';

export const SUMMARY_SYSTEM = 'You write the running summary of a long chat between a person and their assistant, so the chat can go on.';

export function summaryPrompt(previous, turns) {
  return [previous ? `<earlier_summary>\n${previous}\n</earlier_summary>` : '', `<transcript>\n${turns}\n</transcript>`, SUMMARY_INSTRUCTIONS].filter(Boolean).join('\n\n');
}

export function readSummary(text) {
  const m = /<summary>([\s\S]*?)(<\/summary>|$)/.exec(String(text || ''));
  return (m ? m[1] : String(text || '')).trim();
}

// The note the model reads in place of the summarized messages.
export function summaryNote(compaction) {
  return compaction?.summary
    ? `This chat is long, so its earlier part was summarized. The summary stands in for those messages; the messages after it are word for word.\n<summary>\n${compaction.summary}\n</summary>`
    : '';
}

// Returns the chat's new `compaction`, or null when nothing needed doing or
// the summary failed (the chat goes on whole; the next message tries again).
export async function compactIfNeeded({ messages, compaction = null, summarize, at = COMPACT_AT_TOKENS, keep = KEEP_RECENT_TOKENS, names, now = new Date() }) {
  if (!needsCompaction(messages, compaction, at)) return null;
  const from = compaction?.through || 0;
  const cut = keepFrom(messages, from, keep);
  if (cut <= from) return null;
  let summary = '';
  try {
    summary = readSummary(await summarize(summaryPrompt(compaction?.summary || null, transcript(messages.slice(from, cut), names))));
  } catch {
    return null;
  }
  if (!summary) return null;
  return { summary, through: cut, at: now.toISOString(), count: (compaction?.count || 0) + 1 };
}
