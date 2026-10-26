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

/** A whole number of pings for every model (capped at what Pi sends for it), or each model's own best count. */
type PingChoice = number | 'optimal'

interface ModelEntry {
  model: CacheModelAnalysis
  group: CacheGroupAnalysis
  /** The count the chosen setting gives this model. */
  count: number
  /** Cost per 30-minute slot over the whole window, with that count and with none. */
  cost: number[]
  none: number[]
}

/** Per-day totals of a slot series. */
function byDay(values: number[], days: number): number[] {
  return Array.from({ length: days }, (_, day) => sum(values.slice(day * SLOTS_PER_DAY, (day + 1) * SLOTS_PER_DAY)))
}

/** Prompt cost per model, day by day, with the ping count you pick; read only. */
export function PromptCacheAnalysis({ analysis }: { analysis: CacheAnalysis }): React.JSX.Element | null {
  const { t, i18n } = useTranslation()
  const [choice, setChoice] = useState<PingChoice>('optimal')
  const [selectedDay, setSelectedDay] = useState<number | null>(null)
  const days = useMemo(() => dayStarts(analysis.from, analysis.to), [analysis.from, analysis.to])
  const optimal = useMemo(() => optimalCounts(analysis), [analysis])
  const maxPings = Math.max(0, ...analysis.groups.map((group) => group.maxPings))
  const slots = days.length * SLOTS_PER_DAY

  const entries = useMemo(() => analysis.groups
    .flatMap((group) => group.models.map((model) => ({ model, group })))
    .sort((a, b) => b.model.calls - a.model.calls)
    .map(({ model, group }): ModelEntry => {
      const count = group.id === 'automatic' ? 0 : choice === 'optimal' ? optimal.get(model.model) ?? 0 : Math.min(choice, group.maxPings)
      return { model, group, count, ...slotCosts(model, count, analysis.from, slots) }
    }), [analysis, choice, optimal, slots])

  if (entries.length === 0) return null
  const weeks = Math.max(analysis.days, 1) / 7
  const allCost = byDay(entries.reduce((total, entry) => total.map((value, slot) => value + entry.cost[slot]), new Array<number>(slots).fill(0)), days.length)
  const allNone = byDay(entries.reduce((total, entry) => total.map((value, slot) => value + entry.none[slot]), new Array<number>(slots).fill(0)), days.length)
  const totalCost = sum(allCost)
  const totalSaving = sum(allNone) - totalCost
  const choiceLabel = choice === 'optimal' ? t('analytics.promptCache.choice.optimal') : pingsLabel(choice, t)
  const dayLabel = (index: number): string => new Date(days[index]).toLocaleDateString(i18n.language, { weekday: 'short', month: 'short', day: 'numeric' })
  const pickDay = (index: number): void => setSelectedDay(selectedDay === index ? null : index)
  const capped = typeof choice === 'number' && analysis.groups.some((group) => group.id !== 'automatic' && group.maxPings < choice)

  return (
    <section className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-dim">{t('analytics.promptCache.title')}</h3>
        <span className="text-[10px] text-faint">{t('analytics.promptCache.note', { count: analysis.days })}</span>
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-surface px-3 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] text-dim">{t('analytics.promptCache.choice.label')}</span>
          <div role="group" aria-label={t('analytics.promptCache.choice.label')} className="flex flex-wrap overflow-hidden rounded border border-border">
            {[...Array.from({ length: maxPings + 1 }, (_, count): PingChoice => count), 'optimal' as const].map((entry) => (
              <button
                key={entry}
                type="button"
                aria-pressed={choice === entry}
                onClick={() => setChoice(entry)}
                className={clsx('px-2.5 py-1 text-[11px] tabular-nums', choice === entry ? 'bg-accent-bg font-medium text-accent-fg' : 'text-muted hover:bg-surface-hover')}
              >
                {entry === 'optimal' ? t('analytics.promptCache.choice.optimal') : entry === 0 ? t('analytics.promptCache.noPings') : entry}
              </button>
            ))}
          </div>
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
        <Legend />

        {entries.length > 1 && (
          <ChartRow
            title={t('analytics.promptCache.allModels')}
            detail={t('analytics.promptCache.modelCount', { count: entries.length })}
            cost={allCost}
            none={allNone}
            dayLabel={dayLabel}
            selectedDay={selectedDay}
            onPickDay={pickDay}
            showDays
          />
        )}
        {entries.map((entry) => (
          <ModelRow key={entry.model.model} entry={entry} analysis={analysis} days={days.length} weeks={weeks} dayLabel={dayLabel} selectedDay={selectedDay} onPickDay={pickDay} showDays={entries.length === 1} />
        ))}
        {days.length > 0 && (
          <div className="flex justify-between pl-16 text-[10px] text-faint">
            <span>{dayLabel(0)}</span>
            <span>{selectedDay === null ? t('analytics.promptCache.clickDay') : ''}</span>
            <span>{dayLabel(days.length - 1)}</span>
          </div>
        )}
      </div>

      {selectedDay !== null && (
        <DayView
          entries={entries}
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

function Legend(): React.JSX.Element {
  const { t } = useTranslation()
  const items = [
    { tone: 'bg-accent', label: t('analytics.promptCache.legend.cost') },
    { tone: 'bg-success/50', label: t('analytics.promptCache.legend.saved') },
    { tone: 'bg-error/70', label: t('analytics.promptCache.legend.wasted') },
  ]
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-secondary">
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5">
          <span className={clsx('h-2.5 w-2.5 rounded-sm', item.tone)} />
          {item.label}
        </span>
      ))}
    </div>
  )
}

function ModelRow({ entry, analysis, days, weeks, dayLabel, selectedDay, onPickDay, showDays }: {
  entry: ModelEntry
  analysis: CacheAnalysis
  days: number
  weeks: number
  dayLabel: (index: number) => string
  selectedDay: number | null
  onPickDay: (index: number) => void
  showDays: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const { model, group } = entry
  const automatic = group.id === 'automatic'
  const own = summarize([model], group.maxPings, analysis.days)
  const hitRate = own.hitRate === null ? '–' : `${Math.round(own.hitRate * 100)}%`
  const saving = (sum(entry.none) - sum(entry.cost)) / weeks
  const facts = automatic
    ? [t('analytics.promptCache.facts.hitRate', { rate: hitRate }), t('analytics.promptCache.facts.automatic')]
    : [
      t('analytics.promptCache.facts.hitRate', { rate: hitRate }),
      own.confidence === 'none'
        ? t('analytics.promptCache.facts.thin', { count: model.longBreaks })
        : t('analytics.promptCache.facts.best', { pings: pingsLabel(own.best, t) }),
      entry.count === 0 ? null : saving >= 0.005 ? t('analytics.promptCache.facts.saves', { pings: pingsLabel(entry.count, t), cost: money(saving) }) : t('analytics.promptCache.facts.costs', { pings: pingsLabel(entry.count, t), cost: money(-saving) }),
      own.noCacheTotal > 0
        ? own.cacheSavingPerWeek >= 0 ? t('analytics.promptCache.facts.vsNoCache', { cost: money(own.cacheSavingPerWeek) }) : t('analytics.promptCache.facts.noCacheCheaper', { cost: money(-own.cacheSavingPerWeek) })
        : null,
    ].filter((fact): fact is string => fact !== null)
  return (
    <ChartRow
      title={modelName(model.model)}
      fullName={model.model}
      badge={t(LIFETIME_KEYS[group.id])}
      confidence={automatic ? null : own.confidence}
      facts={facts}
      cost={byDay(entry.cost, days)}
      none={byDay(entry.none, days)}
      dayLabel={dayLabel}
      selectedDay={selectedDay}
      onPickDay={onPickDay}
      showDays={showDays}
    />
  )
}

/** A model's (or all models') heading and a bar per day: the cost with the chosen pings, topped by what they saved or wasted. */
function ChartRow({ title, fullName, badge, confidence, detail, facts, cost, none, dayLabel, selectedDay, onPickDay, showDays = false }: {
  title: string
  fullName?: string
  badge?: string
  confidence?: CacheConfidence | null
  detail?: string
  facts?: string[]
  cost: number[]
  none: number[]
  dayLabel: (index: number) => string
  selectedDay: number | null
  onPickDay: (index: number) => void
  showDays?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="space-y-1 border-t border-border/60 pt-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-mono text-xs font-semibold text-primary" title={fullName}>{title}</span>
        {badge && <span className="rounded bg-card px-1.5 text-[10px] text-dim">{badge}</span>}
        {confidence && <span className={clsx('rounded-full px-2 py-0.5 text-[10px] font-medium', CONFIDENCE_CLASSES[confidence])}>{t(CONFIDENCE_KEYS[confidence])}</span>}
        {detail && <span className="text-[11px] text-dim">{detail}</span>}
      </div>
      {facts && facts.length > 0 && <p className="text-[11px] text-dim">{facts.join(' · ')}</p>}
      <Bars cost={cost} none={none} height="h-16" selected={selectedDay} label={dayLabel} onPick={onPickDay} tickLabels={showDays} />
    </div>
  )
}

/** Bars sharing one scale, with the top value on the left; `selected` is outlined. */
function Bars({ cost, none, height, selected, label, onPick, tickLabels = false, below }: {
  cost: number[]
  none: number[]
  height: string
  selected?: number | null
  label: (index: number) => string
  onPick?: (index: number) => void
  tickLabels?: boolean
  below?: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const top = Math.max(1e-9, ...cost.map((value, index) => Math.max(value, none[index])))
  return (
    <div className="flex items-stretch gap-2">
      <div className="flex w-14 shrink-0 flex-col justify-between text-right text-[10px] text-faint tabular-nums">
        <span>{money(top)}</span>
        <span>{money(0)}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className={clsx('flex items-end gap-px', height)}>
          {cost.map((value, index) => {
            const without = none[index]
            const low = Math.min(value, without)
            const saved = without - value
            const title = value === 0 && without === 0
              ? t('analytics.promptCache.bar.idle', { label: label(index) })
              : saved >= 0.005
                ? t('analytics.promptCache.bar.saved', { label: label(index), cost: money(value), none: money(without), saving: money(saved) })
                : saved <= -0.005
                  ? t('analytics.promptCache.bar.wasted', { label: label(index), cost: money(value), none: money(without), extra: money(-saved) })
                  : t('analytics.promptCache.bar.same', { label: label(index), cost: money(value) })
            const body = (
              <>
                {saved > 0 && <div className="w-full rounded-t-sm bg-success/50" style={{ height: `${(saved / top) * 100}%` }} />}
                {saved < 0 && <div className="w-full rounded-t-sm bg-error/70" style={{ height: `${(-saved / top) * 100}%` }} />}
                <div className={clsx('w-full bg-accent', saved === 0 && 'rounded-t-sm')} style={{ height: `${(low / top) * 100}%` }} />
              </>
            )
            return onPick ? (
              <button
                key={index}
                type="button"
                title={title}
                aria-label={title}
                aria-pressed={selected === index}
                onClick={() => onPick(index)}
                className={clsx('flex h-full min-w-0 flex-1 flex-col justify-end rounded-sm hover:bg-surface-hover', selected === index && 'bg-accent-bg ring-1 ring-accent')}
              >
                {body}
              </button>
            ) : (
              <div key={index} title={title} className="flex h-full min-w-0 flex-1 flex-col justify-end">{body}</div>
            )
          })}
        </div>
        {tickLabels && cost.length <= 31 && (
          <div className="mt-0.5 hidden gap-px sm:flex">
            {cost.map((_, index) => (
              <span key={index} className="min-w-0 flex-1 truncate text-center text-[9px] text-faint">{label(index).replace(/^\D+/, '')}</span>
            ))}
          </div>
        )}
        {below}
      </div>
    </div>
  )
}

/** One day in 30-minute blocks for every model that ran, with the cheapest count for each block that had a break. */
function DayView({ entries, dayStart, firstSlot, title, onPrevious, onNext, onClose }: {
  entries: ModelEntry[]
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
  const active = entries.filter((entry) => sum(entry.none.slice(firstSlot, firstSlot + SLOTS_PER_DAY)) > 0)
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
      {active.length === 0 && <p className="py-4 text-center text-xs text-dim">{t('analytics.promptCache.day.empty')}</p>}
      {active.map((entry) => {
        const cost = entry.cost.slice(firstSlot, firstSlot + SLOTS_PER_DAY)
        const none = entry.none.slice(firstSlot, firstSlot + SLOTS_PER_DAY)
        const cells = entry.group.id === 'automatic' ? [] : slotBest([entry.model], entry.group.maxPings, dayStart)
        return (
          <div key={entry.model.model} className="space-y-1 border-t border-border/60 pt-2">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-xs font-semibold text-primary" title={entry.model.model}>{modelName(entry.model.model)}</span>
              <span className="text-[11px] text-dim">
                {t('analytics.promptCache.day.total', { cost: money(sum(cost)), none: money(sum(none)), pings: pingsLabel(entry.count, t) })}
              </span>
            </div>
            <Bars
              cost={cost}
              none={none}
              height="h-14"
              label={blockLabel}
              below={(
                <>
                  {cells.length > 0 && (
                    <div className="mt-1 flex items-center gap-px" aria-label={t('analytics.promptCache.day.bestRow')}>
                      {cells.map((cell, slot) => (
                        <span
                          key={slot}
                          title={cell
                            ? t('analytics.promptCache.day.cell', { count: cell.gaps.length, block: blockLabel(slot), lengths: cell.gaps.map((gap) => Math.round(gap.gapMs / MINUTE)).join(', '), best: pingsLabel(cell.best, t) })
                            : undefined}
                          className={clsx('min-w-0 flex-1 rounded-sm text-center text-[9px] font-semibold leading-4 tabular-nums', cell ? 'bg-accent-bg text-accent-fg' : 'text-transparent')}
                        >
                          {cell ? cell.best : '·'}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="mt-0.5 flex justify-between text-[9px] text-faint tabular-nums">
                    {[0, 12, 24, 36, 48].map((slot) => <span key={slot}>{slot === 48 ? '24:00' : clock(dayStart + slot * SLOT_MS)}</span>)}
                  </div>
                </>
              )}
            />
          </div>
        )
      })}
      {active.some((entry) => entry.group.id !== 'automatic') && <p className="text-[10px] text-faint">{t('analytics.promptCache.day.bestNote')}</p>}
    </div>
  )
}
