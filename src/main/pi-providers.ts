import { execFile } from 'child_process'
import os from 'os'
import type { PiProviderStatus } from '../shared/ipc-contracts'
import { buildPiInvocation, buildPiRunEnv, getPiCli } from './pi-rpc-manager'
import type { PiCli } from './pi-rpc-manager'

/**
 * Provider sign-in without copying Pi's sign-in code. Pi Desktop only asks
 * Pi: `pi --list-models` says which providers are usable, `pi auth check`
 * says whether each one's credential works, and signing in runs Pi's own
 * `/login` screen in a terminal (pi-login.ts). When Pi changes how a provider
 * signs in, nothing here has to change.
 */

/** `pi auth check` may refresh an OAuth token over the network. */
const AUTH_CHECK_TIMEOUT_MS = 20_000
const LIST_MODELS_TIMEOUT_MS = 30_000
const LIST_MODELS_MAX_BUFFER = 8 * 1024 * 1024
/** Provider ids as Pi writes them; anything else is never typed into the TUI. */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i
const LIST_MODELS_HEADER = 'provider'
const AUTH_STATUSES = new Set(['ready', 'not_ready', 'invalid'])

export function isProviderId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && PROVIDER_ID_PATTERN.test(value)
}

/**
 * Provider ids from `pi --list-models`, in first-seen order. Only rows under
 * its table header count, so a message such as "No models found" is not
 * read as a provider.
 */
export function parseListModelsProviders(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/)
  const header = lines.findIndex((line) => line.trim().split(/\s+/)[0] === LIST_MODELS_HEADER)
  if (header < 0) return []
  const providers: string[] = []
  for (const line of lines.slice(header + 1)) {
    const first = line.trim().split(/\s+/)[0]
    if (!first || !isProviderId(first)) continue
    if (!providers.includes(first)) providers.push(first)
  }
  return providers
}

/** One provider's `pi auth check --json` answer; unknown when unreadable. */
export function parseAuthCheck(stdout: string, provider: string): PiProviderStatus {
  try {
    const parsed = JSON.parse(stdout.trim()) as { status?: unknown; authType?: unknown; reason?: unknown }
    if (typeof parsed.status === 'string' && AUTH_STATUSES.has(parsed.status)) {
      return {
        provider,
        status: parsed.status as PiProviderStatus['status'],
        ...(typeof parsed.authType === 'string' ? { authType: parsed.authType } : {}),
        ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
      }
    }
  } catch {
    // Not JSON: an older Pi without `auth check`, or an error message.
  }
  return { provider, status: 'unknown' }
}

/** What `/login` types: Pi's picker of every provider, or one provider's methods. */
export function loginCommand(provider: string | null): string {
  return provider ? `/login ${provider}` : '/login'
}

function runPi(cli: PiCli, args: string[], timeout: number): Promise<string> {
  const invocation = buildPiInvocation(cli, args)
  return new Promise((resolve) => {
    execFile(
      invocation.file,
      invocation.args,
      {
        cwd: os.homedir(),
        timeout,
        maxBuffer: LIST_MODELS_MAX_BUFFER,
        env: buildPiRunEnv(cli.needsShell),
        shell: cli.needsShell,
        windowsHide: true,
      },
      // `auth check` exits 1 for not_ready and 2 for invalid and still prints
      // its JSON, so stdout counts whatever the exit code.
      (_error, stdout) => resolve(typeof stdout === 'string' ? stdout : '')
    )
  })
}

/**
 * Providers Pi can use right now and the state of each one's credential.
 * Empty when Pi is missing. Custom providers from models.json are included,
 * because Pi lists them like any other.
 */
export async function listPiProviders(): Promise<PiProviderStatus[]> {
  const cli = getPiCli()
  if (cli.failureReason || cli.kind === 'omp') return []
  const providers = parseListModelsProviders(await runPi(cli, ['--list-models'], LIST_MODELS_TIMEOUT_MS))
  return Promise.all(
    providers.map(async (provider) =>
      parseAuthCheck(await runPi(cli, ['auth', 'check', '--provider', provider, '--json'], AUTH_CHECK_TIMEOUT_MS), provider)
    )
  )
}

/** The program and arguments that start Pi's interactive screen in a PTY. */
export function interactivePiCommand(cli: PiCli, comspec: string | undefined): { file: string; args: string[] } {
  if (cli.useNode) return { file: cli.node, args: [cli.script] }
  // A .cmd shim needs cmd.exe; a PTY has no `shell: true`.
  if (cli.needsShell) return { file: comspec ?? 'cmd.exe', args: ['/d', '/c', cli.script] }
  return { file: cli.script, args: [] }
}

