import { spawn } from 'child_process'
import { posix, win32 } from 'path'
import type {
  PiInstallMethod,
  PiInstallOption,
  PiInstallResult,
  PiSearchStep,
  PiSetupReport,
} from '../shared/ipc-contracts'
import {
  PI_INSTALLER_COMMAND_POSIX,
  PI_INSTALLER_COMMAND_WINDOWS,
  PI_NPM_INSTALL_COMMAND,
  PI_WINGET_ID,
  whichInPath,
} from './pi-binary-resolution'
import type { ResolutionDeps } from './pi-binary-resolution'
import { RESOLUTION_DEPS, getPiCli, refreshPiResolution, tracePiSearch } from './pi-rpc-manager'
import { childProcessEnv } from './windows-exe-search'

export const PI_WINGET_INSTALL_COMMAND =
  `winget install --id ${PI_WINGET_ID} -e --accept-source-agreements --accept-package-agreements`

export const PI_INSTALL_METHODS: readonly PiInstallMethod[] = ['installer', 'npm', 'winget']

/** Installs fetch a Node runtime and packages; give a slow connection room. */
const INSTALL_TIMEOUT_MS = 10 * 60_000
/** How much of an install's output the screen keeps. */
const OUTPUT_TAIL_CHARS = 8_000

export function isPiInstallMethod(value: unknown): value is PiInstallMethod {
  return typeof value === 'string' && (PI_INSTALL_METHODS as readonly string[]).includes(value)
}

/**
 * The install routes this machine can run, best first. The pi.dev installer is
 * what Pi's own docs recommend and needs nothing preinstalled (it brings its
 * own Node), so it leads; npm and winget follow when their tools are present.
 */
export function piInstallOptions(deps: ResolutionDeps, pathEnv: string): PiInstallOption[] {
  const has = (name: string): boolean => whichInPath(deps, name, pathEnv) !== null
  if (deps.isWindows) {
    return [
      { method: 'installer', command: PI_INSTALLER_COMMAND_WINDOWS, available: has('powershell') },
      { method: 'npm', command: PI_NPM_INSTALL_COMMAND, available: has('npm') },
      { method: 'winget', command: PI_WINGET_INSTALL_COMMAND, available: has('winget') },
    ]
  }
  return [
    { method: 'installer', command: PI_INSTALLER_COMMAND_POSIX, available: has('curl') },
    { method: 'npm', command: PI_NPM_INSTALL_COMMAND, available: has('npm') },
  ]
}

/**
 * Tidy the raw trace for display. Only the file that was picked counts as
 * found: a folder or a stray file that exists but is not used would read as a
 * match. A PATH search probes every extension in every folder, which says
 * nothing a list of the folders does not, so that step is shown as folders.
 */
export function summarizeSearchSteps(
  steps: PiSearchStep[],
  isWindows: boolean,
  picked: string | null
): PiSearchStep[] {
  const dirname = isWindows ? win32.dirname : posix.dirname
  return steps.map((step, index) => {
    // The search stops at its match, so a successful search ends on that step.
    const matched = picked !== null && index === steps.length - 1
    const isPicked = (path: string): boolean => matched && path === picked
    if (step.id !== 'path') {
      return { ...step, matched, checked: step.checked.map((c) => ({ path: c.path, found: isPicked(c.path) })) }
    }
    const folders = new Map<string, boolean>()
    for (const check of step.checked) {
      const folder = dirname(check.path)
      folders.set(folder, (folders.get(folder) ?? false) || isPicked(check.path))
    }
    return { ...step, matched, checked: [...folders].map(([path, found]) => ({ path, found })) }
  })
}

/** Search again from scratch and describe the result for the setup screen. */
export function buildPiSetupReport(): PiSetupReport {
  refreshPiResolution()
  const cli = getPiCli()
  const { resolution, trace } = tracePiSearch()
  return {
    found: cli.found,
    failure: cli.failureReason?.kind ?? null,
    platform: process.platform,
    script: resolution.script,
    source: resolution.source,
    rejectedOverride: resolution.rejectedOverride,
    node: cli.useNode ? cli.node : '',
    steps: summarizeSearchSteps(trace.steps, RESOLUTION_DEPS.isWindows, resolution.found ? resolution.script : null),
    installOptions: piInstallOptions(RESOLUTION_DEPS, resolution.pathEnv),
  }
}

/** Keep the last `max` characters, cut at a line start when one is close. */
export function outputTail(text: string, max = OUTPUT_TAIL_CHARS): string {
  if (text.length <= max) return text
  const cut = text.slice(-max)
  const newline = cut.indexOf('\n')
  return newline >= 0 && newline < 200 ? cut.slice(newline + 1) : cut
}

/**
 * Run one of the offered install commands and report how it went. The command
 * is chosen from the fixed list above, never built from renderer input.
 */
export function runPiInstall(
  method: PiInstallMethod,
  onOutput: (chunk: string) => void
): Promise<PiInstallResult> {
  const pathEnv = process.env.PATH ?? ''
  const option = piInstallOptions(RESOLUTION_DEPS, pathEnv).find((o) => o.method === method)
  if (!option) return Promise.reject(new Error(`unknown install method: ${method}`))

  return new Promise((resolve) => {
    let output = ''
    const append = (chunk: Buffer | string): void => {
      const text = chunk.toString()
      output = outputTail(output + text)
      onOutput(text)
    }
    const finish = (exitCode: number | null, error?: Error): void => {
      if (error) append(`\n${error.message}\n`)
      resolve({ ok: exitCode === 0, exitCode, output, report: buildPiSetupReport() })
    }
    const child = spawn(option.command, {
      shell: true,
      windowsHide: true,
      timeout: INSTALL_TIMEOUT_MS,
      env: childProcessEnv(true, { ...process.env, PATH: pathEnv }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', (err) => finish(null, err))
    child.on('close', (code) => finish(code))
  })
}
