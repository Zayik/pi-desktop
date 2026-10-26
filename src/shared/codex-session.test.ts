import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeCodexSession, codexEntries } from './codex-session'
import { listCost } from './list-prices'
import { openAIBillsCacheWrites, openAIPrice } from './openai-prices'

const T0 = Date.parse('2026-10-20T10:00:00Z')
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString()
const FILE = '/home/me/.codex/sessions/2026/10/20/rollout-2026-10-20T10-00-00-abc.jsonl'

function line(type: string, seconds: number, payload: Record<string, unknown>): Record<string, unknown> {
  return { timestamp: at(seconds), type, payload }
}

function usage(input: number, cached: number, output: number, total: number): Record<string, unknown> {
  const last = { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output }
  return { type: 'token_count', info: { last_token_usage: last, total_token_usage: { ...last, total_tokens: total }, model_context_window: 272_000 } }
}

function rollout(model: string): Record<string, unknown>[] {
  return [
    line('session_meta', 0, { id: 'cx1', timestamp: at(0), cwd: '/repo', originator: 'codex_cli_rs' }),
    line('response_item', 1, { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>...</environment_context>' }] }),
    line('turn_context', 1, { model, cwd: '/repo' }),
    line('event_msg', 1, { type: 'user_message', message: 'run the tests' }),
    line('response_item', 5, { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }), call_id: 'call_1' }),
    line('event_msg', 5, usage(10_000, 0, 50, 10_050)),
    line('event_msg', 5, usage(10_000, 0, 50, 10_050)),
    line('response_item', 40, { type: 'function_call_output', call_id: 'call_1', output: JSON.stringify({ output: 'ok', metadata: { exit_code: 0 } }) }),
    line('response_item', 45, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Passed.' }] }),
    line('event_msg', 45, usage(12_000, 10_000, 20, 22_070)),
    line('event_msg', 45, { type: 'token_count', info: null, rate_limits: {} }),
  ]
}

test('reads calls, tool runs and prompts, skipping repeated counts', () => {
  const entries = codexEntries(rollout('gpt-5.3-codex'), FILE)
  assert.equal(entries[0].id, 'cx1')
  const roles = entries.slice(1).map((entry) => (entry.message as { role: string }).role)
  assert.deepEqual(roles, ['user', 'assistant', 'toolResult', 'assistant'])
  const facts = analyzeCodexSession(rollout('gpt-5.3-codex'), FILE)
  assert.ok(facts)
  assert.equal(facts.source, 'codex')
  assert.equal(facts.calls, 2)
  assert.equal(facts.turns, 1)
  assert.deepEqual(facts.cacheModels, ['codex/gpt-5.3-codex'])
  assert.equal(facts.tools[0].category, 'test')
})

test('older models keep uncached input as input; GPT-5.6 and later write it to the cache', () => {
  const older = analyzeCodexSession(rollout('gpt-5.3-codex'), FILE)
  assert.ok(older)
  assert.deepEqual(older.cacheCalls[1].slice(2, 5), [2_000, 10_000, 0])
  const newer = analyzeCodexSession(rollout('gpt-6-luna'), FILE)
  assert.ok(newer)
  assert.deepEqual(newer.cacheCalls[1].slice(2, 5), [0, 10_000, 2_000])
  // Luna: $0.10 input, writes 1.25x, reads 0.1x.
  assert.ok(Math.abs(newer.cacheCalls[1][8] - 2_000 * 0.1e-6 * 1.25) < 1e-12)
  assert.ok(Math.abs(newer.cacheCalls[1][7] - 10_000 * 0.1e-6 * 0.1) < 1e-12)
})

test('a fork\'s copied lines count as inherited', () => {
  const lines = rollout('gpt-5.3-codex')
  lines[0] = line('session_meta', 30, { id: 'cx2', timestamp: at(30), cwd: '/repo', forked_from_id: 'cx1' })
  const facts = analyzeCodexSession(lines, FILE)
  assert.ok(facts)
  assert.equal(facts.parentSession, 'cx1')
  assert.equal(facts.calls, 1)
})

test('OpenAI list prices', () => {
  assert.equal(openAIPrice('gpt-6.1-sol')?.readRatio, 0.05)
  assert.equal(openAIPrice('gpt-5.6-terra')?.input, 2)
  assert.equal(openAIPrice('gpt-5.4-mini')?.input, 0.75)
  assert.equal(openAIPrice('gpt-5.3-codex')?.output, 14)
  assert.equal(openAIBillsCacheWrites('gpt-5.6-luna'), true)
  assert.equal(openAIBillsCacheWrites('gpt-5.5'), false)
  const long = listCost('gpt-5.5', { input: 300_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 })
  assert.ok(long && Math.abs(long.input - 3) < 1e-9)
  assert.equal(listCost('gemini-3.5-flash', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }), null)
})
