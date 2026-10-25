import { readFileSync } from 'fs'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { isCacheModeChoice, type CacheMode, type CacheModeChoice } from '../../resources/context-snapshot'
import { analyticsDir, sessionModePath } from '../../packages/pi-analytics/src/paths'

const MAX_MODE_FILE_BYTES = 4 * 1024
/** Pi's warming setting that also refreshes the cache after the agent stops. */
export const IDLE_CACHE_WARMING = 'idle'

/**
 * The mode picked for a session, or null when it still runs in the mode it
 * started with. Picks live in pi-analytics' folder, where its extension
 * reads them, so a pick reaches the chat in the CLI too.
 */
export async function readCacheMode(sessionId: string, dir = analyticsDir()): Promise<CacheModeChoice | null> {
  try {
    const text = await readFile(sessionModePath(sessionId, dir), 'utf8')
    if (text.length > MAX_MODE_FILE_BYTES) return null
    const parsed: unknown = JSON.parse(text)
    return isCacheModeChoice(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Pick a session's mode; pi-analytics' extension applies it to the session's next request. */
export async function writeCacheMode(sessionId: string, mode: CacheMode, dir = analyticsDir(), now = Date.now()): Promise<CacheModeChoice> {
  const choice: CacheModeChoice = { mode, changedAt: now }
  const target = sessionModePath(sessionId, dir)
  const temp = `${target}.${process.pid}.tmp`
  await mkdir(dirname(target), { recursive: true })
  await writeFile(temp, JSON.stringify(choice))
  await rename(temp, target)
  return choice
}

/** Pi's global settings file, where `cacheWarming` lives (Pi reads it from nowhere else). */
export function piGlobalSettingsPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ||
    join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.pi', 'agent')
  return join(agentDir, 'settings.json')
}

async function readSettingsObject(path: string): Promise<Record<string, unknown> | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} does not hold a settings object`)
  return parsed as Record<string, unknown>
}

/** Pi's global `cacheWarming` setting, or null when unset (Pi then warms only while the agent works). */
export async function readPiCacheWarming(path = piGlobalSettingsPath()): Promise<string | null> {
  try {
    const value = (await readSettingsObject(path))?.cacheWarming
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

/**
 * Set Pi's global `cacheWarming` to "idle", keeping every other setting.
 * Only on the user's request: it applies to every Pi session, in the app or
 * not, and agents already running keep the setting they started with. A file
 * that does not parse is left alone.
 */
export async function enableIdleCacheWarming(path = piGlobalSettingsPath()): Promise<void> {
  const settings = (await readSettingsObject(path)) ?? {}
  if (settings.cacheWarming === IDLE_CACHE_WARMING) return
  settings.cacheWarming = IDLE_CACHE_WARMING
  const temp = `${path}.${process.pid}.tmp`
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`)
  await rename(temp, path)
}


/** Whether the user installed pi-analytics in Pi (`pi install`), which then loads it in every session. */
export function piAnalyticsInstalled(path = piGlobalSettingsPath()): boolean {
  try {
    const packages: unknown = (JSON.parse(readFileSync(path, 'utf8')) as { packages?: unknown }).packages
    return Array.isArray(packages) && packages.some((entry) => {
      const source = typeof entry === 'string' ? entry : (entry as { source?: unknown } | null)?.source
      return typeof source === 'string' && /(^|[/:@])pi-analytics(@|$|\/|\\)/.test(source)
    })
  } catch {
    return false
  }
}
