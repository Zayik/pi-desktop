import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import {
  SLOTS_PER_DAY,
  SLOT_MS,
  dayStarts,
  optimalCounts,
  slotBest,
  slotCosts,
  slotNoCache,
  summarize,
  type CacheAnalysis,
  type CacheConfidence,
  type CacheGroupAnalysis,
  type CacheGroupId,
  type CacheModelAnalysis,
  type PingSummary,
} from '../../../shared/cache-analysis'
import { CACHE_RULES_CHECKED } from '../../../shared/cache-policy'
import type { Translate } from '../../../shared/i18n'

const MINUTE = 60_000
/** Points per line; longer windows are sampled down to this. */
const MAX_POINTS = 1200
const RECENT_DAYS = 7
/** Day buttons under the chart up to this many days; longer windows pick a day by clicking the chart. */
const MAX_DAY_BUTTONS = 31

const LIFETIME_KEYS = {
  '5m': 'analytics.promptCache.lifetime.fiveMinutes',
  '30m': 'analytics.promptCache.lifetime.thirtyMinutes',
  automatic: 'analytics.promptCache.lifetime.automatic',
} as const satisfies Record<CacheGroupId, string>

const CONFIDENCE_KEYS = {
  none: 'analytics.promptCache.confidence.none',
  early: 'analytics.promptCache.confidence.early',
  solid: 'analytics.promptCache.confidence.solid',
} as const satisfies Record<CacheConfidence, string>

const CONFIDENCE_CLASSES: Record<CacheConfidence, string> = {
  none: 'bg-card text-dim',
  early: 'bg-warning-bg text-warning',
  solid: 'bg-success-bg text-success',
}

/** One color per ping count, shared by the chart, its legend and the table headings. */
const PING_COLORS = [
  { stroke: 'stroke-muted', fill: 'bg-muted', text: 'text-muted' },
  { stroke: 'stroke-sky-400', fill: 'bg-sky-400', text: 'text-sky-400' }, // theme-exempt: one hue per ping count
  { stroke: 'stroke-teal-400', fill: 'bg-teal-400', text: 'text-teal-400' }, // theme-exempt
  { stroke: 'stroke-lime-400', fill: 'bg-lime-400', text: 'text-lime-400' }, // theme-exempt
  { stroke: 'stroke-amber-400', fill: 'bg-amber-400', text: 'text-amber-400' }, // theme-exempt
  { stroke: 'stroke-orange-400', fill: 'bg-orange-400', text: 'text-orange-400' }, // theme-exempt
  { stroke: 'stroke-rose-400', fill: 'bg-rose-400', text: 'text-rose-400' }, // theme-exempt
]
const ALL_KEY = '*'
const NO_CACHE = 'noCache'
const PER_BREAK = 'perBreak'
const PER_MODEL = 'perModel'

export function money(amount: number, signed = false): string {
  const text = `$${Math.abs(amount).toFixed(2)}`
  if (!signed || Math.abs(amount) < 0.005) return text
  return amount < 0 ? `−${text}` : `+${text}`
}

function modelName(model: string): string {
  return model.split('/').slice(1).join('/') || model
}

function pingsLabel(count: number, t: Translate): string {
  return count === 0 ? t('analytics.promptCache.noPings') : t('analytics.promptCache.pings', { count })
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function addInto(total: number[], values: number[]): number[] {
  for (let index = 0; index < values.length; index++) total[index] += values[index]
  return total
}

/** The lowest index of the smallest value; ties go to fewer pings. */
function cheapest(values: number[]): number {
  let best = 0
  for (let index = 1; index < values.length; index++) if (values[index] < values[best] - 1e-12) best = index
  return best
}

function niceStep(raw: number): number {
  const power = Math.pow(10, Math.floor(Math.log10(raw)))
  const fraction = raw / power
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power
}

type ChartMode = 'saving' | 'total'

interface ModelEntry {
  model: CacheModelAnalysis
  group: CacheGroupAnalysis
  summary: PingSummary
  /** The recommended fixed count: its own cheapest, or its group's while it has too few breaks. */
  optimal: number
}

/** Weekly prompt cost for one table row: per ping count (null past what Pi sends), at each break's best count, and with no cache. */
interface CostRow {
  counts: Array<number | null>
  perBreak: number | null
  noCache: number | null
}

interface Line {
  key: string
  label: string
  stroke: string
  style: 'solid' | 'dashed' | 'dotted'
  width: number
  /** Per slot: the cost (total) or the cost minus no pings (saving). */
  steps: number[]
  badge?: string
}

function costRow(entry: ModelEntry, maxPings: number, weeks: number): CostRow {
  const { summary, group } = entry
  const warmable = group.id !== 'automatic'
  return {
    counts: Array.from({ length: maxPings + 1 }, (_, count) => count <= (warmable ? group.maxPings : 0) ? (summary.baseTotal + summary.totals[count]) / weeks : null),
    perBreak: warmable ? (summary.baseTotal + summary.perBreakTotal) / weeks : null,
    noCache: summary.noCacheTotal > 0 ? summary.noCacheTotal / weeks : null,
  }
}

/** Prompt cost per model at every ping count, with a running-cost chart for the model you pick; read only. */
export function PromptCacheAnalysis({ analysis }: { analysis: CacheAnalysis }): React.JSX.Element | null {
  const { t, i18n } = useTranslation()
  const [mode, setMode] = useState<ChartMode>('total')
  const [picked, setPicked] = useState<string | null>(null)
  const [hidden, setHidden] = useState<string[]>([NO_CACHE])
  const [selectedDay, setSelectedDay] = useState<number | null>(null)
  const days = useMemo(() => dayStarts(analysis.from, analysis.to), [analysis.from, analysis.to])
  const maxPings = Math.max(0, ...analysis.groups.map((group) => group.maxPings))
  const slots = days.length * SLOTS_PER_DAY
  const weeks = Math.max(analysis.days, 1) / 7

  const entries = useMemo(() => {
    const optimal = optimalCounts(analysis)
    return analysis.groups
      .flatMap((group) => group.models.map((model) => ({ model, group })))
      .sort((a, b) => b.model.calls - a.model.calls)
      .map(({ model, group }): ModelEntry => ({
        model,
        group,
        summary: summarize([model], group.maxPings, analysis.days),
        optimal: optimal.get(model.model) ?? 0,
      }))
  }, [analysis])

  // Open on the most used model that can be warmed and ran in the last week.
  const defaultKey = useMemo(() => {
    const recentFrom = analysis.to - RECENT_DAYS * 24 * 60 * MINUTE
    const ranRecently = (entry: ModelEntry): boolean => entry.model.base.some(([at]) => at >= recentFrom) || entry.model.gaps.some((gap) => gap.at >= recentFrom)
    const warmable = entries.filter((entry) => entry.group.id !== 'automatic')
    return (warmable.find(ranRecently) ?? warmable[0] ?? entries[0])?.model.model ?? ALL_KEY
  }, [entries, analysis.to])
  const selected = picked ?? defaultKey
  const chartEntries = useMemo(() => selected === ALL_KEY ? entries : entries.filter((entry) => entry.model.model === selected), [entries, selected])
  const chartMax = Math.max(0, ...chartEntries.map((entry) => entry.group.id === 'automatic' ? 0 : entry.group.maxPings))

  const series = useMemo(() => {
    const counts = Array.from({ length: chartMax + 1 }, () => new Array<number>(slots).fill(0))
    const perBreak = new Array<number>(slots).fill(0)
    const perModel = new Array<number>(slots).fill(0)
    const noCache = new Array<number>(slots).fill(0)
    for (const entry of chartEntries) {
      const own = entry.group.id === 'automatic' ? 0 : entry.group.maxPings
      const byCount = Array.from({ length: own + 1 }, (_, count) => slotCosts(entry.model, count, analysis.from, slots).cost)
      counts.forEach((total, count) => addInto(total, byCount[Math.min(count, own)]))
      addInto(perBreak, own > 0 ? slotCosts(entry.model, 'perBreak', analysis.from, slots).cost : byCount[0])
      addInto(perModel, byCount[Math.min(entry.optimal, own)])
      addInto(noCache, slotNoCache(entry.model, analysis.from, slots))
    }
    return { counts, perBreak, perModel, noCache }
  }, [chartEntries, chartMax, analysis.from, slots])

  if (entries.length === 0) return null
  const multi = entries.length > 1
  const single = selected === ALL_KEY ? null : chartEntries[0] ?? null
  const recommended = single && single.group.id !== 'automatic' ? single.optimal : null

  const relative = (values: number[]): number[] => mode === 'total' ? values : values.map((value, slot) => value - series.counts[0][slot])
  const allLines: Line[] = [
    ...series.counts.map((values, count): Line => ({
      key: String(count),
      label: pingsLabel(count, t),
      stroke: PING_COLORS[count % PING_COLORS.length].stroke,
      style: 'solid',
      width: count === recommended ? 3 : 1.75,
      steps: relative(values),
      badge: count === recommended ? t('analytics.promptCache.legend.recommended') : undefined,
    })),
    ...(chartMax > 0 && !single
      ? [{ key: PER_MODEL, label: t('analytics.promptCache.legend.perModel'), stroke: 'stroke-primary', style: 'solid' as const, width: 3, steps: relative(series.perModel) }]
      : []),
    ...(chartMax > 0
      ? [{ key: PER_BREAK, label: t('analytics.promptCache.legend.perBreak'), stroke: 'stroke-special', style: 'dashed' as const, width: 2, steps: relative(series.perBreak) }]
      : []),
    { key: NO_CACHE, label: t('analytics.promptCache.legend.noCache'), stroke: 'stroke-dim', style: 'dotted', width: 1.75, steps: relative(series.noCache) },
  ]
  // The recommended line draws last so it sits on top.
  const lines = allLines.filter((line) => !hidden.includes(line.key)).sort((a, b) => (a.badge ? 1 : 0) - (b.badge ? 1 : 0))
  const toggleLine = (key: string): void => setHidden(hidden.includes(key) ? hidden.filter((entry) => entry !== key) : [...hidden, key])

  // The cheapest fixed count for each day, where the counts differed at all.
  const dayBest = days.map((_, day) => {
    const totals = series.counts.map((values) => sum(values.slice(day * SLOTS_PER_DAY, (day + 1) * SLOTS_PER_DAY)))
    return totals.length > 1 && Math.max(...totals) - Math.min(...totals) >= 0.005 ? cheapest(totals) : null
  })
  const dayLabel = (index: number): string => new Date(days[index]).toLocaleDateString(i18n.language, { weekday: 'short', month: 'short', day: 'numeric' })
  const pick = (key: string): void => { setPicked(key); setSelectedDay(null) }

  return (
    <section className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-dim">{t('analytics.promptCache.title')}</h3>
        <span className="text-[10px] text-faint">{t('analytics.promptCache.note', { count: analysis.days })}</span>
      </div>

      <CostTable entries={entries} maxPings={maxPings} weeks={weeks} selected={selected} multi={multi} onPick={pick} />

      <div className="space-y-3 rounded-lg border border-border bg-surface px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-primary">
              {t('analytics.promptCache.chart.title', { model: single ? modelName(single.model.model) : t('analytics.promptCache.allModels') })}
            </div>
            <p className="mt-0.5 text-[11px] text-dim">{mode === 'saving' ? t('analytics.promptCache.chart.savingNote') : t('analytics.promptCache.chart.totalNote')}</p>
          </div>
          <Segmented
            label={t('analytics.promptCache.chart.modeLabel')}
            options={['total', 'saving'] as ChartMode[]}
            value={mode}
            onChange={setMode}
            render={(entry) => entry === 'saving' ? t('analytics.promptCache.chart.saving') : t('analytics.promptCache.chart.total')}
          />
        </div>
        <Summary entry={single} entries={entries} weeks={weeks} />

        <div className="flex flex-col gap-3 lg:flex-row">
          <div className="min-w-0 flex-1">
            {lines.length === 0 ? (
              <p className="py-6 text-center text-xs text-dim">{t('analytics.promptCache.legend.allHidden')}</p>
            ) : (
              <LineChart
                lines={lines}
                first={0}
                last={slots}
                signed={mode === 'saving'}
                ariaLabel={t('analytics.promptCache.chart.aria')}
                pointLabel={(slot) => t('analytics.promptCache.chart.upTo', { day: dayLabel(Math.min(days.length - 1, Math.floor(Math.max(0, slot - 1) / SLOTS_PER_DAY))), time: new Date(analysis.from + slot * SLOT_MS).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) })}
                gridSlots={days.slice(1).map((_, index) => (index + 1) * SLOTS_PER_DAY)}
                shaded={days.map((start, index) => ({ start, index })).filter(({ start }) => [0, 6].includes(new Date(start).getDay())).map(({ index }) => [index * SLOTS_PER_DAY, (index + 1) * SLOTS_PER_DAY])}
                selected={selectedDay === null ? null : [selectedDay * SLOTS_PER_DAY, (selectedDay + 1) * SLOTS_PER_DAY]}
                onPick={(slot) => {
                  const day = Math.min(days.length - 1, Math.floor(slot / SLOTS_PER_DAY))
                  setSelectedDay(selectedDay === day ? null : day)
                }}
                footer={days.length <= MAX_DAY_BUTTONS ? (
                  <div className="mt-1 hidden sm:grid" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
                    {days.map((start, index) => (
                      <button
                        key={start}
                        type="button"
                        onClick={() => setSelectedDay(selectedDay === index ? null : index)}
                        aria-pressed={selectedDay === index}
                        title={dayBest[index] === null
                          ? t('analytics.promptCache.chart.expand', { day: dayLabel(index) })
                          : t('analytics.promptCache.chart.dayBest', { day: dayLabel(index), pings: pingsLabel(dayBest[index] ?? 0, t) })}
                        className={clsx('flex min-w-0 flex-col items-center rounded py-0.5 text-[10px] leading-tight', selectedDay === index ? 'bg-accent-bg font-medium text-accent-fg' : 'text-faint hover:bg-surface-hover hover:text-secondary')}
                      >
                        <span className="truncate">{new Date(start).toLocaleDateString(i18n.language, { day: 'numeric' })}</span>
                        <span className={clsx('font-semibold tabular-nums', dayBest[index] === null ? 'text-ghost' : PING_COLORS[(dayBest[index] ?? 0) % PING_COLORS.length].text)}>
                          {dayBest[index] ?? '–'}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
                caption={(
                  <div className={clsx('mt-1 justify-between text-[10px] text-faint', days.length <= MAX_DAY_BUTTONS ? 'flex sm:hidden' : 'flex')}>
                    <span>{dayLabel(0)}</span>
                    <span>{dayLabel(days.length - 1)}</span>
                  </div>
                )}
              />
            )}
            {chartMax > 0 && days.length <= MAX_DAY_BUTTONS && <p className="mt-1 hidden text-[10px] text-faint sm:block">{t('analytics.promptCache.chart.dayBestNote')}</p>}
          </div>
          <Legend lines={allLines} hidden={hidden} signed={mode === 'saving'} days={analysis.days} onToggle={toggleLine} />
        </div>
      </div>

      {selectedDay !== null && (
        <DayView
          entries={chartEntries}
          lines={lines}
          mode={mode}
          dayStart={days[selectedDay]}
          firstSlot={selectedDay * SLOTS_PER_DAY}
          title={new Date(days[selectedDay]).toLocaleDateString(i18n.language, { weekday: 'long', month: 'long', day: 'numeric' })}
          onPrevious={selectedDay > 0 ? () => setSelectedDay(selectedDay - 1) : null}
          onNext={selectedDay < days.length - 1 ? () => setSelectedDay(selectedDay + 1) : null}
          onClose={() => setSelectedDay(null)}
        />
      )}

      <p className="text-[10px] text-faint">{t('analytics.cache.rulesAsOf', { date: CACHE_RULES_CHECKED })}</p>
    </section>
  )
}

/** One sentence on what to pick for the chart's model, or for all of them. */
function Summary({ entry, entries, weeks }: { entry: ModelEntry | null; entries: ModelEntry[]; weeks: number }): React.JSX.Element {
  const { t } = useTranslation()
  const weekly = (value: number): string => money(value / weeks)
  let text: string
  if (entry === null) {
    const now = sum(entries.map(({ summary }) => summary.baseTotal + summary.totals[0]))
    const recommended = sum(entries.map(({ summary, optimal, group }) => summary.baseTotal + summary.totals[group.id === 'automatic' ? 0 : optimal]))
    const best = sum(entries.map(({ summary, group }) => summary.baseTotal + (group.id === 'automatic' ? summary.totals[0] : summary.perBreakTotal)))
    text = t('analytics.promptCache.summary.all', { cost: weekly(recommended), now: weekly(now), saving: weekly(now - recommended), best: weekly(best) })
  } else {
    const { summary, optimal, group, model } = entry
    const name = modelName(model.model)
    const now = summary.baseTotal + summary.totals[0]
    if (group.id === 'automatic') {
      text = t('analytics.promptCache.summary.automatic', { model: name, cost: weekly(now) })
    } else {
      const recommended = summary.baseTotal + summary.totals[optimal]
      const best = weekly(summary.baseTotal + summary.perBreakTotal)
      text = now - recommended >= 0.005
        ? t('analytics.promptCache.summary.saves', { model: name, pings: pingsLabel(optimal, t), cost: weekly(recommended), now: weekly(now), saving: weekly(now - recommended), best })
        : t('analytics.promptCache.summary.noSaving', { model: name, cost: weekly(now), best })
      if (summary.confidence === 'none') text += ` ${t('analytics.promptCache.summary.thin', { count: model.longBreaks })}`
    }
  }
  return <p className="text-[13px] font-medium leading-snug text-primary">{text}</p>
}

function CostTable({ entries, maxPings, weeks, selected, multi, onPick }: {
  entries: ModelEntry[]
  maxPings: number
  weeks: number
  selected: string
  multi: boolean
  onPick: (key: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const rows = entries.map((entry) => ({ entry, cost: costRow(entry, maxPings, weeks) }))
  // All models: every model at the same count, capped at what Pi sends it.
  const totalCost: CostRow = {
    counts: Array.from({ length: maxPings + 1 }, (_, count) => sum(rows.map(({ cost }) => {
      const own = cost.counts.filter((value): value is number => value !== null)
      return own[Math.min(count, own.length - 1)]
    }))),
    perBreak: sum(rows.map(({ cost }) => cost.perBreak ?? cost.counts[0] ?? 0)),
    noCache: sum(rows.map(({ cost }) => cost.noCache ?? 0)) || null,
  }
  const columns = Array.from({ length: maxPings + 1 }, (_, count) => count)

  const row = (key: string, label: React.ReactNode, cost: CostRow, detail: React.ReactNode, recommended: number | null, automatic: boolean, strong: boolean): React.JSX.Element => {
    const best = cheapest(cost.counts.map((value) => value ?? Infinity))
    const on = selected === key
    return (
      <tr
        key={key}
        onClick={() => onPick(key)}
        className={clsx('cursor-pointer border-t', strong ? 'border-border-strong' : 'border-border/60', on ? 'bg-accent-bg' : 'hover:bg-surface-hover')}
      >
        <td className="py-1.5 pl-2 pr-2">
          <button type="button" aria-pressed={on} onClick={(event) => { event.stopPropagation(); onPick(key) }} className={clsx('text-left', strong ? 'font-medium text-primary' : 'font-mono text-primary')}>
            {label}
          </button>
          {detail}
        </td>
        <td className="py-1.5 pl-2 text-right tabular-nums text-dim">{cost.noCache === null ? '–' : money(cost.noCache)}</td>
        {automatic ? (
          <>
            <td className="py-1.5 pl-2 text-right tabular-nums text-primary">{money(cost.counts[0] ?? 0)}</td>
            <td colSpan={maxPings + 1} className="py-1.5 pl-2 text-center text-[11px] text-dim">{t('analytics.promptCache.table.providerRuns')}</td>
          </>
        ) : (
          <>
            {cost.counts.map((value, count) => (
              <td key={count} className="py-1.5 pl-2 text-right tabular-nums">
                {value === null ? <span className="text-ghost">–</span> : (
                  <span
                    className={clsx(
                      'inline-block rounded px-1',
                      count === best ? 'font-semibold text-success' : 'text-secondary',
                      count === recommended && 'ring-1 ring-accent',
                    )}
                  >
                    {money(value)}
                  </span>
                )}
              </td>
            ))}
            <td className="py-1.5 pl-3 pr-2 text-right tabular-nums text-special">{cost.perBreak === null ? '–' : money(cost.perBreak)}</td>
          </>
        )}
      </tr>
    )
  }

  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="text-xs font-semibold text-primary">{t('analytics.promptCache.table.title')}</div>
      <p className="mt-0.5 text-[11px] text-dim">{t('analytics.promptCache.table.note')}</p>
      <div className="mt-1.5 overflow-x-auto">
        <table className="w-full min-w-[720px] whitespace-nowrap text-xs">
          <thead>
            <tr className="text-[10px] text-faint">
              <th className="pb-1 pl-2 text-left font-medium">{t('analytics.promptCache.table.model')}</th>
              <th className="pb-1 pl-2 text-right font-medium">{t('analytics.promptCache.table.noCache')}</th>
              {columns.map((count) => (
                <th key={count} className="pb-1 pl-2 text-right font-medium">
                  <span className="inline-flex items-center gap-1">
                    <span className={clsx('h-0.5 w-2.5 rounded', PING_COLORS[count % PING_COLORS.length].fill)} />
                    {pingsLabel(count, t)}
                  </span>
                </th>
              ))}
              <th className="pb-1 pl-3 pr-2 text-right font-medium">{t('analytics.promptCache.table.perBreak')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ entry, cost }) => row(
              entry.model.model,
              modelName(entry.model.model),
              cost,
              <div className="flex items-center gap-1.5 text-[10px] text-dim" title={entry.model.model}>
                <span>{t(LIFETIME_KEYS[entry.group.id])}</span>
                {entry.summary.hitRate !== null && <span>{t('analytics.promptCache.table.hitRate', { rate: Math.round(entry.summary.hitRate * 100) })}</span>}
                {entry.group.id !== 'automatic' && entry.summary.confidence !== 'solid' && (
                  <span className={clsx('rounded-full px-1.5 font-medium', CONFIDENCE_CLASSES[entry.summary.confidence])}>{t(CONFIDENCE_KEYS[entry.summary.confidence])}</span>
                )}
              </div>,
              entry.group.id === 'automatic' ? null : entry.optimal,
              entry.group.id === 'automatic',
              false,
            ))}
            {multi && row(ALL_KEY, t('analytics.promptCache.allModels'), totalCost, null, null, false, true)}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[10px] text-faint">{t('analytics.promptCache.table.footnote')}</p>
    </div>
  )
}

function Legend({ lines, hidden, signed, days, onToggle }: { lines: Line[]; hidden: string[]; signed: boolean; days: number; onToggle: (key: string) => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="shrink-0 lg:w-60">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-dim">{t('analytics.promptCache.legend.title', { count: days })}</div>
      <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2 lg:grid-cols-1">
        {lines.map((line) => {
          const off = hidden.includes(line.key)
          return (
            <button
              key={line.key}
              type="button"
              aria-pressed={!off}
              onClick={() => onToggle(line.key)}
              className={clsx('flex items-center justify-between gap-2 rounded px-2 py-1 text-left text-[11px]', line.badge ? 'border border-accent bg-accent-bg' : 'border border-transparent hover:bg-surface-hover', off && 'opacity-40')}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <LineSwatch line={line} />
                <span className="truncate text-secondary">{line.label}</span>
                {line.badge && <span className="shrink-0 rounded bg-accent px-1 text-[9px] font-semibold text-primary">{line.badge}</span>}
              </span>
              <span className="tabular-nums text-primary">{money(sum(line.steps), signed)}</span>
            </button>
          )
        })}
      </div>
      <p className="mt-1 text-[10px] text-faint">{t('analytics.promptCache.legend.note')}</p>
    </div>
  )
}

function LineSwatch({ line }: { line: Line }): React.JSX.Element {
  return (
    <svg width="16" height="4" aria-hidden="true" className="shrink-0">
      <line x1="0" x2="16" y1="2" y2="2" className={line.stroke} strokeWidth={line.width >= 3 ? 3 : 2} strokeDasharray={dashArray(line.style, true)} />
    </svg>
  )
}

function dashArray(style: Line['style'], small = false): string | undefined {
  if (style === 'dashed') return small ? '4 2' : '6 4'
  if (style === 'dotted') return small ? '1.5 2' : '2 3'
  return undefined
}

function Segmented<T extends string | number>({ label, options, value, onChange, render }: { label: string; options: T[]; value: T; onChange: (value: T) => void; render: (value: T) => string }): React.JSX.Element {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap overflow-hidden rounded border border-border">
      {options.map((entry) => (
        <button
          key={entry}
          type="button"
          aria-pressed={value === entry}
          onClick={() => onChange(entry)}
          className={clsx('px-2.5 py-1 text-[11px] tabular-nums', value === entry ? 'bg-accent-bg font-medium text-accent-fg' : 'text-muted hover:bg-surface-hover')}
        >
          {render(entry)}
        </button>
      ))}
    </div>
  )
}

/** Running totals of each line's steps over `first`..`last`, drawn with a hover readout; a click reports the slot. */
function LineChart({ lines, first, last, signed, ariaLabel, pointLabel, gridSlots, shaded = [], selected = null, onPick, footer, caption }: {
  lines: Line[]
  first: number
  last: number
  signed: boolean
  ariaLabel: string
  pointLabel: (slot: number) => string
  gridSlots: number[]
  shaded?: Array<[number, number]>
  selected?: [number, number] | null
  onPick?: (slot: number) => void
  footer?: React.ReactNode
  /** Shown under the footer, for narrow screens. */
  caption?: React.ReactNode
}): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null)
  const span = Math.max(1, last - first)
  const running = useMemo(() => lines.map((line) => {
    const values = [0]
    for (let slot = first; slot < last; slot++) values.push(values[values.length - 1] + line.steps[slot])
    return values
  }), [lines, first, last])

  let low = 0
  let high = 0
  for (const values of running) for (const value of values) { low = Math.min(low, value); high = Math.max(high, value) }
  const step = niceStep(Math.max(0.01, (high - low) / 4))
  // The epsilon keeps rounding noise from adding an empty band above or below.
  low = Math.floor(low / step + 1e-9) * step
  high = Math.max(low + step, Math.ceil(high / step - 1e-9) * step)
  const ticks: number[] = []
  for (let tick = low; tick <= high + step / 2; tick += step) ticks.push(tick)
  const y = (value: number): number => 100 - ((value - low) / (high - low)) * 100
  const x = (offset: number): number => (offset / span) * 1000
  const stride = Math.max(1, Math.ceil(span / MAX_POINTS))
  const path = (values: number[]): string => {
    const points: string[] = []
    for (let offset = 0; offset <= span; offset += stride) points.push(`${points.length === 0 ? 'M' : 'L'}${x(offset).toFixed(1)} ${y(values[offset]).toFixed(2)}`)
    if (span % stride !== 0) points.push(`L${x(span).toFixed(1)} ${y(values[span]).toFixed(2)}`)
    return points.join(' ')
  }
  const offsetAt = (event: React.MouseEvent<HTMLDivElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect()
    return Math.max(0, Math.min(span, Math.round(((event.clientX - rect.left) / rect.width) * span)))
  }
  // Hover readout from the most to the least expensive line at that point.
  const order = hover === null ? [] : lines.map((_, index) => index).sort((a, b) => running[b][hover] - running[a][hover])

  return (
    <div className="flex">
      <div className="relative w-14 shrink-0" aria-hidden="true">
        {ticks.map((tick) => (
          <span key={tick} className="absolute right-2 -translate-y-1/2 text-[10px] text-dim tabular-nums" style={{ top: `${(y(tick) / 100) * 15}rem` }}>
            {money(tick, signed && Math.abs(tick) > 1e-9)}
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative h-60">
          <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label={ariaLabel}>
            {shaded.map(([from, to]) => <rect key={from} x={x(from - first)} y={0} width={x(to - from)} height={100} className="fill-card opacity-60" />)}
            {selected && <rect x={x(selected[0] - first)} y={0} width={x(selected[1] - selected[0])} height={100} className="fill-accent-bg" />}
            {ticks.map((tick) => (
              <line key={tick} x1={0} x2={1000} y1={y(tick)} y2={y(tick)} className={Math.abs(tick) < 1e-9 ? 'stroke-faint' : 'stroke-border'} vectorEffect="non-scaling-stroke" strokeWidth={1} />
            ))}
            {gridSlots.map((slot) => <line key={slot} x1={x(slot - first)} x2={x(slot - first)} y1={0} y2={100} className="stroke-border" vectorEffect="non-scaling-stroke" strokeWidth={1} />)}
            {lines.map((line, index) => (
              <path
                key={line.key}
                d={path(running[index])}
                fill="none"
                className={line.stroke}
                strokeWidth={line.width}
                strokeDasharray={dashArray(line.style)}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={100} className="stroke-muted" vectorEffect="non-scaling-stroke" strokeWidth={1} />}
          </svg>
          <div
            className={clsx('absolute inset-0', onPick ? 'cursor-pointer' : 'cursor-crosshair')}
            onMouseMove={(event) => setHover(offsetAt(event))}
            onMouseLeave={() => setHover(null)}
            onClick={(event) => onPick?.(first + Math.min(span - 1, offsetAt(event)))}
          />
          {hover !== null && (
            <div
              className="pointer-events-none absolute top-1 z-10 w-60 rounded-lg border border-border bg-elevated px-2.5 py-2 text-[11px] shadow-lg"
              style={hover / span > 0.6 ? { right: `${100 - (hover / span) * 100 + 1}%` } : { left: `${(hover / span) * 100 + 1}%` }}
            >
              <div className="mb-1 font-medium text-primary">{pointLabel(first + hover)}</div>
              {order.map((index) => (
                <div key={lines[index].key} className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5 truncate text-secondary">
                    <LineSwatch line={lines[index]} />
                    {lines[index].label}
                  </span>
                  <span className="tabular-nums text-primary">{money(running[index][hover], signed)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {footer}
        {caption}
      </div>
    </div>
  )
}

/** One day in 30-minute blocks for the chart's lines, with the cheapest count for each block that had a break. */
function DayView({ entries, lines, mode, dayStart, firstSlot, title, onPrevious, onNext, onClose }: {
  entries: ModelEntry[]
  lines: Line[]
  mode: ChartMode
  dayStart: number
  firstSlot: number
  title: string
  onPrevious: (() => void) | null
  onNext: (() => void) | null
  onClose: () => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const clock = (at: number): string => new Date(at).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const blockLabel = (slot: number): string => `${clock(dayStart + slot * SLOT_MS)}–${clock(dayStart + (slot + 1) * SLOT_MS)}`
  const warmable = entries
    .filter((entry) => entry.group.id !== 'automatic')
    .map((entry) => ({ entry, cells: slotBest([entry.model], entry.group.maxPings, dayStart) }))
    .filter(({ cells }) => cells.some((cell) => cell !== null))
  return (
    <div className="space-y-3 rounded-lg border border-accent/40 bg-surface px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-primary">{title}</h4>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => onPrevious?.()} disabled={!onPrevious} aria-label={t('analytics.promptCache.day.previous')} className="rounded border border-border p-1 text-muted hover:bg-surface-hover disabled:opacity-40"><ChevronLeft size={14} /></button>
          <button type="button" onClick={() => onNext?.()} disabled={!onNext} aria-label={t('analytics.promptCache.day.next')} className="rounded border border-border p-1 text-muted hover:bg-surface-hover disabled:opacity-40"><ChevronRight size={14} /></button>
          <button type="button" onClick={onClose} aria-label={t('analytics.promptCache.day.close')} className="rounded border border-border p-1 text-muted hover:bg-surface-hover"><X size={14} /></button>
        </div>
      </div>
      {lines.length > 0 && (
        <LineChart
          lines={lines}
          first={firstSlot}
          last={firstSlot + SLOTS_PER_DAY}
          signed={mode === 'saving'}
          ariaLabel={title}
          pointLabel={(slot) => t('analytics.promptCache.day.upTo', { time: slot - firstSlot >= SLOTS_PER_DAY ? '24:00' : clock(dayStart + (slot - firstSlot) * SLOT_MS) })}
          gridSlots={[6, 12, 18, 24, 30, 36, 42].map((slot) => firstSlot + slot)}
          footer={(
            <>
              <div className="mt-0.5 flex justify-between text-[10px] text-faint tabular-nums">
                {[0, 12, 24, 36, 48].map((slot) => <span key={slot}>{slot === 48 ? '24:00' : clock(dayStart + slot * SLOT_MS)}</span>)}
              </div>
              {warmable.length > 0 && (
                <div className="mt-2 space-y-0.5">
                  <div className="text-[10px] uppercase tracking-wide text-dim">{t('analytics.promptCache.day.bestRow')}</div>
                  {warmable.map(({ entry, cells }) => (
                    <div key={entry.model.model} className="flex items-center gap-px" title={entry.model.model}>
                      {cells.map((cell, slot) => (
                        <span
                          key={slot}
                          title={cell
                            ? t('analytics.promptCache.day.cell', { model: modelName(entry.model.model), count: cell.gaps.length, block: blockLabel(slot), lengths: cell.gaps.map((gap) => Math.round(gap.gapMs / MINUTE)).join(', '), best: pingsLabel(cell.best, t) })
                            : undefined}
                          className={clsx('min-w-0 flex-1 rounded-sm text-center text-[9px] font-semibold leading-4 tabular-nums', cell ? clsx(PING_COLORS[cell.best % PING_COLORS.length].fill, 'text-inverse') : 'bg-card/40 text-transparent')}
                        >
                          {cell ? cell.best : '·'}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        />
      )}
      {warmable.length > 0 && <p className="text-[10px] text-faint">{t('analytics.promptCache.day.bestNote')}</p>}
    </div>
  )
}
