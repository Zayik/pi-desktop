import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatPerMillion, longPromptTier, priceSheet } from './list-prices'

test('a price sheet gives each write lifetime and the long-prompt band', () => {
  const haiku = priceSheet('anthropic/claude-haiku-5-5')
  assert.deepEqual(haiku?.lifetimes, ['5m', '1h'])
  assert.equal(haiku?.base.input, 0.1)
  assert.ok(Math.abs((haiku?.base.writeShort ?? 0) - 0.125) < 1e-12)
  assert.ok(Math.abs((haiku?.base.writeLong ?? 0) - 0.2) < 1e-12)
  assert.equal(haiku?.longPrompt?.over, 100_000)
  assert.ok(Math.abs((haiku?.longPrompt?.cacheRead ?? 0) - 0.05) < 1e-12)
  assert.equal(priceSheet('github-copilot/claude-opus-5.5')?.longPrompt, null)
  assert.ok(Math.abs((priceSheet('claude-code/claude-sonnet-5-5')?.base.cacheRead ?? 0) - 0.1) < 1e-12)
  const terra = priceSheet('openai/gpt-5.6-terra')
  assert.deepEqual(terra?.lifetimes, ['30m', '12h'])
  assert.equal(terra?.base.writeLong, 5)
  assert.equal(priceSheet('openai/gpt-4.1')?.base.writeShort, null)
  assert.equal(priceSheet('google/gemini-4-argon'), null)
})

test('the long-prompt tier is the input multiple past the threshold', () => {
  assert.deepEqual(longPromptTier('anthropic/claude-haiku-5-5'), { over: 100_000, multiple: 5 })
  assert.deepEqual(longPromptTier('openai/gpt-6-luna'), { over: 272_000, multiple: 2 })
  assert.equal(longPromptTier('anthropic/claude-fable-5-1'), null)
})

test('prices per million show cents, and more digits only when needed', () => {
  assert.equal(formatPerMillion(0.1), '$0.10')
  assert.equal(formatPerMillion(0.125), '$0.125')
  assert.equal(formatPerMillion(0.0125), '$0.0125')
  assert.equal(formatPerMillion(20), '$20.00')
  assert.equal(formatPerMillion(null), '-')
})
