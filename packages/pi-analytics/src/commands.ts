/**
 * The commands `pi-analytics` and Pi's `/analytics` share. Each returns the
 * lines to show; the caller prints them or puts them in a notification.
 */
import { ANALYTICS_RANGES, type AnalyticsRangeKey } from '../../../src/shared/analytics-report'
import { applyRecommendations, describePlan, setCacheControl, setKeepWarmPings, readCacheWarming, reset, undo } from './apply'
import { readPlan } from './plan-file'
import { analyticsDir, planPath } from './paths'
import { describeRecommendation, withAlternative, LONG_MARGIN, type CacheRecommendation } from './recommendations'
import { buildEnvelope, writeReport } from './report'
import { openFile } from './open'

export const USAGE = [
  'pi-analytics report [--range 7|30|90|365|all] [--out <file>] [--no-open] [--rebuild]',
  '    Write the HTML report (the same view as Pi Desktop) and open it.',
  'pi-analytics recommend [--range ...]',
  '    List cache settings that would have cost less, numbered.',
  'pi-analytics apply <number>... | all [--range ...] [--long] [--yes]',
  '    Put recommendations into the cache plan Pi runs with. --long takes the long-cache alternative instead.',
  '    --yes lets it turn on Pi\'s idle warming when a setting needs it.',
  'pi-analytics pings <provider/model> <count> [--yes]',
  '    Keep a model warm with this many refreshes after the agent stops (0 to 6 on a 5-minute cache, 0 to 1 on a 30-minute one).',
  'pi-analytics control on|off',
  '    Off: the package only reads, and Pi runs with its own cache settings (the plan is kept). On: the plan applies again.',
  'pi-analytics plan | undo | reset',
  '    Show the plan, step back one change, or go back to before the first.',
  'pi-analytics sessions [--session <id>] [--no-open]',
  '    Open the live page of every Pi session on this machine (the same view as Pi Desktop\'s Context panel).',
  'pi-analytics serve [--port <port>]',
  '    Run the page\'s helper in this terminal instead of in the background.',
]

export interface CommandOptions {
  dir?: string
  settingsPath?: string
  /** Ask the user; a CLI without a terminal, or Pi without UI, answers no. */
  confirm?: (title: string, message: string) => Promise<boolean>
  /** Called after the plan changes, so a running session picks it up. */
  afterPlanChange?: () => void
  /** Open a written report; the default starts the system's opener. */
  open?: (path: string) => void
  now?: number
}

interface Parsed {
  command: string
  positional: string[]
  flags: Map<string, string | true>
}

function parse(argv: string[]): Parsed {
  const [command = 'report', ...rest] = argv
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const [name, inline] = arg.slice(2).split('=', 2)
    const valued = name === 'range' || name === 'out' || name === 'project' || name === 'session'
    if (inline !== undefined) flags.set(name, inline)
    else if (valued && rest[i + 1] !== undefined) flags.set(name, rest[++i])
    else flags.set(name, true)
  }
  return { command, positional, flags }
}

function rangeOf(flags: Parsed['flags']): AnalyticsRangeKey {
  const value = flags.get('range')
  if (value === undefined) return '30'
  const key = String(value).replace(/d$/, '') as AnalyticsRangeKey
  if (!ANALYTICS_RANGES.includes(key)) throw new Error(`--range must be one of ${ANALYTICS_RANGES.join(', ')}`)
  return key
}


/** Run one command line (`args` as typed after `/analytics` or `pi-analytics`). */
export async function runCommand(args: string | string[], options: CommandOptions = {}): Promise<string[]> {
  const parsed = parse(Array.isArray(args) ? args : args.trim().split(/\s+/).filter(Boolean))
  const dir = options.dir ?? analyticsDir()
  const { command, positional, flags } = parsed
  switch (command) {
    case 'report': {
      const envelope = await buildEnvelope({ dir, range: rangeOf(flags), rebuild: flags.has('rebuild'), now: options.now })
      const out = flags.get('out')
      const path = writeReport(envelope, typeof out === 'string' ? out : undefined, dir)
      if (!flags.has('no-open')) (options.open ?? openFile)(path)
      const recs = envelope.data.recommendations
      return [
        `Report written to ${path}`,
        ...(recs.length > 0 ? ['', 'Cheaper cache settings (apply with "apply <number>"):', ...listLines(recs)] : []),
      ]
    }
    case 'recommend': {
      const envelope = await buildEnvelope({ dir, range: rangeOf(flags), now: options.now })
      const recs = envelope.data.recommendations
      const days = Math.round(envelope.data.days)
      const notes = envelope.data.checks.flatMap((check) => {
        if (check.status === 'not-enough-data') return [`${check.model}: not enough breaks yet (${check.breaks} of ${check.minBreaks}).`]
        if (check.status === 'long-only' && check.alternative) return [`${check.model}: no ping count is worth changing to; the ${check.alternative.policy} cache would save $${check.alternative.weeklySaving.toFixed(2)} a week; pick Long for a chat to use it.`]
        return []
      })
      return [
        recs.length === 0 ? `No cache setting would have cost noticeably less over the last ${days} days.` : `Over the last ${days} days:`,
        ...listLines(recs),
        ...(notes.length > 0 ? ['', ...notes] : []),
      ]
    }
    case 'apply': {
      if (positional.length === 0) return ['Name what to apply: a number from "recommend", or "all".']
      const envelope = await buildEnvelope({ dir, range: rangeOf(flags), now: options.now })
      const recs = envelope.data.recommendations
      const picked = positional.includes('all') ? recs : positional.map((value) => {
        const index = Number(value) - 1
        if (!Number.isInteger(index) || !recs[index]) throw new Error(`There is no recommendation ${value}; "recommend" lists ${recs.length}.`)
        return recs[index]
      })
      if (picked.length === 0) return ['Nothing to apply: no cache setting would have cost noticeably less.']
      if (flags.has('long')) {
        const missing = picked.find((rec) => !rec.alternative)
        if (missing) return [`${missing.model} has no long-cache alternative: it is offered only when it costs ${LONG_MARGIN * 100}% less than the best ping count.`]
        picked.splice(0, picked.length, ...picked.map((rec) => withAlternative(rec) as CacheRecommendation))
      }
      const result = await applyRecommendations(picked, {
        dir,
        settingsPath: options.settingsPath,
        now: options.now,
        days: envelope.data.days,
        allowIdleWarming: () => flags.has('yes') || (options.confirm?.(
          'Turn on idle cache warming?',
          'Refreshing the cache after the agent stops needs Pi\'s cacheWarming setting set to "idle". This applies to every Pi session; undo and reset put the old value back.',
        ) ?? false),
      })
      options.afterPlanChange?.()
      return [
        'Applied:',
        ...result.lines.map((line) => `  ${line}`),
        ...(result.enabledIdleWarming ? ['Pi\'s cacheWarming is now "idle" (it was ' + (readCacheWarmingLabel(result.plan.history.at(-1)?.cacheWarmingBefore)) + ').'] : []),
        ...(result.idleWarmingOff ? ['Pi\'s cacheWarming is not "idle", so no refreshes go out after the agent stops. Run again with --yes to turn it on.'] : []),
        'Undo with "undo". New sessions and the next request of running ones use it.',
      ]
    }
    case 'pings': {
      const [model, count] = positional
      if (!model || count === undefined) return ['Name a model and a count, e.g. "pings anthropic/claude-sonnet-5-5 3".']
      const result = await setKeepWarmPings(model, Number(count), {
        dir,
        settingsPath: options.settingsPath,
        now: options.now,
        allowIdleWarming: () => flags.has('yes') || (options.confirm?.(
          'Turn on idle cache warming?',
          'Refreshing the cache after the agent stops needs Pi\'s cacheWarming setting set to "idle". This applies to every Pi session; undo and reset put the old value back.',
        ) ?? false),
      })
      options.afterPlanChange?.()
      return [
        `Set: ${result.lines[0]}`,
        ...(result.enabledIdleWarming ? ['Pi\'s cacheWarming is now "idle".'] : []),
        ...(result.idleWarmingOff ? ['Pi\'s cacheWarming is not "idle", so no refreshes go out after the agent stops. Run again with --yes to turn it on.'] : []),
        'Undo with "undo". Sessions in keep-warm use it from their next request.',
      ]
    }
    case 'control': {
      const [state] = positional
      if (state !== 'on' && state !== 'off') return ['Say "control on" or "control off".']
      setCacheControl(state === 'on', { dir, now: options.now })
      options.afterPlanChange?.()
      return [state === 'on'
        ? 'Cache control is on: the plan and each session\'s mode apply from the next request.'
        : 'Cache control is off: Pi runs with its own cache settings from the next request. The plan is kept; "control on" brings it back, "reset" clears it.']
    }
    case 'undo': {
      const result = undo({ dir, settingsPath: options.settingsPath, now: options.now })
      if (!result) return ['Nothing to undo.']
      options.afterPlanChange?.()
      return [`Undid: ${result.summary}`, ...(result.restoredCacheWarming ? [`Pi's cacheWarming is back to ${readCacheWarmingLabel(result.restoredCacheWarming)}.`] : [])]
    }
    case 'reset': {
      const result = reset({ dir, settingsPath: options.settingsPath, now: options.now })
      options.afterPlanChange?.()
      return ['The cache plan is back to its defaults and cache control is on; Pi decides for every model again.', ...(result.restoredCacheWarming ? [`Pi's cacheWarming is back to ${readCacheWarmingLabel(result.restoredCacheWarming)}.`] : [])]
    }
    case 'plan': {
      const plan = readPlan(planPath(dir))
      const lines = describePlan(plan)
      const warming = readCacheWarming(options.settingsPath)
      return [
        ...(lines.length > 0 ? lines : ['The cache plan is empty: Pi decides for every model.']),
        `Pi's cacheWarming: ${warming ?? 'not set (refreshes only while the agent works)'}`,
        ...(plan.history.length > 0 ? [`${plan.history.length} change${plan.history.length === 1 ? '' : 's'} on record; the last: ${plan.history.at(-1)?.summary}`] : []),
      ]
    }
    case 'sessions': {
      const { sessionPageUrl } = await import('./live/launch')
      const session = flags.get('session')
      const url = await sessionPageUrl(typeof session === 'string' ? session : null, { dir })
      if (!flags.has('no-open')) (options.open ?? openFile)(url)
      return [`Session page: ${url}`]
    }
    case 'help':
    case '--help':
      return USAGE
    default:
      return [`Unknown command "${command}".`, ...USAGE]
  }
}

/** Numbered lines, each followed by its long alternative when there is one. */
function listLines(recs: CacheRecommendation[]): string[] {
  return recs.flatMap((rec, i) => {
    const alt = rec.alternative
    return [
      `${i + 1}. ${describeRecommendation(rec)}`,
      ...(alt ? [`   or the ${alt.policy} cache instead: saves $${alt.weeklySaving.toFixed(2)} a week (apply ${i + 1} --long)`] : []),
    ]
  })
}

function readCacheWarmingLabel(value: string | undefined): string {
  return value === undefined || value === 'unset' ? 'not set' : `"${value}"`
}
