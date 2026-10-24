import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  CONTEXT_DIR_ENV,
  CONTEXT_SNAPSHOT_VERSION,
  buildBreakdown,
  callFromMessage,
  emptyTotals,
  recordCall,
  snapshotFileName,
  snapshotModel,
  type ContextSnapshot,
  type ToolDefinitionInput,
} from './context-snapshot'

const contextDir = process.env[CONTEXT_DIR_ENV] ?? null
// Writes are coalesced: a turn fires several events within a few milliseconds.
const WRITE_DELAY_MS = 200

/**
 * Records what fills the model context on each request and what each model
 * call cost, for Pi Desktop's Context panel. Adds nothing to the context and
 * changes no request: every handler only observes. The snapshot is written to
 * `<PI_DESKTOP_CONTEXT_DIR>/<session id>.json`; without that folder the
 * extension does nothing.
 */
export default function piDesktopContext(pi: ExtensionAPI): void {
  if (!contextDir) return
  const dir = contextDir

  let snapshot: ContextSnapshot | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

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

  const refreshModel = (ctx: ExtensionContext): void => {
    if (!snapshot) return
    snapshot.model = snapshotModel(ctx.model)
    snapshot.reportedTokens = ctx.getContextUsage()?.tokens ?? null
  }

  /** Rebuild calls and the turn start from the saved session, so a resumed session shows its history. */
  const start = (ctx: ExtensionContext): void => {
    const settings = pi.getSettings() as { cacheWarming?: unknown }
    snapshot = {
      version: CONTEXT_SNAPSHOT_VERSION,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      updatedAt: Date.now(),
      model: null,
      cacheRetention: process.env.PI_CACHE_RETENTION === 'long' ? 'long' : 'short',
      cacheWarming: typeof settings.cacheWarming === 'string' ? settings.cacheWarming : null,
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
    scheduleWrite()
  }

  pi.on('session_start', (_event, ctx) => start(ctx))

  pi.on('model_select', (_event, ctx) => {
    refreshModel(ctx)
    scheduleWrite()
  })

  pi.on('before_agent_start', (event) => {
    if (!snapshot || event.messageType !== 'user') return
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
    scheduleWrite()
  })

  pi.on('cache_warming_decision', (event) => {
    if (!snapshot || event.action !== 'warm') return
    snapshot.lastWarmAt = Date.now()
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
