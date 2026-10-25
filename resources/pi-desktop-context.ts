import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  CACHE_MODE_ENV,
  CACHE_STATUS_EVENT,
  CONTEXT_DIR_ENV,
  CONTEXT_SNAPSHOT_VERSION,
  MAX_CATALOG_MODELS,
  PARENT_SESSION_ENV,
  buildBreakdown,
  callFromMessage,
  cacheStatusFromEvent,
  emptyTotals,
  recordCall,
  snapshotFileName,
  snapshotModel,
  type CacheStatusEvent,
  type ContextSnapshot,
  type SnapshotModel,
  type ToolDefinitionInput,
} from './context-snapshot'

// Writes are coalesced: a turn fires several events within a few milliseconds.
const WRITE_DELAY_MS = 200

/**
 * Records what fills the model context on each request and what each model
 * call cost, for Pi Desktop's Context panel. Adds nothing to the context and
 * changes nothing about the requests. The snapshot is written to
 * `<PI_DESKTOP_CONTEXT_DIR>/<session id>.json`; without that folder the
 * extension does nothing.
 *
 * The cache mode is applied by the pi-analytics package's extension, which
 * owns Pi's cache-warming decisions; this one only copies the status it
 * sends on `pi.events` into the snapshot.
 */
export default function piDesktopContext(pi: ExtensionAPI): void {
  const dir = process.env[CONTEXT_DIR_ENV]
  if (!dir) return
  // Read once at load: start() then overwrites it for the processes this one spawns.
  const parentSessionId = process.env[PARENT_SESSION_ENV] || null
  const startMode = process.env[CACHE_MODE_ENV] ?? null

  let snapshot: ContextSnapshot | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  // The package may report before this session's snapshot exists.
  let cacheStatus: CacheStatusEvent | null = null

  /** Copy the package's cache status into the snapshot. */
  const applyStatus = (): void => {
    if (!snapshot || !cacheStatus || cacheStatus.sessionId !== snapshot.sessionId) return
    const status = cacheStatus
    const mode = status.cacheMode ?? undefined
    if (mode !== snapshot.cacheMode) {
      // A switch from the mode the session started in; the first mode is not a switch.
      if (snapshot.cacheMode) snapshot.cacheModeChangedAt = status.cacheModeChangedAt ?? Date.now()
      snapshot.cacheMode = mode
    }
    snapshot.autoWarmLimit = mode === 'auto' ? status.idleLimit : null
    if (status.lastWarmAt !== null && status.lastWarmAt !== snapshot.lastWarmAt) snapshot.lastWarmAt = status.lastWarmAt
    // Until a request goes out, the tier the mode asks for is the one shown.
    if (snapshot.lastRequestAt === null && status.cacheRetention) snapshot.cacheRetention = status.cacheRetention
    scheduleWrite()
  }

  pi.events.on(CACHE_STATUS_EVENT, (data) => {
    const status = cacheStatusFromEvent(data)
    if (!status) return
    cacheStatus = status
    applyStatus()
  })

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
      cacheRetention: startMode === 'long' || process.env.PI_CACHE_RETENTION === 'long' ? 'long' : 'short',
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
      autoWarmLimit: null,
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
    applyStatus()
    scheduleWrite()
  }

  pi.on('session_start', (_event, ctx) => start(ctx))

  pi.on('model_select', (_event, ctx) => {
    refreshModel(ctx)
    scheduleWrite()
  })

  pi.on('before_agent_start', (event) => {
    if (!snapshot) return
    if (event.messageType !== 'user') return
    snapshot.turnStartedAt = Date.now()
    scheduleWrite()
  })

  pi.on('context_with_system', (event, ctx) => {
    if (!snapshot) return
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
