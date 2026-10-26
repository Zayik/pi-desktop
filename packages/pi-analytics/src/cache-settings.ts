/**
 * The cache settings you pick, in files the warming extension, the CLI and
 * Pi Desktop share:
 * - `<analytics dir>/cache-settings.json`: one fixed setting per model,
 *   `{"version":1,"models":{"anthropic/claude-haiku-5-5":6,"github-copilot/gpt-6-luna":"long"}}`.
 *   A number is how many idle pings Pi sends after you stop (0 for none);
 *   "long" asks for the longer cache lifetime and sends no idle pings. A
 *   model left out keeps Pi's own warming.
 * - `<analytics dir>/away.json`: `{"at":<ms>}`, set by `/away`. A chat whose
 *   last message came before it sends no idle pings; the next message in a
 *   chat is newer, so that chat warms again with nothing to undo.
 * - Pi's own `settings.json` `cacheWarming`: "idle" lets Pi ping after you
 *   stop, which the per-model pings need; off puts back Pi's default
 *   ("streaming", warm only while the agent works).
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { analyticsDir, piAgentDir } from './paths'

export const CACHE_SETTINGS_FILE = 'cache-settings.json'
export const AWAY_FILE = 'away.json'
export const CACHE_SETTINGS_VERSION = 1
/** More idle pings than any cache lifetime fits in Pi's 30 idle minutes. */
export const MAX_SETTING_PINGS = 12

export type ModelCacheSetting = number | 'long'

export interface CacheSettings {
  version: typeof CACHE_SETTINGS_VERSION
  /** `provider/model` to its setting. */
  models: Record<string, ModelCacheSetting>
}

export function isModelCacheSetting(value: unknown): value is ModelCacheSetting {
  return value === 'long' || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_SETTING_PINGS)
}

/** The settings in a file's text; entries it cannot read are left out. */
export function parseCacheSettings(text: string): CacheSettings {
  const parsed: unknown = JSON.parse(text)
  const models: Record<string, ModelCacheSetting> = {}
  const source = isRecord(parsed) && isRecord(parsed.models) ? parsed.models : {}
  for (const [model, setting] of Object.entries(source)) {
    if (model.includes('/') && isModelCacheSetting(setting)) models[model] = setting
  }
  return { version: CACHE_SETTINGS_VERSION, models }
}

export function cacheSettingsPath(dir = analyticsDir()): string {
  return join(dir, CACHE_SETTINGS_FILE)
}

export function awayPath(dir = analyticsDir()): string {
  return join(dir, AWAY_FILE)
}

export function readCacheSettings(dir = analyticsDir()): CacheSettings {
  try {
    return parseCacheSettings(readFileSync(cacheSettingsPath(dir), 'utf8'))
  } catch {
    return { version: CACHE_SETTINGS_VERSION, models: {} }
  }
}

/** Set each named model's setting; null puts the model back on Pi's own warming. */
export function updateCacheSettings(changes: Record<string, ModelCacheSetting | null>, dir = analyticsDir()): CacheSettings {
  const settings = readCacheSettings(dir)
  for (const [model, setting] of Object.entries(changes)) {
    if (!model.includes('/')) throw new Error(`"${model}" is not a provider/model name`)
    if (setting === null) delete settings.models[model]
    else if (isModelCacheSetting(setting)) settings.models[model] = setting
    else throw new Error(`A setting is 0 to ${MAX_SETTING_PINGS} pings or "long"`)
  }
  writeJson(cacheSettingsPath(dir), settings)
  return settings
}

export function parseAway(text: string): number | null {
  const parsed: unknown = JSON.parse(text)
  return isRecord(parsed) && typeof parsed.at === 'number' && Number.isFinite(parsed.at) ? parsed.at : null
}

export function readAway(dir = analyticsDir()): number | null {
  try {
    return parseAway(readFileSync(awayPath(dir), 'utf8'))
  } catch {
    return null
  }
}

/** Stop idle pings in every chat whose last message came before `at`. */
export function markAway(at = Date.now(), dir = analyticsDir()): number {
  writeJson(awayPath(dir), { at })
  return at
}

/** Let chats that are still inside their idle window warm again. */
export function clearAway(dir = analyticsDir()): void {
  rmSync(awayPath(dir), { force: true })
}

export function piSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(piAgentDir(env), 'settings.json')
}

/** Pi's `cacheWarming`, or null when settings.json leaves it out (Pi then uses "streaming"). */
export function readCacheWarming(env: NodeJS.ProcessEnv = process.env): string | null {
  const settings = readPiSettings(env)
  return typeof settings.cacheWarming === 'string' ? settings.cacheWarming : null
}

/** Idle warming on ("idle") or back to Pi's default ("streaming"); every other key is kept. */
export function writeCacheWarming(on: boolean, env: NodeJS.ProcessEnv = process.env): string {
  const settings = readPiSettings(env)
  const mode = on ? 'idle' : 'streaming'
  writeJson(piSettingsPath(env), { ...settings, cacheWarming: mode }, 2)
  return mode
}

function readPiSettings(env: NodeJS.ProcessEnv): Record<string, unknown> {
  let text: string
  try {
    text = readFileSync(piSettingsPath(env), 'utf8')
  } catch {
    return {}
  }
  // A settings file we cannot read is left alone rather than replaced.
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) throw new Error(`${piSettingsPath(env)} is not a JSON object`)
  return parsed
}

function writeJson(path: string, value: unknown, indent?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, indent)}\n`)
  renameSync(temp, path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
