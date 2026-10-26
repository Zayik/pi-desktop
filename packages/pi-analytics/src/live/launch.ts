/**
 * Find the running helper, or start one that lives on its own, and give the
 * page's address. Used by `/start-session-analyzer`, `pi-analytics sessions`
 * and Pi Desktop's pop-out.
 */
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { basename, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { analyticsDir } from '../paths'
import { helloAt, pageUrl, readServerInfo, serverToken } from './server'

const START_WAIT_MS = 8_000
const START_POLL_MS = 150

export interface LaunchOptions {
  dir?: string
  /** The package's `cli.js`; found beside this bundle when left out. */
  cliPath?: string
  /** What runs it: Node by default, or Electron with `ELECTRON_RUN_AS_NODE`. */
  runtime?: string
  env?: NodeJS.ProcessEnv
}

export interface HelperAddress {
  port: number
  token: string
  started: boolean
}

/** `dist/cli.js`, beside the bundle or a chunk folder below it. */
export function bundledCliPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [join(here, 'cli.js'), join(here, '..', 'cli.js')]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** The Node that runs Pi, unless Pi is a single binary of its own; then the `node` on PATH. */
export function nodeRuntime(execPath = process.execPath): string {
  return /^(node|bun)(\.exe)?$/i.test(basename(execPath)) ? execPath : 'node'
}

async function runningHelper(dir: string): Promise<number | null> {
  const info = readServerInfo(dir)
  return info && await helloAt(info.port) ? info.port : null
}

export async function ensureHelper(options: LaunchOptions = {}): Promise<HelperAddress> {
  const dir = options.dir ?? analyticsDir()
  // Made before the helper starts, so the two never pick different tokens.
  const token = serverToken(dir)
  const port = await runningHelper(dir)
  if (port !== null) return { port, token, started: false }

  const cli = options.cliPath ?? bundledCliPath()
  if (!cli) throw new Error('pi-analytics is not built: run "npm run build:pi-analytics" in pi-desktop.')
  const child = spawn(options.runtime ?? nodeRuntime(), [cli, 'serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...(options.env ?? process.env), PI_ANALYTICS_DIR: dir },
  })
  child.on('error', () => {})
  child.unref()

  const deadline = Date.now() + START_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS))
    const started = await runningHelper(dir)
    if (started !== null) return { port: started, token, started: true }
  }
  throw new Error('The session page helper did not start. Run "pi-analytics serve" in a terminal to see why.')
}

export async function sessionPageUrl(sessionId: string | null, options: LaunchOptions & { follow?: boolean } = {}): Promise<string> {
  const { port, token } = await ensureHelper(options)
  return pageUrl(port, token, sessionId, options.follow)
}
