/**
 * Context snapshots: what fills a session's model context, and what each model
 * call cost. The bundled `pi-desktop-context.ts` extension builds one per
 * session and writes it as JSON to the folder named in `PI_DESKTOP_CONTEXT_DIR`
 * (pi-analytics runs the same recorder, into its own folder when that is
 * unset); Pi Desktop's Context panel and the pi-analytics session page read it.
 *
 * Shared by the extension loaded into Pi and OMP, the main process, and the
 * renderer, so it has no imports at all. Token counts in the breakdown are
 * estimates at 4 characters a token, the same heuristic Pi's own estimator
 * uses; the calls carry the usage the provider reported.
 *
 * The category scheme follows pi-context-view (MIT,
 * https://github.com/dimk90/pi-context-view).
 */

/** File name of the extension in resources/ (main passes it to the agent with `-e`). */
export const CONTEXT_EXTENSION_FILE = 'pi-desktop-context.ts'
/** Environment variable naming the folder the extension writes snapshots to. */
export const CONTEXT_DIR_ENV = 'PI_DESKTOP_CONTEXT_DIR'
/** Set by the recorder to its session id, so a Pi process it spawns (a subagent) can name its parent. */
export const PARENT_SESSION_ENV = 'PI_DESKTOP_PARENT_SESSION_ID'
/** The cache mode a new session starts in (the app's last choice); a session's mode file wins. */
export const CACHE_MODE_ENV = 'PI_DESKTOP_CACHE_MODE'
export const CONTEXT_SNAPSHOT_VERSION = 1
/** Newest model calls kept in a snapshot; older ones only count in the session totals. */
export const MAX_RECORDED_CALLS = 200
export const MAX_CATALOG_MODELS = 400
/** Largest items listed under one category; the rest are folded into one "more" item. */
export const MAX_CATEGORY_ITEMS = 40
export const MAX_PREVIEW_CHARS = 240
const CHARS_PER_TOKEN = 4

/**
 * Category ids, in the order Pi assembles a request: prompt text, then the
 * tool definitions sent beside it, then the conversation.
 */
export const CONTEXT_CATEGORY_IDS = [
  'system-prompt',
  'context-files',
  'skills',
  'built-in-tools',
  'custom-tools',
  'mcp-tools',
  'user-messages',
  'assistant-messages',
  'assistant-thinking',
  'tool-calls',
  'tool-results',
  'extension-messages',
  'compacted',
] as const

export type ContextCategoryId = (typeof CONTEXT_CATEGORY_IDS)[number]

export interface ContextItem {
  /** A file path, tool name, section name, or a short message label. */
  label: string
  tokens: number
  /** How many messages or calls the item adds up, when more than one. */
  count?: number
  /** The start of the item's text, for a hover preview. */
  preview?: string
}

export interface ContextCategory {
  id: ContextCategoryId
  tokens: number
  /** Largest first. */
  items: ContextItem[]
}

export interface ContextBreakdown {
  /** When the request this breakdown describes was built (ms since epoch). */
  capturedAt: number
  estimatedTokens: number
  /** Only the non-empty categories, in `CONTEXT_CATEGORY_IDS` order. */
  categories: ContextCategory[]
  /** True when the breakdown was rebuilt from the saved session, before any request this run. */
  fromSession?: boolean
}

/** Price per million tokens, in US dollars. */
export interface TokenRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface SnapshotModel {
  provider: string
  id: string
  name: string
  contextWindow: number | null
  maxTokens: number | null
  rates: TokenRates | null
  /** Best-effort prompt cache lifetime in seconds for each retention tier, from the model definition. */
  promptCache: { short?: number; long?: number } | null
}

export interface CallCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

/** One model call, with the usage the provider reported. */
export interface ModelCall {
  /** When the response finished (ms since epoch). */
  at: number
  provider: string
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: CallCost
}

export interface ContextSnapshot {
  version: typeof CONTEXT_SNAPSHOT_VERSION
  sessionId: string
  sessionFile: string | null
  /** The recorder session that spawned this one, when it ran under one. */
  parentSessionId?: string | null
  /**
   * Every model the session could call, so a subagent's cache lifetime,
   * window and rates can be looked up by the model it reports. At most
   * `MAX_CATALOG_MODELS`.
   */
  catalog?: SnapshotModel[]
  updatedAt: number
  model: SnapshotModel | null
  /** The prompt cache tier the latest request asked for (`PI_CACHE_RETENTION=long` picks long). */
  cacheRetention: 'short' | 'long'
  /** Pi's `cacheWarming` setting (`off`, `streaming`, `idle`), when it has one. */
  cacheWarming: string | null
  /** The session's cache mode, when the recorder applies one. */
  cacheMode?: CacheMode
  /** When the mode was last switched; null while the session keeps the mode it started with. */
  cacheModeChangedAt?: number | null
  breakdown: ContextBreakdown | null
  /** Pi's own estimate of the context the next request sends, from the last reported usage. */
  reportedTokens: number | null
  /** Newest last, at most `MAX_RECORDED_CALLS`. */
  calls: ModelCall[]
  /** Calls dropped from `calls`, still counted in `totals`. */
  totals: { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
  /** When the current turn's user prompt started a run. */
  turnStartedAt: number | null
  /** When the latest provider request was sent; every cache hit restarts the lifetime from here. */
  lastRequestAt: number | null
  /** When Pi last sent a cache-warming refresh. */
  lastWarmAt: number | null
  /** The Pi process recording the session, so a reader can tell a live session from one whose process is gone. */
  process?: SnapshotProcess | null
  /** The session's display name (`/name`). */
  sessionName?: string | null
  thinkingLevel?: string | null
  /** True from the start of an agent run to its end. */
  agentRunning?: boolean
  /** The tool running now. */
  activeTool?: string | null
  /** When the session ended: Pi quit, or switched to another session. */
  endedAt?: number | null
}

export interface SnapshotProcess {
  pid: number
  /** When the process started (ms since epoch), to tell it from a later process given the same id. */
  startedAt: number
  cwd: string
}

// ─── Cache modes ────────────────────────────────────────────────────────────

/**
 * How a session uses the prompt cache, picked per session in the app:
 * - focus: the 5-minute cache, kept alive only while the agent works;
 * - keep-warm: the 5-minute cache, also refreshed `MAX_IDLE_WARMS` times
 *   after the agent stops (needs Pi's global `cacheWarming: "idle"`);
 * - long: the 1-hour cache (`PI_CACHE_RETENTION=long`), never refreshed idle.
 * A few refreshes cost less than the 1-hour tier's dearer write for breaks
 * of up to about an hour, so keep-warm is the default.
 */
export const CACHE_MODES = ['keep-warm', 'focus', 'long'] as const
export type CacheMode = typeof CACHE_MODES[number]
export const DEFAULT_CACHE_MODE: CacheMode = 'keep-warm'
/** Refreshes keep-warm sends after the agent stops, about 4 minutes apart: the cache then lives ~15 minutes past the last turn. */
export const MAX_IDLE_WARMS = 3
const CACHE_MODE_SUFFIX = '.mode'

export interface CacheModeChoice {
  mode: CacheMode
  /** When it was picked (ms since epoch). */
  changedAt: number
}

export function isCacheMode(value: unknown): value is CacheMode {
  return typeof value === 'string' && (CACHE_MODES as readonly string[]).includes(value)
}

export function isCacheModeChoice(value: unknown): value is CacheModeChoice {
  return isRecord(value) && isCacheMode(value.mode) && typeof value.changedAt === 'number' && Number.isFinite(value.changedAt)
}

/** The file beside a session's snapshot that holds the mode picked for it. */
export function cacheModeFileName(sessionId: string): string {
  return snapshotFileName(sessionId).replace(/\.json$/, CACHE_MODE_SUFFIX)
}

export function isCacheModeFileName(name: string): boolean {
  return name.endsWith(CACHE_MODE_SUFFIX)
}

/** The cache tier requests ask for in a mode. */
export function cacheRetentionFor(mode: CacheMode): 'short' | 'long' {
  return mode === 'long' ? 'long' : 'short'
}

/**
 * The mode's answer to one of Pi's cache-warming decisions, or null to leave
 * Pi's own. While the agent works Pi expects the next request for sure
 * (continuation probability 1) and decides by price; once it stops, only
 * keep-warm refreshes, up to `maxIdleWarms` times since the last real
 * request, and the others stop so they never pay for idle time.
 */
export function cacheWarmingOverride(mode: CacheMode, continuationProbability: number, idleWarms: number, maxIdleWarms = MAX_IDLE_WARMS): 'warm' | 'stop' | null {
  if (continuationProbability >= 1) return null
  return mode === 'keep-warm' && idleWarms < maxIdleWarms ? 'warm' : 'stop'
}

/**
 * Prompt cache lifetimes (seconds) the vendors advertise for their current
 * models, per retention tier as Pi asks for it, or null for models we know
 * nothing about. GitHub Copilot runs the vendor's models, so its models get
 * the vendor's numbers.
 * - Anthropic: 5 minutes, or 1 hour on the long tier.
 * - OpenAI GPT-5.6 and later: 30 minutes; Pi's long tier also asks for 30.
 * - Older OpenAI: in-memory caching lasts 5 to 10 minutes (the low end is
 *   taken); the 24-hour retention Pi's long tier asks for typically holds
 *   about 30 minutes.
 */
export function advertisedCacheLifetime(provider: string, modelId: string): { short: number; long: number } | null {
  const id = modelId.toLowerCase()
  const name = provider.toLowerCase()
  if (name.includes('anthropic') || id.includes('claude')) return { short: 5 * 60, long: 60 * 60 }
  if (name.includes('openai') || /(^|[./])(gpt|o\d|chatgpt|codex)/.test(id)) {
    return /gpt-(5\.([6-9]|\d{2,})|[6-9]|\d{2,})/.test(id) ? { short: 30 * 60, long: 30 * 60 } : { short: 5 * 60, long: 30 * 60 }
  }
  return null
}

/**
 * Give a model the advertised lifetimes for the tiers its definition leaves
 * out, so Pi's cache warmer (which warms only models with a lifetime) keeps
 * it warm. A lifetime the catalog or the user's models.json sets is kept.
 * Returns true when it filled one in.
 */
export function fillCacheLifetime(model: unknown): boolean {
  if (!isRecord(model) || typeof model.provider !== 'string' || typeof model.id !== 'string') return false
  const advertised = advertisedCacheLifetime(model.provider, model.id)
  if (!advertised) return false
  const current = isRecord(model.promptCache) ? model.promptCache : {}
  const short = typeof current.short === 'number' && current.short > 0 ? current.short : advertised.short
  const long = typeof current.long === 'number' && current.long > 0 ? current.long : advertised.long
  if (short === current.short && long === current.long) return false
  model.promptCache = { ...current, short, long }
  return true
}

/** The channel on `pi.events` the pi-analytics extension reports each session's cache status on. */
export const CACHE_STATUS_EVENT = 'pi-analytics:status'

/** The part of pi-analytics' `SessionCacheStatus` the Context panel shows. */
export interface CacheStatusEvent {
  sessionId: string
  /** Null while the package leaves Pi's own warming alone. */
  cacheMode: CacheMode | null
  cacheModeChangedAt: number | null
  cacheRetention: 'short' | 'long' | null
  /** Idle refreshes allowed for the current break. */
  idleLimit: number | null
  lastWarmAt: number | null
}

const nullableNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** A status sent on `CACHE_STATUS_EVENT`, or null for anything else. */
export function cacheStatusFromEvent(data: unknown): CacheStatusEvent | null {
  if (!isRecord(data) || typeof data.sessionId !== 'string') return null
  return {
    sessionId: data.sessionId,
    cacheMode: isCacheMode(data.cacheMode) ? data.cacheMode : null,
    cacheModeChangedAt: nullableNumber(data.cacheModeChangedAt),
    cacheRetention: data.cacheRetention === 'short' || data.cacheRetention === 'long' ? data.cacheRetention : null,
    idleLimit: nullableNumber(data.idleLimit),
    lastWarmAt: nullableNumber(data.lastWarmAt),
  }
}

// ─── Estimation ─────────────────────────────────────────────────────────────

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function preview(text: string): string | undefined {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > MAX_PREVIEW_CHARS ? `${flat.slice(0, MAX_PREVIEW_CHARS - 1)}…` : flat
}

function item(label: string, text: string): ContextItem {
  const entry: ContextItem = { label, tokens: estimateTextTokens(text) }
  const shown = preview(text)
  if (shown) entry.preview = shown
  return entry
}

/** Sort largest first and fold the tail beyond `MAX_CATEGORY_ITEMS` into one item. */
export function capItems(items: ContextItem[], moreLabel: (count: number) => string): ContextItem[] {
  const sorted = items.filter((entry) => entry.tokens > 0).sort((a, b) => b.tokens - a.tokens)
  if (sorted.length <= MAX_CATEGORY_ITEMS) return sorted
  const kept = sorted.slice(0, MAX_CATEGORY_ITEMS - 1)
  const rest = sorted.slice(MAX_CATEGORY_ITEMS - 1)
  const restCount = rest.reduce((sum, entry) => sum + (entry.count ?? 1), 0)
  kept.push({ label: moreLabel(rest.length), tokens: rest.reduce((sum, entry) => sum + entry.tokens, 0), count: restCount })
  return kept
}

/** Merge items with the same label, adding up tokens and counts. */
function groupByLabel(items: ContextItem[]): ContextItem[] {
  const groups = new Map<string, ContextItem>()
  for (const entry of items) {
    const existing = groups.get(entry.label)
    if (!existing) {
      groups.set(entry.label, { ...entry, count: entry.count ?? 1 })
      continue
    }
    existing.tokens += entry.tokens
    existing.count = (existing.count ?? 1) + (entry.count ?? 1)
  }
  return [...groups.values()].map((entry) => (entry.count === 1 ? { ...entry, count: undefined } : entry))
}

// ─── System prompt ──────────────────────────────────────────────────────────

/** One top-level `<name>` … `</name>` section of Pi's system prompt. */
interface PromptSection {
  name: string
  start: number
  end: number
  body: string
}

/**
 * Pi renders its prompt as top-level XML sections, each tag alone on a line.
 * Tags inside fenced code are examples, not sections.
 */
export function findPromptSections(prompt: string): PromptSection[] {
  const sections: PromptSection[] = []
  let fence: string | undefined
  const pattern = /^<([a-z][a-z0-9_-]*)>\n|^ {0,3}(`{3,}|~{3,})([^\n]*)/gm
  for (let match = pattern.exec(prompt); match !== null; match = pattern.exec(prompt)) {
    const marker = match[2]
    if (marker !== undefined) {
      if (fence === undefined) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length && match[3].trim() === '') fence = undefined
      continue
    }
    if (fence !== undefined) continue
    const name = match[1]
    const closing = `\n</${name}>`
    const closeAt = prompt.indexOf(closing, pattern.lastIndex)
    if (closeAt === -1) continue
    const end = closeAt + closing.length
    if (end < prompt.length && prompt[end] !== '\n') continue
    sections.push({ name, start: match.index, end, body: prompt.slice(pattern.lastIndex, closeAt) })
    pattern.lastIndex = end
  }
  return sections
}

function decodeXml(text: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_match, name: string) => entities[name])
}

/** Each `<project_instructions path="…">` file inside the project_context section. */
function contextFileItems(body: string): ContextItem[] {
  const items: ContextItem[] = []
  const pattern = /<project_instructions path="([^"]+)">\n?([\s\S]*?)\n?<\/project_instructions>/g
  for (const match of body.matchAll(pattern)) items.push(item(decodeXml(match[1]), match[2]))
  return items
}

/** Each `<skill>` record inside the skills section: its name, description, and location. */
function skillItems(body: string): ContextItem[] {
  const items: ContextItem[] = []
  const pattern = /<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<location>([\s\S]*?)<\/location>\s*<\/skill>/g
  for (const match of body.matchAll(pattern)) {
    items.push(item(decodeXml(match[1]), match[0]))
  }
  return items
}

export interface PromptBreakdown {
  systemPrompt: ContextItem[]
  contextFiles: ContextItem[]
  skills: ContextItem[]
}

/**
 * Split the system prompt into its sections. Instruction files and skills get
 * their own categories, an item per file or skill; when a section holds no
 * records Pi generated, the whole section stays a system-prompt item. Text
 * outside every section (a preamble, extension additions) is one item.
 */
export function measureSystemPrompt(prompt: string, labels: { preamble: string; other: string }): PromptBreakdown {
  const result: PromptBreakdown = { systemPrompt: [], contextFiles: [], skills: [] }
  if (!prompt) return result
  const sections = findPromptSections(prompt)
  let outside = ''
  let cursor = 0
  for (const section of sections) {
    outside += prompt.slice(cursor, section.start)
    cursor = section.end
    if (section.name === 'project_context') {
      const files = contextFileItems(section.body)
      if (files.length > 0) {
        result.contextFiles.push(...files)
        continue
      }
    }
    if (section.name === 'skills') {
      const skills = skillItems(section.body)
      if (skills.length > 0) {
        result.skills.push(...skills)
        continue
      }
    }
    result.systemPrompt.push(item(section.name, prompt.slice(section.start, section.end)))
  }
  outside += prompt.slice(cursor)
  if (outside.trim()) {
    result.systemPrompt.unshift(item(sections.length === 0 ? labels.preamble : labels.other, outside))
  }
  return result
}

// ─── Tools ──────────────────────────────────────────────────────────────────

/** The parts of a Pi tool definition that reach the model, plus where it came from. */
export interface ToolDefinitionInput {
  name: string
  description?: string
  parameters?: unknown
  sourceInfo?: { path?: string; source?: string }
}

export type ToolKind = 'built-in' | 'mcp' | 'custom'

export function classifyTool(tool: ToolDefinitionInput): ToolKind {
  const path = tool.sourceInfo?.path ?? ''
  const source = tool.sourceInfo?.source ?? ''
  if (/(^|[^a-z])mcp([^a-z]|$)/i.test(`${path} ${source}`) || /^mcp__/i.test(tool.name)) return 'mcp'
  if (source === 'builtin' || path.startsWith('builtin:')) return 'built-in'
  return 'custom'
}

/** Each tool definition as the provider receives it: name, description, and parameter schema. */
export function measureTools(tools: ToolDefinitionInput[]): Record<ToolKind, ContextItem[]> {
  const result: Record<ToolKind, ContextItem[]> = { 'built-in': [], mcp: [], custom: [] }
  for (const tool of tools) {
    const text = JSON.stringify({ name: tool.name, description: tool.description ?? '', parameters: tool.parameters ?? {} })
    const entry: ContextItem = { label: tool.name, tokens: estimateTextTokens(text) }
    const shown = preview(tool.description ?? '')
    if (shown) entry.preview = shown
    result[classifyTool(tool)].push(entry)
  }
  return result
}

// ─── Messages ───────────────────────────────────────────────────────────────

interface UnknownRecord {
  [key: string]: unknown
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: UnknownRecord, key: string): string {
  const field = value[key]
  return typeof field === 'string' ? field : ''
}

/** Text of a string-or-blocks message body; images and other blocks count by their JSON. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!isRecord(block)) return ''
      if (block.type === 'text') return stringField(block, 'text')
      // An image is sent as data, not text; its size says little about its tokens.
      if (block.type === 'image') return ''
      return JSON.stringify(block)
    })
    .join('\n')
}

function firstLine(text: string, fallback: string): string {
  const line = text.split('\n').find((part) => part.trim())?.trim() ?? ''
  if (!line) return fallback
  return line.length > 60 ? `${line.slice(0, 59)}…` : line
}

export interface MessageBreakdown {
  user: ContextItem[]
  assistant: ContextItem[]
  thinking: ContextItem[]
  toolCalls: ContextItem[]
  toolResults: ContextItem[]
  extension: ContextItem[]
  compacted: ContextItem[]
}

/**
 * Classify the conversation Pi sends: one item per user and assistant message,
 * tool calls and results grouped by tool, extension messages by their type.
 * System messages carry the prompt and tool set, which are measured apart.
 */
export function classifyMessages(messages: unknown[], labels: { user: string; assistant: string; bash: string }): MessageBreakdown {
  const result: MessageBreakdown = { user: [], assistant: [], thinking: [], toolCalls: [], toolResults: [], extension: [], compacted: [] }
  for (const message of messages) {
    if (!isRecord(message)) continue
    switch (message.role) {
      case 'user': {
        const text = contentText(message.content)
        result.user.push(item(firstLine(text, labels.user), text))
        break
      }
      case 'assistant': {
        if (!Array.isArray(message.content)) break
        const texts: string[] = []
        const thoughts: string[] = []
        for (const block of message.content) {
          if (!isRecord(block)) continue
          if (block.type === 'text') texts.push(stringField(block, 'text'))
          else if (block.type === 'thinking') thoughts.push(stringField(block, 'thinking'))
          else if (block.type === 'toolCall') {
            const name = stringField(block, 'name') || 'tool'
            result.toolCalls.push(item(name, `${name}(${JSON.stringify(block.arguments ?? {})})`))
          }
        }
        const text = texts.join('\n')
        if (text) result.assistant.push(item(firstLine(text, labels.assistant), text))
        const thinking = thoughts.join('\n')
        if (thinking) result.thinking.push(item(firstLine(thinking, labels.assistant), thinking))
        break
      }
      case 'toolResult':
        result.toolResults.push(item(stringField(message, 'toolName') || 'tool', contentText(message.content)))
        break
      case 'custom':
        result.extension.push(item(stringField(message, 'customType') || 'custom', contentText(message.content)))
        break
      case 'bashExecution':
        // `!!` commands stay out of the model's context.
        if (message.excludeFromContext === true) break
        result.toolResults.push(item(labels.bash, `$ ${stringField(message, 'command')}\n${stringField(message, 'output')}`))
        break
      case 'compactionSummary':
      case 'branchSummary': {
        const summary = stringField(message, 'summary')
        result.compacted.push(item(firstLine(summary, String(message.role)), summary))
        break
      }
    }
  }
  result.toolCalls = groupByLabel(result.toolCalls)
  result.toolResults = groupByLabel(result.toolResults)
  result.extension = groupByLabel(result.extension)
  return result
}

// ─── Breakdown ──────────────────────────────────────────────────────────────

export interface BreakdownLabels {
  preamble: string
  other: string
  user: string
  assistant: string
  bash: string
  more: (count: number) => string
}

/** English labels for the few items the extension has to name itself. */
export const DEFAULT_BREAKDOWN_LABELS: BreakdownLabels = {
  preamble: 'prompt',
  other: 'other text',
  user: 'user message',
  assistant: 'assistant message',
  bash: 'bash',
  more: (count) => `${count} more`,
}

export function buildBreakdown(input: {
  systemPrompt: string
  tools: ToolDefinitionInput[]
  messages: unknown[]
  capturedAt: number
  fromSession?: boolean
  labels?: BreakdownLabels
}): ContextBreakdown {
  const labels = input.labels ?? DEFAULT_BREAKDOWN_LABELS
  const prompt = measureSystemPrompt(input.systemPrompt, labels)
  const tools = measureTools(input.tools)
  const messages = classifyMessages(input.messages, labels)
  const byId: Record<ContextCategoryId, ContextItem[]> = {
    'system-prompt': prompt.systemPrompt,
    'context-files': prompt.contextFiles,
    skills: prompt.skills,
    'built-in-tools': tools['built-in'],
    'custom-tools': tools.custom,
    'mcp-tools': tools.mcp,
    'user-messages': messages.user,
    'assistant-messages': messages.assistant,
    'assistant-thinking': messages.thinking,
    'tool-calls': messages.toolCalls,
    'tool-results': messages.toolResults,
    'extension-messages': messages.extension,
    compacted: messages.compacted,
  }
  const categories: ContextCategory[] = []
  for (const id of CONTEXT_CATEGORY_IDS) {
    const items = byId[id]
    const tokens = items.reduce((sum, entry) => sum + entry.tokens, 0)
    if (tokens > 0) categories.push({ id, tokens, items: capItems(items, labels.more) })
  }
  const breakdown: ContextBreakdown = {
    capturedAt: input.capturedAt,
    estimatedTokens: categories.reduce((sum, category) => sum + category.tokens, 0),
    categories,
  }
  if (input.fromSession) breakdown.fromSession = true
  return breakdown
}

// ─── Model calls ────────────────────────────────────────────────────────────

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * The call an assistant message records, or null when it is not a finished
 * assistant message with usage (a user message, an aborted stream with none).
 */
export function callFromMessage(message: unknown, fallbackAt: number): ModelCall | null {
  if (!isRecord(message) || message.role !== 'assistant' || !isRecord(message.usage)) return null
  const usage = message.usage
  const cost = isRecord(usage.cost) ? usage.cost : {}
  const call: ModelCall = {
    at: typeof message.timestamp === 'number' && message.timestamp > 0 ? message.timestamp : fallbackAt,
    provider: stringField(message, 'provider'),
    model: stringField(message, 'model'),
    input: finiteNumber(usage.input),
    output: finiteNumber(usage.output),
    cacheRead: finiteNumber(usage.cacheRead),
    cacheWrite: finiteNumber(usage.cacheWrite),
    cost: {
      input: finiteNumber(cost.input),
      output: finiteNumber(cost.output),
      cacheRead: finiteNumber(cost.cacheRead),
      cacheWrite: finiteNumber(cost.cacheWrite),
      total: finiteNumber(cost.total),
    },
  }
  if (call.input + call.output + call.cacheRead + call.cacheWrite === 0) return null
  return call
}

export function emptyTotals(): ContextSnapshot['totals'] {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
}

/** Append a call, keeping at most `MAX_RECORDED_CALLS` and every call in the totals. */
export function recordCall(snapshot: Pick<ContextSnapshot, 'calls' | 'totals'>, call: ModelCall): void {
  snapshot.calls.push(call)
  if (snapshot.calls.length > MAX_RECORDED_CALLS) snapshot.calls.splice(0, snapshot.calls.length - MAX_RECORDED_CALLS)
  snapshot.totals.calls++
  snapshot.totals.input += call.input
  snapshot.totals.output += call.output
  snapshot.totals.cacheRead += call.cacheRead
  snapshot.totals.cacheWrite += call.cacheWrite
  snapshot.totals.cost += call.cost.total
}

/** The model fields a snapshot keeps, from Pi's `Model` object. */
export function snapshotModel(model: unknown): SnapshotModel | null {
  if (!isRecord(model)) return null
  const id = stringField(model, 'id')
  if (!id) return null
  const cost = isRecord(model.cost) ? model.cost : null
  const promptCache = isRecord(model.promptCache) ? model.promptCache : null
  const lifetime = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
  return {
    provider: stringField(model, 'provider'),
    id,
    name: stringField(model, 'name') || id,
    contextWindow: finiteNumber(model.contextWindow) || null,
    maxTokens: finiteNumber(model.maxTokens) || null,
    rates: cost
      ? { input: finiteNumber(cost.input), output: finiteNumber(cost.output), cacheRead: finiteNumber(cost.cacheRead), cacheWrite: finiteNumber(cost.cacheWrite) }
      : null,
    promptCache: promptCache ? { short: lifetime(promptCache.short), long: lifetime(promptCache.long) } : null,
  }
}

/** Snapshot file name for a session id; anything outside `[A-Za-z0-9_-]` becomes `_`. */
export function snapshotFileName(sessionId: string): string {
  return `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'session'}.json`
}

// ─── Reading ────────────────────────────────────────────────────────────────

function isFiniteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

/**
 * Accept a parsed snapshot file only when its shape is the current version's,
 * so a half-written, older, or foreign file shows nothing rather than garbage.
 */
export function isContextSnapshot(value: unknown): value is ContextSnapshot {
  if (!isRecord(value) || value.version !== CONTEXT_SNAPSHOT_VERSION) return false
  if (typeof value.sessionId !== 'string' || typeof value.updatedAt !== 'number') return false
  if (!Array.isArray(value.calls) || !isRecord(value.totals)) return false
  if (value.breakdown !== null && !(isRecord(value.breakdown) && Array.isArray(value.breakdown.categories))) return false
  return isFiniteOrNull(value.lastRequestAt) && isFiniteOrNull(value.turnStartedAt) && isFiniteOrNull(value.reportedTokens)
}
