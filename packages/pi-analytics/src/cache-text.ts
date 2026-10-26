/**
 * The Prompt cache section as text, for `pi-analytics cache` and Pi's
 * `/analytics cache`: the same numbers as the desktop cards and chart.
 */
import { summarize, weekSplit, type CacheAnalysis, type CacheGroupAnalysis, type CacheGroupId, type PingSummary } from '../../../src/shared/cache-analysis'

const GROUP_NAMES: Record<CacheGroupId, string> = {
  '5m': '5-minute cache',
  '30m': '30-minute cache',
  automatic: 'Automatic caching',
}

const CONFIDENCE_LABELS = { none: 'not enough data', early: 'early', solid: 'solid' } as const

function money(amount: number): string {
  return `$${Math.abs(amount).toFixed(2)}`
}

function pings(count: number): string {
  return count === 0 ? 'no pings' : `${count} ping${count === 1 ? '' : 's'}`
}

function modelName(model: string): string {
  return model.split('/').slice(1).join('/') || model
}

function percent(share: number | null): string {
  return share === null ? 'no cache reads' : `${Math.round(share * 100)}%`
}

export function groupHeadline(group: CacheGroupAnalysis, summary: PingSummary): string {
  if (group.id === 'automatic') return summary.hitRate === null ? 'No cache reads yet.' : `${percent(summary.hitRate)} of input was read from cache. The provider runs this cache, so pings cannot help.`
  if (summary.confidence === 'none') return `Not enough breaks yet (${summary.longBreaks} over ${group.lifetimeMinutes} min). Check back after more use.`
  if (summary.best === 0) return 'Pings would not have saved money. Leave them off.'
  const tie = summary.tie === null ? '' : ` ${Math.min(summary.tie, summary.best)} and ${Math.max(summary.tie, summary.best)} pings are about the same.`
  return `${pings(summary.best)[0].toUpperCase()}${pings(summary.best).slice(1)} would have saved about ${money(summary.savingPerWeek)} a week.${tie}`
}

export function cacheLines(analysis: CacheAnalysis, details: CacheGroupId | null = null): string[] {
  if (analysis.groups.length === 0) return ['No prompt cache calls in this range.']
  const weeks = Math.max(analysis.days, 1) / 7
  const lines = [`Prompt cache over the last ${analysis.days} day${analysis.days === 1 ? '' : 's'} (read only; nothing here changes Pi's settings):`]
  for (const group of analysis.groups) {
    if (details && group.id !== details) continue
    const summary = summarize(group.models, group.maxPings, analysis.days)
    lines.push('', `${GROUP_NAMES[group.id]}: ${group.models.map((model) => modelName(model.model)).join(', ')}`)
    lines.push(`  ${groupHeadline(group, summary)}`)
    if (group.id === 'automatic') continue
    lines.push(`  Hit rate ${percent(summary.hitRate)} · ${summary.longBreaks} breaks over ${group.lifetimeMinutes} min (${CONFIDENCE_LABELS[summary.confidence]}) · pings cover breaks up to ${Math.round(group.reachMinutes ?? 0)} min`)
    if (summary.noCacheTotal > 0) {
      lines.push(summary.cacheSavingPerWeek < 0
        ? `  Sending with no cache at all would have been about ${money(summary.cacheSavingPerWeek)} a week cheaper: most prompts were not reread before the cache expired.`
        : `  Caching itself saves about ${money(summary.cacheSavingPerWeek)} a week compared with sending with no cache.`)
    }
    if (group.models.length > 1) {
      lines.push('  By model:')
      for (const model of group.models) {
        const own = summarize([model], group.maxPings, analysis.days)
        const breaks = `${model.longBreaks} break${model.longBreaks === 1 ? '' : 's'}`
        lines.push(own.confidence === 'none'
          ? `    ${modelName(model.model)}: not enough data (${breaks})${summary.confidence === 'none' ? '' : `, uses the group's ${pings(summary.best)}`}`
          : `    ${modelName(model.model)}: ${pings(own.best)}, saves ${money(own.savingPerWeek)} a week (${CONFIDENCE_LABELS[own.confidence]}, ${breaks})`)
      }
    }
    if (details !== group.id) continue
    lines.push('  Each count against no pings, over the whole range and per week:')
    summary.totals.forEach((total, count) => {
      const diff = total - summary.totals[0]
      const sign = diff < -0.005 ? '-' : diff > 0.005 ? '+' : ''
      lines.push(`    ${pings(count).padEnd(9)} ${`${sign}${money(diff)}`.padStart(9)}  ${`${sign}${money(diff / weeks)}`.padStart(7)}/week${count === summary.best ? '  best' : ''}`)
    })
    if (group.models.length > 1) lines.push(`  Each model on its own best count saves ${money(summary.totals[0] - summary.perModelTotal)} over the range.`)
    lines.push(`  The cheapest count at every break, in hindsight, saves ${money(summary.totals[0] - summary.perBreakTotal)}: the most a ping count set by time could reach.`)
    const split = weekSplit(group.models, group.maxPings, analysis.to, analysis.days)
    if (split) {
      lines.push(split.earlier.best === split.later.best
        ? `  Both of the last two weeks agree on ${pings(split.earlier.best)} (saving ${money(split.earlier.saving)} and ${money(split.later.saving)}).`
        : `  The week before last was cheapest with ${pings(split.earlier.best)} (${money(split.earlier.saving)}), last week with ${pings(split.later.best)} (${money(split.later.saving)}).`)
    }
  }
  return lines
}
