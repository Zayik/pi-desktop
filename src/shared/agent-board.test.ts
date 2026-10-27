import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boardTotals, childIsRunning, costSince, currentBranch, snapshotFromSummary, summarizeSession, type AgentSessionSummary } from './agent-board'
import { cacheState } from './context-view'

const T0 = Date.parse('2026-10-24T10:00:00.000Z')

function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString()
}

function assistant(id: string, parentId: string | null, offsetMs: number, model: string, tools: string[] = []): Record<string, unknown> {
  return {
    type: 'message', id, parentId, timestamp: iso(offsetMs),
    message: {
      role: 'assistant', provider: 'anthropic', model, timestamp: T0 + offsetMs,
      content: [{ type: 'text', text: 'done' }, ...tools.map((name) => ({ type: 'toolCall', name, arguments: {} }))],
      usage: { input: 10, output: 100, cacheRead: 900, cacheWrite: 90, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
    },
  }
}

function user(id: string, parentId: string | null, offsetMs: number, text: string): Record<string, unknown> {
  return { type: 'message', id, parentId, timestamp: iso(offsetMs), message: { role: 'user', content: [{ type: 'text', text }] } }
}

const header = { type: 'session', id: 'sess-1', timestamp: iso(0), cwd: '/repo/wt-a', parentSession: '/s/main.jsonl' }

test('summarizes cost, models, tools and active time from a session file', () => {
  const entries = [
    header,
    user('u1', null, 1_000, '  \nImplement task 3\nmore'),
    assistant('a1', 'u1', 5_000, 'claude-sonnet-5-5', ['read', 'bash']),
    // Ten idle minutes are not active time.
    user('u2', 'a1', 605_000, 'next'),
    assistant('a2', 'u2', 610_000, 'claude-haiku-5-5', ['edit']),
  ]
  const summary = summarizeSession(entries, '/s/child.jsonl')
  assert.ok(summary)
  assert.equal(summary.sessionId, 'sess-1')
  assert.equal(summary.cwd, '/repo/wt-a')
  assert.equal(summary.parentSession, '/s/main.jsonl')
  assert.equal(summary.label, 'Implement task 3')
  assert.equal(summary.calls, 2)
  assert.equal(summary.turns, 2)
  assert.ok(Math.abs(summary.cost - 0.02) < 1e-12)
  assert.equal(summary.toolCalls, 3)
  assert.equal(summary.lastTool, 'edit')
  assert.equal(summary.activeMs, 1_000 + 4_000 + 5_000)
  assert.deepEqual(summary.models.map((model) => model.model).sort(), ['claude-haiku-5-5', 'claude-sonnet-5-5'])
  assert.equal(summary.lastCall?.model, 'claude-haiku-5-5')
  assert.equal(summary.contextTokens, 10 + 900 + 90 + 100)
  assert.ok(summary.breakdown?.fromSession)
  assert.ok(summary.breakdown?.categories.some((category) => category.id === 'user-messages'))
})

test('needs a session header', () => {
  assert.equal(summarizeSession([user('u1', null, 0, 'hi')], '/x.jsonl'), null)
})

test('the context follows the current branch, while every branch is billed', () => {
  const entries = [
    header,
    user('u1', null, 1_000, 'start'),
    assistant('a1', 'u1', 2_000, 'm'),
    user('u2', 'a1', 3_000, 'abandoned branch'),
    assistant('a2', 'u2', 4_000, 'm'),
    user('u3', 'a1', 5_000, 'current branch'),
  ]
  assert.deepEqual(currentBranch(entries).map((entry) => entry.id), ['u1', 'a1', 'u3'])
  const summary = summarizeSession(entries, '/x.jsonl')
  assert.equal(summary?.calls, 2)
  const users = summary?.breakdown?.categories.find((category) => category.id === 'user-messages')
  assert.ok(users?.items.every((item) => item.label !== 'abandoned branch'))
})

test('after a compaction the breakdown holds its summary and the kept messages', () => {
  const entries = [
    header,
    user('u1', null, 1_000, 'old work'),
    assistant('a1', 'u1', 2_000, 'm'),
    user('u2', 'a1', 3_000, 'kept'),
    { type: 'compaction', id: 'c1', parentId: 'u2', timestamp: iso(4_000), summary: 'Summary of old work', firstKeptEntryId: 'u2', tokensBefore: 5000 },
    assistant('a2', 'c1', 5_000, 'm'),
  ]
  const breakdown = summarizeSession(entries, '/x.jsonl')?.breakdown
  const ids = breakdown?.categories.map((category) => category.id) ?? []
  assert.ok(ids.includes('compacted'))
  const users = breakdown?.categories.find((category) => category.id === 'user-messages')
  assert.deepEqual(users?.items.map((item) => item.label), ['kept'])
})

function summary(overrides: Partial<AgentSessionSummary>): AgentSessionSummary {
  return {
    sessionId: 's', sessionFile: '/s.jsonl', cwd: null, parentSession: null, label: null, name: null, thinkingLevel: null, selectedModel: null, delegateRuns: [], startedAt: 0, lastActivityAt: 0,
    activeMs: 0, turns: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, models: [], toolCalls: 0,
    lastTool: null, lastCall: null, lastRequestAt: null, turnStartedAt: null, turnCalls: [], callCosts: [],
    contextTokens: null, breakdown: null, ...overrides,
  }
}

test('totals every agent and merges usage per model', () => {
  const model = { provider: 'p', model: 'm1', calls: 1, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 }
  const totals = boardTotals([
    summary({ cost: 0.5, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, activeMs: 10, models: [model] }),
    summary({ cost: 1.5, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, activeMs: 20, models: [model, { ...model, model: 'm2', cost: 1 }] }),
  ])
  assert.equal(totals.cost, 2)
  assert.equal(totals.tokensIn, 16)
  assert.equal(totals.tokensOut, 4)
  assert.equal(totals.activeMs, 30)
  assert.deepEqual(totals.models.map((entry) => [entry.model, entry.agents, entry.calls]), [['m1', 2, 2], ['m2', 1, 1]])
})

test('a child without a task runs while it wrote recently', () => {
  assert.equal(childIsRunning(summary({ lastActivityAt: 1_000 }), null, 10_000), true)
  assert.equal(childIsRunning(summary({ lastActivityAt: 1_000 }), null, 100_000), false)
  assert.equal(childIsRunning(summary({ lastActivityAt: 1_000 }), false, 2_000), false)
})

test('records the request time, the turn, and builds a snapshot for the cache and billing views', () => {
  const entries = [
    header,
    user('u1', null, 1_000, 'first'),
    assistant('a1', 'u1', 5_000, 'm'),
    user('u2', 'a1', 20_000, 'second'),
    assistant('a2', 'u2', 30_000, 'm'),
  ]
  const result = summarizeSession(entries, '/x.jsonl')
  assert.ok(result)
  assert.equal(result.lastRequestAt, T0 + 20_000)
  assert.equal(result.turnStartedAt, T0 + 20_000)
  assert.equal(result.turnCalls.length, 1)
  assert.equal(costSince(result, T0 + 10_000), 0.01)
  const model = { provider: 'anthropic', id: 'm', name: 'M', contextWindow: 1000, maxTokens: null, rates: null, promptCache: { short: 300 } }
  const borrowed = snapshotFromSummary(result, model, 'short')
  assert.equal(borrowed.model?.contextWindow, 1000)
  assert.equal(cacheState(borrowed, T0 + 80_000).remainingMs, 240_000)
  const unknown = snapshotFromSummary(result, { ...model, id: 'other' }, 'short')
  assert.equal(unknown.model?.contextWindow, null)
  assert.equal(cacheState(unknown, T0 + 80_000).status, 'unknown')
})

test('keeps the latest effort and selected model', () => {
  const entries = [
    header,
    { type: 'thinking_level_change', id: 't1', parentId: null, timestamp: iso(100), thinkingLevel: 'medium' },
    { type: 'model_change', id: 'm1', parentId: 't1', timestamp: iso(200), provider: 'anthropic', modelId: 'claude-sonnet-5-5' },
    { type: 'thinking_level_change', id: 't2', parentId: 'm1', timestamp: iso(300), thinkingLevel: 'high' },
  ]
  const result = summarizeSession(entries, '/x.jsonl')
  assert.equal(result?.thinkingLevel, 'high')
  assert.deepEqual(result?.selectedModel, { provider: 'anthropic', model: 'claude-sonnet-5-5' })
})

test('time spent waiting on a running tool counts as active', () => {
  const entries = [
    header,
    user('u1', null, 1_000, 'run the tests'),
    assistant('a1', 'u1', 2_000, 'm', ['bash']),
    // A ten-minute test run, then the reply.
    { type: 'message', id: 't1', parentId: 'a1', timestamp: iso(602_000), message: { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'ok' }] } },
    assistant('a2', 't1', 605_000, 'm'),
  ]
  assert.equal(summarizeSession(entries, '/x.jsonl')?.activeMs, 1_000 + 1_000 + 600_000 + 3_000)
})

test('keeps the subagent questions this session has not answered', () => {
  const ask = (id: string, offsetMs: number) => ({
    type: 'custom_message', id, parentId: null, timestamp: iso(offsetMs), customType: 'subagent_supervisor_request', display: true, content: 'q',
    details: { id, requestId: id, expectsReply: true, runId: 'run-abc', agent: 'worker', childIndex: 0, requestBody: `question ${id}` },
  })
  const entries = [
    header,
    ask('q1', 1_000),
    ask('q2', 2_000),
    { type: 'custom', id: 'r1', parentId: null, timestamp: iso(3_000), customType: 'subagent_supervisor_reply', data: { requestId: 'q1' } },
  ]
  assert.deepEqual(summarizeSession(entries, '/x.jsonl')?.openQuestions?.map((question) => question.body), ['question q2'])
})

test('counts Pi\'s idle pings in the cost but not as calls or active time', () => {
  const ping = (id: string, parentId: string, offsetMs: number): Record<string, unknown> => ({
    type: 'usage', id, parentId, timestamp: iso(offsetMs), kind: 'cache_warm', provider: 'anthropic', model: 'claude-sonnet-5-5',
    usage: { input: 0, output: 1, cacheRead: 990, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 } },
  })
  const entries = [
    header,
    user('u1', null, 1_000, 'go'),
    assistant('a1', 'u1', 5_000, 'claude-sonnet-5-5'),
    ping('w1', 'a1', 275_000),
    ping('w2', 'w1', 545_000),
  ]
  const summary = summarizeSession(entries, '/s/child.jsonl')
  assert.ok(summary)
  assert.equal(summary.calls, 1)
  assert.ok(Math.abs(summary.cost - 0.014) < 1e-9)
  assert.equal(summary.activeMs, 5_000)
  assert.equal(summary.pings?.count, 2)
  assert.deepEqual(summary.models.map((model) => [model.model, model.calls]), [['claude-sonnet-5-5', 1]])
  const snapshot = snapshotFromSummary(summary, null, 'short')
  assert.equal(snapshot.lastWarmAt, T0 + 545_000)
  assert.equal(snapshot.pings?.count, 2)
})
