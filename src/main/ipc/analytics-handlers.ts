import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { ANALYTICS_RANGES, type AnalyticsRangeKey, type AnalyticsReport, type OverviewRequest } from '../../shared/analytics-report'
import { getAnalyticsIndex } from '../analytics-index'
import { isWithinSessionRoots } from '../pi-paths'
import { appLog } from '../app-log'
import { assertTrustedSender, isObject, isString } from './validation'

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
}

function parseOverviewRequest(value: unknown): OverviewRequest {
  if (!isObject(value)) throw new Error('request must be an object')
  const range = value.range
  if (!isString(range) || !ANALYTICS_RANGES.includes(range as AnalyticsRangeKey)) throw new Error('range is not a known range')
  const projectPath = value.projectPath
  if (projectPath !== null && !isString(projectPath)) throw new Error('projectPath must be a string or null')
  return { range: range as AnalyticsRangeKey, projectPath: projectPath || null }
}
