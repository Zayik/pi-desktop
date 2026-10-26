import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { awayPath, cacheSettingsPath, clearAway, markAway, readCacheSettings, updateCacheSettings } from './cache-settings'
import { IdleWarming, fillCacheLifetime } from './warming'

const IDLE = 0.15

function setup(subagent = false, env: NodeJS.ProcessEnv = {}): { dir: string; warming: IdleWarming; clock: { now: number }; env: NodeJS.ProcessEnv; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pi-analytics-warming-'))
  const clock = { now: 1_000 }
  const warming = new IdleWarming({ dir, env, subagent, now: () => clock.now })
  return { dir, warming, clock, env, done: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Settings written within the same millisecond keep their mtime; bump it so the watcher reads them. */
function touch(path: string, at: number): void {
  utimesSync(path, at / 1000, at / 1000)
}

test('a model with no setting is left to Pi', () => {
  const { warming, done } = setup()
  warming.setModel({ provider: 'anthropic', id: 'claude-haiku-5-5' })
  warming.userMessage()
  warming.realRequest()
  assert.equal(warming.decide(IDLE), null)
  done()
})

test('sends exactly the set number of idle pings, again after each message', () => {
  const { dir, warming, done } = setup()
  updateCacheSettings({ 'anthropic/claude-haiku-5-5': 2 }, dir)
  warming.setModel({ provider: 'anthropic', id: 'claude-haiku-5-5' })
  warming.userMessage()
  warming.realRequest()
  assert.equal(warming.decide(1), null, 'while the agent works Pi decides')
  assert.deepEqual([warming.decide(IDLE), warming.decide(IDLE), warming.decide(IDLE)], ['warm', 'warm', 'stop'])
  warming.realRequest()
  assert.equal(warming.decide(IDLE), 'warm')
  done()
})

test('no pings and long stop idle warming; long asks for the long retention', () => {
  const env: NodeJS.ProcessEnv = {}
  const { dir, warming, done } = setup(false, env)
  updateCacheSettings({ 'anthropic/claude-sonnet-5-5': 0, 'anthropic/claude-opus-5-5': 'long' }, dir)
  warming.setModel({ provider: 'anthropic', id: 'claude-sonnet-5-5' })
  warming.realRequest()
  assert.equal(warming.decide(IDLE), 'stop')
  assert.equal(env.PI_CACHE_RETENTION, undefined)
  warming.setModel({ provider: 'anthropic', id: 'claude-opus-5-5' })
  assert.equal(env.PI_CACHE_RETENTION, 'long')
  assert.equal(warming.decide(IDLE), 'stop')
  warming.setModel({ provider: 'anthropic', id: 'claude-sonnet-5-5' })
  assert.equal(env.PI_CACHE_RETENTION, undefined, 'the start retention is put back')
  done()
})

test('a subagent keeps Pi\'s warming whatever the settings say', () => {
  const env: NodeJS.ProcessEnv = {}
  const { dir, warming, done } = setup(true, env)
  updateCacheSettings({ 'anthropic/claude-opus-5-5': 'long' }, dir)
  warming.setModel({ provider: 'anthropic', id: 'claude-opus-5-5' })
  warming.realRequest()
  assert.equal(warming.decide(IDLE), null)
  assert.equal(env.PI_CACHE_RETENTION, undefined)
  done()
})

test('/away stops chats whose last message is older; the next message resumes that chat', () => {
  const { dir, warming, clock, done } = setup()
  updateCacheSettings({ 'anthropic/claude-haiku-5-5': 6 }, dir)
  warming.setModel({ provider: 'anthropic', id: 'claude-haiku-5-5' })
  warming.userMessage()
  warming.realRequest()
  clock.now = 2_000
  markAway(clock.now, dir)
  touch(awayPath(dir), clock.now)
  assert.equal(warming.decide(IDLE), 'stop')
  clock.now = 3_000
  warming.userMessage()
  warming.realRequest()
  assert.equal(warming.decide(IDLE), 'warm', 'nothing to undo: a new message is newer than the away time')
  clearAway(dir)
  done()
})

test('/done holds for this chat until the next message', () => {
  const { dir, warming, done } = setup()
  updateCacheSettings({ 'anthropic/claude-haiku-5-5': 6 }, dir)
  warming.setModel({ provider: 'anthropic', id: 'claude-haiku-5-5' })
  warming.userMessage()
  warming.realRequest()
  warming.markDone()
  assert.equal(warming.decide(IDLE), 'stop')
  warming.userMessage()
  warming.realRequest()
  assert.equal(warming.decide(IDLE), 'warm')
  done()
})

test('settings changes are picked up without a restart', () => {
  const { dir, warming, done } = setup()
  updateCacheSettings({ 'anthropic/claude-haiku-5-5': 1 }, dir)
  touch(cacheSettingsPath(dir), 10_000)
  warming.setModel({ provider: 'anthropic', id: 'claude-haiku-5-5' })
  warming.realRequest()
  assert.equal(warming.decide(IDLE), 'warm')
  updateCacheSettings({ 'anthropic/claude-haiku-5-5': null }, dir)
  touch(cacheSettingsPath(dir), 20_000)
  assert.equal(warming.decide(IDLE), null)
  assert.deepEqual(readCacheSettings(dir).models, {})
  done()
})

test('fills Copilot lifetimes so Pi warms them, keeping set ones', () => {
  const luna: Record<string, unknown> = { provider: 'github-copilot', id: 'gpt-6-luna' }
  assert.equal(fillCacheLifetime(luna), true)
  assert.deepEqual(luna.promptCache, { short: 1800, long: 1800 })
  const claude: Record<string, unknown> = { provider: 'github-copilot', id: 'claude-sonnet-5-5', promptCache: { short: 600 } }
  fillCacheLifetime(claude)
  assert.deepEqual(claude.promptCache, { short: 600, long: 3600 })
  assert.equal(fillCacheLifetime({ provider: 'google', id: 'gemini-4' }), false)
})

test('a setting with a bad value is refused', () => {
  const { dir, done } = setup()
  assert.throws(() => updateCacheSettings({ 'anthropic/claude-haiku-5-5': 99 }, dir))
  assert.throws(() => updateCacheSettings({ haiku: 1 }, dir))
  done()
})
