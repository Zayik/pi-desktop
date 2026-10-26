/**
 * The package's side of Pi's prompt cache, for one Pi process: which mode
 * each request runs in (the session's pick, else the mode the process started
 * in), the cache tier it asks for, and the answer to Pi's idle cache-warming
 * decisions. With neither it changes nothing, so installing the package for
 * its reports leaves Pi's own warming as it was.
 */
import { readFileSync, statSync } from 'fs'
import {
  cacheRetentionFor,
  cacheWarmingOverride,
  fillCacheLifetime,
  isCacheMode,
  isCacheModeChoice,
  type CacheMode,
  type CacheModeChoice,
} from '../../../resources/context-snapshot'
import { SESSION_STATUS_VERSION, effectiveMode, idleLimit, type EffectiveMode, type SessionCacheStatus } from './cache-mode'
import { analyticsDir, sessionModePath } from './paths'

/** Starts a process in a mode before any pick; Pi Desktop's `PI_DESKTOP_CACHE_MODE` is read too. */
export const START_MODE_ENV = 'PI_ANALYTICS_CACHE_MODE'
const DESKTOP_START_MODE_ENV = 'PI_DESKTOP_CACHE_MODE'

/** A JSON file re-read only when its mtime changes. */
class WatchedFile<T> {
  private seen: { path: string; mtimeMs: number; value: T } | null = null
  constructor(private readonly parse: (text: string) => T, private readonly missing: T) {}

  read(path: string): T {
    let mtimeMs: number
    try {
      mtimeMs = statSync(path).mtimeMs
    } catch {
      this.seen = null
      return this.missing
    }
    if (this.seen?.path === path && this.seen.mtimeMs === mtimeMs) return this.seen.value
    let value = this.missing
    try {
      value = this.parse(readFileSync(path, 'utf8'))
    } catch {
      // Half written: the next change is read again.
    }
    this.seen = { path, mtimeMs, value }
    return value
  }
}

export interface WarmingModel {
  provider: string
  id: string
}

export interface WarmingOptions {
  dir?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** Called whenever the status changes. */
  onStatus?: (status: SessionCacheStatus) => void
}

export class CacheWarming {
  private readonly dir: string
  private readonly env: NodeJS.ProcessEnv
  private readonly now: () => number
  private readonly onStatus?: (status: SessionCacheStatus) => void
  /** The retention the process started with, put back when the extension lets go of a request. */
  private readonly startRetention: string | undefined
  private readonly startMode: CacheMode | null
  private readonly modeFile = new WatchedFile<CacheModeChoice | null>((text) => {
    const parsed: unknown = JSON.parse(text)
    return isCacheModeChoice(parsed) ? parsed : null
  }, null)
  private sessionId: string | null = null
  private model: string | null = null
  private idleWarms = 0
  private status: SessionCacheStatus | null = null

  constructor(options: WarmingOptions = {}) {
    this.env = options.env ?? process.env
    this.dir = options.dir ?? analyticsDir(this.env)
    this.now = options.now ?? Date.now
    this.onStatus = options.onStatus
    this.startRetention = this.env.PI_CACHE_RETENTION
    const start = this.env[START_MODE_ENV] ?? this.env[DESKTOP_START_MODE_ENV]
    this.startMode = isCacheMode(start) ? start : null
  }

  /** A session started or resumed; `lastRequestAt` is its last saved model call. */
  startSession(sessionId: string, model: WarmingModel | null, lastRequestAt: number | null): void {
    this.sessionId = sessionId
    this.idleWarms = 0
    this.status = {
      version: SESSION_STATUS_VERSION,
      sessionId,
      updatedAt: this.now(),
      model: null,
      cacheMode: null,
      cacheModeSource: null,
      cacheModeChangedAt: null,
      cacheRetention: null,
      idleLimit: null,
      idleWarms: 0,
      lastRequestAt,
      lastWarmAt: null,
    }
    this.setModel(model)
  }

  /**
   * The session's model changed (or may have). When a mode applies to it,
   * the vendor's cache lifetime is filled into the model object, which is
   * the one Pi's warmer reads: Pi warms only models with a lifetime.
   */
  setModel(model: WarmingModel | null): void {
    this.model = model ? `${model.provider}/${model.id}` : null
    const mode = this.apply()
    if (mode && model) {
      try {
        fillCacheLifetime(model)
      } catch {
        // A frozen model object: Pi keeps its catalog's lifetimes.
      }
    }
  }

  /** The mode for the next request, with `PI_CACHE_RETENTION` set to its tier (or put back when there is none). */
  apply(): EffectiveMode | null {
    const session = this.sessionId ? this.modeFile.read(sessionModePath(this.sessionId, this.dir)) : null
    const mode = effectiveMode({ session, start: this.startMode })
    if (mode) this.env.PI_CACHE_RETENTION = cacheRetentionFor(mode.mode)
    else if (this.startRetention === undefined) delete this.env.PI_CACHE_RETENTION
    else this.env.PI_CACHE_RETENTION = this.startRetention
    this.update({
      model: this.model,
      cacheMode: mode?.mode ?? null,
      cacheModeSource: mode?.source ?? null,
      cacheModeChangedAt: mode?.changedAt ?? null,
      idleLimit: mode ? this.limitFor(mode) : null,
    })
    return mode
  }

  private limitFor(mode: EffectiveMode): number | null {
    return idleLimit(mode)
  }

  /** A real request (Pi's refreshes resend the stored one without it): the idle budget starts again. */
  realRequest(): void {
    this.idleWarms = 0
    this.apply()
  }

  /** A request went out, real or refresh. */
  requestSent(): void {
    this.update({
      lastRequestAt: this.now(),
      cacheRetention: this.env.PI_CACHE_RETENTION === 'long' ? 'long' : 'short',
    })
  }

  /**
   * Answer one of Pi's warming decisions, or null to leave Pi's own. While
   * the agent works (continuation probability 1) Pi decides by price; once
   * it stops, keep-warm refreshes up to its limit and the other
   * modes stop.
   */
  decide(continuationProbability: number, piAction: 'warm' | 'stop'): 'warm' | 'stop' | null {
    const mode = this.apply()
    if (!mode) return null
    const limit = this.limitFor(mode)
    const action = cacheWarmingOverride(mode.mode, continuationProbability, this.idleWarms, limit ?? 0)
    if ((action ?? piAction) === 'warm') {
      if (continuationProbability < 1) this.idleWarms++
      this.update({ idleWarms: this.idleWarms, lastWarmAt: this.now() })
    }
    return action
  }

  current(): SessionCacheStatus | null {
    return this.status
  }

  private update(change: Partial<SessionCacheStatus>): void {
    if (!this.status) return
    const next = { ...this.status, ...change }
    const changed = (Object.keys(change) as (keyof SessionCacheStatus)[]).some((key) => next[key] !== this.status?.[key])
    if (!changed) return
    this.status = { ...next, updatedAt: this.now() }
    this.onStatus?.(this.status)
  }
}
