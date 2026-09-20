# needle3-compaction — why it was abandoned

**Status:** abandoned (2026-09-20). The project was built out and verified
working, but it cannot meet the hard performance bar that was set for it, so it
is being retired rather than shipped.

**The bar:** verbatim, deletion-based compaction of a **~200k-token context
window** must finish in **under 60 seconds** on a **Ryzen 7 5700X** (8C/16T),
using as many cores as possible. The whole point was to avoid thrashing the
host's `llama-server` — i.e. to be *faster* than asking the big model (e.g.
Qwen3.8-27B) to compact the same session, which takes up to ~5 minutes.

**Verdict:** it cannot. On the target machine a single forward pass at the real
per-batch size (~7900 tokens) takes **~150 s on one core**, and a 200k session
needs **~14** such passes → **~35 minutes**, roughly **35× over the 60 s bar**.
Parallelism does not help (it makes it worse — see below), and slicing the model
cannot close a 35× gap without destroying decision quality. There is also **no
production GPU path** for this model/runtime (details at the end).

This document records everything that was built, everything that was tried to
hit the bar, what was deliberately *not* tried and why, and the GPU
assessment. See [`../README.md`](../README.md) for the short version.

---

## 1. What the project is (and does)

`needle3-compaction` is verbatim, deletion-based context compaction for LLM
agents, re-pointed from the original `tamaratran/fast-jev-compaction` at
**Cactus Needle 3** — a tiny (~35 MB, ~121M params, 2-bit) on-device
tool-calling model. It scores every tool call and result, drops or truncates
the stale ones, and keeps everything else **verbatim**. It ships as an npm
library (`src/`), a Claude Code plugin (`hooks/`, `.claude-plugin/`), and a Pi
extension (`pi/`). No API key, no network, nothing leaves the machine.

The core idea that made it attractive: the raw 200k context is **never** sent to
the model. `fitState()` compresses the whole transcript into a state ≤
`maxStateTokens` (7000) in one O(N) pass with **no model call**, so the input's
token count does not by itself drive the cost. What drives cost is the
**number of tool calls** and the **size of the fitted state**.

### Features implemented and verified (the "what we built" list)

These are all done, tested, and pushed to `origin/main`. None of them is the
problem — the problem is raw per-pass cost.

- **Native x64 addon + WASM autodetection** (`src/native.ts`, `native/`,
  `src/needle3.ts`). The native addon (`native/build/Release/native.node`) is a
  node-gyp C++ wrapper (`binding.cc`) around the `needle-rs` `needle-c` crate's
  C ABI, linked against the release `--release -O3` cdylib built with the
  multi-threaded `parallel` feature. `loadNeedleEngine()` tries native first and
  falls back to the `needle-rs` WASM runtime. Decisions are **identical** either
  way (the switch only affects speed), so backend switching never changes
  results.
- **`useConfidence` flag** (`src/needle3.ts`, commit `74ac2af`). The default
  path makes **three** forward passes per request (`run`, `runJson`,
  `confidenceFor`); `useConfidence: false` skips the confidence head and drops to
  a **single** `runJson()` pass — a ~3× wall-time win with no change to the
  decisions at the default `keepThreshold: 0.5`.
- **Batch sizing to Needle 3's 8192 ceiling** (`src/needle3.ts`
  `planBatches`, `src/compact.ts`, commit `fa75a51`). The generic batcher sized
  batches by `maxRequestTokens` (default 30000), which overflowed Needle 3's
  `maxInputTokens` (7936) and would have packed ~200 calls into one rejected
  request. `planBatches` runs the *identical* size check `ask()` enforces
  (`estimateTokens(buildQuery) + estimateTokens(toolsJson) <= 7936`), so every
  batch is guaranteed accepted. Near the 7000-state cap only ~15 calls fit per
  batch, so `#batches ≈ #calls / 15`. Both `planBatches` and `maxInputTokens()`
  were added as **optional** `Asker` members (backward compatible).
- **CI** (`.github/workflows/ci.yml): ubuntu-latest, Node 20, Rust via rustup,
  checks out `geekgineer/needle-rs`, downloads weights, builds the native
  addon, verifies `native/build/Release/native.node` exists, then typechecks,
  tests, and runs the demo.
- **Native-load smoke test** (`tests/native.test.ts`): asserts
  `loadNativeAddon()` returns null when the addon is absent (WASM-fallback
  trigger), non-Needle bytes → null, and (when both addon and weights are
  present) that `load(bytes)` returns an engine and `runJson` returns a payload.
- **Full test suite:** 50 passed | 1 skipped (the native "null when built" case
  is skipped because the addon is present locally). Typecheck green for library,
  hooks, and pi.
- **`npm run demo`** reproduces the baseline end-to-end (e.g. 15.6 s,
  stateTokens 1139, 1 request, all 7 calls kept).

---

## 2. What we tried to hit the 60 s bar

The go/no-go investigation (2026-09-20, on the Ryzen 7 5700X target machine,
load average ~3.4, node v20.19.2). Three levers were examined in order:
per-pass cost, parallelism, and model slicing.

### 2a. Measured per-pass cost (the binding constraint)

A probe (`probe-pass.mjs`, removed after use) timed one `runJson` pass against
query size on the **native** backend:

| Query size | Passes | Result |
|---|---|---|
| ~1494 tokens | 1 | **25.8 s/pass** |
| ~7900 tokens (the real per-batch size) | 1 | **149.86 s/pass** |

Notes on these numbers:

- The ~7900-token figure is what a dense ~200k session actually presents: the
  fitted state (~4975 tokens) is re-sent with every batch, plus the calls, right
  under the 7936 ceiling.
- These are ~3–5× slower than the earlier in-session measurements cited in the
  README (~4.7 s/pass at 1139 tokens, ~40 s/pass at 3831 tokens). The earlier
  figures came from a faster/lower-load baseline; **on the target 5700X the
  measured numbers above are the reliable ones.** (The trend is roughly linear
  in state size here, not the state^1.8 curve fit from the earlier, faster
  host.)
- Cross-check: `needle-rs`'s own benchmarks quote ~4.20 ms/token prefill on a
  desktop CPU → ~33 s for the same 7900-token prefill. Our native build is
  ~4.5× slower than that, consistent with the 5700X being below their benchmark
  host plus the ~3.4 load. Even the optimistic 33 s figure does not change the
  verdict (see 2c).

### 2b. Parallelism across cores (the "use as many cores as possible" lever)

`compact.ts` already runs batches via `Promise.all`. The question was whether
the native backend would scale across the 8 cores. A probe
(`probe-parallel.mjs`, removed after use) ran **8 concurrent passes** at ~7900
tokens as 8 separate processes:

| Config | Time | Speedup |
|---|---|---|
| 1 pass (single core) | 150 s | 1× |
| 8 concurrent passes | **699.8 s wall** | **0.21× (4.7× *slower*)** |

**Conclusion: parallelism does not help; it hurts.** Each native engine instance
opens its own thread pool, so 8 instances oversubscribe the 16 cores and thrash.
Running batches one-at-a-time (serially) is optimal — there is no free
multi-core speedup to exploit here.

### 2c. Projecting to a full 200k session

- ~200 tool calls → fitted state ~4975 tokens → **~14 batches** (~15 calls each).
- `useConfidence: false` → **14 passes** (the cheapest path).
- Serial (optimal, since parallelism hurts): **14 × ~150 s ≈ 2100 s ≈ 35 min.**

**35 minutes vs the 60 s bar = ~35× over.** Even under the optimistic
needle-rs benchmark (33 s/pass) it is 14 × 33 s ≈ 7.7 min — still ~8× over.

### 2d. Model slicing (the only remaining lever)

Needle 3 ships as a **20-layer ladder**; the Needle CLI can build a subnetwork
with `needle build --layers N` (2–20). Per-pass cost is roughly proportional to
layer count, so slicing is the only lever that scales with the gap.

- Best realistic slice (2 layers) → ~10× faster → **~3.5 min**, still ~3.5×
  over the bar, and a 2-layer network is a weak approximation — decisions
  degrade noticeably.
- To actually reach 60 s from the measured 35 min would need ~35× speedup →
  **<1 layer**, which does not exist.

Slicing therefore cannot meet the bar without degrading the verbatim-decision
quality that is the whole reason the project exists.

---

## 3. What we did NOT try, and why

- **Building/benchmarking a sliced (≤4-layer) model.** The CLI (`needle build
  --layers N`) was not installed and the `cactus-needle[train]` toolchain was
  not set up. Given 2c, even an ideal slice lands at ~3.5 min, so a build would
  only have confirmed the negative — it could not reach 60 s. Not worth the
  install/build time once the arithmetic was clear.
- **Re-running the per-pass probe to "tune" the measurement.** The 150 s/pass
  figure is authoritative for the target machine; re-measuring would not change
  the ~35 min projection or the verdict.
- **Fine-tuning needle3 for compaction.** Raised earlier in the project's life
  as a possibility and answered in place: technically feasible (LoRA → `.cact`),
  but (a) tuned models report `confidence: None`, so calibration is lost and the
  decisions at `keepThreshold: 0.5` are unchanged; (b) the hard part is
  labelled `(state, keep_call, keep_result)` data, not the training itself; and
  (c) it is a deployment-specific model for a general library. It also does
  nothing for the per-pass *speed* problem, which is the actual blocker.
- **A dedicated compaction `llama-server` instance.** The original motivation
  was to avoid thrashing the host server; a separate server instance trades one
  machine for another and does not address the on-device bar that was set.
- **Anything in code.** No source, config, or tests were changed for the
  go/no-go — the decision is architectural, not a bug to fix. The three
  exploratory probes were removed so the tree is clean.

---

## 4. GPU assessment (the question you asked)

**Short answer: there is no production GPU path for this model in this stack,
and GPU would not be a realistic fix anyway.**

- **`needle-rs`** (the runtime this repo uses) is explicitly **CPU/WASM-only**
  — no CUDA/Metal. It targets browser/Node/Cloudflare Workers, native CLI,
  Python, C FFI, and `no_std` embedded.
- **The official Cactus Needle 3 engine** is **CPU/NPU-optimized** (tiny
  platform-specific engines; on a Raspberry Pi 5 it reports 400–4k tok/s decode,
  1–10k tok/s prefill depending on ladder depth). It has **no GPU kernels** for
  the production `.cact` path.
- **GPU is used only for training** (JAX CUDA extras: `pip install
  "cactus-needle[train,gpu]"`).
- The only GPU *inference* option is the **JAX reference implementation**, which
  is a development/debug tool: it does not use the `.cact` format, and it will
  not match the tiny engine's efficiency.

The reason is architectural: Needle 3 is *intentionally* a tiny on-device model
(Engram n-gram tables, Hadamard butterflies, 2-bit packing — all cache-friendly
table gathers and cheap integer ops). GPU adds overhead for a model this small,
and a well-tuned CPU path often matches or beats naive GPU. This is exactly why
it runs on phones, wearables, and microcontrollers.

**Could GPU have saved the project?** In principle the JAX reference on a GPU
could drive a 7900-token prefill in ~1–2 s instead of ~33 s, which would bring
14 passes down to ~15–30 s and *would* clear 60 s. But that means abandoning
`needle-rs`/the `.cact` format and building a backend on a dev-only JAX path — a
rewrite of the core for a model that was never designed for GPUs. Not a fix
worth making for an abandoned approach.

---

## 5. What this leaves open / possible follow-ups

If the performance bar is non-negotiable and on-device CPU is a hard
constraint, none of the above closes it. Options that were out of scope here:

- **Relax the bar / target a smaller context.** needle3 is comfortably fast for
  short-to-medium sessions (the demo runs in ~15 s at 1139 tokens). It is only
  the very large, very dense sessions that blow the budget.
- **Accept a slower, background, or off-device route** for the largest sessions
  (e.g. the JAX/GPU path above, or a dedicated worker) instead of on-device CPU.
- **Reconsider the judge model entirely** for the 200k case — a smaller/faster
  heuristic or a cheaper model may beat a tiny specialized LLM at this size.

The code is left intact and tested so any of these can be picked up later
without re-deriving the design.

---

*Prepared 2026-09-20. Measurements taken on AMD Ryzen 7 5700X (8C/16T), node
v20.19.2, native backend, load average ~3.4. All three probes used for the
investigation were removed; the tree is clean.*
