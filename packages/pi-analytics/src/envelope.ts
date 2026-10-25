import type { AnalyticsRangeKey, AnalyticsReport } from '../../../src/shared/analytics-report'
import type { CachePlan } from './cache-plan'
import type { CacheCheck, CacheRecommendation } from './recommendations'

export const REPORT_ENVELOPE_VERSION = 1
/** The placeholder the built page carries where the data goes. */
export const REPORT_DATA_MARKER = '<!--pi-analytics-data-->'

/** What a report page renders: versioned so an old page and a new package can tell each other apart. */
export interface ReportEnvelope {
  kind: 'analytics-report'
  version: typeof REPORT_ENVELOPE_VERSION
  data: {
    report: AnalyticsReport
    recommendations: CacheRecommendation[]
    /** Every model the report covers, including why some have no recommendation. */
    checks: CacheCheck[]
    plan: CachePlan
    days: number
    range: AnalyticsRangeKey
    generatedAt: number
    language: string
  }
}
