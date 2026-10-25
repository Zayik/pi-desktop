import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCacheReport, cacheProvider, replay, KEEP_WARM_EVERY_MS, MAX_SWEEP_PINGS } from './cache-policy'
import { SESSION_ANALYTICS_VERSION, localDayKey, type CacheCall, type SessionAnalytics } from './session-analytics'

const MINUTE = 60_000
const PRICE = 3e-6
/** Relative times count from here, after every cache option the rules date existed. */
const T0 = new Date(2026, 9, 1).getTime()
const time = (at: number): number => (at < 1e11 ? T0 + at : at)

/** A call with a `prompt`-token prompt billed as cache reads after the first, at Anthropic's 5m list prices. */
function call(at: number, prompt: number, first = false, model = 0): CacheCall {
  const read = first ? 0 : prompt - 1000
  const write = prompt - read
  return [time(at), model, 0, read, write, 0, 0, read * PRICE * 0.1, write * PRICE * 1.25]
}

function session(calls: CacheCall[], models = ['anthropic/claude-sonnet-5-5']): SessionAnalytics {
  return {
    version: SESSION_ANALYTICS_VERSION, sessionId: 's', sessionFile: '/s.jsonl', cwd: null, parentSession: null, name: null, label: null,
    startedAt: 0, lastActivityAt: 0, activeMs: 0, turns: 0, calls: calls.length, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    compactions: 0, models: [], tools: [], categories: [], skills: [], testRuns: [], slowCalls: [], failedCommands: [], turnFacts: [],
    days: {}, delegateRuns: [], cacheModels: models, cacheCalls: calls, warmPings: 0, warmCost: 0,
  }
}

test('names the provider from the provider or the model id', () => {
  assert.equal(cacheProvider('anthropic/claude-opus-5-5'), 'anthropic')
  assert.equal(cacheProvider('amazon-bedrock/us.anthropic.claude-sonnet-5-5'), 'anthropic')
  assert.equal(cacheProvider('openai/gpt-6.1'), 'openai')
  assert.equal(cacheProvider('github-copilot/claude-opus-5.5'), 'anthropic')
  assert.equal(cacheProvider('github-copilot/gpt-5.3-codex'), 'openai')
  assert.equal(cacheProvider('openai-codex/gpt-5.5'), 'openai')
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

test('sweeps pings per gap and buckets the gaps', () => {
  const calls: CacheCall[] = [call(0, 40_000, true)]
  // Gaps of 14 minutes need 3 pings (5 + 3 x 4 = 17 min); 2 pings (13 min) let the cache go.
  for (let index = 1; index <= 20; index++) calls.push(call(index * 14 * MINUTE, 40_000 + index * 500))
  const report = buildCacheReport([session(calls)])
  const model = report.models[0]
  assert.deepEqual(model.gapBuckets, [0, 0, 0, 20, 0, 0, 0])
  assert.equal(model.pingSweep.length, MAX_SWEEP_PINGS + 1)
  assert.equal(model.bestPings?.pings, 3)
  assert.equal(model.bestPings?.idleMinutes, 17)
  assert.equal(model.bestPings?.sent, 60)
  assert.ok((model.bestPings?.saving ?? 0) > 0)
  // More pings than needed send no more and cost the same; fewer waste pings and still miss.
  assert.equal(model.pingSweep[5].cost, model.pingSweep[3].cost)
  assert.ok(model.pingSweep[2].cost > model.pingSweep[0].cost)
  assert.equal(model.longPolicy, '1h')
  assert.ok(model.longCost !== null)
  assert.equal(report.days.length, 1)
  assert.equal(report.days[0].calls, 21)
  assert.equal(report.days[0].coldCalls, 1)
})

test('a fixed count matches the replay of the same keep-warm limit', () => {
  const calls: CacheCall[] = [call(0, 30_000, true)]
  for (let index = 1; index <= 30; index++) calls.push(call(calls[index - 1][0] + ((index % 4) * 6 + 1) * MINUTE, 30_000 + index * 300))
  const model = buildCacheReport([session(calls)]).models[0]
  const warm60 = model.policies.find((policy) => policy.policy === '5m-warm-60m')
  const none = model.policies.find((policy) => policy.policy === '5m')
  assert.ok(Math.abs((warm60?.cost ?? 0) - model.pingSweep[MAX_SWEEP_PINGS].cost) < 1e-12)
  assert.ok(Math.abs((none?.cost ?? 0) - model.pingSweep[0].cost) < 1e-12)
})

test('plans a ping count per hour of the day', () => {
  // Five days of: a 70 minute lunch from 13:30 (no ping count saves it), a 20 minute
  // gap from 14:40 (4 pings) and 12 minute gaps through 15:00-16:00 (2 pings).
  const sessions = [0, 1, 2, 3, 4].map((day) => {
    const at = (hour: number, minute: number) => new Date(2026, 9, 20 + day, hour, minute).getTime()
    const times = [at(13, 30), at(14, 40), at(15, 0), at(15, 12), at(15, 24), at(15, 36), at(15, 48), at(16, 0)]
    return session(times.map((time, index) => call(time, 40_000 + index * 500, index === 0)))
  })
  const model = buildCacheReport(sessions).models[0]
  const hour = (h: number) => model.hourly.find((entry) => entry.hour === h)?.pings
  assert.equal(hour(13), 0)
  assert.equal(hour(14), 4)
  assert.equal(hour(15), 2)
  assert.equal(model.bestPings?.pings, 4)
  assert.ok(model.autoSaving > 0)
  assert.ok((model.autoCost ?? Infinity) < (model.bestPings?.cost ?? 0))
})

test('back-to-back calls keep the 5 minute default', () => {
  const calls: CacheCall[] = [call(0, 20_000, true)]
  for (let index = 1; index <= 20; index++) calls.push(call(index * 30_000, 20_000 + index * 800))
  assert.equal(buildCacheReport([session(calls)]).models[0].recommended, null)
})

/** A call on OpenAI's automatic cache: no writes, the uncached part billed as input. */
function autoCall(at: number, prompt: number, first = false): CacheCall {
  const read = first ? 0 : prompt - 1000
  const input = prompt - read
  return [time(at), 0, input, read, 0, 0, input * PRICE, read * PRICE * 0.1, 0]
}

test('GPT-5.6 and later compare 30 minutes with 12 hours, whose reads do not restart its clock', () => {
  const calls: CacheCall[] = [call(0, 40_000, true)]
  // 35 minute gaps for under 12 hours: one 12 hour write beats a ping in each of 20 gaps.
  for (let index = 1; index <= 20; index++) calls.push(call(index * 35 * MINUTE, 40_000 + index * 500))
  const model = buildCacheReport([session(calls, ['openai/gpt-5.6-sol'])]).models[0]
  assert.equal(model.family, 'openai-ttl')
  assert.equal(model.currentPolicy, '30m')
  assert.ok(model.currentPolicyMeasured)
  assert.ok(model.policies.some((policy) => policy.policy === '12h'))
  assert.equal(model.recommended, '12h')
  assert.ok(model.notes.includes('pi-no-12h'))
  assert.equal(model.pingEveryMs, 24 * MINUTE)
  assert.equal(model.pingSweep.length, 30)
  assert.equal(model.shortTtlMs, 30 * MINUTE)

  const spec = { id: '12h' as const, ttlMs: 12 * 60 * MINUTE, write: 2.5, hitKeepsMs: 30 * MINUTE }
  const prices = { inputPrice: PRICE, readRatio: 0.1 }
  // A read at 11:50 keeps the entry until 12:20 only; a call at 12:40 finds it gone.
  const timed = replay([call(0, 10_000, true), call(710 * MINUTE, 10_500), call(760 * MINUTE, 11_000)], spec, prices)
  assert.equal(timed.coldCalls, 2)
})

test('earlier OpenAI models cache automatically and can ask for 24h retention', () => {
  const calls: CacheCall[] = [autoCall(0, 40_000, true)]
  for (let index = 1; index <= 20; index++) calls.push(autoCall(index * 15 * MINUTE, 40_000 + index * 500))
  const model = buildCacheReport([session(calls, ['openai/gpt-5.4'])]).models[0]
  assert.equal(model.family, 'openai-implicit')
  assert.equal(model.currentPolicy, 'in-memory')
  assert.equal(model.currentPolicyMeasured, false)
  assert.equal(model.recommended, '24h')
  assert.ok(Math.abs(model.readRatio - 0.1) < 1e-9)
  assert.ok(model.notes.includes('implicit-lifetime'))
})

test("Copilot models get the vendor's lifetimes", () => {
  const calls: CacheCall[] = [call(0, 40_000, true)]
  for (let index = 1; index <= 20; index++) calls.push(call(index * 15 * MINUTE, 40_000 + index * 500))
  const claude = buildCacheReport([session(calls, ['github-copilot/claude-sonnet-5.5'])]).models[0]
  assert.equal(claude.route, 'copilot')
  assert.equal(claude.family, 'anthropic')
  assert.equal(claude.currentPolicy, '5m')
  assert.ok(claude.policies.some((policy) => policy.policy === '1h'))
  assert.equal(claude.longPolicy, '1h')
  assert.ok(claude.notes.includes('copilot-1h-unlisted'))
  assert.equal(claude.pingSweep.length, MAX_SWEEP_PINGS + 1)

  const gpt = buildCacheReport([session(calls, ['github-copilot/gpt-5.6-terra'])]).models[0]
  assert.equal(gpt.family, 'openai-ttl')
  assert.ok(gpt.policies.some((policy) => policy.policy === '12h'))
  assert.equal(gpt.longPolicy, '12h')
  assert.ok(gpt.notes.includes('copilot-vendor'))

  const gemini = buildCacheReport([session(calls.map((entry) => autoCall(entry[0], 40_000)), ['github-copilot/gemini-4-argon'])]).models[0]
  assert.equal(gemini.family, 'none')
  assert.deepEqual(gemini.policies, [])
  assert.deepEqual(gemini.notes, ['copilot-automatic'])
})

/** A call after `minutes` of break that found the previous `prompt` warm or cold, as the provider billed it. */
function measured(at: number, prompt: number, warm: boolean): CacheCall {
  return call(at, prompt, !warm)
}

test('measures where the cache actually goes cold', () => {
  const calls: CacheCall[] = [call(0, 40_000, true)]
  let at = 0
  // Breaks of 2 to 4 minutes hit, breaks of 6 to 8 miss: a 5 minute lifetime.
  for (const [minutes, warm] of [[2, true], [3, true], [4, true], [6, false], [8, false]] as const) {
    for (let repeat = 0; repeat < 4; repeat++) calls.push(measured((at += minutes * MINUTE), 40_000 + calls.length * 100, warm))
  }
  const model = buildCacheReport([session(calls)]).models[0]
  const observed = model.observed
  assert.ok(observed)
  assert.equal(observed.expectedMinutes, 5)
  assert.equal(observed.warmUpToMinutes, 4)
  assert.equal(observed.coldFromMinutes, 5)
  assert.equal(observed.verdict, 'matches')
  const bucket = (upTo: number) => observed.buckets.find((entry) => entry.upToMinutes === upTo)
  assert.deepEqual([bucket(2)?.gaps, bucket(2)?.hits, bucket(6)?.gaps, bucket(6)?.hits], [4, 4, 4, 0])

  // The same calls missing from 3 minutes on: the cache is shorter than its 5.
  const short: CacheCall[] = [call(0, 40_000, true)]
  at = 0
  for (const [minutes, warm] of [[2, true], [3, false], [4, false], [6, false]] as const) {
    for (let repeat = 0; repeat < 4; repeat++) short.push(measured((at += minutes * MINUTE), 40_000 + short.length * 100, warm))
  }
  assert.equal(buildCacheReport([session(short)]).models[0].observed?.verdict, 'shorter')
})

test("counts Pi's warming pings apart from the calls", () => {
  const ping = (at: number, prompt: number, warm: boolean): CacheCall => {
    const row = call(at, prompt, !warm)
    row[9] = 1
    return row
  }
  const calls: CacheCall[] = [
    call(0, 40_000, true),
    ping(4.5 * MINUTE, 40_000, true),
    ping(9 * MINUTE, 40_000, true),
    measured(12 * MINUTE, 41_000, true),
    ping(16.5 * MINUTE, 41_000, false),
    measured(30 * MINUTE, 42_000, false),
  ]
  // Through Copilot, whose models Pi's own list gives no lifetime: recorded pings show something warmed it anyway.
  const model = buildCacheReport([session(calls, ['github-copilot/claude-sonnet-5.5'])]).models[0]
  assert.equal(model.calls, 3)
  const observed = model.observed
  assert.deepEqual([observed?.pings, observed?.pingHits, observed?.pingedGaps, observed?.pingedGapHits], [3, 2, 2, 1])
  assert.ok((observed?.pingCost ?? 0) > 0)
  assert.ok(!model.notes.includes('pi-no-pings'))
  // Billed pings count in the measured cost, not in the replay's calls.
  assert.ok(model.measuredCost > calls.filter((entry) => entry[9] !== 1).reduce((sum, entry) => sum + entry[6] + entry[7] + entry[8], 0))
})

test('leaves out options that did not exist when the calls ran', () => {
  const old = new Date(2025, 0, 6).getTime()
  const calls: CacheCall[] = Array.from({ length: 12 }, (_, index) => call(old + index * 15 * MINUTE, 40_000 + index * 500, index === 0))
  const model = buildCacheReport([session(calls)]).models[0]
  assert.ok(!model.policies.some((policy) => policy.policy === '1h'))
  assert.ok(model.policies.some((policy) => policy.policy === '5m'))
})

test('a provider without settings to compare reports its cost only', () => {
  const calls = Array.from({ length: 12 }, (_, index) => call(index * MINUTE, 5_000, index === 0))
  const model = buildCacheReport([session(calls, ['google/gemini-4-argon'])]).models[0]
  assert.equal(model.provider, 'other')
  assert.deepEqual(model.policies, [])
  assert.equal(model.recommended, null)
  assert.ok(model.measuredCost > 0)
})

test('Auto is compared walk-forward only once a model has 7 days of calls', () => {
  const DAY = 24 * 60 * MINUTE
  const daysOf = (count: number): CacheCall[] => {
    const calls: CacheCall[] = []
    for (let day = 0; day < count; day++) {
      // Mornings: 12-minute breaks, which a few pings bridge. Afternoons: 3-hour breaks, which no count Pi sends covers.
      const morning = T0 + day * DAY + 9 * 60 * MINUTE
      for (let i = 0; i < 6; i++) calls.push(call(morning + i * 12 * MINUTE, 20_000 + i * 100, i === 0))
      const afternoon = T0 + day * DAY + 13 * 60 * MINUTE
      for (let i = 0; i < 3; i++) calls.push(call(afternoon + i * 180 * MINUTE, 20_000 + i * 100, i === 0))
    }
    return calls
  }
  assert.equal(buildCacheReport([session(daysOf(6))]).models[0].autoComparison, null)
  const report = buildCacheReport([session(daysOf(8))])
  const auto = report.models[0].autoComparison
  assert.ok(auto)
  // The first day has no history to plan from.
  assert.equal(auto.days, 7)
  assert.equal(auto.daily[0].day, localDayKey(T0 + DAY))
  assert.ok(auto.fixedPings <= 6)
  assert.ok(auto.auto <= auto.fixed + 1e-12)
  assert.equal(report.autoComparison?.models, 1)
  assert.ok(Math.abs((report.autoComparison?.billed ?? 0) - auto.daily.reduce((sum, day) => sum + day.billed, 0)) < 1e-12)
})
