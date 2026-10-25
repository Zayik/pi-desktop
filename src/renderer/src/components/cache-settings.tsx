import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LineChart, Minus, Plus, RotateCcw, Undo2 } from 'lucide-react'
import { clsx } from 'clsx'
import { MAX_IDLE_WARMS } from '../../../../resources/context-snapshot'
import type { AnalyticsReport, CachePlanState, SetModelCacheRequest } from '../../../shared/analytics-report'
import type { ModelCachePlan } from '../../../../packages/pi-analytics/src/cache-plan'
import {
  checkModel,
  idleWarmMinutes,
  modelLifetimesMs,
  piMaxIdlePings,
  reportDays,
  type CacheCheck,
  type CacheOption,
} from '../../../../packages/pi-analytics/src/recommendations'
import type { Translate } from '../../../shared/i18n'
import { checkText } from './cache-check-dialog'
import { formatUsd } from './analytics-report-view'

/** Recommendations look at the same 30 days as Check recommendation. */
const RECOMMEND_RANGE = '30'
type Choice = SetModelCacheRequest['mode']

function choiceOf(entry: ModelCachePlan | undefined): Choice | 'auto' {
  return entry?.mode ?? 'default'
}

function formatLifetime(ms: number): string {
  return ms >= 3_600_000 ? `${ms / 3_600_000}h` : `${Math.round(ms / 60_000)}m`
}

function settingText(setting: CacheOption['setting'], t: Translate): string {
  switch (setting.mode) {
    case 'keep-warm': return t('settings.cache.keepWarmPings', { count: setting.idlePings ?? MAX_IDLE_WARMS })
    case 'focus': return t('chat.cacheMode.modes.focus.label')
    case 'long': return t('chat.cacheMode.modes.long.label')
    case 'auto': return t('chat.cacheMode.modes.auto.label')
  }
}

/**
 * Cache control for every model in one place: the pi-analytics plan as a
 * table (Pi's own setting, Focus, Keep warm with its ping count, or Long per
 * model), what the last 30 days suggest beside each row, a switch that turns
 * cache control off without losing the plan, and reset to defaults.
 */
export function CacheSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [state, setState] = useState<CachePlanState | null>(null)
  const [report, setReport] = useState<AnalyticsReport | null>(null)
  const [loadingReport, setLoadingReport] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => {
    void window.piDesktop.analytics.getCachePlan().then(setState).catch((failure: unknown) => setError(String(failure)))
  }, [])

  const change = async (run: () => Promise<CachePlanState>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setState(await run())
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }
  const recommend = async (): Promise<void> => {
    setLoadingReport(true)
    setError(null)
    try {
      setReport(await window.piDesktop.analytics.getOverview({ range: RECOMMEND_RANGE, projectPath: null }))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setLoadingReport(false)
    }
  }
  const enableIdleWarming = async (): Promise<void> => {
    try {
      await window.piDesktop.context.enableIdleCacheWarming()
      setState(await window.piDesktop.analytics.getCachePlan())
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  const plan = state?.plan ?? null
  const on = plan ? !plan.off : true
  const checks = useMemo(() => {
    const found = new Map<string, CacheCheck>()
    if (!report) return found
    const days = reportDays(report)
    for (const model of report.cache.models) found.set(model.model, checkModel(model, days))
    return found
  }, [report])
  // Every model in the plan, then every model the report saw.
  const models = useMemo(() => {
    const names = new Set(Object.keys(plan?.models ?? {}))
    for (const model of report?.cache.models ?? []) names.add(model.model)
    return [...names]
  }, [plan, report])
  const keepsWarm = Object.values(plan?.models ?? {}).some((entry) => entry.mode === 'keep-warm' && (entry.idlePings ?? MAX_IDLE_WARMS) > 0)

  const set = (model: string, mode: Choice, pings?: number): Promise<void> =>
    change(() => window.piDesktop.analytics.setModelCache({ model, mode, pings, allowIdleWarming: false }))
  const apply = (model: string, long: boolean): Promise<void> =>
    change(() => window.piDesktop.analytics.applyCacheRecommendation({ range: RECOMMEND_RANGE, projectPath: null, model, long, allowIdleWarming: false }))

  const button = 'inline-flex items-center gap-1 rounded-md border border-border-strong bg-card px-2 py-1 text-[11px] text-secondary hover:bg-surface-hover hover:text-primary disabled:opacity-50'

  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-primary">{t('settings.cache.control')}</p>
          <p className="text-[11px] text-dim">{on ? t('settings.cache.controlOn') : t('settings.cache.controlOff')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex overflow-hidden rounded-md border border-border-strong" role="group" aria-label={t('settings.cache.control')}>
            {([true, false] as const).map((value) => (
              <button
                key={String(value)}
                type="button"
                disabled={busy || !state}
                aria-pressed={on === value}
                onClick={() => { if (on !== value) void change(() => window.piDesktop.analytics.setCacheControl(value)) }}
                className={clsx('px-2.5 py-1 text-[11px]', on === value ? 'bg-accent text-white' : 'bg-card text-muted hover:bg-surface-hover')}
              >
                {value ? t('settings.cache.on') : t('settings.cache.off')}
              </button>
            ))}
          </div>
          <button type="button" className={button} disabled={busy || !plan || plan.history.length === 0} onClick={() => void change(() => window.piDesktop.analytics.undoCachePlan())}>
            <Undo2 size={11} /> {t('settings.cache.undo')}
          </button>
          {confirmReset ? (
            <span className="inline-flex items-center gap-1">
              <button type="button" className={clsx(button, 'border-error text-error')} disabled={busy} onClick={() => { setConfirmReset(false); void change(() => window.piDesktop.analytics.resetCachePlan()) }}>
                {t('settings.cache.resetConfirm')}
              </button>
              <button type="button" className={button} onClick={() => setConfirmReset(false)}>{t('settings.cache.cancel')}</button>
            </span>
          ) : (
            <button type="button" className={button} disabled={busy || !state} onClick={() => setConfirmReset(true)}>
              <RotateCcw size={11} /> {t('settings.cache.reset')}
            </button>
          )}
        </div>
      </div>
      {confirmReset && <p className="text-[11px] text-dim">{t('settings.cache.resetDetail')}</p>}

      {on && keepsWarm && state?.cacheWarming !== 'idle' && (
        <div className="rounded-lg bg-warning-bg px-2.5 py-2 text-[11px] text-secondary">
          <p>{t('chat.cacheMode.idleWarmingOff')}</p>
          <button type="button" className={clsx(button, 'mt-1.5')} onClick={() => void enableIdleWarming()}>
            {t('chat.cacheMode.enableIdleWarming')}
          </button>
        </div>
      )}
      {error && <p className="text-[11px] text-error">{error}</p>}

      <div className={clsx('overflow-x-auto rounded-lg border border-border', !on && 'opacity-60')}>
        <table className="w-full min-w-[560px] text-left text-[11px]">
          <thead className="bg-card text-faint">
            <tr>
              <th className="px-2.5 py-1.5 font-medium">{t('settings.cache.model')}</th>
              <th className="px-2.5 py-1.5 font-medium">{t('settings.cache.lifetime')}</th>
              <th className="px-2.5 py-1.5 font-medium">{t('settings.cache.setting')}</th>
              <th className="px-2.5 py-1.5 font-medium">{t('settings.cache.proposed')}</th>
            </tr>
          </thead>
          <tbody>
            {models.length === 0 && (
              <tr><td colSpan={4} className="px-2.5 py-3 text-center text-dim">{t('settings.cache.empty')}</td></tr>
            )}
            {models.map((model) => {
              const entry = plan?.models[model]
              const lifetimes = modelLifetimesMs(model)
              const cap = lifetimes ? piMaxIdlePings(lifetimes.short) : 0
              const choice = choiceOf(entry)
              const pings = Math.min(cap, entry?.mode === 'keep-warm' ? entry.idlePings ?? MAX_IDLE_WARMS : MAX_IDLE_WARMS)
              const check = checks.get(model)
              const rec = check?.recommendation ?? null
              const alt = check?.alternative ?? null
              return (
                <tr key={model} className="border-t border-border align-top">
                  <td className="max-w-[180px] truncate px-2.5 py-1.5 font-mono text-secondary" title={model}>{model}</td>
                  <td className="px-2.5 py-1.5 tabular-nums text-muted">
                    {lifetimes ? `${formatLifetime(lifetimes.short)}${lifetimes.long > lifetimes.short ? ` / ${formatLifetime(lifetimes.long)}` : ''}` : '—'}
                  </td>
                  <td className="px-2.5 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <select
                        value={choice}
                        disabled={busy || !lifetimes}
                        onChange={(event) => void set(model, event.target.value as Choice, event.target.value === 'keep-warm' ? pings : undefined)}
                        className="rounded border border-border-strong bg-card px-1.5 py-0.5 text-[11px] text-primary"
                        aria-label={t('settings.cache.settingFor', { model })}
                      >
                        <option value="default">{t('settings.cache.piDefault')}</option>
                        <option value="focus">{t('chat.cacheMode.modes.focus.label')}</option>
                        <option value="keep-warm">{t('chat.cacheMode.modes.keepWarm.label')}</option>
                        {lifetimes && lifetimes.long > lifetimes.short && <option value="long">{t('chat.cacheMode.modes.long.label')}</option>}
                        {choice === 'auto' && <option value="auto" disabled>{t('chat.cacheMode.modes.auto.label')}</option>}
                      </select>
                      {choice === 'keep-warm' && lifetimes && (
                        <span className="flex items-center gap-1" title={t('settings.cache.pingsTitle', { minutes: idleWarmMinutes(lifetimes.short, pings), cap })}>
                          <button type="button" disabled={busy || pings <= 0} onClick={() => void set(model, 'keep-warm', pings - 1)} className="rounded border border-border-strong bg-card p-0.5 disabled:opacity-40" aria-label={t('chat.cacheMode.pingsFewer')}>
                            <Minus size={9} />
                          </button>
                          <span className="w-3 text-center tabular-nums text-primary">{pings}</span>
                          <button type="button" disabled={busy || pings >= cap} onClick={() => void set(model, 'keep-warm', pings + 1)} className="rounded border border-border-strong bg-card p-0.5 disabled:opacity-40" aria-label={t('chat.cacheMode.pingsMore')}>
                            <Plus size={9} />
                          </button>
                          <span className="text-dim">{t('settings.cache.minutes', { minutes: idleWarmMinutes(lifetimes.short, pings) })}</span>
                        </span>
                      )}
                    </div>
                    {!lifetimes && <p className="mt-0.5 text-dim">{t('chat.cacheMode.pingsNotWarmed')}</p>}
                  </td>
                  <td className="px-2.5 py-1.5">
                    {!report ? (
                      <span className="text-faint">—</span>
                    ) : rec ? (
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-primary">{settingText(rec.setting, t)}</span>
                          <span className="text-success">{t('settings.cache.saves', { amount: formatUsd(rec.weeklySaving) })}</span>
                          <button type="button" className={button} disabled={busy || !on} onClick={() => void apply(model, false)}>{t('settings.cache.apply')}</button>
                        </div>
                        {alt && (
                          <div className="flex flex-wrap items-center gap-1.5 text-muted">
                            <span>{t('settings.cache.or', { setting: settingText(alt.setting, t) })}</span>
                            <span className="text-success">{t('settings.cache.saves', { amount: formatUsd(alt.weeklySaving) })}</span>
                            <button type="button" className={button} disabled={busy || !on} onClick={() => void apply(model, true)}>{t('settings.cache.apply')}</button>
                          </div>
                        )}
                      </div>
                    ) : check ? (
                      <span className="text-dim">{checkText(check, t)}</span>
                    ) : (
                      <span className="text-dim">{t('chat.cacheCheck.noHistory')}</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-dim">{t('settings.cache.note')}</p>
        <button type="button" className={button} disabled={loadingReport} onClick={() => void recommend()}>
          <LineChart size={11} /> {loadingReport ? t('chat.cacheCheck.loading') : report ? t('settings.cache.recommendAgain') : t('settings.cache.recommend')}
        </button>
      </div>
    </div>
  )
}
