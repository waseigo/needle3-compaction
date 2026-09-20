import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadNativeAddon, loadNativeEngine } from '../src/native.js';

// The compiled addon is gitignored, so this runs against whatever is present
// on the machine: the fast native path when built, or null (WASM fallback)
// otherwise. The weights are also gitignored, so the load-and-run case is
// skipped until `npm run download-weights` has fetched them (as CI does).
const addon = loadNativeAddon();
const addonPresent = addon !== null;
const cactPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'weights', 'needle3.cact');
const weightsPresent = existsSync(cactPath) && statSync(cactPath).size > 0;

describe('native addon smoke', () => {
  it('is either a valid addon or null (loading never throws)', () => {
    expect(addon === null || typeof addon.load === 'function').toBe(true);
  });

  it('treats non-Needle bytes as absent (the WASM fallback trigger)', () => {
    // The addon's load() rejects anything that is not a Needle 3 container and
    // returns null, so loadNativeEngine() returns null and loadNeedleEngine()
    // falls back to the WASM runtime instead of crashing.
    expect(loadNativeEngine(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBeNull();
  });

  it.skipIf(addonPresent)(
    'reports null when the addon is not built (WASM fallback without building)',
    () => {
      expect(loadNativeAddon()).toBeNull();
    },
  );

  it.skipIf(!addonPresent || !weightsPresent)(
    'loads the real container and runs when the addon is built',
    async () => {
      const bytes = await import('node:fs/promises').then((fs) => fs.readFile(cactPath));
      const engine = loadNativeEngine(bytes);
      expect(engine).not.toBeNull();
      const payload = engine!.runJson('q', '{"tools":[]}');
      expect(typeof payload).toBe('string');
      expect(engine!.maxSeqLen()).toBe(8192);
    },
  );
});
