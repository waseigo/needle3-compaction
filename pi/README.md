# Pi extension: needle-compaction

Replaces Pi's lossy summary compaction with **verbatim, deletion-based pruning**
driven by **Cactus Needle 3** running on-device (CPU, WASM via `needle-rs`),
no API key.

Pi's default compaction summarizes old turns with the session's LLM. This
extension instead asks Cactus Needle 3 — a small, calibrated, on-device
tool-calling model — which tool calls and results are still needed, and keeps
those verbatim while deleting the rest. Nothing is rewritten; the assistant can
always re-run a dropped tool.

## How it works

1. Subscribes to Pi's `session_before_compact` event (auto-compaction or
   `/compact`).
2. Converts the messages-to-summarize into the `fast-jev-compaction` library's
   `Message[]` shape.
3. Runs `compactMessagesNeedle` (the library's `compact` driven by a
   `NeedleAsker` over the WASM engine). The fitted state is capped at 7000
   tokens, under Needle 3's hard 8192-token context.
4. Returns a custom compaction whose `summary` is the **verbatim kept messages**
   (formatted in Pi's native `[User]` / `[Assistant]` / `[Tool result]` style),
   plus a header showing what was kept/dropped.
5. Falls back to Pi's default compaction on any error (missing `.cact`, WASM
   failure, history too large, or when the reduction is trivially small).

## Install

The extension needs the library's Needle 3 model file and the `needle-rs`
package, which this repo already provides:

```sh
npm install          # installs needle-rs and fetches weights/needle3.cact
npm run build        # compiles src/ -> dist/ (the extension imports the built lib)
```

The weights are fetched by `npm install` from the Cactus Compute Hugging Face
repo. If you are on a Pi with no network, copy `weights/needle3.cact` in
manually (35.3 MB) and make sure `needle-rs` is installed.

## Load the extension

**Project-local** (auto-discovered when you run Pi in this directory):

```sh
pi -e pi/needle-compaction.ts
```

or drop the file into `.pi/extensions/` (project) / `~/.pi/agent/extensions/`
(global) and run `/reload`.

**Via the Pi CLI flag** (current directory must contain this repo):

```sh
pi -e .
```

Pi loads TypeScript extensions via jiti, so no compilation of the extension
itself is needed — only the library (`dist/`) must be built.

## What you'll see

On compaction, the Pi TUI shows:

- `Cactus Needle 3 compaction (on-device)...` while the WASM engine runs.
- On success, the old turns are replaced by the verbatim kept messages (no
  model summary), and the session continues from `firstKeptEntryId`.
- On failure, `Needle 3 compaction failed: …` and Pi uses its default summary.

## Tuning

The extension passes a fixed set of options to the library:

| Option | Value | Notes |
| --- | --- | --- |
| `preserveRecentMessages` | `1` | Only the first message is pinned; the old messages being summarized are all candidates. |
| `maxStateTokens` | `7000` | Under Needle 3's 8192-token hard ceiling, leaving headroom for the query + tool schema. |
| `keepThreshold` | `0.5` (default) | Minimum keep probability for a call/result to stay. |

To tune these, edit the constants near the top of `pi/needle-compaction.ts`.

## Limitations

- Same as the library: only tool calls/results are candidates; user/assistant
  text is never removed or shortened in the output (only abridged in the state
  Needle 3 sees). Token sizes are character-based estimates.
- The `summary` field is a text serialization of the kept messages, not the
  original structured messages. Pi stores it as a `CompactionEntry`; the LLM
  reads it as context. If you need the original message objects back, use the
  library directly rather than through this extension.
- Needle 3 has a hard 8192-token context. Very long histories that cannot be
  fitted throw and fall back to Pi's default compaction.
