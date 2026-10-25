import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { analyticsDir, sessionStatusPath } from './paths'
import { CacheWarming, type WarmingModel } from './warming'
import { quietSqliteWarning } from './quiet'
import type { SessionCacheStatus } from './cache-plan'

/** Sent on `pi.events` whenever a session's cache status changes. */
export const STATUS_EVENT = 'pi-analytics:status'
const WRITE_DELAY_MS = 200
const FOOTER_KEY = 'pi-analytics'

/**
 * pi-analytics in Pi: the `/analytics` command (report, recommend, apply,
 * undo, reset, plan) and the cache plan applied to every request. It owns
 * `cache_warming_decision`; other extensions only observe it.
 */
export default function piAnalytics(pi: ExtensionAPI): void {
  quietSqliteWarning()
  const dir = analyticsDir()
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: SessionCacheStatus | null = null
  let ui: ExtensionContext['ui'] | null = null

  const write = (): void => {
    timer = null
    const status = pending
    if (!status) return
    const target = sessionStatusPath(status.sessionId, dir)
    const temp = `${target}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(temp, JSON.stringify(status))
      renameSync(temp, target)
    } catch {
      // The status is a view aid: a failed write must never disturb the session.
    }
  }

  const warming = new CacheWarming({
    dir,
    onStatus: (status) => {
      pending = status
      pi.events.emit(STATUS_EVENT, status)
      ui?.setStatus(FOOTER_KEY, footer(status))
      if (!timer) timer = setTimeout(write, WRITE_DELAY_MS)
    },
  })

  const modelOf = (ctx: ExtensionContext): WarmingModel | null => {
    const model = ctx.model as unknown as WarmingModel | undefined
    return model && typeof model.provider === 'string' && typeof model.id === 'string' ? model : null
  }

  pi.on('session_start', (_event, ctx) => {
    ui = ctx.hasUI ? ctx.ui : null
    let lastRequestAt: number | null = null
    for (const entry of ctx.sessionManager.getBranch()) {
      const message = entry.type === 'message' ? entry.message as { role?: unknown; timestamp?: unknown } : null
      if (message?.role === 'assistant') lastRequestAt = typeof message.timestamp === 'number' ? message.timestamp : Date.parse(entry.timestamp)
    }
    warming.startSession(ctx.sessionManager.getSessionId(), modelOf(ctx), lastRequestAt)
  })

  pi.on('model_select', (_event, ctx) => warming.setModel(modelOf(ctx)))

  pi.on('before_agent_start', (_event, ctx) => warming.setModel(modelOf(ctx)))

  pi.on('context_with_system', (_event, ctx) => {
    warming.setModel(modelOf(ctx))
    warming.realRequest()
  })

  pi.on('before_provider_request', () => warming.requestSent())

  pi.on('cache_warming_decision', (event) => {
    const action = warming.decide(event.continuationProbability, event.action)
    return action ? { action } : undefined
  })

  pi.on('session_shutdown', () => {
    if (timer) clearTimeout(timer)
    write()
  })

  pi.registerCommand('analytics', {
    description: 'Cost and cache report for your Pi sessions; apply, undo or reset its cache recommendations',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      // The session index loads node:sqlite; it is loaded only when asked for.
      const { runCommand } = await import('./commands')
      const lines = await runCommand(args, {
        dir,
        confirm: (title, message) => (ctx.hasUI ? ctx.ui.confirm(title, message) : Promise.resolve(false)),
        afterPlanChange: () => warming.apply(),
      })
      ctx.ui.notify(lines.join('\n'), 'info')
    },
  })
}

function footer(status: SessionCacheStatus): string | undefined {
  if (!status.cacheMode) return undefined
  const idle = status.idleLimit !== null ? ` ${status.idleWarms}/${status.idleLimit}` : ''
  return `cache ${status.cacheMode}${idle}`
}
