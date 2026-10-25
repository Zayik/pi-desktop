import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { ANALYTICS_RANGES, type AnalyticsRangeKey, type AnalyticsReport, type CachePlanState, type OverviewRequest } from '../../shared/analytics-report'
import { applyRecommendations, readCacheWarming, undo } from '../../../packages/pi-analytics/src/apply'
import { readPlan } from '../../../packages/pi-analytics/src/plan-file'
import { planPath } from '../../../packages/pi-analytics/src/paths'
import { recommendations, reportDays, withAlternative } from '../../../packages/pi-analytics/src/recommendations'
import { getAnalyticsIndex } from '../analytics-index'
import { AUTO_WARM_REBUILD_MS, freshAutoWarmSchedule } from '../auto-warm'
import { isWithinSessionRoots } from '../pi-paths'
import { appLog } from '../app-log'
import { assertTrustedSender, isObject, isString } from './validation'

/** The first full scan waits until startup work has settled. */
const STARTUP_SCAN_DELAY_MS = 15_000

export function registerAnalyticsHandlers(): void {
  setTimeout(() => {
    void getAnalyticsIndex().refresh(true)
      .then(() => updateAutoWarmSchedule())
      .catch((error: unknown) => {
        appLog.warn('analytics', 'Could not index sessions for analytics', error)
      })
  }, STARTUP_SCAN_DELAY_MS).unref?.()
  setInterval(() => void updateAutoWarmSchedule(), AUTO_WARM_REBUILD_MS).unref?.()

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

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_GET_CACHE_PLAN, async (event: IpcMainInvokeEvent): Promise<CachePlanState> => {
    assertTrustedSender(event)
    return cachePlanState()
  })

  // The recommendation is worked out again here from the same overview, so the window only names the model.
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_APPLY_CACHE_RECOMMENDATION, async (event: IpcMainInvokeEvent, request: unknown): Promise<CachePlanState> => {
    assertTrustedSender(event)
    if (!isObject(request) || !isString(request.model) || typeof request.allowIdleWarming !== 'boolean') throw new Error('request must name a model and say whether idle warming may be turned on')
    const overview = parseOverviewRequest(request)
    const now = Date.now()
    const report = await getAnalyticsIndex().overview(overview, now)
    const found = recommendations(report, now).find((rec) => rec.model === request.model)
    const recommendation = found && request.long === true ? withAlternative(found) : found
    if (!recommendation) throw new Error(`No cache recommendation for ${request.model}`)
    const allow = request.allowIdleWarming
    await applyRecommendations([recommendation], { now, days: reportDays(report, now), allowIdleWarming: () => allow })
    return cachePlanState()
  })

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_UNDO_CACHE_PLAN, async (event: IpcMainInvokeEvent): Promise<CachePlanState> => {
    assertTrustedSender(event)
    undo()
    return cachePlanState()
  })
}

function cachePlanState(): CachePlanState {
  return { plan: readPlan(planPath()), cacheWarming: readCacheWarming() }
}

function parseOverviewRequest(value: unknown): OverviewRequest {
  if (!isObject(value)) throw new Error('request must be an object')
  const range = value.range
  if (!isString(range) || !ANALYTICS_RANGES.includes(range as AnalyticsRangeKey)) throw new Error('range is not a known range')
  const projectPath = value.projectPath
  if (projectPath !== null && !isString(projectPath)) throw new Error('projectPath must be a string or null')
  return { range: range as AnalyticsRangeKey, projectPath: projectPath || null }
}

/** The whole history's overview over a range, which auto cache mode's schedule is built from. */
export function overviewForAutoWarm(range: AnalyticsRangeKey): Promise<AnalyticsReport> {
  return getAnalyticsIndex().overview({ range, projectPath: null })
}

/** Rebuild auto cache mode's schedule when it is due. */
async function updateAutoWarmSchedule(): Promise<void> {
  try {
    await freshAutoWarmSchedule(overviewForAutoWarm)
  } catch (error) {
    appLog.warn('analytics', 'Could not build the auto keep-warm schedule', error)
  }
}
