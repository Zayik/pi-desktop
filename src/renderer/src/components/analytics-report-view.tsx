import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { ChevronDown } from 'lucide-react'
import type { AnalyticsReport, AnalyticsSignal, AnalyticsSessionKind } from '../../../shared/analytics-report'
import type { WorkCategory } from '../../../shared/session-analytics'
import { CACHE_RULES_CHECKED, GAP_BUCKET_MINUTES, OBSERVED_GAP_MINUTES, type CacheDay, type CacheNote, type CachePolicyId, type ModelCacheReport, type ObservedCache } from '../../../shared/cache-policy'
import type { Translate } from '../../../shared/i18n'
import { formatCompact } from '../utils/format-compact'
import { isImportedModel } from '../../../shared/claude-code-session'

const CATEGORY_LABEL_KEYS = {
  test: 'analytics.category.test',
  build: 'analytics.category.build',
  lint: 'analytics.category.lint',
  install: 'analytics.category.install',
  git: 'analytics.category.git',
  shell: 'analytics.category.shell',
  read: 'analytics.category.read',
  search: 'analytics.category.search',
  edit: 'analytics.category.edit',
  subagent: 'analytics.category.subagent',
  web: 'analytics.category.web',
  other: 'analytics.category.other',
} as const satisfies Record<WorkCategory, string>

const CATEGORY_COLORS: Record<WorkCategory, string> = {
  test: 'bg-rose-400', /* theme-exempt: categorical palette */
  build: 'bg-amber-500', /* theme-exempt: categorical palette */
  lint: 'bg-yellow-400', /* theme-exempt: categorical palette */
  install: 'bg-orange-500', /* theme-exempt: categorical palette */
  git: 'bg-slate-400', /* theme-exempt: categorical palette */
  shell: 'bg-violet-500', /* theme-exempt: categorical palette */
  read: 'bg-sky-400', /* theme-exempt: categorical palette */
  search: 'bg-blue-500', /* theme-exempt: categorical palette */
  edit: 'bg-emerald-500', /* theme-exempt: categorical palette */
  subagent: 'bg-fuchsia-500', /* theme-exempt: categorical palette */
  web: 'bg-teal-400', /* theme-exempt: categorical palette */
  other: 'bg-neutral-500', /* theme-exempt: categorical palette */
}

const KIND_LABEL_KEYS = {
  main: 'analytics.kind.main',
  subagent: 'analytics.kind.subagent',
  delegate: 'analytics.kind.delegate',
  child: 'analytics.kind.child',
} as const satisfies Record<AnalyticsSessionKind, string>

const POLICY_LABEL_KEYS = {
  none: 'analytics.cache.policy.none',
  '5m': 'analytics.cache.policy.fiveMinutes',
  '5m-warm-30m': 'analytics.cache.policy.warm30',
  '5m-warm-60m': 'analytics.cache.policy.warm60',
  '5m-warm-break-even': 'analytics.cache.policy.warmBreakEven',
  '1h': 'analytics.cache.policy.oneHour',
  '30m': 'analytics.cache.policy.thirtyMinutes',
  '30m-warm-6h': 'analytics.cache.policy.thirtyWarm6h',
  '30m-warm-12h': 'analytics.cache.policy.thirtyWarm12h',
  '30m-warm-break-even': 'analytics.cache.policy.thirtyWarmBreakEven',
  '12h': 'analytics.cache.policy.twelveHours',
  'in-memory': 'analytics.cache.policy.inMemory',
  'in-memory-warm-30m': 'analytics.cache.policy.inMemoryWarm30',
  'in-memory-warm-60m': 'analytics.cache.policy.inMemoryWarm60',
  'in-memory-warm-break-even': 'analytics.cache.policy.inMemoryWarmBreakEven',
  '24h': 'analytics.cache.policy.twentyFourHours',
} as const satisfies Record<CachePolicyId, string>

const CACHE_NOTE_KEYS = {
  'copilot-vendor': 'analytics.cache.notes.copilotVendor',
  'copilot-automatic': 'analytics.cache.notes.copilotAutomatic',
  'copilot-1h-unlisted': 'analytics.cache.notes.copilot1hUnlisted',
  'implicit-lifetime': 'analytics.cache.notes.implicitLifetime',
  'pi-no-12h': 'analytics.cache.notes.piNo12h',
  'pi-no-pings': 'analytics.cache.notes.piNoPings',
} as const satisfies Record<CacheNote, string>

function policyLabel(policy: string, t: Translate): string {
  return policy in POLICY_LABEL_KEYS ? t(POLICY_LABEL_KEYS[policy as CachePolicyId]) : policy
}

const SEVERITY_CLASSES: Record<AnalyticsSignal['severity'], string> = {
  high: 'border-l-error',
  medium: 'border-l-warning',
  low: 'border-l-border-strong',
}

const MAX_ROWS = 8
/** One shell tool runs every kind of command, so its rows name the kind. */
const SHELL_KINDS: ReadonlySet<WorkCategory> = new Set(['test', 'build', 'lint', 'install', 'git', 'shell'])

export function formatUsd(amount: number): string {
  if (amount === 0) return '$0'
  if (amount < 0.01) return `$${amount.toFixed(4)}`
  if (amount < 10) return `$${amount.toFixed(3)}`
  return `$${amount.toFixed(2)}`
}

/** "35s", "4m 12s", "1h 05m". */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '–'
}

function signalText(signal: AnalyticsSignal, t: Translate): string {
  const v = signal.values
  switch (signal.id) {
    case 'test-time': return t('analytics.signal.testTime', { share: v.share, minutes: v.minutes, runs: v.runs })
    case 'test-reruns': return t('analytics.signal.testReruns', { perSession: v.perSession, runs: v.runs, failed: v.failed })
    case 'slow-tests': return t('analytics.signal.slowTests', { minutes: v.minutes, runs: v.runs })
    case 'build-time': return t('analytics.signal.buildTime', { share: v.share, minutes: v.minutes, runs: v.runs })
    case 'failing-command': return t('analytics.signal.failingCommand', { command: v.command, failures: v.failures })
    case 'carried-tool': return t('analytics.signal.carriedTool', { tool: v.tool, share: v.share, cost: formatUsd(Number(v.cost)) })
    case 'skill-cost': return t('analytics.signal.skillCost', { skill: v.skill, share: v.share, uses: v.uses })
    case 'subagent-share': return t('analytics.signal.subagentShare', { share: v.share })
    case 'cache-policy': return t('analytics.signal.cachePolicy', { model: v.model, policy: policyLabel(String(v.policy), t), current: policyLabel(String(v.current), t), cost: formatUsd(Number(v.cost)), share: v.share })
    case 'compactions': return t('analytics.signal.compactions', { sessions: v.sessions, most: v.most })
  }
}

/** One report, for the session panel (narrow) or the Analytics view (wide). */
/** `actions` sits under the signals: the cache settings to apply, in the app and in the CLI's report. */
/** `autoCompare` shows the experimental Auto comparison; Pi Desktop shows it only with its Experimental setting on. */
export function AnalyticsReportView({ report, wide = false, actions, autoCompare = true }: { report: AnalyticsReport; wide?: boolean; actions?: React.ReactNode; autoCompare?: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <Tiles report={report} />
      <Signals signals={report.signals} />
      {actions}
      {report.scope === 'overall' && report.days.length > 1 && <DailyCost report={report} />}
      <div className={clsx('space-y-4', wide && 'lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0')}>
        <WorkByKind report={report} />
        <CachePolicies report={report} autoCompare={autoCompare} />
        <Section title={t('analytics.tools.title')} note={t('analytics.tools.note')}>
          <Table
            headers={[t('analytics.tools.tool'), t('analytics.tools.calls'), t('analytics.tools.time'), t('analytics.tools.carried')]}
            rows={report.tools.map((tool) => [
              <span key="n" className="flex min-w-0 items-center gap-1.5">
                <span className={clsx('h-2 w-2 shrink-0 rounded-sm', CATEGORY_COLORS[tool.category])} aria-hidden="true" />
                <span className="truncate font-mono">{tool.tool}</span>
                {SHELL_KINDS.has(tool.category) && <span className="shrink-0 text-dim">{t(CATEGORY_LABEL_KEYS[tool.category])}</span>}
                {tool.errors > 0 && <span className="shrink-0 text-error">{t('analytics.tools.errors', { count: tool.errors })}</span>}
              </span>,
              String(tool.calls),
              formatDuration(tool.durationMs),
              formatUsd(tool.carriedCost),
            ])}
            empty={t('analytics.tools.empty')}
          />
        </Section>
        <Tests report={report} />
        <SlowAndFailing report={report} />
        {report.skills.length > 0 && (
          <Section title={t('analytics.skills.title')}>
            <Table
              headers={[t('analytics.skills.skill'), t('analytics.skills.uses'), t('analytics.skills.tokens'), t('analytics.tools.carried')]}
              rows={report.skills.map((skill) => [<span key="n" className="truncate font-mono">{skill.skill}</span>, String(skill.uses), formatCompact(skill.tokens), formatUsd(skill.carriedCost)])}
            />
          </Section>
        )}
        <Section title={t('analytics.prompts.title')}>
          <Table
            headers={[t('analytics.prompts.prompt'), t('analytics.prompts.time'), t('analytics.prompts.cost')]}
            rows={report.topTurns.map((turn) => [
              <span key="n" className="block min-w-0 truncate" title={turn.label ?? undefined}>{turn.label ?? t('analytics.untitled')}</span>,
              formatDuration(turn.durationMs),
              formatUsd(turn.cost),
            ])}
            empty={t('analytics.prompts.empty')}
          />
        </Section>
        <Section title={report.scope === 'session' ? t('analytics.sessions.agentsTitle') : t('analytics.sessions.topTitle')}>
          <Table
            headers={[t('analytics.sessions.session'), t('analytics.sessions.time'), t('analytics.sessions.cost')]}
            rows={report.sessionRows.map((row) => [
              <span key="n" className="flex min-w-0 items-center gap-1.5" title={row.sessionFile}>
                <span className="shrink-0 rounded bg-card px-1 text-[10px] text-dim">{row.agentName ?? t(KIND_LABEL_KEYS[row.kind])}</span>
                <span className={clsx('truncate', !row.fileExists && 'text-dim line-through')}>{row.title ?? t('analytics.untitled')}</span>
              </span>,
              formatDuration(row.activeMs),
              formatUsd(row.cost),
            ])}
          />
        </Section>
        {report.scope === 'overall' && report.projects.length > 1 && (
          <Section title={t('analytics.projects.title')}>
            <Table
              headers={[t('analytics.projects.project'), t('analytics.projects.sessions'), t('analytics.sessions.cost')]}
              rows={report.projects.map((project) => [
                <span key="n" className="block min-w-0 truncate font-mono" title={project.cwd}>{project.cwd}</span>,
                String(project.sessions),
                formatUsd(project.cost),
              ])}
            />
          </Section>
        )}
        <Models report={report} />
      </div>
    </div>
  )
}

function Tiles({ report }: { report: AnalyticsReport }): React.JSX.Element {
  const { t } = useTranslation()
  const tests = report.tests
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(128px,1fr))] gap-2">
      <Tile
        label={t('analytics.tiles.cost')}
        value={formatUsd(report.cost)}
        detail={t('analytics.tiles.costDetail', { sessions: report.sessions, calls: report.calls })}
      />
      <Tile label={t('analytics.tiles.time')} value={formatDuration(report.activeMs)} detail={t('analytics.tiles.timeDetail', { prompts: report.turns })} />
      <Tile
        label={t('analytics.tiles.tests')}
        value={percent(tests.durationMs, report.activeMs)}
        detail={t('analytics.tiles.testsDetail', { runs: tests.runs, failed: tests.failed })}
        tone={tests.shareOfActive >= 0.35 ? 'warning' : undefined}
      />
      <Tile
        label={t('analytics.tiles.subagents')}
        value={formatUsd(report.subagentCost)}
        detail={t('analytics.tiles.subagentsDetail', { share: percent(report.subagentCost, report.cost) })}
      />
    </div>
  )
}

function Tile({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: 'warning' }): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface px-3 py-2">
      <div className="truncate text-[10px] font-medium uppercase tracking-wide text-dim">{label}</div>
      <div className={clsx('mt-0.5 truncate text-base font-semibold tabular-nums', tone === 'warning' ? 'text-warning' : 'text-primary')}>{value}</div>
      {detail && <div className="truncate text-[11px] text-dim tabular-nums">{detail}</div>}
    </div>
  )
}

function Signals({ signals }: { signals: AnalyticsSignal[] }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Section title={t('analytics.signals.title')} note={t('analytics.signals.note')}>
      {signals.length === 0 ? (
        <p className="text-xs text-dim">{t('analytics.signals.empty')}</p>
      ) : (
        <ul className="space-y-1.5">
          {signals.map((signal, index) => (
            <li key={`${signal.id}-${index}`} className={clsx('rounded border border-border border-l-2 bg-surface px-2.5 py-1.5 text-xs text-secondary', SEVERITY_CLASSES[signal.severity])}>
              {signalText(signal, t)}
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function DailyCost({ report }: { report: AnalyticsReport }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const max = Math.max(...report.days.map((day) => day.cost), 0)
  const first = report.days[0]?.day
  const last = report.days[report.days.length - 1]?.day
  const format = (key: string): string => new Date(`${key}T00:00:00`).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' })
  return (
    <Section title={t('analytics.daily.title')} note={t('analytics.daily.peak', { cost: formatUsd(max) })}>
      <div className="flex h-24 items-end gap-px" role="img" aria-label={t('analytics.daily.title')}>
        {report.days.map((day) => (
          <div
            key={day.day}
            className="min-w-0 flex-1 rounded-t-sm bg-accent/70 hover:bg-accent"
            style={{ height: max > 0 ? `${Math.max(day.cost > 0 ? 2 : 0, (day.cost / max) * 100)}%` : '0%' }}
            title={t('analytics.daily.bar', { day: format(day.day), cost: formatUsd(day.cost), time: formatDuration(day.activeMs) })}
          />
        ))}
      </div>
      {first && last && (
        <div className="mt-1 flex justify-between text-[10px] text-faint tabular-nums">
          <span>{format(first)}</span>
          <span>{format(last)}</span>
        </div>
      )}
    </Section>
  )
}

function WorkByKind({ report }: { report: AnalyticsReport }): React.JSX.Element {
  const { t } = useTranslation()
  const categories = report.categories.filter((stat) => stat.calls > 0 || stat.carriedCost > 0)
  const totalTime = categories.reduce((sum, stat) => sum + stat.durationMs, 0)
  return (
    <Section title={t('analytics.work.title')} note={t('analytics.work.note')}>
      {totalTime > 0 && (
        <div className="mb-2 flex h-2 overflow-hidden rounded-full bg-card" aria-hidden="true">
          {categories.map((stat) => (
            <div key={stat.category} className={CATEGORY_COLORS[stat.category]} style={{ width: `${(stat.durationMs / totalTime) * 100}%` }} />
          ))}
        </div>
      )}
      <Table
        headers={[t('analytics.work.kind'), t('analytics.tools.calls'), t('analytics.tools.time'), t('analytics.work.share'), t('analytics.tools.carried')]}
        rows={categories.map((stat) => [
          <span key="n" className="flex items-center gap-1.5">
            <span className={clsx('h-2 w-2 shrink-0 rounded-sm', CATEGORY_COLORS[stat.category])} aria-hidden="true" />
            {t(CATEGORY_LABEL_KEYS[stat.category])}
          </span>,
          String(stat.calls),
          formatDuration(stat.durationMs),
          percent(stat.durationMs, report.activeMs),
          formatUsd(stat.carriedCost),
        ])}
        empty={t('analytics.tools.empty')}
      />
    </Section>
  )
}

function CachePolicies({ report, autoCompare }: { report: AnalyticsReport; autoCompare: boolean }): React.JSX.Element | null {
  const { t } = useTranslation()
  const models = report.cache.models.filter((model) => model.policies.length > 0 || model.measuredCost > 0)
  if (models.length === 0) return null
  return (
    <Section title={t('analytics.cache.title')} note={t('analytics.cache.note')}>
      <div className="space-y-3">
        {report.cache.days.length > 1 && <CacheDays days={report.cache.days} />}
        {autoCompare && report.scope === 'overall' && <AutoCompare report={report} />}
        {models.slice(0, MAX_ROWS).map((model) => <ModelCache key={model.model} model={model} />)}
        <p className="text-[10px] text-faint">{t('analytics.cache.rulesAsOf', { date: CACHE_RULES_CHECKED })}</p>
      </div>
    </Section>
  )
}

/** Auto (experimental) priced walk-forward against the billed cost and the best fixed count, across all sessions. */
function AutoCompare({ report }: { report: AnalyticsReport }): React.JSX.Element | null {
  const { t } = useTranslation()
  const total = report.cache.autoComparison
  if (!total) return null
  const compared = report.cache.models.filter((model) => model.autoComparison)
  const rows = [
    { key: 'billed', label: t('analytics.cache.auto.billed'), cost: total.billed, tone: 'bg-faint' },
    { key: 'fixed', label: t('analytics.cache.auto.fixed'), cost: total.fixed, tone: 'bg-accent' },
    { key: 'auto', label: t('analytics.cache.auto.auto'), cost: total.auto, tone: 'bg-success' },
  ]
  const max = Math.max(...rows.map((row) => row.cost), 1e-9)
  const diff = total.fixed - total.auto
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-secondary">{t('analytics.cache.auto.title')}</span>
        <span className="text-[10px] text-dim">{t('analytics.cache.auto.span', { count: total.days, from: total.fromDay, to: total.toDay })}</span>
      </div>
      <div className="mt-2 space-y-1">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center gap-2">
            <span className="w-32 shrink-0 truncate text-[11px] text-muted">{row.label}</span>
            <span className="h-2.5 min-w-0 flex-1 rounded-sm bg-card">
              <span className={clsx('block h-full rounded-sm', row.tone)} style={{ width: `${(row.cost / max) * 100}%` }} />
            </span>
            <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-secondary">{formatUsd(row.cost)}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-secondary">
        {Math.abs(diff) < Math.max(0.001, total.fixed * 0.01)
          ? t('analytics.cache.auto.same')
          : diff > 0
            ? t('analytics.cache.auto.better', { amount: formatUsd(diff) })
            : t('analytics.cache.auto.worse', { amount: formatUsd(-diff) })}
      </p>
      {compared.length > 1 && (
        <div className="mt-1.5 space-y-0.5">
          {compared.map((model) => {
            const entry = model.autoComparison!
            return (
              <div key={model.model} className="flex items-baseline gap-2 text-[10px] text-dim tabular-nums">
                <span className="min-w-0 flex-1 truncate font-mono">{model.model}</span>
                <span>{t('analytics.cache.auto.row', { billed: formatUsd(entry.billed), fixed: formatUsd(entry.fixed), pings: entry.fixedPings, auto: formatUsd(entry.auto), count: entry.days })}</span>
              </div>
            )
          })}
        </div>
      )}
      <p className="mt-1.5 text-[10px] text-faint">{t('analytics.cache.auto.disclaimer', { count: total.days })}</p>
    </div>
  )
}

export function ModelCache({ model }: { model: ModelCacheReport }): React.JSX.Element {
  const { t } = useTranslation()
  const cheapest = model.policies.reduce<number | null>((min, policy) => (min === null || policy.cost < min ? policy.cost : min), null)
  const name = model.model.split('/').slice(1).join('/') || model.model
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-mono text-secondary" title={model.model}>{name}</span>
          {model.route === 'copilot' && <span className="shrink-0 rounded bg-card px-1 text-[10px] text-dim">{t('analytics.cache.viaCopilot')}</span>}
          {isImportedModel(model.model) && <span className="shrink-0 rounded bg-card px-1 text-[10px] text-dim">{t('analytics.cache.fromClaudeCode')}</span>}
        </span>
        <span className="shrink-0 text-[11px] text-dim tabular-nums">
          {t('analytics.cache.measured', { cost: formatUsd(model.measuredCost), calls: model.calls })}
        </span>
      </div>
      <div className="mt-0.5 text-[11px] text-dim">
        {t('analytics.cache.timing', {
          current: !model.currentPolicy ? t('analytics.cache.unknown') : model.currentPolicyMeasured ? policyLabel(model.currentPolicy, t) : t('analytics.cache.assumed', { policy: policyLabel(model.currentPolicy, t) }),
          gap: formatDuration(model.medianGapMs),
          share: Math.round(model.longGapShare * 100),
          ttl: Math.round(model.shortTtlMs / 60_000),
        })}
      </div>
      {model.notes.map((note) => <p key={note} className="mt-0.5 text-[11px] text-dim">{t(CACHE_NOTE_KEYS[note])}</p>)}
      {isImportedModel(model.model) && <p className="mt-0.5 text-[11px] text-dim">{t('analytics.cache.importedNote')}</p>}
      <GapHistogram buckets={model.gapBuckets} warmMinutes={model.shortTtlMs / 60_000} />
      {model.observed && <ObservedHits observed={model.observed} />}
      {model.policies.length === 0 ? (
        <p className="mt-1.5 text-[11px] text-dim">{t('analytics.cache.noOptions')}</p>
      ) : (
        <>
          <table className="mt-1.5 w-full table-fixed text-xs">
            <tbody>
              {model.policies.map((policy) => (
                <tr key={policy.policy} className="border-t border-border/60">
                  <td className={clsx('py-1 pr-2', policy.policy === model.recommended ? 'font-medium text-success' : 'text-secondary')}>
                    {policyLabel(policy.policy, t)}
                    {policy.policy === model.currentPolicy && <span className="ml-1.5 rounded bg-card px-1 text-[10px] text-dim">{t('analytics.cache.current')}</span>}
                  </td>
                  <td className="w-20 py-1 text-right text-[11px] text-dim tabular-nums">{policy.pings > 0 ? t('analytics.cache.pings', { count: policy.pings }) : ''}</td>
                  <td className={clsx('w-16 py-1 text-right tabular-nums', policy.cost === cheapest ? 'text-success' : 'text-muted')}>{formatUsd(policy.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {model.pingSweep.length > 0 && <PingSweep model={model} />}
          {model.hourly.length > 0 && <HourlyPings model={model} />}
          <p className="mt-1.5 text-[11px] text-secondary">
            {model.recommended
              ? t('analytics.cache.recommend', { policy: policyLabel(model.recommended, t), saving: formatUsd(model.saving) })
              : t('analytics.cache.keep')}
          </p>
        </>
      )}
    </div>
  )
}

/** Measured prompt tokens per day: read from the cache, written to it, sent uncached. */
function CacheDays({ days }: { days: CacheDay[] }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const format = (key: string): string => new Date(`${key}T00:00:00`).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' })
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs text-secondary">{t('analytics.cache.days.title')}</span>
        <span className="flex items-center gap-2 text-[10px] text-dim">
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-success" aria-hidden="true" />{t('analytics.cache.days.read')}</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-warning" aria-hidden="true" />{t('analytics.cache.days.write')}</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-border-strong" aria-hidden="true" />{t('analytics.cache.days.input')}</span>
        </span>
      </div>
      <div className="flex h-16 items-end gap-px" role="img" aria-label={t('analytics.cache.days.title')}>
        {days.map((day) => {
          const total = day.readTokens + day.writeTokens + day.inputTokens
          const share = (part: number): string => `${total > 0 ? (part / total) * 100 : 0}%`
          return (
            <div
              key={day.day}
              className="flex h-full min-w-0 flex-1 flex-col-reverse overflow-hidden rounded-t-sm"
              title={t('analytics.cache.days.bar', { day: format(day.day), hit: Math.round(total > 0 ? (day.readTokens / total) * 100 : 0), cold: day.coldCalls, calls: day.calls })}
            >
              <div className="bg-success" style={{ height: share(day.readTokens) }} />
              <div className="bg-warning" style={{ height: share(day.writeTokens) }} />
              <div className="bg-border-strong" style={{ height: share(day.inputTokens) }} />
            </div>
          )
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-faint tabular-nums">
        <span>{format(days[0].day)}</span>
        <span>{format(days[days.length - 1].day)}</span>
      </div>
    </div>
  )
}

/** How long the model sat idle between calls: the gaps that decide which lifetime pays. */
function GapHistogram({ buckets, warmMinutes }: { buckets: number[]; warmMinutes: number }): React.JSX.Element | null {
  const { t } = useTranslation()
  const max = Math.max(...buckets, 0)
  if (max === 0) return null
  const label = (index: number): string => index === 0
    ? t('analytics.cache.gaps.under', { minutes: GAP_BUCKET_MINUTES[0] })
    : index < GAP_BUCKET_MINUTES.length
      ? t('analytics.cache.gaps.range', { from: GAP_BUCKET_MINUTES[index - 1], to: GAP_BUCKET_MINUTES[index] })
      : t('analytics.cache.gaps.over', { minutes: GAP_BUCKET_MINUTES[GAP_BUCKET_MINUTES.length - 1] })
  return (
    <div className="mt-2">
      <div className="mb-1 text-[10px] text-faint">{t('analytics.cache.gaps.title')}</div>
      <div className="flex items-end gap-1">
        {buckets.map((count, index) => (
          <div key={index} className="flex min-w-0 flex-1 flex-col items-center gap-0.5" title={t('analytics.cache.gaps.bar', { range: label(index), count })}>
            <span className="text-[9px] text-dim tabular-nums">{count}</span>
            <div className="h-8 w-full overflow-hidden rounded-sm bg-card">
              {/* Gaps within the short lifetime keep the cache warm; longer ones do not. */}
              <div className={clsx('w-full', index < GAP_BUCKET_MINUTES.length && GAP_BUCKET_MINUTES[index] <= warmMinutes ? 'bg-success' : 'bg-warning')} style={{ height: `${(count / max) * 100}%`, marginTop: `${100 - (count / max) * 100}%` }} />
            </div>
            <span className="truncate text-[9px] text-faint">{label(index)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Measured share of calls that found the cache warm after each length of break, against the lifetime they ran with. */
function ObservedHits({ observed }: { observed: ObservedCache }): React.JSX.Element | null {
  const { t } = useTranslation()
  const shown = observed.buckets.some((bucket) => bucket.gaps > 0)
  const label = (index: number): string => (index < OBSERVED_GAP_MINUTES.length ? String(OBSERVED_GAP_MINUTES[index]) : `${OBSERVED_GAP_MINUTES[OBSERVED_GAP_MINUTES.length - 1]}+`)
  const expected = observed.expectedMinutes
  const verdict = expected === null
    ? null
    : observed.verdict === 'matches'
      ? t('analytics.cache.observed.matches', { expected, warm: observed.warmUpToMinutes ?? 0, cold: observed.coldFromMinutes ?? expected })
      : observed.verdict === 'shorter'
        ? t('analytics.cache.observed.shorter', { expected, cold: observed.coldFromMinutes ?? 0 })
        : observed.verdict === 'longer'
          ? t('analytics.cache.observed.longer', { expected, warm: observed.warmUpToMinutes ?? 0 })
          : t('analytics.cache.observed.unclear', { expected })
  return (
    <div className="mt-2">
      {shown && (
        <>
          <div className="mb-1 text-[10px] text-faint">{t('analytics.cache.observed.title')}</div>
          <div className="flex items-end gap-0.5" role="img" aria-label={t('analytics.cache.observed.title')}>
            {observed.buckets.map((bucket, index) => {
              const rate = bucket.gaps > 0 ? bucket.hits / bucket.gaps : 0
              const boundary = expected !== null && OBSERVED_GAP_MINUTES[index] === expected
              return (
                <div
                  key={index}
                  className={clsx('flex min-w-0 flex-1 flex-col items-center gap-0.5', boundary && 'border-r border-dashed border-warning pr-0.5')}
                  title={t('analytics.cache.observed.bar', { range: label(index), hits: bucket.hits, gaps: bucket.gaps })}
                >
                  <span className="text-[9px] text-dim tabular-nums">{bucket.gaps > 0 ? `${Math.round(rate * 100)}` : ''}</span>
                  <div className="h-8 w-full overflow-hidden rounded-sm bg-card">
                    {bucket.gaps > 0 && (
                      <div
                        className={clsx('w-full', rate >= 0.8 ? 'bg-success' : rate < 0.5 ? 'bg-warning' : 'bg-border-strong', bucket.gaps < 3 && 'opacity-50')}
                        style={{ height: `${rate * 100}%`, marginTop: `${100 - rate * 100}%` }}
                      />
                    )}
                  </div>
                  <span className="truncate text-[9px] text-faint tabular-nums">{label(index)}</span>
                </div>
              )
            })}
          </div>
          <div className="text-center text-[9px] text-faint">{t('analytics.cache.observed.axis')}</div>
        </>
      )}
      {verdict && shown && <p className="mt-1 text-[11px] text-secondary">{verdict}</p>}
      {observed.pings > 0 && (
        <p className="mt-0.5 text-[11px] text-secondary">
          {t('analytics.cache.observed.pings', { count: observed.pings, hits: observed.pingHits, cost: formatUsd(observed.pingCost) })}
          {observed.pingedGaps > 0 && ` ${t('analytics.cache.observed.pingedGaps', { count: observed.pingedGaps, hits: observed.pingedGapHits })}`}
        </p>
      )}
    </div>
  )
}

/** Idle a ping count keeps warm: minutes up to two hours, then hours. */
function formatIdle(minutes: number, t: Translate): string {
  return minutes < 120
    ? t('analytics.cache.sweep.idleMinutes', { minutes: Math.round(minutes) })
    : t('analytics.cache.sweep.idleHours', { hours: Math.round(minutes / 6) / 10 })
}

/** Replayed cost of the short lifetime plus 0, 1, 2… pings per idle gap, against the long setting. */
function PingSweep({ model }: { model: ModelCacheReport }): React.JSX.Element {
  const { t } = useTranslation()
  const best = model.bestPings
  const base = model.sweepPolicy ? policyLabel(model.sweepPolicy, t) : ''
  const every = Math.round(model.pingEveryMs / 60_000)
  const max = Math.max(...model.pingSweep.map((point) => point.cost), model.longCost ?? 0)
  const min = Math.min(...model.pingSweep.map((point) => point.cost), model.longCost ?? Infinity)
  // Start the scale just under the cheapest option so the differences show.
  const floor = Math.max(0, min - (max - min) * 0.5)
  const height = (cost: number): string => `${max > floor ? ((cost - floor) / (max - floor)) * 100 : 100}%`
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[10px] text-faint">
        <span>{t('analytics.cache.sweep.title', { base })}</span>
        {model.longCost !== null && model.longPolicy && (
          <span className="flex items-center gap-1">
            <span className="w-3 border-t border-dashed border-warning" aria-hidden="true" />
            {t('analytics.cache.sweep.long', { policy: policyLabel(model.longPolicy, t), cost: formatUsd(model.longCost) })}
          </span>
        )}
      </div>
      <div className="relative flex h-20 items-end gap-0.5" role="img" aria-label={t('analytics.cache.sweep.title', { base })}>
        {model.longCost !== null && (
          <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-warning" style={{ bottom: height(model.longCost) }} aria-hidden="true" />
        )}
        {model.pingSweep.map((point) => (
          <div
            key={point.pings}
            className="flex h-full min-w-0 flex-1 items-end rounded-t-sm hover:bg-card"
            title={t('analytics.cache.sweep.point', { count: point.pings, idle: formatIdle(point.idleMinutes, t), cost: formatUsd(point.cost), sent: point.sent })}
          >
            <div className={clsx('w-full rounded-t-sm', point === best ? 'bg-success' : 'bg-border-strong')} style={{ height: height(point.cost) }} />
          </div>
        ))}
      </div>
      <div className="mt-0.5 flex gap-0.5 text-[9px] text-faint tabular-nums">
        {model.pingSweep.map((point) => (
          <span key={point.pings} className={clsx('min-w-0 flex-1 text-center', point === best && 'text-success')}>
            {model.pingSweep.length <= 16 || point.pings % 5 === 0 || point === best ? point.pings : ''}
          </span>
        ))}
      </div>
      <div className="text-center text-[9px] text-faint">{t('analytics.cache.sweep.axis', { every })}</div>
      {best && (
        <p className="mt-1 text-[11px] text-secondary">
          {best.saving > 0
            ? t('analytics.cache.sweep.best', {
              base,
              count: best.pings,
              idle: formatIdle(best.idleMinutes, t),
              cost: formatUsd(best.cost),
              saving: formatUsd(best.saving),
              perSession: formatUsd(best.saving / Math.max(1, model.sessions)),
            })
            : t('analytics.cache.sweep.none', { base, count: best.pings, cost: formatUsd(best.cost) })}
        </p>
      )}
    </div>
  )
}

/** The cheapest ping count for idle gaps starting in each hour of the day. */
function HourlyPings({ model }: { model: ModelCacheReport }): React.JSX.Element {
  const { t } = useTranslation()
  const byHour = new Map(model.hourly.map((hour) => [hour.hour, hour]))
  const most = Math.max(...model.hourly.map((hour) => hour.pings), 1)
  return (
    <div className="mt-2">
      <div className="mb-1 text-[10px] text-faint">{t('analytics.cache.hourly.title')}</div>
      <div className="grid grid-cols-12 gap-0.5">
        {Array.from({ length: 24 }, (_, hour) => {
          const plan = byHour.get(hour)
          return (
            <div
              key={hour}
              className={clsx('relative h-7 overflow-hidden rounded-sm border text-center', plan ? 'border-border bg-surface' : 'border-transparent bg-card/50')}
              title={plan
                ? t('analytics.cache.hourly.cell', { hour: String(hour).padStart(2, '0'), count: plan.pings, gaps: plan.gaps, saving: formatUsd(plan.fixedCost - plan.cost) })
                : t('analytics.cache.hourly.empty', { hour: String(hour).padStart(2, '0') })}
            >
              {plan && <div className="absolute inset-x-0 bottom-0 bg-success/30" style={{ height: `${(plan.pings / most) * 100}%` }} aria-hidden="true" />}
              <div className="relative text-[8px] leading-3 text-faint tabular-nums">{String(hour).padStart(2, '0')}</div>
              <div className="relative text-[10px] leading-3 text-secondary tabular-nums">{plan ? plan.pings : ''}</div>
            </div>
          )
        })}
      </div>
      <p className="mt-1 text-[11px] text-secondary">
        {model.autoSaving > 0 && model.autoCost !== null
          ? t('analytics.cache.hourly.saving', { cost: formatUsd(model.autoCost), saving: formatUsd(model.autoSaving) })
          : t('analytics.cache.hourly.flat')}
      </p>
    </div>
  )
}

function Tests({ report }: { report: AnalyticsReport }): React.JSX.Element {
  const { t } = useTranslation()
  const tests = report.tests
  return (
    <Section title={t('analytics.tests.title')}>
      {tests.runs === 0 ? (
        <p className="text-xs text-dim">{t('analytics.tests.empty')}</p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <Figure label={t('analytics.tests.runs')} value={String(tests.runs)} />
          <Figure label={t('analytics.tests.failed')} value={String(tests.failed)} tone={tests.failed > 0 ? 'error' : undefined} />
          <Figure label={t('analytics.tests.total')} value={formatDuration(tests.durationMs)} />
          <Figure label={t('analytics.tests.median')} value={formatDuration(tests.medianMs)} />
          <Figure label={t('analytics.tests.share')} value={percent(tests.durationMs, report.activeMs)} />
          <Figure label={t('analytics.tests.perSession')} value={tests.sessions > 0 ? (tests.runs / tests.sessions).toFixed(1) : '–'} />
        </dl>
      )}
    </Section>
  )
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'error' }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="truncate text-dim">{label}</dt>
      <dd className={clsx('tabular-nums', tone === 'error' ? 'text-error' : 'text-secondary')}>{value}</dd>
    </div>
  )
}

function SlowAndFailing({ report }: { report: AnalyticsReport }): React.JSX.Element {
  const { t } = useTranslation()
  const failing = report.failedCommands.filter((entry) => entry.failures > 1)
  return (
    <Section title={t('analytics.slow.title')}>
      <Table
        headers={[t('analytics.slow.call'), t('analytics.tools.time')]}
        rows={report.slowCalls.map((call) => [
          <span key="n" className="flex min-w-0 items-center gap-1.5" title={call.detail ?? undefined}>
            <span className={clsx('h-2 w-2 shrink-0 rounded-sm', CATEGORY_COLORS[call.category])} aria-hidden="true" />
            <span className={clsx('truncate font-mono', call.failed && 'text-error')}>{call.detail ?? call.tool}</span>
          </span>,
          formatDuration(call.durationMs),
        ])}
        empty={t('analytics.slow.empty')}
      />
      {failing.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-dim">{t('analytics.slow.failingTitle')}</div>
          <Table
            headers={[t('analytics.slow.command'), t('analytics.slow.failures')]}
            rows={failing.map((entry) => [<span key="n" className="block truncate font-mono" title={entry.command}>{entry.command}</span>, String(entry.failures)])}
          />
        </div>
      )}
    </Section>
  )
}

function Models({ report }: { report: AnalyticsReport }): React.JSX.Element | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  if (report.models.length === 0) return null
  return (
    <Section
      title={t('analytics.models.title')}
      action={(
        <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1 text-[11px] text-dim hover:text-muted" aria-expanded={open}>
          <ChevronDown size={12} className={clsx('transition-transform', !open && '-rotate-90')} />
          {open ? t('analytics.models.hide') : t('analytics.models.show', { count: report.models.length })}
        </button>
      )}
    >
      {open && (
        <Table
          headers={[t('analytics.models.model'), t('analytics.tools.calls'), t('analytics.sessions.cost')]}
          rows={report.models.map((model) => [<span key="n" className="block truncate font-mono">{model.model}</span>, String(model.calls), formatUsd(model.cost)])}
        />
      )}
    </Section>
  )
}

function Section({ title, note, action, children }: { title: string; note?: string; action?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="min-w-0">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-dim">{title}</h3>
        {action ?? (note && <span className="truncate text-[10px] text-faint">{note}</span>)}
      </div>
      {children}
    </section>
  )
}

function Table({ headers, rows, empty }: { headers: string[]; rows: React.ReactNode[][]; empty?: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const { t } = useTranslation()
  if (rows.length === 0) return <p className="text-xs text-dim">{empty}</p>
  const shown = expanded ? rows : rows.slice(0, MAX_ROWS)
  return (
    <div>
      <table className="w-full table-fixed text-xs">
        <thead>
          <tr className="text-[10px] text-faint">
            {headers.map((header, index) => (
              <th key={header} className={clsx('pb-1 font-medium', index === 0 ? 'w-auto text-left' : 'w-16 text-right')}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-t border-border/60">
              {row.map((value, index) => (
                <td key={index} className={clsx('py-1', index === 0 ? 'min-w-0 pr-2 text-secondary' : 'text-right tabular-nums text-muted')}>{value}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > MAX_ROWS && (
        <button type="button" onClick={() => setExpanded(!expanded)} className="mt-1 text-[11px] text-dim hover:text-muted">
          {expanded ? t('analytics.showLess') : t('analytics.showAll', { count: rows.length })}
        </button>
      )}
    </div>
  )
}
