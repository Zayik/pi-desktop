import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTEXT_SNAPSHOT_VERSION, emptyTotals, type ContextSnapshot, type ModelCall } from '../../resources/context-snapshot'
import {
  billingTable,
  cacheHitRate,
  cacheState,
  contextIsHigh,
  contextTokens,
  effectiveRates,
  nextCallEstimate,
  pingStatus,
  turnCalls,
} from './context-view'

const MODEL = {
  provider: 'anthropic',
  id: 'claude-haiku-5-5',
  name: 'Claude Haiku 5.5',
  contextWindow: 200_000,
  maxTokens: 64_000,
  rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  promptCache: { short: 300, long: 3600 },
}

function call(at: number, overrides: Partial<ModelCall> = {}): ModelCall {
  return {
    at,
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    input: 10,
    output: 100,
    cacheRead: 9_000,
    cacheWrite: 1_000,
    // Billed at 2 / 0.2 / 2.5 / 10 per million: above the listed rates.
    cost: { input: 0.00002, output: 0.001, cacheRead: 0.0018, cacheWrite: 0.0025, total: 0.00532 },
    ...overrides,
  }
}

function snapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    version: CONTEXT_SNAPSHOT_VERSION,
    sessionId: 's',
    sessionFile: null,
    updatedAt: 0,
    model: MODEL,
    cacheRetention: 'short',
    cacheWarming: 'streaming',
    breakdown: null,
    reportedTokens: null,
    calls: [call(1_000)],
    totals: emptyTotals(),
    turnStartedAt: 500,
    lastRequestAt: 900,
    lastWarmAt: null,
    ...overrides,
  }
}

test('counts down from the last request with the active tier lifetime', () => {
  const state = cacheState(snapshot(), 900 + 60_000)
  assert.equal(state.status, 'warm')
  assert.equal(state.lifetimeSeconds, 300)
  assert.equal(state.expiresAt, 900 + 300_000)
  assert.equal(state.remainingMs, 240_000)
})

test('turns expiring in the last minute and cold after the lifetime', () => {
  assert.equal(cacheState(snapshot(), 900 + 250_000).status, 'expiring')
  const cold = cacheState(snapshot(), 900 + 300_000)
  assert.equal(cold.status, 'cold')
  assert.equal(cold.remainingMs, 0)
})

test('a warming refresh restarts the countdown', () => {
  const state = cacheState(snapshot({ lastWarmAt: 200_000 }), 400_000)
  assert.equal(state.status, 'warm')
  assert.equal(state.remainingMs, 100_000)
})

test('uses the long tier lifetime when requests ask for long retention', () => {
  assert.equal(cacheState(snapshot({ cacheRetention: 'long' }), 900 + 1_000_000).status, 'warm')
})

test('has no countdown without calls, without a lifetime, or after a model switch', () => {
  assert.equal(cacheState(snapshot({ calls: [], lastRequestAt: null }), 1).status, 'none')
  assert.equal(cacheState(snapshot({ model: { ...MODEL, promptCache: null } }), 1).status, 'unknown')
  assert.equal(cacheState(snapshot({ model: { ...MODEL, id: 'claude-sonnet-5-5' } }), 1).status, 'model-changed')
})

test('the context resent next prefers Pi figure, then the last call, then the estimate', () => {
  assert.equal(contextTokens(snapshot({ reportedTokens: 12_345 })), 12_345)
  assert.equal(contextTokens(snapshot()), 10 + 9_000 + 1_000 + 100)
  const breakdown = { capturedAt: 0, estimatedTokens: 777, categories: [] }
  assert.equal(contextTokens(snapshot({ calls: [], breakdown })), 777)
})

test('prefers the rates calls were billed at over the listed ones', () => {
  const rates = effectiveRates(snapshot())
  assert.ok(rates)
  assert.ok(Math.abs(rates.cacheRead - 0.2) < 1e-9)
  assert.ok(Math.abs(rates.cacheWrite - 2.5) < 1e-9)
  assert.deepEqual(effectiveRates(snapshot({ calls: [] })), MODEL.rates)
  assert.equal(effectiveRates(snapshot({ calls: [], model: null })), null)
})

test('estimates the next call warm at the read rate and cold at the write rate', () => {
  const estimate = nextCallEstimate(snapshot({ reportedTokens: 100_000 }))
  assert.ok(estimate.warm !== null && Math.abs(estimate.warm - 0.02) < 1e-9)
  assert.ok(estimate.cold !== null && Math.abs(estimate.cold - 0.25) < 1e-9)
})

test('a turn is every call since the latest user prompt', () => {
  const calls = [call(100), call(600), call(700)]
  assert.deepEqual(turnCalls(snapshot({ calls })).map((entry) => entry.at), [600, 700])
  assert.deepEqual(turnCalls(snapshot({ calls, turnStartedAt: null })), [])
})

test('the billing table totals the last call and the turn', () => {
  const table = billingTable(snapshot({ calls: [call(100), call(600), call(700)] }))
  assert.equal(table.turnCallCount, 2)
  assert.ok(Math.abs(table.lastTotal - 0.00532) < 1e-12)
  assert.ok(Math.abs(table.turnTotal - 0.01064) < 1e-12)
  const cacheRead = table.rows.find((row) => row.kind === 'cacheRead')
  assert.equal(cacheRead?.lastTokens, 9_000)
  assert.equal(cacheRead?.turnTokens, 18_000)
  assert.deepEqual(table.rows.map((row) => row.kind), ['input', 'cacheRead', 'cacheWrite', 'output'])
})

test('hit rate is the cached share of the prompt', () => {
  assert.equal(cacheHitRate(call(1)), 9_000 / 10_010)
  assert.equal(cacheHitRate(call(1, { input: 0, cacheRead: 0, cacheWrite: 0 })), null)
})

test('flags a context at 70% of the window or 300k tokens', () => {
  assert.equal(contextIsHigh(139_999, 200_000), false)
  assert.equal(contextIsHigh(140_000, 200_000), true)
  assert.equal(contextIsHigh(300_000, 1_000_000), true)
  assert.equal(contextIsHigh(null, 200_000), false)
})

test('idle pings: counts the ones sent since the prompt and times the next at 90% of the lifetime', () => {
  const idle = snapshot({
    cacheWarming: 'idle',
    pingPlan: { setting: 3, stopped: false },
    pings: { count: 2, cost: 0.003, recent: [[200, 0.001], [271_000, 0.002]] },
    lastWarmAt: 271_000,
  })
  const status = pingStatus(idle, 300_000)
  assert.ok(status)
  assert.equal(status.mode, 'planned')
  assert.equal(status.planned, 3)
  // The ping at 200 came before this turn's prompt (500).
  assert.equal(status.sent, 1)
  assert.equal(status.sentCost, 0.002)
  assert.equal(status.totalCount, 2)
  assert.equal(status.price, 0.002)
  assert.equal(status.nextAt, 271_000 + 270_000)
})

test('idle pings: none come once the setting is used up, stopped, or warming is not idle', () => {
  const base = { cacheWarming: 'idle', pings: { count: 1, cost: 0.001, recent: [[1_100, 0.001]] as [number, number][] }, lastWarmAt: 1_100 }
  assert.equal(pingStatus(snapshot({ ...base, pingPlan: { setting: 1, stopped: false } }), 2_000)?.nextAt, null)
  const stopped = pingStatus(snapshot({ ...base, pingPlan: { setting: 3, stopped: true } }), 2_000)
  assert.equal(stopped?.stopped, true)
  assert.equal(stopped?.nextAt, null)
  assert.equal(pingStatus(snapshot({ ...base, pingPlan: { setting: 'long', stopped: false } }), 2_000)?.mode, 'long')
  const streaming = pingStatus(snapshot({ pingPlan: { setting: 3, stopped: false } }), 2_000)
  assert.equal(streaming?.mode, 'off')
  assert.equal(streaming?.nextAt, null)
  assert.equal(pingStatus(snapshot({ ...base, pingPlan: { setting: 3, stopped: false }, agentRunning: true }), 2_000)?.nextAt, null)
})

test('idle pings: without a setting Pi pings only when its price rule pays', () => {
  // About 10K tokens: a miss costs cents at most, below Pi's five-cent bar.
  const small = pingStatus(snapshot({ cacheWarming: 'idle' }), 2_000)
  assert.equal(small?.mode, 'pi')
  assert.equal(small?.nextAt, null)
  const large = pingStatus(snapshot({ cacheWarming: 'idle', reportedTokens: 2_000_000 }), 2_000)
  assert.equal(large?.nextAt, 900 + 270_000)
})

test('idle pings: Pi stops 30 minutes after the last real request', () => {
  const late = snapshot({ cacheWarming: 'idle', pingPlan: { setting: 6, stopped: false }, lastWarmAt: 900 + 29 * 60_000 })
  assert.equal(pingStatus(late, 900 + 29 * 60_000 + 1_000)?.nextAt, null)
})
