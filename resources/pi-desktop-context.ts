import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  CACHE_MODE_ENV,
  CONTEXT_DIR_ENV,
  CONTEXT_SNAPSHOT_VERSION,
  MAX_CATALOG_MODELS,
  PARENT_SESSION_ENV,
  DEFAULT_CACHE_MODE,
  buildBreakdown,
  cacheModeFileName,
  cacheRetentionFor,
  cacheWarmingOverride,
  callFromMessage,
  isCacheMode,
  isCacheModeChoice,
  emptyTotals,
  recordCall,
  snapshotFileName,
  snapshotModel,
  type CacheMode,
  type CacheModeChoice,
  type ContextSnapshot,
  type SnapshotModel,
  type ToolDefinitionInput,
} from './context-snapshot'

// Writes are coalesced: a turn fires several events within a few milliseconds.
const WRITE_DELAY_MS = 200

/**
 * Records what fills the model context on each request and what each model
 * call cost, for Pi Desktop's Context panel, and applies the session's cache
 * mode. Adds nothing to the context. The snapshot is written to
 * `<PI_DESKTOP_CONTEXT_DIR>/<session id>.json`; without that folder the
 * extension does nothing.
 *
 * The mode the app picked for the session is read from `<session id>.mode`
 * beside it before each request, so a switch applies to the next request.
 * It sets `PI_CACHE_RETENTION`, which Pi reads per request, and answers Pi's
 * idle cache-warming decisions.
 */
export default function piDesktopContext(pi: ExtensionAPI): void {
  const dir = process.env[CONTEXT_DIR_ENV]
  if (!dir) return
  // Read once at load: start() then overwrites it for the processes this one spawns.
  const parentSessionId = process.env[PARENT_SESSION_ENV] || null
  // A chat started outside the app keeps an explicit PI_CACHE_RETENTION=long.
  const startEnv = process.env[CACHE_MODE_ENV]
  const startMode: CacheMode = isCacheMode(startEnv) ? startEnv : process.env.PI_CACHE_RETENTION === 'long' ? 'long' : DEFAULT_CACHE_MODE

  let snapshot: ContextSnapshot | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let modeFile: { path: string; mtimeMs: number; choice: CacheModeChoice | null } | null = null

  /** The mode picked in the app for this session, re-read only when its file changes. */
  const pickedMode = (sessionId: string): CacheModeChoice | null => {
    const path = join(dir, cacheModeFileName(sessionId))
    let mtimeMs: number
    try {
      mtimeMs = statSync(path).mtimeMs
    } catch {
      return null
    }
    if (modeFile?.path === path && modeFile.mtimeMs === mtimeMs) return modeFile.choice
    let choice: CacheModeChoice | null = null
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      choice = isCacheModeChoice(parsed) ? parsed : null
    } catch {
      // Half written or removed: keep the current mode.
    }
    modeFile = { path, mtimeMs, choice }
    return choice
  }

  /** Bring the session's mode into effect for the next request. */
  const applyMode = (): CacheMode => {
    if (!snapshot) return startMode
    const choice = pickedMode(snapshot.sessionId)
    const mode = choice?.mode ?? snapshot.cacheMode ?? startMode
    // Pi reads it on every request; a subagent process spawned from here inherits it.
    process.env.PI_CACHE_RETENTION = cacheRetentionFor(mode)
    if (mode !== snapshot.cacheMode) {
      if (snapshot.cacheMode) snapshot.cacheModeChangedAt = choice?.changedAt ?? Date.now()
      snapshot.cacheMode = mode
      // The cache tier changes with the next request; until then the last one's entry is what lives.
      if (snapshot.lastRequestAt === null) snapshot.cacheRetention = cacheRetentionFor(mode)
      scheduleWrite()
    }
    return mode
  }

  const activeTools = (): ToolDefinitionInput[] => {
    const active = new Set(pi.getActiveTools())
    return pi.getAllTools().filter((tool) => active.has(tool.name))
  }

  const write = (): void => {
    timer = null
    if (!snapshot) return
    snapshot.updatedAt = Date.now()
    const target = join(dir, snapshotFileName(snapshot.sessionId))
    const temp = `${target}.${process.pid}.tmp`
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(temp, JSON.stringify(snapshot))
      renameSync(temp, target)
    } catch {
      // A snapshot is a view aid: a failed write must never disturb the session.
    }
  }

  const scheduleWrite = (): void => {
    if (!timer) timer = setTimeout(write, WRITE_DELAY_MS)
  }

  const modelCatalog = (ctx: ExtensionContext): SnapshotModel[] => {
    try {
      return ctx.modelRegistry.getAvailable()
        .map(snapshotModel)
        .filter((model): model is SnapshotModel => model !== null)
        .slice(0, MAX_CATALOG_MODELS)
    } catch {
      return []
    }
  }

  const refreshModel = (ctx: ExtensionContext): void => {
    if (!snapshot) return
    snapshot.model = snapshotModel(ctx.model)
    snapshot.reportedTokens = ctx.getContextUsage()?.tokens ?? null
  }

  /** Rebuild calls and the turn start from the saved session, so a resumed session shows its history. */
  const start = (ctx: ExtensionContext): void => {
    const settings = pi.getSettings() as { cacheWarming?: unknown }
    const sessionId = ctx.sessionManager.getSessionId()
    // A subagent Pi process started from here inherits the environment.
    process.env[PARENT_SESSION_ENV] = sessionId
    snapshot = {
      version: CONTEXT_SNAPSHOT_VERSION,
      sessionId,
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      parentSessionId: parentSessionId !== sessionId ? parentSessionId : null,
      updatedAt: Date.now(),
      model: null,
      cacheRetention: cacheRetentionFor(startMode),
      cacheWarming: typeof settings.cacheWarming === 'string' ? settings.cacheWarming : null,
      cacheMode: undefined,
      cacheModeChangedAt: null,
      breakdown: null,
      reportedTokens: null,
      calls: [],
      totals: emptyTotals(),
      turnStartedAt: null,
      lastRequestAt: null,
      lastWarmAt: null,
    }
    const messages: unknown[] = []
    let compacted = false
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'compaction') compacted = true
      if (entry.type !== 'message') continue
      const message = entry.message as { role?: unknown; timestamp?: unknown }
      messages.push(message)
      const at = typeof message.timestamp === 'number' ? message.timestamp : Date.parse(entry.timestamp)
      if (message.role === 'user') snapshot.turnStartedAt = at
      const call = callFromMessage(message, at)
      if (call) {
        recordCall(snapshot, call)
        snapshot.lastRequestAt = call.at
      }
    }
    // After a compaction the branch still holds the messages it replaced; only
    // the next request shows what the model really gets.
    snapshot.breakdown = buildBreakdown({
      systemPrompt: ctx.getSystemPrompt(),
      tools: activeTools(),
      messages: compacted ? [] : messages,
      capturedAt: Date.now(),
      fromSession: true,
    })
    refreshModel(ctx)
    snapshot.catalog = modelCatalog(ctx)
    // A resumed session keeps the mode it was switched to.
    const resumed = pickedMode(sessionId)
    snapshot.cacheMode = resumed?.mode ?? startMode
    snapshot.cacheModeChangedAt = resumed ? resumed.changedAt : null
    applyMode()
    scheduleWrite()
  }

  pi.on('session_start', (_event, ctx) => start(ctx))

  pi.on('model_select', (_event, ctx) => {
    refreshModel(ctx)
    scheduleWrite()
  })

  pi.on('before_agent_start', (event) => {
    if (!snapshot) return
    applyMode()
    if (event.messageType !== 'user') return
    snapshot.turnStartedAt = Date.now()
    scheduleWrite()
  })

  pi.on('context_with_system', (event, ctx) => {
    if (!snapshot) return
    applyMode()
    snapshot.breakdown = buildBreakdown({
      systemPrompt: ctx.getSystemPrompt(),
      tools: activeTools(),
      messages: event.messages,
      capturedAt: Date.now(),
    })
    scheduleWrite()
  })

  pi.on('before_provider_request', () => {
    if (!snapshot) return
    snapshot.lastRequestAt = Date.now()
    snapshot.cacheRetention = process.env.PI_CACHE_RETENTION === 'long' ? 'long' : 'short'
    scheduleWrite()
  })

  pi.on('cache_warming_decision', (event) => {
    if (!snapshot) return
    const action = cacheWarmingOverride(applyMode(), event.continuationProbability)
    if ((action ?? event.action) === 'warm') {
      snapshot.lastWarmAt = Date.now()
      scheduleWrite()
    }
    return action ? { action } : undefined
  })

  pi.on('message_end', (event, ctx) => {
    if (!snapshot) return
    const call = callFromMessage(event.message, Date.now())
    if (!call) return
    recordCall(snapshot, call)
    refreshModel(ctx)
    scheduleWrite()
  })

  pi.on('session_compact', (_event, ctx) => {
    refreshModel(ctx)
    scheduleWrite()
  })

  pi.on('session_shutdown', () => {
    if (timer) clearTimeout(timer)
    write()
    snapshot = null
  })
}
