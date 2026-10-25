import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { ClipboardList, RefreshCw } from 'lucide-react'
import { ANALYTICS_RANGES, type AnalyticsRangeKey, type AnalyticsReport, type CachePlanState } from '../../../shared/analytics-report'
import { needsIdleWarming } from '../../../../packages/pi-analytics/src/cache-plan'
import { recommendations, reportDays, type CacheRecommendation } from '../../../../packages/pi-analytics/src/recommendations'
import { retroDigest, retroPrompt } from '../../../shared/retro-digest'
import { useAppStore } from '../store'
import { AnalyticsReportView } from './analytics-report-view'
import { CacheRecommendations } from './cache-recommendations'
import { CopyButton } from './copy-button'

const RANGE_LABEL_KEYS = {
  '7': 'analytics.ranges.sevenDays',
  '30': 'analytics.ranges.thirtyDays',
  '90': 'analytics.ranges.threeMonths',
  '365': 'analytics.ranges.oneYear',
  all: 'analytics.ranges.all',
} as const satisfies Record<AnalyticsRangeKey, string>

/** Sidebar > Analytics: cost and time across every session, with an overall retro. */
export function AnalyticsView(): React.JSX.Element {
  const { t } = useTranslation()
  const activeWorkspace = useAppStore((state) => state.activeWorkspace)
  const engine = useAppStore((state) => state.piEngine)
  const [range, setRange] = useState<AnalyticsRangeKey>('30')
  const [projectOnly, setProjectOnly] = useState(false)
  const [report, setReport] = useState<AnalyticsReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const projectPath = projectOnly ? activeWorkspace?.path ?? null : null
  const [planState, setPlanState] = useState<CachePlanState | null>(null)
  const [planBusy, setPlanBusy] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  // A setting that refreshes after the agent stops, waiting for the user to allow Pi's idle warming.
  const [askIdle, setAskIdle] = useState<CacheRecommendation | null>(null)

  const load = useCallback(async (rebuild = false): Promise<void> => {
    setLoading(true)
    setError(false)
    try {
      if (rebuild) await window.piDesktop.analytics.rebuild()
      setReport(await window.piDesktop.analytics.getOverview({ range, projectPath }))
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [range, projectPath])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void window.piDesktop.analytics.getCachePlan().then(setPlanState, () => setPlanState(null))
  }, [])

  const recs = useMemo(() => (report ? recommendations(report) : []), [report])
  const changePlan = async (change: () => Promise<CachePlanState>): Promise<void> => {
    setPlanBusy(true)
    setPlanError(null)
    try {
      setPlanState(await change())
    } catch (failure) {
      setPlanError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setPlanBusy(false)
      setAskIdle(null)
    }
  }
  const apply = (rec: CacheRecommendation, allowIdleWarming: boolean): Promise<void> =>
    changePlan(() => window.piDesktop.analytics.applyCacheRecommendation({ range, projectPath, model: rec.model, allowIdleWarming }))
  const requestApply = (rec: CacheRecommendation): void => {
    if (needsIdleWarming({ ...rec.setting, appliedAt: 0 }) && planState?.cacheWarming !== 'idle') setAskIdle(rec)
    else void apply(rec, false)
  }

  const digest = report ? retroDigest(report) : null
  const startRetro = async (): Promise<void> => {
    if (!digest) return
    const store = useAppStore.getState()
    // An overall retro is its own conversation, not a turn in whatever chat is open.
    if (store.activeWorkspace) await store.createNewSession()
    useAppStore.getState().insertPrompt(retroPrompt(digest, engine === 'pi'), true)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
        <div>
          <h1 className="text-sm font-semibold text-primary">{t('analytics.view.title')}</h1>
          <p className="text-xs text-dim">{t('analytics.view.subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-border p-0.5" role="group" aria-label={t('analytics.view.range')}>
            {ANALYTICS_RANGES.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setRange(key)}
                aria-pressed={range === key}
                className={clsx('rounded px-2 py-0.5 text-[11px]', range === key ? 'bg-card text-primary' : 'text-dim hover:text-muted')}
              >
                {t(RANGE_LABEL_KEYS[key])}
              </button>
            ))}
          </div>
          <label className={clsx('flex items-center gap-1.5 text-[11px]', activeWorkspace ? 'text-muted' : 'text-faint')} title={activeWorkspace?.path}>
            <input type="checkbox" checked={projectOnly} disabled={!activeWorkspace} onChange={(event) => setProjectOnly(event.target.checked)} />
            {activeWorkspace ? t('analytics.view.projectOnly', { project: activeWorkspace.name }) : t('analytics.view.noProject')}
          </label>
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={loading}
            className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] text-muted hover:bg-surface-hover disabled:opacity-50"
            title={t('analytics.view.rebuildTitle')}
          >
            <RefreshCw size={12} className={clsx(loading && 'animate-spin')} />
            {t('analytics.view.rebuild')}
          </button>
          {digest && <CopyButton text={digest} className="h-7" />}
          <button
            type="button"
            onClick={() => void startRetro()}
            disabled={!digest || report?.sessions === 0}
            className="flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-[11px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            title={t('analytics.retro.overallTitle')}
          >
            <ClipboardList size={12} />
            {t('analytics.retro.button')}
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto max-w-6xl">
          {error ? (
            <p className="py-10 text-center text-xs text-error">{t('analytics.view.error')}</p>
          ) : !report ? (
            <p className="py-10 text-center text-xs text-dim">{t('analytics.loading')}</p>
          ) : report.sessions === 0 ? (
            <p className="py-10 text-center text-xs text-dim">{t('analytics.view.empty')}</p>
          ) : (
            <AnalyticsReportView
              report={report}
              wide
              actions={(
                <div className="space-y-2">
                  {askIdle && (
                    <div className="rounded-lg border border-border-strong bg-card p-3 text-xs">
                      <p className="font-medium text-primary">{t('analytics.recommend.idleTitle')}</p>
                      <p className="mt-1 text-muted">{t('analytics.recommend.idleMessage')}</p>
                      <div className="mt-2 flex gap-2">
                        <button type="button" disabled={planBusy} onClick={() => void apply(askIdle, true)} className="rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:bg-accent-hover disabled:opacity-50">
                          {t('analytics.recommend.idleAccept')}
                        </button>
                        <button type="button" disabled={planBusy} onClick={() => setAskIdle(null)} className="rounded border border-border px-2.5 py-1 text-[11px] text-muted hover:bg-surface-hover">
                          {t('analytics.recommend.idleCancel')}
                        </button>
                      </div>
                    </div>
                  )}
                  {planError && <p className="text-xs text-error">{t('analytics.recommend.failed', { error: planError })}</p>}
                  <CacheRecommendations
                    recommendations={recs}
                    plan={planState?.plan ?? null}
                    days={reportDays(report)}
                    busy={planBusy}
                    onApply={requestApply}
                    onUndo={() => void changePlan(() => window.piDesktop.analytics.undoCachePlan())}
                  />
                </div>
              )}
            />
          )}
        </div>
      </div>
    </div>
  )
}
