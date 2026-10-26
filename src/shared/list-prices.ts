/**
 * What a call cost at the vendor's list prices, for sessions imported from
 * tools that log tokens but no cost. Claude models use Anthropic's table,
 * GPT models OpenAI's; Copilot bills both at the same rates.
 */
import { anthropicCost, anthropicPrice, type AnthropicCost, type AnthropicUsage } from './anthropic-prices'
import { OPENAI_WRITE_30M, openAIBillsCacheWrites, openAIPrice } from './openai-prices'

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
