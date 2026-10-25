import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronUp, LineChart, Timer } from 'lucide-react'
import { clsx } from 'clsx'
import { useAppStore } from '../store'
import {
  CACHE_MODES,
  DEFAULT_CACHE_MODE,
  autoWarmLimit,
  type AutoWarmSchedule,
  type CacheMode,
} from '../../../../resources/context-snapshot'
import type { Translate } from '../../../shared/i18n'
import { CacheCheckDialog } from './cache-check-dialog'

export function cacheModeLabel(mode: CacheMode, t: Translate): string {
  switch (mode) {
    case 'auto': return t('chat.cacheMode.modes.auto.label')
    case 'focus': return t('chat.cacheMode.modes.focus.label')
    case 'keep-warm': return t('chat.cacheMode.modes.keepWarm.label')
    case 'long': return t('chat.cacheMode.modes.long.label')
  }
}

function cacheModeDetail(mode: CacheMode, t: Translate): string {
  switch (mode) {
    case 'auto': return t('chat.cacheMode.modes.auto.detail')
    case 'focus': return t('chat.cacheMode.modes.focus.detail')
    case 'keep-warm': return t('chat.cacheMode.modes.keepWarm.detail')
    case 'long': return t('chat.cacheMode.modes.long.detail')
  }
}

/** Minutes a 5-minute cache stays warm past the last turn with this many refreshes 4 minutes apart. */
function warmMinutes(pings: number): number {
  return 5 + pings * 4
}

/** Auto's plan for the chat's model: idle pings per hour, with the current hour marked. */
function AutoWarmPlan({ schedule, model }: { schedule: AutoWarmSchedule | null; model: string | null }): React.JSX.Element {
  const { t } = useTranslation()
  const plan = (model ? schedule?.models[model] : undefined) ?? schedule?.fallback ?? null
  const now = Date.now()
  const hour = new Date(now).getHours()
  const pings = autoWarmLimit(schedule, model, now)
  const top = plan ? Math.max(1, ...plan) : 1
  return (
    <div className="mx-2 mb-1 mt-1 rounded-lg bg-card px-2.5 py-2 text-[11px] text-secondary">
      <p className="tabular-nums">{t('chat.cacheMode.autoNow', { count: pings, minutes: warmMinutes(pings) })}</p>
      {plan ? (
        <div className="mt-1.5 flex h-6 items-end gap-px" role="img" aria-label={t('chat.cacheMode.autoHours')}>
          {plan.map((count, index) => (
            <div
              key={index}
              className={clsx('min-h-px flex-1 rounded-sm', index === hour ? 'bg-accent-fg' : 'bg-border-strong')}
              style={{ height: `${Math.max(4, (count / top) * 100)}%` }}
              title={t('chat.cacheMode.autoHour', { hour: String(index).padStart(2, '0'), count })}
            />
          ))}
        </div>
      ) : (
        <p className="mt-1 text-dim">{t('chat.cacheMode.autoNoData')}</p>
      )}
      <p className="mt-1.5 text-dim">{t('chat.cacheMode.autoOverride')}</p>
    </div>
  )
}

interface CacheModeSelectorProps {
  className?: string
}

/**
 * The session's prompt cache mode, beside the effort picker. A pick applies
 * from the session's next request and becomes the mode new chats start in.
 */
export function CacheModeSelector({ className }: CacheModeSelectorProps): React.JSX.Element {
  const { t } = useTranslation()
  const sessionId = useAppStore((state) => state.sessionState?.sessionId ?? null)
  const defaultMode = useAppStore((state) => state.settings?.cacheMode ?? DEFAULT_CACHE_MODE)
  const piStatus = useAppStore((state) => state.piStatus)
  const [picked, setPicked] = useState<{ sessionId: string; mode: CacheMode } | null>(null)
  const [warming, setWarming] = useState<{ value: string | null; enabledNow: boolean } | null>(null)
  const [auto, setAuto] = useState<{ schedule: AutoWarmSchedule | null; model: string | null } | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [checking, setChecking] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  // A session keeps the mode picked for it, or the one it started in.
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    void (async () => {
      const choice = await window.piDesktop.context.getCacheMode(sessionId).catch(() => null)
      const started = choice ? null : await window.piDesktop.context.getSnapshot(sessionId).catch(() => null)
      const mode = choice?.mode ?? started?.cacheMode
      if (!cancelled && mode) setPicked({ sessionId, mode })
    })()
    return () => { cancelled = true }
  }, [sessionId])

  useEffect(() => {
    if (!isOpen) return
    void window.piDesktop.context.getCacheWarming()
      .then((value) => setWarming((previous) => ({ value, enabledNow: previous?.enabledNow ?? false })))
      .catch(() => undefined)
    if (sessionId) {
      void Promise.all([
        window.piDesktop.context.getAutoWarmSchedule().catch(() => null),
        window.piDesktop.context.getSnapshot(sessionId).catch(() => null),
      ]).then(([schedule, snapshot]) => setAuto({
        schedule,
        model: snapshot?.model ? `${snapshot.model.provider}/${snapshot.model.id}` : null,
      }))
    }
    const handleClick = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setIsOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen, sessionId])

  if (piStatus !== 'running' || !sessionId) return <></>

  const current = picked?.sessionId === sessionId ? picked.mode : defaultMode
  const choose = async (mode: CacheMode): Promise<void> => {
    try {
      await window.piDesktop.context.setCacheMode(sessionId, mode)
      setPicked({ sessionId, mode })
      const updated = await window.piDesktop.settings.save({ cacheMode: mode })
      useAppStore.setState({ settings: updated })
    } catch {
      // The picker keeps showing the mode that is still in effect.
    }
  }
  const enableIdleWarming = async (): Promise<void> => {
    try {
      await window.piDesktop.context.enableIdleCacheWarming()
      setWarming({ value: 'idle', enabledNow: true })
    } catch {
      // Pi's settings file could not be read or written; the note stays.
    }
  }
  const label = cacheModeLabel(current, t)
  const warms = current === 'auto' || current === 'keep-warm'

  return (
    <div ref={ref} className={clsx('relative', className)}>
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        className={clsx(
          'flex h-7 items-center justify-center gap-1 rounded-l-none rounded-r-[7px] px-2 text-[11px] transition-colors active:scale-[0.98] @max-sm/composer:w-7 @max-sm/composer:gap-0 @max-sm/composer:px-0',
          isOpen ? 'bg-surface-hover text-primary' : 'text-dim hover:bg-surface-hover hover:text-secondary',
        )}
        title={t('chat.cacheMode.withMode', { mode: label })}
        aria-label={t('chat.cacheMode.withMode', { mode: label })}
        aria-expanded={isOpen}
      >
        <Timer size={12} className="shrink-0 text-accent-fg" />
        <span className="whitespace-nowrap @max-md/composer:hidden">{label}</span>
        <ChevronUp
          size={10}
          className={clsx('shrink-0 transition-transform @max-lg/composer:hidden', isOpen && 'rotate-180')}
        />
      </button>

      {isOpen && (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-72 overflow-hidden rounded-xl border border-border-strong bg-surface py-1 shadow-xl shadow-black/30 animate-fade-in">
          <div className="border-b border-border px-3 py-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-faint">{t('chat.cacheMode.title')}</div>
          </div>
          {CACHE_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => {
                void choose(mode)
                if (mode === 'focus' || mode === 'long' || (mode === 'keep-warm' && warming?.value === 'idle')) setIsOpen(false)
              }}
              className={clsx(
                'flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-surface-hover',
                current === mode ? 'text-primary' : 'text-muted',
              )}
            >
              {current === mode ? <Check size={11} className="mt-0.5 shrink-0 text-success" /> : <span className="w-[11px] shrink-0" />}
              <span className="min-w-0">
                <span className="block">{cacheModeLabel(mode, t)}</span>
                <span className="block text-[11px] text-dim">{cacheModeDetail(mode, t)}</span>
              </span>
            </button>
          ))}
          {current === 'auto' && auto && <AutoWarmPlan schedule={auto.schedule} model={auto.model} />}
          {warms && warming && warming.value !== 'idle' && (
            <div className="mx-2 mb-1 mt-1 rounded-lg bg-warning-bg px-2.5 py-2 text-[11px] text-secondary">
              <p>{t('chat.cacheMode.idleWarmingOff')}</p>
              <button
                type="button"
                onClick={() => void enableIdleWarming()}
                className="mt-1.5 rounded-md border border-border-strong bg-card px-2 py-1 text-[11px] text-primary hover:bg-surface-hover"
              >
                {t('chat.cacheMode.enableIdleWarming')}
              </button>
            </div>
          )}
          {warms && warming?.enabledNow && (
            <p className="mx-3 mb-1 mt-1 text-[11px] text-faint">{t('chat.cacheMode.idleWarmingEnabled')}</p>
          )}
          <p className="border-t border-border px-3 py-1.5 text-[11px] text-dim">{t('chat.cacheMode.appliesNext')}</p>
          {auto?.model && (
            <button
              type="button"
              onClick={() => {
                setChecking(auto.model)
                setIsOpen(false)
              }}
              className="flex w-full items-center gap-2 border-t border-border px-3 py-1.5 text-left text-xs text-secondary hover:bg-surface-hover hover:text-primary"
            >
              <LineChart size={12} className="shrink-0 text-accent-fg" />
              {t('chat.cacheMode.checkRecommendation')}
            </button>
          )}
        </div>
      )}
      {checking && <CacheCheckDialog model={checking} onClose={() => setChecking(null)} />}
    </div>
  )
}
