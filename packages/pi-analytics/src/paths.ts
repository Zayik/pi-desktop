import { homedir } from 'os'
import { join } from 'path'

/** Overrides where the package keeps its files (context snapshots, the index and reports). */
export const ANALYTICS_DIR_ENV = 'PI_ANALYTICS_DIR'

/** Pi's agent folder: `PI_CODING_AGENT_DIR`, or `~/.pi/agent`. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR || join(env.HOME ?? env.USERPROFILE ?? homedir(), '.pi', 'agent')
}

/** `<Pi agent folder>/pi-analytics`, unless `PI_ANALYTICS_DIR` names another. */
export function analyticsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env[ANALYTICS_DIR_ENV] || join(piAgentDir(env), 'pi-analytics')
}

/** Context snapshots, one per session, from the recorder Pi Desktop's Context panel uses. */
export const CONTEXT_DIR = 'context'
export const REPORTS_DIR = 'reports'
export const INDEX_FILE = 'analytics.sqlite'
export const ARCHIVE_DIR = 'archive'

/**
 * Where sessions' context snapshots go: Pi Desktop names the folder for its
 * chats (`PI_DESKTOP_CONTEXT_DIR`, the same one), everything else uses this.
 */
export function contextDir(dir = analyticsDir(), env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_DESKTOP_CONTEXT_DIR || join(dir, CONTEXT_DIR)
}
