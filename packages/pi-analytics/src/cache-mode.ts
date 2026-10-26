/**
 * Which cache mode a session's next request runs in, and the status the
 * extension reports for it. A session with no mode of its own, in a process
 * started without one, is left entirely to Pi.
 */
import {
  MAX_IDLE_WARMS,
  autoWarmLimit,
  type AutoWarmSchedule,
  type CacheMode,
  type CacheModeChoice,
} from '../../../resources/context-snapshot'

export type ModeSource = 'session' | 'start'

export interface EffectiveMode {
  mode: CacheMode
  source: ModeSource
  changedAt: number | null
}

/** The mode picked for the session, else the one the process was started in. Null leaves Pi alone. */
export function effectiveMode(input: { session: CacheModeChoice | null; start: CacheMode | null }): EffectiveMode | null {
  const { session, start } = input
  if (session) return { mode: session.mode, source: 'session', changedAt: session.changedAt }
  return start ? { mode: start, source: 'start', changedAt: null } : null
}

/**
 * Idle refreshes allowed for a break that starts at `at`: keep-warm's fixed
 * count, auto's count for the hour from the schedule file, or null in the
 * modes that never refresh idle.
 */
export function idleLimit(mode: EffectiveMode, schedule: AutoWarmSchedule | null, model: string | null, at: number): number | null {
  if (mode.mode === 'keep-warm') return MAX_IDLE_WARMS
  if (mode.mode !== 'auto') return null
  return autoWarmLimit(schedule, model, at)
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
