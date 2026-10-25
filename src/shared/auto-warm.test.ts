import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_AUTO_WARMS, MAX_IDLE_WARMS, autoWarmLimit, isAutoWarmSchedule } from '../../resources/context-snapshot'
import { buildAutoWarmSchedule } from './auto-warm'
import { buildCacheReport, MAX_SWEEP_PINGS } from './cache-policy'
import { SESSION_ANALYTICS_VERSION, type CacheCall, type SessionAnalytics } from './session-analytics'

const PRICE = 3e-6
const SONNET = 'anthropic/claude-sonnet-5-5'

function call(at: number, prompt: number, first = false, model = 0): CacheCall {
  const read = first ? 0 : prompt - 1000
  const write = prompt - read
  return [at, model, 0, read, write, 0, 0, read * PRICE * 0.1, write * PRICE * 1.25]
}

function session(calls: CacheCall[], models = [SONNET]): SessionAnalytics {
  return {
    version: SESSION_ANALYTICS_VERSION, sessionId: 's', sessionFile: '/s.jsonl', cwd: null, parentSession: null, name: null, label: null,
    startedAt: 0, lastActivityAt: 0, activeMs: 0, turns: 0, calls: calls.length, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    compactions: 0, models: [], tools: [], categories: [], skills: [], testRuns: [], slowCalls: [], failedCommands: [], turnFacts: [],
    days: {}, delegateRuns: [], cacheModels: models, cacheCalls: calls, warmPings: 0, warmCost: 0,
  }
}

const at = (day: number, hour: number, minute: number): number => new Date(2026, 9, 20 + day, hour, minute).getTime()

/** Five days of a lunch break from 13:30, a 20 minute gap from 14:40 and 12 minute gaps through 15:00-16:00. */
function workdays(): SessionAnalytics[] {
  return [0, 1, 2, 3, 4].map((day) => {
    const times = [at(day, 13, 30), at(day, 14, 40), at(day, 15, 0), at(day, 15, 12), at(day, 15, 24), at(day, 15, 36), at(day, 15, 48), at(day, 16, 0)]
    return session(times.map((time, index) => call(time, 40_000 + index * 500, index === 0)))
  })
}

test('the extension accepts as many pings as the sweep tries', () => {
  assert.ok(MAX_AUTO_WARMS >= MAX_SWEEP_PINGS)
})

test('plans each hour on its cheapest count and other hours on the best fixed count', () => {
  const report = buildCacheReport([...workdays(), session(Array.from({ length: 12 }, (_, index) => call(index * 60_000, 5_000, index === 0)), ['google/gemini-4-argon'])])
  const schedule = buildAutoWarmSchedule(report, 1000, 30)
  assert.ok(isAutoWarmSchedule(schedule))
  const plan = schedule.models[SONNET]
  assert.equal(plan.length, 24)
  assert.equal(plan[13], 0)
  assert.equal(plan[14], 4)
  assert.equal(plan[15], 2)
  assert.equal(plan[9], 4, 'an hour without breaks keeps the best fixed count')
  assert.deepEqual(schedule.fallback, plan)
  assert.equal(schedule.models['google/gemini-4-argon'], undefined, 'no sweep, no plan')
})

test('plans Copilot and OpenAI models on their own cache lifetimes', () => {
  const copilot = 'github-copilot/claude-sonnet-5-5'
  const openai = 'openai/gpt-6.1'
  const schedule = buildAutoWarmSchedule(buildCacheReport([
    ...workdays().map((facts) => ({ ...facts, cacheModels: [copilot] })),
    ...workdays().map((facts) => ({ ...facts, cacheModels: [openai] })),
  ]), 1000, 30)
  assert.ok(isAutoWarmSchedule(schedule))
  assert.equal(schedule.models[copilot]?.[15], 2)
  assert.ok(schedule.models[openai])
  assert.deepEqual(schedule.fallback, schedule.models[copilot], 'only a 5-minute plan stands in for other models')
})

test('looks up the hour the break starts in, falling back to the main plan and then to keep warm', () => {
  const schedule = buildAutoWarmSchedule(buildCacheReport(workdays()), 1000, 30)
  assert.equal(autoWarmLimit(schedule, SONNET, at(9, 15, 20)), 2)
  assert.equal(autoWarmLimit(schedule, SONNET, at(9, 13, 59)), 0)
  assert.equal(autoWarmLimit(schedule, 'anthropic/claude-opus-5-5', at(9, 14, 5)), 4)
  assert.equal(autoWarmLimit(null, SONNET, at(9, 15, 20)), MAX_IDLE_WARMS)
  assert.equal(autoWarmLimit(buildAutoWarmSchedule(buildCacheReport([]), 1000, 30), SONNET, at(9, 15, 20)), MAX_IDLE_WARMS)
})

test('rejects a schedule with an hour out of range', () => {
  const schedule = buildAutoWarmSchedule(buildCacheReport(workdays()), 1000, 30)
  assert.equal(isAutoWarmSchedule({ ...schedule, models: { [SONNET]: new Array(24).fill(MAX_AUTO_WARMS + 1) } }), false)
  assert.equal(isAutoWarmSchedule({ ...schedule, fallback: [1, 2] }), false)
})
