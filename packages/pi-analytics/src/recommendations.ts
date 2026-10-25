/**
 * Settings the cache report found cheaper than the current one, limited to
 * what Pi can run: the short lifetime with up to as many idle refreshes as
 * Pi sends before it stops warming, or the long lifetime where Pi can ask
 * for it. Each comes with its saving per week, so it can be applied as is.
 */
import type { AnalyticsReport } from '../../../src/shared/analytics-report'
import type { ModelCacheReport, PingSweepPoint } from '../../../src/shared/cache-policy'
import type { ModelCachePlan } from './cache-plan'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
/** Pi stops idle warming this long after a run ends (`MAX_IDLE_WARMING_AGE_MS` in its cache warmer). */
export const PI_IDLE_WARMING_MS = 30 * MINUTE
/** Pi refreshes an entry at this share of its lifetime. */
const PI_REFRESH_AT = 0.9
/** A recommendation must save at least this share of the current cost, and this much a week. */
const MIN_SAVING_SHARE = 0.02
const MIN_WEEKLY_SAVING = 0.01

export interface CacheRecommendation {
  /** `provider/model`. */
  model: string
  /** The plan entry that applies it (without `appliedAt`). */
  setting: Omit<ModelCachePlan, 'appliedAt' | 'source'>
  /** The report's name for the setting, e.g. `5m` or `1h`. */
  policy: string
  /** Idle time the refreshes keep the cache warm through, for keep-warm. */
  idleMinutes: number | null
  currentCost: number
  cost: number
  /** Over the report's window, and per week. */
  saving: number
  weeklySaving: number
  /** The cheapest count in the replay, when Pi stops warming before it. */
  beyondPi: PingSweepPoint | null
}

/** Most idle refreshes Pi sends for a model's short lifetime before it stops warming. */
export function piMaxIdlePings(shortTtlMs: number): number {
  return shortTtlMs > 0 ? Math.floor(PI_IDLE_WARMING_MS / (shortTtlMs * PI_REFRESH_AT)) : 0
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

/** The cheapest setting Pi can run for one model, when it beats the current one by enough to act on. */
export function recommendFor(model: ModelCacheReport, days: number): CacheRecommendation | null {
  const current = currentCost(model)
  if (current === null || !model.sweepPolicy || model.pingSweep.length === 0) return null
  const cap = piMaxIdlePings(model.shortTtlMs)
  const reachable = model.pingSweep.filter((point) => point.pings <= cap)
  const best = reachable.reduce<PingSweepPoint | null>((low, point) => (low === null || point.cost < low.cost ? point : low), null)
  const overall = model.bestPings
  const beyondPi = overall && best && overall.pings > cap && overall.cost < best.cost ? overall : null
  const options: { setting: CacheRecommendation['setting']; policy: string; cost: number; idleMinutes: number | null }[] = []
  if (best) {
    options.push(best.pings === 0
      ? { setting: { mode: 'focus' }, policy: model.sweepPolicy, cost: best.cost, idleMinutes: null }
      : { setting: { mode: 'keep-warm', idlePings: best.pings }, policy: model.sweepPolicy, cost: best.cost, idleMinutes: best.idleMinutes })
  }
  if (model.longPolicy && model.longCost !== null && piCanRunLong(model)) {
    options.push({ setting: { mode: 'long' }, policy: model.longPolicy, cost: model.longCost, idleMinutes: null })
  }
  const pick = options.reduce<(typeof options)[number] | null>((low, option) => (low === null || option.cost < low.cost ? option : low), null)
  if (!pick) return null
  const saving = current - pick.cost
  const weeklySaving = (saving / days) * 7
  if (saving <= current * MIN_SAVING_SHARE || weeklySaving < MIN_WEEKLY_SAVING) return null
  return { model: model.model, setting: pick.setting, policy: pick.policy, idleMinutes: pick.idleMinutes, currentCost: current, cost: pick.cost, saving, weeklySaving, beyondPi }
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
