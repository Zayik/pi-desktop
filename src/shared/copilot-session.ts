/**
 * GitHub Copilot app and CLI sessions
 * (`~/.copilot/session-state/<session>/events.jsonl`) read as Pi sessions.
 *
 * Copilot writes each model call's time, model and output tokens, but its
 * per-call usage (`assistant.usage`) is ephemeral and never reaches the
 * file. Prompt tokens, cache reads and cache writes are only written as
 * totals per model when a run ends (`session.shutdown`). So the timing is
 * measured and each call's prompt is estimated:
 * - The conversation's size before each call is rebuilt from what the file
 *   holds (messages, tool calls, tool results; about four characters a
 *   token) on top of the system prompt and tools, which compactions and the
 *   shutdown report in tokens.
 * - Those sizes are scaled so the run's calls of each model add up to its
 *   real totals, and its reads and writes are shared out in proportion.
 *   Output tokens are measured per call when the file has them.
 * - A run with no shutdown yet (still open, or it crashed) has no totals:
 *   its calls keep the rebuilt sizes, read from the cache when the previous
 *   call was within the vendor's short lifetime.
 * Every call is marked estimated, so the measured cache charts leave it out.
 * Sub-agents run their own conversations; they are left out, and the main
 * agent's totals are used when the shutdown splits them.
 */
import { IMPORT_PROVIDERS } from './import-sources'
import { listCost } from './list-prices'
import { openAIBillsCacheWrites } from './openai-prices'
import { analyzeSession, type SessionAnalytics } from './session-analytics'

type UnknownRecord = Record<string, unknown>

const CHARS_PER_TOKEN = 4
const MINUTE = 60_000

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function time(event: UnknownRecord): number | null {
  const parsed = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function chars(value: unknown): number {
  if (value === undefined || value === null) return 0
  return typeof value === 'string' ? value.length : JSON.stringify(value).length
}

/** The session folder's name: `.../session-state/<session>/events.jsonl`. */
function sessionFolder(file: string): string {
  const parts = file.split(/[\\/]/)
  return parts.length >= 2 ? parts[parts.length - 2] : file
}

interface Call {
  entry: UnknownRecord
  message: UnknownRecord
  model: string
  at: number
  /** Estimated prompt tokens before scaling. */
  rawPrompt: number
  output: number
}

interface ModelTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface Run {
  calls: Call[]
  /** Per model, from the run's shutdown; null while the run has none. */
  totals: Map<string, ModelTotals> | null
}

/** A shutdown's per-model totals: the main agent's when it splits them by agent. */
function shutdownTotals(data: UnknownRecord): Map<string, ModelTotals> {
  const agents = isRecord(data.agentMetrics) ? data.agentMetrics : null
  const main = agents && isRecord(agents.main) && isRecord(agents.main.modelMetrics) ? agents.main.modelMetrics : null
  const metrics = main ?? (isRecord(data.modelMetrics) ? data.modelMetrics : {})
  const totals = new Map<string, ModelTotals>()
  for (const [model, metric] of Object.entries(metrics)) {
    if (!isRecord(metric) || !isRecord(metric.usage)) continue
    const usage = metric.usage
    totals.set(model, {
      input: num(usage.inputTokens),
      output: num(usage.outputTokens),
      cacheRead: num(usage.cacheReadTokens),
      cacheWrite: num(usage.cacheWriteTokens),
    })
  }
  return totals
}

/** The vendor's short lifetime, for runs with no totals to scale to. */
function shortLifetimeMs(model: string): number {
  return !model.toLowerCase().includes('claude') && openAIBillsCacheWrites(model) ? 30 * MINUTE : 5 * MINUTE
}

/** The system prompt and tools in tokens, from the first compaction or shutdown that reports them. */
function reportedBaseTokens(events: UnknownRecord[]): number {
  for (const event of events) {
    const data = isRecord(event.data) ? event.data : {}
    if (event.type === 'session.compaction_complete' && num(data.systemTokens) > 0) return num(data.systemTokens) + num(data.toolDefinitionsTokens)
    if (event.type === 'session.shutdown' && num(data.systemTokens) > 0) return num(data.systemTokens)
  }
  return 0
}

function setUsage(call: Call, usage: { input: number; output: number; cacheRead: number; cacheWrite: number }): void {
  const cost = listCost(call.model, { ...usage, cacheWrite1h: 0 }) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  call.message.usage = { ...usage, cacheWrite1h: 0, cost, estimated: true }
}

/** Share a run's real totals out over its calls, in proportion to their rebuilt prompt sizes. */
function fillRun(run: Run): void {
  const byModel = new Map<string, Call[]>()
  for (const call of run.calls) byModel.set(call.model, [...(byModel.get(call.model) ?? []), call])
  for (const [model, calls] of byModel) {
    const totals = run.totals?.get(model)
    if (totals) {
      // Copilot reports input the OpenAI way, cached tokens included, unless that cannot be.
      const inclusive = totals.input >= totals.cacheRead + totals.cacheWrite
      const prompt = inclusive ? totals.input : totals.input + totals.cacheRead + totals.cacheWrite
      const raw = calls.reduce((sum, call) => sum + call.rawPrompt, 0)
      const measuredOutput = calls.reduce((sum, call) => sum + call.output, 0)
      for (const call of calls) {
        const share = raw > 0 ? call.rawPrompt / raw : 1 / calls.length
        const tokens = prompt * share
        const cacheRead = prompt > 0 ? tokens * (totals.cacheRead / prompt) : 0
        const cacheWrite = prompt > 0 ? tokens * (totals.cacheWrite / prompt) : 0
        const output = measuredOutput > 0 ? call.output : totals.output / calls.length
        setUsage(call, { input: tokens - cacheRead - cacheWrite, output, cacheRead, cacheWrite })
      }
      continue
    }
    // No totals: the previous call's prompt is read back while the cache is warm, the rest written.
    let previous: Call | null = null
    for (const call of calls) {
      const warm = previous !== null && call.at - previous.at <= shortLifetimeMs(model)
      const cacheRead = warm && previous ? Math.min(previous.rawPrompt, call.rawPrompt) : 0
      setUsage(call, { input: 0, output: call.output, cacheRead, cacheWrite: call.rawPrompt - cacheRead })
      previous = call
    }
  }
}

/** The entries of a Copilot `events.jsonl` in Pi's session format. */
export function copilotEntries(events: UnknownRecord[], file: string): UnknownRecord[] {
  const start = events.find((event) => event.type === 'session.start')
  const startData = isRecord(start?.data) ? start.data : {}
  const firstTimed = events.find((event) => time(event) !== null)
  if (!firstTimed) return []
  const context = isRecord(startData.context) ? startData.context : {}
  const header: UnknownRecord = {
    type: 'session',
    id: str(startData.sessionId) ?? sessionFolder(file),
    cwd: str(context.cwd) ?? str(context.gitRoot),
    timestamp: (start ?? firstTimed).timestamp,
  }
  const entries: UnknownRecord[] = [header]
  const runs: Run[] = []
  let run: Run = { calls: [], totals: null }
  runs.push(run)
  let model = str(startData.selectedModel) ?? 'unknown'
  let baseTokens = reportedBaseTokens(events)
  // Characters of conversation the next call sends on top of the base.
  let contextChars = 0
  let callKey: string | null = null
  let call: Call | null = null
  let lastId: string | null = null
  const toolNames = new Map<string, string>()

  const push = (entry: UnknownRecord): void => {
    entry.parentId = lastId
    lastId = str(entry.id)
    entries.push(entry)
  }

  for (const event of events) {
    // Sub-agents keep their own conversations; Copilot logs their usage apart.
    if (str(event.agentId)) continue
    const data = isRecord(event.data) ? event.data : {}
    const at = time(event)
    const id = str(event.id)
    switch (event.type) {
      case 'session.start':
      case 'session.resume':
        if (event !== start) {
          run = { calls: [], totals: null }
          runs.push(run)
        }
        model = str(data.selectedModel) ?? model
        call = null
        break
      case 'session.model_change':
        model = str(data.newModel) ?? model
        break
      case 'assistant.turn_start':
        model = str(data.model) ?? model
        break
      case 'user.message': {
        call = null
        const text = str(data.transformedContent) ?? str(data.content) ?? ''
        contextChars += text.length
        push({ type: 'message', id, timestamp: event.timestamp, message: { role: 'user', content: str(data.content) ?? text } })
        break
      }
      case 'assistant.message': {
        if (at === null) break
        const key = str(data.apiCallId) ?? str(data.requestId) ?? str(data.messageId) ?? id
        const blocks: UnknownRecord[] = []
        const content = str(data.content)
        if (content) blocks.push({ type: 'text', text: content })
        for (const request of Array.isArray(data.toolRequests) ? data.toolRequests : []) {
          if (!isRecord(request) || !str(request.toolCallId)) continue
          const name = str(request.name) ?? 'unknown'
          toolNames.set(String(request.toolCallId), name)
          blocks.push({ type: 'toolCall', id: request.toolCallId, name, arguments: isRecord(request.arguments) ? request.arguments : {} })
        }
        if (call && key === callKey) {
          // Another chunk of the same call.
          ;(call.message.content as UnknownRecord[]).push(...blocks)
          call.entry.timestamp = event.timestamp
          call.at = at
          call.output += num(data.outputTokens)
        } else {
          const callModel = str(data.model) ?? model
          const message: UnknownRecord = { role: 'assistant', provider: IMPORT_PROVIDERS.copilot, model: callModel, content: blocks }
          const entry: UnknownRecord = { type: 'message', id, timestamp: event.timestamp, message }
          call = { entry, message, model: callModel, at, rawPrompt: baseTokens + contextChars / CHARS_PER_TOKEN, output: num(data.outputTokens) }
          callKey = key
          run.calls.push(call)
          push(entry)
        }
        contextChars += chars(content) + blocks.reduce((sum, block) => sum + (block.type === 'toolCall' ? chars(block.arguments) : 0), 0)
        break
      }
      case 'tool.execution_complete': {
        const toolCallId = str(data.toolCallId)
        if (!toolCallId) break
        const result = isRecord(data.result) ? data.result : {}
        const text = str(result.content) ?? (isRecord(data.error) ? str(data.error.message) : null) ?? ''
        contextChars += text.length
        push({
          type: 'message', id, timestamp: event.timestamp,
          message: { role: 'toolResult', toolCallId, toolName: toolNames.get(toolCallId), content: [{ type: 'text', text }], isError: data.success === false },
        })
        call = null
        break
      }
      case 'session.compaction_complete': {
        if (data.success !== true) break
        const base = num(data.systemTokens) + num(data.toolDefinitionsTokens) || baseTokens
        baseTokens = base
        const after = num(data.postCompactionTokens)
        contextChars = after > base ? (after - base) * CHARS_PER_TOKEN : chars(data.summaryContent)
        push({ type: 'compaction', id, timestamp: event.timestamp })
        call = null
        break
      }
      case 'session.shutdown': {
        run.totals = shutdownTotals(data)
        call = null
        break
      }
    }
  }
  for (const each of runs) fillRun(each)
  return entries
}

/** A Copilot session's facts, or null when its file has no timed events. */
export function analyzeCopilotSession(events: UnknownRecord[], file: string): SessionAnalytics | null {
  const entries = copilotEntries(events, file)
  if (entries.length === 0) return null
  const facts = analyzeSession(entries, file)
  if (facts) facts.source = 'copilot'
  return facts
}
