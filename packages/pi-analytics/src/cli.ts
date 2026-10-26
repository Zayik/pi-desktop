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

function fail(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

quietSqliteWarning()
const args = process.argv.slice(2)
if (args[0] === 'serve') {
  // The session page's helper: it keeps running until it has been idle a while.
  const portArg = args.indexOf('--port')
  const port = portArg >= 0 ? Number(args[portArg + 1]) : undefined
  import('./live/server')
    .then(({ serve }) => serve({ port: Number.isInteger(port) ? port : undefined, log: (line) => console.log(line) }))
    .then((server) => {
      if (!server) return
      const stop = (): void => void server.close().then(() => process.exit(0))
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
    }, fail)
} else {
  // Loaded after the warning filter: the session index pulls in node:sqlite.
  import('./commands')
    .then(({ runCommand }) => runCommand(args, { confirm }))
    .then((lines) => console.log(lines.join('\n')), fail)
}
