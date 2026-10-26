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
