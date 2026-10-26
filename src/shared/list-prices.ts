/**
 * What a call cost at the vendor's list prices, for sessions imported from
 * tools that log tokens but no cost. Claude models use Anthropic's table,
 * GPT models OpenAI's; Copilot bills both at the same rates.
 */
import { ANTHROPIC_WRITE_1H, ANTHROPIC_WRITE_5M, anthropicCost, anthropicPrice, type AnthropicCost, type AnthropicUsage } from './anthropic-prices'
import { OPENAI_WRITE_12H, OPENAI_WRITE_30M, openAIBillsCacheWrites, openAIPrice } from './openai-prices'

export type CallUsage = AnthropicUsage
export type CallCost = AnthropicCost

/** The cost of one call, or null for a model neither table knows. */
export function listCost(model: string, usage: CallUsage): CallCost | null {
  if (anthropicPrice(model)) return anthropicCost(model, usage)
  const price = openAIPrice(model)
  if (!price) return null
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite
  const long = price.longPrompt && prompt > price.longPrompt.over ? price.longPrompt : null
  const input = (long?.input ?? price.input) / 1_000_000
  const output = (long?.output ?? price.output) / 1_000_000
  const cost = {
    input: usage.input * input,
    output: usage.output * output,
    cacheRead: usage.cacheRead * input * price.readRatio,
    cacheWrite: usage.cacheWrite * input * (openAIBillsCacheWrites(model) ? OPENAI_WRITE_30M : 1),
  }
  return { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite }
}

/** Prompts over `over` tokens are billed at `multiple` times the base rates (every token of the call, read and write too). */
export interface LongPromptTier {
  over: number
  multiple: number
}

/**
 * The long-prompt tier of a model (`provider/model`, an imported
 * `claude-code/<model>`, or a bare id), or null when it has a flat price.
 * Claude Opus, Sonnet and Fable bill their whole 1M context at one price;
 * Haiku 5.5 and GPT-5.4 and later cost more past a prompt size.
 */
export function longPromptTier(model: string): LongPromptTier | null {
  const id = model.slice(model.lastIndexOf('/') + 1)
  const price = anthropicPrice(id) ?? openAIPrice(id)
  if (!price?.longPrompt) return null
  return { over: price.longPrompt.over, multiple: price.longPrompt.input / price.input }
}

/** How many times the base rates a prompt of `tokens` is billed at. */
export function tierMultiple(tier: LongPromptTier | null | undefined, tokens: number): number {
  return tier && tokens > tier.over ? tier.multiple : 1
}

/** Dollars per million tokens for one band of prompt sizes. Writes are null where the cache is automatic and free. */
export interface PriceBand {
  input: number
  output: number
  cacheRead: number
  writeShort: number | null
  writeLong: number | null
}

/** A model's list prices: its cache lifetimes, the normal band, and the band past its long-prompt threshold. */
export interface PriceSheet {
  vendor: 'anthropic' | 'openai'
  /** The two lifetimes the writes are for (5m and 1h, or 30m and 12h), or null for an automatic cache. */
  lifetimes: [short: string, long: string] | null
  base: PriceBand
  longPrompt: (PriceBand & { over: number }) | null
}

/** List prices of a model (`provider/model`, an imported `<tool>/<model>`, or a bare id), or null when neither table knows it. */
export function priceSheet(model: string): PriceSheet | null {
  const id = model.slice(model.lastIndexOf('/') + 1)
  const claude = anthropicPrice(id)
  if (claude) {
    const band = (input: number, output: number): PriceBand => ({
      input, output, cacheRead: input * claude.readRatio, writeShort: input * ANTHROPIC_WRITE_5M, writeLong: input * ANTHROPIC_WRITE_1H,
    })
    const long = claude.longPrompt
    return { vendor: 'anthropic', lifetimes: ['5m', '1h'], base: band(claude.input, claude.output), longPrompt: long ? { over: long.over, ...band(long.input, long.output) } : null }
  }
  const gpt = openAIPrice(id)
  if (!gpt) return null
  const writes = openAIBillsCacheWrites(id)
  const band = (input: number, output: number): PriceBand => ({
    input, output, cacheRead: input * gpt.readRatio, writeShort: writes ? input * OPENAI_WRITE_30M : null, writeLong: writes ? input * OPENAI_WRITE_12H : null,
  })
  const long = gpt.longPrompt
  return { vendor: 'openai', lifetimes: writes ? ['30m', '12h'] : null, base: band(gpt.input, gpt.output), longPrompt: long ? { over: long.over, ...band(long.input, long.output) } : null }
}

/** A price per million tokens as dollars: at least cents, and the digits a sub-cent price needs (`$0.125`, `$0.0125`). */
export function formatPerMillion(price: number | null): string {
  if (price === null) return '-'
  const text = Number(price.toPrecision(3)).toString()
  const decimals = text.includes('.') ? text.split('.')[1].length : 0
  return `$${decimals >= 2 ? text : price.toFixed(2)}`
}
