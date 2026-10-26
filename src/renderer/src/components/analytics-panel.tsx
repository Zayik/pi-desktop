import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardList, X } from 'lucide-react'
import type { AnalyticsReport } from '../../../shared/analytics-report'
import { retroDigest, retroPrompt } from '../../../shared/retro-digest'
import { useAppStore } from '../store'
import { AnalyticsReportView } from './analytics-report-view'
import { CopyButton } from './copy-button'

/** Reading the session and its agents' files again costs more than the Context panel's snapshot, so this polls slower. */
const REPORT_POLL_MS = 10_000

/** The active session's report, re-read while the panel is open. */
export function useSessionReport(sessionFile: string | null): { report: AnalyticsReport | null; loaded: boolean } {
  const [state, setState] = useState<{ file: string | null; report: AnalyticsReport | null; loaded: boolean }>({ file: null, report: null, loaded: false })
  useEffect(() => {
    if (!sessionFile) return
    let cancelled = false
    const load = (): void => {
      void window.piDesktop.analytics.getSessionReport(sessionFile)
        .then((report) => { if (!cancelled) setState({ file: sessionFile, report, loaded: true }) })
        .catch(() => { if (!cancelled) setState((previous) => ({ ...previous, file: sessionFile, loaded: true })) })
    }
    load()
    const timer = setInterval(load, REPORT_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionFile])
  return state.file === sessionFile ? { report: state.report, loaded: state.loaded } : { report: null, loaded: false }
}

/** Right-side Analytics panel: where this session and its agents spent money and time, and a retro on it. */
export function AnalyticsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  // The tab's session file still has its history while the agent is stopped.
  const sessionFile = useAppStore((state) => state.sessionState?.sessionFile
    ?? (state.activeSessionRuntimeId ? state.sessionRuntimes[state.activeSessionRuntimeId]?.sessionPath : null)
    ?? null)
  const sessionName = useAppStore((state) => state.sessionState?.sessionName ?? null)
  const engine = useAppStore((state) => state.piEngine)
  const { report, loaded } = useSessionReport(sessionFile)
  const digest = report ? retroDigest(report, sessionName ?? report.sessionRows[0]?.title ?? null) : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-medium text-secondary">{t('analytics.panel.title')}</span>
        <div className="flex items-center gap-1">
          {digest && (
            <>
              <CopyButton text={digest} />
              <button
                type="button"
                onClick={() => useAppStore.getState().insertPrompt(retroPrompt(digest, engine === 'pi'), true)}
                className="flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted hover:bg-surface-hover hover:text-primary"
                title={t('analytics.retro.sessionTitle')}
              >
                <ClipboardList size={12} />
                {t('analytics.retro.button')}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded text-faint hover:text-muted"
            title={t('analytics.panel.close')}
            aria-label={t('analytics.panel.close')}
          >
            <X size={13} />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {!sessionFile ? (
          <p className="py-6 text-center text-xs text-dim">{t('analytics.panel.noSession')}</p>
        ) : !report ? (
          <p className="py-6 text-center text-xs text-dim">{loaded ? t('analytics.panel.empty') : t('analytics.loading')}</p>
        ) : (
          <AnalyticsReportView report={report} />
        )}
      </div>
    </div>
  )
}
