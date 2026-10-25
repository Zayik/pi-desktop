import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReport, rangeStart, type IndexedSession } from './analytics-report'
import { retroDigest, retroPrompt } from './retro-digest'
import { localDayKey, SESSION_ANALYTICS_VERSION, type SessionAnalytics } from './session-analytics'

const DAY = 86_400_000
const NOW = new Date(2026, 9, 24, 15, 0, 0).getTime()
const MINUTE = 60_000

function facts(id: string, at: number, overrides: Partial<SessionAnalytics> = {}): SessionAnalytics {
  return {
    version: SESSION_ANALYTICS_VERSION,
    sessionId: id,
    sessionFile: `/s/${id}.jsonl`,
    cwd: '/repo',
    parentSession: null,
    name: null,
    label: `work ${id}`,
    startedAt: at,
    lastActivityAt: at + 60 * MINUTE,
    activeMs: 60 * MINUTE,
    turns: 2,
    calls: 10,
    cost: 1,
    input: 100,
    output: 100,
    cacheRead: 1000,
    cacheWrite: 100,
    compactions: 0,
    models: [{ provider: 'anthropic', model: 'claude-sonnet-5-5', calls: 10, input: 100, output: 100, cacheRead: 1000, cacheWrite: 100, cost: 1 }],
    tools: [{ tool: 'bash', category: 'test', calls: 6, errors: 2, durationMs: 30 * MINUTE, resultTokens: 9000, carriedCost: 0.4 }],
    categories: [{ category: 'test', calls: 6, errors: 2, durationMs: 30 * MINUTE, resultTokens: 9000, carriedCost: 0.4 }],
    skills: [],
    testRuns: Array.from({ length: 6 }, (_, index) => ({ at: at + index * MINUTE, command: 'npm test', durationMs: 5 * MINUTE, failed: index < 2 })),
    slowCalls: [{ at, tool: 'bash', category: 'test', detail: 'npm test', durationMs: 5 * MINUTE, failed: false }],
    failedCommands: [{ command: 'npm test', category: 'test', failures: 2 }],
    turnFacts: [{ startedAt: at, durationMs: 40 * MINUTE, cost: 0.8, calls: 8, toolCalls: 6, label: `work ${id}` }],
    days: { [localDayKey(at)]: { cost: 1, calls: 10, activeMs: 60 * MINUTE } },
    delegateRuns: [],
    cacheModels: [],
    cacheCalls: [],
    warmPings: 0,
    warmCost: 0,
    ...overrides,
  }
}

const indexed = (value: SessionAnalytics, kind: IndexedSession['kind'] = 'main'): IndexedSession => ({ kind, agentName: null, fileExists: true, facts: value })

test('merges sessions and finds the test loop eating the time', () => {
  const report = buildReport('overall', [indexed(facts('a', NOW - DAY)), indexed(facts('b', NOW - 2 * DAY))], rangeStart('7', NOW), NOW)
  assert.equal(report.sessions, 2)
  assert.equal(report.cost, 2)
  assert.equal(report.tests.runs, 12)
  assert.equal(report.tests.failed, 4)
  assert.equal(report.tests.medianMs, 5 * MINUTE)
  assert.equal(report.tests.shareOfActive, 0.5)
  assert.equal(report.failedCommands[0].failures, 4)
  assert.equal(report.days.length, 7)
  const ids = report.signals.map((signal) => signal.id)
  assert.ok(ids.includes('test-time'))
  assert.ok(ids.includes('test-reruns'))
  assert.ok(ids.includes('slow-tests'))
  assert.ok(ids.includes('failing-command'))
  assert.ok(ids.includes('carried-tool'))
  assert.equal(report.signals[0].severity, 'high')
})

test('a window counts only the cost of its own days', () => {
  const twoDays = facts('a', NOW - 10 * DAY, {
    days: { [localDayKey(NOW - 10 * DAY)]: { cost: 3, calls: 5, activeMs: MINUTE }, [localDayKey(NOW - DAY)]: { cost: 1, calls: 5, activeMs: MINUTE } },
  })
  const report = buildReport('overall', [indexed(twoDays)], rangeStart('7', NOW), NOW)
  assert.equal(report.cost, 1)
})

test('a session report leads with the main session and sums its subagents', () => {
  const report = buildReport('session', [indexed(facts('child', NOW), 'subagent'), indexed(facts('main', NOW))])
  assert.equal(report.sessionRows[0].kind, 'main')
  assert.equal(report.subagentCost, 1)
  assert.ok(report.signals.some((signal) => signal.id === 'subagent-share'))
})

test('the digest carries the numbers and the retro prompt runs the skill', () => {
  const report = buildReport('session', [indexed(facts('main', NOW))])
  const digest = retroDigest(report, 'Add export')
  assert.match(digest, /Scope: one session \("Add export"\)/)
  assert.match(digest, /Tests took 50% of active time/)
  assert.match(digest, /\| test \| 6 \| 2 \| 30m \| 50% \| \$0\.40 \|/)
  assert.match(digest, /6 run\(s\) in 1 session\(s\), 2 failed/)
  assert.ok(retroPrompt(digest).startsWith('/skill:pi-retro '))
})
