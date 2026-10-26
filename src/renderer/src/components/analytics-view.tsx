import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { ClipboardList, RefreshCw } from 'lucide-react'
import { ANALYTICS_RANGES, type AnalyticsRangeKey, type AnalyticsReport } from '../../../shared/analytics-report'
import type { CacheSetting, CacheSettingsState } from '../../../shared/cache-analysis'
import { retroDigest, retroPrompt } from '../../../shared/retro-digest'
import { useAppStore } from '../store'
import { AnalyticsReportView } from './analytics-report-view'
import { CopyButton } from './copy-button'
import type { CacheSettingsControls } from './prompt-cache-analysis'

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

  const [cacheState, setCacheState] = useState<CacheSettingsState | null>(null)
  const [cacheBusy, setCacheBusy] = useState(false)
  const [cacheError, setCacheError] = useState(false)
  const changeCache = useCallback(async (change: () => Promise<CacheSettingsState>): Promise<void> => {
    setCacheBusy(true)
    setCacheError(false)
    try {
      setCacheState(await change())
    } catch {
      setCacheError(true)
    } finally {
      setCacheBusy(false)
    }
  }, [])
  useEffect(() => {
    void changeCache(() => window.piDesktop.analytics.getCacheSettings())
  }, [changeCache])
  const cacheSettings: CacheSettingsControls | undefined = cacheState ? {
    state: cacheState,
    busy: cacheBusy,
    onSet: (changes: Record<string, CacheSetting | null>) => void changeCache(() => window.piDesktop.analytics.setCacheSettings(changes)),
    onWarming: (on: boolean) => void changeCache(() => window.piDesktop.analytics.setCacheWarming(on)),
    onAway: (away: boolean) => void changeCache(() => window.piDesktop.analytics.setAway(away)),
  } : undefined


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
            <>
              {cacheError && <p className="mb-2 text-xs text-error">{t('analytics.promptCache.settings.error')}</p>}
              <AnalyticsReportView
                report={report}
                wide
                cacheSettings={cacheSettings}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
