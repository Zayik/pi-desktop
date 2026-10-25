import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { AUTO_WARM_FILE, CACHE_MODE_ENV, CONTEXT_DIR_ENV, MAX_IDLE_WARMS, cacheModeFileName, emptyAutoWarmSchedule, snapshotFileName, type ContextSnapshot } from './context-snapshot'

const EXTENSION_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'pi-desktop-context.ts')).href
const SESSION_ID = 'sess-cache'
let loadedCopies = 0

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown

/** Load a fresh copy of the extension (it reads its environment at load) against a fake Pi. */
async function loadExtension(env: Record<string, string>, model: Record<string, unknown> | null = null): Promise<{ emit: (name: string, event?: Record<string, unknown>) => unknown }> {
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
    sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => null, getBranch: () => [] },
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
  const saved = { dir: process.env[CONTEXT_DIR_ENV], mode: process.env[CACHE_MODE_ENV], retention: process.env.PI_CACHE_RETENTION }
  try {
    await run(dir)
  } finally {
    for (const [name, value] of [[CONTEXT_DIR_ENV, saved.dir], [CACHE_MODE_ENV, saved.mode], ['PI_CACHE_RETENTION', saved.retention]] as const) {
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

test('starts in the mode the app passes and asks for the matching cache tier', async () => {
  await withDir(async (dir) => {
    const { emit } = await loadExtension({ [CONTEXT_DIR_ENV]: dir, [CACHE_MODE_ENV]: 'long' })
    emit('session_start')
    emit('context_with_system', { messages: [] })
    assert.equal(process.env.PI_CACHE_RETENTION, 'long')
    // Pi's idle refresh is never sent in long mode.
    assert.deepEqual(emit('cache_warming_decision', { action: 'warm', continuationProbability: 0.15, warmCost: 0, missCost: 0 }), { action: 'stop' })
    const snapshot = await readSnapshot(dir, emit)
    assert.equal(snapshot.cacheMode, 'long')
    assert.equal(snapshot.cacheRetention, 'long')
    assert.equal(snapshot.cacheModeChangedAt, null)
  })
})

test('a mode picked in the app applies from the next request', async () => {
  await withDir(async (dir) => {
    const { emit } = await loadExtension({ [CONTEXT_DIR_ENV]: dir, [CACHE_MODE_ENV]: 'focus' })
    emit('session_start')
    emit('before_provider_request')
    assert.equal(process.env.PI_CACHE_RETENTION, 'short')
    // While the agent works Pi's own decision stands.
    assert.equal(emit('cache_warming_decision', { action: 'warm', continuationProbability: 1, warmCost: 0, missCost: 0 }), undefined)
    assert.deepEqual(emit('cache_warming_decision', { action: 'warm', continuationProbability: 0.15, warmCost: 0, missCost: 0 }), { action: 'stop' })

    await writeFile(join(dir, cacheModeFileName(SESSION_ID)), JSON.stringify({ mode: 'keep-warm', changedAt: 1234 }))
    assert.deepEqual(emit('cache_warming_decision', { action: 'skip', continuationProbability: 0.15, warmCost: 0, missCost: 0 }), { action: 'warm' })
    await writeFile(join(dir, cacheModeFileName(SESSION_ID)), JSON.stringify({ mode: 'long', changedAt: 5678 }))
    emit('context_with_system', { messages: [] })
    assert.equal(process.env.PI_CACHE_RETENTION, 'long')
    let snapshot = await readSnapshot(dir, emit)
    assert.equal(snapshot.cacheMode, 'long')
    assert.equal(snapshot.cacheModeChangedAt, 5678)
    // The live entry is still the last request's 5-minute one until a request is sent.
    assert.equal(snapshot.cacheRetention, 'short')

    emit('session_start')
    emit('before_provider_request')
    snapshot = await readSnapshot(dir, emit)
    assert.equal(snapshot.cacheMode, 'long', 'a resumed session keeps its picked mode')
    assert.equal(snapshot.cacheRetention, 'long')
  })
})

test('keep warm stops refreshing after its idle budget until the next real request', async () => {
  await withDir(async (dir) => {
    const { emit } = await loadExtension({ [CONTEXT_DIR_ENV]: dir, [CACHE_MODE_ENV]: 'keep-warm' })
    emit('session_start')
    emit('context_with_system', { messages: [] })
    const idle = { action: 'skip', continuationProbability: 0.15, warmCost: 0, missCost: 0 }
    const answers = [1, 2, 3, 4].map(() => emit('cache_warming_decision', idle))
    assert.deepEqual(answers, [{ action: 'warm' }, { action: 'warm' }, { action: 'warm' }, { action: 'stop' }])
    emit('context_with_system', { messages: [] })
    assert.deepEqual(emit('cache_warming_decision', idle), { action: 'warm' })
    emit('session_shutdown')
  })
})

test('auto allows the idle refreshes the schedule gives the hour the break starts in', async () => {
  await withDir(async (dir) => {
    const { emit } = await loadExtension({ [CONTEXT_DIR_ENV]: dir, [CACHE_MODE_ENV]: 'auto' })
    emit('session_start')
    const idle = { action: 'skip', continuationProbability: 0.15, warmCost: 0, missCost: 0 }
    // Without a schedule yet, auto refreshes like keep warm.
    emit('context_with_system', { messages: [] })
    const fallback = Array.from({ length: MAX_IDLE_WARMS + 1 }, () => emit('cache_warming_decision', idle))
    assert.deepEqual(fallback.at(-1), { action: 'stop' })
    assert.equal(fallback.filter((answer) => (answer as { action: string }).action === 'warm').length, MAX_IDLE_WARMS)

    const schedule = emptyAutoWarmSchedule(Date.now(), 30)
    schedule.fallback = Array.from({ length: 24 }, (_, hour) => (hour === new Date().getHours() ? 1 : 5))
    await writeFile(join(dir, AUTO_WARM_FILE), JSON.stringify(schedule))
    emit('context_with_system', { messages: [] })
    assert.deepEqual([1, 2].map(() => emit('cache_warming_decision', idle)), [{ action: 'warm' }, { action: 'stop' }])
    const snapshot = await readSnapshot(dir, emit)
    assert.equal(snapshot.cacheMode, 'auto')
    assert.equal(snapshot.autoWarmLimit, 1)
  })
})

test('a manual pick overrides auto', async () => {
  await withDir(async (dir) => {
    const { emit } = await loadExtension({ [CONTEXT_DIR_ENV]: dir, [CACHE_MODE_ENV]: 'auto' })
    emit('session_start')
    emit('context_with_system', { messages: [] })
    await writeFile(join(dir, cacheModeFileName(SESSION_ID)), JSON.stringify({ mode: 'focus', changedAt: 1234 }))
    const idle = { action: 'warm', continuationProbability: 0.15, warmCost: 0, missCost: 0 }
    assert.deepEqual(emit('cache_warming_decision', idle), { action: 'stop' })
    const snapshot = await readSnapshot(dir, emit)
    assert.equal(snapshot.cacheMode, 'focus')
    assert.equal(snapshot.autoWarmLimit, null)
  })
})

test('gives the session\'s model the advertised cache lifetime so Pi warms it', async () => {
  await withDir(async (dir) => {
    const model: Record<string, unknown> = { provider: 'github-copilot', id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }
    const { emit } = await loadExtension({ [CONTEXT_DIR_ENV]: dir, [CACHE_MODE_ENV]: 'auto' }, model)
    emit('session_start')
    assert.deepEqual(model.promptCache, { short: 300, long: 3600 })
    const snapshot = await readSnapshot(dir, emit)
    assert.deepEqual(snapshot.model?.promptCache, { short: 300, long: 3600 })
  })
})
