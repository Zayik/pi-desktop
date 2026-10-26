import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { AnalyticsIndex, subagentParentFile } from './analytics-index'

const NOW = Date.now()

function session(id: string, cwd: string, startedAt: number, cost: number, extra: Record<string, unknown> = {}, more: Record<string, unknown>[] = []): string {
  const header = { type: 'session', id, timestamp: new Date(startedAt).toISOString(), cwd, ...extra }
  const prompt = { type: 'message', id: 'u1', parentId: null, timestamp: new Date(startedAt + 1_000).toISOString(), message: { role: 'user', content: `task for ${id}` } }
  const reply = {
    type: 'message', id: 'a1', parentId: 'u1', timestamp: new Date(startedAt + 2_000).toISOString(),
    message: {
      role: 'assistant', provider: 'p', model: 'm',
      content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'npm test' } }],
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: cost } },
    },
  }
  const toolResult = {
    type: 'message', id: 'r1', parentId: 'a1', timestamp: new Date(startedAt + 62_000).toISOString(),
    message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }] },
  }
  return [header, prompt, reply, toolResult, ...more].map((entry) => JSON.stringify(entry)).join('\n') + '\n'
}

async function fixture(): Promise<{ root: string; sessions: string; delegates: string; archive: string; index: AnalyticsIndex }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'analytics-index-')))
  const sessions = join(root, 'sessions')
  const delegates = join(root, 'tmp', 'acp-delegate')
  const archive = join(root, 'archive')
  await mkdir(join(sessions, '--repo--'), { recursive: true })
  await mkdir(delegates, { recursive: true })
  const index = new AnalyticsIndex({ dbPath: join(root, 'analytics.sqlite'), sessionRoots: [sessions], importRoots: [], delegateDir: delegates, archiveDir: archive })
  return { root, sessions, delegates, archive, index }
}

test('finds the chat a pi-subagents child belongs to', async () => {
  const { root, sessions, index } = await fixture()
  try {
    const chat = join(sessions, '--repo--', 'chat.jsonl')
    await writeFile(chat, '')
    await mkdir(join(sessions, '--repo--', 'chat', 'run1', 'run-0'), { recursive: true })
    assert.equal(subagentParentFile(join(sessions, '--repo--', 'chat', 'run1', 'run-0', 'child.jsonl'), [sessions]), chat)
    assert.equal(subagentParentFile(chat, [sessions]), null)
    assert.equal(subagentParentFile('/elsewhere/x.jsonl', [sessions]), null)
  } finally {
    index.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a session report adds its pi-subagents children and archived delegates', async () => {
  const { root, sessions, delegates, archive, index } = await fixture()
  try {
    const chat = join(sessions, '--repo--', 'chat.jsonl')
    const delegateCall = {
      type: 'message', id: 'a2', parentId: 'r1', timestamp: new Date(NOW + 70_000).toISOString(),
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'd1', name: 'acp_delegate', arguments: { agent: 'reviewer' } }] },
    }
    const delegateResult = {
      type: 'message', id: 'r2', parentId: 'a2', timestamp: new Date(NOW + 80_000).toISOString(),
      message: { role: 'toolResult', toolCallId: 'd1', toolName: 'acp_delegate', content: [{ type: 'text', text: 'started del_abc123_xy' }] },
    }
    await writeFile(chat, session('main', '/repo', NOW, 1, {}, [delegateCall, delegateResult]))
    const childDir = join(sessions, '--repo--', 'chat', 'run1', 'run-0')
    await mkdir(childDir, { recursive: true })
    await writeFile(join(childDir, 'child.jsonl'), session('child', '/repo', NOW + 5_000, 0.5))
    await writeFile(join(delegates, 'del_abc123_xy.session.jsonl'), session('delegate', '/repo', NOW + 10_000, 0.25))

    const report = await index.sessionReport(chat)
    assert.ok(report)
    assert.equal(report.sessions, 3)
    assert.ok(Math.abs(report.cost - 1.75) < 1e-9)
    assert.ok(Math.abs(report.subagentCost - 0.75) < 1e-9)
    assert.equal(report.sessionRows[0].kind, 'main')
    assert.deepEqual(report.sessionRows.slice(1).map((row) => [row.kind, row.agentName]), [['subagent', null], ['delegate', 'reviewer']])
    assert.equal(report.tests.runs, 3)
    // The delegate was copied out of the temp folder.
    assert.equal(report.sessionRows[2].sessionFile, join(archive, 'del_abc123_xy.session.jsonl'))
  } finally {
    index.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('the overview keeps a deleted session and filters by range and project', async () => {
  const { root, sessions, index } = await fixture()
  try {
    const recent = join(sessions, '--repo--', 'recent.jsonl')
    const old = join(sessions, '--repo--', 'old.jsonl')
    const other = join(sessions, '--repo--', 'other.jsonl')
    await writeFile(recent, session('recent', '/repo', NOW - 60_000, 2))
    await writeFile(old, session('old', '/repo', NOW - 60 * 86_400_000, 3))
    await writeFile(other, session('other', '/elsewhere', NOW - 120_000, 4))
    await index.refresh(true, NOW)

    const week = await index.overview({ range: '7', projectPath: null }, NOW)
    assert.equal(week.sessions, 2)
    assert.ok(Math.abs(week.cost - 6) < 1e-9)
    const all = await index.overview({ range: 'all', projectPath: '/repo' }, NOW)
    assert.equal(all.sessions, 2)
    assert.ok(Math.abs(all.cost - 5) < 1e-9)

    await rm(recent)
    await index.refresh(true, NOW)
    const afterDelete = await index.overview({ range: '7', projectPath: '/repo' }, NOW)
    assert.equal(afterDelete.sessions, 1)
    assert.equal(afterDelete.sessionRows[0].fileExists, false)

    // A rebuild keeps what can no longer be read again.
    await index.rebuild()
    assert.equal((await index.overview({ range: 'all', projectPath: null }, NOW)).sessions, 3)
  } finally {
    index.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('reads Claude Code, Codex and Copilot sessions beside Pi sessions, with Claude Code subagents', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'analytics-index-cc-')))
  const sessions = join(root, 'sessions')
  const claude = join(root, 'claude', 'projects')
  await mkdir(join(sessions, '--repo--'), { recursive: true })
  await mkdir(join(claude, '-repo', 'cc1', 'subagents'), { recursive: true })
  const line = (sessionId: string, uuid: string, seconds: number, extra: Record<string, unknown> = {}): string => JSON.stringify({
    type: 'assistant', sessionId, uuid, parentUuid: null, cwd: '/repo', timestamp: new Date(NOW - 60_000 + seconds * 1000).toISOString(),
    message: { id: `msg_${uuid}`, model: 'claude-opus-5-5', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000 } },
    ...extra,
  })
  await writeFile(join(sessions, '--repo--', 'pi.jsonl'), session('pi1', '/repo', NOW - 60_000, 0.5))
  await writeFile(join(claude, '-repo', 'cc1.jsonl'), line('cc1', 'a1', 1) + '\n')
  await writeFile(join(claude, '-repo', 'cc1', 'subagents', 'agent-x.jsonl'), line('cc1', 'b1', 2, { isSidechain: true }) + '\n')
  const codex = join(root, 'codex', 'sessions')
  const copilot = join(root, 'copilot', 'session-state')
  await mkdir(join(codex, '2026', '10', '20'), { recursive: true })
  await mkdir(join(copilot, 'cp1'), { recursive: true })
  const stamp = (seconds: number): string => new Date(NOW - 60_000 + seconds * 1000).toISOString()
  await writeFile(join(codex, '2026', '10', '20', 'rollout-x.jsonl'), [
    { timestamp: stamp(0), type: 'session_meta', payload: { id: 'cx1', timestamp: stamp(0), cwd: '/repo' } },
    { timestamp: stamp(1), type: 'turn_context', payload: { model: 'gpt-6-luna' } },
    { timestamp: stamp(2), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 10 } } } },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  await writeFile(join(copilot, 'cp1', 'events.jsonl'), [
    { type: 'session.start', id: 'e1', timestamp: stamp(0), data: { sessionId: 'cp1', selectedModel: 'gpt-6-luna', context: { cwd: '/repo' } } },
    { type: 'assistant.message', id: 'e2', timestamp: stamp(3), data: { messageId: 'm1', content: 'hi', outputTokens: 5 } },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  const importRoots = [
    { source: 'claude-code' as const, root: claude, depth: 3 },
    { source: 'codex' as const, root: codex, depth: 3 },
    { source: 'copilot' as const, root: copilot, depth: 1 },
  ]
  const index = new AnalyticsIndex({ dbPath: join(root, 'analytics.sqlite'), sessionRoots: [sessions], importRoots, delegateDir: join(root, 'none'), archiveDir: join(root, 'archive') })
  try {
    await index.refresh(true)
    const counts = index.sources()
    assert.deepEqual(counts.map((count) => [count.source, count.sessions]), [['claude-code', 2], ['codex', 1], ['copilot', 1], ['pi', 1]])
    assert.ok(counts[0].cost > 0)
    const report = await index.sessionReport(join(claude, '-repo', 'cc1.jsonl'))
    assert.ok(report)
    assert.deepEqual(report.sessionRows.map((row) => row.kind).sort(), ['main', 'subagent'])
  } finally {
    index.close()
    await rm(root, { recursive: true, force: true })
  }
})
