import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { PARENT_SESSION_ENV } from '../../../resources/context-snapshot'
import { recordContext } from '../../../resources/pi-desktop-context'
import { markAway } from './cache-settings'
import { analyticsDir, contextDir } from './paths'
import { quietSqliteWarning } from './quiet'
import { IdleWarming } from './warming'

/**
 * pi-analytics in Pi: the `/analytics` command (report and cache), the
 * `/start-session-analyzer` page, the context recorder that page reads, and
 * the idle pings you set per model (`/done` and `/away` stop them until your
 * next message). Requests and Pi's warming while the agent works are left
 * as Pi has them.
 */
export default function piAnalytics(pi: ExtensionAPI): void {
  quietSqliteWarning()
  const dir = analyticsDir()
  // Read before the recorder's session start names this session for the processes it spawns.
  const subagent = Boolean(process.env[PARENT_SESSION_ENV])
  recordContext(pi, contextDir(dir))
  const warming = new IdleWarming({ dir, subagent })

  pi.on('session_start', (_event, ctx) => warming.setModel(ctx.model))
  pi.on('model_select', (_event, ctx) => warming.setModel(ctx.model))
  pi.on('before_agent_start', (_event, ctx) => {
    warming.userMessage()
    warming.setModel(ctx.model)
  })
  pi.on('context_with_system', (_event, ctx) => {
    warming.setModel(ctx.model)
    warming.realRequest()
  })
  pi.on('cache_warming_decision', (event) => {
    const action = warming.decide(event.continuationProbability)
    return action ? { action } : undefined
  })

  pi.registerCommand('done', {
    description: 'No more idle cache pings for this chat until your next message in it',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      warming.markDone()
      ctx.ui.notify(`Idle cache pings stopped for this chat until your next message (${warming.describe()}).`, 'info')
    },
  })

  pi.registerCommand('away', {
    description: 'No more idle cache pings in any Pi chat until your next message in it',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      markAway(Date.now(), dir)
      warming.markDone()
      ctx.ui.notify('Idle cache pings stopped in every Pi chat. Each chat warms again after your next message in it.', 'info')
    },
  })

  pi.registerCommand('start-session-analyzer', {
    description: 'Open the live page of this session and every other Pi session on this machine',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      try {
        const { sessionPageUrl } = await import('./live/launch')
        const { openFile } = await import('./open')
        const url = await sessionPageUrl(ctx.sessionManager.getSessionId(), { dir })
        openFile(url)
        ctx.ui.notify(`Session page: ${url}`, 'info')
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
      }
    },
  })

  pi.registerCommand('analytics', {
    description: 'Cost and prompt-cache report for your Pi sessions: whether keep-warm pings would save money, and how many',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      // The session index loads node:sqlite; it is loaded only when asked for.
      const { runCommand } = await import('./commands')
      const lines = await runCommand(args, { dir })
      ctx.ui.notify(lines.join('\n'), 'info')
    },
  })
}
