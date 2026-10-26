import { shell } from 'electron'
import { rmSync } from 'fs'
import { join } from 'path'
import { analyticsDir } from '../../packages/pi-analytics/src/paths'
import { sessionPageUrl } from '../../packages/pi-analytics/src/live/launch'
import { DESKTOP_FOCUS_FILE, writeAtomic } from '../../packages/pi-analytics/src/live/server'
import { piAnalyticsPath } from './agent-resources'

/**
 * pi-analytics' live session page, popped out of the Context panel. The page
 * is served by the package's helper, the same one Pi sessions in a terminal
 * use; the app only starts it (with Electron running as Node) and says which
 * chat is open, so the page can follow along. The page only reads.
 */
let following = false
let focus: string | null = null

function focusPath(): string {
  return join(analyticsDir(), DESKTOP_FOCUS_FILE)
}

function writeFocus(): void {
  if (!following) return
  writeAtomic(focusPath(), JSON.stringify({ sessionId: focus, at: Date.now() }))
}

export async function openSessionPage(sessionId: string | null): Promise<void> {
  focus = sessionId ?? focus
  following = true
  writeFocus()
  const url = await sessionPageUrl(focus, {
    cliPath: piAnalyticsPath('cli.js'),
    runtime: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    follow: true,
  })
  await shell.openExternal(url)
}

export function setDesktopFocus(sessionId: string | null): void {
  if (sessionId === focus) return
  focus = sessionId
  writeFocus()
}

/** On quit: the page stops following a chat that is no longer open. */
export function clearDesktopFocus(): void {
  if (!following) return
  try {
    rmSync(focusPath(), { force: true })
  } catch {
    // Nothing to follow either way.
  }
}
