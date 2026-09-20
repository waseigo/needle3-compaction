import { createRequire } from 'node:module';
import type { NeedleEngine } from './needle3.js';

/**
 * The compiled native addon's surface. `load` returns a native engine, or
 * `null` when the bytes are not a Needle 3 container (so the caller can fall
 * back to the WASM runtime instead of crashing).
 */
export interface NativeAddon {
  load(bytes: Uint8Array): NativeEngine | null;
}

export interface NativeEngine {
  run(query: string, toolsJson: string): string;
  runJson(query: string, toolsJson: string): string;
  // `null` when the container carries no confidence head.
  confidenceFor(query: string, toolsJson: string, completion: string): number | null;
  maxSeqLen(): number;
}

/**
 * Load the compiled native addon (`native/build/Release/native.node`).
 *
 * Returns `null` when the addon is not available — not built, wrong platform or
 * architecture, or a loader error — so the caller can fall back to the WASM
 * runtime. A CommonJS `require()` is used because a `.node` binary cannot be
 * ES-imported; `createRequire` binds it to this module's location so the
 * relative path resolves from both `dist/` and `src/`.
 */
export function loadNativeAddon(): NativeAddon | null {
  // `createRequire` binds require() to this module's directory, so the relative
  // specifier resolves to native/build/Release/ from both dist/ (built) and
  // src/ (run via tsx). A .node binary cannot be ES-imported.
  const require = createRequire(import.meta.url);
  try {
    const mod = require('../native/build/Release/native.node') as NativeAddon;
    return typeof mod.load === 'function' ? mod : null;
  } catch {
    return null;
  }
}

/**
 * Build a `NeedleEngine` backed by the native addon, or `null` when the addon
 * is unavailable. The confidence head maps the addon's `null` (no head) to the
 * interface's `undefined`.
 */
export function loadNativeEngine(bytes: Uint8Array): NeedleEngine | null {
  const addon = loadNativeAddon();
  if (!addon) return null;
  let engine: NativeEngine | null;
  try {
    engine = addon.load(bytes);
  } catch {
    return null;
  }
  if (!engine) return null;
  return {
    run: (query: string, toolsJson: string) => engine.run(query, toolsJson),
    runJson: (query: string, toolsJson: string) => engine.runJson(query, toolsJson),
    confidenceFor: (
      query: string,
      toolsJson: string,
      completion: string,
    ): number | undefined => {
      const c = engine.confidenceFor(query, toolsJson, completion);
      return c === null ? undefined : c;
    },
    maxSeqLen: () => engine.maxSeqLen(),
  };
}
