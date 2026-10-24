/**
 * The Agents view: one summary per saved session (the main chat, its
 * subagents, and sessions started in its worktrees), read from the session
 * JSONL, plus the totals across them. Pure, so main, the renderer and the
 * tests share one reading of a session file.
 */
import {
  CONTEXT_SNAPSHOT_VERSION,
  MAX_RECORDED_CALLS,
  buildBreakdown,
  callFromMessage,
  type ContextBreakdown,
  type ContextSnapshot,
  type ModelCall,
  type SnapshotModel,
} from '../../resources/context-snapshot'
import { promptTokens } from './context-view'

/** Gaps between entries longer than this are idle time, not work. */
export const ACTIVE_GAP_MS = 5 * 60_000
/** A session with no matching task counts as running while it wrote within this window. */
export const RECENT_ACTIVITY_MS = 45_000
const MAX_LABEL_CHARS = 120

/**
 * main: the open chat. subagent: a subagent run's session. worktree: a session
 * started in one of the repository's other worktrees. child: a session that
 * names the main session as its parent.
 */
export type AgentKind = 'main' | 'subagent' | 'worktree' | 'child'

export interface ModelUsage {
  provider: string
  model: string
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

export interface AgentSessionSummary {
  sessionId: string
  sessionFile: string
  cwd: string | null
  /** The session header's parent, for forks and sessions a harness started from another. */
  parentSession: string | null
  /** First line of the first user message. */
  label: string | null
  /** The session's display name (`/name`, or the name a subagent extension gave its child). */
  name: string | null
  /** billion-context `acp_delegate` runs this session started, oldest first. */
  delegateRuns: DelegateRun[]
  startedAt: number | null
  lastActivityAt: number | null
  /** Sum of the gaps between entries shorter than `ACTIVE_GAP_MS`. */
  activeMs: number
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  /** Per model, most calls first. */
  models: ModelUsage[]
  toolCalls: number
  lastTool: string | null
  lastCall: ModelCall | null
  /** When the request behind the last call went out: the entry written just before its reply. */
  lastRequestAt: number | null
  /** The latest user prompt, and the calls since it. */
  turnStartedAt: number | null
  turnCalls: ModelCall[]
  /** When each call finished and what it cost, oldest first, for totals over a time span. */
  callCosts: [at: number, cost: number][]
  /** Prompt plus reply of the last call: what the next call resends. */
  contextTokens: number | null
  /** Estimated from the conversation on the current branch; no system prompt or tools. */
  breakdown: ContextBreakdown | null
}

export interface DelegateRun {
  runId: string
  agent: string | null
}

/** billion-context names delegate runs `del_<time>_<random>`, both base 36. */
export const DELEGATE_RUN_ID = /\bdel_[a-z0-9]{6,12}_[a-z0-9]{2,8}\b/g
const DELEGATE_TOOL = 'acp_delegate'
const MAX_DELEGATE_RUNS = 200

export interface AgentBoardChild {
  kind: Exclude<AgentKind, 'main'>
  /** The subagent's role, when the tool that started it named one. */
  agentName: string | null
  summary: AgentSessionSummary
  /** Set when the session ran with Pi Desktop's recorder. */
  snapshot: ContextSnapshot | null
}

export interface AgentBoard {
  main: AgentSessionSummary | null
  children: AgentBoardChild[]
}

export interface AgentBoardRequest {
  sessionId: string
  sessionFile: string | null
  /** Session files subagent rows point at. */
  subagentSessionFiles: string[]
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

function firstTextLine(content: unknown): string | null {
  const text = contentText(content)
  const line = text.split('\n').map((part) => part.trim()).find(Boolean)
  if (!line) return null
  return line.length > MAX_LABEL_CHARS ? `${line.slice(0, MAX_LABEL_CHARS - 1)}…` : line
}

/**
 * The entries on the current branch, oldest first: a session file is a tree
 * and the latest entry is its leaf. Files without ids are one branch.
 */
export function currentBranch(entries: UnknownRecord[]): UnknownRecord[] {
  const byId = new Map<string, UnknownRecord>()
  for (const entry of entries) {
    const id = str(entry.id)
    if (id) byId.set(id, entry)
  }
  const leaf = [...entries].reverse().find((entry) => str(entry.id) && entry.type !== 'session')
  if (!leaf) return entries.filter((entry) => entry.type !== 'session')
  const branch: UnknownRecord[] = []
  const seen = new Set<string>()
  let current: UnknownRecord | undefined = leaf
  while (current) {
    const id = str(current.id)
    if (!id || seen.has(id)) break
    seen.add(id)
    branch.push(current)
    const parent = str(current.parentId)
    current = parent ? byId.get(parent) : undefined
  }
  return branch.reverse()
}

/** Messages the next call sends: after the latest compaction, its summary stands in for what it replaced. */
function contextMessages(branch: UnknownRecord[]): unknown[] {
  let start = 0
  const messages: unknown[] = []
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]
    if (entry.type === 'compaction') {
      messages.push({ role: 'compactionSummary', summary: str(entry.summary) ?? '' })
      const firstKept = str(entry.firstKeptEntryId)
      const keptAt = firstKept ? branch.findIndex((candidate) => candidate.id === firstKept) : -1
      start = keptAt >= 0 ? keptAt : index + 1
      // Kept entries before the compaction stay; anything after it is new.
      for (const kept of branch.slice(start)) {
        if (kept !== entry && kept.type === 'message') messages.push(kept.message)
      }
      return messages
    }
  }
  for (const entry of branch) if (entry.type === 'message') messages.push(entry.message)
  return messages
}

export function addModelUsage(models: ModelUsage[], call: Pick<ModelCall, 'provider' | 'model' | 'input' | 'output' | 'cacheRead' | 'cacheWrite'>, cost: number, calls = 1): void {
  let usage = models.find((entry) => entry.model === call.model && entry.provider === call.provider)
  if (!usage) {
    usage = { provider: call.provider, model: call.model, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
    models.push(usage)
  }
  usage.calls += calls
  usage.input += call.input
  usage.output += call.output
  usage.cacheRead += call.cacheRead
  usage.cacheWrite += call.cacheWrite
  usage.cost += cost
}

export function callCost(call: ModelCall): number {
  return call.cost.total > 0 ? call.cost.total : call.cost.input + call.cost.output + call.cost.cacheRead + call.cost.cacheWrite
}

/**
 * Summarize a session file's entries. Every call in the file counts toward
 * cost, abandoned branches included, since they were billed; the context and
 * breakdown follow the current branch only.
 */
export function summarizeSession(entries: UnknownRecord[], sessionFile: string): AgentSessionSummary | null {
  const header = entries.find((entry) => entry.type === 'session')
  const sessionId = str(header?.id)
  if (!header || !sessionId) return null
  const summary: AgentSessionSummary = {
    sessionId,
    sessionFile,
    cwd: str(header.cwd),
    parentSession: str(header.parentSession),
    label: null,
    name: null,
    delegateRuns: [],
    startedAt: entryTime(header),
    lastActivityAt: entryTime(header),
    activeMs: 0,
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    models: [],
    toolCalls: 0,
    lastTool: null,
    lastCall: null,
    lastRequestAt: null,
    turnStartedAt: null,
    turnCalls: [],
    callCosts: [],
    contextTokens: null,
    breakdown: null,
  }
  let previousAt: number | null = summary.startedAt
  const delegateAgents = new Map<string, string>()
  for (const entry of entries) {
    if (entry === header) continue
    const at = entryTime(entry)
    const sentAt = previousAt
    if (at !== null) {
      if (previousAt !== null && at > previousAt && at - previousAt < ACTIVE_GAP_MS) summary.activeMs += at - previousAt
      if (previousAt === null || at > previousAt) previousAt = at
      if (summary.lastActivityAt === null || at > summary.lastActivityAt) summary.lastActivityAt = at
    }
    if (entry.type === 'compaction' && isRecord(entry.usage)) {
      const call = callFromMessage({ role: 'assistant', usage: entry.usage, provider: '', model: '' }, at ?? 0)
      if (call) addCall(summary, call, false, sentAt)
      continue
    }
    if (entry.type === 'session_info') {
      summary.name = str(entry.name) ?? summary.name
      continue
    }
    if (entry.type !== 'message' || !isRecord(entry.message)) continue
    const message = entry.message
    if (message.role === 'toolResult' && message.toolName === DELEGATE_TOOL) {
      const agent = str(message.toolCallId) ? delegateAgents.get(String(message.toolCallId)) ?? null : null
      for (const runId of contentText(message.content).match(DELEGATE_RUN_ID) ?? []) {
        if (summary.delegateRuns.length < MAX_DELEGATE_RUNS && !summary.delegateRuns.some((run) => run.runId === runId)) {
          summary.delegateRuns.push({ runId, agent })
        }
      }
      continue
    }
    if (message.role === 'user') {
      if (summary.label === null) summary.label = firstTextLine(message.content)
      summary.turnStartedAt = at
      summary.turnCalls = []
    }
    if (message.role !== 'assistant') continue
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block) && block.type === 'toolCall') {
          summary.toolCalls++
          summary.lastTool = str(block.name) ?? summary.lastTool
          if (block.name === DELEGATE_TOOL && str(block.id) && isRecord(block.arguments)) {
            const agent = str(block.arguments.agent)
            if (agent) delegateAgents.set(String(block.id), agent)
          }
        }
      }
    }
    const call = callFromMessage(message, at ?? 0)
    if (call) addCall(summary, call, true, sentAt)
  }
  const branch = currentBranch(entries)
  const lastOnBranch = [...branch].reverse()
    .map((entry) => (entry.type === 'message' ? callFromMessage(entry.message, entryTime(entry) ?? 0) : null))
    .find((call): call is ModelCall => call !== null)
  if (lastOnBranch) summary.contextTokens = promptTokens(lastOnBranch) + lastOnBranch.output
  const messages = contextMessages(branch)
  if (messages.length > 0) {
    summary.breakdown = buildBreakdown({ systemPrompt: '', tools: [], messages, capturedAt: summary.lastActivityAt ?? 0, fromSession: true })
  }
  summary.models.sort((a, b) => b.calls - a.calls)
  return summary
}

function addCall(summary: AgentSessionSummary, call: ModelCall, isModelCall: boolean, sentAt: number | null): void {
  const cost = callCost(call)
  summary.callCosts.push([call.at, cost])
  summary.calls++
  summary.input += call.input
  summary.output += call.output
  summary.cacheRead += call.cacheRead
  summary.cacheWrite += call.cacheWrite
  summary.cost += cost
  if (isModelCall) {
    addModelUsage(summary.models, call, cost)
    if (!summary.lastCall || call.at >= summary.lastCall.at) {
      summary.lastCall = call
      summary.lastRequestAt = sentAt ?? call.at
    }
    summary.turnCalls.push(call)
    if (summary.turnCalls.length > MAX_RECORDED_CALLS) summary.turnCalls.shift()
  }
}

export interface BoardTotals {
  cost: number
  /** Prompt tokens: new input plus cache reads and writes. */
  tokensIn: number
  tokensOut: number
  activeMs: number
  agents: number
  /** Per model across every agent, most cost first. */
  models: (ModelUsage & { agents: number })[]
}

export function boardTotals(summaries: AgentSessionSummary[]): BoardTotals {
  const totals: BoardTotals = { cost: 0, tokensIn: 0, tokensOut: 0, activeMs: 0, agents: summaries.length, models: [] }
  for (const summary of summaries) {
    totals.cost += summary.cost
    totals.tokensIn += summary.input + summary.cacheRead + summary.cacheWrite
    totals.tokensOut += summary.output
    totals.activeMs += summary.activeMs
    for (const usage of summary.models) {
      let model = totals.models.find((entry) => entry.model === usage.model && entry.provider === usage.provider)
      if (!model) {
        model = { ...usage, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, agents: 0 }
        totals.models.push(model)
      }
      model.agents++
      model.calls += usage.calls
      model.input += usage.input
      model.output += usage.output
      model.cacheRead += usage.cacheRead
      model.cacheWrite += usage.cacheWrite
      model.cost += usage.cost
    }
  }
  totals.models.sort((a, b) => b.cost - a.cost || b.calls - a.calls)
  return totals
}

/** A child is running while its task says so, or, without a task, while it wrote recently. */
export function childIsRunning(summary: AgentSessionSummary, taskRunning: boolean | null, now: number): boolean {
  if (taskRunning !== null) return taskRunning
  return summary.lastActivityAt !== null && now - summary.lastActivityAt < RECENT_ACTIVITY_MS
}

/** What the agent's calls cost since `since` (a turn start), or all of it without one. */
export function costSince(summary: AgentSessionSummary, since: number | null): number {
  if (since === null) return summary.cost
  return summary.callCosts.reduce((sum, [at, cost]) => (at >= since ? sum + cost : sum), 0)
}

/**
 * A snapshot built from a session file, for an agent the recorder did not
 * see, so its card reads the same cache and billing figures. The model's
 * window, rates and cache lifetime come from `model` when it is the model
 * the agent last called; otherwise they stay unknown.
 */
export function snapshotFromSummary(summary: AgentSessionSummary, model: SnapshotModel | null, cacheRetention: ContextSnapshot['cacheRetention']): ContextSnapshot {
  const last = summary.lastCall
  const matches = model !== null && last !== null && last.model === model.id && (!last.provider || !model.provider || last.provider === model.provider)
  return {
    version: CONTEXT_SNAPSHOT_VERSION,
    sessionId: summary.sessionId,
    sessionFile: summary.sessionFile,
    updatedAt: summary.lastActivityAt ?? 0,
    model: matches ? model : last ? { provider: last.provider, id: last.model, name: last.model, contextWindow: null, maxTokens: null, rates: null, promptCache: null } : null,
    cacheRetention,
    cacheWarming: null,
    breakdown: summary.breakdown,
    reportedTokens: summary.contextTokens,
    calls: summary.turnCalls.length > 0 ? summary.turnCalls : last ? [last] : [],
    totals: { calls: summary.calls, input: summary.input, output: summary.output, cacheRead: summary.cacheRead, cacheWrite: summary.cacheWrite, cost: summary.cost },
    turnStartedAt: summary.turnStartedAt,
    lastRequestAt: summary.lastRequestAt,
    lastWarmAt: null,
  }
}
