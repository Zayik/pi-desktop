import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CONTEXT_SNAPSHOT_VERSION, emptyTotals, snapshotFileName, type ContextSnapshot } from '../../../../resources/context-snapshot'
import { LiveSessions, parseSessionHead } from './sessions'
import type { LivenessDeps } from './liveness'

const NOW = Date.now()

function snapshot(sessionId: string, change: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    version: CONTEXT_SNAPSHOT_VERSION,
    sessionId,
    sessionFile: null,
    updatedAt: NOW - 1_000,
    model: { provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 200_000, maxTokens: 64_000, rates: null, promptCache: null },
    cacheRetention: 'short',
    cacheWarming: null,
    breakdown: null,
    reportedTokens: 50_000,
    calls: [],
    totals: { ...emptyTotals(), cost: 0.25 },
    turnStartedAt: null,
    lastRequestAt: null,
    lastWarmAt: null,
    ...change,
  }
}

function writeSnapshot(dir: string, value: ContextSnapshot): void {
  writeFileSync(join(dir, snapshotFileName(value.sessionId)), JSON.stringify(value))
  const at = new Date(value.updatedAt)
  utimesSync(join(dir, snapshotFileName(value.sessionId)), at, at)
}

/** Processes 1 and 2 run; 1 started at 1000, 2 at 2000. */
const LIVENESS: LivenessDeps = {
  platform: 'linux',
  signal: (pid) => {
    if (pid !== 1 && pid !== 2) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
  },
  startTimes: async (pids) => new Map(pids.map((pid) => [pid, pid * 1000])),
}

function fixture(): { root: string; contextDir: string; sessionsRoot: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'live-sessions-'))
  const contextDir = join(root, 'context')
  const sessionsRoot = join(root, 'sessions')
  mkdirSync(contextDir, { recursive: true })
  mkdirSync(join(sessionsRoot, '--home-me-web--'), { recursive: true })
  return { root, contextDir, sessionsRoot, done: () => rmSync(root, { recursive: true, force: true }) }
}

test('lists each recorded session with what its process is doing, running ones first', async () => {
  const { contextDir, sessionsRoot, done } = fixture()
  try {
    writeSnapshot(contextDir, snapshot('working', { process: { pid: 1, startedAt: 1_000, cwd: '/home/me/web' }, agentRunning: true, activeTool: 'bash', sessionName: 'Fix login' }))
    writeSnapshot(contextDir, snapshot('idle', { process: { pid: 2, startedAt: 2_000, cwd: '/home/me/api' }, agentRunning: false, updatedAt: NOW - 5_000 }))
    // Pi was killed mid-turn: no end mark, and its process is gone.
    writeSnapshot(contextDir, snapshot('crashed', { process: { pid: 3, startedAt: 3_000, cwd: '/home/me/docs' }, agentRunning: true, activeTool: 'bash' }))
    // Its id now belongs to an unrelated process that started later.
    writeSnapshot(contextDir, snapshot('reused', { process: { pid: 2, startedAt: 900_000, cwd: '/home/me/old' }, updatedAt: NOW - 6_000 }))
    writeSnapshot(contextDir, snapshot('closed', { process: { pid: 1, startedAt: 1_000, cwd: '/home/me/web' }, endedAt: NOW - 2_000, updatedAt: NOW - 2_000 }))
    writeSnapshot(contextDir, snapshot('child', { process: { pid: 1, startedAt: 1_000, cwd: '/home/me/web' }, parentSessionId: 'working', updatedAt: NOW - 3_000 }))
    writeSnapshot(contextDir, snapshot('orphan', { process: { pid: 1, startedAt: 1_000, cwd: '/home/me/web' }, parentSessionId: 'not-listed', updatedAt: NOW - 4_000 }))

    const rows = await new LiveSessions({ contextDir, sessionRoots: [sessionsRoot], liveness: LIVENESS }).list(NOW)
    const byId = new Map(rows.map((row) => [row.sessionId, row]))
    assert.deepEqual(rows.map((row) => row.sessionId), ['working', 'child', 'orphan', 'idle', 'crashed', 'closed', 'reused'])
    assert.equal(byId.get('working')?.state, 'working')
    assert.equal(byId.get('working')?.activeTool, 'bash')
    assert.equal(byId.get('working')?.title, 'Fix login')
    assert.equal(byId.get('working')?.contextPercent, 25)
    assert.equal(byId.get('idle')?.state, 'idle')
    assert.equal(byId.get('crashed')?.state, 'stopped')
    assert.equal(byId.get('crashed')?.activeTool, null, 'a stopped session runs no tool')
    assert.equal(byId.get('reused')?.state, 'stopped')
    assert.equal(byId.get('closed')?.state, 'ended')
    assert.equal(byId.get('child')?.parentSessionId, 'working')
    assert.equal(byId.get('orphan')?.parentSessionId, null, 'a parent that is not listed is dropped')
  } finally {
    done()
  }
})

test('adds sessions from Pi\'s log that the recorder never saw, once each', async () => {
  const { contextDir, sessionsRoot, done } = fixture()
  try {
    const dir = join(sessionsRoot, '--home-me-web--')
    const header = (id: string): string => JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date(NOW).toISOString(), cwd: '/home/me/web' })
    const prompt = (text: string): string => JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: new Date(NOW).toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } })
    writeFileSync(join(dir, 'a_old.jsonl'), `${header('from-log')}\n${prompt('Write the docs\nwith detail')}\n`)
    writeFileSync(join(dir, 'b_recorded.jsonl'), `${header('recorded')}\n${prompt('Recorded one')}\n`)
    const stale = join(dir, 'c_stale.jsonl')
    writeFileSync(stale, `${header('stale')}\n`)
    utimesSync(stale, new Date(NOW - 30 * 86_400_000), new Date(NOW - 30 * 86_400_000))
    writeSnapshot(contextDir, snapshot('recorded', { sessionFile: join(dir, 'b_recorded.jsonl'), endedAt: NOW - 10 }))

    const rows = await new LiveSessions({ contextDir, sessionRoots: [sessionsRoot], liveness: LIVENESS }).list(NOW)
    assert.deepEqual(rows.map((row) => [row.sessionId, row.state, row.title]).sort(), [
      ['from-log', 'history', 'Write the docs'],
      ['recorded', 'ended', 'Recorded one'],
    ])
    const fromLog = rows.find((row) => row.sessionId === 'from-log')
    assert.equal(fromLog?.cost, null, 'a log-only session has no recorded cost')
    assert.equal(fromLog?.cwd, '/home/me/web')
  } finally {
    done()
  }
})

test('a session\'s page data is its snapshot and the board built from its file', async () => {
  const { contextDir, sessionsRoot, done } = fixture()
  try {
    const live = new LiveSessions({ contextDir, sessionRoots: [sessionsRoot], liveness: LIVENESS })
    writeSnapshot(contextDir, snapshot('one', { process: { pid: 1, startedAt: 1_000, cwd: '/x' } }))
    const rows = await live.list(NOW)
    const page = await live.session('one', rows, NOW)
    assert.equal(page.kind, 'live-session')
    assert.equal(page.data.snapshot?.sessionId, 'one')
    assert.equal(page.data.row?.state, 'idle')
    assert.equal(page.data.board, null, 'no session file, so no board')
    const missing = await live.session('nope', rows, NOW)
    assert.equal(missing.data.snapshot, null)
    assert.equal(missing.data.row, null)
  } finally {
    done()
  }
})

test('reads a session file\'s id, folder and title from its first lines, even cut off mid-line', () => {
  const head = parseSessionHead([
    JSON.stringify({ type: 'session', id: 's1', cwd: '/w' }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'First prompt' } }),
    JSON.stringify({ type: 'session_info', name: 'Named' }),
    '{"type":"message","mess',
  ].join('\n'))
  assert.deepEqual(head, { sessionId: 's1', cwd: '/w', title: 'Named' })
  assert.deepEqual(parseSessionHead(''), { sessionId: null, cwd: null, title: null })
})
