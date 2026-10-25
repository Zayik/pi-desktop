import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { enableIdleCacheWarming, enableModelCacheLifetime, readCacheMode, readPiCacheWarming, writeCacheMode } from './cache-modes'

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
    await writeFile(join(dir, 's_1.mode'), '{"mode":"forever","changedAt":1}')
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

test('gives a model a short cache lifetime and keeps the rest of the models file', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'models.json')
    await writeFile(path, JSON.stringify({ providers: { ollama: { baseUrl: 'http://x' }, 'github-copilot': { modelOverrides: { 'gpt-6': { name: 'G' } } } } }))
    await enableModelCacheLifetime('github-copilot', 'claude-sonnet-5-5', 300, path)
    await enableModelCacheLifetime('github-copilot', 'gpt-6', 1800, path)
    const config = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(config.providers.ollama, { baseUrl: 'http://x' })
    assert.deepEqual(config.providers['github-copilot'].modelOverrides, {
      'gpt-6': { name: 'G', promptCache: { short: 1800 } },
      'claude-sonnet-5-5': { promptCache: { short: 300 } },
    })
    // A lifetime already set stays.
    await enableModelCacheLifetime('github-copilot', 'gpt-6', 60, path)
    assert.equal(JSON.parse(await readFile(path, 'utf8')).providers['github-copilot'].modelOverrides['gpt-6'].promptCache.short, 1800)
    await writeFile(path, '{ not json')
    await assert.rejects(enableModelCacheLifetime('openai', 'gpt-6', 1800, path))
    assert.equal(await readFile(path, 'utf8'), '{ not json')
  })
})
