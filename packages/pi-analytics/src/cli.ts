#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { quietSqliteWarning } from './quiet'

async function confirm(title: string, message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`${title}\n${message}\n[y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

quietSqliteWarning()
// Loaded after the warning filter: the session index pulls in node:sqlite.
import('./commands')
  .then(({ runCommand }) => runCommand(process.argv.slice(2), { confirm }))
  .then(
    (lines) => console.log(lines.join('\n')),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    },
  )
