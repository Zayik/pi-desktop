import { useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import type { AnalyticsReport } from '../../../shared/analytics-report'
import { checkModel, reportDays } from '../../../../packages/pi-analytics/src/recommendations'
import { ModelCache } from './analytics-report-view'
import { CacheRecommendations } from './cache-recommendations'
import type { Translate } from '../../../shared/i18n'
import type { CacheCheck } from '../../../../packages/pi-analytics/src/recommendations'

/** Why there is no recommendation to apply. */
export function checkText(check: CacheCheck, t: Translate): string {
  switch (check.status) {
    case 'not-enough-data': return t('chat.cacheCheck.notEnoughData', { count: check.breaks, needed: check.minBreaks })
    case 'no-saving': return t('chat.cacheCheck.noSaving')
    case 'long-only': return t('chat.cacheCheck.longOnly', { policy: check.alternative?.policy ?? '1h' })
    case 'not-covered': return t('chat.cacheCheck.notCovered')
    case 'recommend': return ''
  }
}

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
  useEffect(() => {
    let cancelled = false
    void window.piDesktop.analytics.getOverview({ range: CHECK_RANGE, projectPath: null })
      .then((value) => { if (!cancelled) setReport(value) }, () => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  const modelReport = report?.cache.models.find((entry) => entry.model === model) ?? null
  const check = useMemo(() => (report && modelReport ? checkModel(modelReport, reportDays(report)) : null), [report, modelReport])
  const recs = check?.recommendation ? [check.recommendation] : []

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 px-4 pt-[8vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
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
          <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-hover hover:text-primary" aria-label={t('chat.cacheCheck.close')}>
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
              {check && check.status !== 'recommend' && <p className="rounded-lg border border-border bg-card p-3 text-xs text-secondary">{checkText(check, t)}</p>}
              {recs.length > 0 && <CacheRecommendations recommendations={recs} plan={null} days={reportDays(report)} readOnly />}
              <ModelCache model={modelReport} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
