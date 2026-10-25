import React from 'react'
import ReactDOM from 'react-dom/client'
import { I18nextProvider, useTranslation } from 'react-i18next'
import { i18n } from '../../../src/shared/i18n'
import { AnalyticsReportView } from '../../../src/renderer/src/components/analytics-report-view'
import { CacheRecommendations } from '../../../src/renderer/src/components/cache-recommendations'
import { REPORT_ENVELOPE_VERSION, type ReportEnvelope } from '../src/envelope'
import './report.css'

function readEnvelope(): ReportEnvelope | null {
  const element = document.getElementById('pi-analytics-data')
  if (!element?.textContent) return null
  try {
    const parsed = JSON.parse(element.textContent) as ReportEnvelope
    return parsed.kind === 'analytics-report' && parsed.version === REPORT_ENVELOPE_VERSION ? parsed : null
  } catch {
    return null
  }
}

function Page({ envelope }: { envelope: ReportEnvelope | null }): React.JSX.Element {
  const { t } = useTranslation()
  if (!envelope) return <p className="p-10 text-center text-sm text-dim">{t('analytics.page.noData')}</p>
  const { report, recommendations, checks, plan, days, generatedAt } = envelope.data
  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-base font-semibold text-primary">{t('analytics.page.title')}</h1>
        <span className="text-xs text-dim">
          {t('analytics.page.generated', { date: new Date(generatedAt).toLocaleString(), count: Math.max(1, Math.round(days)) })}
        </span>
      </header>
      {report.sessions === 0 ? (
        <p className="py-10 text-center text-xs text-dim">{t('analytics.view.empty')}</p>
      ) : (
        <AnalyticsReportView report={report} wide actions={<CacheRecommendations recommendations={recommendations} checks={checks} plan={plan} days={days} />} />
      )}
    </main>
  )
}

const envelope = readEnvelope()
const language = envelope?.data.language
if (language && language !== i18n.language && i18n.hasResourceBundle(language, 'translation')) void i18n.changeLanguage(language)
document.documentElement.lang = i18n.language

const root = document.getElementById('root')
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <I18nextProvider i18n={i18n}>
        <Page envelope={envelope} />
      </I18nextProvider>
    </React.StrictMode>,
  )
}
