/**
 * What the Context panel shows, derived from a context snapshot: the prompt
 * cache countdown, what the next call costs warm or cold, and the billing
 * table for the last call and the current turn. Pure, so the renderer only
 * formats it.
 */
import type { CallCost, ContextSnapshot, ModelCall, TokenRates } from '../../resources/context-snapshot'

/** Pi stops idle warming this long after the last real request (hard-coded in its cache warmer). */
export const IDLE_WARMING_LIMIT_MS = 30 * 60_000
/** Pi's chance that you continue while idle, and the saving a refresh must clear, when it decides alone. */
const PI_IDLE_CONTINUATION = 0.15
const PI_MINIMUM_SAVING = 0.05

/** The countdown turns amber in its last minute. */
export const CACHE_EXPIRING_MS = 60_000
/** Context is highlighted from this share of the window, or this many tokens: every call resends it. */
export const CONTEXT_WARN_RATIO = 0.7
export const CONTEXT_WARN_TOKENS = 300_000

export type CacheStatus =
  /** No call yet, so nothing is cached. */
  | 'none'
  /** The model declares no lifetime for the active tier, so there is no countdown. */
  | 'unknown'
  | 'warm'
  | 'expiring'
  | 'cold'
  /** Prompt caches are per model: the next call starts cold after a switch. */
  | 'model-changed'

export interface CacheState {
  status: CacheStatus
  /** Lifetime of the active tier in seconds, when the model declares one. */
  lifetimeSeconds: number | null
  /** Last request or warming refresh, whichever is later. */
  refreshedAt: number | null
  expiresAt: number | null
  /** Milliseconds left, 0 once expired; null without a countdown. */
  remainingMs: number | null
}

export function lastCall(snapshot: ContextSnapshot): ModelCall | null {
  return snapshot.calls.at(-1) ?? null
}

export function cacheLifetimeSeconds(snapshot: ContextSnapshot): number | null {
  return snapshot.model?.promptCache?.[snapshot.cacheRetention] ?? null
}

export function cacheState(snapshot: ContextSnapshot, now: number): CacheState {
  const lifetimeSeconds = cacheLifetimeSeconds(snapshot)
  const refreshedAt = Math.max(snapshot.lastRequestAt ?? 0, snapshot.lastWarmAt ?? 0) || null
  const call = lastCall(snapshot)
  const base = { lifetimeSeconds, refreshedAt, expiresAt: null, remainingMs: null }
  if (!call || refreshedAt === null) return { ...base, status: 'none' }
  if (snapshot.model && call.model && (call.model !== snapshot.model.id || (call.provider && call.provider !== snapshot.model.provider))) {
    return { ...base, status: 'model-changed' }
  }
  if (lifetimeSeconds === null) return { ...base, status: 'unknown' }
  const expiresAt = refreshedAt + lifetimeSeconds * 1000
  const remainingMs = Math.max(0, expiresAt - now)
  const status: CacheStatus = remainingMs === 0 ? 'cold' : remainingMs <= CACHE_EXPIRING_MS ? 'expiring' : 'warm'
  return { status, lifetimeSeconds, refreshedAt, expiresAt, remainingMs }
}

/** Tokens the last call sent: new input plus what it read from and wrote to the cache. */
export function promptTokens(call: Pick<ModelCall, 'input' | 'cacheRead' | 'cacheWrite'>): number {
  return call.input + call.cacheRead + call.cacheWrite
}

/**
 * Tokens the next call resends: Pi's own figure (the one it compacts by),
 * else the last call's prompt plus its reply, which joins the context, else
 * the breakdown's estimate.
 */
export function contextTokens(snapshot: ContextSnapshot): number | null {
  if (snapshot.reportedTokens !== null) return snapshot.reportedTokens
  const call = lastCall(snapshot)
  if (call) return promptTokens(call) + call.output
  return snapshot.breakdown?.estimatedTokens ?? null
}

export function contextWindow(snapshot: ContextSnapshot): number | null {
  return snapshot.model?.contextWindow ?? null
}

export function contextIsHigh(tokens: number | null, window: number | null): boolean {
  if (tokens === null) return false
  return tokens >= CONTEXT_WARN_TOKENS || (window !== null && window > 0 && tokens / window >= CONTEXT_WARN_RATIO)
}

/** Share of the last call's prompt served from the cache, 0..1. */
export function cacheHitRate(call: ModelCall): number | null {
  const prompt = promptTokens(call)
  return prompt > 0 ? call.cacheRead / prompt : null
}

const TOKEN_KINDS = ['input', 'cacheRead', 'cacheWrite', 'output'] as const
export type TokenKind = (typeof TOKEN_KINDS)[number]

/**
 * Rates per million tokens. A rate the last calls were billed at wins over the
 * model list's price, since providers bill some tiers (a 1h cache write)
 * above the listed rate.
 */
export function effectiveRates(snapshot: ContextSnapshot): TokenRates | null {
  const listed = snapshot.model?.rates ?? null
  const billed: Partial<TokenRates> = {}
  for (const call of [...snapshot.calls].reverse()) {
    if (snapshot.model && call.model !== snapshot.model.id) continue
    for (const kind of TOKEN_KINDS) {
      if (billed[kind] === undefined && call[kind] > 0 && call.cost[kind] > 0) {
        billed[kind] = (call.cost[kind] / call[kind]) * 1_000_000
      }
    }
    if (TOKEN_KINDS.every((kind) => billed[kind] !== undefined)) break
  }
  if (!listed && Object.keys(billed).length === 0) return null
  return {
    input: billed.input ?? listed?.input ?? 0,
    output: billed.output ?? listed?.output ?? 0,
    cacheRead: billed.cacheRead ?? listed?.cacheRead ?? 0,
    cacheWrite: billed.cacheWrite ?? listed?.cacheWrite ?? 0,
  }
}

export interface NextCallEstimate {
  /** Cost of resending the context from a warm cache (cache-read rate). */
  warm: number | null
  /** Cost of rewriting the context into a cold cache (cache-write rate). */
  cold: number | null
}

/** New input and output are left out: they cost the same either way. */
export function nextCallEstimate(snapshot: ContextSnapshot): NextCallEstimate {
  const tokens = contextTokens(snapshot)
  const rates = effectiveRates(snapshot)
  if (tokens === null || !rates) return { warm: null, cold: null }
  return {
    warm: rates.cacheRead > 0 ? (tokens * rates.cacheRead) / 1_000_000 : null,
    cold: rates.cacheWrite > 0 ? (tokens * rates.cacheWrite) / 1_000_000 : null,
  }
}

/** Calls since the latest user prompt (the whole run it started, tool loops included). */
export function turnCalls(snapshot: ContextSnapshot): ModelCall[] {
  const start = snapshot.turnStartedAt
  if (start === null) return []
  return snapshot.calls.filter((call) => call.at >= start)
}

export interface BillingRow {
  kind: TokenKind
  /** Per million tokens. */
  rate: number | null
  lastTokens: number
  lastCost: number
  turnTokens: number
  turnCost: number
}

export interface BillingTable {
  rows: BillingRow[]
  lastTotal: number
  turnTotal: number
  turnCallCount: number
}

export function billingTable(snapshot: ContextSnapshot): BillingTable {
  const call = lastCall(snapshot)
  const turn = turnCalls(snapshot)
  const rates = effectiveRates(snapshot)
  const rows = TOKEN_KINDS.map((kind): BillingRow => ({
    kind,
    rate: rates ? rates[kind] : null,
    lastTokens: call ? call[kind] : 0,
    lastCost: call ? call.cost[kind] : 0,
    turnTokens: turn.reduce((sum, entry) => sum + entry[kind], 0),
    turnCost: turn.reduce((sum, entry) => sum + entry.cost[kind], 0),
  }))
  return {
    rows,
    lastTotal: call ? costTotal(call.cost) : 0,
    turnTotal: turn.reduce((sum, entry) => sum + costTotal(entry.cost), 0),
    turnCallCount: turn.length,
  }
}

/** A provider's total, or the sum of the parts when it reports none. */
function costTotal(cost: CallCost): number {
  return cost.total > 0 ? cost.total : cost.input + cost.output + cost.cacheRead + cost.cacheWrite
}

/** Pi refreshes at 90% of the lifetime, keeping at least ten seconds of margin. */
export function pingDelayMs(lifetimeSeconds: number): number | null {
  const ttl = lifetimeSeconds * 1000
  if (ttl <= 10_000) return null
  return Math.max(1, Math.floor(Math.min(ttl * 0.9, ttl - 10_000)))
}

export type PingMode =
  /** pi-analytics' setting for this model: up to `planned` pings after each message. */
  | 'planned'
  /** The 1-hour cache: no pings needed. */
  | 'long'
  /** No setting: Pi pings only when its own price rule says it pays. */
  | 'pi'
  /** Pi's `cacheWarming` is not "idle", so nothing pings once the agent stops. */
  | 'off'

export interface PingStatus {
  mode: PingMode
  /** Pings allowed after the latest message (`planned` mode only). */
  planned: number | null
  /** Pings sent since the latest message, and what they cost. */
  sent: number
  sentCost: number
  /** Every ping this session, and what they cost. */
  totalCount: number
  totalCost: number
  /** What one ping costs: the last one's bill, else the context at the cache-read rate. */
  price: number | null
  /** When the next ping goes out, or null when none will. */
  nextAt: number | null
  /** `/done` or `/away` stopped the pings until the next message. */
  stopped: boolean
}

/**
 * The idle pings of a session: how many its setting allows, how many went out
 * since the latest message, and when the next one fires. Null while there is
 * nothing to say: no call yet, or a subagent (Pi decides those).
 */
export function pingStatus(snapshot: ContextSnapshot, now: number): PingStatus | null {
  const cache = cacheState(snapshot, now)
  if (cache.status === 'none' || snapshot.parentSessionId) return null
  const since = snapshot.turnStartedAt ?? 0
  const recent = snapshot.pings?.recent ?? []
  const sentPings = recent.filter(([at]) => at >= since)
  const sent = sentPings.length
  const sentCost = sentPings.reduce((sum, [, cost]) => sum + cost, 0)
  const plan = snapshot.pingPlan ?? null
  // Pi's default, "streaming", stops warming when the agent stops.
  const mode: PingMode = snapshot.cacheWarming !== 'idle'
    ? 'off'
    : plan === null ? 'pi' : plan.setting === 'long' ? 'long' : 'planned'
  const planned = mode === 'planned' && typeof plan?.setting === 'number' ? plan.setting : null
  const estimate = nextCallEstimate(snapshot)
  const lastPing = recent.at(-1)?.[1]
  const price = lastPing ?? estimate.warm
  const stopped = plan?.stopped ?? false
  const status: PingStatus = {
    mode,
    planned,
    sent,
    sentCost,
    totalCount: snapshot.pings?.count ?? 0,
    totalCost: snapshot.pings?.cost ?? 0,
    price,
    nextAt: null,
    stopped,
  }
  const live = cache.status === 'warm' || cache.status === 'expiring'
  if (!live || snapshot.agentRunning || stopped || cache.refreshedAt === null || cache.lifetimeSeconds === null) return status
  if (mode === 'off' || mode === 'long' || (planned !== null && sent >= planned)) return status
  if (mode === 'pi') {
    // Pi's own rule: the chance you continue times what a miss costs, less the ping, must clear five cents.
    if (estimate.warm === null || estimate.cold === null) return status
    if (PI_IDLE_CONTINUATION * Math.max(0, estimate.cold - estimate.warm) - estimate.warm < PI_MINIMUM_SAVING) return status
  }
  const delay = pingDelayMs(cache.lifetimeSeconds)
  if (delay === null) return status
  const nextAt = cache.refreshedAt + delay
  if (snapshot.lastRequestAt !== null && nextAt > snapshot.lastRequestAt + IDLE_WARMING_LIMIT_MS) return status
  return { ...status, nextAt }
}
