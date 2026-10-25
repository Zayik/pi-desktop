/**
 * Analytics over many sessions' facts: one session with its subagents, or
 * every session in a date range. Pure, so main builds it, the renderer shows
 * it, and the retro digest reads the same numbers.
 */
import { addModelUsage, type ModelUsage } from './agent-board'
import { buildCacheReport, type CacheReport } from './cache-policy'
import {
  WORK_CATEGORIES,
  localDayKey,
  type CategoryStat,
  type FailedCommand,
  type SessionAnalytics,
  type SkillStat,
  type SlowCall,
  type ToolStat,
  type WorkCategory,
} from './session-analytics'

/** How a session relates to the one a session report is about, or to nothing (overall). */
export type AnalyticsSessionKind = 'main' | 'subagent' | 'delegate' | 'child'

export interface IndexedSession {
  kind: AnalyticsSessionKind
  /** The subagent's role, when the tool that started it named one. */
  agentName: string | null
  /** False once the session file was deleted; its facts stay in the index. */
  fileExists: boolean
  facts: SessionAnalytics
}

export type AnalyticsRangeKey = '7' | '30' | '90' | '365' | 'all'
export const ANALYTICS_RANGES: AnalyticsRangeKey[] = ['7', '30', '90', '365', 'all']

export interface OverviewRequest {
  range: AnalyticsRangeKey
  /** Only sessions whose working folder is this project (or inside it). */
  projectPath: string | null
}

export interface SessionReportRequest {
  sessionFile: string
}

export interface SessionRow {
  sessionId: string
  sessionFile: string
  kind: AnalyticsSessionKind
  agentName: string | null
  title: string | null
  cwd: string | null
  startedAt: number | null
  activeMs: number
  cost: number
  calls: number
  fileExists: boolean
}

export interface TopTurn {
  sessionId: string
  sessionTitle: string | null
  startedAt: number
  durationMs: number
  cost: number
  calls: number
  toolCalls: number
  label: string | null
}

export interface TestSummary {
  runs: number
  failed: number
  durationMs: number
  /** Median run time; long single runs say more than the average. */
  medianMs: number
  /** Sessions that ran tests at least once. */
  sessions: number
  /** Share of active time spent waiting on tests. */
  shareOfActive: number
}

export interface DayPoint {
  day: string
  cost: number
  activeMs: number
}

export interface ProjectRow {
  cwd: string
  sessions: number
  cost: number
  activeMs: number
}

export type SignalId =
  | 'test-time'
  | 'test-reruns'
  | 'slow-tests'
  | 'failing-command'
  | 'carried-tool'
  | 'skill-cost'
  | 'subagent-share'
  | 'compactions'
  | 'build-time'
  | 'cache-policy'

/** A finding, kept as data and translated at render. */
export interface AnalyticsSignal {
  id: SignalId
  severity: 'high' | 'medium' | 'low'
  /** Numbers and names the message fills in. */
  values: Record<string, string | number>
}

export interface AnalyticsReport {
  scope: 'session' | 'overall'
  /** The window the report covers; null ends are open. */
  from: number | null
  to: number | null
  sessions: number
  turns: number
  calls: number
  cost: number
  activeMs: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  models: ModelUsage[]
  categories: CategoryStat[]
  tools: ToolStat[]
  skills: SkillStat[]
  tests: TestSummary
  slowCalls: (SlowCall & { sessionId: string })[]
  failedCommands: FailedCommand[]
  topTurns: TopTurn[]
  /** Sessions, most cost first: the main session and its agents, or the range's top sessions. */
  sessionRows: SessionRow[]
  /** Cost of sessions run as subagents or delegates. */
  subagentCost: number
  days: DayPoint[]
  projects: ProjectRow[]
  /** What each cache setting would have cost these calls, per model. */
  cache: CacheReport
  signals: AnalyticsSignal[]
}

const MAX_ROWS = 15
const MAX_TOP_TURNS = 10
const MAX_SLOW_CALLS = 10
const MAX_TOOLS = 25
const MAX_FAILED = 10
const MS_PER_DAY = 86_400_000
const MINUTE = 60_000

export function rangeStart(range: AnalyticsRangeKey, now: number): number | null {
  if (range === 'all') return null
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return start.getTime() - (Number(range) - 1) * MS_PER_DAY
}

function sessionTitle(facts: SessionAnalytics): string | null {
  return facts.name ?? facts.label
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function mergeBy<T extends object>(target: T[], items: T[], same: (a: T, b: T) => boolean, numeric: (keyof T)[]): void {
  for (const item of items) {
    const known = target.find((entry) => same(entry, item))
    if (!known) {
      target.push({ ...item })
      continue
    }
    for (const key of numeric) (known[key] as number) += item[key] as number
  }
}

/**
 * One report over `sessions`. With a window, cost, time and daily points
 * count only the days inside it; tools, skills and tests come from the
 * sessions active in it, whole.
 */
export function buildReport(scope: AnalyticsReport['scope'], sessions: IndexedSession[], from: number | null = null, to: number | null = null): AnalyticsReport {
  const fromDay = from === null ? null : localDayKey(from)
  const toDay = to === null ? null : localDayKey(to)
  const inWindow = (day: string): boolean => (fromDay === null || day >= fromDay) && (toDay === null || day <= toDay)
  const report: AnalyticsReport = {
    scope,
    from,
    to,
    sessions: sessions.length,
    turns: 0,
    calls: 0,
    cost: 0,
    activeMs: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    models: [],
    categories: [],
    tools: [],
    skills: [],
    tests: { runs: 0, failed: 0, durationMs: 0, medianMs: 0, sessions: 0, shareOfActive: 0 },
    slowCalls: [],
    failedCommands: [],
    topTurns: [],
    sessionRows: [],
    subagentCost: 0,
    days: [],
    projects: [],
    cache: { models: [], days: [], saving: 0 },
    signals: [],
  }
  const days = new Map<string, DayPoint>()
  const projects = new Map<string, ProjectRow>()
  const testDurations: number[] = []
  let compactingSessions = 0
  let maxCompactions = 0

  for (const session of sessions) {
    const { facts } = session
    const windowed = fromDay !== null || toDay !== null
    let cost = facts.cost
    let activeMs = facts.activeMs
    if (windowed) {
      cost = 0
      activeMs = 0
      for (const [day, fact] of Object.entries(facts.days)) {
        if (!inWindow(day)) continue
        cost += fact.cost
        activeMs += fact.activeMs
      }
    }
    for (const [day, fact] of Object.entries(facts.days)) {
      if (!inWindow(day)) continue
      const point = days.get(day) ?? { day, cost: 0, activeMs: 0 }
      point.cost += fact.cost
      point.activeMs += fact.activeMs
      days.set(day, point)
    }
    report.cost += cost
    report.activeMs += activeMs
    report.turns += facts.turns
    report.calls += facts.calls
    report.input += facts.input
    report.output += facts.output
    report.cacheRead += facts.cacheRead
    report.cacheWrite += facts.cacheWrite
    if (session.kind === 'subagent' || session.kind === 'delegate') report.subagentCost += cost
    for (const usage of facts.models) addModelUsage(report.models, usage, usage.cost, usage.calls)
    mergeBy(report.categories, facts.categories, (a, b) => a.category === b.category, ['calls', 'errors', 'durationMs', 'resultTokens', 'carriedCost'])
    mergeBy(report.tools, facts.tools, (a, b) => a.tool === b.tool && a.category === b.category, ['calls', 'errors', 'durationMs', 'resultTokens', 'carriedCost'])
    mergeBy(report.skills, facts.skills, (a, b) => a.skill === b.skill, ['uses', 'tokens', 'carriedCost'])
    mergeBy(report.failedCommands, facts.failedCommands, (a, b) => a.command === b.command, ['failures'])
    if (facts.testRuns.length > 0) report.tests.sessions++
    for (const run of facts.testRuns) {
      report.tests.runs++
      if (run.failed) report.tests.failed++
      report.tests.durationMs += run.durationMs
      testDurations.push(run.durationMs)
    }
    for (const call of facts.slowCalls) report.slowCalls.push({ ...call, sessionId: facts.sessionId })
    const title = sessionTitle(facts)
    for (const turn of facts.turnFacts) report.topTurns.push({ ...turn, sessionId: facts.sessionId, sessionTitle: title })
    report.sessionRows.push({
      sessionId: facts.sessionId,
      sessionFile: facts.sessionFile,
      kind: session.kind,
      agentName: session.agentName,
      title,
      cwd: facts.cwd,
      startedAt: facts.startedAt,
      activeMs,
      cost,
      calls: facts.calls,
      fileExists: session.fileExists,
    })
    if (facts.cwd) {
      const project = projects.get(facts.cwd) ?? { cwd: facts.cwd, sessions: 0, cost: 0, activeMs: 0 }
      project.sessions++
      project.cost += cost
      project.activeMs += activeMs
      projects.set(facts.cwd, project)
    }
    if (facts.compactions >= 3) compactingSessions++
    maxCompactions = Math.max(maxCompactions, facts.compactions)
  }

  report.tests.medianMs = median(testDurations)
  report.tests.shareOfActive = report.activeMs > 0 ? Math.min(1, report.tests.durationMs / report.activeMs) : 0
  report.models.sort((a, b) => b.cost - a.cost || b.calls - a.calls)
  report.categories.sort((a, b) => WORK_CATEGORIES.indexOf(a.category) - WORK_CATEGORIES.indexOf(b.category))
  report.tools = report.tools.sort((a, b) => b.carriedCost - a.carriedCost || b.durationMs - a.durationMs).slice(0, MAX_TOOLS)
  report.skills.sort((a, b) => b.carriedCost - a.carriedCost || b.uses - a.uses)
  report.failedCommands = report.failedCommands.sort((a, b) => b.failures - a.failures).slice(0, MAX_FAILED)
  report.slowCalls = report.slowCalls.sort((a, b) => b.durationMs - a.durationMs).slice(0, MAX_SLOW_CALLS)
  report.topTurns = report.topTurns.sort((a, b) => b.cost - a.cost).slice(0, MAX_TOP_TURNS)
  // The main session leads its own report; the rest go by cost.
  report.sessionRows.sort((a, b) => Number(b.kind === 'main') - Number(a.kind === 'main') || b.cost - a.cost)
  if (scope === 'overall') report.sessionRows = report.sessionRows.slice(0, MAX_ROWS)
  report.days = fillDays([...days.values()], from, to)
  report.projects = [...projects.values()].sort((a, b) => b.cost - a.cost).slice(0, MAX_ROWS)
  report.cache = buildCacheReport(sessions.map(({ facts }) => (from === null && to === null
    ? facts
    : { ...facts, cacheCalls: (facts.cacheCalls ?? []).filter(([at]) => (from === null || at >= from) && (to === null || at <= to)) })))
  report.signals = findSignals(report, { compactingSessions, maxCompactions })
  return report
}

/** Every day from the first to the last (or the window's ends), zero where nothing ran. */
function fillDays(points: DayPoint[], from: number | null, to: number | null): DayPoint[] {
  if (points.length === 0 && from === null) return []
  const byDay = new Map(points.map((point) => [point.day, point]))
  const sorted = [...byDay.keys()].sort()
  const startKey = from !== null ? localDayKey(from) : sorted[0]
  const endKey = to !== null ? localDayKey(to) : sorted[sorted.length - 1]
  if (!startKey || !endKey) return []
  const filled: DayPoint[] = []
  const cursor = new Date(`${startKey}T12:00:00`)
  for (let guard = 0; guard < 4000; guard++) {
    const key = localDayKey(cursor.getTime())
    if (key > endKey) break
    filled.push(byDay.get(key) ?? { day: key, cost: 0, activeMs: 0 })
    cursor.setDate(cursor.getDate() + 1)
  }
  return filled
}

function category(report: AnalyticsReport, id: WorkCategory): CategoryStat | undefined {
  return report.categories.find((entry) => entry.category === id)
}

const percent = (share: number): number => Math.round(share * 100)
const minutes = (ms: number): number => Math.round(ms / MINUTE)

/**
 * Rules that point at where time or money went, strongest first. Thresholds
 * are deliberately coarse: a signal is a place to look, not a verdict.
 */
export function findSignals(report: AnalyticsReport, extra: { compactingSessions: number; maxCompactions: number }): AnalyticsSignal[] {
  const signals: AnalyticsSignal[] = []
  const { tests } = report
  if (tests.durationMs >= 5 * MINUTE && tests.shareOfActive >= 0.2) {
    signals.push({
      id: 'test-time',
      severity: tests.shareOfActive >= 0.35 ? 'high' : 'medium',
      values: { share: percent(tests.shareOfActive), minutes: minutes(tests.durationMs), runs: tests.runs },
    })
  }
  if (tests.sessions > 0 && tests.runs / tests.sessions >= 5) {
    signals.push({
      id: 'test-reruns',
      severity: tests.runs / tests.sessions >= 10 ? 'high' : 'medium',
      values: { perSession: Math.round((tests.runs / tests.sessions) * 10) / 10, failed: tests.failed, runs: tests.runs },
    })
  }
  if (tests.runs >= 2 && tests.medianMs >= 3 * MINUTE) {
    signals.push({ id: 'slow-tests', severity: tests.medianMs >= 10 * MINUTE ? 'high' : 'medium', values: { minutes: minutes(tests.medianMs), runs: tests.runs } })
  }
  const build = category(report, 'build')
  if (build && build.durationMs >= 5 * MINUTE && report.activeMs > 0 && build.durationMs / report.activeMs >= 0.15) {
    signals.push({ id: 'build-time', severity: 'medium', values: { share: percent(build.durationMs / report.activeMs), minutes: minutes(build.durationMs), runs: build.calls } })
  }
  for (const failed of report.failedCommands.slice(0, 3)) {
    if (failed.failures >= 3) signals.push({ id: 'failing-command', severity: failed.failures >= 6 ? 'high' : 'medium', values: { command: failed.command, failures: failed.failures } })
  }
  if (report.cost > 0) {
    for (const tool of report.tools.slice(0, 3)) {
      const share = tool.carriedCost / report.cost
      if (share >= 0.15) {
        signals.push({
          id: 'carried-tool',
          severity: share >= 0.3 ? 'high' : 'medium',
          values: { tool: tool.tool, share: percent(share), cost: Math.round(tool.carriedCost * 100) / 100, tokens: tool.resultTokens },
        })
      }
    }
    for (const skill of report.skills.slice(0, 2)) {
      const share = skill.carriedCost / report.cost
      if (share >= 0.1) signals.push({ id: 'skill-cost', severity: 'low', values: { skill: skill.skill, share: percent(share), uses: skill.uses } })
    }
    const subagentShare = report.subagentCost / report.cost
    if (subagentShare >= 0.4) signals.push({ id: 'subagent-share', severity: 'low', values: { share: percent(subagentShare) } })
  }
  for (const model of report.cache.models) {
    if (!model.recommended || !model.currentPolicy) continue
    // Ranked by what it saves of all cost, worded by what it saves of this model's prompts.
    const ofAll = report.cost > 0 ? model.saving / report.cost : 0
    if (ofAll < 0.02) continue
    signals.push({
      id: 'cache-policy',
      severity: ofAll >= 0.15 ? 'high' : ofAll >= 0.05 ? 'medium' : 'low',
      values: { model: model.model, policy: model.recommended, current: model.currentPolicy, cost: Math.round(model.saving * 100) / 100, share: percent(model.savingShare) },
    })
  }
  if (extra.compactingSessions > 0) {
    signals.push({ id: 'compactions', severity: 'low', values: { sessions: extra.compactingSessions, most: extra.maxCompactions } })
  }
  const order = { high: 0, medium: 1, low: 2 }
  return signals.sort((a, b) => order[a.severity] - order[b.severity])
}
