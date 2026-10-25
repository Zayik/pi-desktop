import { basename, join, posix as posixPath } from 'path'
import { buildNpmPrefixCommand, escapeCmdSpawn } from './cmd-escape'
import { i18n, type Translate } from '../shared/i18n'
import type { PiResolutionSource, PiSearchStep, PiSearchStepId } from '../shared/ipc-contracts'

export type { PiSearchCheck, PiSearchStep, PiSearchStepId } from '../shared/ipc-contracts'

/**
 * Locating the Pi CLI is the single most failure-prone step at startup, and the
 * failures are all environmental rather than logical: a GUI app started from
 * Finder or a desktop launcher inherits a minimal PATH, version managers hide
 * global installs under per-version directories, and Windows ships shims that
 * cannot be spawned without a shell.
 *
 * Everything here is pure with respect to injected `ResolutionDeps`, so the
 * whole search order is unit-testable without touching the real filesystem.
 */

export const PI_PACKAGE = '@earendil-works/pi-coding-agent'
export const PI_CLI_REL = join('node_modules', PI_PACKAGE, 'dist', 'cli.js')
export const OMP_PACKAGE = '@oh-my-pi/pi-coding-agent'
/** The commands shown in `errors.pi.installHint`, as `{{npmCommand}}`/`{{bunCommand}}` placeholders. */
export const PI_NPM_INSTALL_COMMAND = `npm install -g ${PI_PACKAGE}`
export const OMP_BUN_INSTALL_COMMAND = `bun install -g ${OMP_PACKAGE}`
/** Environment variable naming a Pi executable, file or install folder. */
export const PI_PATH_ENV = 'PI_DESKTOP_PI_PATH'
/** Set by the pi.dev installer's launcher; Pi reads it to know it is a managed install. */
export const PI_MANAGED_ROOT_ENV = 'PI_MANAGED_INSTALL_ROOT'
export const PI_INSTALLER_COMMAND_WINDOWS = 'powershell -c "irm https://pi.dev/install.ps1 | iex"'
export const PI_INSTALLER_COMMAND_POSIX = 'curl -fsSL https://pi.dev/install.sh | sh'
export const PI_WINGET_ID = 'EarendilWorks.pi'
export const PI_FALLBACK_BINARY_POSIX = 'pi'
export const PI_FALLBACK_BINARY_WINDOWS = 'pi.cmd'
export const OMP_FALLBACK_BINARY_POSIX = 'omp'
export const OMP_FALLBACK_BINARY_WINDOWS = 'omp.exe'
export const DEFAULT_LOGIN_SHELL = '/bin/bash'
export const FISH_SHELL_NAME = 'fish'
/** Sentinels bracket the PATH so rc-file chatter can be discarded. */
export const SHELL_PATH_START = '__PI_PATH_START__'
export const SHELL_PATH_END = '__PI_PATH_END__'
/** A login shell sources the user's whole rc chain; give it room but bound it. */
export const SHELL_PROBE_TIMEOUT_MS = 5_000
export const NPM_PREFIX_TIMEOUT_MS = 5_000
/** `--version` prints a cached string and exits; it never waits on the network. */
const IDENTITY_PROBE_TIMEOUT_MS = 5_000
const VERSION_FLAG = '--version'
/** Any dotted number in the output: both `0.4.1` and `omp 0.4.1` qualify. */
const VERSION_OUTPUT_PATTERN = /\d+\.\d+/
const WINDOWS_PATH_DELIMITER = ';'
const POSIX_PATH_DELIMITER = ':'
const DEFAULT_WINDOWS_PATHEXT = '.COM;.EXE;.BAT;.CMD'
/**
 * The Windows PATH entries that name one folder whatever the current folder
 * is: a drive-letter path (`C:\`) or a UNC path (`\\server\share`). `C:tools`
 * depends on the current folder of drive C, and `\tools` on the current drive.
 */
const WINDOWS_FIXED_PATH_PATTERN = /^(?:[a-z]:[\\/]|[\\/]{2})/i
const JS_EXTENSION = '.js'
const SHELL_SCRIPT_PATTERN = /\.(cmd|bat|ps1)$/i
const VERSION_NUMBER_PATTERN = /\d+/g
const OMP_BINARY_PATTERN = /(?:^|[\\/])omp(?:\.(?:cmd|exe|bat|ps1))?$/i
const MANAGED_MARKER = 'managed-install.json'
const MANAGED_CURRENT_VERSION = 'current-version'
const MANAGED_RELEASES = 'releases'
// Same shape Pi accepts for a managed release directory name.
const MANAGED_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
// `set "PI_MANAGED_INSTALL_ROOT=..."` in a .cmd, `export PI_MANAGED_INSTALL_ROOT="..."` in sh,
// `$env:PI_MANAGED_INSTALL_ROOT = '...'` in a .ps1.
const MANAGED_ROOT_ASSIGNMENT = /PI_MANAGED_INSTALL_ROOT\s*=\s*["']?([^"'\r\n]+?)["']?\s*$/m
const WINDOWS_ENV_REF = /%([A-Za-z_][A-Za-z0-9_()]*)%/g
const POSIX_ENV_REF = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g
const REGISTRY_PATH_LINE = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/im
const REGISTRY_TIMEOUT_MS = 5_000
const REGISTRY_PATH_KEYS = [
  'HKCU\\Environment',
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
]
const WINGET_PACKAGE_PREFIX = `${PI_WINGET_ID}_`

export interface CaptureOptions {
  shell: boolean
  timeoutMs: number
  /** PATH to hand the child, so probes see version-manager shims too. */
  pathEnv: string
}

/** Filesystem and process access, injected so the search order can be tested. */
export interface ResolutionDeps {
  isWindows: boolean
  env: NodeJS.ProcessEnv
  exists(path: string): boolean
  isDirectory(path: string): boolean
  /** Immediate child names of a directory; empty when unreadable. */
  listDir(path: string): string[]
  /** Run a command and return trimmed stdout, or null if it failed. */
  capture(command: string, args: string[], options: CaptureOptions): string | null
  /** A small text file's contents, or null when unreadable. Optional for tests. */
  readText?(path: string): string | null
}

export type PiEngine = 'auto' | 'pi' | 'omp'

export interface PiResolution {
  /** Path to spawn: either a cli.js (with node) or an executable/shim. */
  script: string
  /** True when `script` is a .js entry point that needs a Node binary. */
  useNode: boolean
  /** True when `script` is a Windows shim that spawn cannot invoke directly. */
  needsShell: boolean
  source: PiResolutionSource
  /** False when nothing was found and `script` is only a hopeful fallback. */
  found: boolean
  /** A configured override that pointed at nothing; null when unset or valid. */
  rejectedOverride: string | null
  /** PATH with the login shell's entries merged in, for spawned children. */
  pathEnv: string
  /** Root of a pi.dev managed install, which Pi needs in its environment. */
  managedRoot?: string
}

/**
 * Records every path the resolver looks at, by step, so the setup screen can
 * show exactly where it searched instead of a hand-written list that drifts.
 */
export class PiSearchTrace {
  readonly steps: PiSearchStep[] = []

  begin(id: PiSearchStepId): PiSearchStep {
    const step: PiSearchStep = { id, checked: [] }
    this.steps.push(step)
    return step
  }

  record(path: string, found: boolean): void {
    const step = this.steps.at(-1)
    if (!step || !path) return
    const existing = step.checked.find((check) => check.path === path)
    if (existing) existing.found ||= found
    else step.checked.push({ path, found })
  }

  /** Wrap deps so every filesystem probe lands in the current step. */
  wrap(deps: ResolutionDeps): ResolutionDeps {
    return {
      ...deps,
      exists: (path) => {
        const found = deps.exists(path)
        this.record(path, found)
        return found
      },
      isDirectory: (path) => {
        const found = deps.isDirectory(path)
        if (found) this.record(path, true)
        return found
      },
    }
  }
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? env.USERPROFILE ?? ''
}

function pathDelimiterFor(isWindows: boolean): string {
  return isWindows ? WINDOWS_PATH_DELIMITER : POSIX_PATH_DELIMITER
}

/**
 * True for a Windows `.cmd`/`.bat`/`.ps1` shim. spawn() cannot start one
 * directly (Node refuses since CVE-2024-27980), so it goes through cmd.exe
 * with shell: true.
 */
export function isCmdShim(isWindows: boolean, script: string): boolean {
  return isWindows && SHELL_SCRIPT_PATTERN.test(script)
}

/**
 * Turn the raw `piExecutablePath` setting into a usable path, or null when it
 * carries no information. Blank values and the bare binary name both mean
 * "auto-detect"; quotes and a leading `~` are normalized away because both are
 * common in hand-entered or pasted paths.
 */
export function normalizeOverride(raw: string | undefined | null, home: string): string | null {
  if (!raw) return null
  let value = raw.trim()
  if (!value) return null
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
  if (quoted && value.length >= 2) value = value.slice(1, -1).trim()
  if (!value) return null

  const lower = value.toLowerCase()
  if (lower === PI_FALLBACK_BINARY_POSIX || lower === PI_FALLBACK_BINARY_WINDOWS) return null
  // `omp` is an intentional engine selector, not a filesystem path. Keep it
  // for resolvePiBinary() so the Settings field can switch runtimes without
  // requiring the user to find the installed executable.
  if (lower === OMP_FALLBACK_BINARY_POSIX || lower === OMP_FALLBACK_BINARY_WINDOWS) return value

  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(home, value.slice(2))
  }
  return value
}

/** Extract the PATH the login shell printed between our sentinels. */
export function parseShellPath(stdout: string): string | null {
  const start = stdout.indexOf(SHELL_PATH_START)
  if (start < 0) return null
  const from = start + SHELL_PATH_START.length
  const end = stdout.indexOf(SHELL_PATH_END, from)
  if (end < 0) return null
  const value = stdout.slice(from, end).trim()
  return value || null
}

/**
 * Args that make a login shell print its PATH. Interactive (`-i`) *and* login
 * (`-l`) because nvm/fnm/asdf initialization lives in `.bashrc`/`.zshrc` for
 * some users and in the profile files for others.
 */
export function buildLoginShellArgs(shellPath: string): string[] {
  // fish stores PATH as a list, so `$PATH` interpolates space-separated.
  const pathExpression =
    basename(shellPath) === FISH_SHELL_NAME ? '(string join : $PATH)' : '"$PATH"'
  return [
    '-i',
    '-l',
    '-c',
    `printf '%s%s%s' '${SHELL_PATH_START}' ${pathExpression} '${SHELL_PATH_END}'`,
  ]
}

/**
 * Ask the user's login shell for its PATH. Returns null on Windows (where the
 * GUI already inherits the full user PATH) or when the probe yields nothing.
 */
export function loginShellPath(deps: ResolutionDeps): string | null {
  if (deps.isWindows) return null
  const shell = deps.env.SHELL ?? DEFAULT_LOGIN_SHELL
  const stdout = deps.capture(shell, buildLoginShellArgs(shell), {
    shell: false,
    timeoutMs: SHELL_PROBE_TIMEOUT_MS,
    pathEnv: deps.env.PATH ?? '',
  })
  if (!stdout) return null
  return parseShellPath(stdout)
}

/** Replace `%NAME%` (Windows) or `$NAME` (POSIX) references with their values. */
export function expandEnvRefs(value: string, env: NodeJS.ProcessEnv, isWindows: boolean): string {
  const lookup = (name: string): string | undefined => {
    if (!isWindows) return env[name]
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
    return key ? env[key] : undefined
  }
  const pattern = isWindows ? WINDOWS_ENV_REF : POSIX_ENV_REF
  return value.replace(pattern, (whole, name: string) => lookup(name) ?? whole)
}

/** The Path value from `reg query ... /v Path` output, expanded. */
export function parseRegistryPath(stdout: string, env: NodeJS.ProcessEnv): string | null {
  const match = REGISTRY_PATH_LINE.exec(stdout)
  if (!match || !match[1]) return null
  return expandEnvRefs(match[1], env, true)
}

/**
 * The user and system PATH as stored in the registry right now. A running app
 * keeps the PATH it started with, so without this an install made while the
 * app is open (npm, winget, the pi.dev installer) stays invisible until the
 * user signs out.
 */
export function windowsRegistryPath(deps: ResolutionDeps): string | null {
  if (!deps.isWindows) return null
  const parts: string[] = []
  for (const key of REGISTRY_PATH_KEYS) {
    const stdout = deps.capture('reg', ['query', key, '/v', 'Path'], {
      shell: false,
      timeoutMs: REGISTRY_TIMEOUT_MS,
      pathEnv: deps.env.PATH ?? '',
    })
    const value = stdout ? parseRegistryPath(stdout, deps.env) : null
    if (value) parts.push(value)
  }
  return parts.length > 0 ? parts.join(WINDOWS_PATH_DELIMITER) : null
}

/** Append entries from `incoming` that `current` does not already contain. */
export function mergePathEntries(current: string, incoming: string, isWindows: boolean): string {
  const delimiter = pathDelimiterFor(isWindows)
  const existing = current.split(delimiter).filter(Boolean)
  const seen = new Set(existing)
  for (const entry of incoming.split(delimiter).filter(Boolean)) {
    if (seen.has(entry)) continue
    seen.add(entry)
    existing.push(entry)
  }
  return existing.join(delimiter)
}

/** Sort comparator putting the highest version-like directory name first. */
export function compareVersionsDesc(a: string, b: string): number {
  const left = a.match(VERSION_NUMBER_PATTERN)?.map(Number) ?? []
  const right = b.match(VERSION_NUMBER_PATTERN)?.map(Number) ?? []
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0)
    if (diff !== 0) return diff
  }
  return b.localeCompare(a)
}

/** A directory whose children are node versions, plus the prefix inside one. */
interface VersionRoot {
  root: string
  /** Path segments appended to a version directory to reach its npm prefix. */
  prefixSuffix: string[]
}

function posixVersionRoots(env: NodeJS.ProcessEnv): VersionRoot[] {
  const home = homeDir(env)
  const fnmDir = env.FNM_DIR ?? ''
  const asdfDir = env.ASDF_DATA_DIR ?? join(home, '.asdf')
  const roots: VersionRoot[] = [
    { root: join(home, '.nvm', 'versions', 'node'), prefixSuffix: [] },
    { root: join(home, '.local', 'share', 'fnm', 'node-versions'), prefixSuffix: ['installation'] },
    {
      root: join(home, 'Library', 'Application Support', 'fnm', 'node-versions'),
      prefixSuffix: ['installation'],
    },
    { root: join(home, '.volta', 'tools', 'image', 'node'), prefixSuffix: [] },
    { root: join(asdfDir, 'installs', 'nodejs'), prefixSuffix: [] },
    { root: join(home, '.local', 'share', 'mise', 'installs', 'node'), prefixSuffix: [] },
    { root: join(home, '.nodenv', 'versions'), prefixSuffix: [] },
    { root: join('/usr/local/n', 'versions', 'node'), prefixSuffix: [] },
  ]
  if (fnmDir) {
    roots.push({ root: join(fnmDir, 'node-versions'), prefixSuffix: ['installation'] })
  }
  return roots
}

function windowsVersionRoots(env: NodeJS.ProcessEnv): VersionRoot[] {
  const appData = env.APPDATA ?? ''
  const localAppData = env.LOCALAPPDATA ?? ''
  const nvmHome = env.NVM_HOME ?? ''
  const roots: VersionRoot[] = []
  if (nvmHome) roots.push({ root: nvmHome, prefixSuffix: [] })
  if (appData) {
    roots.push({ root: join(appData, 'nvm'), prefixSuffix: [] })
    roots.push({ root: join(appData, 'fnm', 'node-versions'), prefixSuffix: ['installation'] })
  }
  if (localAppData) {
    roots.push({ root: join(localAppData, 'fnm', 'node-versions'), prefixSuffix: ['installation'] })
    roots.push({ root: join(localAppData, 'Volta', 'tools', 'image', 'node'), prefixSuffix: [] })
  }
  return roots
}

/**
 * Every per-version npm prefix a node version manager may have created, newest
 * version first. These are the installs a bare PATH search can never see.
 */
export function versionManagerPrefixes(deps: ResolutionDeps): string[] {
  const roots = deps.isWindows ? windowsVersionRoots(deps.env) : posixVersionRoots(deps.env)
  const prefixes: string[] = []
  const seen = new Set<string>()
  for (const { root, prefixSuffix } of roots) {
    if (!deps.exists(root)) continue
    const versions = deps
      .listDir(root)
      .filter((name) => deps.isDirectory(join(root, name)))
      .sort(compareVersionsDesc)
    for (const version of versions) {
      const prefix = join(root, version, ...prefixSuffix)
      if (seen.has(prefix)) continue
      seen.add(prefix)
      prefixes.push(prefix)
    }
  }
  return prefixes
}

/**
 * Look for the Pi cli.js under a directory that behaves like an npm prefix.
 * Covers the three global-install layouts: Windows (`<prefix>/node_modules`),
 * POSIX (`<prefix>/lib/node_modules`), and shim-adjacent installs where the
 * shim sits one level below the prefix.
 */
export function findCliJsNear(deps: ResolutionDeps, dir: string): string | null {
  const candidates = [
    join(dir, PI_CLI_REL),
    join(dir, 'lib', PI_CLI_REL),
    join(dir, '..', PI_CLI_REL),
    join(dir, '..', 'lib', PI_CLI_REL),
  ]
  for (const candidate of candidates) {
    if (deps.exists(candidate)) return candidate
  }
  return null
}

/** Executable shim names an npm prefix may expose, per platform. */
function shimCandidates(deps: ResolutionDeps, prefix: string): string[] {
  return deps.isWindows
    ? [join(prefix, 'pi.cmd'), join(prefix, 'pi.ps1'), join(prefix, 'pi.exe')]
    : [join(prefix, 'bin', 'pi'), join(prefix, 'pi')]
}

function usableFile(deps: ResolutionDeps, path: string): boolean {
  return deps.exists(path) && !deps.isDirectory(path)
}

/**
 * Resolve a prefix to a spawnable Pi path, preferring its JS entry point.
 */
function resolveFromPrefix(deps: ResolutionDeps, prefix: string): string | null {
  const cliJs = findCliJsNear(deps, prefix)
  if (cliJs) return cliJs
  for (const shim of shimCandidates(deps, prefix)) {
    if (usableFile(deps, shim)) return shim
  }
  return null
}
/**
 * Resolve a configured OMP executable or install directory.
 */
function resolveOmpOverride(deps: ResolutionDeps, overridePath: string): string | null {
  if (deps.isDirectory(overridePath)) {
    for (const shim of ompShimCandidates(deps, overridePath)) {
      if (usableFile(deps, shim)) return shim
    }
    return null
  }
  return usableFile(deps, overridePath) ? overridePath : null
}

/** True for a PATH entry that does not depend on the current folder. */
function isFixedPathEntry(dir: string, isWindows: boolean): boolean {
  return isWindows ? WINDOWS_FIXED_PATH_PATTERN.test(dir) : posixPath.isAbsolute(dir)
}

// `"C:\Program Files\nodejs"`: Windows (cmd.exe and libuv) reads a PATH entry
// without the quotes around it.
const QUOTED_PATH_ENTRY = /^"(.*)"$/

function unquotedPathEntry(dir: string, isWindows: boolean): string {
  return isWindows ? dir.replace(QUOTED_PATH_ENTRY, '$1') : dir
}

/**
 * Search PATH for an executable, honoring PATHEXT on Windows. Relative
 * entries are skipped: the result is spawned with the workspace as the
 * working directory, and a relative entry would resolve against it.
 */
export function whichInPath(deps: ResolutionDeps, name: string, pathEnv: string): string | null {
  const dirs = pathEnv
    .split(pathDelimiterFor(deps.isWindows))
    .map((dir) => unquotedPathEntry(dir, deps.isWindows))
    .filter((dir) => isFixedPathEntry(dir, deps.isWindows))
  const pathJoin = deps.isWindows ? join : posixPath.join
  const extensions = deps.isWindows
    ? (deps.env.PATHEXT ?? DEFAULT_WINDOWS_PATHEXT).split(';').map((e) => e.toLowerCase())
    : ['']
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = pathJoin(dir, name + extension)
      if (usableFile(deps, candidate)) return candidate
      // Tests inject a platform independent path separator while running on
      // the host OS; accept that spelling as a fallback in the seam.
      if (!deps.isWindows) {
        const hostCandidate = join(dir, name + extension)
        if (hostCandidate !== candidate && usableFile(deps, hostCandidate)) return hostCandidate
      }
    }
  }
  return null
}

/** Ask npm where its global prefix is; null when npm is unreachable. */
function npmGlobalPrefix(deps: ResolutionDeps, pathEnv: string): string | null {
  const command = buildNpmPrefixCommand(deps.isWindows)
  const stdout = deps.capture(command.file, command.args, {
    shell: deps.isWindows,
    timeoutMs: NPM_PREFIX_TIMEOUT_MS,
    pathEnv,
  })
  if (!stdout) return null
  const prefix = stdout.trim()
  if (!prefix || !deps.exists(prefix)) return null
  return prefix
}

/** Hardcoded install locations, used only after every dynamic probe fails. */
function ompShimCandidates(deps: ResolutionDeps, prefix: string): string[] {
  return deps.isWindows
    ? [join(prefix, 'omp.cmd'), join(prefix, 'omp.exe'), join(prefix, 'omp.ps1')]
    : [join(prefix, 'bin', 'omp'), join(prefix, 'omp')]
}

function ompLocations(deps: ResolutionDeps): string[] {
  const { env } = deps
  const home = homeDir(env)
  if (deps.isWindows) {
    const appData = env.APPDATA ?? ''
    const localAppData = env.LOCALAPPDATA ?? ''
    const userProfile = env.USERPROFILE ?? home
    return [
      appData ? join(appData, 'npm', OMP_FALLBACK_BINARY_WINDOWS) : '',
      localAppData ? join(localAppData, 'npm', OMP_FALLBACK_BINARY_WINDOWS) : '',
      localAppData ? join(localAppData, 'omp', OMP_FALLBACK_BINARY_WINDOWS) : '',
      join(userProfile, '.bun', 'bin', OMP_FALLBACK_BINARY_WINDOWS),
    ].filter(Boolean)
  }
  return [
    join(home, '.local', 'bin', OMP_FALLBACK_BINARY_POSIX),
    join(home, '.bun', 'bin', OMP_FALLBACK_BINARY_POSIX),
    join(home, '.npm-global', 'bin', OMP_FALLBACK_BINARY_POSIX),
    join(home, '.npm-packages', 'bin', OMP_FALLBACK_BINARY_POSIX),
    '/opt/homebrew/bin/omp',
    '/usr/local/bin/omp',
    '/usr/bin/omp',
  ]
}

/**
 * Every OMP candidate, most authoritative first. A generator rather than an
 * array so the `npm prefix -g` subprocess is only spawned when the cheaper
 * PATH and common-location lookups came up empty.
 */
function* ompCandidates(deps: ResolutionDeps, pathEnv: string): Generator<string> {
  const onPath = whichInPath(deps, OMP_FALLBACK_BINARY_POSIX, pathEnv)
  if (onPath) yield onPath
  for (const candidate of ompLocations(deps)) {
    if (usableFile(deps, candidate)) yield candidate
  }
  const prefix = npmGlobalPrefix(deps, pathEnv)
  if (prefix) {
    for (const candidate of ompShimCandidates(deps, prefix)) {
      if (usableFile(deps, candidate)) yield candidate
    }
  }
}

/** The first OMP candidate, taken on trust because the engine is explicit. */
function resolveOmpBinary(deps: ResolutionDeps, pathEnv: string): string | null {
  for (const candidate of ompCandidates(deps, pathEnv)) return candidate
  return null
}

/**
 * Ask a candidate to identify itself. `deps.capture` yields stdout only for a
 * clean exit, so an unreadable file, a non-executable one and a script that
 * errors out all answer null.
 */
function respondsToVersion(deps: ResolutionDeps, script: string, pathEnv: string): boolean {
  // A .cmd/.ps1 shim only starts through cmd.exe, which quotes nothing itself:
  // escape both tokens exactly as the real spawn path does.
  const viaCmd = isCmdShim(deps.isWindows, script)
  const command = escapeCmdSpawn(viaCmd, script, [VERSION_FLAG])
  const stdout = deps.capture(command.file, command.args, {
    shell: viaCmd,
    timeoutMs: IDENTITY_PROBE_TIMEOUT_MS,
    pathEnv,
  })
  return stdout !== null && VERSION_OUTPUT_PATTERN.test(stdout)
}

/**
 * The first OMP candidate that behaves like a CLI. `omp` is a short, common
 * name, and auto-detection reaches this point only when the user asked for
 * nothing in particular — accepting a same-named data file or unrelated script
 * would mark the resolution found, replacing the actionable "install Pi with…"
 * message with a spawn timeout minutes later.
 */
function resolveVerifiedOmpBinary(deps: ResolutionDeps, pathEnv: string): string | null {
  for (const candidate of ompCandidates(deps, pathEnv)) {
    if (respondsToVersion(deps, candidate, pathEnv)) return candidate
  }
  return null
}

export function isOmpExecutable(script: string): boolean {
  return OMP_BINARY_PATTERN.test(script)
}

/**
 * Where the pi.dev installer may have put a managed install when its launcher
 * is not on PATH. The installer's own default is not published, so these are
 * the conventional per-user app folders; PI_MANAGED_INSTALL_ROOT wins when set.
 */
export function managedRootCandidates(deps: ResolutionDeps): string[] {
  const { env } = deps
  const home = homeDir(env)
  const roots: string[] = []
  const configured = env[PI_MANAGED_ROOT_ENV]?.trim()
  if (configured) roots.push(configured)
  if (deps.isWindows) {
    const localAppData = env.LOCALAPPDATA ?? ''
    if (localAppData) roots.push(join(localAppData, 'pi'), join(localAppData, 'Programs', 'pi'))
    if (home) roots.push(join(home, '.pi', 'install'))
  } else if (home) {
    roots.push(
      join(home, '.local', 'share', 'pi'),
      join(home, '.pi', 'install'),
      join(home, 'Library', 'Application Support', 'pi')
    )
  }
  return roots
}

/**
 * The cli.js of the active release in a managed install, or null when `root`
 * is not one. Pi itself trusts only a root holding its marker file, so do we.
 */
export function resolveManagedRelease(deps: ResolutionDeps, root: string): string | null {
  if (!deps.exists(join(root, MANAGED_MARKER))) return null
  const releases = join(root, MANAGED_RELEASES)
  const current = deps.readText?.(join(root, MANAGED_CURRENT_VERSION))?.trim() ?? ''
  const versions = MANAGED_VERSION_PATTERN.test(current) ? [current] : []
  versions.push(
    ...deps
      .listDir(releases)
      .filter((name) => name !== current && MANAGED_VERSION_PATTERN.test(name))
      .sort(compareVersionsDesc)
  )
  for (const version of versions) {
    const cliJs = join(releases, version, PI_CLI_REL)
    if (deps.exists(cliJs)) return cliJs
  }
  return null
}

/**
 * Find the managed-install root behind a launcher on PATH: next to it, one
 * folder up, or named in the launcher's own text (it has to export
 * PI_MANAGED_INSTALL_ROOT for Pi to recognise the install).
 */
export function managedRootFromLauncher(deps: ResolutionDeps, launcher: string): string | null {
  const dir = join(launcher, '..')
  for (const candidate of [dir, join(dir, '..')]) {
    if (deps.exists(join(candidate, MANAGED_MARKER))) return candidate
  }
  const text = deps.readText?.(launcher)
  const match = text ? MANAGED_ROOT_ASSIGNMENT.exec(text) : null
  if (!match) return null
  let root = match[1].trim()
  // %~dp0 is the launcher's own folder in a .cmd file.
  const relative = /^%~dp0\\?/i.exec(root)
  root = relative ? join(dir, root.slice(relative[0].length)) : expandEnvRefs(root, deps.env, deps.isWindows)
  return root && deps.exists(join(root, MANAGED_MARKER)) ? root : null
}

/** Install folders winget may have unpacked the pi package into. */
function wingetLocations(deps: ResolutionDeps, localAppData: string, programFiles: string): string[] {
  const paths: string[] = []
  if (localAppData) paths.push(join(localAppData, 'Microsoft', 'WinGet', 'Links', 'pi.exe'))
  paths.push(join(programFiles, 'WinGet', 'Links', 'pi.exe'))
  if (localAppData) {
    const packages = join(localAppData, 'Microsoft', 'WinGet', 'Packages')
    for (const name of deps.listDir(packages)) {
      if (!name.startsWith(WINGET_PACKAGE_PREFIX)) continue
      const dir = join(packages, name)
      paths.push(join(dir, 'pi.exe'), join(dir, PI_CLI_REL), join(dir, 'pi.cmd'))
    }
  }
  return paths
}

function commonLocations(deps: ResolutionDeps): string[] {
  const { env } = deps
  const home = homeDir(env)
  if (deps.isWindows) {
    const appData = env.APPDATA ?? ''
    const localAppData = env.LOCALAPPDATA ?? ''
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
    const scoop = env.SCOOP ?? (home ? join(home, 'scoop') : '')
    const paths: string[] = []
    if (appData) paths.push(join(appData, 'npm', PI_CLI_REL), join(appData, 'npm', 'pi.cmd'))
    if (localAppData) {
      paths.push(join(localAppData, 'npm', PI_CLI_REL), join(localAppData, 'npm', 'pi.cmd'))
    }
    paths.push(join(programFiles, 'nodejs', PI_CLI_REL))
    paths.push(...wingetLocations(deps, localAppData, programFiles))
    if (scoop) {
      paths.push(
        join(scoop, 'persist', 'nodejs', 'bin', PI_CLI_REL),
        join(scoop, 'persist', 'nodejs-lts', 'bin', PI_CLI_REL),
        join(scoop, 'shims', 'pi.exe'),
        join(scoop, 'shims', 'pi.cmd')
      )
    }
    if (home) {
      paths.push(
        join(home, '.bun', 'install', 'global', PI_CLI_REL),
        join(home, '.bun', 'bin', 'pi.exe')
      )
    }
    return paths
  }
  return [
    join(home, '.bun', 'install', 'global', PI_CLI_REL),
    join(home, '.bun', 'bin', 'pi'),
    join(home, '.npm-global', PI_CLI_REL),
    join(home, '.npm-packages', PI_CLI_REL),
    join('/opt/homebrew/lib', PI_CLI_REL),
    join('/usr/local/lib', PI_CLI_REL),
    join('/usr/lib', PI_CLI_REL),
    join(home, '.npm-global', 'bin', 'pi'),
    '/opt/homebrew/bin/pi',
    '/usr/local/bin/pi',
    '/usr/bin/pi',
    join(home, '.local/bin/pi'),
  ]
}

function finalize(
  deps: ResolutionDeps,
  script: string,
  source: PiResolutionSource,
  found: boolean,
  rejectedOverride: string | null,
  pathEnv: string,
  managedRoot?: string
): PiResolution {
  const useNode = script.toLowerCase().endsWith(JS_EXTENSION)
  return {
    script,
    useNode,
    needsShell: !useNode && isCmdShim(deps.isWindows, script),
    source,
    found,
    rejectedOverride,
    pathEnv,
    ...(managedRoot ? { managedRoot } : {}),
  }
}

/** A configured file or install folder, resolved; null when it holds no Pi. */
function resolveConfiguredPath(deps: ResolutionDeps, configured: string): { script: string; managedRoot?: string } | null {
  if (deps.isDirectory(configured)) {
    const managed = resolveManagedRelease(deps, configured)
    if (managed) return { script: managed, managedRoot: configured }
    const fromDir = resolveFromPrefix(deps, configured)
    return fromDir ? { script: fromDir } : null
  }
  return deps.exists(configured) ? { script: configured } : null
}

/**
 * Find the Pi CLI. Order, most authoritative first:
 *
 *   0. Merge the login shell's PATH into ours (POSIX), or the PATH currently
 *      stored in the registry (Windows), so every later probe sees what a new
 *      terminal would see. A GUI process otherwise keeps a stale or minimal
 *      PATH: no version-manager shims, and nothing installed since it started.
 *   1. The path configured in Settings, if it exists. A directory is accepted
 *      and searched; a stale value is reported rather than silently obeyed.
 *   2. The PI_DESKTOP_PI_PATH environment variable, same rules.
 *   3. npm's own global prefix.
 *   4. A PATH search. A pi.dev launcher found there is followed to its
 *      managed install.
 *   5. A pi.dev managed install that is not on PATH.
 *   6. Per-version prefixes created by node version managers.
 *   7. Hardcoded common install locations (npm, winget, Scoop, Bun, Homebrew).
 *   8. OMP fallback when Pi is not installed, accepted only after the
 *      candidate answers a `--version` probe.
 *   9. The bare binary name, flagged as not found.
 *
 * Pass a `trace` to record every path looked at, step by step.
 */
export function resolvePiBinary(
  rawDeps: ResolutionDeps,
  overridePath: string | null,
  engine: PiEngine = 'auto',
  trace?: PiSearchTrace
): PiResolution {
  const deps = trace ? trace.wrap(rawDeps) : rawDeps
  const basePath = deps.env.PATH ?? ''
  const shellPath = deps.isWindows ? windowsRegistryPath(deps) : loginShellPath(deps)
  const pathEnv = shellPath ? mergePathEntries(basePath, shellPath, deps.isWindows) : basePath
  let rejectedOverride: string | null = null

  if (engine === 'omp') {
    if (overridePath && overridePath.toLowerCase() !== OMP_FALLBACK_BINARY_POSIX && overridePath.toLowerCase() !== OMP_FALLBACK_BINARY_WINDOWS) {
      const override = resolveOmpOverride(deps, overridePath)
      return override
        ? finalize(deps, override, 'override', true, null, pathEnv)
        : finalize(
            deps,
            deps.isWindows ? OMP_FALLBACK_BINARY_WINDOWS : OMP_FALLBACK_BINARY_POSIX,
            'fallback',
            false,
            overridePath,
            pathEnv
          )
    }
    const omp = resolveOmpBinary(deps, pathEnv)
    return omp
      ? finalize(deps, omp, 'omp', true, null, pathEnv)
      : finalize(
          deps,
          deps.isWindows ? OMP_FALLBACK_BINARY_WINDOWS : OMP_FALLBACK_BINARY_POSIX,
          'fallback',
          false,
          null,
          pathEnv
        )
  }
  if (overridePath && (overridePath.toLowerCase() === OMP_FALLBACK_BINARY_POSIX || overridePath.toLowerCase() === OMP_FALLBACK_BINARY_WINDOWS)) {
    const omp = resolveOmpBinary(deps, pathEnv)
    if (omp) return finalize(deps, omp, 'override', true, null, pathEnv)
    return finalize(
      deps,
      deps.isWindows ? OMP_FALLBACK_BINARY_WINDOWS : OMP_FALLBACK_BINARY_POSIX,
      'fallback',
      false,
      overridePath,
      pathEnv
    )
  }
  trace?.begin('settings')
  if (overridePath) {
    const configured = resolveConfiguredPath(deps, overridePath)
    if (configured) {
      return finalize(deps, configured.script, 'override', true, null, pathEnv, configured.managedRoot)
    }
    rejectedOverride = overridePath
  }

  trace?.begin('env')
  const envPath = normalizeOverride(deps.env[PI_PATH_ENV], homeDir(deps.env))
  if (envPath) {
    const configured = resolveConfiguredPath(deps, envPath)
    if (configured) {
      return finalize(deps, configured.script, 'env', true, rejectedOverride, pathEnv, configured.managedRoot)
    }
  }

  const npmStep = trace?.begin('npm-prefix')
  const prefix = npmGlobalPrefix(deps, pathEnv)
  if (npmStep) npmStep.npmPrefix = prefix
  if (prefix) {
    const fromPrefix = resolveFromPrefix(deps, prefix)
    if (fromPrefix) return finalize(deps, fromPrefix, 'npm-prefix', true, rejectedOverride, pathEnv)
  }

  trace?.begin('path')
  const onPath = whichInPath(deps, PI_FALLBACK_BINARY_POSIX, pathEnv)
  if (onPath) {
    const managedRoot = managedRootFromLauncher(deps, onPath)
    const managed = managedRoot ? resolveManagedRelease(deps, managedRoot) : null
    if (managedRoot && managed) {
      return finalize(deps, managed, 'managed-install', true, rejectedOverride, pathEnv, managedRoot)
    }
    // A .cmd/.ps1 shim is spawnable only through a shell, which breaks the
    // JSONL stdio piping RPC mode needs. Prefer the cli.js it wraps.
    if (SHELL_SCRIPT_PATTERN.test(onPath)) {
      const cliJs = findCliJsNear(deps, join(onPath, '..'))
      if (cliJs) return finalize(deps, cliJs, 'path', true, rejectedOverride, pathEnv)
    }
    return finalize(deps, onPath, 'path', true, rejectedOverride, pathEnv)
  }

  trace?.begin('managed-install')
  for (const root of managedRootCandidates(deps)) {
    const managed = resolveManagedRelease(deps, root)
    if (managed) return finalize(deps, managed, 'managed-install', true, rejectedOverride, pathEnv, root)
  }

  trace?.begin('version-manager')
  for (const versionPrefix of versionManagerPrefixes(deps)) {
    const fromVersion = resolveFromPrefix(deps, versionPrefix)
    if (fromVersion) {
      return finalize(deps, fromVersion, 'version-manager', true, rejectedOverride, pathEnv)
    }
  }

  trace?.begin('common-location')
  for (const candidate of commonLocations(deps)) {
    if (deps.exists(candidate)) {
      return finalize(deps, candidate, 'common-location', true, rejectedOverride, pathEnv)
    }
  }

  // Keep the historical Pi-first preference, but make an OMP-only machine
  // work without forcing the user to discover the Agent Executable field.
  // This is the one branch nobody asked for, so it is also the one that has to
  // prove the binary is real before claiming the search succeeded.
  if (engine === 'auto') {
    trace?.begin('omp')
    const omp = resolveVerifiedOmpBinary(deps, pathEnv)
    if (omp) return finalize(deps, omp, 'omp', true, rejectedOverride, pathEnv)
  }

  const fallback = deps.isWindows ? PI_FALLBACK_BINARY_WINDOWS : PI_FALLBACK_BINARY_POSIX
  return finalize(deps, fallback, 'fallback', false, rejectedOverride, pathEnv)
}


/**
 * Explain a failed resolution. A stale configured path is the headline when
 * one exists, because "Pi is not installed" is actively misleading to someone
 * who did point the app at their install. `t` defaults to the interface
 * language.
 */
export function describePiResolutionFailure(resolution: PiResolution, t: Translate = i18n.t): string {
  const settingsHint = t('errors.pi.settingsHint')
  const installHint = t('errors.pi.installHint', {
    npmCommand: PI_NPM_INSTALL_COMMAND,
    bunCommand: OMP_BUN_INSTALL_COMMAND,
  })
  if (resolution.rejectedOverride) {
    return t('errors.pi.configuredPathMissing', {
      settingsHint,
      path: resolution.rejectedOverride,
      installHint,
    })
  }
  return t('errors.pi.notFound', { installHint, settingsHint })
}

/**
 * Why a resolved Pi invocation cannot start. Kept as data, not text, so each
 * sink renders it in its own language: the interface language for the UI,
 * English for the log and the diagnostics report.
 */
export type PiStartFailure =
  | { kind: 'pi-not-found'; resolution: PiResolution }
  | { kind: 'node-not-found'; node: string }

/** Render a start failure with `t` (interface text) or `tEnglish` (log, report). */
export function describePiStartFailure(failure: PiStartFailure, t: Translate): string {
  return failure.kind === 'pi-not-found'
    ? describePiResolutionFailure(failure.resolution, t)
    : t('errors.pi.nodeNotFound', { node: failure.node })
}
