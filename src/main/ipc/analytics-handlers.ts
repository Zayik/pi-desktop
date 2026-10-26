import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import type { CacheSetting, CacheSettingsState } from '../../shared/cache-analysis'
import { ANALYTICS_RANGES, type AnalyticsRangeKey, type AnalyticsReport, type OverviewRequest } from '../../shared/analytics-report'
import { getAnalyticsIndex } from '../analytics-index'
import { isWithinSessionRoots } from '../pi-paths'
import { appLog } from '../app-log'
import { assertTrustedSender, isObject, isString } from './validation'
import {
  clearAway,
  isModelCacheSetting,
  markAway,
  readAway,
  readCacheSettings,
  readCacheWarming,
  updateCacheSettings,
  writeCacheWarming,
} from '../../../packages/pi-analytics/src/cache-settings'

/** The first full scan waits until startup work has settled. */
const STARTUP_SCAN_DELAY_MS = 15_000

export function registerAnalyticsHandlers(): void {
  setTimeout(() => {
    void getAnalyticsIndex().refresh(true)
      .catch((error: unknown) => {
        appLog.warn('analytics', 'Could not index sessions for analytics', error)
      })
  }, STARTUP_SCAN_DELAY_MS).unref?.()

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_SESSION_REPORT, async (event: IpcMainInvokeEvent, sessionFile: unknown): Promise<AnalyticsReport | null> => {
    assertTrustedSender(event)
    if (!isString(sessionFile) || !sessionFile) throw new Error('sessionFile must be a non-empty string')
    if (!isWithinSessionRoots(sessionFile)) return null
    return getAnalyticsIndex().sessionReport(sessionFile)
  })

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_OVERVIEW, async (event: IpcMainInvokeEvent, request: unknown): Promise<AnalyticsReport> => {
    assertTrustedSender(event)
    return getAnalyticsIndex().overview(parseOverviewRequest(request))
  })

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_REBUILD, async (event: IpcMainInvokeEvent): Promise<void> => {
    assertTrustedSender(event)
    await getAnalyticsIndex().rebuild()
  })

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_CACHE_SETTINGS, (event: IpcMainInvokeEvent): CacheSettingsState => {
    assertTrustedSender(event)
    return cacheSettingsState()
  })

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_SET_CACHE_SETTINGS, (event: IpcMainInvokeEvent, changes: unknown): CacheSettingsState => {
    assertTrustedSender(event)
    updateCacheSettings(parseSettingChanges(changes))
    return cacheSettingsState()
  })

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_SET_CACHE_WARMING, (event: IpcMainInvokeEvent, on: unknown): CacheSettingsState => {
    assertTrustedSender(event)
    if (typeof on !== 'boolean') throw new Error('on must be a boolean')
    writeCacheWarming(on)
    return cacheSettingsState()
  })

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_SET_AWAY, (event: IpcMainInvokeEvent, away: unknown): CacheSettingsState => {
    assertTrustedSender(event)
    if (typeof away !== 'boolean') throw new Error('away must be a boolean')
    if (away) markAway()
    else clearAway()
    return cacheSettingsState()
  })
}

function cacheSettingsState(): CacheSettingsState {
  let warmingMode: string | null = null
  try {
    warmingMode = readCacheWarming()
  } catch (error) {
    appLog.warn('analytics', 'Could not read Pi settings.json', error)
  }
  return { models: readCacheSettings().models, warming: warmingMode === 'idle', warmingMode, away: readAway() }
}

function parseSettingChanges(value: unknown): Record<string, CacheSetting | null> {
  if (!isObject(value)) throw new Error('changes must be an object')
  const changes: Record<string, CacheSetting | null> = {}
  for (const [model, setting] of Object.entries(value)) {
    if (setting !== null && !isModelCacheSetting(setting)) throw new Error(`${model}: not a cache setting`)
    changes[model] = setting
  }
  return changes
}

function parseOverviewRequest(value: unknown): OverviewRequest {
  if (!isObject(value)) throw new Error('request must be an object')
  const range = value.range
  if (!isString(range) || !ANALYTICS_RANGES.includes(range as AnalyticsRangeKey)) throw new Error('range is not a known range')
  const projectPath = value.projectPath
  if (projectPath !== null && !isString(projectPath)) throw new Error('projectPath must be a string or null')
  return { range: range as AnalyticsRangeKey, projectPath: projectPath || null }
}
