import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelCacheReport, PingSweepPoint } from '../../../src/shared/cache-policy'
import { checkModel, describeRecommendation, piMaxIdlePings, recommendFor, withAlternative } from './recommendations'

const MINUTE = 60_000

function point(pings: number, cost: number): PingSweepPoint {
  return { pings, idleMinutes: 5 + pings * 4, cost, sent: pings * 10, saving: 0 }
}

function model(change: Partial<ModelCacheReport>): ModelCacheReport {
  const pingSweep = change.pingSweep ?? [point(0, 10), point(1, 8), point(2, 7), point(3, 7.5)]
  return {
    model: 'anthropic/claude-haiku-5-5', provider: 'anthropic', family: 'anthropic', route: 'api', notes: [], calls: 100, estimatedCalls: 0, sessions: 5,
    measuredCost: 10, currentPolicy: '5m', currentPolicyMeasured: true, inputPrice: 1e-6, readRatio: 0.1, readRatioMeasured: true,
    policies: [{ policy: '5m', cost: 10, pings: 0, coldCalls: 20 }], recommended: null, saving: 0, savingShare: 0,
    medianGapMs: MINUTE, longGapShare: 0.2, shortTtlMs: 5 * MINUTE, gapBuckets: [100, 50, 30, 20], sweepPolicy: '5m', pingEveryMs: 4 * MINUTE,
    pingSweep, bestPings: pingSweep.reduce((low, p) => (p.cost < low.cost ? p : low)), longPolicy: '1h', longCost: 9,
    hourly: [], autoCost: null, autoSaving: 0, autoComparison: null, observed: null,
    ...change,
  }
}

test('Pi refreshes a 5-minute cache 6 times and a 30-minute one once before it stops warming', () => {
  assert.equal(piMaxIdlePings(5 * MINUTE), 6)
  assert.equal(piMaxIdlePings(30 * MINUTE), 1)
})

test('picks the cheapest ping count with its weekly saving', () => {
  const rec = recommendFor(model({}), 14)
  assert.deepEqual(rec?.setting, { mode: 'keep-warm', idlePings: 2 })
  assert.equal(rec?.weeklySaving, 1.5)
  assert.match(describeRecommendation(rec!), /keep warm 13 min after the agent stops \(2 refreshes\), saves \$1\.50 a week/)
})

test('caps the count at what Pi sends and says what lies beyond', () => {
  const sweep = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((pings) => point(pings, 10 - pings * 0.5))
  const rec = recommendFor(model({ pingSweep: sweep }), 7)
  assert.equal(rec?.setting.idlePings, 6)
  assert.equal(rec?.beyondPi?.pings, 8)
})

test('no recommendation below the minimum number of breaks, and the check says how many there are', () => {
  const check = checkModel(model({ gapBuckets: [40, 20, 10, 5], longGapShare: 0.2 }), 7)
  assert.equal(check.status, 'not-enough-data')
  assert.equal(check.breaks, 15)
  assert.equal(check.minBreaks, 20)
  assert.equal(check.recommendation, null)
})

test('the long tier is an opt-in beside the ping count, only when it is clearly cheaper', () => {
  const near = recommendFor(model({ longCost: 6.5 }), 7)
  assert.equal(near?.setting.mode, 'keep-warm')
  assert.equal(near?.alternative, null)
  const clear = recommendFor(model({ longCost: 6 }), 7)
  assert.equal(clear?.setting.mode, 'keep-warm')
  assert.deepEqual(clear?.alternative?.setting, { mode: 'long' })
  assert.deepEqual(withAlternative(clear!)?.setting, { mode: 'long' })
  const flat = [point(0, 10)]
  const longOnly = checkModel(model({ pingSweep: flat, longCost: 6 }), 7)
  assert.equal(longOnly.status, 'long-only')
  assert.deepEqual(longOnly.alternative?.setting, { mode: 'long' })
  const gpt = model({ model: 'openai/gpt-5.6', provider: 'openai', family: 'openai-ttl', pingSweep: flat, longPolicy: '12h', longCost: 6, shortTtlMs: 30 * MINUTE, sweepPolicy: '30m', currentPolicy: '30m', policies: [{ policy: '30m', cost: 10, pings: 0, coldCalls: 1 }] })
  assert.equal(checkModel(gpt, 7).status, 'no-saving')
})

test('nothing when the saving is too small to act on', () => {
  assert.equal(recommendFor(model({ pingSweep: [point(0, 10), point(1, 9.95)], longCost: 12 }), 7), null)
})
