/**
 * The commands `pi-analytics` and Pi's `/analytics` share. Each returns the
 * lines to show; the caller prints them or puts them in a notification.
 */
import { ANALYTICS_RANGES, type AnalyticsRangeKey } from '../../../src/shared/analytics-report'
import type { AnalyticsSource } from '../../../src/shared/session-analytics'
import { IMPORT_SOURCE_NAMES, type ImportSource } from '../../../src/shared/import-sources'
import { IMPORT_ENV } from '../../../src/main/pi-paths'
import { cacheLines, priceLines } from './cache-text'
import { cacheRecommendations } from '../../../src/shared/cache-analysis'
import {
  MAX_SETTING_PINGS,
  cacheSettingsPath,
  clearAway,
  isModelCacheSetting,
  markAway,
  readAway,
  readCacheSettings,
  readCacheWarming,
  updateCacheSettings,
  writeCacheWarming,
  type ModelCacheSetting,
} from './cache-settings'
import { analyticsDir } from './paths'
import { buildEnvelope, listSources, writeReport } from './report'
import { openFile } from './open'

export const USAGE = [
  'pi-analytics report [--range 7|30|90|365|all] [--out <file>] [--no-open] [--rebuild]',
  '    Write the HTML report (the same view as Pi Desktop) and open it.',
  'pi-analytics cache [--range ...] [--details 5m|30m]',
  '    Whether keep-warm pings would have saved money, and how many, per cache lifetime and model. Read only.',
  'pi-analytics cache show',
  '    The setting each model uses, whether Pi pings after you stop (cache warming), and /away.',
  `pi-analytics cache set <provider/model> <0-${MAX_SETTING_PINGS}|long|pi>`,
  '    Fix a model\'s idle pings (0 for none), or "long" for the longer cache with no pings; "pi" leaves it to Pi.',
  'pi-analytics cache apply [--range ...]',
  '    Set every model to its recommended setting, except models with too little data to tell.',
  'pi-analytics warming on|off',
  '    Let Pi ping after you stop (Pi\'s cacheWarming "idle", which the pings need), or only while it works ("streaming", Pi\'s default).',
  'pi-analytics away [clear]',
  '    No idle pings in any Pi chat until your next message in it, as /away does. "clear" lets them warm again now.',
  'pi-analytics prices [--range ...]',
  '    List prices per million tokens (input, output, cache read and writes) of the models you used, with the long-prompt rates.',
  'pi-analytics sessions [--session <id>] [--no-open]',
  '    Open the live page of every Pi session on this machine (the same view as Pi Desktop\'s Context panel).',
  'pi-analytics serve [--port <port>]',
  '    Run the page\'s helper in this terminal instead of in the background.',
  'pi-analytics sources [--rebuild]',
  '    List the tools whose sessions are read (Pi, Claude Code, Codex, the Copilot app and CLI), with how many sessions and the days they cover.',
]

const SOURCE_LABELS: Record<AnalyticsSource, string> = { pi: 'Pi', ...IMPORT_SOURCE_NAMES }

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
      const sub = parsed.positional[0]
      if (sub === 'show') return showSettings(dir)
      if (sub === 'set') {
        const [, model, value] = parsed.positional
        if (!model || value === undefined) return [`Usage: pi-analytics cache set <provider/model> <0-${MAX_SETTING_PINGS}|long|pi>`]
        const setting = value === 'pi' ? null : value === 'long' ? 'long' : Number(value)
        if (setting !== null && !isModelCacheSetting(setting)) return [`The setting is 0 to ${MAX_SETTING_PINGS} pings, "long" or "pi".`]
        updateCacheSettings({ [model]: setting }, dir)
        return [`${model}: ${settingLabel(setting)}.`, ...warmingNote(setting)]
      }
      if (sub === 'apply') {
        const envelope = await buildEnvelope({ dir, range: rangeOf(flags), now: options.now })
        const recommendations = cacheRecommendations(envelope.data.report.cacheAnalysis)
        const apply = recommendations.filter((entry) => !entry.lowData)
        if (apply.length) updateCacheSettings(Object.fromEntries(apply.map((entry) => [entry.model, entry.setting])), dir)
        return [
          ...apply.map((entry) => `${entry.model}: ${settingLabel(entry.setting)}`),
          ...recommendations.filter((entry) => entry.lowData).map((entry) => `${entry.model}: left as it is, too little data (recommended ${settingLabel(entry.setting)})`),
          ...(recommendations.length ? [] : ['No model Pi ran can take a setting yet.']),
          ...warmingNote(apply.some((entry) => typeof entry.setting === 'number' && entry.setting > 0) ? 1 : null),
        ]
      }
      if (sub !== undefined) return [`Unknown cache command "${sub}".`, ...USAGE]
      const details = flags.get('details')
      if (details !== undefined && details !== '5m' && details !== '30m') return ['--details takes 5m or 30m.']
      const envelope = await buildEnvelope({ dir, range: rangeOf(flags), now: options.now })
      return cacheLines(envelope.data.report.cacheAnalysis, details ?? null)
    }
    case 'warming': {
      const value = parsed.positional[0]
      if (value !== 'on' && value !== 'off') return ['Usage: pi-analytics warming on|off']
      const mode = writeCacheWarming(value === 'on')
      return [`Pi's cacheWarming is now "${mode}": ${value === 'on' ? 'Pi pings after you stop, as each model\'s setting says' : 'Pi warms only while the agent works, so every setting runs like 0 pings'}. Running Pi chats pick it up on their next request.`]
    }
    case 'away': {
      if (parsed.positional[0] === 'clear') {
        clearAway(dir)
        return ['Away cleared: chats still inside Pi\'s 30 idle minutes warm again.']
      }
      const at = markAway(Date.now(), dir)
      return [`Away since ${new Date(at).toLocaleTimeString()}: no idle pings in any Pi chat until your next message in it. Nothing to undo.`]
    }
    case 'prices': {
      const envelope = await buildEnvelope({ dir, range: rangeOf(flags), now: options.now })
      return priceLines(envelope.data.report.cacheAnalysis)
    }
    case 'sessions': {
      const { sessionPageUrl } = await import('./live/launch')
      const session = flags.get('session')
      const url = await sessionPageUrl(typeof session === 'string' ? session : null, { dir })
      if (!flags.has('no-open')) (options.open ?? openFile)(url)
      return [`Session page: ${url}`]
    }
    case 'sources': {
      const sources = await listSources({ dir, rebuild: flags.has('rebuild') })
      const day = (at: number | null): string => (at === null ? '?' : new Date(at).toISOString().slice(0, 10))
      return [
        ...sources.roots.map(({ source, root }) => {
          const found = sources.counts.find((count) => count.source === source)
          const label = SOURCE_LABELS[source]
          return found
            ? `${label}: ${found.sessions} session${found.sessions === 1 ? '' : 's'}, ${day(found.firstAt)} to ${day(found.lastAt)}, $${found.cost.toFixed(2)} at list prices (${root})`
            : `${label}: no sessions found in ${root}`
        }),
        ...(Object.keys(IMPORT_ENV) as ImportSource[])
          .filter((source) => !sources.roots.some((root) => root.source === source))
          .map((source) => `${SOURCE_LABELS[source]}: off (${IMPORT_ENV[source]}=0)`),
        'Other tools\' sessions are priced at the vendors\' list prices, also when they ran on a subscription. Their caches are analyzed the same way, for reference.',
        'Copilot logs only totals per run, so each Copilot call\'s prompt size is estimated; its timing is measured.',
      ]
    }
    case 'help':
    case '--help':
      return USAGE
    default:
      return [`Unknown command "${command}".`, ...USAGE]
  }
}


function settingLabel(setting: ModelCacheSetting | null): string {
  if (setting === null) return 'left to Pi'
  if (setting === 'long') return 'long cache, no idle pings'
  return setting === 1 ? '1 idle ping' : `${setting} idle pings`
}

/** A reminder when pings are set but Pi does not ping after you stop. */
function warmingNote(setting: ModelCacheSetting | null): string[] {
  if (typeof setting !== 'number' || setting === 0 || readCacheWarming() === 'idle') return []
  return ['Cache warming is off, so Pi sends no idle pings yet: turn it on with `pi-analytics warming on`.']
}

function showSettings(dir: string): string[] {
  const { models } = readCacheSettings(dir)
  const warming = readCacheWarming()
  const away = readAway(dir)
  const entries = Object.entries(models).sort(([a], [b]) => a.localeCompare(b))
  return [
    `Cache warming: ${warming === 'idle' ? 'on' : 'off'} (Pi's cacheWarming is "${warming ?? 'streaming'}")`,
    ...(away === null ? [] : [`Away since ${new Date(away).toLocaleString()}: chats with no message since then send no idle pings.`]),
    ...(entries.length ? entries.map(([model, setting]) => `${model}: ${settingLabel(setting)}`) : ['No model has a setting; Pi decides for all of them.']),
    `Settings file: ${cacheSettingsPath(dir)}`,
  ]
}
