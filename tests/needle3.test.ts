import { describe, expect, it } from 'vitest';
import {
  NeedleAsker,
  parseDecisions,
  toNoul,
  type NeedleEngine,
} from '../src/index.js';

describe('toNoul', () => {
  it('maps a keep with high confidence to ~1', () => {
    expect(toNoul(true, 0.95)).toBeCloseTo(0.95);
  });
  it('maps a drop with high confidence to ~0', () => {
    expect(toNoul(false, 0.95)).toBeCloseTo(0.05);
  });
  it('maps an unsure answer (0.5 confidence) to the threshold', () => {
    expect(toNoul(true, 0.5)).toBeCloseTo(0.5);
    expect(toNoul(false, 0.5)).toBeCloseTo(0.5);
  });
  it('uses confident defaults when there is no confidence head', () => {
    expect(toNoul(true, undefined)).toBeCloseTo(0.9);
    expect(toNoul(false, undefined)).toBeCloseTo(0.1);
  });
  it('clamps confidence into [0,1]', () => {
    expect(toNoul(true, 1.5)).toBeCloseTo(1);
    expect(toNoul(false, -0.5)).toBeCloseTo(1);
  });
});

describe('parseDecisions', () => {
  const standard = `[{"name":"decide","arguments":{"decisions":[
    {"id":"t1","keep_call":true,"keep_result":false},
    {"id":"t2","keep_call":false,"keep_result":false}
  ]}}]`;
  it('parses the standard decide-tool payload', () => {
    expect(parseDecisions(standard)).toEqual([
      { id: 't1', keep_call: true, keep_result: false },
      { id: 't2', keep_call: false, keep_result: false },
    ]);
  });
  it('parses a top-level { decisions } object', () => {
    const d = parseDecisions('{"decisions":[{"id":"t1","keep_call":true,"keep_result":true}]}');
    expect(d).toEqual([{ id: 't1', keep_call: true, keep_result: true }]);
  });
  it('parses a flattened decisions array', () => {
    const d = parseDecisions('[{"id":"t1","keep_call":true,"keep_result":false}]');
    expect(d).toEqual([{ id: 't1', keep_call: true, keep_result: false }]);
  });
  it('coerces string/number booleans', () => {
    const d = parseDecisions('[{"id":"t1","keep_call":"true","keep_result":"false"}]');
    expect(d[0]).toEqual({ id: 't1', keep_call: true, keep_result: false });
  });
  it('returns [] for abstention ([]) and empty/invalid payloads', () => {
    expect(parseDecisions('[]')).toEqual([]);
    expect(parseDecisions('')).toEqual([]);
    expect(parseDecisions('not json')).toEqual([]);
    expect(parseDecisions('{"decisions":"x"}')).toEqual([]);
  });
  it('skips entries without an id', () => {
    const d = parseDecisions('[{"keep_call":true},{"id":"t1","keep_call":true,"keep_result":true}]');
    expect(d).toHaveLength(1);
    expect(d[0].id).toBe('t1');
  });
});

function fakeEngine(
  payload: string,
  confidence: number | undefined = 0.9,
): NeedleEngine {
  return {
    run: () => 'reasoning',
    runJson: () => payload,
    confidenceFor: () => confidence,
    maxSeqLen: () => 8192,
  };
}

const state: any = {
  context: 'Compaction state',
  goal: 'fix the test',
  history: [
    { i: 0, role: 'user', text: 'fix it' },
    { i: 1, role: 'assistant', text: '', tool_calls: [{ id: 't1', tool: 'Read', input: { file_path: 'src/a.ts' }, result: 'ok, 42 chars (omitted)' }] },
    { i: 2, role: 'user', text: '' },
  ],
};

describe('NeedleAsker.planBatches', () => {
  // A fitted state with many call-only entries: large enough that the whole
  // decide request does not fit Needle's 8192-token context in one batch.
  function manyCallsState(n: number): any {
    const history = Array.from({ length: n }, (_, i) => ({
      i,
      role: 'assistant' as const,
      text: '',
      tool_calls: [
        {
          id: `t${i}`,
          tool: 'Read',
          input: { file_path: `/repo/src/module-${i}.ts` },
          result: 'ok, 480 chars (omitted)',
        },
      ],
    }));
    return { context: 'state', goal: '', history };
  }

  function calls(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: `t${i}`,
      tool_use_id: `tool-${i}`,
      tool: 'Read',
      input: {},
      callIndex: i,
      resultIndex: i,
      resultChars: 100,
      isError: false,
      pinned: false,
    }));
  }

  it('keeps every call exactly once across the batches', () => {
    const asker = new NeedleAsker({ engine: fakeEngine('[]') });
    const list = calls(200);
    const batches = asker.planBatches(manyCallsState(200), list);
    expect(batches.flat().map((c) => c.id)).toEqual(list.map((c) => c.id));
  });

  it('splits when the state leaves little room (does not pack all into one)', () => {
    const asker = new NeedleAsker({ engine: fakeEngine('[]') });
    const list = calls(200);
    const batches = asker.planBatches(manyCallsState(200), list);
    // The generic batchCalls against the 30000 default would put all in one
    // request that overflows the 7936 ceiling; planBatches must not.
    expect(batches.length).toBeGreaterThan(1);
    // Each batch is non-empty and the last is the remainder.
    expect(batches.every((b) => b.length > 0)).toBe(true);
    expect(batches.reduce((sum, b) => sum + b.length, 0)).toBe(200);
  });

  it('puts everything in one batch when it fits', () => {
    const asker = new NeedleAsker({ engine: fakeEngine('[]') });
    const list = calls(5);
    const batches = asker.planBatches(state, list);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(5);
  });
});

describe('NeedleAsker.ask', () => {
  it('maps keep/drop decisions to noul using confidence', async () => {
    const asker = new NeedleAsker({
      engine: fakeEngine('[{"name":"decide","arguments":{"decisions":[{"id":"t1","keep_call":true,"keep_result":false}]}}]'),
    });
    const res = await asker.ask(state, {
      call_t1: { type: 'noul', instructions: 'x' },
      result_t1: { type: 'noul', instructions: 'x' },
    });
    expect(res.answers.call_t1.noul).toBeCloseTo(0.9);
    expect(res.answers.result_t1.noul).toBeCloseTo(0.1);
  });

  it('keeps a call Needle did not decide', async () => {
    const asker = new NeedleAsker({ engine: fakeEngine('[]') });
    const res = await asker.ask(state, {
      call_t1: { type: 'noul', instructions: 'x' },
      result_t1: { type: 'noul', instructions: 'x' },
    });
    expect(res.answers.call_t1.noul).toBe(1);
    expect(res.answers.result_t1.noul).toBe(1);
  });

  it('falls back to confident defaults without a confidence head', async () => {
    const asker = new NeedleAsker({
      engine: fakeEngine('[{"name":"decide","arguments":{"decisions":[{"id":"t1","keep_call":false,"keep_result":true}]}}]', undefined),
    });
    const res = await asker.ask(state, {
      call_t1: { type: 'noul', instructions: 'x' },
      result_t1: { type: 'noul', instructions: 'x' },
    });
    expect(res.answers.call_t1.noul).toBeCloseTo(0.1);
    expect(res.answers.result_t1.noul).toBeCloseTo(0.9);
  });

  it('throws when the input would exceed Needle 3 context', async () => {
    const asker = new NeedleAsker({ engine: fakeEngine('[]') });
    const huge: any = { context: 'x'.repeat(120000), goal: '', history: [] };
    await expect(
      asker.ask(huge, { call_t1: { type: 'noul', instructions: 'x' } }),
    ).rejects.toThrow(/too large/);
  });

  it('skips run() and confidenceFor() when useConfidence is false', async () => {
    let runCalls = 0;
    let confidenceCalls = 0;
    const asker = new NeedleAsker({
      engine: {
        run: () => {
          runCalls += 1;
          return 'reasoning';
        },
        runJson: () =>
          '[{"name":"decide","arguments":{"decisions":[{"id":"t1","keep_call":true,"keep_result":false}]}}]',
        confidenceFor: () => {
          confidenceCalls += 1;
          return 0.95;
        },
        maxSeqLen: () => 8192,
      },
      useConfidence: false,
    });
    const res = await asker.ask(state, {
      call_t1: { type: 'noul', instructions: 'x' },
      result_t1: { type: 'noul', instructions: 'x' },
    });
    expect(runCalls).toBe(0);
    expect(confidenceCalls).toBe(0);
    // No head: confident defaults (0.9 keep / 0.1 drop) instead of calibrated.
    expect(res.answers.call_t1.noul).toBeCloseTo(0.9);
    expect(res.answers.result_t1.noul).toBeCloseTo(0.1);
  });

  it('uses the confidence head by default', async () => {
    let runCalls = 0;
    const asker = new NeedleAsker({
      engine: {
        run: () => {
          runCalls += 1;
          return 'reasoning';
        },
        runJson: () =>
          '[{"name":"decide","arguments":{"decisions":[{"id":"t1","keep_call":true,"keep_result":false}]}}]',
        confidenceFor: () => 0.95,
        maxSeqLen: () => 8192,
      },
    });
    const res = await asker.ask(state, {
      call_t1: { type: 'noul', instructions: 'x' },
      result_t1: { type: 'noul', instructions: 'x' },
    });
    expect(runCalls).toBe(1);
    expect(res.answers.call_t1.noul).toBeCloseTo(0.95);
    expect(res.answers.result_t1.noul).toBeCloseTo(0.05);
  });
});
