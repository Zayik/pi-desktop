/**
 * Sessions read from other tools' logs. Their calls are named
 * `<provider>/<model>` with the tool's own provider, so they stay apart from
 * the same model under Pi. The analysis shows them for reference.
 */
import type { AnalyticsSource } from './session-analytics'

export type ImportSource = Exclude<AnalyticsSource, 'pi'>

/** The provider part of an imported call's model name, per tool. */
export const IMPORT_PROVIDERS: Record<ImportSource, string> = {
  'claude-code': 'claude-code',
  codex: 'codex',
  copilot: 'copilot-cli',
}

/** Each tool's name, for text outside the app. */
export const IMPORT_SOURCE_NAMES: Record<ImportSource, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot app and CLI',
}

/** The tool a model name was imported from, or null for Pi's own. */
export function importSourceOf(model: string): ImportSource | null {
  const provider = model.split('/')[0]
  const found = (Object.entries(IMPORT_PROVIDERS) as [ImportSource, string][]).find(([, name]) => name === provider)
  return found ? found[0] : null
}

/** A model from another tool's sessions. */
export function isImportedModel(model: string): boolean {
  return importSourceOf(model) !== null
}
