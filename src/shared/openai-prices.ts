/**
 * OpenAI's list prices, for transcripts that record tokens but no cost
 * (Codex, and GPT models through Copilot, which bills them at the same
 * rates). Checked 2026-10-26 against developers.openai.com/api/docs/pricing
 * and GitHub's Copilot models-and-pricing page; models those pages no longer
 * list keep the prices OpenAI published when they were current.
 */

export interface OpenAIPrice {
  /** Dollars per million uncached input tokens. */
  input: number
  output: number
  /** Cache read price as a multiple of `input`. */
  readRatio: number
  /** Prompts over `over` tokens cost these instead. */
  longPrompt?: { over: number; input: number; output: number }
}

/** GPT-5.6 and later bill cache writes, at this multiple of input for the 30-minute lifetime. */
export const OPENAI_WRITE_30M = 1.25
/** The 12-hour lifetime's writes cost this multiple of input. */
export const OPENAI_WRITE_12H = 2.5

const LONG_272K = 272_000

// Most specific first: the first pattern that matches a model id wins.
const PRICES: Array<[RegExp, OpenAIPrice]> = [
  [/gpt-6[-.]1[-.]sol/, { input: 2, output: 10, readRatio: 0.05, longPrompt: { over: LONG_272K, input: 4, output: 15 } }],
  [/gpt-6[-.]?\d*[-.]astra/, { input: 10, output: 50, readRatio: 0.1, longPrompt: { over: LONG_272K, input: 20, output: 75 } }],
  [/gpt-6[-.]?\d*[-.]luna/, { input: 0.1, output: 0.5, readRatio: 0.1, longPrompt: { over: LONG_272K, input: 0.2, output: 0.75 } }],
  [/gpt-5[-.]6[-.]cyber/, { input: 12.5, output: 75, readRatio: 0.1 }],
  [/gpt-5[-.]6[-.]sol/, { input: 4, output: 20, readRatio: 0.1, longPrompt: { over: LONG_272K, input: 8, output: 30 } }],
  [/gpt-5[-.]6[-.]terra/, { input: 2, output: 12, readRatio: 0.1, longPrompt: { over: LONG_272K, input: 4, output: 18 } }],
  [/gpt-5[-.]6[-.]luna/, { input: 0.2, output: 1.2, readRatio: 0.1, longPrompt: { over: 200_000, input: 0.4, output: 1.8 } }],
  [/gpt-5[-.]5/, { input: 5, output: 30, readRatio: 0.1, longPrompt: { over: LONG_272K, input: 10, output: 45 } }],
  [/gpt-5[-.]4[-.]nano/, { input: 0.2, output: 1.25, readRatio: 0.1 }],
  [/gpt-5[-.]4[-.]mini/, { input: 0.75, output: 4.5, readRatio: 0.1 }],
  [/gpt-5[-.]4/, { input: 2.5, output: 15, readRatio: 0.1, longPrompt: { over: LONG_272K, input: 5, output: 22.5 } }],
  [/gpt-5[-.][23]/, { input: 1.75, output: 14, readRatio: 0.1 }],
  [/gpt-5[-.]?\d*[-.]mini/, { input: 0.25, output: 2, readRatio: 0.1 }],
  [/gpt-5[-.]?\d*[-.]nano/, { input: 0.05, output: 0.4, readRatio: 0.1 }],
  [/gpt-5/, { input: 1.25, output: 10, readRatio: 0.1 }],
  [/gpt-4[-.]1[-.]mini/, { input: 0.4, output: 1.6, readRatio: 0.25 }],
  [/gpt-4[-.]1/, { input: 2, output: 8, readRatio: 0.25 }],
  [/gpt-4o[-.]mini/, { input: 0.15, output: 0.6, readRatio: 0.5 }],
  [/gpt-4o/, { input: 2.5, output: 10, readRatio: 0.5 }],
  [/(^|[/-])o4[-.]mini/, { input: 1.1, output: 4.4, readRatio: 0.25 }],
  [/(^|[/-])o3/, { input: 2, output: 8, readRatio: 0.25 }],
]

/** The list price of an OpenAI model id (`gpt-5.3-codex`, `gpt-6-luna`, ...), or null when unknown. */
export function openAIPrice(model: string): OpenAIPrice | null {
  const id = model.toLowerCase()
  return PRICES.find(([pattern]) => pattern.test(id))?.[1] ?? null
}

/** GPT-5.6 and later bill cache writes and take a lifetime; earlier models cache automatically and free of charge. */
export function openAIBillsCacheWrites(model: string): boolean {
  const id = model.toLowerCase()
  return /gpt-(5\.([6-9]|\d{2,})|[6-9]|\d{2,})/.test(id) || /gpt-5-([6-9]|\d{2,})/.test(id) || id.includes('daybreak')
}
