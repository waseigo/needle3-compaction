import { JevClient, type JevClientOptions } from './client.js';
import { compact } from './compact.js';
import { NeedleAsker, type NeedleAskerOptions } from './needle3.js';
import type { CompactOptions, CompactResult, Message } from './types.js';

export type CompactMessagesOptions = CompactOptions & JevClientOptions;

/** `compact` with a `JevClient` built from the options (key from `TYPESAFE_API_KEY` by default). */
export function compactMessages(
  messages: readonly Message[],
  options: CompactMessagesOptions = {},
): Promise<CompactResult> {
  return compact(messages, new JevClient(options), options);
}

export type CompactMessagesNeedleOptions = CompactOptions & NeedleAskerOptions;

/**
 * `compact` driven by **Cactus Needle 3** running on CPU (WASM via `needle-rs`,
 * no API key). The fitted state is capped at `maxStateTokens` (default 7000,
 * under Needle 3's 8192-token context) so the query + tool schema always fits.
 * Throws (so callers can fall back to the built-in summary) when `needle-rs`
 * or `needle3.cact` is missing.
 */
export async function compactMessagesNeedle(
  messages: readonly Message[],
  options: CompactMessagesNeedleOptions = {},
): Promise<CompactResult> {
  const maxStateTokens = options.maxStateTokens ?? 7000;
  const asker = new NeedleAsker({ engine: options.engine, cactPath: options.cactPath });
  return compact(messages, asker, { ...options, maxStateTokens });
}
