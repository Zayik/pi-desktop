import { useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import type { AnalyticsReport, CachePlanState } from '../../../shared/analytics-report'
import { needsIdleWarming } from '../../../../packages/pi-analytics/src/cache-plan'
import { recommendations, reportDays, type CacheRecommendation } from '../../../../packages/pi-analytics/src/recommendations'
import { ModelCache } from './analytics-report-view'
import { CacheRecommendations } from './cache-recommendations'

/** The recommendation looks at the same window Auto learns from. */
const CHECK_RANGE = '30'

interface CacheCheckDialogProps {
  /** `provider/model` of the chat's model. */
  model: string
  onClose: () => void
}

/**
 * Check recommendation: what each cache setting would have cost this chat's
 * model over the last 30 days, and the cheapest one Pi can run, to apply
 * once (for every chat on the model) and undo.
 */
export function CacheCheckDialog({ model, onClose }: CacheCheckDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const titleId = useId()
  const [report, setReport] = useState<AnalyticsReport | null>(null)
  const [failed, setFailed] = useState(false)
  const [planState, setPlanState] = useState<CachePlanState | null>(null)
  const [busy, setBusy] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  // A setting that refreshes after the agent stops, waiting for the user to allow Pi's idle warming.
  const [askIdle, setAskIdle] = useState<CacheRecommendation | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.piDesktop.analytics.getOverview({ range: CHECK_RANGE, projectPath: null })
      .then((value) => { if (!cancelled) setReport(value) }, () => { if (!cancelled) setFailed(true) })
    void window.piDesktop.analytics.getCachePlan().then((value) => { if (!cancelled) setPlanState(value) }, () => undefined)
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [busy, onClose])

  const modelReport = report?.cache.models.find((entry) => entry.model === model) ?? null
  const recs = useMemo(() => (report ? recommendations(report).filter((rec) => rec.model === model) : []), [report, model])

  const changePlan = async (change: () => Promise<CachePlanState>): Promise<void> => {
    setBusy(true)
    setPlanError(null)
    try {
      setPlanState(await change())
    } catch (failure) {
      setPlanError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
      setAskIdle(null)
    }
  }
  const apply = (rec: CacheRecommendation, allowIdleWarming: boolean): Promise<void> =>
    changePlan(() => window.piDesktop.analytics.applyCacheRecommendation({ range: CHECK_RANGE, projectPath: null, model: rec.model, allowIdleWarming }))
  const requestApply = (rec: CacheRecommendation): void => {
    if (needsIdleWarming({ ...rec.setting, appliedAt: 0 }) && planState?.cacheWarming !== 'idle') setAskIdle(rec)
    else void apply(rec, false)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 px-4 pt-[8vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[84vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border-strong bg-surface shadow-2xl"
      >
        <div className="flex items-start justify-between border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold text-primary">{t('chat.cacheCheck.title')}</h2>
            <p className="mt-0.5 truncate text-xs text-dim">{t('chat.cacheCheck.intro', { model })}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="rounded p-1 text-muted hover:bg-surface-hover hover:text-primary disabled:opacity-50" aria-label={t('chat.cacheCheck.close')}>
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {failed ? (
            <p className="py-6 text-center text-xs text-error">{t('chat.cacheCheck.failed')}</p>
          ) : !report ? (
            <p className="py-6 text-center text-xs text-dim">{t('chat.cacheCheck.loading')}</p>
          ) : !modelReport ? (
            <p className="py-6 text-center text-xs text-dim">{t('chat.cacheCheck.noHistory')}</p>
          ) : (
            <>
              {askIdle && (
                <div className="rounded-lg border border-border-strong bg-card p-3 text-xs">
                  <p className="font-medium text-primary">{t('analytics.recommend.idleTitle')}</p>
                  <p className="mt-1 text-muted">{t('analytics.recommend.idleMessage')}</p>
                  <div className="mt-2 flex gap-2">
                    <button type="button" disabled={busy} onClick={() => void apply(askIdle, true)} className="rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:bg-accent-hover disabled:opacity-50">
                      {t('analytics.recommend.idleAccept')}
                    </button>
                    <button type="button" disabled={busy} onClick={() => setAskIdle(null)} className="rounded border border-border px-2.5 py-1 text-[11px] text-muted hover:bg-surface-hover">
                      {t('analytics.recommend.idleCancel')}
                    </button>
                  </div>
                </div>
              )}
              {planError && <p className="text-xs text-error">{t('analytics.recommend.failed', { error: planError })}</p>}
              {recs.length > 0 || (planState && Object.keys(planState.plan.models).length > 0) ? (
                <CacheRecommendations
                  recommendations={recs}
                  plan={planState?.plan ?? null}
                  days={reportDays(report)}
                  busy={busy}
                  onApply={requestApply}
                  onUndo={() => void changePlan(() => window.piDesktop.analytics.undoCachePlan())}
                />
              ) : (
                <p className="rounded-lg border border-border bg-surface p-3 text-xs text-dim">{t('analytics.recommend.none')}</p>
              )}
              <ModelCache model={modelReport} />
              <p className="text-[11px] text-faint">{t('chat.cacheCheck.appliesTo')}</p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
