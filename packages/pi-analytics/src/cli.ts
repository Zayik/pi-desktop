#!/usr/bin/env node
import { quietSqliteWarning } from './quiet'

quietSqliteWarning()
// Loaded after the warning filter: the session index pulls in node:sqlite.
import('./commands')
  .then(({ runCommand }) => runCommand(process.argv.slice(2)))
  .then(
    (lines) => console.log(lines.join('\n')),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    },
  )
