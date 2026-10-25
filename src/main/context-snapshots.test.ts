import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { CONTEXT_SNAPSHOT_VERSION, emptyTotals, type ContextSnapshot } from '../../resources/context-snapshot'
import { pruneContextSnapshots, readContextSnapshot } from './context-snapshots'

function snapshot(sessionId: string, updatedAt = 1): ContextSnapshot {
  return {
    version: CONTEXT_SNAPSHOT_VERSION, sessionId, sessionFile: null, updatedAt, model: null, cacheRetention: 'short',
    cacheWarming: null, breakdown: null, reportedTokens: null, calls: [], totals: emptyTotals(),
    turnStartedAt: null, lastRequestAt: null, lastWarmAt: null,
  }
}

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'context-snapshots-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('reads a session snapshot and re-reads it after it changes', async () => {
  await withDir(async (dir) => {
    assert.equal(await readContextSnapshot('abc', dir), null)
    const path = join(dir, 'abc.json')
    await writeFile(path, JSON.stringify(snapshot('abc', 1)))
    assert.equal((await readContextSnapshot('abc', dir))?.updatedAt, 1)
    await writeFile(path, JSON.stringify(snapshot('abc', 22)))
    await utimes(path, new Date(), new Date(Date.now() + 5_000))
    assert.equal((await readContextSnapshot('abc', dir))?.updatedAt, 22)
  })
})

test('ignores a half-written file and one written for another session', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'abc.json'), '{"version":')
    assert.equal(await readContextSnapshot('abc', dir), null)
    await writeFile(join(dir, 'other.json'), JSON.stringify(snapshot('someone-else')))
    assert.equal(await readContextSnapshot('other', dir), null)
  })
})

test('prunes snapshots and temp files older than the retention window', async () => {
  await withDir(async (dir) => {
    const now = Date.now()
    const old = new Date(now - 31 * 24 * 60 * 60 * 1000)
    for (const name of ['old.json', 'crash.json.12.tmp', 'fresh.json', 'notes.txt']) {
      await writeFile(join(dir, name), '{}')
    }
    await utimes(join(dir, 'old.json'), old, old)
    await utimes(join(dir, 'crash.json.12.tmp'), old, old)
    await utimes(join(dir, 'notes.txt'), old, old)
    await pruneContextSnapshots(dir, now)
    assert.deepEqual((await readdir(dir)).sort(), ['fresh.json', 'notes.txt'])
  })
})

test('prunes old cache mode files with the snapshots', async () => {
  await withDir(async (dir) => {
    const now = Date.now()
    const old = new Date(now - 31 * 24 * 60 * 60 * 1000)
    for (const name of ['old.mode', 'fresh.mode']) await writeFile(join(dir, name), '{}')
    await utimes(join(dir, 'old.mode'), old, old)
    await pruneContextSnapshots(dir, now)
    assert.deepEqual(await readdir(dir), ['fresh.mode'])
  })
})
