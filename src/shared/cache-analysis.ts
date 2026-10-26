/**
 * Prompt-cache analytics, read only: for each cache lifetime and model, what
 * each count of keep-warm pings would have cost, replayed the way Pi warms (a
 * refresh at 90% of the lifetime, and no more refreshes than fit in the 30
 * minutes Pi keeps warming after a run). Every gap keeps its time and its
 * cost at each count, so a chart can add them up over any span and any mix
 * of models, and the CLI prints the same totals.
 */
import { PI_REFRESH_AT, cacheProfile, callTotals, gapCostsByPings, measurePrices, piMaxIdlePings, promptTokens, type CacheRoute } from './cache-policy'
import type { CacheCall, SessionAnalytics } from './session-analytics'

export type CacheGroupId = '5m' | '30m' | 'automatic'
export const CACHE_GROUPS: CacheGroupId[] = ['5m', '30m', 'automatic']
/** How much a recommendation rests on: breaks longer than the lifetime. */
export type CacheConfidence = 'none' | 'early' | 'solid'
export const EARLY_BREAKS = 10
export const SOLID_BREAKS = 20
/** Two counts closer than this per week are called a tie. */
export const TIE_PER_WEEK = 0.25

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
export const SLOT_MS = 30 * MINUTE
export const SLOTS_PER_DAY = DAY / SLOT_MS

/** A gap where the ping count matters: when the call after it ran, its length, and its cost at 0, 1, 2… pings (the pings plus that call). */
export interface CacheGap {
  at: number
  gapMs: number
  costs: number[]
}

export interface CacheModelAnalysis {
  /** `provider/model`. */
  model: string
  route: CacheRoute
  group: CacheGroupId
  calls: number
  /** Measured prompt tokens, and the part of them read from the cache. */
  promptTokens: number
  readTokens: number
  /** Gaps longer than the lifetime: the only ones pings can change. */
  longBreaks: number
  /** Gaps the cache outlives on its own. */
  shortBreaks: number
  /** Prompt cost no ping count changes (each session's first call, calls inside the lifetime; every call's billed cost where pings cannot help), per 30-minute slot start. */
  base: Array<[at: number, cost: number]>
  gaps: CacheGap[]
  /** What the same prompts would have cost with no cache at all (every token at the input price), per 30-minute slot start. */
  noCache: Array<[at: number, cost: number]>
}

export interface CacheGroupAnalysis {
  id: CacheGroupId
  lifetimeMinutes: number | null
  /** Most pings Pi sends before it stops warming. */
  maxPings: number
  /** The longest break that many pings keep warm. */
  reachMinutes: number | null
  models: CacheModelAnalysis[]
}

export interface CacheAnalysis {
  /** Local midnight of the first day and of the day after the last. */
  from: number
  to: number
  days: number
  groups: CacheGroupAnalysis[]
}

function startOfDay(at: number): number {
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

function nextMidnight(at: number): number {
  const day = new Date(startOfDay(at))
  day.setDate(day.getDate() + 1)
  return day.getTime()
}

/** Calendar days from `from` to `to`, counted by local date so a DST day still counts once. */
export function daysBetween(from: number, to: number): number {
  let count = 0
  for (let at = from; at < to && count < 4000; at = nextMidnight(at)) count++
  return count
}

function slotStart(at: number, from: number): number {
  return from + Math.floor((at - from) / SLOT_MS) * SLOT_MS
}

/** Each session's calls per model, in order, without Pi's own pings (the replay sends its own). */
function runsByModel(sessions: SessionAnalytics[]): Map<string, CacheCall[][]> {
  const byModel = new Map<string, CacheCall[][]>()
  for (const facts of sessions) {
    const perModel = new Map<number, CacheCall[]>()
    for (const call of facts.cacheCalls ?? []) {
      if (call[9] === 1) continue
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
  return byModel
}

/** `from`/`to` are the report's window; open ends take the first call's day and today. */
export function buildCacheAnalysis(sessions: SessionAnalytics[], from: number | null, to: number | null, now = Date.now()): CacheAnalysis {
  const byModel = runsByModel(sessions)
  const allCalls = [...byModel.values()].flat(2)
  const start = from ?? (allCalls.length > 0 ? startOfDay(Math.min(...allCalls.map((call) => call[0]))) : startOfDay(now))
  const end = nextMidnight(to ?? now)
  const groups = new Map<CacheGroupId, CacheGroupAnalysis>()
  for (const [model, runs] of byModel) {
    const all = runs.flat()
    if (all.length === 0) continue
    const profile = cacheProfile(model, all)
    const prices = measurePrices(callTotals(all), profile, model)
    const ttlMs = profile.sweep?.ttlMs ?? 0
    const id: CacheGroupId = !profile.sweep || !prices ? 'automatic' : ttlMs >= 30 * MINUTE ? '30m' : '5m'
    const maxPings = id === 'automatic' ? 0 : piMaxIdlePings(ttlMs)
    const group = groups.get(id) ?? {
      id,
      lifetimeMinutes: id === 'automatic' ? null : ttlMs / MINUTE,
      maxPings,
      reachMinutes: id === 'automatic' ? null : (ttlMs + maxPings * ttlMs * PI_REFRESH_AT) / MINUTE,
      models: [],
    }
    const entry: CacheModelAnalysis = {
      model,
      route: profile.route,
      group: id,
      calls: all.length,
      promptTokens: all.reduce((sum, call) => sum + promptTokens(call), 0),
      readTokens: all.reduce((sum, call) => sum + call[3], 0),
      longBreaks: 0,
      shortBreaks: 0,
      base: [],
      gaps: [],
      noCache: [],
    }
    if (profile.sweep && prices && id !== 'automatic') {
      const everyMs = ttlMs * PI_REFRESH_AT
      const { openings, gaps } = gapCostsByPings(runs, { ...profile.sweep, everyMs, horizonMs: ttlMs + maxPings * everyMs }, prices)
      const base = new Map<number, number>()
      const addBase = (at: number, cost: number): void => {
        const slot = slotStart(at, start)
        base.set(slot, (base.get(slot) ?? 0) + cost)
      }
      for (const [at, cost] of openings) addBase(at, cost)
      for (const gap of gaps) {
        if (gap.gapMs > ttlMs) entry.longBreaks++
        else entry.shortBreaks++
        if (gap.costs.every((cost) => Math.abs(cost - gap.costs[0]) < 1e-12)) addBase(gap.at, gap.costs[0])
        else entry.gaps.push({ at: gap.at, gapMs: gap.gapMs, costs: gap.costs })
      }
      entry.base = [...base.entries()].sort((a, b) => a[0] - b[0])
      const uncached = new Map<number, number>()
      for (const call of all) {
        const slot = slotStart(call[0], start)
        uncached.set(slot, (uncached.get(slot) ?? 0) + promptTokens(call) * prices.inputPrice)
      }
      entry.noCache = [...uncached.entries()].sort((a, b) => a[0] - b[0])
    } else {
      // Pings cannot change it: chart what the calls were billed.
      const billed = new Map<number, number>()
      for (const call of all) {
        const slot = slotStart(call[0], start)
        billed.set(slot, (billed.get(slot) ?? 0) + call[6] + call[7] + call[8])
      }
      entry.base = [...billed.entries()].sort((a, b) => a[0] - b[0])
    }
    group.models.push(entry)
    groups.set(id, group)
  }
  for (const group of groups.values()) group.models.sort((a, b) => b.calls - a.calls)
  return {
    from: start,
    to: end,
    days: daysBetween(start, end),
    groups: CACHE_GROUPS.map((id) => groups.get(id)).filter((group): group is CacheGroupAnalysis => group !== undefined),
  }
}

export function confidenceOf(longBreaks: number): CacheConfidence {
  return longBreaks >= SOLID_BREAKS ? 'solid' : longBreaks >= EARLY_BREAKS ? 'early' : 'none'
}

function cheapest(totals: number[]): number {
  let best = 0
  for (let index = 1; index < totals.length; index++) if (totals[index] < totals[best] - 1e-12) best = index
  return best
}

/** Each count's cost over the gaps of `models` between `fromAt` and `toAt`. */
export function countTotals(models: CacheModelAnalysis[], maxPings: number, fromAt = -Infinity, toAt = Infinity): number[] {
  const totals = new Array<number>(maxPings + 1).fill(0)
  for (const model of models) {
    for (const gap of model.gaps) {
      if (gap.at < fromAt || gap.at >= toAt) continue
      for (let count = 0; count <= maxPings; count++) totals[count] += gap.costs[count]
    }
  }
  return totals
}

export interface PingSummary {
  /** Cost of the gaps at each count. */
  totals: number[]
  best: number
  /** The next cheapest count when it is within `TIE_PER_WEEK` of the best. */
  tie: number | null
  /** What the best count saves over no pings, per week. */
  savingPerWeek: number
  longBreaks: number
  confidence: CacheConfidence
  hitRate: number | null
  /** Each model's own best count, or the shared best while its own data is thin. */
  modelBest: Map<string, number>
  /** Gap cost with every model on its own count, and with the cheapest count at every gap (hindsight). */
  perModelTotal: number
  perBreakTotal: number
  /** Prompt cost no count changes, and the whole prompt cost with no cache at all. */
  baseTotal: number
  noCacheTotal: number
  /** What caching with the best count saves over no cache, per week; below 0 when no cache would have been cheaper. */
  cacheSavingPerWeek: number
}

export function summarize(models: CacheModelAnalysis[], maxPings: number, days: number): PingSummary {
  const weeks = Math.max(days, 1) / 7
  const totals = countTotals(models, maxPings)
  const best = cheapest(totals)
  const runnerUp = totals.map((cost, count) => ({ cost, count })).filter(({ count }) => count !== best).sort((a, b) => a.cost - b.cost)[0]
  const tie = runnerUp && runnerUp.count !== 0 && best !== 0 && (runnerUp.cost - totals[best]) / weeks < TIE_PER_WEEK ? runnerUp.count : null
  const longBreaks = models.reduce((sum, model) => sum + model.longBreaks, 0)
  const promptTotal = models.reduce((sum, model) => sum + model.promptTokens, 0)
  const modelBest = new Map<string, number>()
  let perModelTotal = 0
  let perBreakTotal = 0
  let baseTotal = 0
  let noCacheTotal = 0
  for (const model of models) {
    for (const [, cost] of model.base) baseTotal += cost
    for (const [, cost] of model.noCache) noCacheTotal += cost
    const own = confidenceOf(model.longBreaks) === 'none' ? best : cheapest(countTotals([model], maxPings))
    modelBest.set(model.model, own)
    for (const gap of model.gaps) {
      perModelTotal += gap.costs[own]
      perBreakTotal += Math.min(...gap.costs)
    }
  }
  return {
    totals,
    best,
    tie,
    savingPerWeek: (totals[0] - totals[best]) / weeks,
    longBreaks,
    confidence: confidenceOf(longBreaks),
    hitRate: promptTotal > 0 ? models.reduce((sum, model) => sum + model.readTokens, 0) / promptTotal : null,
    modelBest,
    perModelTotal,
    perBreakTotal,
    baseTotal,
    noCacheTotal,
    cacheSavingPerWeek: (noCacheTotal - baseTotal - totals[best]) / weeks,
  }
}

/**
 * Prompt cost per 30-minute slot from `from` with `count` pings (capped at
 * what Pi sends for the model), or with the cheapest count at every break
 * (`perBreak`, hindsight), and with none; each array has `slots` entries.
 */
export function slotCosts(model: CacheModelAnalysis, count: number | 'perBreak', from: number, slots: number): { cost: number[]; none: number[] } {
  const cost = new Array<number>(slots).fill(0)
  const none = new Array<number>(slots).fill(0)
  const slotOf = (at: number): number => Math.min(slots - 1, Math.max(0, Math.floor((at - from) / SLOT_MS)))
  for (const [at, value] of model.base) {
    const slot = slotOf(at)
    cost[slot] += value
    none[slot] += value
  }
  for (const gap of model.gaps) {
    const slot = slotOf(gap.at)
    cost[slot] += count === 'perBreak' ? Math.min(...gap.costs) : gap.costs[Math.min(count, gap.costs.length - 1)]
    none[slot] += gap.costs[0]
  }
  return { cost, none }
}

/** What the same prompts would have cost with no cache at all, per 30-minute slot from `from`. */
export function slotNoCache(model: CacheModelAnalysis, from: number, slots: number): number[] {
  const cost = new Array<number>(slots).fill(0)
  for (const [at, value] of model.noCache) cost[Math.min(slots - 1, Math.max(0, Math.floor((at - from) / SLOT_MS)))] += value
  return cost
}

/** The best count for every model across groups: its own once it has enough breaks, else its group's. */
export function optimalCounts(analysis: CacheAnalysis): Map<string, number> {
  const counts = new Map<string, number>()
  for (const group of analysis.groups) {
    if (group.id === 'automatic') continue
    for (const [model, count] of summarize(group.models, group.maxPings, analysis.days).modelBest) counts.set(model, count)
  }
  return counts
}

/** The cheapest count for the gaps ending in each slot of a day, or null where no gap's count mattered. */
export function slotBest(models: CacheModelAnalysis[], maxPings: number, dayStart: number, slots = SLOTS_PER_DAY): Array<{ best: number; gaps: CacheGap[]; saving: number } | null> {
  const cells: Array<CacheGap[]> = Array.from({ length: slots }, () => [])
  for (const model of models) {
    for (const gap of model.gaps) {
      const slot = Math.floor((gap.at - dayStart) / SLOT_MS)
      if (slot >= 0 && slot < slots) cells[slot].push(gap)
    }
  }
  return cells.map((gaps) => {
    if (gaps.length === 0) return null
    const totals = new Array<number>(maxPings + 1).fill(0)
    for (const gap of gaps) for (let count = 0; count <= maxPings; count++) totals[count] += gap.costs[count]
    const best = cheapest(totals)
    return { best, gaps, saving: totals[0] - totals[best] }
  })
}

/** The two most recent weeks' best counts and savings, when the window holds two weeks. */
export function weekSplit(models: CacheModelAnalysis[], maxPings: number, to: number, days: number): { earlier: { best: number; saving: number }; later: { best: number; saving: number } } | null {
  if (days < 14) return null
  const middle = new Date(to)
  middle.setDate(middle.getDate() - 7)
  const start = new Date(middle)
  start.setDate(start.getDate() - 7)
  const part = (fromAt: number, toAt: number): { best: number; saving: number } => {
    const totals = countTotals(models, maxPings, fromAt, toAt)
    const best = cheapest(totals)
    return { best, saving: totals[0] - totals[best] }
  }
  return { earlier: part(start.getTime(), middle.getTime()), later: part(middle.getTime(), to) }
}

/** Local day starts from `from` to `to`, for the day strip and the zoomed view. */
export function dayStarts(from: number, to: number): number[] {
  const starts: number[] = []
  for (let at = from; at < to && starts.length < 4000; at = nextMidnight(at)) starts.push(at)
  return starts
}

