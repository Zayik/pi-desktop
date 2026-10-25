/**
 * The cache plan: the prompt-cache setting each model runs with, written by
 * `pi-analytics apply` (or Pi Desktop's Apply button) and read by the
 * extension before every request. A model the plan does not name, in a
 * session with no mode of its own, is left entirely to Pi.
 *
 * Every change keeps the plan it replaced, and Pi's `cacheWarming` setting
 * when the change turned on idle warming, so `undo` steps back one change
 * and `reset` goes back to before the first.
 */
import {
  MAX_AUTO_WARMS,
  MAX_IDLE_WARMS,
  autoWarmLimit,
  isCacheMode,
  type AutoWarmSchedule,
  type CacheMode,
  type CacheModeChoice,
} from '../../../resources/context-snapshot'

export const CACHE_PLAN_VERSION = 1
/** Changes kept for undo. */
export const MAX_PLAN_HISTORY = 20
const HOURS_PER_DAY = 24

export interface ModelCachePlan {
  mode: CacheMode
  /** keep-warm: refreshes after the agent stops; `MAX_IDLE_WARMS` when left out. */
  idlePings?: number
  /** auto: refreshes per local hour of the day the break starts in. */
  hourly?: number[]
  /** What the report said when this was applied. */
  source?: { weeklySaving: number; days: number }
  appliedAt: number
}

export interface PlanSnapshot {
  /** For models with no entry of their own. */
  default: ModelCachePlan | null
  /** By `provider/model`. */
  models: Record<string, ModelCachePlan>
}

export interface PlanChange {
  at: number
  /** What it did, for `pi-analytics plan` and the undo message. */
  summary: string
  /** The plan before the change. */
  before: PlanSnapshot
  /** Pi's `cacheWarming` before the change, when the change set it ("unset" when it had none). */
  cacheWarmingBefore?: string
}

export interface CachePlan extends PlanSnapshot {
  version: typeof CACHE_PLAN_VERSION
  updatedAt: number
  history: PlanChange[]
}

export function emptyPlan(now = Date.now()): CachePlan {
  return { version: CACHE_PLAN_VERSION, updatedAt: now, default: null, models: {}, history: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_AUTO_WARMS
}

export function isModelCachePlan(value: unknown): value is ModelCachePlan {
  if (!isRecord(value) || !isCacheMode(value.mode) || typeof value.appliedAt !== 'number') return false
  if (value.idlePings !== undefined && !isCount(value.idlePings)) return false
  if (value.hourly !== undefined && !(Array.isArray(value.hourly) && value.hourly.length === HOURS_PER_DAY && value.hourly.every(isCount))) return false
  return true
}

function isSnapshot(value: unknown): value is PlanSnapshot {
  return isRecord(value) &&
    (value.default === null || isModelCachePlan(value.default)) &&
    isRecord(value.models) && Object.values(value.models).every(isModelCachePlan)
}

export function isCachePlan(value: unknown): value is CachePlan {
  if (!isSnapshot(value)) return false
  const plan = value as Partial<CachePlan>
  return plan.version === CACHE_PLAN_VERSION && typeof plan.updatedAt === 'number' &&
    Array.isArray(plan.history) && plan.history.every((change) => isRecord(change) && isSnapshot(change.before))
}

function snapshotOf(plan: PlanSnapshot): PlanSnapshot {
  return JSON.parse(JSON.stringify({ default: plan.default, models: plan.models })) as PlanSnapshot
}

/**
 * Set some models' entries (null removes one; the key `*` is the default),
 * remembering the plan before. Returns the new plan; the caller writes it.
 */
export function changePlan(
  plan: CachePlan,
  entries: Record<string, ModelCachePlan | null>,
  summary: string,
  now = Date.now(),
  cacheWarmingBefore?: string,
): CachePlan {
  const next: CachePlan = { ...plan, models: { ...plan.models }, updatedAt: now }
  for (const [model, entry] of Object.entries(entries)) {
    if (model === DEFAULT_PLAN_KEY) next.default = entry
    else if (entry) next.models[model] = entry
    else delete next.models[model]
  }
  const change: PlanChange = { at: now, summary, before: snapshotOf(plan) }
  if (cacheWarmingBefore !== undefined) change.cacheWarmingBefore = cacheWarmingBefore
  next.history = [...plan.history, change].slice(-MAX_PLAN_HISTORY)
  return next
}

/** The key that names the plan's default entry. */
export const DEFAULT_PLAN_KEY = '*'

/** Step back one change. Null when there is nothing to undo. */
export function undoPlan(plan: CachePlan, now = Date.now()): { plan: CachePlan; undone: PlanChange } | null {
  const undone = plan.history.at(-1)
  if (!undone) return null
  return { plan: { ...plan, ...snapshotOf(undone.before), updatedAt: now, history: plan.history.slice(0, -1) }, undone }
}

/**
 * Back to before the first change still on record. Returns the change whose
 * `cacheWarmingBefore` is the oldest, to restore Pi's setting with.
 */
export function resetPlan(plan: CachePlan, now = Date.now()): { plan: CachePlan; cacheWarmingBefore?: string } {
  const first = plan.history[0]
  const cacheWarmingBefore = plan.history.find((change) => change.cacheWarmingBefore !== undefined)?.cacheWarmingBefore
  const base = first ? snapshotOf(first.before) : { default: null, models: {} }
  return { plan: { ...emptyPlan(now), ...base, updatedAt: now }, cacheWarmingBefore }
}

/** True when an entry can send refreshes after the agent stops, which needs Pi's `cacheWarming: "idle"`. */
export function needsIdleWarming(entry: ModelCachePlan | null): boolean {
  if (!entry) return false
  if (entry.mode === 'keep-warm') return (entry.idlePings ?? MAX_IDLE_WARMS) > 0
  if (entry.mode === 'auto') return entry.hourly ? entry.hourly.some((pings) => pings > 0) : true
  return false
}

export type ModeSource = 'session' | 'plan-model' | 'plan-default' | 'start'

export interface EffectiveMode {
  mode: CacheMode
  source: ModeSource
  /** The plan entry behind it, when it came from the plan. */
  entry: ModelCachePlan | null
  changedAt: number | null
}

/**
 * The mode a session's next request runs in: the one picked for the session,
 * then the plan's entry for the model, then the plan's default, then the mode
 * the process was started in. Null leaves Pi alone.
 */
export function effectiveMode(input: {
  session: CacheModeChoice | null
  plan: CachePlan
  model: string | null
  start: CacheMode | null
}): EffectiveMode | null {
  const { session, plan, model, start } = input
  const entry = (model ? plan.models[model] : undefined) ?? null
  if (session) return { mode: session.mode, source: 'session', entry: entry ?? plan.default, changedAt: session.changedAt }
  if (entry) return { mode: entry.mode, source: 'plan-model', entry, changedAt: entry.appliedAt }
  if (plan.default) return { mode: plan.default.mode, source: 'plan-default', entry: plan.default, changedAt: plan.default.appliedAt }
  return start ? { mode: start, source: 'start', entry: null, changedAt: null } : null
}

/**
 * Idle refreshes allowed for a break that starts at `at`: keep-warm's count
 * from the plan, auto's count for the hour (from the plan, else the schedule
 * file), or null in the modes that never refresh idle.
 */
export function idleLimit(mode: EffectiveMode, schedule: AutoWarmSchedule | null, model: string | null, at: number): number | null {
  if (mode.mode === 'keep-warm') return mode.entry?.mode === 'keep-warm' ? mode.entry.idlePings ?? MAX_IDLE_WARMS : MAX_IDLE_WARMS
  if (mode.mode !== 'auto') return null
  const hourly = mode.entry?.mode === 'auto' ? mode.entry.hourly : undefined
  return hourly ? hourly[new Date(at).getHours()] : autoWarmLimit(schedule, model, at)
}

export const SESSION_STATUS_VERSION = 1

/** Written to `sessions/<id>.status.json` and sent as `pi-analytics:status` on `pi.events`. */
export interface SessionCacheStatus {
  version: typeof SESSION_STATUS_VERSION
  sessionId: string
  updatedAt: number
  /** `provider/model` of the session's model. */
  model: string | null
  /** Null while the extension leaves Pi alone. */
  cacheMode: CacheMode | null
  cacheModeSource: ModeSource | null
  cacheModeChangedAt: number | null
  /** The tier the last request asked for. */
  cacheRetention: 'short' | 'long' | null
  /** Idle refreshes allowed for the current break, or null when idle refreshes are off. */
  idleLimit: number | null
  /** Idle refreshes sent since the last real request. */
  idleWarms: number
  lastRequestAt: number | null
  lastWarmAt: number | null
}
