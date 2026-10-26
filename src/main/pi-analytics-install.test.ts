import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { piAnalyticsInstalled } from './pi-analytics-install'

test('finds pi-analytics among the packages installed in Pi', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-analytics-install-'))
  try {
    const path = join(dir, 'settings.json')
    assert.equal(piAnalyticsInstalled(path), false)
    await writeFile(path, JSON.stringify({ packages: ['npm:pi-retro', { source: 'git:github.com/someone/other' }] }))
    assert.equal(piAnalyticsInstalled(path), false)
    await writeFile(path, JSON.stringify({ packages: ['npm:pi-analytics@0.1.0'] }))
    assert.equal(piAnalyticsInstalled(path), true)
    await writeFile(path, JSON.stringify({ packages: [{ source: '/home/me/pi-desktop/packages/pi-analytics' }] }))
    assert.equal(piAnalyticsInstalled(path), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
