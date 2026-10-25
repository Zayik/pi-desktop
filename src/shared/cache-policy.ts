/**
 * What past sessions would have cost under each prompt-cache setting their
 * provider offers, replayed from the real calls: their prompt sizes and the
 * real gaps between them. Output costs the same under every setting, so only
 * prompt cost is compared.
 *
 * The replay is an estimate: it assumes the same calls at the same times,
 * and that each call reuses the previous call's prompt as its cached prefix.
 * The measured cost next to it is what the provider billed.
 *
 * Provider rules (checked 2026-10-25):
 * - Anthropic (API, Bedrock, Vertex, OpenRouter): 5 minutes (write 1.25x) or
 *   1 hour (write 2x), read 0.1x (0.05x Opus/Sonnet 5.5, 0.025x Fable and
 *   Mythos 5.1). A hit restarts the lifetime.
 * - OpenAI GPT-5.6 and later: 30 minutes (write 1.25x) or 12 hours (write
 *   2.5x), read 0.1x (0.05x GPT-6.1 Sol). A hit keeps an entry at least 30
 *   minutes past the read but does not restart the 12 hour clock.
 * - Earlier OpenAI models: automatic, no write charge, a model-dependent read
 *   price. In-memory entries live about 5 to 10 minutes idle; `24h` retention
 *   (no extra charge) typically about 30 minutes. Both are estimates.
 * - GitHub Copilot: billed per token at the upstream rates (Claude with the
 *   5 minute write price, GPT-5.6+ with the 30 minute one, older models with
 *   none). Its docs list no longer lifetime, though its backend takes
 *   Anthropic's `ttl: "1h"` (VS Code's extendedTtl setting sends it).
 */
import { localDayKey, type CacheCall, type SessionAnalytics } from './session-analytics'

export type CacheProvider = 'anthropic' | 'openai' | 'other'
/** How a model caches: Anthropic's two lifetimes, OpenAI's two lifetimes, OpenAI's automatic cache, or nothing to set. */
export type CacheFamily = 'anthropic' | 'openai-ttl' | 'openai-implicit' | 'none'
/** Copilot passes the cache through but offers no lifetime setting. */
export type CacheRoute = 'api' | 'copilot'

export type CachePolicyId =
  | 'none'
  | '5m' | '5m-warm-30m' | '5m-warm-60m' | '5m-warm-break-even' | '1h'
  | '30m' | '30m-warm-6h' | '30m-warm-12h' | '30m-warm-break-even' | '12h'
  | 'in-memory' | 'in-memory-warm-30m' | 'in-memory-warm-60m' | 'in-memory-warm-break-even' | '24h'

/** Facts about a model's caching the cost table alone does not show. */
export type CacheNote =
  /** Copilot lists no longer lifetime for this model; only keep-warm pings could change the timing. */
  | 'copilot-lifetime'
  /** Copilot accepts Anthropic's 1 hour lifetime but does not document or list a price for it. */
  | 'copilot-1h-unlisted'
  /** Copilot caches the model automatically and there is nothing to set. */
  | 'copilot-automatic'
  /** The automatic cache's lifetimes are typical values, not guarantees. */
  | 'implicit-lifetime'
  /** Pi's long retention asks OpenAI for 30 minutes on this model, so 12 hours cannot be picked from Pi. */
  | 'pi-no-12h'
  /** Pi's cache warming runs only for models that declare a cache lifetime, so pings here are a what-if. */
  | 'pi-no-pings'

export interface PolicySpec {
  id: CachePolicyId
  ttlMs: number
  /** Cache write price as a multiple of the input price. */
  write: number
  /**
   * Set when a hit does not restart the lifetime (OpenAI's 12 hours): an
   * entry lives `ttlMs` from its write, or this long past its last read if
   * that is later.
   */
  hitKeepsMs?: number
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

/** Pings on a 5 minute cache: 4 minutes apart leaves a minute of margin. */
export const KEEP_WARM_EVERY_MS = 4 * MINUTE
/** Pings on a 30 minute cache, with the same share of margin. */
const KEEP_WARM_30M_EVERY_MS = 24 * MINUTE
/** The Anthropic ping sweep tries 0 to this many pings per idle gap: enough to keep 5 minutes warm through a whole hour. */
export const MAX_SWEEP_PINGS = Math.ceil((HOUR - 5 * MINUTE) / KEEP_WARM_EVERY_MS)
/** An hour of the day with fewer gaps than this keeps the best fixed count in the auto schedule. */
const MIN_GAPS_PER_HOUR = 5
/** The hourly schedule is worth mentioning from this share of the best fixed count's cost. */
const MIN_AUTO_SAVING_SHARE = 0.01
/** Upper bounds of the gap histogram's buckets; the last bucket is everything longer. */
export const GAP_BUCKET_MINUTES = [1, 5, 10, 15, 30, 60]

/** The short lifetime a ping sweep keeps warm, how far apart its pings are, and how much idle it sweeps. */
interface SweepSpec {
  base: CachePolicyId
  ttlMs: number
  write: number
  everyMs: number
  horizonMs: number
}

interface CacheProfile {
  family: CacheFamily
  route: CacheRoute
  policies: PolicySpec[]
  /** What the calls ran with when they do not show it. */
  defaultPolicy: CachePolicyId | null
  /** The longer lifetime the sweep is drawn against. */
  longPolicy: CachePolicyId | null
  sweep: SweepSpec | null
  notes: CacheNote[]
}

function warmPolicies(ttlMs: number, write: number, everyMs: number, limits: Array<[CachePolicyId, number]>, breakEven: CachePolicyId): PolicySpec[] {
  return [
    ...limits.map(([id, forMs]): PolicySpec => ({ id, ttlMs, write, warm: { everyMs, forMs } })),
    { id: breakEven, ttlMs, write, warm: { everyMs, forMs: 24 * HOUR, breakEven: true } },
  ]
}

const ANTHROPIC_SHORT: PolicySpec[] = [
  { id: 'none', ttlMs: 0, write: 1 },
  { id: '5m', ttlMs: 5 * MINUTE, write: 1.25 },
  // Half the long lifetime, the whole of it, and as long as pinging is cheaper than writing again.
  ...warmPolicies(5 * MINUTE, 1.25, KEEP_WARM_EVERY_MS, [['5m-warm-30m', 30 * MINUTE], ['5m-warm-60m', HOUR]], '5m-warm-break-even'),
]
const OPENAI_SHORT: PolicySpec[] = [
  { id: 'none', ttlMs: 0, write: 1 },
  { id: '30m', ttlMs: 30 * MINUTE, write: 1.25 },
  ...warmPolicies(30 * MINUTE, 1.25, KEEP_WARM_30M_EVERY_MS, [['30m-warm-6h', 6 * HOUR], ['30m-warm-12h', 12 * HOUR]], '30m-warm-break-even'),
]
// The automatic cache has no write price and cannot be turned off; 5 minutes is the low end of in-memory's 5 to 10.
const IMPLICIT_SHORT: PolicySpec[] = [
  { id: 'in-memory', ttlMs: 5 * MINUTE, write: 1 },
  ...warmPolicies(5 * MINUTE, 1, KEEP_WARM_EVERY_MS, [['in-memory-warm-30m', 30 * MINUTE], ['in-memory-warm-60m', HOUR]], 'in-memory-warm-break-even'),
]

const ANTHROPIC_SWEEP: SweepSpec = { base: '5m', ttlMs: 5 * MINUTE, write: 1.25, everyMs: KEEP_WARM_EVERY_MS, horizonMs: HOUR }
const OPENAI_SWEEP: SweepSpec = { base: '30m', ttlMs: 30 * MINUTE, write: 1.25, everyMs: KEEP_WARM_30M_EVERY_MS, horizonMs: 12 * HOUR }
const IMPLICIT_SWEEP: SweepSpec = { base: 'in-memory', ttlMs: 5 * MINUTE, write: 1, everyMs: KEEP_WARM_EVERY_MS, horizonMs: HOUR }

function openAIModelId(id: string): boolean {
  return /(^|[./])(gpt|o\d|chatgpt|codex)/.test(id)
}

/** GPT-5.6 and later price cache writes and take a lifetime; earlier models cache automatically. */
function openAIHasLifetimes(id: string, calls: CacheCall[]): boolean {
  return /gpt-(5\.([6-9]|\d{2,})|[6-9]|\d{2,})/.test(id) || id.includes('daybreak') || calls.some((call) => call[4] > 0)
}

export function cacheProvider(model: string): CacheProvider {
  const [provider, ...rest] = model.split('/')
  const id = rest.join('/').toLowerCase()
  const name = provider.toLowerCase()
  if (name.includes('anthropic') || id.includes('claude')) return 'anthropic'
  if (name.includes('openai') || openAIModelId(id)) return 'openai'
  return 'other'
}

function cacheProfile(model: string, calls: CacheCall[]): CacheProfile {
  const [provider, ...rest] = model.split('/')
  const id = rest.join('/').toLowerCase()
  const route: CacheRoute = provider.toLowerCase() === 'github-copilot' ? 'copilot' : 'api'
  const kind = cacheProvider(model)
  if (kind === 'anthropic') {
    return route === 'copilot'
      // Copilot's price list shows only the 5 minute write, but its backend takes `ttl: "1h"` (VS Code's extendedTtl setting uses it).
      ? { family: 'anthropic', route, policies: [...ANTHROPIC_SHORT, { id: '1h', ttlMs: HOUR, write: 2 }], defaultPolicy: '5m', longPolicy: '1h', sweep: ANTHROPIC_SWEEP, notes: ['copilot-1h-unlisted', 'pi-no-pings'] }
      : { family: 'anthropic', route, policies: [...ANTHROPIC_SHORT, { id: '1h', ttlMs: HOUR, write: 2 }], defaultPolicy: '5m', longPolicy: '1h', sweep: ANTHROPIC_SWEEP, notes: [] }
  }
  if (kind === 'openai' && openAIHasLifetimes(id, calls)) {
    return route === 'copilot'
      ? { family: 'openai-ttl', route, policies: OPENAI_SHORT, defaultPolicy: '30m', longPolicy: null, sweep: OPENAI_SWEEP, notes: ['copilot-lifetime', 'pi-no-pings'] }
      : {
        family: 'openai-ttl',
        route,
        policies: [...OPENAI_SHORT, { id: '12h', ttlMs: 12 * HOUR, write: 2.5, hitKeepsMs: 30 * MINUTE }],
        defaultPolicy: '30m',
        longPolicy: '12h',
        sweep: OPENAI_SWEEP,
        notes: ['pi-no-12h', 'pi-no-pings'],
      }
  }
  if (kind === 'openai') {
    return route === 'copilot'
      ? { family: 'openai-implicit', route, policies: IMPLICIT_SHORT, defaultPolicy: 'in-memory', longPolicy: null, sweep: IMPLICIT_SWEEP, notes: ['copilot-lifetime', 'implicit-lifetime', 'pi-no-pings'] }
      : {
        family: 'openai-implicit',
        route,
        // 24h retention typically holds about 30 minutes; it is the low end that decides misses.
        policies: [...IMPLICIT_SHORT, { id: '24h', ttlMs: 30 * MINUTE, write: 1 }],
        defaultPolicy: 'in-memory',
        longPolicy: '24h',
        sweep: IMPLICIT_SWEEP,
        notes: ['implicit-lifetime', 'pi-no-pings'],
      }
  }
  return { family: 'none', route, policies: [], defaultPolicy: null, longPolicy: null, sweep: null, notes: route === 'copilot' ? ['copilot-automatic'] : [] }
}

/** Cache read price as a multiple of input, from the list prices, when the sessions never show one. */
function defaultReadRatio(family: CacheFamily, model: string): number {
  const id = model.toLowerCase()
  if (family === 'anthropic') {
    if (/(fable|mythos)-5[-.]1/.test(id)) return 0.025
    if (/(opus|sonnet)-5[-.]5/.test(id)) return 0.05
    return 0.1
  }
  if (family === 'openai-ttl') return /gpt-6[-.]1-sol/.test(id) ? 0.05 : 0.1
  if (family === 'openai-implicit') {
    if (/gpt-4o|(^|\/)o1/.test(id)) return 0.5
    if (/gpt-4\.1|(^|\/)o[34]/.test(id)) return 0.25
  }
  return 0.1
}

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
  family: CacheFamily
  route: CacheRoute
  notes: CacheNote[]
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
  medianGapMs: number
  /** Share of gaps longer than the short lifetime (`shortTtlMs`). */
  longGapShare: number
  /** The provider's short lifetime: 5 minutes, or 30 for GPT-5.6 and later. */
  shortTtlMs: number
  /** Gaps between calls per `GAP_BUCKET_MINUTES` bucket, plus one for longer gaps. */
  gapBuckets: number[]
  /** The setting the ping sweep keeps warm, and how far apart its pings are. */
  sweepPolicy: CachePolicyId | null
  pingEveryMs: number
  /**
   * The short lifetime plus at most 0, 1, 2… pings per idle gap, up to
   * enough to cover the long lifetime, and the count that would have cost
   * least.
   */
  pingSweep: PingSweepPoint[]
  bestPings: PingSweepPoint | null
  /** The long lifetime's replayed cost, to compare the sweep with (null where there is no long setting). */
  longPolicy: CachePolicyId | null
  longCost: number | null
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

interface Prices {
  inputPrice: number
  readRatio: number
  readRatioMeasured: boolean
}

interface CallTotals {
  input: number
  inputCost: number
  read: number
  readCost: number
  write: number
  writeCost: number
  write1h: number
}

function callTotals(calls: CacheCall[]): CallTotals {
  const totals: CallTotals = { input: 0, inputCost: 0, read: 0, readCost: 0, write: 0, writeCost: 0, write1h: 0 }
  for (const call of calls) {
    totals.input += call[2]
    totals.inputCost += call[6]
    totals.read += call[3]
    totals.readCost += call[7]
    totals.write += call[4]
    totals.writeCost += call[8]
    totals.write1h += call[5]
  }
  return totals
}

/** Input price and read multiple measured from the calls, falling back to the list multiple. */
function measurePrices(totals: CallTotals, profile: CacheProfile, model: string): Prices | null {
  let inputPrice = totals.input > 0 && totals.inputCost > 0 ? totals.inputCost / totals.input : 0
  // A session that sent everything through the cache shows no input price; derive it from the writes.
  if (inputPrice === 0 && totals.write > 0 && totals.writeCost > 0) {
    const multiple = profile.family === 'anthropic' && totals.write1h > totals.write / 2 ? 2 : 1.25
    inputPrice = totals.writeCost / totals.write / multiple
  }
  if (inputPrice === 0) return null
  const measured = totals.read > 0 && totals.readCost > 0
  return {
    inputPrice,
    readRatio: measured ? totals.readCost / totals.read / inputPrice : defaultReadRatio(profile.family, model),
    readRatioMeasured: measured,
  }
}

/**
 * The setting the calls ran with: Anthropic's one-hour writes mean 1h,
 * OpenAI writes billed near 2.5x mean 12h. Copilot has one setting, and the
 * automatic cache shows none.
 */
function currentPolicy(profile: CacheProfile, totals: CallTotals, prices: Prices | null): CachePolicyId | null {
  if (profile.route === 'copilot' && profile.family !== 'anthropic') return profile.defaultPolicy
  if (profile.family === 'anthropic') return totals.write === 0 ? null : totals.write1h > totals.write / 2 ? '1h' : '5m'
  if (profile.family === 'openai-ttl') {
    if (totals.write === 0 || totals.writeCost === 0 || !prices) return null
    return totals.writeCost / totals.write / prices.inputPrice > 1.9 ? '12h' : '30m'
  }
  return null
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
  let expiresAt = -Infinity
  for (const call of calls) {
    const prompt = promptTokens(call)
    const at = call[0]
    if (spec.ttlMs === 0) {
      result.cost += prompt * prices.inputPrice
      continue
    }
    let warm = false
    if (cached > 0) {
      if (at <= expiresAt) warm = true
      else if (spec.warm) {
        // Pings refresh the lifetime; each one reads the whole cached prompt.
        const maxPings = spec.warm.breakEven
          ? Math.floor(spec.write / prices.readRatio)
          : Math.ceil((spec.warm.forMs - spec.ttlMs) / spec.warm.everyMs)
        const needed = Math.ceil((at - expiresAt) / spec.warm.everyMs)
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
      // A read keeps the prefix written earlier: its clock restarts, or with a fixed lifetime only stretches.
      expiresAt = spec.hitKeepsMs !== undefined ? Math.max(expiresAt, at + spec.hitKeepsMs) : at + spec.ttlMs
    } else {
      result.coldCalls++
      result.cost += prompt * prices.inputPrice * spec.write
      expiresAt = at + spec.ttlMs
    }
    cached = prompt
  }
  return result
}

function sweepMaxPings(sweep: SweepSpec): number {
  return Math.ceil((sweep.horizonMs - sweep.ttlMs) / sweep.everyMs)
}

/**
 * Every idle gap's cost (the pings plus the call after it) at each count of
 * 0 to the sweep's maximum pings on the short lifetime, keyed by the local
 * hour the gap starts in. A gap's cost depends only on its own length and
 * prompts, so any schedule of counts is a sum over these rows.
 */
function gapCostsByPings(runs: CacheCall[][], sweep: SweepSpec, prices: Pick<Prices, 'inputPrice' | 'readRatio'>): { first: number; gaps: Array<{ hour: number; costs: number[]; sent: number[] }> } {
  const maxPings = sweepMaxPings(sweep)
  const read = prices.inputPrice * prices.readRatio
  let first = 0
  const gaps: Array<{ hour: number; costs: number[]; sent: number[] }> = []
  for (const run of runs) {
    if (run.length === 0) continue
    first += promptTokens(run[0]) * prices.inputPrice * sweep.write
    for (let index = 1; index < run.length; index++) {
      const cached = promptTokens(run[index - 1])
      const prompt = promptTokens(run[index])
      const gap = run[index][0] - run[index - 1][0]
      const needed = gap <= sweep.ttlMs ? 0 : Math.ceil((gap - sweep.ttlMs) / sweep.everyMs)
      const sameRoot = cached > 0 && prompt >= cached * PREFIX_BREAK
      const costs: number[] = []
      const sent: number[] = []
      for (let limit = 0; limit <= maxPings; limit++) {
        const pings = Math.min(needed, limit)
        const hit = Math.min(cached, prompt)
        const call = needed <= limit && sameRoot
          ? hit * read + (prompt - hit) * prices.inputPrice * sweep.write
          : prompt * prices.inputPrice * sweep.write
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
    const all = runs.flat()
    const profile = cacheProfile(model, all)
    const shortTtlMs = profile.sweep?.ttlMs ?? 5 * MINUTE
    const gaps: number[] = []
    for (const run of runs) for (let index = 1; index < run.length; index++) gaps.push(run[index][0] - run[index - 1][0])
    const measuredCost = all.reduce((sum, call) => sum + call[6] + call[7] + call[8], 0)
    const totals = callTotals(all)
    const prices = measurePrices(totals, profile, model)
    const measuredPolicy = currentPolicy(profile, totals, prices)
    const report: ModelCacheReport = {
      model,
      provider: cacheProvider(model),
      family: profile.family,
      route: profile.route,
      notes: profile.notes,
      calls: all.length,
      sessions: runs.length,
      measuredCost,
      currentPolicy: measuredPolicy ?? profile.defaultPolicy,
      currentPolicyMeasured: measuredPolicy !== null,
      inputPrice: prices?.inputPrice ?? 0,
      readRatio: prices?.readRatio ?? defaultReadRatio(profile.family, model),
      readRatioMeasured: prices?.readRatioMeasured ?? false,
      policies: [],
      recommended: null,
      saving: 0,
      savingShare: 0,
      medianGapMs: median(gaps),
      longGapShare: gaps.length > 0 ? gaps.filter((gap) => gap > shortTtlMs).length / gaps.length : 0,
      shortTtlMs,
      gapBuckets: gapBuckets(gaps),
      sweepPolicy: profile.sweep?.base ?? null,
      pingEveryMs: profile.sweep?.everyMs ?? 0,
      pingSweep: [],
      bestPings: null,
      longPolicy: profile.longPolicy,
      longCost: null,
      hourly: [],
      autoCost: null,
      autoSaving: 0,
    }
    if (profile.policies.length > 0 && prices) {
      report.policies = profile.policies.map((spec) => {
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
    if (profile.sweep && prices) {
      const sweep = profile.sweep
      const maxPings = sweepMaxPings(sweep)
      const current = report.policies.find((entry) => entry.policy === report.currentPolicy)?.cost ?? 0
      report.longCost = report.policies.find((entry) => entry.policy === profile.longPolicy)?.cost ?? null
      const { first, gaps: rows } = gapCostsByPings(runs, sweep, prices)
      const sweepTotals = new Array<number>(maxPings + 1).fill(first)
      const sent = new Array<number>(maxPings + 1).fill(0)
      const hours = new Map<number, { gaps: number; costs: number[] }>()
      for (const row of rows) {
        const hour = hours.get(row.hour) ?? { gaps: 0, costs: new Array<number>(maxPings + 1).fill(0) }
        hour.gaps++
        for (let limit = 0; limit <= maxPings; limit++) {
          sweepTotals[limit] += row.costs[limit]
          sent[limit] += row.sent[limit]
          hour.costs[limit] += row.costs[limit]
        }
        hours.set(row.hour, hour)
      }
      report.pingSweep = sweepTotals.map((cost, pings) => ({
        pings,
        idleMinutes: (sweep.ttlMs + pings * sweep.everyMs) / MINUTE,
        cost,
        sent: sent[pings],
        saving: current - cost,
      }))
      const fixed = cheapestIndex(sweepTotals)
      report.bestPings = report.pingSweep[fixed]
      report.hourly = [...hours.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([hour, entry]) => {
          const pings = entry.gaps >= MIN_GAPS_PER_HOUR ? cheapestIndex(entry.costs) : fixed
          return { hour, gaps: entry.gaps, pings, cost: entry.costs[pings], fixedCost: entry.costs[fixed] }
        })
      report.autoCost = first + report.hourly.reduce((sum, hour) => sum + hour.cost, 0)
      const autoSaving = sweepTotals[fixed] - report.autoCost
      // Rounding-sized differences are not a reason to change the count by hour.
      report.autoSaving = autoSaving >= Math.max(0.001, sweepTotals[fixed] * MIN_AUTO_SAVING_SHARE) ? autoSaving : 0
    }
    models.push(report)
  }
  models.sort((a, b) => b.measuredCost - a.measuredCost)
  return { models, days: cacheDays(sessions), saving: models.reduce((sum, model) => sum + model.saving, 0) }
}
