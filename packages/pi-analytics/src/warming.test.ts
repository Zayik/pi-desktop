import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { changePlan, emptyPlan } from './cache-plan'
import { writeJsonAtomic } from './plan-file'
import { planPath, sessionModePath } from './paths'
import { CacheWarming } from './warming'

const HAIKU = { provider: 'github-copilot', id: 'claude-haiku-5.5' }

function setup(): { dir: string; env: NodeJS.ProcessEnv; clock: { now: number } } {
  const dir = mkdtempSync(join(tmpdir(), 'pi-analytics-warming-'))
  return { dir, env: { PI_CACHE_RETENTION: 'short' }, clock: { now: 1_000 } }
}

test('with no pick and no plan entry Pi is left alone', () => {
  const { dir, env } = setup()
  const warming = new CacheWarming({ dir, env })
  const model = { ...HAIKU }
  warming.startSession('s1', model, null)
  assert.equal(warming.decide(0.4, 'warm'), null)
  assert.equal(env.PI_CACHE_RETENTION, 'short')
  assert.equal('promptCache' in model, false)
})

test('a plan entry refreshes up to its count after the agent stops, then stops', () => {
  const { dir, env, clock } = setup()
  writeJsonAtomic(planPath(dir), changePlan(emptyPlan(0), { 'github-copilot/claude-haiku-5.5': { mode: 'keep-warm', idlePings: 2, appliedAt: 1 } }, 'x', 1))
  const statuses: (number | null)[] = []
  const warming = new CacheWarming({ dir, env, now: () => clock.now, onStatus: (status) => statuses.push(status.idleLimit) })
  const model: Record<string, unknown> = { ...HAIKU }
  warming.startSession('s1', model as unknown as typeof HAIKU, null)
  // The vendor's lifetime goes into the model object Pi's warmer reads.
  assert.deepEqual(model.promptCache, { short: 300, long: 3600 })
  warming.realRequest()
  assert.equal(warming.decide(1, 'warm'), null)
  assert.equal(warming.decide(0.3, 'stop'), 'warm')
  assert.equal(warming.decide(0.3, 'stop'), 'warm')
  assert.equal(warming.decide(0.3, 'warm'), 'stop')
  assert.equal(warming.current()?.idleWarms, 2)
  warming.realRequest()
  assert.equal(warming.decide(0.3, 'stop'), 'warm')
  assert.equal(statuses.at(-1), 2)
})

test('a session pick outranks the plan, and the start retention comes back when nothing applies', () => {
  const { dir, env } = setup()
  env.PI_CACHE_RETENTION = undefined
  writeJsonAtomic(planPath(dir), changePlan(emptyPlan(0), { 'github-copilot/claude-haiku-5.5': { mode: 'keep-warm', idlePings: 2, appliedAt: 1 } }, 'x', 1))
  const warming = new CacheWarming({ dir, env })
  warming.startSession('s1', { ...HAIKU }, null)
  const modeFile = sessionModePath('s1', dir)
  mkdirSync(dirname(modeFile), { recursive: true })
  writeFileSync(modeFile, JSON.stringify({ mode: 'long', changedAt: 5 }))
  assert.equal(warming.apply()?.source, 'session')
  assert.equal(env.PI_CACHE_RETENTION, 'long')
  assert.equal(warming.decide(0.3, 'warm'), 'stop')
  warming.setModel({ provider: 'openai', id: 'gpt-5.4' })
  assert.equal(warming.current()?.cacheMode, 'long')
  writeJsonAtomic(planPath(dir), emptyPlan(2))
  writeFileSync(modeFile, '{}')
  assert.equal(warming.apply(), null)
  assert.equal(env.PI_CACHE_RETENTION, undefined)
})
