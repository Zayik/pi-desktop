import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { CONTEXT_DIR_ENV, snapshotFileName, type ContextSnapshot } from './context-snapshot'

const EXTENSION_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'pi-desktop-context.ts')).href
const SESSION_ID = 'sess-cache'
let loadedCopies = 0

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown

/** Load a fresh copy of the extension (it reads its environment at load) against a fake Pi. */
async function loadExtension(env: Record<string, string>, model: Record<string, unknown> | null = null, branch: unknown[] = []): Promise<{ emit: (name: string, event?: Record<string, unknown>) => unknown }> {
  for (const [name, value] of Object.entries(env)) process.env[name] = value
  const extension = await import(`${EXTENSION_URL}?copy=${++loadedCopies}`) as { default: (pi: ExtensionAPI) => void }
  const handlers = new Map<string, Handler>()
  const pi = {
    on: (name: string, handler: Handler) => { handlers.set(name, handler) },
    getActiveTools: () => [],
    getAllTools: () => [],
    getSettings: () => ({ cacheWarming: 'idle' }),
  }
  const ctx = {
    sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => null, getBranch: () => branch },
    getSystemPrompt: () => 'system',
    modelRegistry: { getAvailable: () => [] },
    model,
    getContextUsage: () => null,
  }
  extension.default(pi as unknown as ExtensionAPI)
  return { emit: (name, event = {}) => handlers.get(name)?.(event, ctx) }
}

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'context-ext-'))
  const saved = { dir: process.env[CONTEXT_DIR_ENV], retention: process.env.PI_CACHE_RETENTION }
  try {
    await run(dir)
  } finally {
    for (const [name, value] of [[CONTEXT_DIR_ENV, saved.dir], ['PI_CACHE_RETENTION', saved.retention]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(dir, { recursive: true, force: true })
  }
}

async function readSnapshot(dir: string, emit: (name: string) => unknown): Promise<ContextSnapshot> {
  emit('session_shutdown')
  return JSON.parse(await readFile(join(dir, snapshotFileName(SESSION_ID)), 'utf8')) as ContextSnapshot
}

test('only observes Pi\'s requests and warming decisions', async () => {
  await withDir(async (dir) => {
    delete process.env.PI_CACHE_RETENTION
    const model: Record<string, unknown> = { provider: 'github-copilot', id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }
    const branch: unknown[] = []
    const { emit } = await loadExtension({ [CONTEXT_DIR_ENV]: dir }, model, branch)
    emit('session_start')
    emit('context_with_system', { messages: [] })
    assert.equal(emit('cache_warming_decision', { action: 'warm', continuationProbability: 0.15, warmCost: 0, missCost: 0 }), undefined)
    assert.equal(process.env.PI_CACHE_RETENTION, undefined)
    assert.equal(model.promptCache, undefined)
    // Pi appends the refresh's usage once its one-token reply is back.
    const warmedAt = Date.now()
    branch.push({
      type: 'usage', id: 'w1', parentId: null, timestamp: new Date(warmedAt).toISOString(), kind: 'cache_warm', provider: 'github-copilot', model: 'claude-sonnet-5-5',
      usage: { input: 0, output: 1, cacheRead: 5_000, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0015 } },
    })
    await new Promise((resolve) => setTimeout(resolve, 1_800))
    const snapshot = await readSnapshot(dir, emit)
    assert.equal(snapshot.cacheRetention, 'short')
    assert.equal(snapshot.lastWarmAt, warmedAt, 'a refresh Pi sends is noted when its usage is on the branch')
    assert.equal(snapshot.pings?.count, 1)
    assert.equal(snapshot.pings?.cost, 0.0015)
  })
})

test('records which process runs the session and whether its agent is working', async () => {
  await withDir(async (dir) => {
    const { emit } = await loadExtension({ [CONTEXT_DIR_ENV]: dir })
    emit('session_start')
    emit('agent_start')
    emit('tool_execution_start', { toolName: 'bash', toolCallId: 't1', args: {} })
    emit('session_info_changed', { name: 'Rate limiter' })
    // Written on a short timer while the session runs.
    await new Promise((resolve) => setTimeout(resolve, 400))
    let snapshot = JSON.parse(await readFile(join(dir, snapshotFileName(SESSION_ID)), 'utf8')) as ContextSnapshot
    assert.equal(snapshot.process?.pid, process.pid)
    assert.ok(Math.abs((snapshot.process?.startedAt ?? 0) - (Date.now() - process.uptime() * 1000)) < 2_000)
    assert.equal(snapshot.agentRunning, true)
    assert.equal(snapshot.activeTool, 'bash')
    assert.equal(snapshot.sessionName, 'Rate limiter')
    assert.equal(snapshot.endedAt, null)

    emit('tool_execution_end')
    emit('agent_end')
    snapshot = await readSnapshot(dir, emit)
    assert.equal(snapshot.agentRunning, false)
    assert.equal(snapshot.activeTool, null)
    assert.ok(typeof snapshot.endedAt === 'number', 'a closed session says so, so readers need not guess from its process')
  })
})

test('records nothing on its own without a folder: pi-analytics runs it with one', async () => {
  await withDir(async (dir) => {
    delete process.env[CONTEXT_DIR_ENV]
    const { emit } = await loadExtension({})
    emit('session_start')
    emit('session_shutdown')
    await assert.rejects(readFile(join(dir, snapshotFileName(SESSION_ID)), 'utf8'))
  })
})
