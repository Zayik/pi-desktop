import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyRecommendations, reset, setCacheControl, setKeepWarmPings, undo } from './apply'
import { effectiveMode } from './cache-plan'
import { readPlan } from './plan-file'
import { planPath } from './paths'
import type { CacheRecommendation } from './recommendations'

const rec: CacheRecommendation = {
  model: 'anthropic/claude-haiku-5-5', setting: { mode: 'keep-warm', idlePings: 3 }, policy: '5m', idleMinutes: 17,
  currentCost: 10, cost: 6, saving: 4, weeklySaving: 20, beyondPi: null, breaks: 40, alternative: null,
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

test('a count set by hand is capped by the model\'s cache lifetime', async () => {
  const paths = setup('{"cacheWarming":"idle"}')
  await setKeepWarmPings('anthropic/claude-haiku-5-5', 6, { ...paths, now: 1 })
  assert.deepEqual(readPlan(planPath(paths.dir)).models['anthropic/claude-haiku-5-5'], { mode: 'keep-warm', idlePings: 6, appliedAt: 1 })
  await assert.rejects(setKeepWarmPings('anthropic/claude-haiku-5-5', 7, paths), /0 to 6/)
  await setKeepWarmPings('github-copilot/gpt-6-luna', 1, { ...paths, now: 2 })
  await assert.rejects(setKeepWarmPings('github-copilot/gpt-6-luna', 2, paths), /0 to 1/)
  await assert.rejects(setKeepWarmPings('google/gemini-3-pro', 1, paths), /no cache lifetime/)
  assert.equal(undo({ ...paths, now: 3 })?.restoredCacheWarming, null)
  assert.equal(readPlan(planPath(paths.dir)).models['github-copilot/gpt-6-luna'], undefined)
})

test('turning cache control off leaves Pi alone but keeps the plan, and undo or reset turns it back on', async () => {
  const paths = setup('{"cacheWarming":"idle"}')
  await setKeepWarmPings('anthropic/claude-haiku-5-5', 4, { ...paths, now: 1 })
  setCacheControl(false, { dir: paths.dir, now: 2 })
  let plan = readPlan(planPath(paths.dir))
  assert.equal(plan.off, true)
  assert.equal(plan.models['anthropic/claude-haiku-5-5'].idlePings, 4)
  assert.equal(effectiveMode({ session: { mode: 'long', changedAt: 1 }, plan, model: 'anthropic/claude-haiku-5-5', start: 'keep-warm' }), null)
  undo({ ...paths, now: 3 })
  assert.equal(readPlan(planPath(paths.dir)).off, undefined)
  setCacheControl(false, { dir: paths.dir, now: 4 })
  reset({ ...paths, now: 5 })
  plan = readPlan(planPath(paths.dir))
  assert.equal(plan.off, undefined)
  assert.deepEqual(plan.models, {})
})
