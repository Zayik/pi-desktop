import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyRecommendations, reset, undo } from './apply'
import { readPlan } from './plan-file'
import { planPath } from './paths'
import type { CacheRecommendation } from './recommendations'

const rec: CacheRecommendation = {
  model: 'anthropic/claude-haiku-5-5', setting: { mode: 'keep-warm', idlePings: 3 }, policy: '5m', idleMinutes: 17,
  currentCost: 10, cost: 6, saving: 4, weeklySaving: 20, beyondPi: null,
}

function setup(settings: string): { dir: string; settingsPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'pi-analytics-'))
  const settingsPath = join(root, 'settings.json')
  writeFileSync(settingsPath, settings)
  return { dir: join(root, 'pi-analytics'), settingsPath }
}

test('applying turns on idle warming only with consent, and undo puts the old value back', async () => {
  const paths = setup('{"defaultModel":"m","cacheWarming":"streaming"}')
  const declined = await applyRecommendations([rec], { ...paths, allowIdleWarming: () => false, now: 1 })
  assert.equal(declined.idleWarmingOff, true)
  assert.equal(JSON.parse(readFileSync(paths.settingsPath, 'utf8')).cacheWarming, 'streaming')
  const accepted = await applyRecommendations([rec], { ...paths, allowIdleWarming: () => true, now: 2 })
  assert.equal(accepted.enabledIdleWarming, true)
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsPath, 'utf8')), { defaultModel: 'm', cacheWarming: 'idle' })
  assert.equal(readPlan(planPath(paths.dir)).models[rec.model].idlePings, 3)
  assert.equal(undo({ ...paths, now: 3 })?.restoredCacheWarming, 'streaming')
  assert.equal(JSON.parse(readFileSync(paths.settingsPath, 'utf8')).cacheWarming, 'streaming')
  reset({ ...paths, now: 4 })
  assert.deepEqual(readPlan(planPath(paths.dir)).models, {})
})

test('a settings file that does not parse is left alone', async () => {
  const paths = setup('{ not json')
  const result = await applyRecommendations([rec], { ...paths, allowIdleWarming: () => true })
  assert.equal(result.enabledIdleWarming, false)
  assert.equal(readFileSync(paths.settingsPath, 'utf8'), '{ not json')
})
