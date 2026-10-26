import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_IDLE_WARMS } from '../../../resources/context-snapshot'
import { effectiveMode, idleLimit } from './cache-mode'

const SONNET = 'anthropic/claude-sonnet-5-5'

test('a session pick outranks the start mode; with neither Pi is left alone', () => {
  assert.equal(effectiveMode({ session: { mode: 'long', changedAt: 3 }, start: 'auto' })?.source, 'session')
  assert.equal(effectiveMode({ session: null, start: 'auto' })?.source, 'start')
  assert.equal(effectiveMode({ session: null, start: null }), null)
})

test('the idle limit is keep-warm\'s count or the hour\'s count in the schedule', () => {
  const at = new Date(2026, 9, 25, 14, 30).getTime()
  assert.equal(idleLimit({ mode: 'keep-warm', source: 'session', changedAt: 1 }, null, SONNET, at), MAX_IDLE_WARMS)
  const schedule = { version: 1 as const, builtAt: 0, days: 30, models: { [SONNET]: Array.from({ length: 24 }, (_, hour) => (hour === 14 ? 2 : 5)) }, fallback: null }
  assert.equal(idleLimit({ mode: 'auto', source: 'session', changedAt: 1 }, schedule, SONNET, at), 2)
  assert.equal(idleLimit({ mode: 'focus', source: 'session', changedAt: 1 }, null, SONNET, at), null)
})
