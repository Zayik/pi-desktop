import { Fragment, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react'
import {
  SLOTS_PER_DAY,
  SLOT_MS,
  dayStarts,
  optimalCounts,
  recommendedSetting,
  slotBest,
  slotCosts,
  slotLong,
  slotNoCache,
  summarize,
  type CacheAnalysis,
  type CacheRecommendation,
  type CacheSetting,
  type CacheSettingsState,
  type CacheConfidence,
  type CacheGroupAnalysis,
  type CacheGroupId,
  type CacheModelAnalysis,
  type PingSummary,
} from '../../../shared/cache-analysis'
import { CACHE_RULES_CHECKED } from '../../../shared/cache-policy'
import { importSourceOf, isImportedModel, type ImportSource } from '../../../shared/import-sources'
import { formatMultiple, formatPerMillion, priceSheet, type PriceBand } from '../../../shared/list-prices'
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

/** Models from other tools' logs: shown for reference beside Pi's own. */
const IMPORT_KEYS = {
  'claude-code': 'analytics.promptCache.table.fromClaudeCode',
  codex: 'analytics.promptCache.table.fromCodex',
  copilot: 'analytics.promptCache.table.fromCopilot',
} as const satisfies Record<ImportSource, string>

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
/** The long lifetime's color, apart from every ping count's. */
const LONG_COLOR = { stroke: 'stroke-indigo-400', fill: 'bg-indigo-400', text: 'text-indigo-400' } // theme-exempt
const LONG = 'long'
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

/** A fixed setting: a ping count on the short lifetime, or the long lifetime with none. */
type Choice = number | typeof LONG

function choiceLabel(choice: Choice, t: Translate): string {
  return choice === LONG ? t('analytics.promptCache.longLabel') : pingsLabel(choice, t)
}

function choiceColor(choice: Choice): typeof LONG_COLOR {
  return choice === LONG ? LONG_COLOR : PING_COLORS[choice % PING_COLORS.length]
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
  /** The recommended setting: that count, or the long lifetime when it costs less and the model has enough breaks to tell; null where the provider runs the cache. */
  recommended: Choice | null
}

/** Weekly prompt cost for one table row: per ping count (null past what Pi sends), at each break's best count, and with no cache. */
interface CostRow {
  counts: Array<number | null>
  long: number | null
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

/** Whole prompt cost of a model on a setting, over the window. */
function choiceTotal(entry: ModelEntry, choice: Choice): number {
  const { summary } = entry
  if (choice === LONG && summary.longTotal !== null) return summary.longTotal
  return summary.baseTotal + summary.totals[choice === LONG ? 0 : Math.min(choice, summary.totals.length - 1)]
}

function recommendedChoice(entry: Omit<ModelEntry, 'recommended'>): Choice | null {
  return recommendedSetting(entry.group, entry.summary, entry.optimal)
}

function costRow(entry: ModelEntry, maxPings: number, weeks: number): CostRow {
  const { summary, group } = entry
  const warmable = group.id !== 'automatic'
  return {
    counts: Array.from({ length: maxPings + 1 }, (_, count) => count <= (warmable ? group.maxPings : 0) ? (summary.baseTotal + summary.totals[count]) / weeks : null),
    long: summary.longTotal === null ? null : summary.longTotal / weeks,
    perBreak: warmable ? (summary.baseTotal + summary.perBreakTotal) / weeks : null,
    noCache: summary.noCacheTotal > 0 ? summary.noCacheTotal / weeks : null,
  }
}

/** No cache against the short cache with no pings: the writes cost more, the reads cost less. */
function cacheEffect(summary: PingSummary, warmable: boolean, weeks: number): { writes: number | null; reads: number | null } {
  if (!warmable || summary.noCacheTotal <= 0) return { writes: null, reads: null }
  const now = summary.baseTotal + summary.totals[0]
  return { writes: summary.writePremium / weeks, reads: (summary.noCacheTotal - (now - summary.writePremium)) / weeks }
}

/** Pi Desktop's handles on the cache settings; the HTML report has none and stays read only. */
export interface CacheSettingsControls {
  state: CacheSettingsState
  busy: boolean
  onSet: (changes: Record<string, CacheSetting | null>) => void
  onWarming: (on: boolean) => void
  onAway: (away: boolean) => void
}

/** The setting a model runs on now: its own (no pings while cache warming is off), or no pings when Pi decides. Null where none applies. */
function inUseChoice(entry: ModelEntry, state: CacheSettingsState): Choice | null {
  if (!settable(entry)) return null
  const setting = state.models[entry.model.model]
  if (setting === LONG) return entry.model.long ? LONG : 0
  if (!state.warming || setting === undefined) return 0
  return Math.min(setting, entry.group.maxPings)
}

/** Pi runs the model and it has a cache a setting can change. */
function settable(entry: ModelEntry): boolean {
  return entry.group.id !== 'automatic' && !isImportedModel(entry.model.model)
}

/** Running cost per slot for a set of models: every ping count (capped per model), Long, each break's best, each model's recommended setting and no cache. */
interface Series {
  counts: number[][]
  long: number[] | null
  perBreak: number[]
  perModel: number[]
  noCache: number[]
  /** The most pings any of the models can take. */
  maxPings: number
}

function buildSeries(entries: ModelEntry[], from: number, slots: number): Series {
  const maxPings = Math.max(0, ...entries.map((entry) => entry.group.id === 'automatic' ? 0 : entry.group.maxPings))
  const counts = Array.from({ length: maxPings + 1 }, () => new Array<number>(slots).fill(0))
  const perBreak = new Array<number>(slots).fill(0)
  const perModel = new Array<number>(slots).fill(0)
  const noCache = new Array<number>(slots).fill(0)
  const long = entries.some((entry) => entry.model.long) ? new Array<number>(slots).fill(0) : null
  for (const entry of entries) {
    const own = entry.group.id === 'automatic' ? 0 : entry.group.maxPings
    const byCount = Array.from({ length: own + 1 }, (_, count) => slotCosts(entry.model, count, from, slots).cost)
    counts.forEach((total, count) => addInto(total, byCount[Math.min(count, own)]))
    addInto(perBreak, own > 0 ? slotCosts(entry.model, 'perBreak', from, slots).cost : byCount[0])
    const ownLong = slotLong(entry.model, from, slots)
    if (long) addInto(long, ownLong ?? byCount[0])
    addInto(perModel, entry.recommended === LONG && ownLong ? ownLong : byCount[Math.min(entry.optimal, own)])
    addInto(noCache, slotNoCache(entry.model, from, slots))
  }
  return { counts, long, perBreak, perModel, noCache, maxPings }
}

/** The slots of a setting's line in a series. */
function choiceSteps(series: Series, choice: Choice): number[] {
  return choice === LONG ? series.long ?? series.counts[0] : series.counts[Math.min(choice, series.counts.length - 1)]
}

/** Prompt cost per model at every ping count, then a small running-cost graph per model that opens into its full chart; with `settings`, a click on a cost uses that setting. */
export function PromptCacheAnalysis({ analysis, settings }: { analysis: CacheAnalysis; settings?: CacheSettingsControls }): React.JSX.Element | null {
  const { t } = useTranslation()
  // undefined: nothing clicked yet, so the default model is open; null: every graph closed.
  const [expanded, setExpanded] = useState<string | null | undefined>(undefined)
  const days = useMemo(() => dayStarts(analysis.from, analysis.to), [analysis.from, analysis.to])
  const maxPings = Math.max(0, ...analysis.groups.map((group) => group.maxPings))
  const weeks = Math.max(analysis.days, 1) / 7

  const entries = useMemo(() => {
    const optimal = optimalCounts(analysis)
    return analysis.groups
      .flatMap((group) => group.models.map((model) => ({ model, group })))
      .sort((a, b) => b.model.calls - a.model.calls)
      .map(({ model, group }): ModelEntry => {
        const entry = { model, group, summary: summarize([model], group.maxPings, analysis.days), optimal: optimal.get(model.model) ?? 0 }
        return { ...entry, recommended: recommendedChoice(entry) }
      })
  }, [analysis])

  // Open on the most used model that can be warmed and ran in the last week.
  const defaultKey = useMemo(() => {
    const recentFrom = analysis.to - RECENT_DAYS * 24 * 60 * MINUTE
    const ranRecently = (entry: ModelEntry): boolean => entry.model.base.some(([at]) => at >= recentFrom) || entry.model.gaps.some((gap) => gap.at >= recentFrom)
    const warmable = entries.filter((entry) => entry.group.id !== 'automatic')
    return (warmable.find(ranRecently) ?? warmable[0] ?? entries[0])?.model.model ?? ALL_KEY
  }, [entries, analysis.to])

  if (entries.length === 0) return null
  const multi = entries.length > 1
  const open = expanded === undefined ? defaultKey : expanded
  const cards: Array<{ key: string; entry: ModelEntry | null }> = [
    ...(multi ? [{ key: ALL_KEY, entry: null }] : []),
    ...entries.map((entry) => ({ key: entry.model.model, entry })),
  ]
  // A model picked in the table opens its graph and brings it into view.
  const pick = (key: string): void => {
    setExpanded(key)
    requestAnimationFrame(() => document.getElementById(cardId(key))?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  }

  return (
    <section className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-dim">{t('analytics.promptCache.title')}</h3>
        <span className="text-[10px] text-faint">{t('analytics.promptCache.note', { count: analysis.days })}</span>
      </div>

      {settings && <SettingsBar entries={entries} controls={settings} />}
      <CostTable entries={entries} maxPings={maxPings} weeks={weeks} selected={open ?? ''} multi={multi} onPick={pick} settings={settings} />

      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-xs font-semibold text-primary">{t('analytics.promptCache.models.title')}</div>
          <span className="text-[10px] text-faint">{t('analytics.promptCache.models.hint')}</span>
        </div>
        {cards.map(({ key, entry }) => (
          <ModelCard
            key={key}
            id={cardId(key)}
            entry={entry}
            entries={entries}
            analysis={analysis}
            days={days}
            weeks={weeks}
            state={settings?.state ?? null}
            open={open === key}
            onToggle={() => setExpanded(open === key ? null : key)}
          />
        ))}
      </div>

      <ModelPrices models={analysis.groups.flatMap((group) => group.models.map((model) => model.model))} />

      <p className="text-[10px] text-faint">{t('analytics.cache.rulesAsOf', { date: CACHE_RULES_CHECKED })}</p>
    </section>
  )
}

function cardId(key: string): string {
  return `prompt-cache-model-${key === ALL_KEY ? 'all' : key.replace(/[^A-Za-z0-9_-]/g, '-')}`
}

/** One model (or all of them, with `entry` null): a line on what to pick and a small running-cost graph; a click opens the full chart in its place. */
function ModelCard({ id, entry, entries, analysis, days, weeks, state, open, onToggle }: {
  id: string
  entry: ModelEntry | null
  entries: ModelEntry[]
  analysis: CacheAnalysis
  days: number[]
  weeks: number
  state: CacheSettingsState | null
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const slots = days.length * SLOTS_PER_DAY
  const chartEntries = useMemo(() => entry ? [entry] : entries, [entry, entries])
  const series = useMemo(() => buildSeries(chartEntries, analysis.from, slots), [chartEntries, analysis.from, slots])
  const weekly = (steps: number[]): number => sum(steps) / weeks
  const automatic = entry?.group.id === 'automatic'
  const recommended = entry ? entry.recommended : null
  const current = entry && state ? inUseChoice(entry, state) : null

  // The small graph: no pings against the recommended setting, plus the one in use when it differs.
  const mini: Line[] = [
    { key: '0', label: t('analytics.promptCache.noPings'), stroke: PING_COLORS[0].stroke, style: 'solid', width: 1.5, steps: series.counts[0] },
  ]
  if (entry === null) {
    if (series.maxPings > 0) mini.push({ key: PER_MODEL, label: t('analytics.promptCache.models.eachRecommended'), stroke: 'stroke-primary', style: 'solid', width: 2.5, steps: series.perModel })
  } else if (recommended !== null && recommended !== 0) {
    mini.push({ key: String(recommended), label: t('analytics.promptCache.models.recommended', { setting: choiceLabel(recommended, t) }), stroke: choiceColor(recommended).stroke, style: 'solid', width: 2.5, steps: choiceSteps(series, recommended) })
  }
  if (current !== null && current !== 0 && current !== recommended) {
    mini.push({ key: `in-${current}`, label: t('analytics.promptCache.models.inUse', { setting: choiceLabel(current, t) }), stroke: choiceColor(current).stroke, style: 'dashed', width: 1.75, steps: choiceSteps(series, current) })
  }

  const noPings = weekly(series.counts[0])
  let headline: string
  if (entry === null) {
    const each = weekly(series.perModel)
    headline = noPings - each >= 0.005
      ? t('analytics.promptCache.models.allSaves', { cost: money(each), saving: money(noPings - each) })
      : t('analytics.promptCache.models.noSaving', { cost: money(noPings) })
  } else if (automatic) {
    headline = t('analytics.promptCache.models.automatic', { cost: money(noPings) })
  } else {
    // A model with too few breaks borrows its group's count, so name that count even when it saves little here.
    const best = weekly(choiceSteps(series, recommended ?? 0))
    headline = recommended !== null && recommended !== 0
      ? t('analytics.promptCache.models.saves', { setting: choiceLabel(recommended, t), cost: money(best), saving: money(Math.max(0, noPings - best)) })
      : t('analytics.promptCache.models.noSaving', { cost: money(noPings) })
  }

  return (
    <div id={id} className={clsx('scroll-mt-4 rounded-lg border bg-surface', open ? 'border-accent' : 'border-border')}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full flex-col gap-1.5 rounded-lg px-3 py-2 text-left hover:bg-surface-hover"
      >
        <div className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-dim">
            <span className={clsx('text-xs text-primary', entry ? 'font-mono' : 'font-semibold')}>{entry ? modelName(entry.model.model) : t('analytics.promptCache.allModels')}</span>
            {entry && <SourceTag model={entry.model.model} />}
            {entry && <span>{t(LIFETIME_KEYS[entry.group.id])}</span>}
            {entry?.summary.hitRate != null && <span>{t('analytics.promptCache.table.hitRate', { rate: Math.round(entry.summary.hitRate * 100) })}</span>}
            {entry && !automatic && entry.summary.confidence !== 'solid' && (
              <span className={clsx('rounded-full px-1.5 font-medium', CONFIDENCE_CLASSES[entry.summary.confidence])}>{t(CONFIDENCE_KEYS[entry.summary.confidence])}</span>
            )}
            {entry === null && <span>{t('analytics.promptCache.models.count', { count: entries.length })}</span>}
          </div>
          <span className="flex items-center gap-1.5 text-[11px] text-secondary">
            {headline}
            <ChevronDown aria-hidden="true" className={clsx('h-3.5 w-3.5 text-dim transition-transform', open && 'rotate-180')} />
          </span>
        </div>
        {!open && <Sparkline lines={mini} weeks={weeks} />}
      </button>
      {open && (
        <div className="border-t border-border px-3 pb-3 pt-2">
          <ModelChart entry={entry} entries={entries} chartEntries={chartEntries} series={series} analysis={analysis} days={days} weeks={weeks} />
        </div>
      )}
    </div>
  )
}

/** A small running-cost graph with no axes, and each line's weekly cost beside it. */
function Sparkline({ lines, weeks }: { lines: Line[]; weeks: number }): React.JSX.Element {
  const points = 240
  const running = lines.map((line) => {
    const per = Math.max(1, Math.ceil(line.steps.length / points))
    const values = [0]
    let total = 0
    for (let slot = 0; slot < line.steps.length; slot++) {
      total += line.steps[slot]
      if ((slot + 1) % per === 0 || slot === line.steps.length - 1) values.push(total)
    }
    return values
  })
  const high = Math.max(0.01, ...running.map((values) => values[values.length - 1]))
  const path = (values: number[]): string => values.map((value, index) => `${index === 0 ? 'M' : 'L'}${((index / Math.max(1, values.length - 1)) * 1000).toFixed(1)} ${(40 - (value / high) * 38).toFixed(2)}`).join(' ')
  return (
    <div className="flex w-full items-center gap-3">
      <svg className="h-12 min-w-0 flex-1 overflow-visible" viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden="true">
        <line x1={0} x2={1000} y1={40} y2={40} className="stroke-border" vectorEffect="non-scaling-stroke" strokeWidth={1} />
        {lines.map((line, index) => (
          <path key={line.key} d={path(running[index])} fill="none" className={line.stroke} strokeWidth={line.width} strokeDasharray={dashArray(line.style)} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div className="w-56 shrink-0 space-y-0.5 text-[10px]">
        {lines.map((line) => (
          <div key={line.key} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 truncate text-dim"><LineSwatch line={line} />{line.label}</span>
            <span className="tabular-nums text-secondary">{money(sum(line.steps) / weeks)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** The full running-cost chart for one model (or all of them): a line per ping count, the legend, and a day opened in 30-minute blocks. */
function ModelChart({ entry, entries, chartEntries, series, analysis, days, weeks }: {
  entry: ModelEntry | null
  entries: ModelEntry[]
  chartEntries: ModelEntry[]
  series: Series
  analysis: CacheAnalysis
  days: number[]
  weeks: number
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [mode, setMode] = useState<ChartMode>('total')
  const [hidden, setHidden] = useState<string[]>([NO_CACHE])
  const [selectedDay, setSelectedDay] = useState<number | null>(null)
  const slots = days.length * SLOTS_PER_DAY
  const chartMax = series.maxPings
  const recommended = entry?.recommended ?? null

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
    ...(series.long
      ? [{ key: LONG, label: t('analytics.promptCache.legend.long'), stroke: LONG_COLOR.stroke, style: 'solid' as const, width: recommended === LONG ? 3 : 1.75, steps: relative(series.long), badge: recommended === LONG ? t('analytics.promptCache.legend.recommended') : undefined }]
      : []),
    ...(chartMax > 0 && !entry
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

  // The cheapest fixed setting for each day, where they differed at all.
  const dayBest = days.map((_, day): Choice | null => {
    const options = [...series.counts, ...(series.long ? [series.long] : [])]
    const totals = options.map((values) => sum(values.slice(day * SLOTS_PER_DAY, (day + 1) * SLOTS_PER_DAY)))
    if (totals.length < 2 || Math.max(...totals) - Math.min(...totals) < 0.005) return null
    const best = cheapest(totals)
    return best === series.counts.length ? LONG : best
  })
  const dayLabel = (index: number): string => new Date(days[index]).toLocaleDateString(i18n.language, { weekday: 'short', month: 'short', day: 'numeric' })

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-[11px] text-dim">{mode === 'saving' ? t('analytics.promptCache.chart.savingNote') : t('analytics.promptCache.chart.totalNote')}</p>
        <Segmented
          label={t('analytics.promptCache.chart.modeLabel')}
          options={['total', 'saving'] as ChartMode[]}
          value={mode}
          onChange={setMode}
          render={(value) => value === 'saving' ? t('analytics.promptCache.chart.saving') : t('analytics.promptCache.chart.total')}
        />
      </div>
      <Summary entry={entry} entries={entries} weeks={weeks} />

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
                        : t('analytics.promptCache.chart.dayBest', { day: dayLabel(index), pings: choiceLabel(dayBest[index] ?? 0, t) })}
                      className={clsx('flex min-w-0 flex-col items-center rounded py-0.5 text-[10px] leading-tight', selectedDay === index ? 'bg-accent-bg font-medium text-accent-fg' : 'text-faint hover:bg-surface-hover hover:text-secondary')}
                    >
                      <span className="truncate">{new Date(start).toLocaleDateString(i18n.language, { day: 'numeric' })}</span>
                      <span className={clsx('font-semibold tabular-nums', dayBest[index] === null ? 'text-ghost' : choiceColor(dayBest[index] ?? 0).text)}>
                        {dayBest[index] === LONG ? t('analytics.promptCache.longShort') : dayBest[index] ?? '–'}
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
    </div>
  )
}

/** One sentence on what to pick for the chart's model, or for all of them. */
function Summary({ entry, entries, weeks }: { entry: ModelEntry | null; entries: ModelEntry[]; weeks: number }): React.JSX.Element {
  const { t } = useTranslation()
  const weekly = (value: number): string => money(value / weeks)
  let text: string
  if (entry === null) {
    const now = sum(entries.map(({ summary }) => summary.baseTotal + summary.totals[0]))
    const recommended = sum(entries.map((own) => choiceTotal(own, own.recommended ?? 0)))
    const best = sum(entries.map(({ summary, group }) => summary.baseTotal + (group.id === 'automatic' ? summary.totals[0] : summary.perBreakTotal)))
    text = t('analytics.promptCache.summary.all', { cost: weekly(recommended), now: weekly(now), saving: weekly(now - recommended), best: weekly(best) })
  } else {
    const { summary, group, model } = entry
    const name = modelName(model.model)
    const now = summary.baseTotal + summary.totals[0]
    if (group.id === 'automatic') {
      text = t('analytics.promptCache.summary.automatic', { model: name, cost: weekly(now) })
    } else {
      const choice = entry.recommended ?? 0
      const recommended = choiceTotal(entry, choice)
      const best = weekly(summary.baseTotal + summary.perBreakTotal)
      text = now - recommended >= 0.005
        ? t('analytics.promptCache.summary.saves', { model: name, pings: choiceLabel(choice, t), cost: weekly(recommended), now: weekly(now), saving: weekly(now - recommended), best })
        : t('analytics.promptCache.summary.noSaving', { model: name, cost: weekly(now), best })
      if (summary.confidence === 'none') text += ` ${t('analytics.promptCache.summary.thin', { count: model.longBreaks })}`
      const effect = cacheEffect(summary, true, weeks)
      if (effect.writes !== null && effect.reads !== null && model.writeMultiple !== null) {
        text += ` ${t('analytics.promptCache.summary.vsNoCache', { noCache: weekly(summary.noCacheTotal), multiple: model.writeMultiple, writes: money(effect.writes), reads: money(effect.reads) })}`
      }
    }
  }
  return <p className="text-[13px] font-medium leading-snug text-primary">{text}</p>
}

/** Which tool ran a model, when it was not Pi. */
function SourceTag({ model }: { model: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const source = importSourceOf(model)
  return source ? <span className="rounded-full bg-card px-1.5 font-medium">{t(IMPORT_KEYS[source])}</span> : null
}

function CostTable({ entries, maxPings, weeks, selected, multi, onPick, settings }: {
  entries: ModelEntry[]
  maxPings: number
  weeks: number
  selected: string
  multi: boolean
  onPick: (key: string) => void
  settings?: CacheSettingsControls
}): React.JSX.Element {
  const { t } = useTranslation()
  const state = settings?.state ?? null
  const inUse = (entry: ModelEntry): Choice | null => state ? inUseChoice(entry, state) : null
  /** What the recommended setting would save each week over the one in use. */
  const leftOver = (entry: ModelEntry): number | null => {
    const current = inUse(entry)
    if (current === null || entry.recommended === null) return null
    return Math.max(0, choiceTotal(entry, current) - choiceTotal(entry, entry.recommended)) / weeks
  }
  const leftTotal = sum(entries.map((entry) => leftOver(entry) ?? 0))
  const rows = entries.map((entry) => ({ entry, cost: costRow(entry, maxPings, weeks) }))
  // All models: every model at the same count, capped at what Pi sends it.
  const totalCost: CostRow = {
    counts: Array.from({ length: maxPings + 1 }, (_, count) => sum(rows.map(({ cost }) => {
      const own = cost.counts.filter((value): value is number => value !== null)
      return own[Math.min(count, own.length - 1)]
    }))),
    long: rows.some(({ cost }) => cost.long !== null) ? sum(rows.map(({ cost }) => cost.long ?? cost.counts[0] ?? 0)) : null,
    perBreak: sum(rows.map(({ cost }) => cost.perBreak ?? cost.counts[0] ?? 0)),
    noCache: sum(rows.map(({ cost }) => cost.noCache ?? 0)) || null,
  }
  const columns = Array.from({ length: maxPings + 1 }, (_, count) => count)
  const hasLong = totalCost.long !== null

  const row = (key: string, label: React.ReactNode, cost: CostRow, detail: React.ReactNode, recommended: Choice | null, automatic: boolean, strong: boolean, entry: ModelEntry | null = null): React.JSX.Element => {
    const fixed = [...cost.counts.map((value) => value ?? Infinity), cost.long ?? Infinity]
    const best: Choice = cheapest(fixed) === cost.counts.length ? LONG : cheapest(fixed)
    const current = entry ? inUse(entry) : null
    const canSet = Boolean(settings && entry && settable(entry))
    const cell = (choice: Choice, value: number | null): React.JSX.Element => {
      const className = clsx(
        'inline-block rounded px-1',
        choice === current ? 'bg-accent font-semibold text-white' : choice === best ? 'font-semibold text-success' : 'text-secondary',
        choice === recommended && 'ring-1 ring-success',
      )
      return (
      <td key={choice} className="py-1.5 pl-2 text-right align-top tabular-nums">
        {value === null ? <span className="text-ghost">–</span> : canSet && entry && settings ? (
          <button
            type="button"
            disabled={settings.busy}
            aria-pressed={choice === current}
            aria-label={t('analytics.promptCache.settings.useAria', { model: modelName(entry.model.model), setting: choiceLabel(choice, t), cost: money(value) })}
            onClick={(event) => {
              event.stopPropagation()
              settings.onSet({ [entry.model.model]: choice })
            }}
            className={clsx(className, 'min-h-6 hover:ring-1 hover:ring-accent disabled:opacity-60')}
          >
            {money(value)}
          </button>
        ) : (
          <span className={className}>{money(value)}</span>
        )}
      </td>
      )
    }
    const on = selected === key
    const left = entry ? leftOver(entry) : strong && state ? leftTotal : null
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
            <td colSpan={maxPings + (hasLong ? 1 : 0) + (state ? 0 : 1)} className="py-1.5 pl-2 text-center text-[11px] text-dim">{t('analytics.promptCache.table.providerRuns')}</td>
          </>
        ) : (
          <>
            {cost.counts.map((value, count) => cell(count, value))}
            {hasLong && cell(LONG, cost.long)}
            {!state && <td className="py-1.5 pl-3 pr-2 text-right tabular-nums text-special">{cost.perBreak === null ? '–' : money(cost.perBreak)}</td>}
          </>
        )}
        {state && (
          <td className={clsx('py-1.5 pl-3 pr-2 text-right tabular-nums', left === null ? 'text-ghost' : left < 0.005 ? 'text-success' : 'font-semibold text-warning')}>
            {left === null ? '–' : left < 0.005 ? t('analytics.promptCache.settings.best') : money(left)}
          </td>
        )}
      </tr>
    )
  }

  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="text-xs font-semibold text-primary">{t('analytics.promptCache.table.title')}</div>
      <p className="mt-0.5 text-[11px] text-dim">{t(state ? 'analytics.promptCache.settings.tableNote' : 'analytics.promptCache.table.note')}</p>
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
              {hasLong && (
                <th className="pb-1 pl-2 text-right font-medium" title={t('analytics.promptCache.table.longTitle')}>
                  <span className="inline-flex items-center gap-1">
                    <span className={clsx('h-0.5 w-2.5 rounded', LONG_COLOR.fill)} />
                    {t('analytics.promptCache.table.long')}
                  </span>
                </th>
              )}
              {!state && <th className="pb-1 pl-3 pr-2 text-right font-medium">{t('analytics.promptCache.table.perBreak')}</th>}
              {state && <th className="pb-1 pl-3 pr-2 text-right font-medium" title={t('analytics.promptCache.settings.leftTitle')}>{t('analytics.promptCache.settings.left')}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ entry, cost }) => row(
              entry.model.model,
              modelName(entry.model.model),
              cost,
              <div className="flex items-center gap-1.5 text-[10px] text-dim" title={entry.model.model}>
                <SourceTag model={entry.model.model} />
                <span>{t(LIFETIME_KEYS[entry.group.id])}</span>
                {entry.model.writeMultiple !== null && <span>{t('analytics.promptCache.table.writeMultiple', { multiple: entry.model.writeMultiple })}</span>}
                {entry.model.longPrompt && entry.model.longPrompt.calls > 0 && (
                  <span title={t('analytics.promptCache.table.longPromptTitle', { tokens: `${Math.round(entry.model.longPrompt.over / 1000)}K`, multiple: entry.model.longPrompt.multiple })}>
                    {t('analytics.promptCache.table.longPrompt', { share: Math.max(1, Math.round((entry.model.longPrompt.calls / entry.model.calls) * 100)), tokens: `${Math.round(entry.model.longPrompt.over / 1000)}K`, multiple: entry.model.longPrompt.multiple })}
                  </span>
                )}
                {entry.model.estimatedCalls > 0 && <span title={t('analytics.promptCache.table.estimatedTitle')}>{t('analytics.promptCache.table.estimated')}</span>}
                {entry.summary.hitRate !== null && <span>{t('analytics.promptCache.table.hitRate', { rate: Math.round(entry.summary.hitRate * 100) })}</span>}
                {entry.group.id !== 'automatic' && entry.summary.confidence !== 'solid' && (
                  <span className={clsx('rounded-full px-1.5 font-medium', CONFIDENCE_CLASSES[entry.summary.confidence])}>{t(CONFIDENCE_KEYS[entry.summary.confidence])}</span>
                )}
              </div>,
              entry.recommended,
              entry.group.id === 'automatic',
              false,
              entry,
            ))}
            {multi && row(ALL_KEY, t('analytics.promptCache.allModels'), totalCost, null, null, false, true)}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[10px] text-faint">{t('analytics.promptCache.table.footnote')}</p>
    </div>
  )
}

/** Cache warming on or off, Apply recommendations, and Away, above the table they act on. */
function SettingsBar({ entries, controls }: { entries: ModelEntry[]; controls: CacheSettingsControls }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { state, busy } = controls
  const recommendations: CacheRecommendation[] = entries
    .filter((entry) => settable(entry) && entry.recommended !== null)
    .map((entry) => ({ model: entry.model.model, setting: entry.recommended as CacheSetting, lowData: entry.summary.confidence === 'none' }))
  const pending = recommendations.filter((entry) => !entry.lowData && state.models[entry.model] !== entry.setting)
  const needsWarming = pending.some((entry) => typeof entry.setting === 'number' && entry.setting > 0)
  const apply = (): void => {
    controls.onSet(Object.fromEntries(pending.map((entry) => [entry.model, entry.setting])))
    if (needsWarming && !state.warming) controls.onWarming(true)
  }
  const awayTime = state.away === null ? null : new Date(state.away).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })
  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-primary">{t('analytics.promptCache.settings.title')}</div>
          <p className="mt-0.5 text-[11px] text-dim">{t('analytics.promptCache.settings.note')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-muted" title={t('analytics.promptCache.settings.warmingTitle')}>
            <input type="checkbox" checked={state.warming} disabled={busy} onChange={(event) => controls.onWarming(event.target.checked)} />
            {t(state.warming ? 'analytics.promptCache.settings.warmingOn' : 'analytics.promptCache.settings.warmingOff')}
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => controls.onAway(state.away === null)}
            title={t('analytics.promptCache.settings.awayTitle')}
            className="flex h-7 items-center rounded-md border border-border px-2 text-[11px] text-muted hover:bg-surface-hover disabled:opacity-50"
          >
            {awayTime === null ? t('analytics.promptCache.settings.away') : t('analytics.promptCache.settings.awayClear', { time: awayTime })}
          </button>
          <button
            type="button"
            disabled={busy || pending.length === 0}
            onClick={apply}
            className="flex h-7 items-center rounded-md bg-accent px-2.5 text-[11px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {pending.length ? t('analytics.promptCache.settings.apply', { count: pending.length }) : t('analytics.promptCache.settings.applied')}
          </button>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-dim">
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-accent" />{t('analytics.promptCache.settings.inUse')}</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm ring-1 ring-success" />{t('analytics.promptCache.settings.recommended')}</span>
        <span>{t('analytics.promptCache.settings.lowData')}</span>
      </div>
      {!state.warming && <p className="rounded border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning">{t('analytics.promptCache.settings.offNote')}</p>}
      {state.away !== null && awayTime !== null && <p className="text-[11px] text-dim">{t('analytics.promptCache.settings.awayNote', { time: awayTime })}</p>}
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


/** The list prices of the models in the analysis, with the rates past each long-prompt threshold. */
function ModelPrices({ models }: { models: string[] }): React.JSX.Element | null {
  const { t } = useTranslation()
  // Copilot and imported logs bill the vendor's rates, so one row per model id.
  const ids = [...new Set(models.map(modelName))].sort((a, b) => a.localeCompare(b))
  if (ids.length === 0) return null
  const multiples = (band: PriceBand | null): React.JSX.Element => (
    <>
      {[band?.cacheRead ?? null, band?.writeShort ?? null, band?.writeLong ?? null].map((price, index) => (
        <td key={index} className={clsx('py-1 pl-2 text-right tabular-nums text-dim', index === 0 && 'border-l border-border pl-3', index === 2 && 'pr-2')}>
          {band ? formatMultiple(price, band.input) : ''}
        </td>
      ))}
    </>
  )
  const cells = (band: PriceBand, lifetimes: [string, string] | null): React.JSX.Element => (
    <>
      <td className="py-1 pl-2 text-right tabular-nums">{formatPerMillion(band.input)}</td>
      <td className="py-1 pl-2 text-right tabular-nums">{formatPerMillion(band.output)}</td>
      <td className="py-1 pl-2 text-right tabular-nums">{formatPerMillion(band.cacheRead)}</td>
      <td className="py-1 pl-2 text-right tabular-nums">{formatPerMillion(band.writeShort)}{lifetimes && <span className="ml-1 text-[10px] text-faint">{lifetimes[0]}</span>}</td>
      <td className="py-1 pl-2 text-right tabular-nums">{formatPerMillion(band.writeLong)}{lifetimes && <span className="ml-1 text-[10px] text-faint">{lifetimes[1]}</span>}</td>
    </>
  )
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="text-xs font-semibold text-primary">{t('analytics.promptCache.prices.title')}</div>
      <p className="mt-0.5 text-[11px] text-dim">{t('analytics.promptCache.prices.note')}</p>
      <div className="mt-1.5 overflow-x-auto">
        <table className="w-full min-w-[860px] whitespace-nowrap text-xs">
          <thead>
            <tr className="text-[10px] text-faint">
              <th className="pb-1 pl-2 text-left font-medium">{t('analytics.promptCache.table.model')}</th>
              <th className="pb-1 pl-2 text-right font-medium">{t('analytics.promptCache.prices.input')}</th>
              <th className="pb-1 pl-2 text-right font-medium">{t('analytics.promptCache.prices.output')}</th>
              <th className="pb-1 pl-2 text-right font-medium">{t('analytics.promptCache.prices.read')}</th>
              <th className="pb-1 pl-2 text-right font-medium">{t('analytics.promptCache.prices.writeShort')}</th>
              <th className="pb-1 pl-2 text-right font-medium">{t('analytics.promptCache.prices.writeLong')}</th>
              <th className="border-l border-border pb-1 pl-3 text-right font-medium">{t('analytics.promptCache.prices.readMultiple')}</th>
              <th className="pb-1 pl-2 text-right font-medium">{t('analytics.promptCache.prices.shortMultiple')}</th>
              <th className="pb-1 pl-2 pr-2 text-right font-medium">{t('analytics.promptCache.prices.longMultiple')}</th>
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => {
              const sheet = priceSheet(id)
              return (
                <Fragment key={id}>
                  <tr className="border-t border-border text-secondary">
                    <td className="py-1 pl-2 font-mono text-primary">{id}</td>
                    {sheet ? <>{cells(sheet.base, sheet.lifetimes)}{multiples(sheet.base)}</> : (
                      <td colSpan={8} className="py-1 pl-2 text-right text-faint">{t('analytics.promptCache.prices.unknown')}</td>
                    )}
                  </tr>
                  {sheet?.longPrompt && (
                    <tr className="text-warning">
                      <td className="pb-1 pl-5 text-[11px]">{t('analytics.promptCache.prices.over', { tokens: `${Math.round(sheet.longPrompt.over / 1000)}K`, multiple: Number((sheet.longPrompt.input / sheet.base.input).toFixed(2)) })}</td>
                      {cells(sheet.longPrompt, sheet.lifetimes)}
                      {multiples(null)}
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[10px] text-faint">{t('analytics.promptCache.prices.footnote')}</p>
    </div>
  )
}
