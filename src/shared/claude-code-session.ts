/**
 * Claude Code transcripts (`~/.claude/projects/<project>/<session>.jsonl`)
 * read as Pi sessions, so the analytics and the cache replay treat them like
 * any other session.
 *
 * What differs from Pi's format:
 * - One API response is written as several lines that share `message.id`,
 *   one content block each, every line repeating the usage. They are merged
 *   into one assistant message, timed at its last line.
 * - Tool results arrive as `tool_result` blocks inside user lines.
 * - Usage has no cost. It is priced at Anthropic's list prices, so a
 *   subscription's sessions show what the API would have charged.
 * - The cache write is split into its 5-minute and one-hour parts, which
 *   the replay needs to know which lifetime the session ran with.
 * - Subagents write their own files under `<session>/subagents/`.
 * - A resumed session can copy lines of the session it resumed, which keep
 *   that session's `sessionId`. Those are read as inherited, like a Pi fork.
 */
import { anthropicCost } from './anthropic-prices'
import { IMPORT_PROVIDERS } from './import-sources'
import { analyzeSession, type SessionAnalytics } from './session-analytics'

/** Calls are named `claude-code/<model>`, so they stay apart from the same model under Pi. */
export const CLAUDE_CODE_PROVIDER = IMPORT_PROVIDERS['claude-code']

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

function time(line: UnknownRecord): number | null {
  const parsed = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function fileStem(file: string): string {
  return (file.split(/[\\/]/).pop() ?? file).replace(/\.jsonl$/i, '')
}

/** Claude Code's usage block as Pi's, priced; null for a model without a known price or no tokens. */
function piUsage(model: string, usage: UnknownRecord): UnknownRecord | null {
  const creation = isRecord(usage.cache_creation) ? usage.cache_creation : {}
  const tokens = {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
    cacheWrite1h: num(creation.ephemeral_1h_input_tokens),
  }
  if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0) return null
  const cost = anthropicCost(model, { ...tokens, fast: usage.speed === 'fast' })
  return { ...tokens, cost: cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
}

/** Claude Code's content blocks as Pi's: `tool_use` becomes `toolCall`; thinking is dropped. */
function assistantBlocks(content: unknown): UnknownRecord[] {
  if (!Array.isArray(content)) return []
  const blocks: UnknownRecord[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') blocks.push({ type: 'text', text: block.text })
    else if (block.type === 'tool_use') blocks.push({ type: 'toolCall', id: block.id, name: block.name, arguments: isRecord(block.input) ? block.input : {} })
  }
  return blocks
}

/** A tool result's content as Pi's: text and image blocks. */
function resultContent(content: unknown): UnknownRecord[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  return content.filter(isRecord).map((block) => (block.type === 'image' ? { type: 'image' } : { type: 'text', text: typeof block.text === 'string' ? block.text : '' }))
}

/**
 * The entries of a Claude Code transcript in Pi's session format: a header,
 * then user, assistant, tool result and compaction entries.
 */
export function claudeCodeEntries(lines: UnknownRecord[], file: string): UnknownRecord[] {
  const stem = fileStem(file)
  const isSubagent = /[\\/]subagents[\\/]/.test(file)
  const own = lines.filter((line) => line.isSidechain !== true || isSubagent)
  const first = own.find((line) => time(line) !== null)
  if (!first) return []

  // Lines copied from a resumed session keep its id; this file's own lines start after them.
  const sessionId = isSubagent ? stem : str(first.sessionId) ?? stem
  const copied = isSubagent ? [] : own.filter((line) => str(line.sessionId) && line.sessionId !== stem)
  const firstOwn = copied.length > 0 ? own.find((line) => line.sessionId === stem && time(line) !== null) : first
  const header: UnknownRecord = {
    type: 'session',
    id: isSubagent ? sessionId : stem,
    cwd: str(first.cwd),
    timestamp: (firstOwn ?? first).timestamp,
  }
  if (copied.length > 0) header.parentSession = str(copied[0].sessionId)

  // Merge each response's lines; later lines' uuids point at the first one's entry.
  const responses = new Map<string, { entry: UnknownRecord; message: UnknownRecord; content: UnknownRecord[] }>()
  const alias = new Map<string, string>()
  const entryId = (uuid: unknown): string | null => {
    const id = str(uuid)
    return id ? alias.get(id) ?? id : null
  }
  const entries: UnknownRecord[] = [header]

  for (const line of own) {
    const uuid = str(line.uuid)
    if (line.type === 'system' && line.subtype === 'compact_boundary') {
      entries.push({ type: 'compaction', id: uuid, parentId: entryId(line.logicalParentUuid ?? line.parentUuid), timestamp: line.timestamp })
      continue
    }
    if (!isRecord(line.message)) continue
    const message = line.message

    if (line.type === 'assistant') {
      const responseId = str(message.id) ?? uuid
      const model = str(message.model)
      if (!responseId || !model || model === '<synthetic>') continue
      const known = responses.get(responseId)
      if (known) {
        if (uuid) alias.set(uuid, str(known.entry.id) ?? uuid)
        known.content.push(...assistantBlocks(message.content))
        known.entry.timestamp = line.timestamp
        const usage = isRecord(message.usage) ? piUsage(model, message.usage) : null
        if (usage) known.message.usage = usage
        continue
      }
      const content = assistantBlocks(message.content)
      const piMessage: UnknownRecord = { role: 'assistant', provider: CLAUDE_CODE_PROVIDER, model, content }
      const usage = isRecord(message.usage) ? piUsage(model, message.usage) : null
      if (usage) piMessage.usage = usage
      const entry: UnknownRecord = { type: 'message', id: uuid, parentId: entryId(line.parentUuid), timestamp: line.timestamp, message: piMessage }
      responses.set(responseId, { entry, message: piMessage, content })
      entries.push(entry)
      continue
    }

    if (line.type !== 'user' || line.isMeta === true || line.isCompactSummary === true) continue
    const content = message.content
    const results = Array.isArray(content) ? content.filter((block) => isRecord(block) && block.type === 'tool_result') as UnknownRecord[] : []
    if (results.length === 0) {
      entries.push({ type: 'message', id: uuid, parentId: entryId(line.parentUuid), timestamp: line.timestamp, message: { role: 'user', content } })
      continue
    }
    // One Pi entry per result; they chain, so the next line's parent is the last of them.
    let parent = entryId(line.parentUuid)
    results.forEach((block, index) => {
      const id = index === results.length - 1 ? uuid : `${uuid}#${index}`
      entries.push({
        type: 'message', id, parentId: parent, timestamp: line.timestamp,
        message: { role: 'toolResult', toolCallId: block.tool_use_id, content: resultContent(block.content), isError: block.is_error === true },
      })
      parent = id
    })
  }
  return entries
}

/** A Claude Code transcript's facts, or null when it has no timed lines. */
export function analyzeClaudeCodeSession(lines: UnknownRecord[], file: string): SessionAnalytics | null {
  const entries = claudeCodeEntries(lines, file)
  if (entries.length === 0) return null
  const facts = analyzeSession(entries, file)
  if (facts) facts.source = 'claude-code'
  return facts
}
