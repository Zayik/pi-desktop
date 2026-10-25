import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { AUTO_SCHEDULE_FILE } from '../../packages/pi-analytics/src/paths'
import { buildReport, type AnalyticsReport } from '../shared/analytics-report'
import { freshAutoWarmSchedule, readAutoWarmSchedule } from './auto-warm'

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'auto-warm-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('builds the schedule when missing or stale and reuses a fresh one', async () => {
  await withDir(async (dir) => {
    let builds = 0
    const overview = async (): Promise<AnalyticsReport> => {
      builds++
      return buildReport('overall', [])
    }
    assert.equal(await readAutoWarmSchedule(dir), null)
    const first = await freshAutoWarmSchedule(overview, 1000, dir, 10_000)
    assert.equal(builds, 1)
    assert.deepEqual(await readAutoWarmSchedule(dir), first)
    await freshAutoWarmSchedule(overview, 1000, dir, 10_500)
    assert.equal(builds, 1)
    const second = await freshAutoWarmSchedule(overview, 1000, dir, 11_500)
    assert.equal(builds, 2)
    assert.equal(second.builtAt, 11_500)
  })
})

test('ignores a file that is not a schedule', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, AUTO_SCHEDULE_FILE), JSON.stringify({ version: 1, models: { a: [1] } }))
    assert.equal(await readAutoWarmSchedule(dir), null)
  })
})
