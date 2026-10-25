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
import { describeRecommendation, type CacheRecommendation } from './recommendations'

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
    const detail = entry.mode === 'keep-warm' ? ` (${entry.idlePings ?? MAX_IDLE_WARMS} idle refreshes)` : entry.mode === 'auto' && entry.hourly ? ' (by hour)' : ''
    const saving = entry.source ? `, applied ${new Date(entry.appliedAt).toLocaleString()} for $${entry.source.weeklySaving.toFixed(2)} a week` : ''
    return `${key}: ${entry.mode}${detail}${saving}`
  }
  const lines = Object.entries(plan.models).map(([model, entry]) => line(model, entry))
  if (plan.default) lines.push(line('every other model', plan.default))
  return lines
}
