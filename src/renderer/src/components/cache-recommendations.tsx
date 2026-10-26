import { useTranslation } from 'react-i18next'
import type { CachePlan, ModelCachePlan } from '../../../../packages/pi-analytics/src/cache-plan'
import type { CacheCheck, CacheRecommendation } from '../../../../packages/pi-analytics/src/recommendations'

export interface CacheRecommendationsProps {
  recommendations: CacheRecommendation[]
  plan: CachePlan | null
  /** Days of sessions behind the figures. */
  days: number
  /** Every model checked, to say which have too little history; optional. */
  checks?: CacheCheck[]
  /** In the app: apply one (`long`: its long-cache alternative); without it the row shows the command instead. */
  onApply?: (recommendation: CacheRecommendation, index: number, long: boolean) => void
  onUndo?: () => void
  busy?: boolean
}

function sameSetting(entry: ModelCachePlan | undefined, setting: CacheRecommendation['setting']): boolean {
  return !!entry && entry.mode === setting.mode && (entry.idlePings ?? null) === (setting.idlePings ?? null)
}

/** Cache settings Pi can run that would have cost less, with their weekly saving, and a way to apply each. */
export function CacheRecommendations({ recommendations, plan, days, checks = [], onApply, onUndo, busy = false }: CacheRecommendationsProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const planned = plan ? Object.keys(plan.models).length + (plan.default ? 1 : 0) : 0
  const thin = checks.filter((check) => check.status === 'not-enough-data')
  if (recommendations.length === 0 && planned === 0 && thin.length === 0) return null
  const action = (rec: CacheRecommendation, index: number, long: boolean): React.ReactNode => {
    if (sameSetting(plan?.models[rec.model], long && rec.alternative ? rec.alternative.setting : rec.setting)) {
      return <span className="text-[10px] text-dim">{t('analytics.recommend.applied')}</span>
    }
    if (onApply) {
      return (
        <button
          type="button"
          disabled={busy}
          onClick={() => onApply(rec, index, long)}
          className="rounded border border-border-strong px-2 py-0.5 text-[11px] text-secondary hover:border-border-strong-hover hover:text-primary disabled:opacity-50"
        >
          {t('analytics.recommend.apply')}
        </button>
      )
    }
    return <code className="rounded bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted">pi-analytics apply {index + 1}{long ? ' --long' : ''}</code>
  }
  const setting = (rec: CacheRecommendation): string => {
    if (rec.setting.mode === 'keep-warm') {
      return t('analytics.recommend.keepWarm', { count: rec.setting.idlePings ?? 0, minutes: Math.round(rec.idleMinutes ?? 0) })
    }
    if (rec.setting.mode === 'long') return t('analytics.recommend.long', { policy: rec.policy })
    return t('analytics.recommend.focus')
  }
  return (
    <section className="min-w-0 rounded-lg border border-border bg-surface p-3">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-dim">{t('analytics.recommend.title')}</h3>
        <span className="truncate text-[10px] text-faint">{t('analytics.recommend.note', { count: Math.max(1, Math.round(days)) })}</span>
      </div>
      {recommendations.length === 0 ? (
        <p className="text-xs text-dim">{t('analytics.recommend.none')}</p>
      ) : (
        <ol className="space-y-1.5">
          {recommendations.map((rec, index) => {
            return (
              <li key={rec.model} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
                <span className="w-4 shrink-0 text-right text-faint">{index + 1}.</span>
                <span className="min-w-0 truncate font-mono text-secondary">{rec.model}</span>
                <span className="text-muted">{setting(rec)}</span>
                <span className="font-medium text-success">{t('analytics.recommend.saving', { amount: `$${rec.weeklySaving.toFixed(2)}` })}</span>
                <span className="ml-auto shrink-0">{action(rec, index, false)}</span>
                {rec.alternative && (
                  <p className="flex basis-full items-baseline gap-2 pl-6 text-[11px] text-dim">
                    <span>{t('analytics.recommend.alternative', { policy: rec.alternative.policy, amount: `$${rec.alternative.weeklySaving.toFixed(2)}` })}</span>
                    <span className="ml-auto shrink-0">{action(rec, index, true)}</span>
                  </p>
                )}
                {rec.beyondPi && (
                  <p className="basis-full pl-6 text-[10px] text-faint">
                    {t('analytics.recommend.beyondPi', { count: rec.beyondPi.pings, minutes: Math.round(rec.beyondPi.idleMinutes) })}
                  </p>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {thin.length > 0 && (
        <p className="mt-2 text-[10px] text-faint">
          {t('analytics.recommend.thin', { models: thin.map((check) => `${check.model} (${check.breaks}/${check.minBreaks})`).join(', '), count: thin.length })}
        </p>
      )}
      {planned > 0 && (
        <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-[10px] text-dim">
          <span>{t('analytics.recommend.planned', { count: planned })}</span>
          {onUndo ? (
            <button type="button" disabled={busy} onClick={onUndo} className="text-accent-fg hover:underline disabled:opacity-50">
              {t('analytics.recommend.undo')}
            </button>
          ) : (
            <code className="font-mono">pi-analytics undo</code>
          )}
        </p>
      )}
    </section>
  )
}
