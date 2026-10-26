import type { AnalyticsRangeKey, AnalyticsReport } from '../../../src/shared/analytics-report'

export const REPORT_ENVELOPE_VERSION = 3
/** The placeholder the built page carries where the data goes. */
export const REPORT_DATA_MARKER = '<!--pi-analytics-data-->'

/** What a report page renders: versioned so an old page and a new package can tell each other apart. */
export interface ReportEnvelope {
  kind: 'analytics-report'
  version: typeof REPORT_ENVELOPE_VERSION
  data: {
    report: AnalyticsReport
    days: number
    range: AnalyticsRangeKey
    generatedAt: number
    language: string
  }
}
