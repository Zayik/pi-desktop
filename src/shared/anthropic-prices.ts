/**
 * Anthropic's list prices, for transcripts that record tokens but no cost
 * (Claude Code). Pi's own sessions carry the cost Pi worked out, so this is
 * only used for imports. Checked 2026-10-26 against the Claude API pricing
 * table; Bedrock and Vertex price differently and are not covered.
 */

export interface AnthropicPrice {
  /** Dollars per million uncached input tokens. */
  input: number
  output: number
  /** Cache read price as a multiple of `input`. */
  readRatio: number
  /** Haiku 5.5 charges more for prompts over 100K tokens. */
  longPrompt?: { over: number; input: number; output: number }
}

/** Cache writes as a multiple of the input price. */
export const ANTHROPIC_WRITE_5M = 1.25
export const ANTHROPIC_WRITE_1H = 2
/** Fast mode doubles the price of every token. */
const FAST_MULTIPLE = 2

// Most specific first: the first pattern that matches a model id wins.
const PRICES: Array<[RegExp, AnthropicPrice]> = [
  [/(fable|mythos)-5[-.]1/, { input: 10, output: 50, readRatio: 0.025 }],
  [/(fable|mythos)-5/, { input: 10, output: 50, readRatio: 0.1 }],
  [/opus-5[-.]5/, { input: 4, output: 20, readRatio: 0.05 }],
  [/opus-5/, { input: 5, output: 25, readRatio: 0.1 }],
  [/opus-4[-.][5-9]/, { input: 5, output: 25, readRatio: 0.1 }],
  [/opus-4|3-opus/, { input: 15, output: 75, readRatio: 0.1 }],
  [/sonnet-5[-.]5/, { input: 2, output: 10, readRatio: 0.05 }],
  [/sonnet-5/, { input: 2, output: 10, readRatio: 0.1 }],
  [/sonnet-4|3-[57]-sonnet/, { input: 3, output: 15, readRatio: 0.1 }],
  [/haiku-5[-.]5/, { input: 0.1, output: 0.5, readRatio: 0.1, longPrompt: { over: 100_000, input: 0.5, output: 2.5 } }],
  [/haiku-4[-.]5/, { input: 1, output: 5, readRatio: 0.1 }],
  [/3-5-haiku/, { input: 0.8, output: 4, readRatio: 0.1 }],
  [/3-haiku/, { input: 0.25, output: 1.25, readRatio: 0.1 }],
]

/** The list price of a Claude model id (`claude-opus-5-5`, `claude-3-7-sonnet-20250219`, ...), or null when unknown. */
export function anthropicPrice(model: string): AnthropicPrice | null {
  const id = model.toLowerCase()
  if (!id.includes('claude') && !/(opus|sonnet|haiku|fable|mythos)-/.test(id)) return null
  return PRICES.find(([pattern]) => pattern.test(id))?.[1] ?? null
}

export interface AnthropicUsage {
  input: number
  output: number
  cacheRead: number
  /** All cache writes; `cacheWrite1h` is the one-hour part of them. */
  cacheWrite: number
  cacheWrite1h: number
  fast?: boolean
}

export interface AnthropicCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

/** What a call cost at list price, or null for a model without a known price. */
export function anthropicCost(model: string, usage: AnthropicUsage): AnthropicCost | null {
  const price = anthropicPrice(model)
  if (!price) return null
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite
  const long = price.longPrompt && prompt > price.longPrompt.over ? price.longPrompt : null
  const multiple = usage.fast ? FAST_MULTIPLE : 1
  const input = ((long?.input ?? price.input) * multiple) / 1_000_000
  const output = ((long?.output ?? price.output) * multiple) / 1_000_000
  const oneHour = Math.min(usage.cacheWrite1h, usage.cacheWrite)
  const cost = {
    input: usage.input * input,
    output: usage.output * output,
    cacheRead: usage.cacheRead * input * price.readRatio,
    cacheWrite: (usage.cacheWrite - oneHour) * input * ANTHROPIC_WRITE_5M + oneHour * input * ANTHROPIC_WRITE_1H,
  }
  return { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite }
}
