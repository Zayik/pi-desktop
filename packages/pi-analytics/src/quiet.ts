/**
 * Node 22 warns that SQLite is experimental the first time the session index
 * loads it; in a terminal UI that line lands in the middle of the screen.
 * Only that warning is dropped.
 */
export function quietSqliteWarning(): void {
  const emit = process.emitWarning.bind(process) as (...args: unknown[]) => void
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning instanceof Error ? warning.message : warning).includes('SQLite is an experimental feature')) return
    emit(warning, ...rest)
  }) as typeof process.emitWarning
}
