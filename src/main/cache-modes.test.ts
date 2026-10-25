import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { enableIdleCacheWarming, piAnalyticsInstalled, readCacheMode, readPiCacheWarming, writeCacheMode } from './cache-modes'

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'cache-modes-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('writes and reads back the mode picked for a session', async () => {
  await withDir(async (dir) => {
    assert.equal(await readCacheMode('s/1', dir), null)
    await writeCacheMode('s/1', 'keep-warm', dir, 42)
    assert.deepEqual(await readCacheMode('s/1', dir), { mode: 'keep-warm', changedAt: 42 })
    await writeFile(join(dir, 'sessions', 's_1.mode'), '{"mode":"forever","changedAt":1}')
    assert.equal(await readCacheMode('s/1', dir), null)
  })
})

test('turns on idle warming in Pi settings and keeps the other settings', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'agent', 'settings.json')
    assert.equal(await readPiCacheWarming(path), null)
    await enableIdleCacheWarming(path)
    assert.equal(await readPiCacheWarming(path), 'idle')
    await writeFile(path, JSON.stringify({ defaultModel: 'm', cacheWarming: 'streaming' }))
    await enableIdleCacheWarming(path)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { defaultModel: 'm', cacheWarming: 'idle' })
  })
})

test('leaves a settings file that does not parse alone', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'settings.json')
    await writeFile(path, '{ broken')
    await assert.rejects(enableIdleCacheWarming(path))
    assert.equal(await readFile(path, 'utf8'), '{ broken')
  })
})

test('finds pi-analytics among the packages installed in Pi', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'settings.json')
    assert.equal(piAnalyticsInstalled(path), false)
    await writeFile(path, JSON.stringify({ packages: ['npm:pi-retro', { source: 'git:github.com/someone/other' }] }))
    assert.equal(piAnalyticsInstalled(path), false)
    await writeFile(path, JSON.stringify({ packages: ['npm:pi-analytics@0.1.0'] }))
    assert.equal(piAnalyticsInstalled(path), true)
    await writeFile(path, JSON.stringify({ packages: [{ source: '/home/me/pi-desktop/packages/pi-analytics' }] }))
    assert.equal(piAnalyticsInstalled(path), true)
  })
})
