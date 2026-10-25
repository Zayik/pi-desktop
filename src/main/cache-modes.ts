import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { cacheModeFileName, isCacheModeChoice, type CacheMode, type CacheModeChoice } from '../../resources/context-snapshot'
import { getContextSnapshotDir } from './context-snapshots'

const MAX_MODE_FILE_BYTES = 4 * 1024
/** Pi's warming setting that also refreshes the cache after the agent stops. */
export const IDLE_CACHE_WARMING = 'idle'

/** The mode picked for a session, or null when it still runs in the mode it started with. */
export async function readCacheMode(sessionId: string, dir = getContextSnapshotDir()): Promise<CacheModeChoice | null> {
  try {
    const text = await readFile(join(dir, cacheModeFileName(sessionId)), 'utf8')
    if (text.length > MAX_MODE_FILE_BYTES) return null
    const parsed: unknown = JSON.parse(text)
    return isCacheModeChoice(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Pick a session's mode; the context extension applies it to the session's next request. */
export async function writeCacheMode(sessionId: string, mode: CacheMode, dir = getContextSnapshotDir(), now = Date.now()): Promise<CacheModeChoice> {
  const choice: CacheModeChoice = { mode, changedAt: now }
  const target = join(dir, cacheModeFileName(sessionId))
  const temp = `${target}.${process.pid}.tmp`
  await mkdir(dir, { recursive: true })
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

/** Pi's models file, where a model's `promptCache` lifetime can be set for a built-in model. */
export function piModelsPath(): string {
  return join(piGlobalSettingsPath(), '..', 'models.json')
}

/**
 * Give a model a short-tier prompt cache lifetime through a `modelOverrides`
 * entry, so Pi's cache warmer will keep it warm (Pi warms only models with a
 * known lifetime; GitHub Copilot and OpenAI models ship without one). Only
 * on the user's request; a lifetime already set is kept, and a file that
 * does not parse is left alone. Agents pick it up when restarted.
 */
export async function enableModelCacheLifetime(provider: string, modelId: string, seconds: number, path = piModelsPath()): Promise<void> {
  const config = (await readSettingsObject(path)) ?? {}
  const providers = isPlainObject(config.providers) ? config.providers : (config.providers = {})
  const entry = isPlainObject(providers[provider]) ? providers[provider] : (providers[provider] = {})
  const overrides = isPlainObject(entry.modelOverrides) ? entry.modelOverrides : (entry.modelOverrides = {})
  const model = isPlainObject(overrides[modelId]) ? overrides[modelId] : (overrides[modelId] = {})
  const promptCache = isPlainObject(model.promptCache) ? model.promptCache : (model.promptCache = {})
  if (typeof promptCache.short === 'number' && promptCache.short > 0) return
  promptCache.short = seconds
  const temp = `${path}.${process.pid}.tmp`
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`)
  await rename(temp, path)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
