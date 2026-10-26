/**
 * Apply, undo and reset on disk: the plan file, plus Pi's global
 * `cacheWarming`, which must be "idle" for refreshes after the agent stops.
 * That setting is changed only with the caller's consent, and its old value
 * goes into the plan's history so undo and reset put it back.
 */
import { readFileSync } from 'fs'
import {
  DEFAULT_PLAN_KEY,
  changePlan,
  needsIdleWarming,
  resetPlan,
  undoPlan,
  type CachePlan,
  type ModelCachePlan,
} from './cache-plan'
import { readPlan, writeJsonAtomic } from './plan-file'
import { MAX_IDLE_WARMS } from '../../../resources/context-snapshot'
import { analyticsDir, piSettingsPath, planPath } from './paths'
import { describeRecommendation, idleWarmMinutes, piMaxIdlePings, shortLifetimeMs, type CacheRecommendation } from './recommendations'

const IDLE = 'idle'
/** Recorded as the old `cacheWarming` when Pi's settings had none. */
const UNSET = 'unset'

export interface ApplyOptions {
  dir?: string
  settingsPath?: string
  now?: number
  /** May the change set Pi's `cacheWarming` to "idle"? Asked only when an entry needs it. */
  allowIdleWarming?: () => boolean | Promise<boolean>
  /** Days of sessions the recommendations came from. */
  days?: number
}

export interface ApplyResult {
  plan: CachePlan
  /** What changed, one line each. */
  lines: string[]
  /** True when Pi's `cacheWarming` was set to "idle". */
  enabledIdleWarming: boolean
  /** True when an entry needs idle warming but it stays off. */
  idleWarmingOff: boolean
}

function readSettings(path: string): Record<string, unknown> | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    // A settings file that does not parse is never rewritten.
    return null
  }
}

export function readCacheWarming(path = piSettingsPath()): string | null {
  const value = readSettings(path)?.cacheWarming
  return typeof value === 'string' ? value : null
}

/** Set Pi's `cacheWarming` (`unset` removes it), keeping every other setting. False when the file does not parse. */
function writeCacheWarming(path: string, value: string): boolean {
  const settings = readSettings(path)
  if (!settings) return false
  if (value === UNSET) delete settings.cacheWarming
  else settings.cacheWarming = value
  writeJsonAtomic(path, settings)
  return true
}

/** Write recommendations into the plan, one entry per model. */
export async function applyRecommendations(recs: CacheRecommendation[], options: ApplyOptions = {}): Promise<ApplyResult> {
  const now = options.now ?? Date.now()
  const entries: Record<string, ModelCachePlan> = {}
  for (const rec of recs) {
    entries[rec.model] = { ...rec.setting, appliedAt: now, source: { weeklySaving: rec.weeklySaving, days: options.days ?? 0 } }
  }
  return applyEntries(entries, recs.map(describeRecommendation), options)
}

/**
 * Keep `model` warm with `pings` idle refreshes, the count picked by hand.
 * The count is capped at what Pi sends for the model's lifetime before it
 * stops warming: 6 on a 5-minute cache, 1 on a 30-minute one.
 */
export async function setKeepWarmPings(model: string, pings: number, options: ApplyOptions = {}): Promise<ApplyResult> {
  return setModelCache(model, { mode: 'keep-warm', idlePings: pings }, options)
}

/** A model's setting picked by hand; null takes its entry out, so Pi decides for it again. */
export type ManualCacheSetting = { mode: 'focus' | 'long' } | { mode: 'keep-warm'; idlePings: number } | null

/** Set (or with null, clear) one model's entry by hand. Keep warm's count is capped as in `setKeepWarmPings`. */
export async function setModelCache(model: string, setting: ManualCacheSetting, options: ApplyOptions = {}): Promise<ApplyResult> {
  if (!setting) return applyEntries({ [model]: null }, [`${model}: Pi's own setting`], options)
  const appliedAt = options.now ?? Date.now()
  if (setting.mode !== 'keep-warm') return applyEntries({ [model]: { mode: setting.mode, appliedAt } }, [`${model}: ${setting.mode}, set by hand`], options)
  const ttl = shortLifetimeMs(model)
  if (ttl === null) throw new Error(`Pi has no cache lifetime for ${model}, so it never refreshes it.`)
  const cap = piMaxIdlePings(ttl)
  const pings = setting.idlePings
  if (!Number.isInteger(pings) || pings < 0 || pings > cap) throw new Error(`${model} takes 0 to ${cap} idle refreshes.`)
  const line = `${model}: keep warm ${idleWarmMinutes(ttl, pings)} min after the agent stops (${pings} ${pings === 1 ? 'refresh' : 'refreshes'}), set by hand`
  return applyEntries({ [model]: { mode: 'keep-warm', idlePings: pings, appliedAt } }, [line], options)
}

/** Write plan entries (key `*` for the default), turning on idle warming when they need it and the caller agrees. */
export async function applyEntries(entries: Record<string, ModelCachePlan | null>, lines: string[], options: ApplyOptions = {}): Promise<ApplyResult> {
  const dir = options.dir ?? analyticsDir()
  const settingsPath = options.settingsPath ?? piSettingsPath()
  const now = options.now ?? Date.now()
  const plan = readPlan(planPath(dir))
  const needsIdle = Object.values(entries).some(needsIdleWarming)
  const warming = readCacheWarming(settingsPath)
  let enabledIdleWarming = false
  let cacheWarmingBefore: string | undefined
  if (needsIdle && warming !== IDLE && (await options.allowIdleWarming?.())) {
    if (writeCacheWarming(settingsPath, IDLE)) {
      enabledIdleWarming = true
      cacheWarmingBefore = warming ?? UNSET
    }
  }
  const summary = lines.length > 0 ? lines.join('; ') : Object.keys(entries).map((key) => key === DEFAULT_PLAN_KEY ? 'default' : key).join(', ')
  const next = changePlan(plan, entries, summary, now, cacheWarmingBefore)
  writeJsonAtomic(planPath(dir), next)
  return { plan: next, lines, enabledIdleWarming, idleWarmingOff: needsIdle && warming !== IDLE && !enabledIdleWarming }
}

/**
 * Turn cache control on or off. Off, the extension changes nothing and Pi
 * runs with its own settings; the plan's entries stay for when it is back
 * on, and undo steps back over the switch like any other change.
 */
export function setCacheControl(on: boolean, options: { dir?: string; now?: number } = {}): CachePlan {
  const dir = options.dir ?? analyticsDir()
  const plan = readPlan(planPath(dir))
  if (!plan.off === on) return plan
  const next = changePlan(plan, {}, on ? 'cache control on' : 'cache control off', options.now ?? Date.now(), undefined, on)
  writeJsonAtomic(planPath(dir), next)
  return next
}

/** Step the plan back one change, and Pi's `cacheWarming` with it when that change set it. */
export function undo(options: { dir?: string; settingsPath?: string; now?: number } = {}): { summary: string; restoredCacheWarming: string | null } | null {
  const dir = options.dir ?? analyticsDir()
  const result = undoPlan(readPlan(planPath(dir)), options.now)
  if (!result) return null
  writeJsonAtomic(planPath(dir), result.plan)
  const before = result.undone.cacheWarmingBefore
  if (before !== undefined) writeCacheWarming(options.settingsPath ?? piSettingsPath(), before)
  return { summary: result.undone.summary, restoredCacheWarming: before ?? null }
}

/** Back to the plan before every change on record, and Pi's `cacheWarming` before the first that set it. */
export function reset(options: { dir?: string; settingsPath?: string; now?: number } = {}): { restoredCacheWarming: string | null } {
  const dir = options.dir ?? analyticsDir()
  const result = resetPlan(readPlan(planPath(dir)), options.now)
  writeJsonAtomic(planPath(dir), result.plan)
  if (result.cacheWarmingBefore !== undefined) writeCacheWarming(options.settingsPath ?? piSettingsPath(), result.cacheWarmingBefore)
  return { restoredCacheWarming: result.cacheWarmingBefore ?? null }
}

/** The plan as lines for a terminal. */
export function describePlan(plan: CachePlan): string[] {
  const line = (key: string, entry: ModelCachePlan): string => {
    const pings = entry.idlePings ?? MAX_IDLE_WARMS
    const detail = entry.mode === 'keep-warm' ? ` (${pings} idle ${pings === 1 ? 'refresh' : 'refreshes'})` : entry.mode === 'auto' && entry.hourly ? ' (by hour)' : ''
    const saving = entry.source ? `, applied ${new Date(entry.appliedAt).toLocaleString()} for $${entry.source.weeklySaving.toFixed(2)} a week` : ''
    return `${key}: ${entry.mode}${detail}${saving}`
  }
  if (plan.off) return ['Cache control is off: Pi runs with its own settings. The plan below is kept for when it is back on.', ...describePlan({ ...plan, off: false })]
  const lines = Object.entries(plan.models).map(([model, entry]) => line(model, entry))
  if (plan.default) lines.push(line('every other model', plan.default))
  return lines
}
