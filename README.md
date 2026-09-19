# needle3-compaction

Verbatim context compaction for LLM agents. Replaces the lossy LLM-summary
compaction with **deletion-based pruning**: every tool call and result is
scored by a small on-device model, stale ones are dropped or truncated, and
everything kept stays verbatim. Works as an npm library, a Claude Code plugin,
and a Pi extension.

Driven by **Cactus Needle 3** — a tiny on-device model (~35 MB, ~121M
parameters, 2-bit) that runs on CPU via WebAssembly (`needle-rs`). No API key,
no network, nothing leaves the machine.

This repo is a fork of [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction),
re-pointed at Needle 3 so the compaction runs locally. [Attribution](#attribution).

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results the judge says are no longer needed, and it asks the
judge while showing it the whole conversation. User and assistant text stays
verbatim and in order.

The repository is both an npm package (`src/`) and a Claude Code plugin
(`hooks/`, `.claude-plugin/`) that uses the package to replace Claude Code's
built-in compaction summary with the original messages.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to the model is the whole conversation so far, oldest
   first, with every tool result replaced by a short note (`ok, 4213 chars
   (omitted)`). Tool inputs are included, texts are included, nothing is
   summarized.
3. The state is fitted into `maxStateTokens` in stages, each applied only if
   the previous one was not enough: tool inputs truncated to 1000, then 200,
   then 60 characters; long texts abridged to head + tail, oldest non-pinned
   messages first; old non-pinned messages collapsed to a `[… N chars omitted
   …]` note; old tool calls reduced to one line each (`t12 Read file_path=src/a.ts
   → ok 480ch`); old call-less messages left out; runs of old call-only messages
   folded into one entry. If it still does not fit, compaction throws. Tokens
   are estimated without a tokenizer (a word per six letters, half a token per
   digit, ~one per other symbol).
4. For every non-pinned call the model gets two questions: should the **call**
   stay (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do).
5. Decisions per call, against `keepThreshold`:
   - `keepResult ≥ threshold` → keep call and result;
   - else `keepCall ≥ threshold` → keep the call, truncate the result to its
     first `truncateHeadChars` characters plus a one-line note;
   - else → remove the call together with its result.
6. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.

Needle 3 is posed the questions as a single `decide` tool call over the whole
state: for each non-pinned call, return `{ id, keep_call, keep_result }`. Its
**calibrated confidence head** scores its own answer (0..1). A `keep` lands at
`confidence`, a `drop` at `1 − confidence` (no head → `0.9` / `0.1`). That
probability is compared to `keepThreshold`. A call Needle declines to decide is
**kept** (conservative): compaction only ever drops what it is confident about.
Because of Needle 3's hard 8192-token context, the fitted state defaults to
`maxStateTokens: 7000` (the library's Needle 3 entry point caps the budget
there automatically).

Model failures, malformed answers, or a history that cannot be fitted throw;
the caller (or the Claude Code hook) decides what to fall back to.

## Install and usage

```sh
npm install needle3-compaction
```

The 35 MB weights auto-download on first use (or run `npm run download-weights`).

```ts
import { compactMessagesNeedle, reductionRatio, type Message } from 'needle3-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessagesNeedle(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own judge, implement the `Asker` interface (one
`ask(state, questions)` method) and call `compact(messages, asker, options)`;
the building blocks (`collectToolCalls`, `fitState`, `batchCalls`,
`decideCall`, `applyDecisions`) are exported too.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |
| `cactPath` | auto | Path to a `needle3.cact` checkpoint (Needle 3 path only) |

`maxStateTokens` defaults to `7000` on the Needle 3 entry point
(`compactMessagesNeedle`), under Needle 3's 8192-token ceiling.

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

## Limitations

- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state the model
  sees).
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The full state is repeated with every request, so a history near the state
  ceiling costs one request per handful of questions.

## Cactus Needle 3 (on-device, no API key)

The compaction is driven by **Cactus Needle 3** — Cactus Compute's ~121M-parameter,
2-bit, on-device tool-calling model — instead of any cloud API. It runs on CPU
via WebAssembly (`needle-rs`), needs no API key, and never sends your transcript
anywhere. It works on a Pi 5 (~400–4000 tok/s) or any Node/browser environment.
The trade-off is a hard 8192-token context, so the fitted state defaults to
`maxStateTokens: 7000`.

```ts
import { compactMessagesNeedle } from 'needle3-compaction';

const result = await compactMessagesNeedle(transcript, {
  preserveRecentMessages: 4,
  // maxStateTokens defaults to 7000 (under Needle 3's 8192 ceiling)
});
```

### How the Needle 3 path works

1. The whole conversation is fitted into a state under 7000 tokens (tool results
   replaced by short `ok, N chars (omitted)` notes).
2. The state is posed to Needle 3 as a single `decide` tool call: for each
   non-pinned call, return `{ id, keep_call, keep_result }`.
3. Needle 3's **calibrated confidence head** scores its own answer (0..1). A
   `keep` lands at `confidence`, a `drop` at `1 − confidence` (no head →
   `0.9` / `0.1`). That probability is compared to `keepThreshold`.
4. A call Needle declines to decide is **kept** (conservative): compaction only
   ever drops what it is confident about.

### Speed

On CPU, each forward pass over the state costs several seconds, and the default
path makes **three** of them per call: `run()` (full completion), `runJson()`
(structured decisions), and `confidenceFor()` (the calibrated head). The
confidence head is a single scalar applied uniformly to every call in a batch,
so for the default `keepThreshold: 0.5` it does not change which calls are
dropped — only how confident the reported probabilities look. Set
`useConfidence: false` to drop the confidence head and the `run()` that feeds
it, leaving just the single `runJson()` pass. That roughly triples throughput
with no change to the default decisions; the reported probabilities fall back
to `0.9` / `0.1`.

```ts
const result = await compactMessagesNeedle(transcript, {
  preserveRecentMessages: 4,
  useConfidence: false, // skip the confidence head (faster); default is true
});
```

### Weights

The 35.3 MB `needle3.cact` checkpoint is **not committed** to the repo. It is
auto-downloaded from [Hugging Face](https://huggingface.co/Cactus-Compute/needle3)
on first use, or explicitly with:

```sh
npm run download-weights   # builds, then fetches weights/needle3.cact
```

To point at a pre-sliced container (lower memory), pass `cactPath` to a `.cact`
produced by the Needle CLI (`needle build --layers N`).

### Resources

- [needle-rs](https://github.com/geekgineer/needle-rs) — the WASM runtime
  (browser, Node, Deno, Bun, Cloudflare Workers).
- [Cactus Compute Needle](https://github.com/cactus-compute/needle) — the model
  and its Apache-2.0 weights.
- [Needle 3 weights](https://huggingface.co/Cactus-Compute/needle3) — the
  `needle3.cact` checkpoint.
- [Paper](https://arxiv.org/abs/2607.18363) — Needle (arXiv:2607.18363).

## Pi extension (prime target)

`pi/needle-compaction.ts` is a Pi (Earendil Works) extension that replaces Pi's
lossy summary compaction with the Needle 3 verbatim pruning above. See
[`pi/README.md`](pi/README.md) for install and usage.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin: `hooks/needle3.ts`
is a thin adapter that feeds `session.compact` transcripts through `src/` and
falls back to Claude Code's built-in summary on errors or insufficient
reduction. See [`hooks/README.md`](hooks/README.md) for configuration and the
Claude Code 2.1.274 type reference.

### Install in Claude Code

Function hooks are an early-access Claude Code feature (2.1.274+), so the
opt-in flag must be set wherever Claude Code runs, e.g. in
`~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

Then add this repository as a plugin marketplace and install the plugin,
either from the shell or as slash commands inside a session:

```sh
claude plugin marketplace add waseigo/needle3-compaction
claude plugin install needle3-compaction@needle3-compaction
```

The install prompts for the plugin options (thresholds, `truncateHeadChars`,
…); leave them at their defaults. Restart Claude Code or run `/reload-plugins`.
From then on `/compact` (and auto-compaction) goes through Needle 3: the toast
reads `needle3-compaction: kept N/M messages, no summary (…)` when the pruned
history replaced the built-in summary, or `fallback to built-in summary (…)`
when the on-device model could not remove enough (short sessions, or when it
fails).

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root. No publishing step is required; the marketplace is
just the repo's `.claude-plugin/marketplace.json`.

## Development

```sh
npm install
npm run typecheck        # library + hook
npm test
npm run build
npm run validate:plugin  # claude plugin validate
npm run download-weights # fetch the Needle 3 checkpoint (optional)
npm run demo
```

The unit tests use fake engines and never touch the network. The demo is the
live check (it downloads the weights on first run).

## Attribution

This project is a fork of [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
by [tamaratran](https://github.com/tamaratran). The original design, the
deletion-based compaction, the Claude Code plugin, and much of the
documentation come from that repository.

This fork re-points the compaction at **Cactus Needle 3** so it runs on-device
with no API key. The original authors' work is retained and credited; this is a
derivative project, not a replacement. It is not kept in sync with the upstream
and no pull requests are being opened back to it.

- Original: [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
- This fork: [waseigo/needle3-compaction](https://github.com/waseigo/needle3-compaction)
