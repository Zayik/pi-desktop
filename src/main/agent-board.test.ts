import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { CONTEXT_SNAPSHOT_VERSION, emptyTotals, type ContextSnapshot } from '../../resources/context-snapshot'
import { readAgentBoard } from './agent-board'
import { sanitizePath } from './session-paths'

const NOW = Date.now()

function sessionFile(id: string, cwd: string, startedAt: number, extra: Record<string, unknown> = {}, more: Record<string, unknown>[] = []): string {
  const header = { type: 'session', id, timestamp: new Date(startedAt).toISOString(), cwd, ...extra }
  const prompt = { type: 'message', id: 'u1', parentId: null, timestamp: new Date(startedAt + 1_000).toISOString(), message: { role: 'user', content: `task for ${id}` } }
  const reply = {
    type: 'message', id: 'a1', parentId: 'u1', timestamp: new Date(startedAt + 2_000).toISOString(),
    message: { role: 'assistant', provider: 'p', model: 'm', content: [], usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.1 } } },
  }
  return [header, prompt, reply, ...more].map((entry) => JSON.stringify(entry)).join('\n') + '\n'
}

test('finds subagent, worktree, parent-linked and recorder-linked sessions of a chat', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-board-')))
  const saved = { pi: process.env.PI_CODING_AGENT_DIR, omp: process.env.OMP_CODING_AGENT_DIR }
  process.env.PI_CODING_AGENT_DIR = join(root, 'pi')
  process.env.OMP_CODING_AGENT_DIR = join(root, 'omp')
  try {
    const repo = join(root, 'repo')
    const worktree = join(root, 'repo-wt')
    await mkdir(repo)
    const git = (...args: string[]): void => { execFileSync('git', args, { cwd: repo, stdio: 'ignore' }) }
    git('init', '-q')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
    git('worktree', 'add', '-q', worktree)

    const sessions = join(root, 'pi', 'sessions')
    const repoDir = join(sessions, sanitizePath(repo))
    const worktreeDir = join(sessions, sanitizePath(worktree))
    const otherDir = join(sessions, '--elsewhere--')
    await Promise.all([mkdir(repoDir, { recursive: true }), mkdir(worktreeDir, { recursive: true }), mkdir(otherDir, { recursive: true })])

    const main = join(repoDir, 'main.jsonl')
    const start = NOW - 10 * 60_000
    // billion-context: the chat starts a delegate, whose session sits in the temp folder.
    const delegateCall = {
      type: 'message', id: 'a2', parentId: 'a1', timestamp: new Date(start + 3_000).toISOString(),
      message: { role: 'assistant', provider: 'p', model: 'm', content: [{ type: 'toolCall', id: 'call-1', name: 'acp_delegate', arguments: { agent: 'reviewer', task: 'review' } }] },
    }
    const delegateResult = {
      type: 'message', id: 't1', parentId: 'a2', timestamp: new Date(start + 4_000).toISOString(),
      message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'acp_delegate', content: [{ type: 'text', text: 'Started delegate del_mabc123_x9z1 (async).' }] },
    }
    await writeFile(main, sessionFile('main', repo, start, {}, [delegateCall, delegateResult]))
    const temp = join(root, 'tmp')
    await mkdir(join(temp, 'acp-delegate'), { recursive: true })
    await writeFile(join(temp, 'acp-delegate', 'del_mabc123_x9z1.session.jsonl'), sessionFile('delegate', repo, start + 5_000))
    // pi-subagents: children under a folder named after the chat file, nested one more level.
    const runDir = join(repoDir, 'main', 'run-abc', 'run-0')
    await mkdir(runDir, { recursive: true })
    const piSubagent = join(runDir, 'child.jsonl')
    await writeFile(piSubagent, sessionFile('pi-subagent', repo, start + 6_000, {}, [{ type: 'session_info', id: 'n1', parentId: 'a1', timestamp: new Date(start + 7_000).toISOString(), name: 'worker: fix tests' }]))
    const nestedDir = join(runDir, 'child', 'run-def', 'run-0')
    await mkdir(nestedDir, { recursive: true })
    await writeFile(join(nestedDir, 'grandchild.jsonl'), sessionFile('grandchild', repo, start + 8_000))
    await writeFile(join(repoDir, 'unrelated.jsonl'), sessionFile('unrelated', repo, start + 5_000))
    await writeFile(join(repoDir, 'forked.jsonl'), sessionFile('forked', repo, start + 5_000, { parentSession: main }))
    await writeFile(join(worktreeDir, 'implement.jsonl'), sessionFile('implement', worktree, start + 60_000))
    await writeFile(join(worktreeDir, 'old.jsonl'), sessionFile('old', worktree, start - 3 * 60 * 60_000))
    const subagent = join(otherDir, 'sub.jsonl')
    await writeFile(subagent, sessionFile('sub', '/elsewhere', start + 30_000))
    const spawned = join(otherDir, 'spawned.jsonl')
    await writeFile(spawned, sessionFile('spawned', '/elsewhere', start + 40_000))

    const snapshots = join(root, 'snapshots')
    await mkdir(snapshots)
    const snapshot: ContextSnapshot = {
      version: CONTEXT_SNAPSHOT_VERSION, sessionId: 'spawned', sessionFile: spawned, parentSessionId: 'main', updatedAt: NOW,
      model: null, cacheRetention: 'short', cacheWarming: null, breakdown: null, reportedTokens: null, calls: [],
      totals: emptyTotals(), turnStartedAt: null, lastRequestAt: null, lastWarmAt: null,
    }
    await writeFile(join(snapshots, 'spawned.json'), JSON.stringify(snapshot))

    const board = await readAgentBoard({ sessionId: 'main', sessionFile: main, subagentSessionFiles: [subagent, '/etc/passwd'] }, NOW, snapshots, temp)
    assert.equal(board.main?.sessionId, 'main')
    assert.ok(Math.abs((board.main?.cost ?? 0) - 0.1) < 1e-12)
    const kinds = Object.fromEntries(board.children.map((child) => [child.summary.sessionId, child.kind]))
    assert.deepEqual(kinds, {
      forked: 'child', sub: 'subagent', spawned: 'child', implement: 'worktree', delegate: 'subagent', 'pi-subagent': 'subagent', grandchild: 'subagent',
    })
    assert.equal(board.children.find((child) => child.summary.sessionId === 'delegate')?.agentName, 'reviewer')
    assert.equal(board.children.find((child) => child.summary.sessionId === 'pi-subagent')?.summary.name, 'worker: fix tests')
    assert.equal(board.children.find((child) => child.summary.sessionId === 'spawned')?.snapshot?.sessionId, 'spawned')
  } finally {
    if (saved.pi === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = saved.pi
    if (saved.omp === undefined) delete process.env.OMP_CODING_AGENT_DIR
    else process.env.OMP_CODING_AGENT_DIR = saved.omp
    await rm(root, { recursive: true, force: true })
  }
})
