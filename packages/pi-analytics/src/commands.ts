/**
 * The commands `pi-analytics` and Pi's `/analytics` share. Each returns the
 * lines to show; the caller prints them or puts them in a notification.
 */
import { spawn } from 'child_process'
import { ANALYTICS_RANGES, type AnalyticsRangeKey } from '../../../src/shared/analytics-report'
import { applyRecommendations, describePlan, readCacheWarming, reset, undo } from './apply'
import { readPlan } from './plan-file'
import { analyticsDir, planPath } from './paths'
import { describeRecommendation } from './recommendations'
import { buildEnvelope, writeReport } from './report'

export const USAGE = [
  'pi-analytics report [--range 7|30|90|365|all] [--out <file>] [--no-open] [--rebuild]',
  '    Write the HTML report (the same view as Pi Desktop) and open it.',
  'pi-analytics recommend [--range ...]',
  '    List cache settings that would have cost less, numbered.',
  'pi-analytics apply <number>... | all [--range ...] [--yes]',
  '    Put recommendations into the cache plan Pi runs with. --yes lets it turn on Pi\'s idle warming when a setting needs it.',
  'pi-analytics plan | undo | reset',
  '    Show the plan, step back one change, or go back to before the first.',
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
    const valued = name === 'range' || name === 'out' || name === 'project'
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

export function openFile(path: string): void {
  const [command, args] = process.platform === 'darwin' ? ['open', [path]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', path]]
      : ['xdg-open', [path]]
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
  } catch {
    // No opener: the path is printed.
  }
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
        ...(recs.length > 0 ? ['', 'Cheaper cache settings (apply with "apply <number>"):', ...recs.map((rec, i) => `${i + 1}. ${describeRecommendation(rec)}`)] : []),
      ]
    }
    case 'recommend': {
      const envelope = await buildEnvelope({ dir, range: rangeOf(flags), now: options.now })
      const recs = envelope.data.recommendations
      if (recs.length === 0) return [`No cache setting would have cost noticeably less over the last ${Math.round(envelope.data.days)} days.`]
      return [`Over the last ${Math.round(envelope.data.days)} days:`, ...recs.map((rec, i) => `${i + 1}. ${describeRecommendation(rec)}`)]
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
    case 'undo': {
      const result = undo({ dir, settingsPath: options.settingsPath, now: options.now })
      if (!result) return ['Nothing to undo.']
      options.afterPlanChange?.()
      return [`Undid: ${result.summary}`, ...(result.restoredCacheWarming ? [`Pi's cacheWarming is back to ${readCacheWarmingLabel(result.restoredCacheWarming)}.`] : [])]
    }
    case 'reset': {
      const result = reset({ dir, settingsPath: options.settingsPath, now: options.now })
      options.afterPlanChange?.()
      return ['The cache plan is back to before its first change; Pi decides for every model again.', ...(result.restoredCacheWarming ? [`Pi's cacheWarming is back to ${readCacheWarmingLabel(result.restoredCacheWarming)}.`] : [])]
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
    case 'help':
    case '--help':
      return USAGE
    default:
      return [`Unknown command "${command}".`, ...USAGE]
  }
}

function readCacheWarmingLabel(value: string | undefined): string {
  return value === undefined || value === 'unset' ? 'not set' : `"${value}"`
}
