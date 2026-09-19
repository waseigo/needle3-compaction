import { describe, expect, it } from 'vitest';
import {
  compactSession,
  decisionLog,
  decisionLogLines,
  resolveHookConfig,
  summarize,
  toSessionMessages,
} from '../hooks/needle3.ts';
import {
  NeedleAsker,
  type NeedleEngine,
} from '../src/index.js';
import { applyDecisions, collectToolCalls, decideCall, type Message } from '../src/index.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const fileA = 'export const a = 1;\n'.repeat(50);

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    call('tool-2', 'Bash', { command: 'npm test' }, 'FAIL'),
    result('tool-2', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'Fixing now.', { handle: 'h-5' }),
    message('user', 'go ahead', { handle: 'h-6' }),
  ];
}

/** A fake Needle 3 engine that returns the given decide-tool payload. */
function fakeNeedleEngine(
  decisions: Record<string, { keep_call: boolean; keep_result: boolean }>,
  confidence: number | undefined = 0.9,
): NeedleEngine {
  return {
    run: () => 'reasoning',
    runJson: () =>
      JSON.stringify([
        {
          name: 'decide',
          arguments: {
            decisions: Object.entries(decisions).map(([id, d]) => ({ id, ...d })),
          },
        },
      ]),
    confidenceFor: () => confidence,
    maxSeqLen: () => 8192,
  };
}

function needleAsker(
  decisions: Record<string, { keep_call: boolean; keep_result: boolean }>,
  confidence: number | undefined = 0.9,
): NeedleAsker {
  return new NeedleAsker({ engine: fakeNeedleEngine(decisions, confidence) });
}

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      maxStateTokens: 7000,
    });
    expect(
      resolveHookConfig({
        keepThreshold: 0.3,
        maxStateTokens: 1000,
        cactPath: '/cact',
        goal: 'g',
        compactAtPercent: 'no',
      }),
    ).toEqual({
      keepThreshold: 0.3,
      maxStateTokens: 1000,
      cactPath: '/cact',
      goal: 'g',
      compactAtPercent: 60,
      minReductionRatio: 0.25,
    });
  });

  it("caps maxStateTokens at Needle 3's safe budget", () => {
    expect(resolveHookConfig({ maxStateTokens: 25000 })).toMatchObject({ maxStateTokens: 7000 });
  });
});

describe('session message mapping', () => {
  it('returns the engine objects for untouched messages and handle-less copies for rebuilt ones', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    messages[1]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[2]!.toolResults![0]!.text = 'x'.repeat(2000);
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out).toHaveLength(messages.length);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]?.handle).toBeUndefined();
    expect(out[1]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[needle3-compaction truncated 1700 chars`),
    );
    expect(out[2]?.handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[needle3-compaction truncated 1700 chars`),
    );
    expect(out[2]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'tool-1', isError: false });
    expect(out[3]).toBe(messages[3]);
    expect(out[4]).toBe(messages[4]);
  });

  it('preserves short dropped-result messages and their handles', () => {
    const messages = transcript();
    messages[1]!.toolUses[0]!.text = 'y'.repeat(100);
    messages[2]!.toolResults![0]!.text = 'y'.repeat(100);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).toBe(messages[2]);
  });
});

describe('compactSession', () => {
  it('runs the library over the on-device asker and reports the outcome', async () => {
    const { result: output, messages } = await compactSession(
      transcript(),
      { ...resolveHookConfig({ preserveRecentMessages: 1 }) },
      needleAsker({
        t1: { keep_call: false, keep_result: false },
        t2: { keep_call: true, keep_result: true },
      }),
    );
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_call', 'keep']);
    expect(messages.map((m) => m.handle)).toEqual(['h-0', 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
    expect(summarize(output)).toMatch(
      /^\d+% reduction; 1 kept, 1 call_dropped; state ~\d+ tokens \(full\) in 1 request\(s\)$/,
    );
    expect(decisionLog(output)).toBe('t1:Read:drop_call/call=0.10/result=0.10 t2:Bash:keep/call=0.90/result=0.90');
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('splits a long decision log into ui.log lines under the host limit', async () => {
    const { result: output } = await compactSession(
      transcript(),
      { ...resolveHookConfig({ preserveRecentMessages: 1 }) },
      needleAsker({
        t1: { keep_call: false, keep_result: false },
        t2: { keep_call: false, keep_result: false },
      }),
    );
    const lines = decisionLogLines(output, 60);
    expect(lines).toEqual([
      'decisions (1/2): t1:Read:drop_call/call=0.10/result=0.10',
      'decisions (2/2): t2:Bash:drop_call/call=0.10/result=0.10',
    ]);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(decisionLogLines({ ...output, decisions: [] })).toEqual(['decisions: (none)']);
  });

  it('throws when the engine fails so the hook can fall back', async () => {
    const badEngine: NeedleEngine = {
      run: () => {
        throw new Error('wasm boom');
      },
      runJson: () => '',
      confidenceFor: () => 0.9,
      maxSeqLen: () => 8192,
    };
    await expect(
      compactSession(
        transcript(),
        resolveHookConfig({ preserveRecentMessages: 1 }),
        new NeedleAsker({ engine: badEngine }),
      ),
    ).rejects.toThrow(/wasm boom/);
  });
});
