import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeCopilotSession, copilotEntries } from './copilot-session'
import { buildCacheReport } from './cache-policy'

const T0 = Date.parse('2026-10-20T10:00:00Z')
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString()
const FILE = '/home/me/.copilot/session-state/cp1/events.jsonl'

let next = 0
function event(type: string, seconds: number, data: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, id: `e${++next}`, parentId: null, timestamp: at(seconds), data, ...extra }
}

/** Two prompts, three model calls (one written in two chunks), a tool run, a sub-agent call, then the run's totals. */
function events(shutdown = true): Record<string, unknown>[] {
  return [
    event('session.start', 0, { sessionId: 'cp1', selectedModel: 'claude-sonnet-4.6', startTime: at(0), version: 1, producer: 'copilot', copilotVersion: '1.0', context: { cwd: '/repo' } }),
    event('user.message', 1, { content: 'run the tests' }),
    event('assistant.message', 5, { messageId: 'm1', apiCallId: 'c1', content: 'Running.', outputTokens: 20 }),
    event('assistant.message', 6, { messageId: 'm1b', apiCallId: 'c1', content: '', outputTokens: 10, toolRequests: [{ toolCallId: 't1', name: 'bash', arguments: { command: 'npm test' } }] }),
    event('tool.execution_complete', 60, { toolCallId: 't1', success: true, result: { content: 'x'.repeat(4000) } }),
    event('assistant.message', 65, { messageId: 'm2', apiCallId: 'c2', content: 'Passed.', outputTokens: 30 }),
    event('assistant.message', 66, { messageId: 's1', apiCallId: 'sub', content: 'sub-agent', outputTokens: 5 }, { agentId: 'a1' }),
    event('user.message', 1_200, { content: 'thanks' }),
    event('assistant.message', 1_205, { messageId: 'm3', apiCallId: 'c3', content: 'Welcome.', outputTokens: 40 }),
    ...(shutdown ? [event('session.shutdown', 1_210, {
      shutdownType: 'routine', sessionStartTime: T0, codeChanges: {}, systemTokens: 10_000,
      modelMetrics: { 'claude-sonnet-4.6': { requests: { count: 4 }, usage: { inputTokens: 99_999, outputTokens: 999, cacheReadTokens: 1, cacheWriteTokens: 1 } } },
      agentMetrics: { main: { modelMetrics: { 'claude-sonnet-4.6': { requests: { count: 3 }, usage: { inputTokens: 33_000, outputTokens: 100, cacheReadTokens: 20_000, cacheWriteTokens: 12_000 } } } } },
    })] : []),
  ]
}

test('merges chunks of one call, leaves sub-agents out and keeps tool results', () => {
  const entries = copilotEntries(events(), FILE)
  assert.equal(entries[0].id, 'cp1')
  assert.equal(entries[0].cwd, '/repo')
  const roles = entries.slice(1).map((entry) => (entry.message as { role: string }).role)
  assert.deepEqual(roles, ['user', 'assistant', 'toolResult', 'assistant', 'user', 'assistant'])
  const first = entries[2].message as { content: { type: string }[] }
  assert.deepEqual(first.content.map((block) => block.type), ['text', 'toolCall'])
})

test('spreads the main agent\'s run totals over its calls, growing with the conversation', () => {
  const facts = analyzeCopilotSession(events(), FILE)
  assert.ok(facts)
  assert.equal(facts.source, 'copilot')
  assert.equal(facts.calls, 3)
  assert.deepEqual(facts.cacheModels, ['copilot-cli/claude-sonnet-4.6'])
  const calls = facts.cacheCalls
  const prompt = (call: (typeof calls)[number]): number => call[2] + call[3] + call[4]
  // Input includes reads and writes, OpenAI style: 33,000 prompt tokens in all.
  assert.ok(Math.abs(calls.reduce((sum, call) => sum + prompt(call), 0) - 33_000) < 1e-6)
  assert.ok(Math.abs(calls.reduce((sum, call) => sum + call[3], 0) - 20_000) < 1e-6)
  // The tool result grew the second prompt.
  assert.ok(prompt(calls[1]) > prompt(calls[0]))
  assert.ok(calls.every((call) => call[10] === 1))
  assert.equal(facts.output, 100)
  assert.ok(facts.cost > 0)
})

test('estimated calls are replayed but kept out of the measured cache charts', () => {
  const facts = analyzeCopilotSession(events(), FILE)
  assert.ok(facts)
  const [model] = buildCacheReport([facts]).models
  assert.equal(model.route, 'copilot')
  assert.equal(model.estimatedCalls, 3)
  assert.equal(model.observed, null)
  assert.ok(model.policies.length > 0)
})

test('a run with no shutdown keeps the rebuilt sizes and reads back warm prompts', () => {
  const facts = analyzeCopilotSession(events(false), FILE)
  assert.ok(facts)
  const [first, second, third] = facts.cacheCalls
  assert.equal(first[3], 0)
  // A minute later: warm. Twenty minutes later: past Claude's five.
  assert.ok(second[3] > 0)
  assert.equal(third[3], 0)
})
