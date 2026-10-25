import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCacheReport, cacheProvider, replay, KEEP_WARM_EVERY_MS } from './cache-policy'
import { SESSION_ANALYTICS_VERSION, type CacheCall, type SessionAnalytics } from './session-analytics'

const MINUTE = 60_000
const PRICE = 3e-6

/** A call with a `prompt`-token prompt billed as cache reads after the first, at Anthropic's 5m list prices. */
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
    days: {}, delegateRuns: [], cacheModels: models, cacheCalls: calls,
  }
}

test('names the provider from the provider or the model id', () => {
  assert.equal(cacheProvider('anthropic/claude-opus-5-5'), 'anthropic')
  assert.equal(cacheProvider('amazon-bedrock/us.anthropic.claude-sonnet-5-5'), 'anthropic')
  assert.equal(cacheProvider('openai/gpt-6.1'), 'openai')
  assert.equal(cacheProvider('google/gemini-4-argon'), 'other')
})

test('a gap longer than the lifetime writes the whole prompt again', () => {
  const prices = { inputPrice: PRICE, readRatio: 0.1 }
  const calls = [call(0, 10_000, true), call(2 * MINUTE, 11_000), call(20 * MINUTE, 12_000)]
  const short = replay(calls, { id: '5m', ttlMs: 5 * MINUTE, write: 1.25 }, prices)
  assert.equal(short.coldCalls, 2)
  const expected = 10_000 * PRICE * 1.25 + (10_000 * PRICE * 0.1 + 1_000 * PRICE * 1.25) + 12_000 * PRICE * 1.25
  assert.ok(Math.abs(short.cost - expected) < 1e-12)
  const long = replay(calls, { id: '1h', ttlMs: 60 * MINUTE, write: 2 }, prices)
  assert.equal(long.coldCalls, 1)
})

test('keep-warm pings cover a gap and are charged as reads', () => {
  const calls = [call(0, 10_000, true), call(14 * MINUTE, 10_500)]
  const warm = replay(calls, { id: '5m-warm-60m', ttlMs: 5 * MINUTE, write: 1.25, warm: { everyMs: KEEP_WARM_EVERY_MS, forMs: 60 * MINUTE } }, { inputPrice: PRICE, readRatio: 0.1 })
  // Pings at 4, 8 and 12 minutes keep it warm until 17.
  assert.equal(warm.pings, 3)
  assert.equal(warm.coldCalls, 1)
})

test('break-even warming stops once its pings would cost more than writing again', () => {
  const spec = { id: '5m-warm-break-even' as const, ttlMs: 5 * MINUTE, write: 1.25, warm: { everyMs: KEEP_WARM_EVERY_MS, forMs: 12 * 60 * MINUTE, breakEven: true } }
  const prices = { inputPrice: PRICE, readRatio: 0.1 }
  // 40 minutes idle needs 9 pings, fewer than the 12 one rewrite pays for.
  const kept = replay([call(0, 10_000, true), call(40 * MINUTE, 10_500)], spec, prices)
  assert.deepEqual([kept.pings, kept.coldCalls], [9, 1])
  // 70 minutes would need 17: it pings 12 times, then the cache goes cold anyway.
  const lost = replay([call(0, 10_000, true), call(70 * MINUTE, 10_500)], spec, prices)
  assert.deepEqual([lost.pings, lost.coldCalls], [12, 2])
})

test('a shrunken prompt (compaction) counts as a new prefix', () => {
  const calls = [call(0, 50_000, true), call(MINUTE, 8_000)]
  assert.equal(replay(calls, { id: '5m', ttlMs: 5 * MINUTE, write: 1.25 }, { inputPrice: PRICE, readRatio: 0.1 }).coldCalls, 2)
})

test('recommends a longer lifetime for calls with 10 to 40 minute gaps', () => {
  const calls: CacheCall[] = [call(0, 40_000, true)]
  for (let index = 1; index <= 20; index++) calls.push(call(index * 15 * MINUTE, 40_000 + index * 500))
  const report = buildCacheReport([session(calls)])
  const model = report.models[0]
  assert.equal(model.provider, 'anthropic')
  assert.equal(model.currentPolicy, '5m')
  assert.ok(Math.abs(model.readRatio - 0.1) < 1e-9)
  assert.ok(Math.abs(model.inputPrice - PRICE) < 1e-15)
  assert.equal(model.medianGapMs, 15 * MINUTE)
  assert.equal(model.recommended, '1h')
  assert.ok(model.saving > 0)
  assert.equal(report.saving, model.saving)
})

test('sweeps keep-warm limits and buckets the gaps', () => {
  const calls: CacheCall[] = [call(0, 40_000, true)]
  // Gaps of 14 minutes need 3 pings: pinging for 15 minutes of idle covers them, 10 (2 pings) does not.
  for (let index = 1; index <= 20; index++) calls.push(call(index * 14 * MINUTE, 40_000 + index * 500))
  const report = buildCacheReport([session(calls)])
  const model = report.models[0]
  assert.deepEqual(model.gapBuckets, [0, 0, 0, 20, 0, 0, 0])
  const at = (minutes: number) => model.warmSweep.find((point) => point.idleMinutes === minutes)
  assert.ok((at(15)?.saving ?? 0) > 0)
  assert.ok((at(10)?.saving ?? 0) < (at(15)?.saving ?? 0))
  assert.equal(model.bestWarm?.idleMinutes, 15)
  assert.equal(report.days.length, 1)
  assert.equal(report.days[0].calls, 21)
  assert.equal(report.days[0].coldCalls, 1)
})

test('back-to-back calls keep the 5 minute default', () => {
  const calls: CacheCall[] = [call(0, 20_000, true)]
  for (let index = 1; index <= 20; index++) calls.push(call(index * 30_000, 20_000 + index * 800))
  assert.equal(buildCacheReport([session(calls)]).models[0].recommended, null)
})

test('a provider without settings to compare reports its cost only', () => {
  const calls = Array.from({ length: 12 }, (_, index) => call(index * MINUTE, 5_000, index === 0))
  const model = buildCacheReport([session(calls, ['google/gemini-4-argon'])]).models[0]
  assert.equal(model.provider, 'other')
  assert.deepEqual(model.policies, [])
  assert.equal(model.recommended, null)
  assert.ok(model.measuredCost > 0)
})
