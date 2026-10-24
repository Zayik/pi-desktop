import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { ChevronDown, X } from 'lucide-react'
import type { ContextCategory, ContextCategoryId, ContextSnapshot } from '../../../../resources/context-snapshot'
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

/** Right-side Context panel: what fills this session's context, its prompt cache, and what calls cost. */
export function ContextPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const sessionId = useAppStore((state) => state.sessionState?.sessionId ?? null)
  const { snapshot, loaded } = useContextSnapshot(sessionId)

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
        ) : !snapshot ? (
          <p className="py-6 text-center text-xs text-dim">
            {loaded ? t('chat.contextPanel.noSnapshot') : t('chat.contextPanel.loading')}
          </p>
        ) : (
          <ContextSnapshotView snapshot={snapshot} />
        )}
      </div>
    </div>
  )
}

function ContextSnapshotView({ snapshot }: { snapshot: ContextSnapshot }): React.JSX.Element {
  const now = useNow(1_000)
  const cache = cacheState(snapshot, now)
  return (
    <div className="flex flex-col gap-4">
      <SummaryTiles snapshot={snapshot} />
      <PromptCacheBlock snapshot={snapshot} cache={cache} />
      <ContextBreakdownView snapshot={snapshot} />
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

function SummaryTiles({ snapshot }: { snapshot: ContextSnapshot }): React.JSX.Element {
  const { t } = useTranslation()
  const tokens = contextTokens(snapshot)
  const windowTokens = contextWindow(snapshot)
  const percent = tokens !== null && windowTokens ? Math.min(100, (tokens / windowTokens) * 100) : null
  const high = contextIsHigh(tokens, windowTokens)
  const { totals } = snapshot
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <Tile
          label={t('chat.contextPanel.tiles.context')}
          value={percent !== null ? `${Math.round(percent)}%` : tokens !== null ? formatCompact(tokens) : '–'}
          detail={tokens !== null && windowTokens ? t('chat.contextPanel.tiles.contextOfWindow', { tokens: formatCompact(tokens), window: formatCompact(windowTokens) }) : undefined}
          tone={high ? 'warning' : undefined}
        />
        <Tile
          label={t('chat.contextPanel.tiles.cost')}
          value={formatUsd(totals.cost)}
          detail={t('chat.contextPanel.tiles.calls', { count: totals.calls })}
        />
        <Tile
          label={t('chat.contextPanel.tiles.tokens')}
          value={formatCompact(totals.input + totals.output + totals.cacheRead + totals.cacheWrite)}
          detail={t('chat.contextPanel.tiles.tokensDetail', { input: formatCompact(totals.input + totals.cacheRead + totals.cacheWrite), output: formatCompact(totals.output) })}
        />
        <Tile
          label={t('chat.contextPanel.tiles.model')}
          value={snapshot.model?.name ?? '–'}
          detail={snapshot.model?.provider || undefined}
        />
      </div>
      {percent !== null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-card" aria-hidden="true">
          <div className={clsx('h-full rounded-full', high ? 'bg-warning' : 'bg-success')} style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
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

function PromptCacheBlock({ snapshot, cache }: { snapshot: ContextSnapshot; cache: CacheState }): React.JSX.Element {
  const { t } = useTranslation()
  const estimate = nextCallEstimate(snapshot)
  const billing = billingTable(snapshot)
  const call = lastCall(snapshot)
  const hitRate = call ? cacheHitRate(call) : null
  const fraction = cache.remainingMs !== null && cache.lifetimeSeconds
    ? cache.remainingMs / (cache.lifetimeSeconds * 1000)
    : 0
  const live = cache.status === 'warm' || cache.status === 'expiring'

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

      <BillingTableView rows={billing.rows} lastTotal={billing.lastTotal} turnTotal={billing.turnTotal} />
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

function BillingTableView({ rows, lastTotal, turnTotal }: { rows: BillingRow[]; lastTotal: number; turnTotal: number }): React.JSX.Element {
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
      </tbody>
    </table>
  )
}

function ContextBreakdownView({ snapshot }: { snapshot: ContextSnapshot }): React.JSX.Element {
  const { t } = useTranslation()
  const [openId, setOpenId] = useState<string | null>(null)
  const breakdown = snapshot.breakdown
  const windowTokens = contextWindow(snapshot)
  // The bar spans the window when it is known, else the estimate itself.
  const span = useMemo(() => {
    const estimated = breakdown?.estimatedTokens ?? 0
    return windowTokens && windowTokens > estimated ? windowTokens : estimated
  }, [breakdown, windowTokens])

  if (!breakdown || breakdown.categories.length === 0) {
    return (
      <section>
        <h3 className="pb-1 text-[11px] font-medium text-dim">{t('chat.contextPanel.breakdown.title')}</h3>
        <p className="text-xs text-dim">{t('chat.contextPanel.breakdown.empty')}</p>
      </section>
    )
  }

  const free = windowTokens ? Math.max(0, windowTokens - breakdown.estimatedTokens) : null
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
        {breakdown.fromSession ? t('chat.contextPanel.breakdown.fromSession') : t('chat.contextPanel.breakdown.note')}
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
