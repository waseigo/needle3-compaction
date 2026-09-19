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
});
