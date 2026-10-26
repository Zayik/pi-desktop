import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_IDLE_WARMS } from '../../../resources/context-snapshot'
import { effectiveMode, idleLimit } from './cache-mode'

test('a session pick outranks the start mode; with neither Pi is left alone', () => {
  assert.equal(effectiveMode({ session: { mode: 'long', changedAt: 3 }, start: 'focus' })?.source, 'session')
  assert.equal(effectiveMode({ session: null, start: 'focus' })?.source, 'start')
  assert.equal(effectiveMode({ session: null, start: null }), null)
})

test('only keep-warm refreshes while idle', () => {
  assert.equal(idleLimit({ mode: 'keep-warm', source: 'session', changedAt: 1 }), MAX_IDLE_WARMS)
  assert.equal(idleLimit({ mode: 'focus', source: 'session', changedAt: 1 }), null)
  assert.equal(idleLimit({ mode: 'long', source: 'session', changedAt: 1 }), null)
})
