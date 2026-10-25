import { test } from 'node:test'
import assert from 'node:assert/strict'
import { changePlan, effectiveMode, emptyPlan, idleLimit, isCachePlan, needsIdleWarming, resetPlan, undoPlan, type ModelCachePlan } from './cache-plan'

const SONNET = 'anthropic/claude-sonnet-5-5'
const keepWarm = (idlePings: number, appliedAt = 1): ModelCachePlan => ({ mode: 'keep-warm', idlePings, appliedAt })

test('a session pick outranks the model entry, which outranks the default and the start mode', () => {
  let plan = changePlan(emptyPlan(0), { [SONNET]: keepWarm(5), '*': { mode: 'focus', appliedAt: 2 } }, 'x', 10)
  assert.equal(effectiveMode({ session: { mode: 'long', changedAt: 3 }, plan, model: SONNET, start: 'auto' })?.source, 'session')
  assert.deepEqual(effectiveMode({ session: null, plan, model: SONNET, start: 'auto' })?.entry, keepWarm(5))
  assert.equal(effectiveMode({ session: null, plan, model: 'openai/gpt-5.4', start: 'auto' })?.source, 'plan-default')
  plan = changePlan(plan, { '*': null }, 'y', 11)
  assert.equal(effectiveMode({ session: null, plan, model: 'openai/gpt-5.4', start: 'auto' })?.source, 'start')
  assert.equal(effectiveMode({ session: null, plan, model: 'openai/gpt-5.4', start: null }), null)
})

test('the idle limit comes from the entry, the hour, or the schedule', () => {
  const at = new Date(2026, 9, 25, 14, 30).getTime()
  const hourly = Array.from({ length: 24 }, (_, hour) => (hour === 14 ? 6 : 1))
  assert.equal(idleLimit({ mode: 'keep-warm', source: 'plan-model', entry: keepWarm(5), changedAt: 1 }, null, SONNET, at), 5)
  assert.equal(idleLimit({ mode: 'keep-warm', source: 'session', entry: null, changedAt: 1 }, null, SONNET, at), 3)
  assert.equal(idleLimit({ mode: 'auto', source: 'plan-model', entry: { mode: 'auto', hourly, appliedAt: 1 }, changedAt: 1 }, null, SONNET, at), 6)
  const schedule = { version: 1 as const, builtAt: 0, days: 30, models: { [SONNET]: hourly.map(() => 2) }, fallback: null }
  assert.equal(idleLimit({ mode: 'auto', source: 'session', entry: null, changedAt: 1 }, schedule, SONNET, at), 2)
  assert.equal(idleLimit({ mode: 'focus', source: 'session', entry: null, changedAt: 1 }, null, SONNET, at), null)
})

test('undo steps back one change and reset goes back to before the first', () => {
  const first = changePlan(emptyPlan(0), { [SONNET]: keepWarm(5) }, 'first', 10, 'unset')
  const second = changePlan(first, { [SONNET]: { mode: 'long', appliedAt: 2 } }, 'second', 20)
  assert.ok(isCachePlan(second))
  const undone = undoPlan(second, 30)
  assert.equal(undone?.undone.summary, 'second')
  assert.deepEqual(undone?.plan.models[SONNET], keepWarm(5))
  assert.equal(undone?.plan.history.length, 1)
  const reset = resetPlan(second, 40)
  assert.deepEqual(reset.plan.models, {})
  assert.equal(reset.plan.history.length, 0)
  assert.equal(reset.cacheWarmingBefore, 'unset')
  assert.equal(undoPlan(reset.plan), null)
})

test('only entries that refresh after the agent stops need idle warming', () => {
  assert.equal(needsIdleWarming(keepWarm(2)), true)
  assert.equal(needsIdleWarming(keepWarm(0)), false)
  assert.equal(needsIdleWarming({ mode: 'long', appliedAt: 1 }), false)
  assert.equal(needsIdleWarming({ mode: 'auto', hourly: new Array(24).fill(0), appliedAt: 1 }), false)
})
