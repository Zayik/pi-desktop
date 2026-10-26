/**
 * The answer to Pi's idle cache-warming decisions, for one Pi process, from
 * the per-model settings in `cache-settings.json`. It only changes what
 * happens after the agent stops: while it works (continuation probability 1)
 * Pi decides by price, and subagents, models with no setting and decisions it
 * cannot read are left to Pi as well.
 */
import { readFileSync, statSync } from 'fs'
import { analyticsDir } from './paths'
import { awayPath, cacheSettingsPath, parseAway, parseCacheSettings, type CacheSettings, type ModelCacheSetting } from './cache-settings'

/** A JSON file re-read only when its mtime changes. */
class WatchedFile<T> {
  private seen: { mtimeMs: number; value: T } | null = null
  constructor(private readonly path: string, private readonly parse: (text: string) => T, private readonly missing: T) {}

  read(): T {
    let mtimeMs: number
    try {
      mtimeMs = statSync(this.path).mtimeMs
    } catch {
      this.seen = null
      return this.missing
    }
    if (this.seen?.mtimeMs === mtimeMs) return this.seen.value
    let value = this.missing
    try {
      value = this.parse(readFileSync(this.path, 'utf8'))
    } catch {
      // Half written: the next change is read again.
    }
    this.seen = { mtimeMs, value }
    return value
  }
}

/**
 * Prompt cache lifetimes (seconds) the vendors advertise, per retention tier
 * as Pi asks for it, or null for models we know nothing about. GitHub
 * Copilot runs the vendor's models, so its models get the vendor's numbers.
 * - Anthropic: 5 minutes, or 1 hour on the long tier.
 * - OpenAI GPT-5.6 and later: 30 minutes; Pi's long tier also asks for 30.
 * - Older OpenAI: in-memory caching lasts 5 to 10 minutes (the low end is
 *   taken); the 24-hour retention Pi's long tier asks for typically holds
 *   about 30 minutes.
 */
export function advertisedCacheLifetime(provider: string, modelId: string): { short: number; long: number } | null {
  const id = modelId.toLowerCase()
  const name = provider.toLowerCase()
  if (name.includes('anthropic') || id.includes('claude')) return { short: 5 * 60, long: 60 * 60 }
  if (name.includes('openai') || /(^|[./])(gpt|o\d|chatgpt|codex)/.test(id)) {
    return /gpt-(5\.([6-9]|\d{2,})|[6-9]|\d{2,})/.test(id) ? { short: 30 * 60, long: 30 * 60 } : { short: 5 * 60, long: 30 * 60 }
  }
  return null
}

/**
 * Give a model the advertised lifetimes for the tiers its definition leaves
 * out, so Pi's cache warmer (which warms only models with a lifetime) keeps
 * it warm. A lifetime the catalog or the user's models.json sets is kept.
 * Returns true when it filled one in.
 */
export function fillCacheLifetime(model: unknown): boolean {
  if (!isRecord(model) || typeof model.provider !== 'string' || typeof model.id !== 'string') return false
  const advertised = advertisedCacheLifetime(model.provider, model.id)
  if (!advertised) return false
  const current = isRecord(model.promptCache) ? model.promptCache : {}
  const short = typeof current.short === 'number' && current.short > 0 ? current.short : advertised.short
  const long = typeof current.long === 'number' && current.long > 0 ? current.long : advertised.long
  if (short === current.short && long === current.long) return false
  model.promptCache = { ...current, short, long }
  return true
}

export interface WarmingOptions {
  dir?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** A subagent's process (started by another session): Pi's own warming is kept. */
  subagent?: boolean
}

export class IdleWarming {
  private readonly env: NodeJS.ProcessEnv
  private readonly now: () => number
  private readonly subagent: boolean
  /** The retention the process started with, put back for models without "long". */
  private readonly startRetention: string | undefined
  private readonly settings: WatchedFile<CacheSettings>
  private readonly away: WatchedFile<number | null>
  private model: string | null = null
  private idleWarms = 0
  /** Your last message in this chat (not the agent's own calls after it). */
  private lastMessageAt = 0
  /** `/done`: no idle pings until the next message in this chat. */
  private done = false

  constructor(options: WarmingOptions = {}) {
    this.env = options.env ?? process.env
    const dir = options.dir ?? analyticsDir(this.env)
    this.now = options.now ?? Date.now
    this.subagent = options.subagent ?? false
    this.startRetention = this.env.PI_CACHE_RETENTION
    this.settings = new WatchedFile(cacheSettingsPath(dir), parseCacheSettings, { version: 1, models: {} })
    this.away = new WatchedFile(awayPath(dir), parseAway, null)
  }

  /** The setting for the session's model, or null to leave it to Pi. */
  setting(): ModelCacheSetting | null {
    if (this.subagent || !this.model) return null
    return this.settings.read().models[this.model] ?? null
  }

  /**
   * The session's model changed (or may have). A model with a setting gets
   * the vendor's cache lifetime filled in, on the object Pi's warmer reads,
   * and the retention its setting asks for.
   */
  setModel(model: unknown): void {
    this.model = isRecord(model) && typeof model.provider === 'string' && typeof model.id === 'string' ? `${model.provider}/${model.id}` : null
    const setting = this.setting()
    if (setting !== null) {
      try {
        fillCacheLifetime(model)
      } catch {
        // A frozen model object: Pi keeps its catalog's lifetimes.
      }
    }
    if (this.subagent) return
    if (setting === 'long') this.env.PI_CACHE_RETENTION = 'long'
    else if (this.startRetention === undefined) delete this.env.PI_CACHE_RETENTION
    else this.env.PI_CACHE_RETENTION = this.startRetention
  }

  /** You sent a message: `/done` and `/away` no longer hold for this chat. */
  userMessage(): void {
    this.done = false
    this.lastMessageAt = this.now()
  }

  /** A real request (Pi's refreshes resend the stored one without it): the pings start again. */
  realRequest(): void {
    this.idleWarms = 0
  }

  /** Stop idle pings for this chat until its next message. */
  markDone(): void {
    this.done = true
  }

  /** Answer one of Pi's warming decisions, or null to leave Pi's own. */
  decide(continuationProbability: number): 'warm' | 'stop' | null {
    if (continuationProbability >= 1) return null
    const setting = this.setting()
    if (setting === null) return null
    const away = this.away.read()
    if (this.done || (away !== null && away >= this.lastMessageAt)) return 'stop'
    if (setting === 'long' || this.idleWarms >= setting) return 'stop'
    this.idleWarms++
    return 'warm'
  }

  /** What `/done` and `/away` report. */
  describe(): string {
    const setting = this.setting()
    if (setting === null) return this.subagent ? 'subagent: Pi decides' : 'no setting: Pi decides'
    return setting === 'long' ? 'long cache, no idle pings' : `${this.idleWarms}/${setting} idle pings sent`
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
