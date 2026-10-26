import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LivenessTracker,
  parseBootTime,
  parsePidTimeLines,
  parseProcStatStart,
  parsePsStartTimes,
  systemStartTimes,
  type LivenessDeps,
} from './liveness'

function fakeDeps(running: Map<number, number | undefined>, lookups: number[][] = []): LivenessDeps {
  return {
    platform: 'linux',
    signal: (pid) => {
      if (!running.has(pid)) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    },
    startTimes: async (pids) => {
      lookups.push(pids)
      const times = new Map<number, number>()
      for (const pid of pids) {
        const at = running.get(pid)
        if (at !== undefined) times.set(pid, at)
      }
      return times
    },
  }
}

test('a process counts as running only while its id lives and its start time matches', async () => {
  const running = new Map<number, number | undefined>([[100, 1_000_000], [200, 5_000_000]])
  const lookups: number[][] = []
  const tracker = new LivenessTracker(fakeDeps(running, lookups))
  const live = { pid: 100, startedAt: 1_000_900 }
  // Pi crashed and the system gave its id to a later process.
  const reused = { pid: 200, startedAt: 1_000_000 }
  const gone = { pid: 300, startedAt: 1 }

  const first = await tracker.check([live, reused, gone])
  assert.deepEqual([...first], [LivenessTracker.key(live)])
  assert.deepEqual(lookups, [[100, 200]], 'start times are read once, for ids that are alive')

  await tracker.check([live, reused])
  assert.equal(lookups.length, 1, 'a confirmed process is not looked up again')

  running.delete(100)
  assert.equal((await tracker.check([live])).size, 0)
  running.set(100, 1_000_000)
  assert.equal((await tracker.check([live])).size, 0, 'once gone, a process never comes back')
})

test('a start time the system cannot give leaves the process id to decide', async () => {
  const running = new Map<number, number | undefined>([[42, undefined]])
  const tracker = new LivenessTracker(fakeDeps(running))
  assert.equal((await tracker.check([{ pid: 42, startedAt: 7 }])).size, 1)
})

test('a process of another user still exists', async () => {
  const tracker = new LivenessTracker({
    platform: 'linux',
    signal: () => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' })
    },
    startTimes: async () => new Map(),
  })
  assert.equal((await tracker.check([{ pid: 1, startedAt: 0 }])).size, 1)
})

test('reads start times in each system\'s format', () => {
  assert.equal(parseProcStatStart('1234 (node (pi) x) S 1 1234 1234 0 -1 4194560 100 0 0 0 5 1 0 0 20 0 11 0 98765 1000 100'), 98765)
  assert.equal(parseProcStatStart('garbage'), null)
  assert.equal(parseBootTime('cpu 1 2 3\nbtime 1792900000\nprocesses 5\n'), 1792900000000)
  const ps = parsePsStartTimes('  123 Sun Oct 25 09:01:02 2026\n 4567 Mon Oct 26 10:00:00 2026\n')
  assert.equal(ps.size, 2)
  assert.equal(ps.get(123), new Date(2026, 9, 25, 9, 1, 2).getTime())
  assert.deepEqual([...parsePidTimeLines('12 1792949803879\r\n\r\n34 1792949800000\r\n')], [[12, 1792949803879], [34, 1792949800000]])
})

test('this process\'s start time, read from the system, matches the one the recorder writes', async () => {
  const times = await systemStartTimes([process.pid])
  const recorded = Date.now() - process.uptime() * 1000
  const read = times.get(process.pid)
  assert.ok(read !== undefined, 'the system gave a start time')
  assert.ok(Math.abs(read - recorded) < 5_000, `${read} vs ${recorded}`)
})
