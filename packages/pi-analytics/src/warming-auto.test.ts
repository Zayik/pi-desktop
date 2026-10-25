import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { MAX_IDLE_WARMS, emptyAutoWarmSchedule } from '../../../resources/context-snapshot'
import { AUTO_SCHEDULE_FILE, sessionModePath } from './paths'
import { CacheWarming } from './warming'

const SONNET = { provider: 'github-copilot', id: 'claude-sonnet-5-5' }

function setup(start: string): { dir: string; env: NodeJS.ProcessEnv } {
  return { dir: mkdtempSync(join(tmpdir(), 'pi-analytics-auto-')), env: { PI_DESKTOP_CACHE_MODE: start } }
}

test('auto refreshes as often as the schedule gives the hour the break starts in', () => {
  const { dir, env } = setup('auto')
  const warming = new CacheWarming({ dir, env })
  warming.startSession('s1', { ...SONNET }, null)
  // Without a schedule yet, auto refreshes like keep warm.
  warming.realRequest()
  const answers = Array.from({ length: MAX_IDLE_WARMS + 1 }, () => warming.decide(0.15, 'stop'))
  assert.equal(answers.filter((answer) => answer === 'warm').length, MAX_IDLE_WARMS)
  assert.equal(answers.at(-1), 'stop')

  const schedule = emptyAutoWarmSchedule(Date.now(), 30)
  schedule.models[`${SONNET.provider}/${SONNET.id}`] = Array.from({ length: 24 }, (_, hour) => (hour === new Date().getHours() ? 1 : 5))
  writeFileSync(join(dir, AUTO_SCHEDULE_FILE), JSON.stringify(schedule))
  warming.realRequest()
  assert.deepEqual([warming.decide(0.15, 'stop'), warming.decide(0.15, 'stop')], ['warm', 'stop'])
  assert.equal(warming.current()?.idleLimit, 1)
})

test('a manual pick overrides auto', () => {
  const { dir, env } = setup('auto')
  const warming = new CacheWarming({ dir, env })
  warming.startSession('s1', { ...SONNET }, null)
  const modeFile = sessionModePath('s1', dir)
  mkdirSync(dirname(modeFile), { recursive: true })
  writeFileSync(modeFile, JSON.stringify({ mode: 'focus', changedAt: 1234 }))
  assert.equal(warming.decide(0.15, 'warm'), 'stop')
  assert.equal(warming.current()?.cacheMode, 'focus')
  assert.equal(warming.current()?.cacheModeChangedAt, 1234)
})

test('fills the vendor\'s cache lifetime into a Copilot model so Pi warms it', () => {
  const { dir, env } = setup('auto')
  const model: Record<string, unknown> = { ...SONNET }
  new CacheWarming({ dir, env }).startSession('s1', model as unknown as typeof SONNET, null)
  assert.deepEqual(model.promptCache, { short: 300, long: 3600 })
})
