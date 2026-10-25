/**
 * What past sessions would have cost under each prompt-cache setting their
 * provider offers, replayed from the real calls: their prompt sizes and the
 * real gaps between them. Output costs the same under every setting, so only
 * prompt cost is compared.
 *
 * The replay is an estimate: it assumes the same calls at the same times,
 * and that each call reuses the previous call's prompt as its cached prefix.
 * The measured cost next to it is what the provider billed.
 */
import { localDayKey, type CacheCall, type SessionAnalytics } from './session-analytics'

export type CacheProvider = 'anthropic' | 'openai' | 'other'

export type CachePolicyId = 'none' | '5m' | '5m-warm-30m' | '5m-warm-60m' | '5m-warm-break-even' | '1h' | '30m' | '12h'

interface PolicySpec {
  id: CachePolicyId
  ttlMs: number
  /** Cache write price as a multiple of the input price. */
  write: number
  /**
   * Keep-warm pings during idle gaps: up to `forMs` of idle, or with
   * `breakEven`, only while the pings of one gap cost less than writing
   * the prompt again would.
   */
  warm?: { everyMs: number; forMs: number; breakEven?: boolean }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** A prompt this much smaller than the cached one no longer shares its prefix (a compaction or another branch). */
const PREFIX_BREAK = 0.9
/** Fewer calls than this say too little about timing to recommend anything. */
const MIN_CALLS_FOR_ADVICE = 10
/** A cheaper setting is worth recommending from this share of savings. */
const MIN_SAVING_SHARE = 0.05

export const KEEP_WARM_EVERY_MS = 4 * MINUTE
/** The ping sweep tries 0 to this many pings per idle gap: enough to keep 5 minutes warm through a whole hour. */
export const MAX_SWEEP_PINGS = Math.ceil((HOUR - 5 * MINUTE) / KEEP_WARM_EVERY_MS)
/** An hour of the day with fewer gaps than this keeps the best fixed count in the auto schedule. */
const MIN_GAPS_PER_HOUR = 5
/** The hourly schedule is worth mentioning from this share of the best fixed count's cost. */
const MIN_AUTO_SAVING_SHARE = 0.01
/** Upper bounds of the gap histogram's buckets; the last bucket is everything longer. */
export const GAP_BUCKET_MINUTES = [1, 5, 10, 15, 30, 60]

/**
 * Settings per provider, with list prices as multiples of the input price
 * (Anthropic: 5m write 1.25x, 1h write 2x; OpenAI: 30m write 1.25x, 12h
 * write 2.5x). A hit refreshes the lifetime on both.
 */
const POLICIES: Record<Exclude<CacheProvider, 'other'>, PolicySpec[]> = {
  anthropic: [
    { id: 'none', ttlMs: 0, write: 1 },
    { id: '5m', ttlMs: 5 * MINUTE, write: 1.25 },
    // Half the long lifetime, the whole of it, and as long as pinging is cheaper than writing again.
    { id: '5m-warm-30m', ttlMs: 5 * MINUTE, write: 1.25, warm: { everyMs: KEEP_WARM_EVERY_MS, forMs: 30 * MINUTE } },
    { id: '5m-warm-60m', ttlMs: 5 * MINUTE, write: 1.25, warm: { everyMs: KEEP_WARM_EVERY_MS, forMs: HOUR } },
    { id: '5m-warm-break-even', ttlMs: 5 * MINUTE, write: 1.25, warm: { everyMs: KEEP_WARM_EVERY_MS, forMs: 12 * HOUR, breakEven: true } },
    { id: '1h', ttlMs: HOUR, write: 2 },
  ],
  openai: [
    { id: 'none', ttlMs: 0, write: 1 },
    { id: '30m', ttlMs: 30 * MINUTE, write: 1.25 },
    { id: '12h', ttlMs: 12 * HOUR, write: 2.5 },
  ],
}

/** What a provider caches with when the calls do not say. */
const DEFAULT_POLICY: Record<CacheProvider, CachePolicyId | null> = { anthropic: '5m', openai: '30m', other: null }

/** Cache read price as a multiple of input, when the sessions never show one. */
const DEFAULT_READ_RATIO = 0.1

export interface PolicyCost {
  policy: CachePolicyId
  /** Simulated prompt cost over the calls. */
  cost: number
  /** Keep-warm pings the setting would have sent. */
  pings: number
  /** Calls that would have found the cache cold. */
  coldCalls: number
}

export interface ModelCacheReport {
  /** `provider/model`. */
  model: string
  provider: CacheProvider
  calls: number
  sessions: number
  /** What the prompts were billed: input, cache reads and cache writes. */
  measuredCost: number
  /** The setting the calls ran with, read from their cache writes, or the provider's default. */
  currentPolicy: CachePolicyId | null
  /** False when `currentPolicy` is the provider's default because the calls did not show it. */
  currentPolicyMeasured: boolean
  /** Input price per token and cache read multiple, measured from the calls when they show them. */
  inputPrice: number
  readRatio: number
  /** True when the read multiple came from the calls rather than the list price. */
  readRatioMeasured: boolean
  policies: PolicyCost[]
  /** The cheapest setting, when the difference is worth acting on. */
  recommended: CachePolicyId | null
  /** Simulated saving of `recommended` over the current setting. */
  saving: number
  /** `saving` as a share of the current setting's simulated cost. */
  savingShare: number
  /** Median gap between calls, the number that decides between short and long lifetimes. */
  medianGapMs: number
  /** Share of gaps longer than five minutes. */
  longGapShare: number
  /** Gaps between calls per `GAP_BUCKET_MINUTES` bucket, plus one for longer gaps. */
  gapBuckets: number[]
  /**
   * 5 minutes plus at most 0 to `MAX_SWEEP_PINGS` pings per idle gap
   * (Anthropic only), and the count that would have cost least.
   */
  pingSweep: PingSweepPoint[]
  bestPings: PingSweepPoint | null
  /** The 1 hour setting's replayed cost, to compare the sweep with. */
  oneHourCost: number | null
  /** The best ping count per local hour of the day the idle gap starts in. */
  hourly: HourPlan[]
  /** Cost with each hour on its own best count; null without a sweep. */
  autoCost: number | null
  /** What the hourly schedule saves over the best single count. */
  autoSaving: number
}

export interface PingSweepPoint {
  /** Pings allowed per idle gap. */
  pings: number
  /** Idle this many pings keep warm. */
  idleMinutes: number
  cost: number
  /** Pings actually sent. */
  sent: number
  /** Against the current setting; negative when it costs more. */
  saving: number
}

export interface HourPlan {
  hour: number
  gaps: number
  /** Best count for this hour, or the best fixed count when the hour has too few gaps. */
  pings: number
  /** Cost of this hour's gaps at that count and at the best fixed count. */
  cost: number
  fixedCost: number
}

/** Measured cache use of one day: prompt tokens read from the cache, written to it, and sent uncached. */
export interface CacheDay {
  day: string
  calls: number
  /** Calls that read nothing from the cache. */
  coldCalls: number
  readTokens: number
  writeTokens: number
  inputTokens: number
}

export interface CacheReport {
  models: ModelCacheReport[]
  days: CacheDay[]
  /** Sum of the recommended savings. */
  saving: number
}

export function cacheProvider(model: string): CacheProvider {
  const [provider, ...rest] = model.split('/')
  const id = rest.join('/').toLowerCase()
  const name = provider.toLowerCase()
  if (name.includes('anthropic') || id.includes('claude')) return 'anthropic'
  if (name.includes('openai') || /^(gpt|o\d|chatgpt|codex)/.test(id)) return 'openai'
  return 'other'
}

/** The setting the calls ran with: one-hour writes mean 1h, other writes the provider's default. */
function currentPolicy(provider: CacheProvider, calls: CacheCall[]): CachePolicyId | null {
  let writes = 0
  let oneHour = 0
  for (const call of calls) {
    writes += call[4]
    oneHour += call[5]
  }
  if (provider === 'anthropic') return writes === 0 ? null : oneHour > writes / 2 ? '1h' : '5m'
  if (provider === 'openai') return calls.some((call) => call[3] > 0) ? '30m' : null
  return null
}

interface Prices {
  inputPrice: number
  readRatio: number
  readRatioMeasured: boolean
}

/** Input price and read multiple measured from the calls, falling back to the list multiple. */
function measurePrices(calls: CacheCall[], provider: CacheProvider): Prices | null {
  let input = 0
  let inputCost = 0
  let read = 0
  let readCost = 0
  let write = 0
  let writeCost = 0
  let write1h = 0
  for (const call of calls) {
    input += call[2]
    inputCost += call[6]
    read += call[3]
    readCost += call[7]
    write += call[4]
    writeCost += call[8]
    write1h += call[5]
  }
  let inputPrice = input > 0 && inputCost > 0 ? inputCost / input : 0
  // A session that sent everything through the cache shows no input price; derive it from the writes.
  if (inputPrice === 0 && write > 0 && writeCost > 0) {
    const multiple = provider === 'anthropic' && write1h > write / 2 ? 2 : 1.25
    inputPrice = writeCost / write / multiple
  }
  if (inputPrice === 0) return null
  const measured = read > 0 && readCost > 0
  return { inputPrice, readRatio: measured ? readCost / read / inputPrice : DEFAULT_READ_RATIO, readRatioMeasured: measured }
}

function promptTokens(call: CacheCall): number {
  return call[2] + call[3] + call[4]
}

/**
 * Replay one session's calls of one model under a setting. Each call's
 * prompt starts with the previous call's, so a warm cache serves that much
 * and the rest is written; a cold one writes it all.
 */
export function replay(calls: CacheCall[], spec: PolicySpec, prices: Pick<Prices, 'inputPrice' | 'readRatio'>): PolicyCost {
  const result: PolicyCost = { policy: spec.id, cost: 0, pings: 0, coldCalls: 0 }
  let cached = 0
  let lastAt: number | null = null
  for (const call of calls) {
    const prompt = promptTokens(call)
    const at = call[0]
    if (spec.ttlMs === 0) {
      result.cost += prompt * prices.inputPrice
      continue
    }
    let warm = false
    if (lastAt !== null && cached > 0) {
      const gap = at - lastAt
      if (gap <= spec.ttlMs) warm = true
      else if (spec.warm) {
        // Pings refresh the lifetime; each one reads the whole cached prompt.
        const maxPings = spec.warm.breakEven
          ? Math.floor(spec.write / prices.readRatio)
          : Math.ceil((spec.warm.forMs - spec.ttlMs) / spec.warm.everyMs)
        const needed = Math.ceil((gap - spec.ttlMs) / spec.warm.everyMs)
        // Warming that gives up before the next call still paid for its pings.
        const pings = Math.min(needed, maxPings)
        result.pings += pings
        result.cost += pings * cached * prices.inputPrice * prices.readRatio
        warm = needed <= maxPings
      }
    }
    if (warm && prompt < cached * PREFIX_BREAK) warm = false
    if (warm) {
      const hit = Math.min(cached, prompt)
      result.cost += hit * prices.inputPrice * prices.readRatio + (prompt - hit) * prices.inputPrice * spec.write
    } else {
      result.coldCalls++
      result.cost += prompt * prices.inputPrice * spec.write
    }
    cached = prompt
    lastAt = at
  }
  return result
}

/**
 * Every idle gap's cost (the pings plus the call after it) at each count of
 * 0 to `MAX_SWEEP_PINGS` pings on a 5 minute cache, keyed by the local hour
 * the gap starts in. A gap's cost depends only on its own length and
 * prompts, so any schedule of counts is a sum over these rows.
 */
function gapCostsByPings(runs: CacheCall[][], prices: Pick<Prices, 'inputPrice' | 'readRatio'>): { first: number; gaps: Array<{ hour: number; costs: number[]; sent: number[] }> } {
  const ttl = 5 * MINUTE
  const write = 1.25
  const read = prices.inputPrice * prices.readRatio
  let first = 0
  const gaps: Array<{ hour: number; costs: number[]; sent: number[] }> = []
  for (const run of runs) {
    if (run.length === 0) continue
    first += promptTokens(run[0]) * prices.inputPrice * write
    for (let index = 1; index < run.length; index++) {
      const cached = promptTokens(run[index - 1])
      const prompt = promptTokens(run[index])
      const gap = run[index][0] - run[index - 1][0]
      const needed = gap <= ttl ? 0 : Math.ceil((gap - ttl) / KEEP_WARM_EVERY_MS)
      const sameRoot = cached > 0 && prompt >= cached * PREFIX_BREAK
      const costs: number[] = []
      const sent: number[] = []
      for (let limit = 0; limit <= MAX_SWEEP_PINGS; limit++) {
        const pings = Math.min(needed, limit)
        const hit = Math.min(cached, prompt)
        const call = needed <= limit && sameRoot
          ? hit * read + (prompt - hit) * prices.inputPrice * write
          : prompt * prices.inputPrice * write
        costs.push(pings * cached * read + call)
        sent.push(pings)
      }
      gaps.push({ hour: new Date(run[index - 1][0]).getHours(), costs, sent })
    }
  }
  return { first, gaps }
}

function cheapestIndex(costs: number[]): number {
  let best = 0
  for (let index = 1; index < costs.length; index++) if (costs[index] < costs[best] - 1e-12) best = index
  return best
}

function gapBuckets(gaps: number[]): number[] {
  const buckets = new Array<number>(GAP_BUCKET_MINUTES.length + 1).fill(0)
  for (const gap of gaps) {
    const index = GAP_BUCKET_MINUTES.findIndex((limit) => gap <= limit * MINUTE)
    buckets[index < 0 ? GAP_BUCKET_MINUTES.length : index]++
  }
  return buckets
}

/** Measured cache use per local day, every model together. */
function cacheDays(sessions: SessionAnalytics[]): CacheDay[] {
  const days = new Map<string, CacheDay>()
  for (const facts of sessions) {
    for (const call of facts.cacheCalls) {
      const day = localDayKey(call[0])
      const entry = days.get(day) ?? { day, calls: 0, coldCalls: 0, readTokens: 0, writeTokens: 0, inputTokens: 0 }
      entry.calls++
      if (call[3] === 0) entry.coldCalls++
      entry.readTokens += call[3]
      entry.writeTokens += call[4]
      entry.inputTokens += call[2]
      days.set(day, entry)
    }
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day))
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Per model across sessions: each session keeps its own cache, so each is replayed alone. */
export function buildCacheReport(sessions: SessionAnalytics[]): CacheReport {
  const byModel = new Map<string, CacheCall[][]>()
  for (const facts of sessions) {
    const perModel = new Map<number, CacheCall[]>()
    for (const call of facts.cacheCalls ?? []) {
      const list = perModel.get(call[1]) ?? []
      list.push(call)
      perModel.set(call[1], list)
    }
    for (const [index, calls] of perModel) {
      const name = facts.cacheModels[index]
      if (!name) continue
      const runs = byModel.get(name) ?? []
      runs.push([...calls].sort((a, b) => a[0] - b[0]))
      byModel.set(name, runs)
    }
  }

  const models: ModelCacheReport[] = []
  for (const [model, runs] of byModel) {
    const provider = cacheProvider(model)
    const all = runs.flat()
    const gaps: number[] = []
    for (const run of runs) for (let index = 1; index < run.length; index++) gaps.push(run[index][0] - run[index - 1][0])
    const measuredCost = all.reduce((sum, call) => sum + call[6] + call[7] + call[8], 0)
    const prices = measurePrices(all, provider)
    const report: ModelCacheReport = {
      model,
      provider,
      calls: all.length,
      sessions: runs.length,
      measuredCost,
      currentPolicy: currentPolicy(provider, all) ?? DEFAULT_POLICY[provider],
      currentPolicyMeasured: currentPolicy(provider, all) !== null,
      inputPrice: prices?.inputPrice ?? 0,
      readRatio: prices?.readRatio ?? DEFAULT_READ_RATIO,
      readRatioMeasured: prices?.readRatioMeasured ?? false,
      policies: [],
      recommended: null,
      saving: 0,
      savingShare: 0,
      medianGapMs: median(gaps),
      longGapShare: gaps.length > 0 ? gaps.filter((gap) => gap > 5 * MINUTE).length / gaps.length : 0,
      gapBuckets: gapBuckets(gaps),
      pingSweep: [],
      bestPings: null,
      oneHourCost: null,
      hourly: [],
      autoCost: null,
      autoSaving: 0,
    }
    if (provider !== 'other' && prices) {
      report.policies = POLICIES[provider].map((spec) => {
        const total: PolicyCost = { policy: spec.id, cost: 0, pings: 0, coldCalls: 0 }
        for (const run of runs) {
          const part = replay(run, spec, prices)
          total.cost += part.cost
          total.pings += part.pings
          total.coldCalls += part.coldCalls
        }
        return total
      })
      const cheapest = [...report.policies].sort((a, b) => a.cost - b.cost)[0]
      const baseline = report.policies.find((entry) => entry.policy === report.currentPolicy)
      if (cheapest && baseline && cheapest.policy !== baseline.policy && report.calls >= MIN_CALLS_FOR_ADVICE) {
        const saving = baseline.cost - cheapest.cost
        if (baseline.cost > 0 && saving / baseline.cost >= MIN_SAVING_SHARE) {
          report.recommended = cheapest.policy
          report.saving = saving
          report.savingShare = saving / baseline.cost
        }
      }
    }
    if (provider === 'anthropic' && prices) {
      const current = report.policies.find((entry) => entry.policy === report.currentPolicy)?.cost ?? 0
      report.oneHourCost = report.policies.find((entry) => entry.policy === '1h')?.cost ?? null
      const { first, gaps: rows } = gapCostsByPings(runs, prices)
      const totals = new Array<number>(MAX_SWEEP_PINGS + 1).fill(first)
      const sent = new Array<number>(MAX_SWEEP_PINGS + 1).fill(0)
      const hours = new Map<number, { gaps: number; costs: number[] }>()
      for (const row of rows) {
        const hour = hours.get(row.hour) ?? { gaps: 0, costs: new Array<number>(MAX_SWEEP_PINGS + 1).fill(0) }
        hour.gaps++
        for (let limit = 0; limit <= MAX_SWEEP_PINGS; limit++) {
          totals[limit] += row.costs[limit]
          sent[limit] += row.sent[limit]
          hour.costs[limit] += row.costs[limit]
        }
        hours.set(row.hour, hour)
      }
      report.pingSweep = totals.map((cost, pings) => ({
        pings,
        idleMinutes: 5 + (pings * KEEP_WARM_EVERY_MS) / MINUTE,
        cost,
        sent: sent[pings],
        saving: current - cost,
      }))
      const fixed = cheapestIndex(totals)
      report.bestPings = report.pingSweep[fixed]
      report.hourly = [...hours.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([hour, entry]) => {
          const pings = entry.gaps >= MIN_GAPS_PER_HOUR ? cheapestIndex(entry.costs) : fixed
          return { hour, gaps: entry.gaps, pings, cost: entry.costs[pings], fixedCost: entry.costs[fixed] }
        })
      report.autoCost = first + report.hourly.reduce((sum, hour) => sum + hour.cost, 0)
      const autoSaving = totals[fixed] - report.autoCost
      // Rounding-sized differences are not a reason to change the count by hour.
      report.autoSaving = autoSaving >= Math.max(0.001, totals[fixed] * MIN_AUTO_SAVING_SHARE) ? autoSaving : 0
    }
    models.push(report)
  }
  models.sort((a, b) => b.measuredCost - a.measuredCost)
  return { models, days: cacheDays(sessions), saving: models.reduce((sum, model) => sum + model.saving, 0) }
}
