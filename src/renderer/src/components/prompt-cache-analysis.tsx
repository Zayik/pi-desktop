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
  summarize,
  type CacheAnalysis,
  type CacheConfidence,
  type CacheGroupAnalysis,
  type CacheGroupId,
  type CacheModelAnalysis,
} from '../../../shared/cache-analysis'
import { CACHE_RULES_CHECKED } from '../../../shared/cache-policy'
import type { Translate } from '../../../shared/i18n'

const MINUTE = 60_000
/** Points per line; longer windows are sampled down to this. */
const MAX_POINTS = 1200
/** Models on by default: the most used ones that ran in the last week of the window. */
const DEFAULT_MODELS = 4
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

/** One color per model line, in order; past six they repeat dashed. */
const MODEL_COLORS = [
  { stroke: 'stroke-accent-fg', fill: 'bg-accent-fg' },
  { stroke: 'stroke-success', fill: 'bg-success' },
  { stroke: 'stroke-special', fill: 'bg-special' },
  { stroke: 'stroke-warning', fill: 'bg-warning' },
  { stroke: 'stroke-error', fill: 'bg-error' },
  { stroke: 'stroke-muted', fill: 'bg-muted' },
]
const TOTAL_KEY = '*'

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

function niceStep(raw: number): number {
  const power = Math.pow(10, Math.floor(Math.log10(raw)))
  const fraction = raw / power
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power
}

/** A whole number of pings for every model (capped at what Pi sends for it), or each model's own best count. */
type PingChoice = number | 'optimal'
type ChartMode = 'saving' | 'total'

interface ModelEntry {
  model: CacheModelAnalysis
  group: CacheGroupAnalysis
  color: (typeof MODEL_COLORS)[number]
  dashed: boolean
  /** The count the chosen setting gives this model, and the one Optimal gives it. */
  count: number
  optimal: number
  /** Cost per 30-minute slot over the whole window, with that count and with none. */
  cost: number[]
  none: number[]
}

interface Line {
  key: string
  label: string
  stroke: string
  dashed: boolean
  /** Per slot: the cost (total) or the cost minus no pings (saving). */
  steps: number[]
}

/** Prompt cost per model as running lines, with the ping count you pick; read only. */
export function PromptCacheAnalysis({ analysis }: { analysis: CacheAnalysis }): React.JSX.Element | null {
  const { t, i18n } = useTranslation()
  const [choice, setChoice] = useState<PingChoice>('optimal')
  const [mode, setMode] = useState<ChartMode>('saving')
  const [picked, setPicked] = useState<string[] | null>(null)
  const [selectedDay, setSelectedDay] = useState<number | null>(null)
  const days = useMemo(() => dayStarts(analysis.from, analysis.to), [analysis.from, analysis.to])
  const optimal = useMemo(() => optimalCounts(analysis), [analysis])
  const maxPings = Math.max(0, ...analysis.groups.map((group) => group.maxPings))
  const slots = days.length * SLOTS_PER_DAY

  const entries = useMemo(() => analysis.groups
    .flatMap((group) => group.models.map((model) => ({ model, group })))
    .sort((a, b) => b.model.calls - a.model.calls)
    .map(({ model, group }, index): ModelEntry => {
      const count = group.id === 'automatic' ? 0 : choice === 'optimal' ? optimal.get(model.model) ?? 0 : Math.min(choice, group.maxPings)
      return {
        model,
        group,
        color: MODEL_COLORS[index % MODEL_COLORS.length],
        dashed: index >= MODEL_COLORS.length,
        count,
        optimal: optimal.get(model.model) ?? 0,
        ...slotCosts(model, count, analysis.from, slots),
      }
    }), [analysis, choice, optimal, slots])

  // The most used models that ran recently; the rest wait to be switched on.
  const defaults = useMemo(() => {
    const recentFrom = Math.max(0, slots - RECENT_DAYS * SLOTS_PER_DAY)
    const recent = entries.filter((entry) => entry.none.slice(recentFrom).some((value) => value > 0)).slice(0, DEFAULT_MODELS)
    return [TOTAL_KEY, ...(recent.length > 0 ? recent : entries.slice(0, 1)).map((entry) => entry.model.model)]
  }, [entries, slots])
  const shown = picked ?? defaults

  if (entries.length === 0) return null
  const weeks = Math.max(analysis.days, 1) / 7
  const multi = entries.length > 1
  const totalCost = sum(entries.map((entry) => sum(entry.cost)))
  const totalSaving = sum(entries.map((entry) => sum(entry.none))) - totalCost
  const choiceLabel = choice === 'optimal' ? t('analytics.promptCache.choice.optimal') : pingsLabel(choice, t)
  const capped = typeof choice === 'number' && analysis.groups.some((group) => group.id !== 'automatic' && group.maxPings < choice)
  const toggle = (key: string): void => {
    const next = shown.includes(key) ? shown.filter((entry) => entry !== key) : [...shown, key]
    setPicked(next)
  }

  const steps = (entry: ModelEntry): number[] => mode === 'total' ? entry.cost : entry.cost.map((value, slot) => value - entry.none[slot])
  const lines: Line[] = [
    ...(multi && shown.includes(TOTAL_KEY)
      ? [{
        key: TOTAL_KEY,
        label: t('analytics.promptCache.allModels'),
        stroke: 'stroke-primary',
        dashed: false,
        steps: entries.reduce((total, entry) => { const own = steps(entry); return total.map((value, slot) => value + own[slot]) }, new Array<number>(slots).fill(0)),
      }]
      : []),
    ...entries.filter((entry) => shown.includes(entry.model.model)).map((entry): Line => ({
      key: entry.model.model,
      label: modelName(entry.model.model),
      stroke: entry.color.stroke,
      dashed: entry.dashed,
      steps: steps(entry),
    })),
  ]
  const dayLabel = (index: number): string => new Date(days[index]).toLocaleDateString(i18n.language, { weekday: 'short', month: 'short', day: 'numeric' })

  return (
    <section className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-dim">{t('analytics.promptCache.title')}</h3>
        <span className="text-[10px] text-faint">{t('analytics.promptCache.note', { count: analysis.days })}</span>
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-surface px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[11px] text-dim">{t('analytics.promptCache.choice.label')}</span>
            <Segmented
              label={t('analytics.promptCache.choice.label')}
              options={[...Array.from({ length: maxPings + 1 }, (_, count): PingChoice => count), 'optimal' as const]}
              value={choice}
              onChange={setChoice}
              render={(entry) => entry === 'optimal' ? t('analytics.promptCache.choice.optimal') : entry === 0 ? t('analytics.promptCache.noPings') : String(entry)}
            />
          </div>
          <Segmented
            label={t('analytics.promptCache.chart.modeLabel')}
            options={['saving', 'total'] as ChartMode[]}
            value={mode}
            onChange={setMode}
            render={(entry) => entry === 'saving' ? t('analytics.promptCache.chart.saving') : t('analytics.promptCache.chart.total')}
          />
        </div>
        <p className="text-[11px] text-dim">
          {choice === 'optimal' ? t('analytics.promptCache.choice.optimalNote') : t('analytics.promptCache.choice.fixedNote', { pings: choiceLabel })}
          {capped && ` ${t('analytics.promptCache.choice.capped')}`}
        </p>
        <p className="text-[13px] font-medium leading-snug text-primary">
          {choice === 0
            ? t('analytics.promptCache.headline.noPings', { count: analysis.days, cost: money(totalCost) })
            : totalSaving >= 0.005
              ? t('analytics.promptCache.headline.saves', { count: analysis.days, pings: choiceLabel, cost: money(totalCost), saving: money(totalSaving), weekly: money(totalSaving / weeks) })
              : t('analytics.promptCache.headline.costs', { count: analysis.days, pings: choiceLabel, cost: money(totalCost), extra: money(-totalSaving) })}
        </p>

        <div role="group" aria-label={t('analytics.promptCache.models.filter')} className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] text-dim">{t('analytics.promptCache.models.label')}</span>
          {multi && <Chip on={shown.includes(TOTAL_KEY)} swatch="bg-primary" onClick={() => toggle(TOTAL_KEY)}>{t('analytics.promptCache.allModels')}</Chip>}
          {entries.map((entry) => (
            <Chip key={entry.model.model} on={shown.includes(entry.model.model)} swatch={entry.color.fill} title={entry.model.model} onClick={() => toggle(entry.model.model)}>
              {modelName(entry.model.model)}
            </Chip>
          ))}
        </div>

        {lines.length === 0 ? (
          <p className="py-6 text-center text-xs text-dim">{t('analytics.promptCache.models.none')}</p>
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
                    title={t('analytics.promptCache.chart.expand', { day: dayLabel(index) })}
                    className={clsx('min-w-0 truncate rounded py-0.5 text-center text-[10px]', selectedDay === index ? 'bg-accent-bg font-medium text-accent-fg' : 'text-faint hover:bg-surface-hover hover:text-secondary')}
                  >
                    {new Date(start).toLocaleDateString(i18n.language, { day: 'numeric' })}
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
        <p className="text-[10px] text-faint">{mode === 'saving' ? t('analytics.promptCache.chart.savingNote') : t('analytics.promptCache.chart.totalNote')}</p>
      </div>

      {selectedDay !== null && (
        <DayView
          entries={entries.filter((entry) => shown.includes(entry.model.model))}
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

      <ModelTable entries={entries} analysis={analysis} weeks={weeks} shown={shown} onToggle={toggle} />
      <p className="text-[10px] text-faint">{t('analytics.cache.rulesAsOf', { date: CACHE_RULES_CHECKED })}</p>
    </section>
  )
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

function Chip({ on, swatch, onClick, title, children }: { on: boolean; swatch: string; onClick: () => void; title?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={clsx('flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px]', on ? 'border-border-strong bg-card text-primary' : 'border-border text-dim hover:bg-surface-hover')}
    >
      <span className={clsx('h-2 w-2 rounded-full', on ? swatch : 'bg-faint')} />
      {children}
    </button>
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

  return (
    <div className="flex">
      <div className="relative w-14 shrink-0" aria-hidden="true">
        {ticks.map((tick) => (
          <span key={tick} className="absolute right-2 -translate-y-1/2 text-[10px] text-dim tabular-nums" style={{ top: `${(y(tick) / 100) * 12}rem` }}>
            {money(tick, signed && Math.abs(tick) > 1e-9)}
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative h-48">
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
                strokeWidth={line.key === TOTAL_KEY ? 2.5 : 1.75}
                strokeDasharray={line.dashed ? '5 3' : undefined}
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
              className="pointer-events-none absolute top-1 z-10 w-56 rounded-lg border border-border bg-elevated px-2.5 py-2 text-[11px] shadow-lg"
              style={hover / span > 0.6 ? { right: `${100 - (hover / span) * 100 + 1}%` } : { left: `${(hover / span) * 100 + 1}%` }}
            >
              <div className="mb-1 font-medium text-primary">{pointLabel(first + hover)}</div>
              {lines.map((line, index) => (
                <div key={line.key} className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5 truncate text-secondary">
                    <svg width="12" height="4" aria-hidden="true" className="shrink-0"><line x1="0" x2="12" y1="2" y2="2" className={line.stroke} strokeWidth={2.5} strokeDasharray={line.dashed ? '3 2' : undefined} /></svg>
                    {line.label}
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

/** One day in 30-minute blocks for the models shown, with the cheapest count for each block that had a break. */
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
                          className={clsx('min-w-0 flex-1 rounded-sm text-center text-[9px] font-semibold leading-4 tabular-nums', cell ? clsx(entry.color.fill, 'text-inverse') : 'bg-card/40 text-transparent')}
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

function ModelTable({ entries, analysis, weeks, shown, onToggle }: { entries: ModelEntry[]; analysis: CacheAnalysis; weeks: number; shown: string[]; onToggle: (model: string) => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="text-xs font-semibold text-primary">{t('analytics.promptCache.models.title')}</div>
      <p className="mt-0.5 text-[11px] text-dim">{t('analytics.promptCache.models.note')}</p>
      <div className="mt-1.5 overflow-x-auto">
        <table className="w-full min-w-[640px] whitespace-nowrap text-xs">
          <thead>
            <tr className="text-[10px] text-faint">
              <th className="pb-1 text-left font-medium">{t('analytics.promptCache.models.model')}</th>
              <th className="pb-1 pl-3 text-left font-medium">{t('analytics.promptCache.models.cache')}</th>
              <th className="pb-1 text-right font-medium">{t('analytics.promptCache.models.hitRate')}</th>
              <th className="pb-1 pl-3 text-left font-medium">{t('analytics.promptCache.models.best')}</th>
              <th className="pb-1 text-right font-medium">{t('analytics.promptCache.models.saves')}</th>
              <th className="pb-1 text-right font-medium">{t('analytics.promptCache.models.vsNoCache')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const own = summarize([entry.model], entry.group.maxPings, analysis.days)
              const automatic = entry.group.id === 'automatic'
              const saving = (sum(entry.none) - sum(entry.cost)) / weeks
              const on = shown.includes(entry.model.model)
              return (
                <tr key={entry.model.model} className="border-t border-border/60">
                  <td className="py-1 pr-2">
                    <button type="button" onClick={() => onToggle(entry.model.model)} aria-pressed={on} title={entry.model.model} className="flex items-center gap-1.5 font-mono text-primary hover:underline">
                      <span className={clsx('h-2 w-2 shrink-0 rounded-full', on ? entry.color.fill : 'bg-faint')} />
                      {modelName(entry.model.model)}
                    </button>
                  </td>
                  <td className="py-1 pl-3 text-secondary">{t(LIFETIME_KEYS[entry.group.id])}</td>
                  <td className="py-1 text-right tabular-nums text-secondary">{own.hitRate === null ? '–' : `${Math.round(own.hitRate * 100)}%`}</td>
                  <td className="py-1 pl-3">
                    {automatic
                      ? <span className="text-dim">{t('analytics.promptCache.models.providerRuns')}</span>
                      : (
                        <span className="flex items-center gap-1.5">
                          <span className="text-secondary">{own.confidence === 'none' ? t('analytics.promptCache.models.usesGroup', { pings: pingsLabel(entry.optimal, t) }) : pingsLabel(own.best, t)}</span>
                          <span className={clsx('rounded-full px-1.5 text-[10px] font-medium', CONFIDENCE_CLASSES[own.confidence])}>{t(CONFIDENCE_KEYS[own.confidence])}</span>
                        </span>
                      )}
                  </td>
                  <td className={clsx('py-1 text-right tabular-nums', saving <= -0.005 ? 'text-error' : 'text-success')}>
                    {automatic || entry.count === 0 ? '–' : saving <= -0.005 ? t('analytics.promptCache.models.costsMore', { cost: money(-saving) }) : money(saving)}
                  </td>
                  <td className={clsx('py-1 text-right tabular-nums', own.cacheSavingPerWeek < 0 ? 'text-warning' : 'text-secondary')}>
                    {own.noCacheTotal > 0 ? own.cacheSavingPerWeek < 0 ? t('analytics.promptCache.models.noCacheCheaper', { cost: money(-own.cacheSavingPerWeek) }) : money(own.cacheSavingPerWeek) : '–'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

