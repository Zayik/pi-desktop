import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  CONTEXT_DIR_ENV,
  CONTEXT_SNAPSHOT_VERSION,
  MAX_CATALOG_MODELS,
  PARENT_SESSION_ENV,
  buildBreakdown,
  callFromMessage,
  emptyPings,
  emptyTotals,
  pingFromEntry,
  recordCall,
  recordPing,
  snapshotFileName,
  snapshotModel,
  type ContextSnapshot,
  type PingPlan,
  type SnapshotModel,
  type ToolDefinitionInput,
} from './context-snapshot'

// Writes are coalesced: a turn fires several events within a few milliseconds.
const WRITE_DELAY_MS = 200
const MAX_WRITE_RETRIES = 3
/** A warming refresh is a one-token reply; its usage entry is looked for this long after the decision. */
const PING_SCAN_DELAYS_MS = [1_500, 4_000, 10_000, 30_000]

export interface RecordContextOptions {
  /** The idle ping setting for the session's model now (pi-analytics' per-model settings). */
  pingPlan?: () => PingPlan | null
}

export interface ContextRecorder {
  /** Write the snapshot again soon, after something it reads (the ping plan) changed. */
  refresh(): void
}

/**
 * Loaded on its own (with `-e`) where pi-analytics is not: OMP. It records
 * only when Pi Desktop names the folder in `PI_DESKTOP_CONTEXT_DIR`.
 */
export default function piDesktopContext(pi: ExtensionAPI): void {
  const dir = process.env[CONTEXT_DIR_ENV]
  if (dir) recordContext(pi, dir)
}

/**
 * Records what fills the model context on each request and what each model
 * call cost, for Pi Desktop's Context panel and pi-analytics' session page.
 * Adds nothing to the context and changes nothing about the requests. The
 * snapshot is written to `<dir>/<session id>.json`.
 */
export function recordContext(pi: ExtensionAPI, dir: string, options: RecordContextOptions = {}): ContextRecorder {
  // Read once at load: start() then overwrites it for the processes this one spawns.
  const parentSessionId = process.env[PARENT_SESSION_ENV] || null
  const processStartedAt = Math.round(Date.now() - process.uptime() * 1000)

  let snapshot: ContextSnapshot | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const activeTools = (): ToolDefinitionInput[] => {
    const active = new Set(pi.getActiveTools())
    return pi.getAllTools().filter((tool) => active.has(tool.name))
  }

  let failedWrites = 0
  const write = (): void => {
    timer = null
    if (!snapshot) return
    snapshot.updatedAt = Date.now()
    if (options.pingPlan) {
      try {
        snapshot.pingPlan = options.pingPlan()
      } catch {
        snapshot.pingPlan = null
      }
    }
    const target = join(dir, snapshotFileName(snapshot.sessionId))
    const temp = `${target}.${process.pid}.tmp`
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(temp, JSON.stringify(snapshot))
      renameSync(temp, target)
      failedWrites = 0
    } catch {
      // A snapshot is a view aid: a failed write must never disturb the session.
      // Windows can hold the file for a moment (a reader, antivirus), so try again soon.
      if (++failedWrites <= MAX_WRITE_RETRIES && !timer) timer = setTimeout(write, WRITE_DELAY_MS * failedWrites)
    }
  }

  const scheduleWrite = (): void => {
    if (!timer) timer = setTimeout(write, WRITE_DELAY_MS)
  }

  /**
   * Pings are not messages: Pi appends a `usage` entry to the branch after
   * each refresh and tells extensions nothing, so the branch is read again.
   * Returns true when it found a new one.
   */
  const readPings = (entries: unknown[]): boolean => {
    if (!snapshot) return false
    const pings = emptyPings()
    for (const entry of entries) {
      const ping = pingFromEntry(entry)
      if (ping) recordPing(pings, ping)
    }
    const found = pings.count > (snapshot.pings?.count ?? 0)
    snapshot.pings = pings
    snapshot.lastWarmAt = pings.recent.at(-1)?.[0] ?? null
    return found
  }

  let pingScan: ReturnType<typeof setTimeout> | null = null
  const scanForPing = (ctx: ExtensionContext, attempt = 0): void => {
    if (pingScan) clearTimeout(pingScan)
    pingScan = setTimeout(() => {
      pingScan = null
      let found = false
      try {
        found = readPings(ctx.sessionManager.getBranch())
      } catch {
        // A replaced session: its own start reads its pings.
      }
      if (found) scheduleWrite()
      else if (attempt + 1 < PING_SCAN_DELAYS_MS.length) scanForPing(ctx, attempt + 1)
    }, PING_SCAN_DELAYS_MS[attempt])
    pingScan.unref?.()
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
    snapshot.thinkingLevel = ctx.thinkingLevel ?? snapshot.thinkingLevel ?? null
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
      cacheRetention: process.env.PI_CACHE_RETENTION === 'long' ? 'long' : 'short',
      cacheWarming: typeof settings.cacheWarming === 'string' ? settings.cacheWarming : null,
      breakdown: null,
      reportedTokens: null,
      calls: [],
      totals: emptyTotals(),
      turnStartedAt: null,
      lastRequestAt: null,
      lastWarmAt: null,
      pings: emptyPings(),
      process: { pid: process.pid, startedAt: processStartedAt, cwd: ctx.cwd ?? process.cwd() },
      // Older Pi releases have neither; the session file still names the session.
      sessionName: ctx.sessionManager.getSessionName?.() ?? null,
      thinkingLevel: ctx.thinkingLevel ?? null,
      agentRunning: ctx.isIdle?.() === false,
      activeTool: null,
      endedAt: null,
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
    readPings(ctx.sessionManager.getBranch())
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

  // The event carries Pi's own action, not what a later handler (pi-analytics) answers,
  // so the ping is counted only once its usage entry is on the branch.
  pi.on('cache_warming_decision', (_event, ctx) => {
    if (!snapshot) return
    scanForPing(ctx)
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

  pi.on('agent_start', () => {
    if (!snapshot) return
    snapshot.agentRunning = true
    scheduleWrite()
  })

  pi.on('agent_end', () => {
    if (!snapshot) return
    snapshot.agentRunning = false
    snapshot.activeTool = null
    scheduleWrite()
  })

  pi.on('tool_execution_start', (event) => {
    if (!snapshot) return
    snapshot.activeTool = event.toolName
    scheduleWrite()
  })

  pi.on('tool_execution_end', () => {
    if (!snapshot) return
    snapshot.activeTool = null
    scheduleWrite()
  })

  pi.on('thinking_level_select', (_event, ctx) => {
    refreshModel(ctx)
    scheduleWrite()
  })

  pi.on('session_info_changed', (event) => {
    if (!snapshot) return
    snapshot.sessionName = event.name ?? null
    scheduleWrite()
  })

  pi.on('session_shutdown', () => {
    if (timer) clearTimeout(timer)
    if (pingScan) clearTimeout(pingScan)
    if (snapshot) {
      snapshot.agentRunning = false
      snapshot.activeTool = null
      snapshot.endedAt = Date.now()
    }
    write()
    snapshot = null
  })

  return { refresh: scheduleWrite }
}
