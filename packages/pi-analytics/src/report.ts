/**
 * The report outside Pi Desktop: the same session index and report code the
 * app runs, with the index kept in the package's folder, and the same view
 * rendered into one self-contained HTML file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { AnalyticsIndex, type SourceSummary } from '../../../src/main/analytics-index'
import type { AnalyticsSource } from '../../../src/shared/session-analytics'
import type { AnalyticsRangeKey } from '../../../src/shared/analytics-report'
import { readPlan } from './plan-file'
import { REPORT_DATA_MARKER, REPORT_ENVELOPE_VERSION, type ReportEnvelope } from './envelope'
import { ARCHIVE_DIR, INDEX_FILE, REPORTS_DIR, analyticsDir, planPath } from './paths'
import { cacheChecks, recommendations, reportDays } from './recommendations'

export const REPORT_TEMPLATE_FILE = 'report.html'

export interface BuildOptions {
  range?: AnalyticsRangeKey
  projectPath?: string | null
  dir?: string
  /** Read every session file again. */
  rebuild?: boolean
  language?: string
  now?: number
}

export async function buildEnvelope(options: BuildOptions = {}): Promise<ReportEnvelope> {
  const dir = options.dir ?? analyticsDir()
  const range = options.range ?? '30'
  const now = options.now ?? Date.now()
  mkdirSync(dir, { recursive: true })
  const index = new AnalyticsIndex({ dbPath: join(dir, INDEX_FILE), archiveDir: join(dir, ARCHIVE_DIR) })
  try {
    if (options.rebuild) await index.rebuild()
    const report = await index.overview({ range, projectPath: options.projectPath ?? null }, now)
    return {
      kind: 'analytics-report',
      version: REPORT_ENVELOPE_VERSION,
      data: {
        report,
        recommendations: recommendations(report, now),
        checks: cacheChecks(report, now),
        plan: readPlan(planPath(dir)),
        days: reportDays(report, now),
        range,
        generatedAt: now,
        language: options.language ?? 'en',
      },
    }
  } finally {
    index.close()
  }
}

/** The folders each tool's sessions are read from, and what the index holds from each. */
export async function listSources(options: { dir?: string; rebuild?: boolean } = {}): Promise<{ roots: { source: AnalyticsSource; root: string }[]; counts: SourceSummary[] }> {
  const dir = options.dir ?? analyticsDir()
  mkdirSync(dir, { recursive: true })
  const index = new AnalyticsIndex({ dbPath: join(dir, INDEX_FILE), archiveDir: join(dir, ARCHIVE_DIR) })
  try {
    if (options.rebuild) await index.rebuild()
    else await index.refresh(true)
    return { roots: index.roots(), counts: index.sources() }
  } finally {
    index.close()
  }
}

/** The built page, next to the bundle (`dist/report.html`). */
export function reportTemplatePath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // Beside the bundle, a chunk folder below it, or the sources (`src/` next to `dist/`).
  for (const candidate of [join(here, REPORT_TEMPLATE_FILE), join(here, '..', REPORT_TEMPLATE_FILE), join(here, '..', 'dist', REPORT_TEMPLATE_FILE)]) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`The report page is not built: run "npm run build:pi-analytics" in pi-desktop (looked for ${REPORT_TEMPLATE_FILE} beside ${here}).`)
}

/** JSON safe inside a `<script>` element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

export function renderHtml(envelope: ReportEnvelope, template = readFileSync(reportTemplatePath(), 'utf8')): string {
  if (!template.includes(REPORT_DATA_MARKER)) throw new Error('The report page has no data placeholder; rebuild it.')
  const data = `<script id="pi-analytics-data" type="application/json">${scriptJson(envelope)}</script>`
  return template.replace(REPORT_DATA_MARKER, () => data)
}

/** Write the page and return its path: `reports/analytics-<date>.html` unless `out` names one. */
export function writeReport(envelope: ReportEnvelope, out?: string, dir = analyticsDir()): string {
  const day = new Date(envelope.data.generatedAt).toISOString().slice(0, 10)
  const path = out ?? join(dir, REPORTS_DIR, `analytics-${day}.html`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, renderHtml(envelope))
  return path
}
