/**
 * Auto cache mode's schedule: how many idle keep-warm pings to allow for a
 * break that starts in each local hour of the day, per model, from the ping
 * sweep of the cache report (the cheapest count per hour over past breaks).
 */
import { MAX_AUTO_WARMS, emptyAutoWarmSchedule, type AutoWarmSchedule } from '../../resources/context-snapshot'
import { KEEP_WARM_EVERY_MS, type CacheReport, type ModelCacheReport } from './cache-policy'

const HOURS_PER_DAY = 24

/** Each hour's best count; hours with no breaks keep the model's best fixed count. */
function hourPlan(model: ModelCacheReport): number[] | null {
  // Pi only warms models with a prompt-cache lifetime, and a count means 4-minute refreshes of a 5-minute cache.
  if (!model.bestPings || model.family !== 'anthropic' || model.route !== 'api' || model.pingEveryMs !== KEEP_WARM_EVERY_MS) return null
  const plan = new Array<number>(HOURS_PER_DAY).fill(Math.min(model.bestPings.pings, MAX_AUTO_WARMS))
  for (const hour of model.hourly) plan[hour.hour] = Math.min(hour.pings, MAX_AUTO_WARMS)
  return plan
}

/**
 * The schedule for every Anthropic API model with a ping sweep. Models
 * come sorted by cost, so the fallback, for models without a plan of their
 * own, is the plan of the model that costs the most.
 */
export function buildAutoWarmSchedule(report: CacheReport, builtAt: number, days: number): AutoWarmSchedule {
  const schedule = emptyAutoWarmSchedule(builtAt, days)
  for (const model of report.models) {
    const plan = hourPlan(model)
    if (!plan) continue
    schedule.models[model.model] = plan
    schedule.fallback ??= plan
  }
  return schedule
}
