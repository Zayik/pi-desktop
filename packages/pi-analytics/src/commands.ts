/**
 * The commands `pi-analytics` and Pi's `/analytics` share. Each returns the
 * lines to show; the caller prints them or puts them in a notification.
 */
import { ANALYTICS_RANGES, type AnalyticsRangeKey } from '../../../src/shared/analytics-report'
import { cacheLines } from './cache-text'
import { analyticsDir } from './paths'
import { buildEnvelope, writeReport } from './report'
import { openFile } from './open'

export const USAGE = [
  'pi-analytics report [--range 7|30|90|365|all] [--out <file>] [--no-open] [--rebuild]',
  '    Write the HTML report (the same view as Pi Desktop) and open it.',
  'pi-analytics cache [--range ...] [--details 5m|30m]',
  '    Whether keep-warm pings would have saved money, and how many, per cache lifetime and model. Read only.',
  'pi-analytics sessions [--session <id>] [--no-open]',
  '    Open the live page of every Pi session on this machine (the same view as Pi Desktop\'s Context panel).',
  'pi-analytics serve [--port <port>]',
  '    Run the page\'s helper in this terminal instead of in the background.',
]

export interface CommandOptions {
  dir?: string
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
    const valued = name === 'range' || name === 'out' || name === 'project' || name === 'details' || name === 'session'
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
  const { command, flags } = parsed
  switch (command) {
    case 'report': {
      const envelope = await buildEnvelope({ dir, range: rangeOf(flags), rebuild: flags.has('rebuild'), now: options.now })
      const out = flags.get('out')
      const path = writeReport(envelope, typeof out === 'string' ? out : undefined, dir)
      if (!flags.has('no-open')) (options.open ?? openFile)(path)
      return [`Report written to ${path}`, '', ...cacheLines(envelope.data.report.cacheAnalysis)]
    }
    case 'cache': {
      const details = flags.get('details')
      if (details !== undefined && details !== '5m' && details !== '30m') return ['--details takes 5m or 30m.']
      const envelope = await buildEnvelope({ dir, range: rangeOf(flags), now: options.now })
      return cacheLines(envelope.data.report.cacheAnalysis, details ?? null)
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

