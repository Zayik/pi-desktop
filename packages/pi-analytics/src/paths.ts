import { homedir } from 'os'
import { join } from 'path'

/** Overrides where the package keeps its files (the plan, session files, the index and reports). */
export const ANALYTICS_DIR_ENV = 'PI_ANALYTICS_DIR'

/** Pi's agent folder: `PI_CODING_AGENT_DIR`, or `~/.pi/agent`. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR || join(env.HOME ?? env.USERPROFILE ?? homedir(), '.pi', 'agent')
}

/** `<Pi agent folder>/pi-analytics`, unless `PI_ANALYTICS_DIR` names another. */
export function analyticsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env[ANALYTICS_DIR_ENV] || join(piAgentDir(env), 'pi-analytics')
}

/** Pi's global settings, where `cacheWarming` lives. */
export function piSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(piAgentDir(env), 'settings.json')
}

export const PLAN_FILE = 'cache-plan.json'
export const SESSIONS_DIR = 'sessions'
export const REPORTS_DIR = 'reports'
export const INDEX_FILE = 'analytics.sqlite'
export const ARCHIVE_DIR = 'archive'
/** Auto mode's per-hour schedule, for models the plan gives no hours of their own (same format Pi Desktop builds). */
export const AUTO_SCHEDULE_FILE = 'auto-warm.json'

export function planPath(dir = analyticsDir()): string {
  return join(dir, PLAN_FILE)
}

/** The cache mode picked for one session, which outranks the plan: `{ mode, changedAt }`. */
export function sessionModePath(sessionId: string, dir = analyticsDir()): string {
  return join(dir, SESSIONS_DIR, `${safeId(sessionId)}.mode`)
}

/** What the extension is doing for one session, rewritten as it changes. */
export function sessionStatusPath(sessionId: string, dir = analyticsDir()): string {
  return join(dir, SESSIONS_DIR, `${safeId(sessionId)}.status.json`)
}

function safeId(sessionId: string): string {
  return sessionId.replace(/[^\w.-]/g, '_')
}
