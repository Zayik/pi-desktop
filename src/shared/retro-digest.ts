/**
 * The evidence a retro starts from: the report's numbers as compact
 * Markdown the agent reads. Always English, like logs, since it is written
 * for the model rather than shown in the interface.
 */
import type { AnalyticsReport, AnalyticsSignal } from './analytics-report'

/** The retro skill shipped with the app (resources/skills/pi-retro). */
export const RETRO_SKILL_NAME = 'pi-retro'
const MAX_DIGEST_ROWS = 8

function money(value: number): string {
  if (value === 0) return '$0'
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return `${Math.round(ms / 1000)}s`
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

function share(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '-'
}

function cell(text: string | null | undefined): string {
  return (text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '-'
}

function date(at: number | null): string {
  return at === null ? 'start' : new Date(at).toISOString().slice(0, 10)
}

function signalLine(signal: AnalyticsSignal): string {
  const v = signal.values
  switch (signal.id) {
    case 'test-time': return `Tests took ${v.share}% of active time (${v.minutes} min over ${v.runs} runs).`
    case 'test-reruns': return `Tests ran ${v.perSession} times per session that tested (${v.runs} runs, ${v.failed} failed).`
    case 'slow-tests': return `The median test run took ${v.minutes} min (${v.runs} runs).`
    case 'build-time': return `Builds took ${v.share}% of active time (${v.minutes} min over ${v.runs} runs).`
    case 'failing-command': return `\`${v.command}\` failed ${v.failures} times.`
    case 'carried-tool': return `Results of \`${v.tool}\` were resent with later calls for ${v.share}% of all cost (${money(Number(v.cost))}).`
    case 'skill-cost': return `Skill \`${v.skill}\` stayed in context for ${v.share}% of all cost (${v.uses} loads).`
    case 'subagent-share': return `Subagents made up ${v.share}% of the cost.`
    case 'cache-policy': return `Cache setting ${v.policy} instead of ${v.current} would have saved about ${money(Number(v.cost))} (${v.share}% of its simulated prompt cost) on ${v.model}.`
    case 'compactions': return `${v.sessions} session(s) compacted three or more times (most: ${v.most}).`
  }
}

/** The digest for a session report (with its agents) or an overall report. */
export function retroDigest(report: AnalyticsReport, title: string | null = null): string {
  const lines: string[] = []
  const scope = report.scope === 'session'
    ? `one session${title ? ` ("${cell(title)}")` : ''} and its ${report.sessions - 1} agent session(s)`
    : `${report.sessions} session(s) from ${date(report.from)} to ${report.to === null ? 'now' : date(report.to)}`
  lines.push('# Pi Desktop analytics digest', '')
  lines.push(`Scope: ${scope}.`)
  lines.push(`Cost ${money(report.cost)} over ${report.calls} model calls and ${report.turns} prompts; active time ${duration(report.activeMs)}.`)
  lines.push(`Tokens: ${report.input} input, ${report.cacheRead} cache read, ${report.cacheWrite} cache write, ${report.output} output.`)
  lines.push('Active time counts gaps under 5 minutes between session entries, plus time waiting on tools. Carried cost is what later calls paid to resend a result; it is an estimate (4 characters per token).', '')

  if (report.signals.length > 0) {
    lines.push('## Signals', '')
    for (const signal of report.signals) lines.push(`- [${signal.severity}] ${signalLine(signal)}`)
    lines.push('')
  }

  lines.push('## Work by kind', '', '| Kind | Calls | Errors | Time | Share of active | Carried cost |', '|---|---|---|---|---|---|')
  for (const stat of report.categories) {
    lines.push(`| ${stat.category} | ${stat.calls} | ${stat.errors} | ${duration(stat.durationMs)} | ${share(stat.durationMs, report.activeMs)} | ${money(stat.carriedCost)} |`)
  }
  lines.push('')

  lines.push('## Tools', '', '| Tool | Kind | Calls | Errors | Time | Result tokens | Carried cost |', '|---|---|---|---|---|---|---|')
  for (const tool of report.tools.slice(0, MAX_DIGEST_ROWS)) {
    lines.push(`| ${cell(tool.tool)} | ${tool.category} | ${tool.calls} | ${tool.errors} | ${duration(tool.durationMs)} | ${tool.resultTokens} | ${money(tool.carriedCost)} |`)
  }
  lines.push('')

  const { tests } = report
  lines.push('## Tests', '')
  lines.push(tests.runs === 0
    ? 'No test runs were found.'
    : `${tests.runs} run(s) in ${tests.sessions} session(s), ${tests.failed} failed; ${duration(tests.durationMs)} in total, median ${duration(tests.medianMs)}, ${share(tests.durationMs, report.activeMs)} of active time.`)
  lines.push('')

  if (report.slowCalls.length > 0) {
    lines.push('## Slowest tool calls', '')
    for (const call of report.slowCalls.slice(0, MAX_DIGEST_ROWS)) {
      lines.push(`- ${duration(call.durationMs)} ${call.tool}${call.failed ? ' (failed)' : ''}: ${cell(call.detail)}`)
    }
    lines.push('')
  }

  if (report.failedCommands.length > 0) {
    lines.push('## Commands that failed more than once', '')
    for (const failed of report.failedCommands.filter((entry) => entry.failures > 1).slice(0, MAX_DIGEST_ROWS)) {
      lines.push(`- ${failed.failures}x \`${cell(failed.command)}\``)
    }
    lines.push('')
  }

  if (report.cache.models.some((model) => model.policies.length > 0)) {
    lines.push('## Prompt cache settings (replayed)', '')
    lines.push('Prompt cost of the same calls at the same times under each setting; measured is what was billed. 5m-warm pings every 4 minutes for up to 1 hour of idle.', '')
    for (const model of report.cache.models.filter((entry) => entry.policies.length > 0).slice(0, MAX_DIGEST_ROWS)) {
      const options = model.policies.map((policy) => `${policy.policy} ${money(policy.cost)}`).join(', ')
      lines.push(`- ${model.model} (${model.calls} calls, now ${model.currentPolicy ?? 'unknown'}${model.currentPolicyMeasured ? '' : ' (assumed)'}, measured ${money(model.measuredCost)}, median gap ${duration(model.medianGapMs)}): ${options}${model.recommended ? `; cheapest ${model.recommended}, saves ${money(model.saving)}` : ''}`)
    }
    lines.push('')
  }

  if (report.skills.length > 0) {
    lines.push('## Skills', '')
    for (const skill of report.skills.slice(0, MAX_DIGEST_ROWS)) {
      lines.push(`- ${skill.skill}: ${skill.uses} load(s), ~${skill.tokens} tokens, carried ${money(skill.carriedCost)}`)
    }
    lines.push('')
  }

  if (report.models.length > 0) {
    lines.push('## Models', '')
    for (const model of report.models.slice(0, MAX_DIGEST_ROWS)) {
      lines.push(`- ${model.provider ? `${model.provider}/` : ''}${model.model}: ${model.calls} calls, ${money(model.cost)}`)
    }
    lines.push('')
  }

  if (report.topTurns.length > 0) {
    lines.push('## Most expensive prompts', '')
    for (const turn of report.topTurns.slice(0, MAX_DIGEST_ROWS)) {
      lines.push(`- ${money(turn.cost)}, ${duration(turn.durationMs)}, ${turn.calls} calls, ${turn.toolCalls} tools: ${cell(turn.label)}`)
    }
    lines.push('')
  }

  lines.push(report.scope === 'session' ? '## Sessions in this report' : '## Most expensive sessions', '')
  lines.push(`Subagents and delegates: ${money(report.subagentCost)} (${share(report.subagentCost, report.cost)}).`, '')
  for (const row of report.sessionRows.slice(0, MAX_DIGEST_ROWS)) {
    const who = row.kind === 'main' ? 'main' : `${row.kind}${row.agentName ? ` ${row.agentName}` : ''}`
    lines.push(`- ${money(row.cost)}, ${duration(row.activeMs)} [${who}] ${cell(row.title)}${row.fileExists ? ` - ${row.sessionFile}` : ' (file deleted)'}`)
  }
  if (report.scope === 'overall' && report.projects.length > 1) {
    lines.push('', '## Projects', '')
    for (const project of report.projects.slice(0, MAX_DIGEST_ROWS)) {
      lines.push(`- ${money(project.cost)}, ${duration(project.activeMs)}, ${project.sessions} session(s): ${project.cwd}`)
    }
  }
  return `${lines.join('\n').trim()}\n`
}

/**
 * The composer text that runs the retro skill on a digest. Pi Desktop loads
 * the skill into Pi only; another engine gets the request without it.
 */
export function retroPrompt(digest: string, withSkill = true): string {
  const request = 'Run a retrospective using this digest as the evidence. Propose changes to the environment (checks, test commands, navigation pointers, tool use), most saving first, each citing a number from the digest. Do not change anything until I pick one.'
  return withSkill ? `/skill:${RETRO_SKILL_NAME} ${request}\n\n${digest}` : `${request}\n\n${digest}`
}
