import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { recordContext } from '../../../resources/pi-desktop-context'
import { analyticsDir, contextDir } from './paths'
import { quietSqliteWarning } from './quiet'

/**
 * pi-analytics in Pi: the `/analytics` command (report and cache), the
 * `/start-session-analyzer` page, and the context recorder that page reads.
 * It only observes: nothing here changes a request or Pi's cache warming.
 */
export default function piAnalytics(pi: ExtensionAPI): void {
  quietSqliteWarning()
  const dir = analyticsDir()
  recordContext(pi, contextDir(dir))

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
