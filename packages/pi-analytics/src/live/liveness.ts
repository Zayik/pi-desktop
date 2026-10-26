/**
 * Whether the Pi process that wrote a snapshot is still running. A process id
 * alone is not enough: once a process ends, the system can give its id to a
 * new one. So the first time a process is seen, its start time is checked
 * against the one the recorder wrote; after that the id only has to stay
 * alive, and once it is gone it never counts as alive again.
 */
import { execFile } from 'child_process'
import { readFile } from 'fs/promises'

/** Start times read from the system and written by the recorder differ by a little. */
export const START_TIME_TOLERANCE_MS = 5_000
const LOOKUP_TIMEOUT_MS = 10_000

export interface LivenessDeps {
  platform: NodeJS.Platform
  /** `process.kill(pid, 0)`: throws ESRCH when there is no such process. */
  signal: (pid: number) => void
  /** Start times of the given processes, in ms since epoch; a missing entry means unknown. */
  startTimes: (pids: number[]) => Promise<Map<number, number>>
}

export function processExists(signal: LivenessDeps['signal'], pid: number): boolean {
  try {
    signal(pid)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Field 22 of `/proc/<pid>/stat`, in clock ticks since boot. The name in field 2 can hold spaces and parentheses. */
export function parseProcStatStart(stat: string): number | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  const fields = stat.slice(close + 2).split(' ')
  // Fields after the name start at field 3, so field 22 is index 19.
  const ticks = Number(fields[19])
  return Number.isFinite(ticks) ? ticks : null
}

export function parseBootTime(procStat: string): number | null {
  const match = /^btime (\d+)$/m.exec(procStat)
  return match ? Number(match[1]) * 1000 : null
}

/** `ps -o pid=,lstart=` lines: `  123 Sun Oct 25 09:01:02 2026`. */
export function parsePsStartTimes(output: string): Map<number, number> {
  const times = new Map<number, number>()
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const at = Date.parse(match[2])
    if (Number.isFinite(at)) times.set(Number(match[1]), at)
  }
  return times
}

/** `<pid> <ms since epoch>` lines from the PowerShell query. */
export function parsePidTimeLines(output: string): Map<number, number> {
  const times = new Map<number, number>()
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (match) times.set(Number(match[1]), Number(match[2]))
  }
  return times
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true, env }, (_error, stdout) => resolve(String(stdout ?? '')))
  })
}

/** Linux reports in clock ticks; 100 a second on every common kernel build. */
const CLOCK_TICKS_PER_SECOND = 100

async function linuxStartTimes(pids: number[]): Promise<Map<number, number>> {
  const times = new Map<number, number>()
  let boot: number | null
  try {
    boot = parseBootTime(await readFile('/proc/stat', 'utf8'))
  } catch {
    return times
  }
  if (boot === null) return times
  await Promise.all(pids.map(async (pid) => {
    try {
      const ticks = parseProcStatStart(await readFile(`/proc/${pid}/stat`, 'utf8'))
      if (ticks !== null) times.set(pid, boot + (ticks / CLOCK_TICKS_PER_SECOND) * 1000)
    } catch {
      // Gone, or not ours to read.
    }
  }))
  return times
}

export async function systemStartTimes(pids: number[], platform: NodeJS.Platform = process.platform): Promise<Map<number, number>> {
  if (pids.length === 0) return new Map()
  if (platform === 'linux') return linuxStartTimes(pids)
  if (platform === 'win32') {
    const script = `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $([DateTimeOffset]::new($_.StartTime).ToUnixTimeMilliseconds())" }`
    return parsePidTimeLines(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]))
  }
  // The C locale keeps the date in the English form Date.parse reads.
  return parsePsStartTimes(await run('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], { ...process.env, LC_ALL: 'C' }))
}

export const SYSTEM_LIVENESS: LivenessDeps = {
  platform: process.platform,
  signal: (pid) => process.kill(pid, 0),
  startTimes: (pids) => systemStartTimes(pids),
}

export interface ProcessRef {
  pid: number
  startedAt: number
}

const key = (ref: ProcessRef): string => `${ref.pid}:${ref.startedAt}`

export class LivenessTracker {
  /** Processes whose start time matched, or could not be read. */
  private readonly confirmed = new Set<string>()
  private readonly ended = new Set<string>()

  constructor(private readonly deps: LivenessDeps = SYSTEM_LIVENESS) {}

  /** Which of the processes are running, checking start times only for ones not seen before. */
  async check(refs: ProcessRef[]): Promise<Set<string>> {
    const alive = new Set<string>()
    const unverified: ProcessRef[] = []
    for (const ref of refs) {
      const id = key(ref)
      if (this.ended.has(id)) continue
      if (!processExists(this.deps.signal, ref.pid)) {
        this.ended.add(id)
        this.confirmed.delete(id)
        continue
      }
      if (this.confirmed.has(id)) alive.add(id)
      else unverified.push(ref)
    }
    if (unverified.length > 0) {
      let times: Map<number, number>
      try {
        times = await this.deps.startTimes([...new Set(unverified.map((ref) => ref.pid))])
      } catch {
        times = new Map()
      }
      for (const ref of unverified) {
        const id = key(ref)
        const started = times.get(ref.pid)
        if (started === undefined || Math.abs(started - ref.startedAt) <= START_TIME_TOLERANCE_MS) {
          this.confirmed.add(id)
          alive.add(id)
        } else {
          // Another process now has this id.
          this.ended.add(id)
        }
      }
    }
    return alive
  }

  static key = key
}
