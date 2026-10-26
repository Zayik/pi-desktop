/**
 * OpenAI Codex CLI sessions (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`)
 * read as Pi sessions.
 *
 * Each line is `{ timestamp, type, payload }`. What matters here:
 * - `session_meta` opens the file: the session id, its folder, its start.
 * - `turn_context` names the model the following calls use.
 * - `response_item` holds the conversation: messages, tool calls
 *   (`function_call`, `custom_tool_call`) and their outputs.
 * - `event_msg` of type `token_count` closes each model call with its usage
 *   (`info.last_token_usage`); `user_message` is what the user typed (the
 *   `response_item` user messages also carry injected context).
 * - `compacted` marks a compaction.
 * Codex reports input with cached tokens included and no cache writes. For
 * GPT-5.6 and later, which cache everything they are sent, the uncached
 * part is the write; earlier models cache for free and it stays input.
 * A forked session starts with its parent's lines, older than its own
 * start; they count as inherited, like a Pi fork.
 */
import { IMPORT_PROVIDERS } from './import-sources'
import { listCost } from './list-prices'
import { openAIBillsCacheWrites } from './openai-prices'
import { analyzeSession, type SessionAnalytics } from './session-analytics'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function fileStem(file: string): string {
  return (file.split(/[\\/]/).pop() ?? file).replace(/\.jsonl$/i, '')
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('\n')
}

/** A tool call's arguments: Codex sends JSON text; a shell command array becomes one command line. */
function toolArguments(raw: unknown): UnknownRecord {
  let args: unknown = raw
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw)
    } catch {
      return { input: raw }
    }
  }
  if (!isRecord(args)) return {}
  if (Array.isArray(args.command)) {
    const parts = args.command.filter((part): part is string => typeof part === 'string')
    // `["bash", "-lc", "npm test"]` runs its last part.
    const command = parts.length >= 3 && /^-\w*c$/.test(parts[1]) ? parts.slice(2).join(' ') : parts.join(' ')
    return { ...args, command }
  }
  return args
}

/** A tool output's text: Codex wraps shell output as JSON `{ output, metadata }`. */
function outputText(output: unknown): { text: string; failed: boolean } {
  if (typeof output !== 'string') return { text: contentText(output), failed: false }
  try {
    const parsed: unknown = JSON.parse(output)
    if (isRecord(parsed) && typeof parsed.output === 'string') {
      const exit = isRecord(parsed.metadata) ? parsed.metadata.exit_code : undefined
      return { text: parsed.output, failed: typeof exit === 'number' && exit !== 0 }
    }
  } catch {
    // Plain text.
  }
  return { text: output, failed: false }
}

/** Codex's usage as Pi's, priced. */
function piUsage(model: string, usage: UnknownRecord): UnknownRecord | null {
  const prompt = num(usage.input_tokens)
  const cacheRead = Math.min(num(usage.cached_input_tokens), prompt)
  const uncached = prompt - cacheRead
  const writes = openAIBillsCacheWrites(model)
  const tokens = {
    input: writes ? 0 : uncached,
    output: num(usage.output_tokens),
    cacheRead,
    cacheWrite: writes ? uncached : 0,
    cacheWrite1h: 0,
  }
  if (prompt + tokens.output === 0) return null
  const cost = listCost(model, tokens) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  return { ...tokens, cost }
}

/** The entries of a Codex rollout file in Pi's session format. */
export function codexEntries(lines: UnknownRecord[], file: string): UnknownRecord[] {
  const meta = lines.find((line) => line.type === 'session_meta')
  const metaPayload = isRecord(meta?.payload) ? meta.payload : {}
  const startedAt = str(metaPayload.timestamp) ?? str(meta?.timestamp)
  if (!startedAt) return []
  const header: UnknownRecord = { type: 'session', id: str(metaPayload.id) ?? fileStem(file), cwd: str(metaPayload.cwd), timestamp: startedAt }
  const forkedFrom = str(metaPayload.forked_from_id) ?? str(metaPayload.forked_from)
  if (forkedFrom) header.parentSession = forkedFrom
  const entries: UnknownRecord[] = [header]
  let model = 'unknown'
  let lastId: string | null = null
  let index = 0
  // The call being written: its items arrive first, its usage last.
  let open: UnknownRecord | null = null
  let lastTotal: string | null = null
  const toolNames = new Map<string, string>()

  const push = (entry: UnknownRecord): UnknownRecord => {
    entry.id = `${fileStem(file)}#${++index}`
    entry.parentId = lastId
    lastId = entry.id as string
    entries.push(entry)
    return entry
  }
  /** The call being written, opened by its first item. */
  const openCall = (timestamp: unknown): { entry: UnknownRecord; message: UnknownRecord; content: UnknownRecord[] } => {
    const entry = open ?? push({ type: 'message', timestamp, message: { role: 'assistant', provider: IMPORT_PROVIDERS.codex, model, content: [] } })
    open = entry
    entry.timestamp = timestamp
    const message = entry.message as UnknownRecord
    return { entry, message, content: message.content as UnknownRecord[] }
  }

  for (const line of lines) {
    const payload = isRecord(line.payload) ? line.payload : {}
    switch (line.type) {
      case 'turn_context':
        model = str(payload.model) ?? model
        break
      case 'compacted':
        open = null
        push({ type: 'compaction', timestamp: line.timestamp })
        break
      case 'event_msg':
        if (payload.type === 'user_message') {
          open = null
          push({ type: 'message', timestamp: line.timestamp, message: { role: 'user', content: str(payload.message) ?? '' } })
        } else if (payload.type === 'token_count' && isRecord(payload.info)) {
          const info = payload.info
          // Codex sometimes repeats the last count; the running total tells a repeat apart.
          const total = JSON.stringify(info.total_token_usage ?? null)
          if (total !== 'null' && total === lastTotal) break
          lastTotal = total
          const usage = isRecord(info.last_token_usage) ? piUsage(model, info.last_token_usage) : null
          if (!usage) break
          const { message } = openCall(line.timestamp)
          message.model = model
          message.usage = usage
          open = null
        }
        break
      case 'response_item': {
        const type = payload.type
        if (type === 'message' && payload.role === 'assistant') {
          const text = contentText(payload.content)
          if (text) openCall(line.timestamp).content.push({ type: 'text', text })
        } else if (type === 'function_call' || type === 'custom_tool_call' || type === 'local_shell_call') {
          const callId = str(payload.call_id) ?? str(payload.id)
          const name = str(payload.name) ?? (type === 'local_shell_call' ? 'shell' : 'unknown')
          if (callId) toolNames.set(callId, name)
          const args = toolArguments(payload.arguments ?? payload.input ?? (isRecord(payload.action) ? payload.action : undefined))
          openCall(line.timestamp).content.push({ type: 'toolCall', id: callId, name, arguments: args })
        } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
          const callId = str(payload.call_id)
          const { text, failed } = outputText(payload.output)
          push({
            type: 'message', timestamp: line.timestamp,
            message: { role: 'toolResult', toolCallId: callId, toolName: callId ? toolNames.get(callId) : undefined, content: [{ type: 'text', text }], isError: failed },
          })
        }
        break
      }
    }
  }
  return entries
}

/** A Codex session's facts, or null when the file has no session header. */
export function analyzeCodexSession(lines: UnknownRecord[], file: string): SessionAnalytics | null {
  const entries = codexEntries(lines, file)
  if (entries.length === 0) return null
  const facts = analyzeSession(entries, file)
  if (facts) facts.source = 'codex'
  return facts
}
