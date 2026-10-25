import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { AUTO_WARM_FILE, isAutoWarmSchedule, type AutoWarmSchedule } from '../../resources/context-snapshot'
import type { AnalyticsRangeKey, AnalyticsReport } from '../shared/analytics-report'
import { buildAutoWarmSchedule } from '../shared/auto-warm'
import { getContextSnapshotDir } from './context-snapshots'

const MAX_SCHEDULE_BYTES = 256 * 1024
/** Habits change: the schedule is built from the last 30 days of sessions. */
export const AUTO_WARM_RANGE: AnalyticsRangeKey = '30'
const AUTO_WARM_DAYS = 30
/** Rebuilt this often while the app runs, and on picking Auto when older. */
export const AUTO_WARM_REBUILD_MS = 6 * 60 * 60 * 1000

/** The schedule auto mode runs on, or null before the first build. */
export async function readAutoWarmSchedule(dir = getContextSnapshotDir()): Promise<AutoWarmSchedule | null> {
  try {
    const text = await readFile(join(dir, AUTO_WARM_FILE), 'utf8')
    if (text.length > MAX_SCHEDULE_BYTES) return null
    const parsed: unknown = JSON.parse(text)
    return isAutoWarmSchedule(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Build the schedule from the analytics overview and write it where the
 * context extension reads it; running agents pick it up at their next break.
 */
export async function rebuildAutoWarmSchedule(
  overview: (range: AnalyticsRangeKey) => Promise<AnalyticsReport>,
  dir = getContextSnapshotDir(),
  now = Date.now(),
): Promise<AutoWarmSchedule> {
  const report = await overview(AUTO_WARM_RANGE)
  const schedule = buildAutoWarmSchedule(report.cache, now, AUTO_WARM_DAYS)
  const target = join(dir, AUTO_WARM_FILE)
  const temp = `${target}.${process.pid}.tmp`
  await mkdir(dir, { recursive: true })
  await writeFile(temp, JSON.stringify(schedule))
  await rename(temp, target)
  return schedule
}

let building: Promise<AutoWarmSchedule> | null = null

/** The schedule, rebuilt first when missing or older than `maxAgeMs`; one build runs at a time. */
export async function freshAutoWarmSchedule(
  overview: (range: AnalyticsRangeKey) => Promise<AnalyticsReport>,
  maxAgeMs = AUTO_WARM_REBUILD_MS,
  dir = getContextSnapshotDir(),
  now = Date.now(),
): Promise<AutoWarmSchedule> {
  const current = await readAutoWarmSchedule(dir)
  if (current && now - current.builtAt < maxAgeMs) return current
  building ??= rebuildAutoWarmSchedule(overview, dir, now).finally(() => { building = null })
  return building
}
