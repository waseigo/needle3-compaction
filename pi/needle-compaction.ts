/**
 * Pi extension: replace Pi's lossy summary compaction with verbatim,
 * deletion-based pruning driven by Cactus Needle 3 (on-device, CPU, no API
 * key).
 *
 * This extension subscribes to `session_before_compact` and returns a custom
 * compaction whose `summary` is the verbatim kept messages (formatted in Pi's
 * native `[User]` / `[Assistant]` / `[Tool result]` style), not a model-generated
 * summary. Nothing is rewritten; the assistant can always re-run a dropped tool.
 *
 * Usage:
 *   pi -e .pi/needle-compaction.ts
 * or drop this file into `~/.pi/agent/extensions/` (global) or `.pi/extensions/`
 * (project-local) for auto-discovery, then `/reload`.
 */

import type { ExtensionAPI, SessionBeforeCompactEvent } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { compactMessagesNeedle, type CompactResult, type Message } from 'needle3-compaction';

/**
 * Fitted-state ceiling. Needle 3's hard context is 8192 tokens; 4000 leaves
 * plenty of headroom for the query + tool schema and keeps each pass cheap
 * (per-pass cost scales with state size). The trade-off is less context in the
 * state vs 7000; fast-path decoding (useConfidence: false below) already cuts
 * the dominant cost, so the smaller state here is what keeps on-device
 * compaction responsive.
 */
const NEEDLE_MAX_STATE_TOKENS = 4000;

/**
 * Pi's `AgentMessage` -> the library's `Message`. Tool uses live on assistant
 * messages; tool results are separate `toolResult` messages, mapped onto an
 * `assistant` shell so the library's `collectToolCalls` can pair them by
 * `tool_use_id`.
 */
function contentText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  return content
    .filter((c) => c.type === 'text')
    .map((c) => (typeof c.text === 'string' ? c.text : ''))
    .join('\n');
}

function piMessagesToLibrary(piMessages: readonly AgentMessage[]): Message[] {
  const out: Message[] = [];
  for (const msg of piMessages) {
    if (msg.role === 'user') {
      out.push({
        role: 'user',
        text: contentText(msg.content),
        toolUses: [],
        toolResults: [],
      });
    } else if (msg.role === 'assistant') {
      const textParts = (msg.content as unknown[])
        .filter((c) => (c as { type?: string }).type === 'text')
        .map((c) => (c as { text?: string }).text ?? '');
      const toolUses = (msg.content as unknown[])
        .filter((c) => (c as { type?: string }).type === 'toolCall')
        .map((c) => ({
          tool_use_id: (c as { id?: string }).id ?? '',
          tool: (c as { name?: string }).name ?? 'unknown',
          input: (c as { arguments?: Record<string, unknown> }).arguments ?? {},
        }));
      out.push({
        role: 'assistant',
        text: textParts.join('\n'),
        toolUses,
        toolResults: [],
      });
    } else if (msg.role === 'toolResult') {
      out.push({
        role: 'assistant',
        text: '',
        toolUses: [],
        toolResults: [
          {
            tool_use_id: msg.toolCallId,
            text: contentText(msg.content),
            isError: msg.isError,
          },
        ],
      });
    }
  }
  return out;
}

/** Library `Message[]` -> Pi's native transcript text (for the `summary` field). */
function libraryMessagesToText(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (msg.text.trim()) parts.push(`[User]: ${msg.text}`);
    } else if (msg.role === 'assistant') {
      if (msg.toolUses?.length) {
        const calls = msg.toolUses
          .map((t) => `${t.tool}(${JSON.stringify(t.input)})`)
          .join('; ');
        parts.push(`[Assistant tool calls]: ${calls}`);
      }
      if (msg.text.trim()) parts.push(`[Assistant]: ${msg.text}`);
    }
    for (const r of msg.toolResults ?? []) {
      parts.push(`[Tool result]: ${r.text}`);
    }
  }
  return parts.join('\n');
}

/** A short header for the `summary` so the LLM (and the user) knows what this is. */
function buildSummary(result: CompactResult): string {
  const stats = result.stats;
  const dropped = stats.callsDropped + stats.resultsDropped;
  const body = libraryMessagesToText(result.messages);
  const parts = [
    '## Pruned conversation (Cactus Needle 3, on-device, no model summary)',
    '',
    `Verbatim pruning: kept ${stats.kept} calls, dropped ${stats.callsDropped} calls and ${stats.resultsDropped} results (${dropped} total). ${stats.messagesBefore} messages -> ${stats.messagesAfter}.`,
    '',
    body,
  ];
  return parts.join('\n');
}

export default function (pi: ExtensionAPI) {
  pi.on('session_before_compact', async (event: SessionBeforeCompactEvent, ctx) => {
    const { preparation } = event;
    const { messagesToSummarize, firstKeptEntryId, tokensBefore } = preparation;

    // Nothing to prune.
    if (!messagesToSummarize || messagesToSummarize.length === 0) return;

    ctx.ui.notify('Cactus Needle 3 compaction (on-device)...', 'info');

    try {
      const libraryMessages = piMessagesToLibrary(messagesToSummarize);
      const result: CompactResult = await compactMessagesNeedle(libraryMessages, {
        // Only the old messages are being summarized; pin just the first so
        // the library does not protect the newest old messages from pruning.
        preserveRecentMessages: 1,
        maxStateTokens: NEEDLE_MAX_STATE_TOKENS,
        // Skip the confidence head (run() + confidenceFor()) and keep only the
        // runJson() pass. Decisions at keepThreshold 0.5 are unchanged; the
        // reported probabilities fall back to 0.9/0.1.
        useConfidence: false,
      });

      // Not worth it: nothing dropped and no reduction -> let Pi use its default.
      const reduction = (s: CompactResult['stats']) => {
        const { charsBefore, charsAfter } = s;
        return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
      };
      if (reduction(result.stats) < 0.1) {
        ctx.ui.notify('Needle 3 kept nearly everything; using default compaction', 'info');
        return;
      }

      return {
        compaction: {
          summary: buildSummary(result),
          firstKeptEntryId,
          tokensBefore,
          details: {
            engine: 'cactus-needle-3',
            stats: result.stats,
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Needle 3 compaction failed: ${message}. Falling back to default.`, 'error');
      // Returning undefined lets Pi use its default compaction.
      return;
    }
  });
}
