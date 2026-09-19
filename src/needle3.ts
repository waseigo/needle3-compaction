import { estimateTokens } from './state.js';
import type {
  CompactionState,
  HistoryEntry,
  JevAsker,
  JevQuestions,
  JevResponse,
  JevState,
} from './types.js';

/**
 * Hard context ceiling of Needle 3 (from the `.cact` header). The fitted
 * state plus the query preamble and the tool schema must stay under it.
 */
export const NEEDLE_MAX_TOKENS = 8192;

/**
 * Where the Needle 3 checkpoint lives on Hugging Face (Apache-2.0). The
 * weights (~35 MB) are not committed to this repo; they are fetched once and
 * cached in `weights/needle3.cact` on first use.
 */
const CACT_URL =
  'https://huggingface.co/Cactus-Compute/needle3/resolve/main/needle3.cact';

/**
 * The inference surface we need from `needle-rs` (or a fake in tests).
 * Mirrors `NeedleV3Wasm`: `run` returns the full completion (reasoning + call),
 * `runJson` returns just the tool-call payload, and `confidenceFor` scores a
 * *completion* (not a bare query) to a calibrated 0..1.
 */
export interface NeedleEngine {
  run(query: string, toolsJson: string): string;
  runJson(query: string, toolsJson: string): string;
  confidenceFor(query: string, toolsJson: string, completion: string): number | undefined;
  /** Optional; defaults to 8192 when absent. */
  maxSeqLen?: () => number;
}

/** One per-call decision emitted by the `decide` tool. */
export interface NeedleDecision {
  id: string;
  keep_call: boolean;
  keep_result: boolean;
}

export interface NeedleAskerOptions {
  /** Injected engine (used by tests); otherwise `loadNeedleEngine` is used. */
  engine?: NeedleEngine;
  /** Path to `needle3.cact` (default: `weights/needle3.cact` next to this file). */
  cactPath?: string;
}

/**
 * A `JevAsker` that asks **Cactus Needle 3** (on-device, CPU, no API key) to
 * decide which tool calls and results to keep. Needle 3 is a tool-calling /
 * structured-extraction model, so each batch of `noul` questions is posed as a
 * single `decide` tool call: it returns one `{ keep_call, keep_result }` per
 * call plus a calibrated confidence. That confidence is folded into the `noul`
 * probability the rest of the library expects:
 *
 *   keep   -> confidence (or 0.9 without a head)
 *   drop   -> 1 - confidence (or 0.1 without a head)
 *
 * so a confident keep lands near 1.0, a confident drop near 0.0, and an
 * unsure answer near the `keepThreshold`. A call Needle declines to decide is
 * kept (conservative): compaction only ever drops what it is confident about.
 */
export class NeedleAsker implements JevAsker {
  private readonly engine: NeedleEngine | undefined;
  private readonly pending: Promise<NeedleEngine> | undefined;

  constructor(options: NeedleAskerOptions = {}) {
    this.engine = options.engine;
    this.pending = options.engine ? undefined : loadNeedleEngine(options);
  }

  /** The engine's hard context limit, with a little headroom for the schema. */
  private maxInputTokens(): number {
    const seq = this.engine?.maxSeqLen ? this.engine.maxSeqLen() : NEEDLE_MAX_TOKENS;
    return Math.max(1, seq - 256);
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    const engine = this.engine ?? (await this.pending);
    if (!engine) throw new Error('NeedleAsker has no engine');
    const cs = toCompactionState(state);
    const callIds = extractCallIds(questions);
    const toolsJson = decideToolSchema();
    const query = buildQuery(cs, callIds);

    const total = estimateTokens(query) + estimateTokens(toolsJson);
    const limit = this.maxInputTokens();
    if (total > limit) {
      throw new Error(
        `Needle 3 input too large (~${total} tokens, limit ${limit}). ` +
          `Lower maxStateTokens (default 7000; Needle 3's context is ${NEEDLE_MAX_TOKENS} tokens)`,
      );
    }

    const completion = engine.run(query, toolsJson);
    const payload = engine.runJson(query, toolsJson);
    const confidence = engine.confidenceFor(query, toolsJson, completion);
    const decisions = parseDecisions(payload);
    const byId = new Map(decisions.map((d) => [d.id, d]));

    const answers: Record<string, { noul: number }> = {};
    for (const qName of Object.keys(questions)) {
      const id = callIdFromQuestion(qName);
      if (!id) {
        answers[qName] = { noul: 1 };
        continue;
      }
      const d = byId.get(id);
      // A call Needle did not decide is kept with full confidence.
      if (!d) {
        answers[qName] = { noul: 1 };
        continue;
      }
      const keep = qName.startsWith('call_') ? d.keep_call : d.keep_result;
      answers[qName] = { noul: toNoul(keep, confidence) };
    }
    return { answers, model: 'needle-3' };
  }
}

/**
 * Loads the real Needle 3 engine from `needle-rs` (WASM, CPU, offline).
 * Requires the `needle-rs` package; the `needle3.cact` checkpoint is
 * auto-downloaded from Hugging Face on first use if it is not already present.
 * Throws a clear error if either is missing, so callers can fall back to the
 * built-in summary instead of crashing.
 */
export async function loadNeedleEngine(options: NeedleAskerOptions = {}): Promise<NeedleEngine> {
  let needle: any;
  try {
    needle = await import('needle-rs');
  } catch (error) {
    throw new Error(
      `needle-rs is not installed. Run "npm install needle-rs" and download needle3.cact ` +
        `to use the Needle 3 compaction path. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const init = needle.default;
  if (typeof init !== 'function') {
    throw new Error('needle-rs does not export an init function');
  }
  // Node's fetch() rejects file:// URLs, so the no-arg `init()` (which
  // resolves needle_wasm_bg.wasm via a file:// URL) cannot be used here.
  // Feed it the WASM bytes directly; `__wbg_load` then calls
  // WebAssembly.instantiate without a network round-trip. The `{ module_or_path }`
  // object form is the non-deprecated shape (a bare value triggers a console.warn).
  await init({ module_or_path: await loadWasmBytes() });
  const NeedleV3Wasm = needle.NeedleV3Wasm;
  if (!NeedleV3Wasm?.load) {
    throw new Error('needle-rs does not export NeedleV3Wasm');
  }
  const cactPath = options.cactPath ?? defaultCactPath();
  // Only the default path auto-downloads; a caller-supplied path must exist.
  if (options.cactPath === undefined) {
    await ensureWeights(cactPath);
  }
  const bytes = await readFileCact(cactPath);
  const engine = NeedleV3Wasm.load(bytes);
  if (!engine) {
    throw new Error(`Failed to load Needle 3 from ${cactPath}`);
  }
  return {
    run: (query: string, toolsJson: string) => engine.run(query, toolsJson),
    // The runtime exposes snake_case for these; the internal NeedleEngine
    // interface keeps camelCase, so the mapping translates.
    runJson: (query: string, toolsJson: string) => engine.run_json(query, toolsJson),
    confidenceFor: (
      query: string,
      toolsJson: string,
      completion: string,
    ): number | undefined => engine.confidence_for(query, toolsJson, completion),
    maxSeqLen: engine.max_seq_len ? () => engine.max_seq_len() : undefined,
  };
}

function defaultCactPath(): string {
  // The model weights ship at the package root, one level above both src/
  // and dist/, so the relative path is stable for either entry point.
  return new URL('../weights/needle3.cact', import.meta.url).pathname;
}

/**
 * Finds `needle-rs/needle_wasm_bg.wasm` by walking up from this file. The
 * runtime ships it next to `needle_wasm.js`; this loader (compiled to
 * `dist/needle3.js`, or run from `src/`) sits one or more levels below the
 * project root that owns `node_modules`.
 */
async function loadWasmBytes(): Promise<Uint8Array> {
  const { readFile, access } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  let dir = dirname(new URL(import.meta.url).pathname);
  for (let depth = 0; depth <= 6; depth++) {
    const candidate = join(dir, 'node_modules/needle-rs/needle_wasm_bg.wasm');
    try {
      await access(candidate);
      return new Uint8Array(await readFile(candidate));
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error(
    'needle-rs/needle_wasm_bg.wasm not found. Run "npm install needle-rs" ' +
      'to use the Needle 3 compaction path.',
  );
}

async function readFileCact(path: string): Promise<Uint8Array> {
  const { readFile } = await import('node:fs/promises');
  return new Uint8Array(await readFile(path));
}

/**
 * Downloads the Needle 3 checkpoint if it is not already present, and returns
 * the path to it. The weights are not committed to the repo; this is the
 * public entry point for fetching them (also invoked lazily by
 * `loadNeedleEngine`).
 */
export async function downloadNeedleWeights(): Promise<string> {
  const cactPath = defaultCactPath();
  await ensureWeights(cactPath);
  return cactPath;
}

/**
 * Fetches `needle3.cact` from Hugging Face if it is missing or empty. Writes
 * to a `.part` file first and renames, so an interrupted download never leaves
 * a half-written checkpoint that a later run would mistake for a valid one.
 */
async function ensureWeights(cactPath: string): Promise<void> {
  const { writeFile, rename, mkdir, stat } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  try {
    const s = await stat(cactPath);
    if (s.size > 0) return; // present and non-empty — trust it
  } catch {
    // missing; fall through to download
  }
  const dir = dirname(cactPath);
  await mkdir(dir, { recursive: true });
  console.log(`[needle3] downloading needle3.cact (~35 MB) from Hugging Face…`);
  const res = await fetch(CACT_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to download needle3.cact from ${CACT_URL}: ${res.status} ${res.statusText}`,
    );
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength === 0) {
    throw new Error('Downloaded needle3.cact is empty.');
  }
  const tmp = `${cactPath}.part`;
  await writeFile(tmp, buf);
  await rename(tmp, cactPath);
  console.log(`[needle3] needle3.cact ready at ${cactPath} (${buf.byteLength} bytes)`);
}

/* -------------------------------------------------------------------------- */
/* Query / schema construction                                                */
/* -------------------------------------------------------------------------- */

function toCompactionState(state: JevState): CompactionState {
  if (typeof state === 'string') return { context: state, goal: '', history: [] };
  return state as CompactionState;
}

function decideToolSchema(): string {
  return JSON.stringify([
    {
      name: 'decide',
      parameters: {
        type: 'object',
        properties: {
          decisions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                keep_call: { type: 'boolean' },
                keep_result: { type: 'boolean' },
              },
              required: ['id', 'keep_call', 'keep_result'],
            },
          },
        },
        required: ['decisions'],
      },
    },
  ]);
}

function buildQuery(state: CompactionState, callIds: string[]): string {
  const parts: string[] = [];
  if (state.context?.trim()) parts.push(state.context.trim());
  if (state.goal?.trim()) parts.push(`GOAL:\n${state.goal.trim()}`);
  const history = serializeHistory(state.history);
  if (history) parts.push(`CONVERSATION (tool outputs abbreviated; each call has an id t1, t2, ...):\n${history}`);
  parts.push(
    `DECIDE:\nFor each tool call listed below, output one decision. Fields:\n` +
      `- id: the call id (e.g. t1)\n` +
      `- keep_call: true if the call itself should stay in history (knowing it was made, with its input, still matters)\n` +
      `- keep_result: true if its full output should stay verbatim (its contents are still needed and re-running the tool would not do)\n` +
      `Return every listed call, in order.`,
  );
  const listed = callIds.map((id) => callLine(state, id)).filter(Boolean).join('\n');
  if (listed) parts.push(`Listed calls:\n${listed}`);
  return parts.filter(Boolean).join('\n\n');
}

function serializeHistory(history: HistoryEntry[]): string {
  const lines: string[] = [];
  for (const entry of history) {
    const role = entry.role === 'user' ? '[User]' : '[Assistant]';
    const text = entry.text?.trim();
    if (text) lines.push(`${role} ${text}`);
    const tcs = entry.tool_calls;
    if (Array.isArray(tcs)) {
      for (const tc of tcs) {
        if (typeof tc === 'string') {
          lines.push(`[tool] ${tc}`);
        } else {
          const input = JSON.stringify(tc.input ?? {});
          lines.push(`[tool] ${tc.id} ${tc.tool} input=${input} -> ${tc.result}`);
        }
      }
    }
  }
  return lines.join('\n') || '';
}

function callInfo(state: CompactionState, id: string): { tool: string; input: string; result: string } | null {
  for (const entry of state.history) {
    const tcs = entry.tool_calls;
    if (!Array.isArray(tcs)) continue;
    for (const tc of tcs) {
      if (typeof tc === 'string') {
        const m = tc.match(/^(\S+)\b/);
        if (m && m[1] === id) return { tool: tc, input: '', result: tc };
      } else if (tc.id === id) {
        return { tool: tc.tool, input: JSON.stringify(tc.input ?? {}), result: tc.result };
      }
    }
  }
  return null;
}

function callLine(state: CompactionState, id: string): string | null {
  const info = callInfo(state, id);
  if (!info) return null;
  return `${info.tool} (result: ${info.result})`;
}

/* -------------------------------------------------------------------------- */
/* Question-name -> call-id helpers                                           */
/* -------------------------------------------------------------------------- */

function extractCallIds(questions: JevQuestions): string[] {
  const ids = new Set<string>();
  for (const name of Object.keys(questions)) {
    const id = callIdFromQuestion(name);
    if (id) ids.add(id);
  }
  return [...ids];
}

function callIdFromQuestion(name: string): string | null {
  const i = name.indexOf('_');
  return i === -1 || i === 0 ? null : name.slice(i + 1);
}

/* -------------------------------------------------------------------------- */
/* Payload parsing + confidence -> noul                                       */
/* -------------------------------------------------------------------------- */

function asObject(v: unknown): any {
  return v !== null && typeof v === 'object' ? (v as any) : null;
}

export function parseDecisions(payload: string): NeedleDecision[] {
  if (!payload) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return [];
  }

  // 1) { "decisions": [...] }
  const obj = asObject(raw);
  if (obj?.decisions && Array.isArray(obj.decisions)) return normalize(obj.decisions);

  // 2) [ { "name": "decide", "arguments": { "decisions": [...] } }, ... ]
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const o = asObject(item);
      if (o?.name === 'decide' && o.arguments && Array.isArray(o.arguments.decisions)) {
        return normalize(o.arguments.decisions);
      }
    }
    // 3) [ { "id": ..., "keep_call": ..., "keep_result": ... }, ... ] (flattened)
    if (raw.some((item) => {
      const o = asObject(item);
      return o !== null && 'id' in o;
    })) {
      return normalize(raw);
    }
  }
  return [];
}

function normalize(items: unknown[]): NeedleDecision[] {
  const out: NeedleDecision[] = [];
  for (const item of items) {
    const o = asObject(item);
    if (!o) continue;
    const id = String(o.id ?? '');
    if (!id) continue;
    out.push({ id, keep_call: toBool(o.keep_call), keep_result: toBool(o.keep_result) });
  }
  return out;
}

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return /^(true|yes|t|1)$/i.test(v.trim());
  if (typeof v === 'number') return v >= 0.5;
  return false;
}

export function toNoul(keep: boolean, confidence: number | undefined): number {
  if (confidence === undefined || !Number.isFinite(confidence)) {
    // No confidence head: trust the boolean, confidently.
    return keep ? 0.9 : 0.1;
  }
  const c = Math.max(0, Math.min(1, confidence));
  return keep ? c : 1 - c;
}
