import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SLOTS_PER_DAY, buildCacheAnalysis, pingSeries, slotBest, summarize, weekSplit } from './cache-analysis'
import { SESSION_ANALYTICS_VERSION, type CacheCall, type SessionAnalytics } from './session-analytics'

const MINUTE = 60_000
const PRICE = 3e-6
const DAY_ONE = new Date(2026, 9, 5).getTime()

/** A call with a `prompt`-token prompt read from the cache after the first, at Anthropic's 5m list prices. */
function call(at: number, prompt: number, first = false, model = 0): CacheCall {
  const read = first ? 0 : prompt - 1000
  const write = prompt - read
  return [at, model, 0, read, write, 0, 0, read * PRICE * 0.1, write * PRICE * 1.25]
}

function session(calls: CacheCall[], models = ['anthropic/claude-sonnet-5-5']): SessionAnalytics {
  return {
    version: SESSION_ANALYTICS_VERSION, sessionId: 's', sessionFile: '/s.jsonl', cwd: null, parentSession: null, name: null, label: null,
    startedAt: 0, lastActivityAt: 0, activeMs: 0, turns: 0, calls: calls.length, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    compactions: 0, models: [], tools: [], categories: [], skills: [], testRuns: [], slowCalls: [], failedCommands: [], turnFacts: [],
    days: {}, delegateRuns: [], cacheModels: models, cacheCalls: calls, warmPings: 0, warmCost: 0,
  }
}

/** One working day: a call every `every` minutes from 9:00, with `breaks` (minutes) between some of them. */
function day(start: number, breaks: number[], model = 0): CacheCall[] {
  let at = start + 9 * 60 * MINUTE
  const calls = [call(at, 40_000, true, model)]
  let prompt = 40_000
  for (const pause of breaks) {
    for (let step = 0; step < 3; step++) {
      at += 2 * MINUTE
      prompt += 500
      calls.push(call(at, prompt, false, model))
    }
    at += pause * MINUTE
    prompt += 500
    calls.push(call(at, prompt, false, model))
  }
  return calls
}

test('groups models by cache lifetime and caps pings at what Pi sends', () => {
  const analysis = buildCacheAnalysis([
    session(day(DAY_ONE, [12]), ['anthropic/claude-sonnet-5-5']),
    session(day(DAY_ONE, [40]), ['openai/gpt-6-luna']),
  ], DAY_ONE, DAY_ONE, DAY_ONE)
  assert.deepEqual(analysis.groups.map((group) => [group.id, group.maxPings, Math.round(group.reachMinutes ?? 0)]), [['5m', 6, 32], ['30m', 1, 57]])
  assert.equal(analysis.days, 1)
})

test('a break pings can bridge favours pings; one past their reach charges them on top of the rewrite', () => {
  const short = buildCacheAnalysis([session(day(DAY_ONE, [12, 12, 12]))], DAY_ONE, DAY_ONE, DAY_ONE).groups[0]
  const summary = summarize(short.models, short.maxPings, 7)
  // 12 minutes needs 2 refreshes (at 4.5 and 9 minutes, warm until 14).
  assert.equal(summary.best, 2)
  assert.ok(summary.savingPerWeek > 0)

  const long = buildCacheAnalysis([session(day(DAY_ONE, [45, 45, 45]))], DAY_ONE, DAY_ONE, DAY_ONE).groups[0]
  const totals = summarize(long.models, long.maxPings, 7).totals
  assert.equal(summarize(long.models, long.maxPings, 7).best, 0)
  // Every extra ping only adds its read.
  for (let count = 1; count < totals.length; count++) assert.ok(totals[count] > totals[count - 1])
})

test('gaps inside the lifetime and session openings land in the base cost, not the ping lines', () => {
  const group = buildCacheAnalysis([session(day(DAY_ONE, [3, 3]))], DAY_ONE, DAY_ONE, DAY_ONE).groups[0]
  const model = group.models[0]
  assert.equal(model.gaps.length, 0)
  assert.equal(model.longBreaks, 0)
  assert.ok(model.base.length > 0)
  const saving = pingSeries(group.models, group.maxPings, new Map(), DAY_ONE, SLOTS_PER_DAY, 'saving')
  assert.ok(saving.slice(0, group.maxPings + 3).every((line) => line.every((value) => value === 0)))
  const total = pingSeries(group.models, group.maxPings, new Map(), DAY_ONE, SLOTS_PER_DAY, 'total')
  assert.ok(total[0][SLOTS_PER_DAY] > 0)
  assert.equal(total[0][SLOTS_PER_DAY], total[group.maxPings][SLOTS_PER_DAY])
})

test('lines run flat until a break and step at the slot it ends in', () => {
  const group = buildCacheAnalysis([session(day(DAY_ONE, [12]))], DAY_ONE, DAY_ONE, DAY_ONE).groups[0]
  const lines = pingSeries(group.models, group.maxPings, new Map(), DAY_ONE, SLOTS_PER_DAY, 'saving')
  // Calls start at 9:00; the break ends at 9:18, in the 9:00 slot (index 18).
  assert.equal(lines[2][18], 0)
  assert.ok(lines[2][19] < 0)
  assert.equal(lines[2][19], lines[2][SLOTS_PER_DAY])
  const cells = slotBest(group.models, group.maxPings, DAY_ONE)
  assert.equal(cells[18]?.best, 2)
  assert.equal(cells.filter(Boolean).length, 1)
})

test('a model with too few breaks borrows the group count; hindsight is never worse than either', () => {
  const sessions: SessionAnalytics[] = []
  for (let index = 0; index < 8; index++) {
    sessions.push(session(day(DAY_ONE + index * 24 * 60 * MINUTE, [8, 8, 25]), ['anthropic/claude-sonnet-5-5']))
  }
  sessions.push(session(day(DAY_ONE, [40]), ['anthropic/claude-opus-5-5']))
  const group = buildCacheAnalysis(sessions, DAY_ONE, DAY_ONE + 7 * 24 * 60 * MINUTE, DAY_ONE).groups[0]
  const summary = summarize(group.models, group.maxPings, 8)
  assert.equal(summary.confidence, 'solid')
  assert.equal(summary.modelBest.get('anthropic/claude-opus-5-5'), summary.best)
  assert.ok(summary.perBreakTotal <= summary.perModelTotal + 1e-12)
  assert.ok(summary.perModelTotal <= summary.totals[summary.best] + 1e-12)
})

test('compares the last two weeks only when the window holds them', () => {
  const sessions = [0, 3, 8, 11].map((offset) => session(day(DAY_ONE + offset * 24 * 60 * MINUTE, offset < 7 ? [8, 8] : [25, 25])))
  const analysis = buildCacheAnalysis(sessions, DAY_ONE, DAY_ONE + 13 * 24 * 60 * MINUTE, DAY_ONE)
  const group = analysis.groups[0]
  const split = weekSplit(group.models, group.maxPings, analysis.to, analysis.days)
  assert.ok(split)
  assert.equal(split.earlier.best, 1)
  assert.equal(split.later.best, 5)
  assert.equal(weekSplit(group.models, group.maxPings, analysis.to, 7), null)
})

test('a model with no lifetime to warm only reports its hit rate', () => {
  const analysis = buildCacheAnalysis([session(day(DAY_ONE, [12]), ['google/gemini-4-argon'])], DAY_ONE, DAY_ONE, DAY_ONE)
  assert.equal(analysis.groups[0].id, 'automatic')
  const summary = summarize(analysis.groups[0].models, 0, 1)
  assert.ok(summary.hitRate !== null && summary.hitRate > 0.7)
  assert.equal(analysis.groups[0].models[0].gaps.length, 0)
})

test('no cache prices every prompt token at the input price, and caching beats it when prompts are reread', () => {
  const group = buildCacheAnalysis([session(day(DAY_ONE, [12, 3, 3]))], DAY_ONE, DAY_ONE, DAY_ONE).groups[0]
  const model = group.models[0]
  const summary = summarize(group.models, group.maxPings, 7)
  assert.ok(Math.abs(summary.noCacheTotal - model.promptTokens * PRICE) < 1e-9)
  assert.ok(summary.cacheSavingPerWeek > 0)
  // The no-cache line ends at the same total in both modes, once the 0-ping line is added back.
  const total = pingSeries(group.models, group.maxPings, summary.modelBest, DAY_ONE, SLOTS_PER_DAY, 'total')
  const saving = pingSeries(group.models, group.maxPings, summary.modelBest, DAY_ONE, SLOTS_PER_DAY, 'saving')
  const noCache = group.maxPings + 3
  assert.ok(Math.abs(total[noCache][SLOTS_PER_DAY] - summary.noCacheTotal) < 1e-9)
  assert.ok(Math.abs(saving[noCache][SLOTS_PER_DAY] + total[0][SLOTS_PER_DAY] - summary.noCacheTotal) < 1e-9)
})

test('a prompt sent once after every long break is cheaper with no cache', () => {
  const calls = [0, 1, 2, 3].map((index) => call(DAY_ONE + 9 * 60 * MINUTE + index * 90 * MINUTE, 40_000, true))
  const group = buildCacheAnalysis([session(calls)], DAY_ONE, DAY_ONE, DAY_ONE).groups[0]
  assert.ok(summarize(group.models, group.maxPings, 7).cacheSavingPerWeek < 0)
})
