import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import {
  SLOTS_PER_DAY,
  SLOT_MS,
  dayStarts,
  pingSeries,
  slotBest,
  summarize,
  weekSplit,
  type CacheAnalysis,
  type CacheConfidence,
  type CacheGroupAnalysis,
  type CacheGroupId,
  type CacheModelAnalysis,
  type PingSeriesMode,
  type PingSummary,
} from '../../../shared/cache-analysis'
import { CACHE_RULES_CHECKED } from '../../../shared/cache-policy'
import type { Translate } from '../../../shared/i18n'

/** Day buttons under the chart up to this many days; longer windows zoom by clicking the chart. */
const MAX_DAY_BUTTONS = 31
/** Points per line; longer windows are sampled down to this. */
const MAX_POINTS = 1200
const MINUTE = 60_000

const GROUP_NAME_KEYS = {
  '5m': 'analytics.promptCache.group.fiveMinutes',
  '30m': 'analytics.promptCache.group.thirtyMinutes',
  automatic: 'analytics.promptCache.group.automatic',
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

/** Cells of the zoomed day, by cheapest count: deeper for more pings. */
const CELL_OPACITY = [0.15, 0.3, 0.42, 0.55, 0.7, 0.85, 1]

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

function niceStep(raw: number): number {
  const power = Math.pow(10, Math.floor(Math.log10(raw)))
  const fraction = raw / power
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power
}

/** The card's one-sentence answer. */
export function groupHeadline(group: CacheGroupAnalysis, summary: PingSummary, t: Translate): string {
  if (group.id === 'automatic') {
    return summary.hitRate === null ? t('analytics.promptCache.headline.automaticNone') : t('analytics.promptCache.headline.automatic', { rate: Math.round(summary.hitRate * 100) })
  }
  if (summary.confidence === 'none') return t('analytics.promptCache.headline.thin', { count: summary.longBreaks, minutes: group.lifetimeMinutes })
  if (summary.best === 0) return t('analytics.promptCache.headline.none')
  const text = t('analytics.promptCache.headline.save', { count: summary.best, cost: money(summary.savingPerWeek) })
  return summary.tie === null ? text : `${text} ${t('analytics.promptCache.headline.tie', { low: Math.min(summary.tie, summary.best), high: Math.max(summary.tie, summary.best) })}`
}

/** What pings would have saved per lifetime group, and how many: read only. */
export function PromptCacheAnalysis({ analysis }: { analysis: CacheAnalysis }): React.JSX.Element | null {
  const { t } = useTranslation()
  const warmable = analysis.groups.filter((group) => group.id !== 'automatic')
  const [groupId, setGroupId] = useState<CacheGroupId | null>(warmable[0]?.id ?? null)
  const summaries = useMemo(() => new Map(analysis.groups.map((group) => [group.id, summarize(group.models, group.maxPings, analysis.days)])), [analysis])
  if (analysis.groups.length === 0) return null
  const active = warmable.find((group) => group.id === groupId) ?? warmable[0] ?? null
  return (
    <section className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-dim">{t('analytics.promptCache.title')}</h3>
        <span className="text-[10px] text-faint">{t('analytics.promptCache.note', { count: analysis.days })}</span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-2">
        {analysis.groups.map((group) => (
          <GroupCard
            key={group.id}
            group={group}
            summary={summaries.get(group.id)!}
            days={analysis.days}
            selected={active?.id === group.id}
            onOpen={group.id === 'automatic' ? null : () => setGroupId(group.id)}
          />
        ))}
      </div>
      {active && <GroupDetails key={active.id} analysis={analysis} group={active} />}
      <p className="text-[10px] text-faint">{t('analytics.cache.rulesAsOf', { date: CACHE_RULES_CHECKED })}</p>
    </section>
  )
}

function GroupCard({ group, summary, days, selected, onOpen }: { group: CacheGroupAnalysis; summary: PingSummary; days: number; selected: boolean; onOpen: (() => void) | null }): React.JSX.Element {
  const { t } = useTranslation()
  const automatic = group.id === 'automatic'
  return (
    <div className={clsx('flex min-w-0 flex-col gap-2 rounded-lg border bg-surface px-3 py-2.5', selected ? 'border-accent' : 'border-border')}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-primary">{t(GROUP_NAME_KEYS[group.id])}</span>
        <span className={clsx('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium', automatic ? 'bg-card text-dim' : CONFIDENCE_CLASSES[summary.confidence])}>
          {automatic ? t('analytics.promptCache.readOnly') : t(CONFIDENCE_KEYS[summary.confidence])}
        </span>
      </div>
      <div className="truncate text-[11px] text-dim" title={group.models.map((model) => model.model).join(', ')}>
        {group.models.map((model) => modelName(model.model)).join(', ')}
      </div>
      <p className="text-[13px] font-medium leading-snug text-primary">{groupHeadline(group, summary, t)}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Stat label={t('analytics.promptCache.hitRate')} value={summary.hitRate === null ? '–' : `${Math.round(summary.hitRate * 100)}%`} />
        {!automatic && <Stat label={t('analytics.promptCache.best')} value={summary.confidence === 'none' ? '–' : pingsLabel(summary.best, t)} />}
        {!automatic && <Stat label={t('analytics.promptCache.savesPerWeek')} value={summary.confidence === 'none' || summary.best === 0 ? '–' : money(summary.savingPerWeek)} />}
      </div>
      <p className="text-[11px] text-dim">
        {automatic
          ? t('analytics.promptCache.automaticBasis')
          : t('analytics.promptCache.basis', { count: days, breaks: summary.longBreaks, minutes: group.lifetimeMinutes, reach: Math.round(group.reachMinutes ?? 0) })}
      </p>
      {onOpen && (
        <button
          type="button"
          onClick={onOpen}
          aria-pressed={selected}
          className={clsx('self-start rounded border px-2.5 py-1 text-[11px] font-medium', selected ? 'border-accent bg-accent-bg text-accent-fg' : 'border-border text-secondary hover:bg-surface-hover')}
        >
          {selected ? t('analytics.promptCache.showing') : t('analytics.promptCache.details')}
        </button>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-dim">{label}</span>
      <span className="text-sm font-semibold text-primary tabular-nums">{value}</span>
    </div>
  )
}

type LineKind = 'count' | 'perBreak' | 'perModel'
interface LineSpec {
  index: number
  kind: LineKind
  count: number
}

function GroupDetails({ analysis, group }: { analysis: CacheAnalysis; group: CacheGroupAnalysis }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [picked, setPicked] = useState<string[] | null>(null)
  const [mode, setMode] = useState<PingSeriesMode>('saving')
  const [zoom, setZoom] = useState<number | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [focus, setFocus] = useState<number | null>(null)

  const models = useMemo(() => (picked ? group.models.filter((model) => picked.includes(model.model)) : group.models), [picked, group.models])
  const multi = models.length > 1
  const summary = useMemo(() => summarize(models, group.maxPings, analysis.days), [models, group.maxPings, analysis.days])
  const days = useMemo(() => dayStarts(analysis.from, analysis.to), [analysis.from, analysis.to])
  const totalSlots = days.length * SLOTS_PER_DAY
  const lines = useMemo(() => pingSeries(models, group.maxPings, summary.modelBest, analysis.from, totalSlots, mode), [models, group.maxPings, summary.modelBest, analysis.from, totalSlots, mode])

  const zoomed = zoom !== null
  const first = zoomed ? Math.round((days[zoom] - analysis.from) / SLOT_MS) : 0
  const last = zoomed ? first + SLOTS_PER_DAY : totalSlots
  const span = Math.max(1, last - first)
  const value = (line: number, slot: number): number => lines[line][slot] - (zoomed ? lines[line][first] : 0)

  const perBreak = group.maxPings + 1
  const perModel = group.maxPings + 2
  const specs: LineSpec[] = [
    ...Array.from({ length: group.maxPings + 1 }, (_, count): LineSpec => ({ index: count, kind: 'count', count })),
    ...(multi ? [{ index: perModel, kind: 'perModel' as const, count: 0 }] : []),
    { index: perBreak, kind: 'perBreak', count: 0 },
  ]

  let low = 0
  let high = 0
  for (const spec of specs) {
    for (let slot = first; slot <= last; slot++) {
      const v = value(spec.index, slot)
      if (v < low) low = v
      if (v > high) high = v
    }
  }
  const step = niceStep(Math.max(0.01, (high - low) / 4))
  // The epsilon keeps rounding noise from adding an empty band above or below.
  low = Math.floor(low / step + 1e-9) * step
  high = Math.max(low + step, Math.ceil(high / step - 1e-9) * step)
  const ticks: number[] = []
  for (let tick = low; tick <= high + step / 2; tick += step) ticks.push(tick)
  const y = (v: number): number => 100 - ((v - low) / (high - low)) * 100
  const x = (slot: number): number => ((slot - first) / span) * 1000
  const stride = Math.max(1, Math.ceil(span / MAX_POINTS))
  const path = (line: number): string => {
    const points: string[] = []
    for (let slot = first; slot <= last; slot += stride) points.push(`${points.length === 0 ? 'M' : 'L'}${x(slot).toFixed(1)} ${y(value(line, slot)).toFixed(2)}`)
    if ((last - first) % stride !== 0) points.push(`L${x(last).toFixed(1)} ${y(value(line, last)).toFixed(2)}`)
    return points.join(' ')
  }

  const lineClass = (spec: LineSpec): string => {
    const faded = focus !== null && focus !== spec.index
    if (spec.kind === 'perBreak') return clsx('stroke-special', faded && 'opacity-25')
    if (spec.kind === 'perModel') return clsx('stroke-success', faded && 'opacity-25')
    if (spec.count === summary.best) return clsx('stroke-accent', faded && 'opacity-25')
    if (focus === spec.index) return 'stroke-primary'
    return clsx(spec.count === 0 ? 'stroke-dim' : 'stroke-border-strong', faded && 'opacity-25')
  }
  const lineWidth = (spec: LineSpec): number => (spec.kind !== 'count' || spec.count === summary.best || focus === spec.index ? 2.25 : 1.25)
  const lineLabel = (spec: LineSpec): string => spec.kind === 'perBreak' ? t('analytics.promptCache.line.perBreak') : spec.kind === 'perModel' ? t('analytics.promptCache.line.perModel') : pingsLabel(spec.count, t)
  const signed = mode === 'saving'
  const order = [...specs].sort((a, b) => rank(a) - rank(b))
  function rank(spec: LineSpec): number {
    if (focus === spec.index) return 4
    if (spec.kind === 'perBreak') return 3
    if (spec.kind === 'perModel') return 2
    return spec.count === summary.best ? 1 : 0
  }

  const dayLabel = (at: number): string => new Date(at).toLocaleDateString(i18n.language, { weekday: 'short', day: 'numeric' })
  // Past two weeks the strip has room for the date alone.
  const stripLabel = (at: number): string => new Date(at).toLocaleDateString(i18n.language, days.length > 14 ? { day: 'numeric' } : { weekday: 'short', day: 'numeric' })
  const longDay = (at: number): string => new Date(at).toLocaleDateString(i18n.language, { weekday: 'long', month: 'short', day: 'numeric' })
  const clock = (at: number): string => new Date(at).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const slotTime = (slot: number): number => analysis.from + slot * SLOT_MS

  const onMove = (event: React.MouseEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    const slot = first + Math.round(((event.clientX - rect.left) / rect.width) * span)
    setHover(Math.max(first, Math.min(last, slot)))
  }
  const zoomInto = (index: number): void => {
    setZoom(Math.max(0, Math.min(days.length - 1, index)))
    setHover(null)
  }
  const hoverDay = hover === null ? null : Math.min(days.length - 1, Math.floor(hover / SLOTS_PER_DAY))

  const dayBest = useMemo(() => days.map((start, index) => {
    const cells = slotBest(models, group.maxPings, start)
    if (!cells.some((cell) => cell !== null)) return null
    const fromSlot = index * SLOTS_PER_DAY
    let best = 0
    for (let count = 1; count <= group.maxPings; count++) {
      const cost = (n: number): number => lines[n][fromSlot + SLOTS_PER_DAY] - lines[n][fromSlot]
      if (cost(count) < cost(best) - 1e-12) best = count
    }
    return best
  }), [days, models, group.maxPings, lines])
  const cells = zoomed ? slotBest(models, group.maxPings, days[zoom]) : []
  const split = weekSplit(models, group.maxPings, analysis.to, analysis.days)
  const weeks = Math.max(analysis.days, 1) / 7

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-xs font-semibold text-primary">
            {zoomed ? longDay(days[zoom]) : t('analytics.promptCache.chart.title')} · {t(GROUP_NAME_KEYS[group.id])}
          </h4>
          <p className="mt-0.5 text-[11px] text-dim">
            {zoomed ? t('analytics.promptCache.chart.zoomNote') : signed ? t('analytics.promptCache.chart.savingNote') : t('analytics.promptCache.chart.totalNote')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {zoomed && (
            <>
              <button type="button" onClick={() => zoomInto(zoom - 1)} disabled={zoom === 0} aria-label={t('analytics.promptCache.chart.previousDay')} className="rounded border border-border p-1 text-muted hover:bg-surface-hover disabled:opacity-40"><ChevronLeft size={14} /></button>
              <button type="button" onClick={() => zoomInto(zoom + 1)} disabled={zoom === days.length - 1} aria-label={t('analytics.promptCache.chart.nextDay')} className="rounded border border-border p-1 text-muted hover:bg-surface-hover disabled:opacity-40"><ChevronRight size={14} /></button>
              <button type="button" onClick={() => setZoom(null)} className="rounded border border-border px-2 py-1 text-[11px] text-secondary hover:bg-surface-hover">{t('analytics.promptCache.chart.back', { count: analysis.days })}</button>
            </>
          )}
          <div role="group" aria-label={t('analytics.promptCache.chart.modeLabel')} className="flex overflow-hidden rounded border border-border">
            {(['saving', 'total'] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                aria-pressed={mode === entry}
                onClick={() => setMode(entry)}
                className={clsx('px-2 py-1 text-[11px]', mode === entry ? 'bg-card font-medium text-primary' : 'text-muted hover:bg-surface-hover')}
              >
                {entry === 'saving' ? t('analytics.promptCache.chart.saving') : t('analytics.promptCache.chart.total')}
              </button>
            ))}
          </div>
        </div>
      </div>

      {group.models.length > 1 && (
        <div role="group" aria-label={t('analytics.promptCache.models.filter')} className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] text-dim">{t('analytics.promptCache.models.label')}</span>
          <Chip on={picked === null} onClick={() => setPicked(null)}>{t('analytics.promptCache.models.all')}</Chip>
          {group.models.map((model) => {
            const on = picked !== null && picked.includes(model.model)
            return (
              <Chip
                key={model.model}
                on={on}
                title={model.model}
                onClick={() => {
                  if (picked === null) return setPicked([model.model])
                  const next = on ? picked.filter((name) => name !== model.model) : [...picked, model.model]
                  setPicked(next.length === 0 || next.length === group.models.length ? null : next)
                }}
              >
                {modelName(model.model)}
              </Chip>
            )
          })}
        </div>
      )}

      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-[999_1_480px]">
          <div className="flex">
            <div className="relative w-14 shrink-0" aria-hidden="true">
              {ticks.map((tick) => (
                <span key={tick} className="absolute right-2 -translate-y-1/2 text-[10px] text-dim tabular-nums" style={{ top: `${(y(tick) / 100) * 12}rem` }}>
                  {money(tick, signed && Math.abs(tick) > 1e-9)}
                </span>
              ))}
            </div>
            <div className="relative h-48 min-w-0 flex-1">
              <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label={t('analytics.promptCache.chart.aria')}>
                {!zoomed && days.map((start, index) => {
                  const weekday = new Date(start).getDay()
                  return weekday === 0 || weekday === 6
                    ? <rect key={start} x={x(index * SLOTS_PER_DAY)} y={0} width={(SLOTS_PER_DAY / span) * 1000} height={100} className="fill-card opacity-60" />
                    : null
                })}
                {ticks.map((tick) => (
                  <line key={tick} x1={0} x2={1000} y1={y(tick)} y2={y(tick)} className={Math.abs(tick) < 1e-9 ? 'stroke-faint' : 'stroke-border'} vectorEffect="non-scaling-stroke" strokeWidth={1} />
                ))}
                {(zoomed ? [6, 12, 18, 24, 30, 36, 42].map((slot) => first + slot) : days.slice(1).map((_, index) => (index + 1) * SLOTS_PER_DAY)).map((slot) => (
                  <line key={slot} x1={x(slot)} x2={x(slot)} y1={0} y2={100} className="stroke-border" vectorEffect="non-scaling-stroke" strokeWidth={1} />
                ))}
                {order.map((spec) => (
                  <path
                    key={spec.index}
                    d={path(spec.index)}
                    fill="none"
                    className={lineClass(spec)}
                    strokeWidth={lineWidth(spec)}
                    strokeDasharray={spec.kind === 'perBreak' ? '6 4' : undefined}
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={100} className="stroke-muted" vectorEffect="non-scaling-stroke" strokeWidth={1} />}
              </svg>
              <div
                className={clsx('absolute inset-0', zoomed ? 'cursor-crosshair' : 'cursor-zoom-in')}
                onMouseMove={onMove}
                onMouseLeave={() => setHover(null)}
                onClick={() => { if (!zoomed && hoverDay !== null) zoomInto(hoverDay) }}
              />
              {hover !== null && (
                <div
                  className="pointer-events-none absolute top-1 z-10 w-52 rounded-lg border border-border bg-elevated px-2.5 py-2 text-[11px] shadow-lg"
                  style={(hover - first) / span > 0.6 ? { right: `${100 - ((hover - first) / span) * 100 + 1}%` } : { left: `${((hover - first) / span) * 100 + 1}%` }}
                >
                  <div className="mb-1 font-medium text-primary">{t('analytics.promptCache.chart.upTo', { day: dayLabel(slotTime(Math.max(0, hover - 1))), time: clock(slotTime(hover)) })}</div>
                  {specs.map((spec) => (
                    <div key={spec.index} className={clsx('flex justify-between gap-2', (spec.kind !== 'count' || spec.count === summary.best) ? 'text-primary' : 'text-muted')}>
                      <span>{lineLabel(spec)}</span>
                      <span className="tabular-nums">{money(value(spec.index, hover), signed)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          {zoomed ? (
            <div className="ml-14 mt-1">
              <div className="flex justify-between text-[10px] text-faint tabular-nums">
                {[0, 12, 24, 36, 48].map((slot) => <span key={slot}>{slot === 48 ? '24:00' : clock(slotTime(first + slot))}</span>)}
              </div>
              <div className="mt-2 text-[10px] uppercase tracking-wide text-dim">{t('analytics.promptCache.cells.title')}</div>
              <div className="mt-1 grid grid-cols-[repeat(48,minmax(0,1fr))] gap-px">
                {cells.map((cell, slot) => (
                  <div
                    key={slot}
                    className={clsx('flex h-6 items-center justify-center rounded-sm text-[9px] font-semibold tabular-nums', cell ? 'text-primary' : 'bg-card')}
                    style={cell ? { backgroundColor: `color-mix(in srgb, var(--color-accent) ${Math.round(CELL_OPACITY[Math.min(cell.best, CELL_OPACITY.length - 1)] * 100)}%, transparent)` } : undefined}
                    title={cell
                      ? t('analytics.promptCache.cells.cell', {
                        from: clock(slotTime(first + slot)),
                        to: clock(slotTime(first + slot + 1)),
                        count: cell.gaps.length,
                        lengths: cell.gaps.map((gap) => Math.round(gap.gapMs / MINUTE)).join(', '),
                        best: pingsLabel(cell.best, t),
                        saving: money(cell.saving),
                      })
                      : t('analytics.promptCache.cells.empty', { from: clock(slotTime(first + slot)), to: clock(slotTime(first + slot + 1)) })}
                  >
                    {cell ? cell.best : ''}
                  </div>
                ))}
              </div>
              <p className="mt-1 text-[10px] text-faint">{t('analytics.promptCache.cells.note')}</p>
            </div>
          ) : days.length <= MAX_DAY_BUTTONS ? (
            <div className="ml-14 mt-1 grid" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
              {days.map((start, index) => (
                <button
                  key={start}
                  type="button"
                  onClick={() => zoomInto(index)}
                  title={t('analytics.promptCache.chart.expand', { day: longDay(start) })}
                  className="flex min-w-0 flex-col items-center rounded py-1 text-[10px] hover:bg-surface-hover"
                >
                  <span className="truncate text-muted">{stripLabel(start)}</span>
                  <span className={clsx('tabular-nums', dayBest[index] === null ? 'text-faint' : 'font-semibold text-accent-fg')}>{dayBest[index] === null ? '–' : dayBest[index]}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="ml-14 mt-1 flex justify-between text-[10px] text-faint">
              <span>{longDay(days[0])}</span>
              <span>{t('analytics.promptCache.chart.clickToZoom')}</span>
              <span>{longDay(days[days.length - 1])}</span>
            </div>
          )}
        </div>

        <div className="flex min-w-[230px] flex-1 flex-col gap-0.5">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-dim">{zoomed ? t('analytics.promptCache.legend.day') : t('analytics.promptCache.legend.total', { count: analysis.days })}</div>
          {specs.map((spec) => {
            const best = spec.kind === 'count' && spec.count === summary.best
            return (
              <button
                key={spec.index}
                type="button"
                onMouseEnter={() => setFocus(spec.index)}
                onMouseLeave={() => setFocus(null)}
                onFocus={() => setFocus(spec.index)}
                onBlur={() => setFocus(null)}
                className={clsx('flex items-center justify-between gap-2 rounded border px-2 py-1 text-left text-[11px]', best ? 'border-accent/40 bg-accent-bg' : focus === spec.index ? 'border-border-strong' : 'border-transparent')}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <svg width="16" height="6" aria-hidden="true" className="shrink-0">
                    <line x1="0" x2="16" y1="3" y2="3" className={lineClass({ ...spec })} strokeWidth={lineWidth(spec) + 0.5} strokeDasharray={spec.kind === 'perBreak' ? '4 3' : undefined} />
                  </svg>
                  <span className={clsx('truncate', best || spec.kind !== 'count' ? 'font-medium text-primary' : 'text-secondary')}>{lineLabel(spec)}</span>
                  {best && <span className="shrink-0 rounded-full bg-accent px-1.5 text-[9px] font-semibold text-white">{t('analytics.promptCache.legend.bestFixed')}</span>}
                </span>
                <span className={clsx('shrink-0 whitespace-nowrap tabular-nums', best || spec.kind !== 'count' ? 'font-medium text-primary' : 'text-muted')}>{money(value(spec.index, last), signed)}</span>
              </button>
            )
          })}
          <p className="mt-1 text-[10px] text-faint">{signed ? t('analytics.promptCache.legend.savingNote') : t('analytics.promptCache.legend.totalNote')}</p>
        </div>
      </div>

      <div className="space-y-1 border-t border-border/60 pt-2 text-[11px] text-secondary">
        <p>
          <span className="mr-1.5 font-semibold uppercase tracking-wide text-special">{t('analytics.promptCache.dynamic.label')}</span>
          {multi
            ? t('analytics.promptCache.dynamic.multi', {
              count: summary.best,
              fixed: money(summary.totals[0] - summary.totals[summary.best]),
              models: models.map((model) => `${modelName(model.model)}: ${summary.modelBest.get(model.model) ?? 0}`).join(', '),
              perModel: money(summary.totals[0] - summary.perModelTotal),
              perBreak: money(summary.totals[0] - summary.perBreakTotal),
            })
            : t('analytics.promptCache.dynamic.single', { count: summary.best, extra: money(summary.totals[summary.best] - summary.perBreakTotal) })}
        </p>
        {split && (
          <p>
            <span className="mr-1.5 font-semibold uppercase tracking-wide text-dim">{t('analytics.promptCache.weeks.label')}</span>
            {split.earlier.best === split.later.best
              ? t('analytics.promptCache.weeks.same', { count: split.earlier.best, earlier: money(split.earlier.saving), later: money(split.later.saving) })
              : t('analytics.promptCache.weeks.differ', { earlier: pingsLabel(split.earlier.best, t), earlierSaving: money(split.earlier.saving), later: pingsLabel(split.later.best, t), laterSaving: money(split.later.saving) })}
          </p>
        )}
      </div>

      {group.models.length > 1 && <ModelTable group={group} days={analysis.days} groupSummary={summarize(group.models, group.maxPings, analysis.days)} picked={picked} onPick={(model) => setPicked([model])} weeks={weeks} />}
      <BreakLengths group={group} models={models} />
    </div>
  )
}

function Chip({ on, onClick, title, children }: { on: boolean; onClick: () => void; title?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={clsx('rounded-full border px-2.5 py-0.5 text-[11px]', on ? 'border-accent bg-accent-bg font-medium text-accent-fg' : 'border-border text-secondary hover:bg-surface-hover')}
    >
      {children}
    </button>
  )
}

function ModelTable({ group, days, groupSummary, picked, onPick, weeks }: { group: CacheGroupAnalysis; days: number; groupSummary: PingSummary; picked: string[] | null; onPick: (model: string) => void; weeks: number }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="border-t border-border/60 pt-2">
      <div className="text-xs font-semibold text-primary">{t('analytics.promptCache.models.title')}</div>
      <p className="mt-0.5 text-[11px] text-dim">{t('analytics.promptCache.models.note')}</p>
      <div className="mt-1.5 overflow-x-auto">
        <table className="w-full min-w-[460px] text-xs">
          <thead>
            <tr className="text-[10px] text-faint">
              <th className="pb-1 text-left font-medium">{t('analytics.promptCache.models.model')}</th>
              <th className="pb-1 text-right font-medium">{t('analytics.promptCache.models.breaks', { minutes: group.lifetimeMinutes })}</th>
              <th className="pb-1 pl-3 text-left font-medium">{t('analytics.promptCache.best')}</th>
              <th className="pb-1 text-right font-medium">{t('analytics.promptCache.savesPerWeek')}</th>
              <th className="pb-1 pl-3 text-left font-medium">{t('analytics.promptCache.models.data')}</th>
            </tr>
          </thead>
          <tbody>
            {group.models.map((model) => <ModelRow key={model.model} model={model} group={group} days={days} groupBest={groupSummary.confidence === 'none' ? null : groupSummary.best} selected={picked !== null && picked.includes(model.model)} onPick={onPick} weeks={weeks} />)}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ModelRow({ model, group, days, groupBest, selected, onPick, weeks }: { model: CacheModelAnalysis; group: CacheGroupAnalysis; days: number; groupBest: number | null; selected: boolean; onPick: (model: string) => void; weeks: number }): React.JSX.Element {
  const { t } = useTranslation()
  const summary = summarize([model], group.maxPings, days)
  const thin = summary.confidence === 'none'
  return (
    <tr className={clsx('border-t border-border/60', selected && 'bg-accent-bg')}>
      <td className="py-1 pr-2">
        <button type="button" onClick={() => onPick(model.model)} title={model.model} className="truncate font-mono text-accent-fg underline-offset-2 hover:underline">
          {modelName(model.model)}
        </button>
        {model.route === 'copilot' && <span className="ml-1.5 rounded bg-card px-1 text-[10px] text-dim">{t('analytics.cache.viaCopilot')}</span>}
      </td>
      <td className="py-1 text-right tabular-nums text-muted">{model.longBreaks}</td>
      <td className="py-1 pl-3 text-secondary">{!thin ? pingsLabel(summary.best, t) : groupBest === null ? '\u2013' : t('analytics.promptCache.models.useGroup', { pings: pingsLabel(groupBest, t) })}</td>
      <td className="py-1 text-right tabular-nums text-muted">{thin ? '–' : money((summary.totals[0] - summary.totals[summary.best]) / weeks)}</td>
      <td className="py-1 pl-3"><span className={clsx('rounded-full px-2 py-0.5 text-[10px] font-medium', CONFIDENCE_CLASSES[summary.confidence])}>{t(CONFIDENCE_KEYS[summary.confidence])}</span></td>
    </tr>
  )
}

/** Breaks by length, against what the cache outlives on its own and what pings can reach. */
function BreakLengths({ group, models }: { group: CacheGroupAnalysis; models: CacheModelAnalysis[] }): React.JSX.Element | null {
  const { t } = useTranslation()
  const lifetime = group.lifetimeMinutes ?? 0
  const reach = Math.round(group.reachMinutes ?? 0)
  const lengths = models.flatMap((model) => model.gaps.map((gap) => gap.gapMs / MINUTE))
  const short = models.reduce((sum, model) => sum + model.shortBreaks, 0)
  const mid = Math.round((lifetime + reach) / 2)
  const rows = [
    { label: t('analytics.promptCache.breaks.under', { minutes: lifetime }), count: short, note: t('analytics.promptCache.breaks.warm'), tone: 'bg-border-strong' },
    ...(group.maxPings > 1
      ? [
        { label: `${lifetime}–${mid} min`, count: lengths.filter((m) => m > lifetime && m <= mid).length, note: t('analytics.promptCache.breaks.fewPings'), tone: 'bg-accent/60' },
        { label: `${mid}–${reach} min`, count: lengths.filter((m) => m > mid && m <= reach).length, note: t('analytics.promptCache.breaks.morePings'), tone: 'bg-accent' },
      ]
      : [{ label: `${lifetime}–${reach} min`, count: lengths.filter((m) => m > lifetime && m <= reach).length, note: t('analytics.promptCache.breaks.onePing'), tone: 'bg-accent' }]),
    { label: t('analytics.promptCache.breaks.over', { minutes: reach }), count: lengths.filter((m) => m > reach).length, note: t('analytics.promptCache.breaks.tooLong'), tone: 'bg-warning' },
  ]
  const max = Math.max(1, ...rows.map((row) => row.count))
  if (rows.every((row) => row.count === 0)) return null
  return (
    <div className="border-t border-border/60 pt-2">
      <div className="text-xs font-semibold text-primary">{t('analytics.promptCache.breaks.title')}</div>
      <p className="mt-0.5 text-[11px] text-dim">{t('analytics.promptCache.breaks.note')}</p>
      <div className="mt-1.5 space-y-1">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[90px_minmax(0,1fr)_minmax(0,220px)] items-center gap-2 text-[11px]">
            <span className="text-secondary tabular-nums">{row.label}</span>
            <div className="h-3 overflow-hidden rounded-sm bg-card"><div className={clsx('h-3 rounded-sm', row.tone)} style={{ width: `${(row.count / max) * 100}%` }} /></div>
            <span className="truncate text-dim"><span className="font-medium text-primary tabular-nums">{row.count}</span> · {row.note}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
