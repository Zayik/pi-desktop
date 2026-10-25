import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { ChevronDown } from 'lucide-react'
import type { AnalyticsReport, AnalyticsSignal, AnalyticsSessionKind } from '../../../shared/analytics-report'
import type { WorkCategory } from '../../../shared/session-analytics'
import { GAP_BUCKET_MINUTES, type CacheDay, type CachePolicyId, type ModelCacheReport } from '../../../shared/cache-policy'
import type { Translate } from '../../../shared/i18n'
import { formatCompact } from '../utils/format-compact'

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
  '12h': 'analytics.cache.policy.twelveHours',
} as const satisfies Record<CachePolicyId, string>

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
export function AnalyticsReportView({ report, wide = false }: { report: AnalyticsReport; wide?: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <Tiles report={report} />
      <Signals signals={report.signals} />
      {report.scope === 'overall' && report.days.length > 1 && <DailyCost report={report} />}
      <div className={clsx('space-y-4', wide && 'lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0')}>
        <WorkByKind report={report} />
        <CachePolicies report={report} />
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

function CachePolicies({ report }: { report: AnalyticsReport }): React.JSX.Element | null {
  const { t } = useTranslation()
  const models = report.cache.models.filter((model) => model.policies.length > 0 || model.measuredCost > 0)
  if (models.length === 0) return null
  return (
    <Section title={t('analytics.cache.title')} note={t('analytics.cache.note')}>
      <div className="space-y-3">
        {report.cache.days.length > 1 && <CacheDays days={report.cache.days} />}
        {models.slice(0, MAX_ROWS).map((model) => <ModelCache key={model.model} model={model} />)}
      </div>
    </Section>
  )
}

function ModelCache({ model }: { model: ModelCacheReport }): React.JSX.Element {
  const { t } = useTranslation()
  const cheapest = model.policies.reduce<number | null>((min, policy) => (min === null || policy.cost < min ? policy.cost : min), null)
  const name = model.model.split('/').slice(1).join('/') || model.model
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate font-mono text-secondary" title={model.model}>{name}</span>
        <span className="shrink-0 text-[11px] text-dim tabular-nums">
          {t('analytics.cache.measured', { cost: formatUsd(model.measuredCost), calls: model.calls })}
        </span>
      </div>
      <div className="mt-0.5 text-[11px] text-dim">
        {t('analytics.cache.timing', {
          current: !model.currentPolicy ? t('analytics.cache.unknown') : model.currentPolicyMeasured ? policyLabel(model.currentPolicy, t) : t('analytics.cache.assumed', { policy: policyLabel(model.currentPolicy, t) }),
          gap: formatDuration(model.medianGapMs),
          share: Math.round(model.longGapShare * 100),
        })}
      </div>
      <GapHistogram buckets={model.gapBuckets} />
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
          {model.warmSweep.length > 0 && <WarmSweep model={model} />}
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
function GapHistogram({ buckets }: { buckets: number[] }): React.JSX.Element | null {
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
              {/* Gaps within five minutes keep a 5 minute cache warm; longer ones do not. */}
              <div className={clsx('w-full', index < 2 ? 'bg-success' : 'bg-warning')} style={{ height: `${(count / max) * 100}%`, marginTop: `${100 - (count / max) * 100}%` }} />
            </div>
            <span className="truncate text-[9px] text-faint">{label(index)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 5 minutes plus pings, by how long the pinging keeps going, against the current setting. */
function WarmSweep({ model }: { model: ModelCacheReport }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="mt-2">
      <div className="mb-1 text-[10px] text-faint">{t('analytics.cache.sweep.title')}</div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(52px,1fr))] gap-1">
        {model.warmSweep.map((point) => (
          <div
            key={point.idleMinutes}
            className={clsx('rounded border px-1 py-0.5 text-center', point === model.bestWarm ? 'border-success text-success' : 'border-border text-muted')}
            title={t('analytics.cache.sweep.point', { minutes: point.idleMinutes, cost: formatUsd(point.cost), pings: point.pings })}
          >
            <div className="text-[10px]">{t('analytics.cache.sweep.minutes', { minutes: point.idleMinutes })}</div>
            <div className="text-[11px] tabular-nums">{point.saving >= 0 ? `−${formatUsd(point.saving)}` : `+${formatUsd(-point.saving)}`}</div>
          </div>
        ))}
      </div>
      {model.bestWarm && (
        <p className="mt-1 text-[11px] text-secondary">
          {t('analytics.cache.sweep.best', {
            minutes: model.bestWarm.idleMinutes,
            saving: formatUsd(model.bestWarm.saving),
            perSession: formatUsd(model.bestWarm.saving / Math.max(1, model.sessions)),
          })}
        </p>
      )}
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
