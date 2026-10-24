import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { ChevronDown, X } from 'lucide-react'
import type { ContextCategory, ContextCategoryId, ContextSnapshot, SnapshotModel } from '../../../../resources/context-snapshot'
import {
  boardTotals,
  childIsRunning,
  costSince,
  snapshotFromSummary,
  type AgentBoard,
  type AgentBoardRequest,
  type AgentKind,
  type AgentSessionSummary,
  type BoardTotals,
} from '../../../shared/agent-board'
import { pathsEqual } from '../../../shared/path-compare'
import type { SubagentTask, SubagentTaskStatus } from '../../../shared/subagent-task'
import { SubagentStatusIcon } from './subagent-task-row'
import {
  billingTable,
  cacheHitRate,
  cacheState,
  contextIsHigh,
  contextTokens,
  contextWindow,
  lastCall,
  nextCallEstimate,
  type BillingRow,
  type CacheState,
  type TokenKind,
} from '../../../shared/context-view'
import type { Translate } from '../../../shared/i18n'
import { useAppStore } from '../store'
import { formatCompact } from '../utils/format-compact'

/** The Context panel re-reads the session's snapshot this often while it is open. */
const SNAPSHOT_POLL_MS = 2_000
/** Reading every agent's session file costs more, so the board refreshes a little slower. */
const BOARD_POLL_MS = 3_000

const CATEGORY_LABEL_KEYS = {
  'system-prompt': 'chat.contextPanel.category.systemPrompt',
  'context-files': 'chat.contextPanel.category.contextFiles',
  skills: 'chat.contextPanel.category.skills',
  'built-in-tools': 'chat.contextPanel.category.builtInTools',
  'custom-tools': 'chat.contextPanel.category.customTools',
  'mcp-tools': 'chat.contextPanel.category.mcpTools',
  'user-messages': 'chat.contextPanel.category.userMessages',
  'assistant-messages': 'chat.contextPanel.category.assistantMessages',
  'assistant-thinking': 'chat.contextPanel.category.assistantThinking',
  'tool-calls': 'chat.contextPanel.category.toolCalls',
  'tool-results': 'chat.contextPanel.category.toolResults',
  'extension-messages': 'chat.contextPanel.category.extensionMessages',
  compacted: 'chat.contextPanel.category.compacted',
} as const satisfies Record<ContextCategoryId, string>

// One distinct color per category, in request order: prompt parts, tools, conversation.
const CATEGORY_COLORS: Record<ContextCategoryId, string> = {
  'system-prompt': 'bg-slate-400', /* theme-exempt: categorical palette */
  'context-files': 'bg-amber-500', /* theme-exempt: categorical palette */
  skills: 'bg-yellow-400', /* theme-exempt: categorical palette */
  'built-in-tools': 'bg-violet-500', /* theme-exempt: categorical palette */
  'custom-tools': 'bg-fuchsia-500', /* theme-exempt: categorical palette */
  'mcp-tools': 'bg-pink-500', /* theme-exempt: categorical palette */
  'user-messages': 'bg-sky-400', /* theme-exempt: categorical palette */
  'assistant-messages': 'bg-blue-500', /* theme-exempt: categorical palette */
  'assistant-thinking': 'bg-indigo-400', /* theme-exempt: categorical palette */
  'tool-calls': 'bg-teal-400', /* theme-exempt: categorical palette */
  'tool-results': 'bg-emerald-500', /* theme-exempt: categorical palette */
  'extension-messages': 'bg-orange-500', /* theme-exempt: categorical palette */
  compacted: 'bg-rose-400', /* theme-exempt: categorical palette */
}

const TOKEN_KIND_LABEL_KEYS = {
  input: 'chat.contextPanel.billing.input',
  cacheRead: 'chat.contextPanel.billing.cacheRead',
  cacheWrite: 'chat.contextPanel.billing.cacheWrite',
  output: 'chat.contextPanel.billing.output',
} as const satisfies Record<TokenKind, string>

function formatUsd(amount: number): string {
  if (amount === 0) return '$0'
  if (amount < 0.01) return `$${amount.toFixed(4)}`
  if (amount < 10) return `$${amount.toFixed(3)}`
  return `$${amount.toFixed(2)}`
}

/** "35s", "4m 12s", "1h 05m": active time. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/** "5m", "1h": a cache lifetime in the unit it is published in. */
function formatLifetime(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

function categoryLabelKey(id: string): (typeof CATEGORY_LABEL_KEYS)[ContextCategoryId] | null {
  return id in CATEGORY_LABEL_KEYS ? CATEGORY_LABEL_KEYS[id as ContextCategoryId] : null
}

/** The active session's context snapshot, re-read while the panel is open. */
function useContextSnapshot(sessionId: string | null): { snapshot: ContextSnapshot | null; loaded: boolean } {
  const [state, setState] = useState<{ sessionId: string | null; snapshot: ContextSnapshot | null; loaded: boolean }>({
    sessionId: null,
    snapshot: null,
    loaded: false,
  })
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    const load = (): void => {
      window.piDesktop.context.getSnapshot(sessionId)
        .then((snapshot) => {
          if (!cancelled) setState({ sessionId, snapshot, loaded: true })
        })
        .catch(() => {
          if (!cancelled) setState((previous) => ({ ...previous, sessionId, loaded: true }))
        })
    }
    load()
    const id = setInterval(load, SNAPSHOT_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [sessionId])
  // A snapshot of the previous session never shows under the new one.
  return state.sessionId === sessionId ? state : { snapshot: null, loaded: false }
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

/** The chat's agents board, re-read while the panel is open. */
function useAgentBoard(request: AgentBoardRequest | null): AgentBoard | null {
  const [state, setState] = useState<{ sessionId: string | null; board: AgentBoard | null }>({ sessionId: null, board: null })
  // Re-subscribe only when the request's content changes, not on every render.
  const key = request ? JSON.stringify(request) : null
  useEffect(() => {
    if (!key) return
    const parsed = JSON.parse(key) as AgentBoardRequest
    let cancelled = false
    const load = (): void => {
      window.piDesktop.context.getAgentBoard(parsed)
        .then((board) => {
          if (!cancelled) setState({ sessionId: parsed.sessionId, board })
        })
        .catch(() => {
          // Keep the last board; the next poll retries.
        })
    }
    load()
    const id = setInterval(load, BOARD_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [key])
  // A board of the previous chat never shows under the new one.
  return request && state.sessionId === request.sessionId ? state.board : null
}

/**
 * The model details for a subagent's last call, from the models the main
 * session could call: subagents inherit the main session's model list and
 * cache retention.
 */
function catalogModel(mainSnapshot: ContextSnapshot | null, summary: AgentSessionSummary): SnapshotModel | null {
  const call = summary.lastCall
  if (!mainSnapshot || !call) return mainSnapshot?.model ?? null
  const matches = (model: SnapshotModel): boolean => model.id === call.model && (!call.provider || !model.provider || model.provider === call.provider)
  return mainSnapshot.catalog?.find(matches) ?? (mainSnapshot.model && matches(mainSnapshot.model) ? mainSnapshot.model : null)
}

/** The session file a subagent row's transcript lives in, when it has one. */
function taskSessionFile(task: SubagentTask): string | null {
  return task.transcriptRef.kind === 'pi-foreground' ? task.transcriptRef.sessionFile ?? null : null
}

/** Right-side Context panel: every agent of this chat, what fills its context, its prompt cache, and what calls cost. */
export function ContextPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const sessionId = useAppStore((state) => state.sessionState?.sessionId ?? null)
  const sessionFile = useAppStore((state) => state.sessionState?.sessionFile ?? null)
  const tasks = useAppStore((state) => state.subagentTasks)
  const { snapshot, loaded } = useContextSnapshot(sessionId)
  const subagentFiles = useMemo(
    () => tasks.map(taskSessionFile).filter((file): file is string => file !== null).sort(),
    [tasks]
  )
  const request = useMemo<AgentBoardRequest | null>(
    () => (sessionId ? { sessionId, sessionFile, subagentSessionFiles: subagentFiles } : null),
    [sessionId, sessionFile, subagentFiles]
  )
  const board = useAgentBoard(request)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-medium text-secondary">{t('chat.contextPanel.title')}</span>
        <button
          type="button"
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded text-faint hover:text-muted"
          title={t('chat.contextPanel.close')}
          aria-label={t('chat.contextPanel.close')}
        >
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {!sessionId ? (
          <p className="py-6 text-center text-xs text-dim">{t('chat.contextPanel.noSession')}</p>
        ) : !snapshot && !board?.main ? (
          <p className="py-6 text-center text-xs text-dim">
            {loaded ? t('chat.contextPanel.noSnapshot') : t('chat.contextPanel.loading')}
          </p>
        ) : (
          <AgentBoardView snapshot={snapshot} board={board} tasks={tasks} />
        )}
      </div>
    </div>
  )
}

interface CardModel {
  key: string
  kind: AgentKind
  title: string
  subtitle: string | null
  status: SubagentTaskStatus
  /** The recorder's snapshot, or one built from the session file. */
  snapshot: ContextSnapshot
  summary: AgentSessionSummary | null
  /** True when the snapshot came from the recorder, so the breakdown includes the prompt and tools. */
  recorded: boolean
  /** Thinking level. */
  effort: string | null
}

function AgentBoardView({ snapshot, board, tasks }: {
  snapshot: ContextSnapshot | null
  board: AgentBoard | null
  tasks: SubagentTask[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const now = useNow(1_000)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const [finishedOpen, setFinishedOpen] = useState(true)
  const mainEffort = useAppStore((state) => state.sessionState?.thinkingLevel || null)
  const main = board?.main ?? null
  const mainSnapshot = snapshot ?? (main ? snapshotFromSummary(main, null, 'short') : null)
  const children = board?.children ?? []

  const matchedTaskIds = new Set<string>()
  const childCards: CardModel[] = children.map((child) => {
    const task = tasks.find((candidate) => {
      const file = taskSessionFile(candidate)
      return file !== null && pathsEqual(file, child.summary.sessionFile)
    })
    if (task) matchedTaskIds.add(task.id)
    const running = childIsRunning(child.summary, task ? task.status === 'running' : null, now)
    const status: SubagentTaskStatus = task && !running ? task.status : running ? 'running' : 'done'
    const agentName = task?.agent ?? child.agentName
    return {
      key: child.summary.sessionFile,
      kind: child.kind,
      title: child.summary.name ?? (agentName ? agentName : child.summary.label ?? child.summary.sessionId),
      subtitle: child.kind === 'worktree' && child.summary.cwd ? child.summary.cwd : child.summary.name ? null : agentName ? child.summary.label : null,
      status,
      snapshot: child.snapshot ?? snapshotFromSummary(child.summary, catalogModel(mainSnapshot, child.summary), mainSnapshot?.cacheRetention ?? 'short'),
      summary: child.summary,
      recorded: child.snapshot !== null,
      effort: child.summary.thinkingLevel,
    }
  })
  const liveTasks = tasks.filter((task) => !matchedTaskIds.has(task.id))
  const summaries = [...(main ? [main] : []), ...children.map((child) => child.summary)]
  const totals = boardTotals(summaries)
  const runningCards = childCards.filter((card) => card.status === 'running')
  const finishedCards = childCards.filter((card) => card.status !== 'running')
  const runningTasks = liveTasks.filter((task) => task.status === 'running')
  const finishedTasks = liveTasks.filter((task) => task.status !== 'running')
  const turnStart = mainSnapshot?.turnStartedAt ?? null
  const subagentTurnCost = children.reduce((sum, child) => sum + costSince(child.summary, turnStart), 0)

  return (
    <div className="flex flex-col gap-3">
      <BoardTiles
        totals={totals}
        totalTurns={summaries.reduce((sum, summary) => sum + summary.turns, 0)}
        running={runningCards.length + runningTasks.length + (isStreaming ? 1 : 0)}
        mainSnapshot={mainSnapshot}
        fallbackCost={mainSnapshot?.totals.cost ?? 0}
      />
      {totals.models.length > 0 && <ModelBreakdown models={totals.models} />}
      {mainSnapshot && (
        <AgentCard
          card={{
            key: 'main',
            kind: 'main',
            title: t('chat.contextPanel.agents.main'),
            subtitle: main?.name ?? main?.label ?? null,
            status: isStreaming ? 'running' : 'done',
            snapshot: mainSnapshot,
            summary: main,
            recorded: snapshot !== null,
            effort: mainEffort ?? main?.thinkingLevel ?? null,
          }}
          now={now}
          subagents={children.length > 0 ? { count: children.length, turnCost: subagentTurnCost } : undefined}
        />
      )}
      {(runningCards.length > 0 || runningTasks.length > 0) && (
        <section className="flex flex-col gap-2">
          <h3 className="text-[10px] font-medium uppercase tracking-wide text-dim">
            {t('chat.contextPanel.agents.running', { count: runningCards.length + runningTasks.length })}
          </h3>
          {runningCards.map((card) => <AgentCard key={card.key} card={card} now={now} />)}
          {runningTasks.map((task) => <TaskCard key={task.id} task={task} />)}
        </section>
      )}
      {(finishedCards.length > 0 || finishedTasks.length > 0) && (
        <section className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setFinishedOpen((value) => !value)}
            aria-expanded={finishedOpen}
            className="flex items-center gap-1 text-left text-[10px] font-medium uppercase tracking-wide text-dim hover:text-muted"
          >
            <ChevronDown size={11} className={clsx('transition-transform duration-150', finishedOpen ? 'rotate-0' : '-rotate-90')} />
            {t('chat.contextPanel.agents.finished', { count: finishedCards.length + finishedTasks.length })}
            {!finishedOpen && (
              <span className="ml-auto normal-case tracking-normal tabular-nums">
                {formatUsd(finishedCards.reduce((sum, card) => sum + (card.summary?.cost ?? 0), 0))}
              </span>
            )}
          </button>
          {finishedOpen && [...finishedCards].reverse().map((card) => <AgentCard key={card.key} card={card} now={now} />)}
          {finishedOpen && finishedTasks.map((task) => <TaskCard key={task.id} task={task} />)}
        </section>
      )}
    </div>
  )
}

function Tile({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: 'warning' }): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-md border border-border bg-surface px-2.5 py-2">
      <div className="truncate text-[10px] font-medium uppercase tracking-wide text-dim">{label}</div>
      <div className={clsx('mt-0.5 truncate text-sm font-semibold tabular-nums', tone === 'warning' ? 'text-warning' : 'text-primary')}>{value}</div>
      {detail && <div className="truncate text-[11px] text-dim tabular-nums">{detail}</div>}
    </div>
  )
}

function contextFigures(snapshot: ContextSnapshot): { tokens: number | null; windowTokens: number | null; percent: number | null; high: boolean } {
  const tokens = contextTokens(snapshot)
  const windowTokens = contextWindow(snapshot)
  const percent = tokens !== null && windowTokens ? Math.min(100, (tokens / windowTokens) * 100) : null
  return { tokens, windowTokens, percent, high: contextIsHigh(tokens, windowTokens) }
}

function BoardTiles({ totals, totalTurns, running, mainSnapshot, fallbackCost }: {
  totals: BoardTotals
  totalTurns: number
  running: number
  mainSnapshot: ContextSnapshot | null
  fallbackCost: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const context = mainSnapshot ? contextFigures(mainSnapshot) : null
  const agents = Math.max(1, totals.agents)
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <Tile
          label={t('chat.contextPanel.agents.tiles.cost')}
          value={formatUsd(totals.agents > 0 ? totals.cost : fallbackCost)}
          detail={`${t('chat.contextPanel.agents.tiles.agentCount', { count: agents })} · ${t('chat.contextPanel.agents.tiles.turns', { count: totalTurns })}`}
        />
        <Tile
          label={t('chat.contextPanel.agents.tiles.tokens')}
          value={formatCompact(totals.tokensIn + totals.tokensOut)}
          detail={t('chat.contextPanel.tiles.tokensDetail', { input: formatCompact(totals.tokensIn), output: formatCompact(totals.tokensOut) })}
        />
        <Tile
          label={t('chat.contextPanel.agents.tiles.time')}
          value={formatDuration(totals.activeMs)}
          detail={t('chat.contextPanel.agents.tiles.running', { count: running })}
        />
        <Tile
          label={t('chat.contextPanel.agents.tiles.mainContext')}
          value={context?.percent != null ? `${Math.round(context.percent)}%` : context?.tokens != null ? formatCompact(context.tokens) : '–'}
          detail={context?.tokens != null && context.windowTokens ? t('chat.contextPanel.tiles.contextOfWindow', { tokens: formatCompact(context.tokens), window: formatCompact(context.windowTokens) }) : undefined}
          tone={context?.high ? 'warning' : undefined}
        />
      </div>
      {context?.percent != null && <ContextBar percent={context.percent} high={context.high} />}
    </div>
  )
}

function ContextBar({ percent, high }: { percent: number; high: boolean }): React.JSX.Element {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-card" aria-hidden="true">
      <div className={clsx('h-full rounded-full', high ? 'bg-warning' : 'bg-success')} style={{ width: `${percent}%` }} />
    </div>
  )
}

function ModelBreakdown({ models }: { models: BoardTotals['models'] }): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex items-center gap-1 text-[11px] font-medium text-accent-fg hover:underline"
      >
        <ChevronDown size={11} className={clsx('transition-transform duration-150', open ? 'rotate-0' : '-rotate-90')} />
        {open ? t('chat.contextPanel.agents.models.hide') : t('chat.contextPanel.agents.models.show', { count: models.length })}
      </button>
      {open && (
        <table className="mt-1.5 w-full table-fixed text-[11px] tabular-nums">
          <caption className="sr-only">{t('chat.contextPanel.agents.models.caption')}</caption>
          <thead>
            <tr className="border-b border-border text-dim">
              <th scope="col" className="w-[38%] py-1 text-left font-medium">{t('chat.contextPanel.agents.models.model')}</th>
              <th scope="col" className="py-1 text-right font-medium">{t('chat.contextPanel.agents.models.agents')}</th>
              <th scope="col" className="py-1 text-right font-medium">{t('chat.contextPanel.agents.models.calls')}</th>
              <th scope="col" className="py-1 text-right font-medium">{t('chat.contextPanel.agents.models.tokens')}</th>
              <th scope="col" className="py-1 text-right font-medium">{t('chat.contextPanel.agents.models.cost')}</th>
            </tr>
          </thead>
          <tbody>
            {models.map((model) => (
              <tr key={`${model.provider}/${model.model}`} className="border-b border-border/50 text-secondary">
                <th scope="row" className="truncate py-1 text-left font-normal" title={model.provider ? `${model.provider}/${model.model}` : model.model}>
                  {model.model || t('chat.contextPanel.agents.models.compaction')}
                </th>
                <td className="py-1 text-right">{model.agents}</td>
                <td className="py-1 text-right">{model.calls}</td>
                <td className="truncate py-1 text-right">{`${formatCompact(model.input + model.cacheRead + model.cacheWrite)} / ${formatCompact(model.output)}`}</td>
                <td className="py-1 text-right">{formatUsd(model.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

const KIND_LABEL_KEYS = {
  main: 'chat.contextPanel.agents.kind.main',
  subagent: 'chat.contextPanel.agents.kind.subagent',
  worktree: 'chat.contextPanel.agents.kind.worktree',
  child: 'chat.contextPanel.agents.kind.child',
} as const satisfies Record<AgentKind, string>

function InfoBlock({ label, value, detail, title }: { label: string; value: string; detail?: string; title?: string }): React.JSX.Element {
  return (
    <div className="min-w-0 rounded border border-border bg-card/40 px-2 py-1" title={title}>
      <div className="truncate text-[10px] uppercase tracking-wide text-dim">{label}</div>
      <div className="truncate text-xs font-semibold text-primary">{value}</div>
      {detail && <div className="truncate text-[10px] text-dim">{detail}</div>}
    </div>
  )
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: 'warning' }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10px] uppercase tracking-wide text-dim">{label}</div>
      <div className={clsx('truncate text-xs font-semibold tabular-nums', tone === 'warning' ? 'text-warning' : 'text-primary')}>{value}</div>
      {detail && <div className="truncate text-[10px] text-dim">{detail}</div>}
    </div>
  )
}

/**
 * One agent at a glance: models, context, tokens, cost, time, tools and its
 * prompt cache; the full cache, billing and context breakdown open below.
 */
function AgentCard({ card, now, subagents }: {
  card: CardModel
  now: number
  subagents?: { count: number; turnCost: number }
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const { snapshot, summary } = card
  const context = contextFigures(snapshot)
  const cache = cacheState(snapshot, now)
  const estimate = nextCallEstimate(snapshot)
  const live = cache.status === 'warm' || cache.status === 'expiring'
  // A finished subagent's cache is never read again, and one with no known lifetime has no countdown.
  const showCache = card.kind === 'main' || (card.status === 'running' && cache.status !== 'unknown')
  const models = (summary?.models ?? []).filter((model) => model.model)
  // The model the next call goes to: the recorder knows it, else the last call or switch.
  const currentId = (card.recorded ? snapshot.model?.id : null) ?? summary?.lastCall?.model ?? summary?.selectedModel?.model ?? snapshot.model?.id ?? null
  const currentModel = snapshot.model && snapshot.model.id === currentId ? snapshot.model.name : currentId
  const otherModels = models.filter((model) => model.model !== currentId).length
  const cost = summary?.cost ?? snapshot.totals.cost
  const tokensIn = summary ? summary.input + summary.cacheRead + summary.cacheWrite : snapshot.totals.input + snapshot.totals.cacheRead + snapshot.totals.cacheWrite
  const tokensOut = summary?.output ?? snapshot.totals.output

  return (
    <article className={clsx('rounded-md border bg-surface px-2.5 py-2', card.kind === 'main' ? 'border-accent/40' : 'border-border')}>
      <header className="flex items-center gap-1.5">
        <SubagentStatusIcon status={card.status} />
        <h4 className="min-w-0 flex-1 truncate text-xs font-semibold text-primary" title={card.title}>{card.title}</h4>
        {card.kind !== 'main' && (
          <span className="shrink-0 rounded bg-card px-1.5 py-px text-[10px] text-dim">{t(KIND_LABEL_KEYS[card.kind])}</span>
        )}
      </header>
      {card.subtitle && <p className="mt-0.5 truncate text-[11px] text-dim" title={card.subtitle}>{card.subtitle}</p>}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <InfoBlock
          label={t('chat.contextPanel.agents.card.model')}
          value={currentModel ?? '–'}
          detail={otherModels > 0 ? t('chat.contextPanel.agents.card.otherModels', { count: otherModels }) : undefined}
          title={models.map((model) => model.model).join('\n') || undefined}
        />
        <InfoBlock label={t('chat.contextPanel.agents.card.effort')} value={card.effort ?? '–'} />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-x-2 gap-y-1.5">
        <Metric
          label={t('chat.contextPanel.tiles.context')}
          value={context.percent !== null ? `${Math.round(context.percent)}%` : context.tokens !== null ? formatCompact(context.tokens) : '–'}
          detail={context.percent !== null && context.tokens !== null ? formatCompact(context.tokens) : undefined}
          tone={context.high ? 'warning' : undefined}
        />
        <Metric
          label={t('chat.contextPanel.tiles.tokens')}
          value={`${formatCompact(tokensIn)} / ${formatCompact(tokensOut)}`}
          detail={t('chat.contextPanel.agents.card.inOut')}
        />
        <Metric label={t('chat.contextPanel.agents.card.cost')} value={formatUsd(cost)} detail={summary ? t('chat.contextPanel.agents.tiles.turns', { count: summary.turns }) : undefined} />
        <Metric label={t('chat.contextPanel.agents.card.time')} value={summary ? formatDuration(summary.activeMs) : '–'} />
        <div className="col-span-2 min-w-0">
          <Metric
            label={t('chat.contextPanel.agents.card.tools')}
            value={summary ? String(summary.toolCalls) : '–'}
            detail={summary?.lastTool ? t('chat.contextPanel.agents.card.lastTool', { tool: summary.lastTool }) : undefined}
          />
        </div>
      </div>
      {context.percent !== null && <div className="mt-1.5"><ContextBar percent={context.percent} high={context.high} /></div>}
      {showCache && <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/60 pt-1.5 text-[11px] tabular-nums">
        <span className={clsx('font-medium', cache.status === 'warm' ? 'text-success' : cache.status === 'expiring' ? 'text-warning' : 'text-dim')} role="timer" aria-live="off">
          {cacheStatusText(cache, t)}
        </span>
        <span className="truncate text-dim">
          {live
            ? t('chat.contextPanel.agents.card.nextWarm', { cost: estimate.warm !== null ? formatUsd(estimate.warm) : '–' })
            : cache.status !== 'none' ? t('chat.contextPanel.agents.card.nextCold', { cost: estimate.cold !== null ? formatUsd(estimate.cold) : '–' }) : ''}
        </span>
      </div>}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="mt-1.5 flex items-center gap-1 text-[11px] text-accent-fg hover:underline"
      >
        <ChevronDown size={11} className={clsx('transition-transform duration-150', open ? 'rotate-0' : '-rotate-90')} />
        {open ? t('chat.contextPanel.agents.card.hideDetails') : showCache ? t('chat.contextPanel.agents.card.details') : t('chat.contextPanel.agents.card.detailsNoCache')}
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-3">
          <PromptCacheBlock snapshot={snapshot} cache={cache} subagents={subagents} showCache={showCache} />
          <ContextBreakdownView snapshot={snapshot} partial={!card.recorded} />
        </div>
      )}
    </article>
  )
}

/** A subagent row with no saved session to read (still starting, or an engine that keeps none). */
function TaskCard({ task }: { task: SubagentTask }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <article className="rounded-md border border-border bg-surface px-2.5 py-2">
      <header className="flex items-center gap-1.5">
        <SubagentStatusIcon status={task.status} />
        <h4 className="min-w-0 flex-1 truncate text-xs font-semibold text-primary">{task.agent}</h4>
        <span className="shrink-0 rounded bg-card px-1.5 py-px text-[10px] text-dim">{t(KIND_LABEL_KEYS.subagent)}</span>
      </header>
      {task.label && <p className="mt-0.5 truncate text-[11px] text-dim" title={task.label}>{task.label}</p>}
      <div className="mt-2 grid grid-cols-3 gap-x-2">
        <Metric label={t('chat.contextPanel.tiles.tokens')} value={task.tokens !== undefined ? formatCompact(task.tokens) : '–'} />
        <Metric label={t('chat.contextPanel.agents.card.time')} value={task.durationMs !== undefined ? formatDuration(task.durationMs) : '–'} />
        <Metric
          label={t('chat.contextPanel.agents.card.tools')}
          value={task.toolCount !== undefined ? String(task.toolCount) : '–'}
          detail={task.currentTool ? t('chat.contextPanel.agents.card.lastTool', { tool: task.currentTool }) : undefined}
        />
      </div>
      <p className="mt-1.5 text-[10px] text-faint">{t('chat.contextPanel.agents.card.noSessionFile')}</p>
    </article>
  )
}

function cacheStatusText(cache: CacheState, t: Translate): string {
  switch (cache.status) {
    case 'none':
      return t('chat.contextPanel.cache.none')
    case 'unknown':
      return t('chat.contextPanel.cache.unknown')
    case 'model-changed':
      return t('chat.contextPanel.cache.modelChanged')
    case 'cold':
      return t('chat.contextPanel.cache.cold')
    case 'warm':
    case 'expiring':
      return t('chat.contextPanel.cache.warmLeft', { time: formatCountdown(cache.remainingMs ?? 0) })
  }
}

interface SubagentCost {
  count: number
  /** What the chat's other agents spent since its latest prompt. */
  turnCost: number
}

function PromptCacheBlock({ snapshot, cache, subagents, showCache = true }: {
  snapshot: ContextSnapshot
  cache: CacheState
  subagents?: SubagentCost
  showCache?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const estimate = nextCallEstimate(snapshot)
  const billing = billingTable(snapshot)
  const call = lastCall(snapshot)
  const hitRate = call ? cacheHitRate(call) : null
  const fraction = cache.remainingMs !== null && cache.lifetimeSeconds
    ? cache.remainingMs / (cache.lifetimeSeconds * 1000)
    : 0
  const live = cache.status === 'warm' || cache.status === 'expiring'

  if (!showCache) {
    return (
      <section className="rounded-md border border-border bg-surface px-2.5 py-2.5">
        <h3 className="text-[10px] font-medium uppercase tracking-wide text-dim">{t('chat.contextPanel.billing.title')}</h3>
        <BillingTableView rows={billing.rows} lastTotal={billing.lastTotal} turnTotal={billing.turnTotal} />
      </section>
    )
  }

  return (
    <section className="rounded-md border border-border bg-surface px-2.5 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[10px] font-medium uppercase tracking-wide text-dim">
          {cache.lifetimeSeconds
            ? t('chat.contextPanel.cache.titleWithLifetime', { lifetime: formatLifetime(cache.lifetimeSeconds) })
            : t('chat.contextPanel.cache.title')}
        </h3>
        <span
          className={clsx(
            'text-xs font-medium tabular-nums',
            cache.status === 'warm' ? 'text-success' : cache.status === 'expiring' ? 'text-warning' : 'text-dim'
          )}
          role="timer"
          aria-live="off"
        >
          {cacheStatusText(cache, t)}
        </span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-card" aria-hidden="true">
        {live && (
          <div
            className={clsx('h-full rounded-full', cache.status === 'expiring' ? 'bg-warning' : 'bg-success')}
            style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%` }}
          />
        )}
      </div>

      <div className="mt-2.5 grid grid-cols-3 gap-2">
        <CacheFigure
          label={t('chat.contextPanel.cache.nextWarm')}
          value={estimate.warm !== null ? formatUsd(estimate.warm) : '–'}
          detail={t('chat.contextPanel.cache.nextWarmDetail')}
          emphasized={live}
        />
        <CacheFigure
          label={t('chat.contextPanel.cache.nextCold')}
          value={estimate.cold !== null ? formatUsd(estimate.cold) : '–'}
          detail={t('chat.contextPanel.cache.nextColdDetail')}
          emphasized={!live && cache.status !== 'none'}
        />
        <CacheFigure
          label={t('chat.contextPanel.cache.thisTurn')}
          value={formatUsd(billing.turnTotal)}
          detail={t('chat.contextPanel.tiles.calls', { count: billing.turnCallCount })}
        />
      </div>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-dim">
        {hitRate !== null && (
          <span>{t('chat.contextPanel.cache.hitRate', { percent: Math.round(hitRate * 100) })}</span>
        )}
        {snapshot.cacheWarming && (
          <span>{t('chat.contextPanel.cache.warming', { mode: snapshot.cacheWarming })}</span>
        )}
      </div>

      <BillingTableView rows={billing.rows} lastTotal={billing.lastTotal} turnTotal={billing.turnTotal} subagents={subagents} />
    </section>
  )
}

function CacheFigure({ label, value, detail, emphasized }: { label: string; value: string; detail: string; emphasized?: boolean }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10px] uppercase tracking-wide text-dim">{label}</div>
      <div className={clsx('truncate text-sm font-semibold tabular-nums', emphasized ? 'text-primary' : 'text-secondary')}>{value}</div>
      <div className="truncate text-[11px] text-dim">{detail}</div>
    </div>
  )
}

function BillingTableView({ rows, lastTotal, turnTotal, subagents }: { rows: BillingRow[]; lastTotal: number; turnTotal: number; subagents?: SubagentCost }): React.JSX.Element {
  const { t } = useTranslation()
  const cell = (tokens: number, cost: number): string => `${formatCompact(tokens)} · ${formatUsd(cost)}`
  return (
    <table className="mt-3 w-full table-fixed text-[11px] tabular-nums">
      <caption className="sr-only">{t('chat.contextPanel.billing.caption')}</caption>
      <thead>
        <tr className="border-b border-border text-dim">
          <th scope="col" className="w-[30%] py-1 text-left font-medium">{t('chat.contextPanel.billing.tokenType')}</th>
          <th scope="col" className="w-[18%] py-1 text-right font-medium">{t('chat.contextPanel.billing.rate')}</th>
          <th scope="col" className="py-1 text-right font-medium">{t('chat.contextPanel.billing.lastCall')}</th>
          <th scope="col" className="py-1 text-right font-medium">{t('chat.contextPanel.billing.thisTurn')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.kind} className="border-b border-border/50 text-secondary">
            <th scope="row" className="truncate py-1 text-left font-normal">{t(TOKEN_KIND_LABEL_KEYS[row.kind])}</th>
            <td className="py-1 text-right text-dim">{row.rate !== null ? row.rate.toFixed(2) : '–'}</td>
            <td className="truncate py-1 text-right">{cell(row.lastTokens, row.lastCost)}</td>
            <td className="truncate py-1 text-right">{cell(row.turnTokens, row.turnCost)}</td>
          </tr>
        ))}
        <tr className="font-semibold text-primary">
          <th scope="row" className="py-1 text-left">{t('chat.contextPanel.billing.total')}</th>
          <td />
          <td className="py-1 text-right">{formatUsd(lastTotal)}</td>
          <td className="py-1 text-right">{formatUsd(turnTotal)}</td>
        </tr>
        {subagents && (
          <>
            <tr className="border-t border-border/50 text-secondary">
              <th scope="row" className="truncate py-1 text-left font-normal">{t('chat.contextPanel.billing.subagents', { count: subagents.count })}</th>
              <td />
              <td className="py-1 text-right text-dim">–</td>
              <td className="py-1 text-right">{formatUsd(subagents.turnCost)}</td>
            </tr>
            <tr className="font-semibold text-primary">
              <th scope="row" className="py-1 text-left">{t('chat.contextPanel.billing.totalWithSubagents')}</th>
              <td />
              <td />
              <td className="py-1 text-right">{formatUsd(turnTotal + subagents.turnCost)}</td>
            </tr>
          </>
        )}
      </tbody>
    </table>
  )
}

function ContextBreakdownView({ snapshot, partial = false }: { snapshot: ContextSnapshot; partial?: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const [openId, setOpenId] = useState<string | null>(null)
  const breakdown = snapshot.breakdown
  const windowTokens = contextWindow(snapshot)
  // A session file has no system prompt or tools: what the last call really
  // sent beyond the conversation is shown as one share of its own.
  const reported = contextTokens(snapshot)
  const unattributed = partial && breakdown && reported !== null ? Math.max(0, reported - breakdown.estimatedTokens) : 0
  const filled = (breakdown?.estimatedTokens ?? 0) + unattributed
  // The bar spans the window when it is known, else what fills it.
  const span = windowTokens && windowTokens > filled ? windowTokens : filled

  if (!breakdown || breakdown.categories.length === 0) {
    return (
      <section>
        <h3 className="pb-1 text-[11px] font-medium text-dim">{t('chat.contextPanel.breakdown.title')}</h3>
        <p className="text-xs text-dim">{t('chat.contextPanel.breakdown.empty')}</p>
      </section>
    )
  }

  const free = windowTokens ? Math.max(0, windowTokens - filled) : null
  return (
    <section>
      <div className="flex items-baseline justify-between gap-2 pb-1.5">
        <h3 className="text-[11px] font-medium text-dim">{t('chat.contextPanel.breakdown.title')}</h3>
        <span className="text-[11px] text-dim tabular-nums">
          {t('chat.contextPanel.breakdown.estimated', { tokens: formatCompact(breakdown.estimatedTokens) })}
        </span>
      </div>
      <div className="flex h-3 overflow-hidden rounded-sm bg-card" role="img" aria-label={t('chat.contextPanel.breakdown.barLabel')}>
        {breakdown.categories.map((category) => (
          <div
            key={category.id}
            className={clsx('h-full', CATEGORY_COLORS[category.id] ?? 'bg-elevated')}
            style={{ width: `${span > 0 ? (category.tokens / span) * 100 : 0}%` }}
            title={`${categoryLabel(category, t)}: ${formatCompact(category.tokens)}`}
          />
        ))}
        {unattributed > 0 && (
          <div
            className="h-full bg-elevated"
            style={{ width: `${span > 0 ? (unattributed / span) * 100 : 0}%` }}
            title={`${t('chat.contextPanel.breakdown.unattributed')}: ${formatCompact(unattributed)}`}
          />
        )}
      </div>
      <ul className="mt-2 flex flex-col">
        {breakdown.categories.map((category) => (
          <CategoryRow
            key={category.id}
            category={category}
            span={span}
            open={openId === category.id}
            onToggle={() => setOpenId((current) => (current === category.id ? null : category.id))}
          />
        ))}
        {unattributed > 0 && (
          <li className="flex items-center gap-2 px-1 py-1 text-xs text-secondary">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm bg-elevated" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate" title={t('chat.contextPanel.breakdown.unattributedDetail')}>{t('chat.contextPanel.breakdown.unattributed')}</span>
            <span className="tabular-nums">{formatCompact(unattributed)}</span>
            <span className="w-10 text-right tabular-nums text-dim">{span > 0 ? `${Math.round((unattributed / span) * 100)}%` : ''}</span>
            <span className="w-[11px] shrink-0" aria-hidden="true" />
          </li>
        )}
        {free !== null && (
          <li className="flex items-center gap-2 px-1 py-1 text-xs text-dim">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm bg-card" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{t('chat.contextPanel.breakdown.free')}</span>
            <span className="tabular-nums">{formatCompact(free)}</span>
            <span className="w-10 text-right tabular-nums">{span > 0 ? `${Math.round((free / span) * 100)}%` : ''}</span>
          </li>
        )}
      </ul>
      <p className="mt-2 text-[11px] text-faint">
        {partial
          ? t('chat.contextPanel.breakdown.conversationOnly')
          : breakdown.fromSession ? t('chat.contextPanel.breakdown.fromSession') : t('chat.contextPanel.breakdown.note')}
      </p>
    </section>
  )
}

function categoryLabel(category: ContextCategory, t: Translate): string {
  const key = categoryLabelKey(category.id)
  return key ? t(key) : category.id
}

function CategoryRow({ category, span, open, onToggle }: {
  category: ContextCategory
  span: number
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const share = span > 0 ? Math.round((category.tokens / span) * 100) : 0
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs text-secondary hover:bg-highlight"
      >
        <span className={clsx('h-2.5 w-2.5 shrink-0 rounded-sm', CATEGORY_COLORS[category.id] ?? 'bg-elevated')} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{categoryLabel(category, t)}</span>
        <span className="tabular-nums">{formatCompact(category.tokens)}</span>
        <span className="w-10 text-right tabular-nums text-dim">{`${share}%`}</span>
        <ChevronDown size={11} className={clsx('shrink-0 text-faint transition-transform duration-150', open ? 'rotate-0' : '-rotate-90')} />
      </button>
      {open && (
        <ul className="mb-1 ml-[18px] border-l border-border pl-2">
          {category.items.map((entry, index) => (
            <li
              key={`${entry.label}-${index}`}
              className="flex items-center gap-2 py-0.5 text-[11px] text-dim"
              title={entry.preview}
            >
              <span className="min-w-0 flex-1 truncate text-secondary">{entry.label}</span>
              {entry.count !== undefined && entry.count > 1 && (
                <span className="shrink-0 tabular-nums">{t('chat.contextPanel.breakdown.count', { count: entry.count })}</span>
              )}
              <span className="shrink-0 tabular-nums">{formatCompact(entry.tokens)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}
