/**
 * Where a session's money and time went, read from its JSONL: per tool,
 * per kind of work (tests, builds, lint, installs, ...), per skill, per turn
 * and per day. Pure, so the analytics index in main, the renderer and the
 * tests share one reading of a session file.
 *
 * A tool's cost is more than the call: its result stays in the context and is
 * sent again with every later model call, mostly as cache reads, until a
 * compaction drops it. That "carried" cost is the tokens of the result times
 * the prompt price of each later call on the same branch.
 */
import { callFromMessage, estimateTextTokens, type ModelCall } from '../../resources/context-snapshot'
import { ACTIVE_GAP_MS, DELEGATE_RUN_ID, TOOL_WAIT_GAP_MS, addModelUsage, callCost, type DelegateRun, type ModelUsage } from './agent-board'

/** Bump when the facts change shape or meaning, so the index reads every file again. */
export const SESSION_ANALYTICS_VERSION = 3

/** What a tool call was for. Shell commands are sorted by what they run. */
export const WORK_CATEGORIES = ['test', 'build', 'lint', 'install', 'git', 'shell', 'read', 'search', 'edit', 'subagent', 'web', 'other'] as const
export type WorkCategory = typeof WORK_CATEGORIES[number]

/** An image block in a tool result, roughly what providers bill for one. */
const IMAGE_TOKENS = 1_200
const MAX_LABEL_CHARS = 120
const MAX_COMMAND_CHARS = 200
const MAX_TEST_RUNS = 200
const MAX_TURNS = 300
const MAX_SLOW_CALLS = 10
const MAX_FAILED_COMMANDS = 20
const MAX_CACHE_CALLS = 5_000

export interface ToolStat {
  tool: string
  category: WorkCategory
  calls: number
  errors: number
  /** Wall-clock time from the call to its result. */
  durationMs: number
  /** Estimated tokens the results put into the context. */
  resultTokens: number
  /** What later calls paid to send these results again. */
  carriedCost: number
}

export interface CategoryStat {
  category: WorkCategory
  calls: number
  errors: number
  durationMs: number
  resultTokens: number
  carriedCost: number
}

export interface SkillStat {
  skill: string
  /** Times the agent read the skill's SKILL.md, or a `/skill:` command loaded it. */
  uses: number
  tokens: number
  carriedCost: number
}

export interface TestRun {
  at: number
  command: string
  durationMs: number
  failed: boolean
}

export interface SlowCall {
  at: number
  tool: string
  category: WorkCategory
  /** The command, path or pattern, shortened. */
  detail: string | null
  durationMs: number
  failed: boolean
}

export interface FailedCommand {
  command: string
  category: WorkCategory
  failures: number
}

export interface TurnFact {
  startedAt: number
  /** From the prompt to the last entry before the next prompt. */
  durationMs: number
  cost: number
  calls: number
  toolCalls: number
  label: string | null
}

/**
 * One model call as the cache replay needs it: when it finished, which model
 * (index into `cacheModels`), its prompt tokens by kind, and what each kind
 * cost. Tuples keep a long session's row small.
 */
export type CacheCall = [
  at: number,
  model: number,
  input: number,
  cacheRead: number,
  cacheWrite: number,
  /** The part of `cacheWrite` written with one-hour retention. */
  cacheWrite1h: number,
  inputCost: number,
  cacheReadCost: number,
  cacheWriteCost: number,
  /** 1 for a cache-warming ping Pi sent while idle; missing or 0 for a real call (rows from before version 3 have none). */
  ping?: number,
]

export interface DayFact {
  cost: number
  calls: number
  activeMs: number
}

export interface SessionAnalytics {
  version: typeof SESSION_ANALYTICS_VERSION
  sessionId: string
  sessionFile: string
  cwd: string | null
  /** The session header's parent: a fork's source, or the chat a harness started this from. */
  parentSession: string | null
  name: string | null
  label: string | null
  startedAt: number | null
  lastActivityAt: number | null
  /** Sum of the gaps between entries shorter than `ACTIVE_GAP_MS`, plus the time spent waiting on tool calls. */
  activeMs: number
  turns: number
  calls: number
  cost: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  compactions: number
  models: ModelUsage[]
  tools: ToolStat[]
  categories: CategoryStat[]
  skills: SkillStat[]
  testRuns: TestRun[]
  slowCalls: SlowCall[]
  failedCommands: FailedCommand[]
  turnFacts: TurnFact[]
  /** Local YYYY-MM-DD -> what that day's calls cost and how long the session worked. */
  days: Record<string, DayFact>
  delegateRuns: DelegateRun[]
  /** `provider/model` names `cacheCalls` point at. */
  cacheModels: string[]
  /** Every model call of the session, oldest first (the newest `MAX_CACHE_CALLS`), with the warming pings between them. */
  cacheCalls: CacheCall[]
  /** Cache-warming pings Pi sent (its `cache_warm` usage entries) and what they cost; their cost is also in `cost`. */
  warmPings: number
  warmCost: number
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function entryTime(entry: UnknownRecord): number | null {
  if (typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)) return entry.timestamp
  if (typeof entry.timestamp !== 'string') return null
  const parsed = Date.parse(entry.timestamp)
  return Number.isFinite(parsed) ? parsed : null
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('\n')
}

function contentTokens(content: unknown): number {
  let tokens = estimateTextTokens(contentText(content))
  if (Array.isArray(content)) for (const block of content) if (isRecord(block) && block.type === 'image') tokens += IMAGE_TOKENS
  return tokens
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Local-time YYYY-MM-DD. */
export function localDayKey(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const TEST_COMMAND = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:[:\w-]*)?|npx\s+(?:vitest|jest|mocha|ava|playwright\s+test|cypress\s+run)|vitest|jest|pytest|py\.test|python3?\s+-m\s+(?:pytest|unittest)|go\s+test|cargo\s+(?:test|nextest)|dotnet\s+test|mvnw?\s+(?:\S+\s+)*(?:test|verify)|gradlew?\s+(?:\S+\s+)*test|(?:tsx|node)\s+(?:\S+\s+)*--test|ctest|rspec|phpunit|mix\s+test|swift\s+test|deno\s+test|tox|nox)\b/
const LINT_COMMAND = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:lint|typecheck|type-check|check|format)(?:[:\w-]*)?|eslint|tsc|biome|prettier\s+(?:\S+\s+)*--check|ruff|mypy|pyright|flake8|pylint|black\s+(?:\S+\s+)*--check|cargo\s+(?:clippy|fmt|check)|golangci-lint|go\s+vet|rubocop|shellcheck)\b/
const BUILD_COMMAND = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|package|compile|bundle)(?:[:\w-]*)?|(?:electron-)?vite\s+build|webpack|esbuild|rollup|cargo\s+build|go\s+build|dotnet\s+build|mvnw?\s+(?:\S+\s+)*(?:package|install|compile)|gradlew?\s+(?:\S+\s+)*(?:build|assemble)|make|cmake|ninja|docker\s+build|electron-builder)\b/
const INSTALL_COMMAND = /\b(?:(?:npm|pnpm|bun)\s+(?:i|install|ci|add)|yarn(?:\s+(?:install|add))?$|yarn\s+(?:install|add)|pip3?\s+install|uv\s+(?:sync|add|pip\s+install)|poetry\s+(?:install|add)|cargo\s+(?:add|fetch)|go\s+(?:get|mod\s+download)|bundle\s+install|apt(?:-get)?\s+install|brew\s+install|dotnet\s+restore)\b/
const GIT_COMMAND = /^(?:git|gh)\b/

/**
 * What a shell command runs. A chain (`npm run build && npm test`) takes the
 * category that says most about it: tests over builds over lint over installs.
 */
export function classifyCommand(command: string): WorkCategory {
  const parts = command.split(/&&|\|\||;|\n/).map((part) => part.trim().replace(/^(?:cd\s+\S+|\w+=\S*\s+)+/, '').trim())
  const has = (pattern: RegExp): boolean => parts.some((part) => pattern.test(part))
  if (has(TEST_COMMAND)) return 'test'
  if (has(BUILD_COMMAND)) return 'build'
  if (has(LINT_COMMAND)) return 'lint'
  if (has(INSTALL_COMMAND)) return 'install'
  if (parts.some((part) => GIT_COMMAND.test(part))) return 'git'
  return 'shell'
}

const SHELL_TOOLS = new Set(['bash', 'shell', 'exec', 'run_command'])
const READ_TOOLS = new Set(['read', 'read_file', 'view'])
const SEARCH_TOOLS = new Set(['grep', 'find', 'ls', 'glob', 'search'])
const EDIT_TOOLS = new Set(['edit', 'write', 'multi_edit', 'apply_patch', 'notebook_edit'])
const SUBAGENT_TOOLS = new Set(['acp_delegate', 'subagent', 'subagent_wait', 'task', 'hub'])
const WEB_TOOLS = new Set(['web_search', 'web_fetch', 'fetch', 'websearch', 'webfetch'])

export function classifyToolCall(tool: string, args: UnknownRecord): WorkCategory {
  const name = tool.toLowerCase()
  if (SHELL_TOOLS.has(name)) return classifyCommand(str(args.command) ?? '')
  if (READ_TOOLS.has(name)) return 'read'
  if (SEARCH_TOOLS.has(name)) return 'search'
  if (EDIT_TOOLS.has(name)) return 'edit'
  if (SUBAGENT_TOOLS.has(name)) return 'subagent'
  if (WEB_TOOLS.has(name)) return 'web'
  return 'other'
}

function callDetail(args: UnknownRecord): string | null {
  const value = str(args.command) ?? str(args.path) ?? str(args.file_path) ?? str(args.pattern) ?? str(args.url) ?? str(args.task) ?? str(args.query)
  return value ? shorten(value, MAX_COMMAND_CHARS) : null
}

const SKILL_FILE = /(?:^|[\\/])([^\\/]+)[\\/]SKILL\.md$/i
/** Pi's expansion of `/skill:name`, the first thing in the user message. */
const SKILL_BLOCK = /^<skill name="([^"]+)" location="[^"]*">/

/** The skill a read loads: the folder holding its SKILL.md. */
export function skillFromPath(path: string): string | null {
  return SKILL_FILE.exec(path)?.[1] ?? null
}

interface PendingCall {
  tool: string
  category: WorkCategory
  args: UnknownRecord
  calledAt: number | null
  /** The assistant message that made the call, so parallel calls share a start. */
  batch: string
}

/** Something in the context that later calls pay to resend. */
interface Carried {
  tokens: number
  tool?: ToolStat
  category?: CategoryStat
  skill?: SkillStat
}

/** Prompt price per token of a call: what it paid for everything it sent. */
function promptPrice(call: ModelCall): number {
  const tokens = call.input + call.cacheRead + call.cacheWrite
  if (tokens <= 0) return 0
  const cost = call.cost.input + call.cost.cacheRead + call.cost.cacheWrite
  return cost > 0 ? cost / tokens : 0
}

/**
 * Read one session file's entries. Every call counts toward cost, abandoned
 * branches too, since they were billed; carried cost follows the tree, so a
 * result is charged only for the calls that sent it.
 */
export function analyzeSession(entries: UnknownRecord[], sessionFile: string): SessionAnalytics | null {
  const header = entries.find((entry) => entry.type === 'session')
  const sessionId = str(header?.id)
  if (!header || !sessionId) return null
  const facts: SessionAnalytics = {
    version: SESSION_ANALYTICS_VERSION,
    sessionId,
    sessionFile,
    cwd: str(header.cwd),
    parentSession: str(header.parentSession),
    name: null,
    label: null,
    startedAt: entryTime(header),
    lastActivityAt: entryTime(header),
    activeMs: 0,
    turns: 0,
    calls: 0,
    cost: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    compactions: 0,
    models: [],
    tools: [],
    categories: [],
    skills: [],
    testRuns: [],
    slowCalls: [],
    failedCommands: [],
    turnFacts: [],
    days: {},
    delegateRuns: [],
    cacheModels: [],
    cacheCalls: [],
    warmPings: 0,
    warmCost: 0,
  }

  const toolStat = (tool: string, category: WorkCategory): ToolStat => {
    let stat = facts.tools.find((entry) => entry.tool === tool && entry.category === category)
    if (!stat) facts.tools.push(stat = { tool, category, calls: 0, errors: 0, durationMs: 0, resultTokens: 0, carriedCost: 0 })
    return stat
  }
  const categoryStat = (category: WorkCategory): CategoryStat => {
    let stat = facts.categories.find((entry) => entry.category === category)
    if (!stat) facts.categories.push(stat = { category, calls: 0, errors: 0, durationMs: 0, resultTokens: 0, carriedCost: 0 })
    return stat
  }
  const skillStat = (skill: string): SkillStat => {
    let stat = facts.skills.find((entry) => entry.skill === skill)
    if (!stat) facts.skills.push(stat = { skill, uses: 0, tokens: 0, carriedCost: 0 })
    return stat
  }
  const day = (at: number): DayFact => (facts.days[localDayKey(at)] ??= { cost: 0, calls: 0, activeMs: 0 })

  const pending = new Map<string, PendingCall>()
  // The latest result time in each assistant message's batch of calls.
  const batchEnd = new Map<string, number>()
  const delegateAgents = new Map<string, string>()
  const failures = new Map<string, FailedCommand>()
  // Per entry id: what it puts in the context, and the prompt price its call paid.
  const carriedBy = new Map<string, Carried>()
  const priceOf = new Map<string, number>()
  let turn: TurnFact | null = null
  let previousAt = facts.startedAt
  let index = 0
  const inheritEntry = (entry: UnknownRecord, id: string): void => {
    if (entry.type !== 'message' || !isRecord(entry.message)) return
    const message = entry.message
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block) && block.type === 'toolCall' && str(block.id)) {
          const tool = str(block.name) ?? 'unknown'
          const args = isRecord(block.arguments) ? block.arguments : {}
          pending.set(String(block.id), { tool, category: classifyToolCall(tool, args), args, calledAt: null, batch: id })
        }
      }
    } else if (message.role === 'toolResult') {
      const call = str(message.toolCallId) ? pending.get(String(message.toolCallId)) : undefined
      if (call) pending.delete(String(message.toolCallId))
      const tool = call?.tool ?? str(message.toolName) ?? 'unknown'
      const category = call?.category ?? classifyToolCall(tool, {})
      carriedBy.set(id, { tokens: contentTokens(message.content), tool: toolStat(tool, category), category: categoryStat(category) })
    } else if (message.role === 'user') {
      const text = contentText(message.content)
      const skill = SKILL_BLOCK.exec(text)?.[1]
      if (skill) carriedBy.set(id, { tokens: estimateTextTokens(text), skill: skillStat(skill) })
    }
  }
  // A fork or clone copies its parent's branch, ids and times included. Those
  // entries were billed to the parent; here they only count as carried context.
  const forkedAt = facts.parentSession ? facts.startedAt : null

  for (const entry of entries) {
    index++
    if (entry === header) continue
    const at = entryTime(entry)
    const inherited = forkedAt !== null && at !== null && at < forkedAt
    // Waiting on a running tool (a 20-minute test run) is work, not idle time.
    const waitedOnTool = isRecord(entry.message) && entry.message.role === 'toolResult' && pending.has(String(entry.message.toolCallId))
    const activeGap = waitedOnTool ? TOOL_WAIT_GAP_MS : ACTIVE_GAP_MS
    if (at !== null && !inherited) {
      if (previousAt !== null && at > previousAt && at - previousAt < activeGap) {
        facts.activeMs += at - previousAt
        day(at).activeMs += at - previousAt
      }
      if (previousAt === null || at > previousAt) previousAt = at
      if (facts.lastActivityAt === null || at > facts.lastActivityAt) facts.lastActivityAt = at
      if (turn) turn.durationMs = Math.max(turn.durationMs, at - turn.startedAt)
    }
    const id = str(entry.id) ?? `#${index}`

    if (inherited) {
      inheritEntry(entry, id)
      continue
    }
    if (entry.type === 'compaction') {
      facts.compactions++
      if (isRecord(entry.usage)) {
        const call = callFromMessage({ role: 'assistant', usage: entry.usage, provider: '', model: '' }, at ?? 0)
        if (call) addCall(facts, call, turn, day)
      }
      continue
    }
    if (entry.type === 'session_info') {
      facts.name = str(entry.name) ?? facts.name
      continue
    }
    // Pi records each cache-warming refresh as a usage entry: billed, but no turn of the conversation.
    if (entry.type === 'usage' && entry.kind === 'cache_warm' && isRecord(entry.usage)) {
      const call = callFromMessage({ role: 'assistant', usage: entry.usage, provider: entry.provider, model: entry.model }, at ?? 0)
      if (call) {
        const cost = callCost(call)
        addCall(facts, call, turn, day, false)
        addModelUsage(facts.models, call, cost)
        facts.warmPings++
        facts.warmCost += cost
        recordCacheCall(facts, call, entry.usage.cacheWrite1h, true)
      }
      continue
    }
    if (entry.type !== 'message' || !isRecord(entry.message)) continue
    const message = entry.message

    if (message.role === 'user') {
      facts.turns++
      const text = contentText(message.content)
      const skill = SKILL_BLOCK.exec(text)?.[1]
      if (skill) {
        const stat = skillStat(skill)
        const tokens = estimateTextTokens(text)
        stat.uses++
        stat.tokens += tokens
        carriedBy.set(id, { tokens, skill: stat })
      }
      const line = text.replace(/^<skill[\s\S]*?<\/skill>\s*/, '').split('\n').map((part) => part.trim()).find(Boolean) ?? (skill ? `/skill:${skill}` : null)
      const label = line ? shorten(line, MAX_LABEL_CHARS) : null
      if (facts.label === null) facts.label = label
      if (at !== null) {
        turn = { startedAt: at, durationMs: 0, cost: 0, calls: 0, toolCalls: 0, label }
        facts.turnFacts.push(turn)
        if (facts.turnFacts.length > MAX_TURNS) facts.turnFacts.shift()
      }
      continue
    }

    if (message.role === 'assistant') {
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!isRecord(block) || block.type !== 'toolCall') continue
          const tool = str(block.name) ?? 'unknown'
          const args = isRecord(block.arguments) ? block.arguments : {}
          const callId = str(block.id)
          if (turn) turn.toolCalls++
          if (tool === 'acp_delegate' && callId) {
            const agent = str(args.agent)
            if (agent) delegateAgents.set(callId, agent)
          }
          if (callId) pending.set(callId, { tool, category: classifyToolCall(tool, args), args, calledAt: at, batch: id })
          else {
            toolStat(tool, classifyToolCall(tool, args)).calls++
            categoryStat(classifyToolCall(tool, args)).calls++
          }
        }
      }
      const call = callFromMessage(message, at ?? 0)
      if (call) {
        addCall(facts, call, turn, day)
        addModelUsage(facts.models, call, callCost(call))
        priceOf.set(id, promptPrice(call))
        recordCacheCall(facts, call, isRecord(message.usage) ? message.usage.cacheWrite1h : 0)
      }
      continue
    }

    if (message.role !== 'toolResult') continue
    const callId = str(message.toolCallId)
    const call = callId ? pending.get(callId) : undefined
    if (callId) pending.delete(callId)
    const tool = call?.tool ?? str(message.toolName) ?? 'unknown'
    const category = call?.category ?? classifyToolCall(tool, {})
    const args = call?.args ?? {}
    const failed = message.isError === true
    // Parallel calls of one message share a start; each is charged the time since the previous result.
    let durationMs = 0
    if (call && at !== null && call.calledAt !== null) {
      const start = Math.max(call.calledAt, batchEnd.get(call.batch) ?? call.calledAt)
      durationMs = Math.max(0, at - start)
      batchEnd.set(call.batch, Math.max(at, batchEnd.get(call.batch) ?? at))
    }
    const tokens = contentTokens(message.content)
    const tStat = toolStat(tool, category)
    const cStat = categoryStat(category)
    tStat.calls++
    cStat.calls++
    tStat.durationMs += durationMs
    cStat.durationMs += durationMs
    tStat.resultTokens += tokens
    cStat.resultTokens += tokens
    if (failed) {
      tStat.errors++
      cStat.errors++
    }
    const carried: Carried = { tokens, tool: tStat, category: cStat }
    const path = str(args.path) ?? str(args.file_path)
    const skill = READ_TOOLS.has(tool.toLowerCase()) && path ? skillFromPath(path) : null
    if (skill && !failed) {
      const stat = skillStat(skill)
      stat.uses++
      stat.tokens += tokens
      carried.skill = stat
    }
    carriedBy.set(id, carried)

    const detail = callDetail(args)
    if (category === 'test' && at !== null && facts.testRuns.length < MAX_TEST_RUNS) {
      facts.testRuns.push({ at, command: detail ?? tool, durationMs, failed })
    }
    if (at !== null && durationMs > 0) {
      facts.slowCalls.push({ at, tool, category, detail, durationMs, failed })
      facts.slowCalls.sort((a, b) => b.durationMs - a.durationMs)
      if (facts.slowCalls.length > MAX_SLOW_CALLS) facts.slowCalls.pop()
    }
    if (failed && detail && SHELL_TOOLS.has(tool.toLowerCase())) {
      const known = failures.get(detail) ?? { command: detail, category, failures: 0 }
      known.failures++
      failures.set(detail, known)
    }
    if (tool === 'acp_delegate') {
      const agent = callId ? delegateAgents.get(callId) ?? null : null
      for (const runId of contentText(message.content).match(DELEGATE_RUN_ID) ?? []) {
        if (!facts.delegateRuns.some((run) => run.runId === runId)) facts.delegateRuns.push({ runId, agent })
      }
    }
  }

  // Calls that never got a result (the session stopped mid-tool) still count as calls.
  for (const call of pending.values()) {
    toolStat(call.tool, call.category).calls++
    categoryStat(call.category).calls++
  }

  addCarriedCost(entries, carriedBy, priceOf)

  facts.failedCommands = [...failures.values()].sort((a, b) => b.failures - a.failures).slice(0, MAX_FAILED_COMMANDS)
  facts.tools.sort((a, b) => b.carriedCost - a.carriedCost || b.durationMs - a.durationMs || b.calls - a.calls)
  facts.categories.sort((a, b) => b.durationMs - a.durationMs || b.calls - a.calls)
  facts.skills.sort((a, b) => b.uses - a.uses)
  facts.models.sort((a, b) => b.cost - a.cost || b.calls - a.calls)
  return facts
}

function recordCacheCall(facts: SessionAnalytics, call: ModelCall, cacheWrite1h: unknown, ping = false): void {
  if (call.at <= 0) return
  let model: number
  const last = facts.cacheCalls[facts.cacheCalls.length - 1]
  // A ping refreshes the last request's cache; its usage may name the served model differently.
  if (ping && last) model = last[1]
  else {
    const name = `${call.provider}/${call.model}`
    model = facts.cacheModels.indexOf(name)
    if (model < 0) model = facts.cacheModels.push(name) - 1
  }
  const oneHour = typeof cacheWrite1h === 'number' && Number.isFinite(cacheWrite1h) ? Math.min(cacheWrite1h, call.cacheWrite) : 0
  const row: CacheCall = [call.at, model, call.input, call.cacheRead, call.cacheWrite, oneHour, call.cost.input, call.cost.cacheRead, call.cost.cacheWrite]
  if (ping) row.push(1)
  facts.cacheCalls.push(row)
  if (facts.cacheCalls.length > MAX_CACHE_CALLS) facts.cacheCalls.shift()
}

/** `counted` false adds a ping's cost and tokens without counting it as a model call of the conversation. */
function addCall(facts: SessionAnalytics, call: ModelCall, turn: TurnFact | null, day: (at: number) => DayFact, counted = true): void {
  const cost = callCost(call)
  if (counted) facts.calls++
  facts.cost += cost
  facts.input += call.input
  facts.output += call.output
  facts.cacheRead += call.cacheRead
  facts.cacheWrite += call.cacheWrite
  if (call.at > 0) {
    const bucket = day(call.at)
    bucket.cost += cost
    if (counted) bucket.calls++
  }
  if (turn) {
    turn.cost += cost
    if (counted) turn.calls++
  }
}

/**
 * Charge each carried item for every later call that sent it: the calls in
 * its subtree, up to a compaction, which replaces what came before it.
 * Entries are written after their parents, so one pass from the end sums
 * each subtree's prompt prices.
 */
function addCarriedCost(entries: UnknownRecord[], carriedBy: Map<string, Carried>, priceOf: Map<string, number>): void {
  if (carriedBy.size === 0) return
  const subtree = new Map<string, number>()
  const ids: (string | null)[] = entries.map((entry) => str(entry.id))
  const hasTree = ids.some((id, index) => id !== null && str(entries[index].parentId) !== null)
  if (!hasTree) {
    // A legacy file is one branch: everything after an entry is its subtree.
    let sum = 0
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]
      const id = ids[index] ?? `#${index + 1}`
      if (entry.type === 'compaction') sum = 0
      const carried = carriedBy.get(id)
      if (carried) charge(carried, sum)
      sum += priceOf.get(id) ?? 0
    }
    return
  }
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    const id = ids[index]
    if (!id) continue
    const own = priceOf.get(id) ?? 0
    const below = subtree.get(id) ?? 0
    const carried = carriedBy.get(id)
    if (carried) charge(carried, below)
    const parent = str(entry.parentId)
    // A compaction's subtree no longer sends what came before it.
    if (parent && entry.type !== 'compaction') subtree.set(parent, (subtree.get(parent) ?? 0) + own + below)
  }
}

function charge(carried: Carried, priceSum: number): void {
  const cost = carried.tokens * priceSum
  if (cost <= 0) return
  if (carried.tool) carried.tool.carriedCost += cost
  if (carried.category) carried.category.carriedCost += cost
  if (carried.skill) carried.skill.carriedCost += cost
}
