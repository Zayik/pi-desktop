import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeClaudeCodeSession, claudeCodeEntries } from './claude-code-session'
import { isImportedModel } from './import-sources'
import { anthropicCost, anthropicPrice } from './anthropic-prices'

const T0 = Date.parse('2026-10-20T10:00:00Z')
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString()
const FILE = '/home/me/.claude/projects/-repo/s1.jsonl'

function usage(read: number, write: number, write1h = 0): Record<string, unknown> {
  return {
    input_tokens: 2, output_tokens: 100, cache_read_input_tokens: read, cache_creation_input_tokens: write,
    cache_creation: { ephemeral_5m_input_tokens: write - write1h, ephemeral_1h_input_tokens: write1h },
  }
}

/** A prompt, a response written as two lines (text, then a tool call), its tool result, and a second response. */
function transcript(): Record<string, unknown>[] {
  const base = { sessionId: 's1', cwd: '/repo', isSidechain: false }
  return [
    { ...base, type: 'user', uuid: 'u1', parentUuid: null, timestamp: at(0), message: { role: 'user', content: 'fix the tests' } },
    { ...base, type: 'user', uuid: 'meta', parentUuid: 'u1', timestamp: at(0), isMeta: true, message: { role: 'user', content: 'caveat' } },
    {
      ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: at(5),
      message: { id: 'msg_1', model: 'claude-sonnet-4-6', role: 'assistant', content: [{ type: 'text', text: 'Running them.' }], usage: usage(0, 10_000) },
    },
    {
      ...base, type: 'assistant', uuid: 'a2', parentUuid: 'a1', timestamp: at(6),
      message: { id: 'msg_1', model: 'claude-sonnet-4-6', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }], usage: usage(0, 10_000) },
    },
    {
      ...base, type: 'user', uuid: 'r1', parentUuid: 'a2', timestamp: at(66),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] },
    },
    {
      ...base, type: 'assistant', uuid: 'a3', parentUuid: 'r1', timestamp: at(70),
      message: { id: 'msg_2', model: 'claude-sonnet-4-6', role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage: usage(10_000, 500, 500) },
    },
  ]
}

test('merges the lines of one response and keeps the tree', () => {
  const entries = claudeCodeEntries(transcript(), FILE)
  assert.equal(entries[0].type, 'session')
  assert.equal(entries[0].id, 's1')
  const messages = entries.slice(1).map((entry) => (entry.message as { role: string }).role)
  assert.deepEqual(messages, ['user', 'assistant', 'toolResult', 'assistant'])
  const assistant = entries[2] as { id: string; timestamp: string; message: { content: { type: string }[] } }
  assert.deepEqual(assistant.message.content.map((block) => block.type), ['text', 'toolCall'])
  assert.equal(assistant.timestamp, at(6))
  // The tool result's parent was the second line; it points at the merged entry.
  assert.equal(entries[3].parentId, 'a1')
})

test('prices calls at list price and keeps the one-hour part of writes', () => {
  const facts = analyzeClaudeCodeSession(transcript(), FILE)
  assert.ok(facts)
  assert.equal(facts.source, 'claude-code')
  assert.equal(facts.calls, 2)
  assert.deepEqual(facts.cacheModels, ['claude-code/claude-sonnet-4-6'])
  assert.equal(facts.cacheCalls.length, 2)
  const [first, second] = facts.cacheCalls
  assert.equal(first[4], 10_000)
  assert.equal(first[5], 0)
  assert.equal(second[3], 10_000)
  assert.equal(second[5], 500)
  // Sonnet 4.6: $3 input, writes 1.25x (5 min) and 2x (1 hour), reads 0.1x.
  assert.ok(Math.abs(first[8] - 10_000 * 3e-6 * 1.25) < 1e-9)
  assert.ok(Math.abs(second[7] - 10_000 * 3e-6 * 0.1) < 1e-9)
  assert.ok(Math.abs(second[8] - 500 * 3e-6 * 2) < 1e-9)
  assert.equal(facts.tools[0].tool, 'Bash')
  assert.equal(facts.tools[0].category, 'test')
  assert.equal(facts.turns, 1)
})

test('lines copied from a resumed session count as inherited', () => {
  const copied = transcript().map((line) => ({ ...line, sessionId: 's0' }))
  const own = {
    sessionId: 's1', cwd: '/repo', type: 'assistant', uuid: 'a9', parentUuid: 'a3', timestamp: at(600),
    message: { id: 'msg_9', model: 'claude-sonnet-4-6', role: 'assistant', content: [], usage: usage(10_000, 100) },
  }
  const facts = analyzeClaudeCodeSession([...copied, own], FILE)
  assert.ok(facts)
  assert.equal(facts.parentSession, 's0')
  assert.equal(facts.calls, 1)
})

test('subagent files are their own session', () => {
  const lines = transcript().map((line) => ({ ...line, isSidechain: true }))
  const entries = claudeCodeEntries(lines, '/home/me/.claude/projects/-repo/s1/subagents/agent-a7.jsonl')
  assert.equal(entries[0].id, 'agent-a7')
  assert.equal(entries[0].parentSession, undefined)
  assert.equal(entries.length, 5)
  // In the main file, sidechain lines are left out.
  assert.equal(claudeCodeEntries(lines, FILE).length, 0)
})

test('imported models are told apart from Pi models', () => {
  assert.equal(isImportedModel('claude-code/claude-opus-5-5'), true)
  assert.equal(isImportedModel('anthropic/claude-opus-5-5'), false)
})

test('list prices by model id', () => {
  assert.equal(anthropicPrice('claude-opus-5-5')?.input, 4)
  assert.equal(anthropicPrice('claude-opus-4-5-20251101')?.input, 5)
  assert.equal(anthropicPrice('claude-opus-4-1-20250805')?.input, 15)
  assert.equal(anthropicPrice('claude-3-7-sonnet-20250219')?.input, 3)
  assert.equal(anthropicPrice('claude-sonnet-5-5')?.readRatio, 0.05)
  assert.equal(anthropicPrice('claude-sonnet-5')?.readRatio, 0.1)
  assert.equal(anthropicPrice('claude-fable-5-1')?.readRatio, 0.025)
  assert.equal(anthropicPrice('claude-haiku-4-5-20251001')?.input, 1)
  assert.equal(anthropicPrice('gpt-6'), null)
  const long = anthropicCost('claude-haiku-5-5', { input: 200_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 })
  assert.ok(long && Math.abs(long.input - 0.1) < 1e-9)
  const fast = anthropicCost('claude-opus-5-5', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, fast: true })
  assert.equal(fast?.total, 8)
})
