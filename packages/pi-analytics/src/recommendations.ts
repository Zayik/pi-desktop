/**
 * Settings the cache report found cheaper than the current one, limited to
 * what Pi can run: the short lifetime with up to as many idle refreshes as
 * Pi sends before it stops warming, or the long lifetime where Pi can ask
 * for it. Each comes with its saving per week, so it can be applied as is.
 */
import type { AnalyticsReport } from '../../../src/shared/analytics-report'
import type { ModelCacheReport, PingSweepPoint } from '../../../src/shared/cache-policy'
import type { ModelCachePlan } from './cache-plan'
import { advertisedCacheLifetime } from '../../../resources/context-snapshot'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
/** Pi stops idle warming this long after a run ends (`MAX_IDLE_WARMING_AGE_MS` in its cache warmer). */
export const PI_IDLE_WARMING_MS = 30 * MINUTE
/** Pi refreshes an entry at this share of its lifetime. */
const PI_REFRESH_AT = 0.9
/** A recommendation must save at least this share of the current cost, and this much a week. */
const MIN_SAVING_SHARE = 0.02
const MIN_WEEKLY_SAVING = 0.01

/** Breaks longer than the short lifetime a model needs on record before it gets a recommendation. */
export const MIN_BREAKS = 20
/** The long lifetime is offered beside the ping count only when it costs at least this share less. */
export const LONG_MARGIN = 0.1

/** One setting and what it would have saved. */
export interface CacheOption {
  /** The plan entry that applies it (without `appliedAt`). */
  setting: Omit<ModelCachePlan, 'appliedAt' | 'source'>
  /** The report's name for the setting, e.g. `5m` or `1h`. */
  policy: string
  /** Idle time the refreshes keep the cache warm through, for keep-warm. */
  idleMinutes: number | null
  cost: number
  /** Over the report's window, and per week. */
  saving: number
  weeklySaving: number
}

/** The best ping count Pi can run for a model, and the long lifetime when it is clearly cheaper still. */
export interface CacheRecommendation extends CacheOption {
  /** `provider/model`. */
  model: string
  currentCost: number
  /** Breaks longer than the short lifetime the figures rest on. */
  breaks: number
  /** The cheapest count in the replay, when Pi stops warming before it. */
  beyondPi: PingSweepPoint | null
  /** The long lifetime, opt-in: only when it costs `LONG_MARGIN` less than the ping count. */
  alternative: CacheOption | null
}

export type CacheCheckStatus = 'recommend' | 'not-enough-data' | 'no-saving' | 'long-only' | 'not-covered'

/** What checking one model found, including why there is no recommendation. */
export interface CacheCheck {
  model: string
  status: CacheCheckStatus
  breaks: number
  minBreaks: number
  recommendation: CacheRecommendation | null
  /** With `long-only`: no ping count is worth changing to, but the long lifetime is. */
  alternative: CacheOption | null
}

/** Most idle refreshes Pi sends for a model's short lifetime before it stops warming. */
export function piMaxIdlePings(shortTtlMs: number): number {
  return shortTtlMs > 0 ? Math.floor(PI_IDLE_WARMING_MS / (shortTtlMs * PI_REFRESH_AT)) : 0
}

/** A `provider/model` key's advertised short lifetime, or null for a model Pi has no lifetime for (and so never warms). */
export function shortLifetimeMs(model: string): number | null {
  const slash = model.indexOf('/')
  if (slash <= 0) return null
  const lifetime = advertisedCacheLifetime(model.slice(0, slash), model.slice(slash + 1))
  return lifetime ? lifetime.short * 1000 : null
}

/** Minutes the cache stays warm after the agent stops with this many idle refreshes. */
export function idleWarmMinutes(shortTtlMs: number, pings: number): number {
  return Math.round((shortTtlMs + pings * shortTtlMs * PI_REFRESH_AT) / MINUTE)
}

/** Pi's long tier reaches the report's long lifetime for Anthropic (1 hour) and older OpenAI models (24-hour retention), not GPT-5.6's 12 hours. */
function piCanRunLong(model: ModelCacheReport): boolean {
  return model.family === 'anthropic' || model.family === 'openai-implicit'
}

/** Days the report covers, for the weekly figure. */
export function reportDays(report: AnalyticsReport, now = Date.now()): number {
  const first = report.from ?? (report.days[0] ? new Date(`${report.days[0].day}T00:00:00`).getTime() : now)
  const last = report.to ?? now
  return Math.max(1, (last - first) / DAY)
}

function currentCost(model: ModelCacheReport): number | null {
  const current = model.policies.find((policy) => policy.policy === model.currentPolicy)
  return current?.cost ?? model.pingSweep[0]?.cost ?? null
}

/** Breaks longer than the model's short lifetime. */
export function breaksOf(model: ModelCacheReport): number {
  const gaps = model.gapBuckets.reduce((sum, count) => sum + count, 0)
  return Math.round(gaps * model.longGapShare)
}

/** Check one model: the best ping count Pi can run, the long lifetime as an opt-in, or why there is nothing to recommend. */
export function checkModel(model: ModelCacheReport, days: number): CacheCheck {
  const breaks = breaksOf(model)
  const result = (status: CacheCheckStatus, recommendation: CacheRecommendation | null = null, alternative: CacheOption | null = null): CacheCheck =>
    ({ model: model.model, status, breaks, minBreaks: MIN_BREAKS, recommendation, alternative })
  const current = currentCost(model)
  if (current === null || !model.sweepPolicy || model.pingSweep.length === 0) return result('not-covered')
  if (breaks < MIN_BREAKS) return result('not-enough-data')
  const cap = piMaxIdlePings(model.shortTtlMs)
  const best = model.pingSweep
    .filter((point) => point.pings <= cap)
    .reduce<PingSweepPoint | null>((low, point) => (low === null || point.cost < low.cost ? point : low), null)
  if (!best) return result('not-covered')
  const option = (setting: CacheOption['setting'], policy: string, cost: number, idleMinutes: number | null): CacheOption =>
    ({ setting, policy, idleMinutes, cost, saving: current - cost, weeklySaving: ((current - cost) / days) * 7 })
  const worthIt = (candidate: CacheOption): boolean => candidate.saving > current * MIN_SAVING_SHARE && candidate.weeklySaving >= MIN_WEEKLY_SAVING
  const pings = best.pings === 0
    ? option({ mode: 'focus' }, model.sweepPolicy, best.cost, null)
    : option({ mode: 'keep-warm', idlePings: best.pings }, model.sweepPolicy, best.cost, best.idleMinutes)
  const long = model.longPolicy && model.longCost !== null && piCanRunLong(model) && model.longCost <= best.cost * (1 - LONG_MARGIN)
    ? option({ mode: 'long' }, model.longPolicy, model.longCost, null)
    : null
  const alternative = long && worthIt(long) ? long : null
  if (!worthIt(pings)) return alternative ? result('long-only', null, alternative) : result('no-saving')
  const overall = model.bestPings
  const beyondPi = overall && overall.pings > cap && overall.cost < best.cost ? overall : null
  return result('recommend', { ...pings, model: model.model, currentCost: current, breaks, beyondPi, alternative }, alternative)
}

/** The recommendation for one model, or null. */
export function recommendFor(model: ModelCacheReport, days: number): CacheRecommendation | null {
  return checkModel(model, days).recommendation
}

/** Every model the report covers, checked. */
export function cacheChecks(report: AnalyticsReport, now = Date.now()): CacheCheck[] {
  const days = reportDays(report, now)
  return report.cache.models.map((model) => checkModel(model, days))
}

/** A recommendation with its long alternative as the setting, to apply that instead. */
export function withAlternative(rec: CacheRecommendation): CacheRecommendation | null {
  return rec.alternative ? { ...rec, ...rec.alternative, alternative: null } : null
}

/** Every model's recommendation, the biggest weekly saving first. */
export function recommendations(report: AnalyticsReport, now = Date.now()): CacheRecommendation[] {
  const days = reportDays(report, now)
  return report.cache.models
    .map((model) => recommendFor(model, days))
    .filter((rec): rec is CacheRecommendation => rec !== null)
    .sort((a, b) => b.weeklySaving - a.weeklySaving)
}

/** One line for a terminal or a notification, e.g. "anthropic/claude-haiku-5-5: keep warm 15 min after the agent stops (3 refreshes), saves $20.00 a week". */
export function describeRecommendation(rec: CacheRecommendation): string {
  const saves = `saves $${rec.weeklySaving.toFixed(2)} a week`
  const setting = rec.setting
  if (setting.mode === 'keep-warm') {
    const pings = setting.idlePings ?? 0
    return `${rec.model}: keep warm ${Math.round(rec.idleMinutes ?? 0)} min after the agent stops (${pings} ${pings === 1 ? 'refresh' : 'refreshes'}), ${saves}`
  }
  if (setting.mode === 'long') return `${rec.model}: use the ${rec.policy} cache, ${saves}`
  return `${rec.model}: no refreshes after the agent stops, ${saves}`
}
