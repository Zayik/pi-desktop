import { readdir, readFile, rm, stat } from 'fs/promises'
import { join } from 'path'
import { getGuiDataPath } from './app-data-paths'
import { isContextSnapshot, snapshotFileName, type ContextSnapshot } from '../../resources/context-snapshot'

const CONTEXT_DIR_NAME = 'context-snapshots'
/** A snapshot file is small, but an unbounded one would be read whole on every poll. */
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
/** Snapshots of sessions untouched this long are removed at startup. */
const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** Folder the context extension writes snapshots to (passed to the agent as `PI_DESKTOP_CONTEXT_DIR`). */
export function getContextSnapshotDir(): string {
  return getGuiDataPath(CONTEXT_DIR_NAME)
}

interface CachedSnapshot {
  mtimeMs: number
  size: number
  value: ContextSnapshot | null
}

const cache = new Map<string, CachedSnapshot>()

/**
 * The snapshot the context extension wrote for a session, or null when there
 * is none yet (the session has not started under this app, or the extension
 * could not run). Parsed files are cached by mtime and size, since the
 * Context panel polls.
 */
export async function readContextSnapshot(sessionId: string, dir = getContextSnapshotDir()): Promise<ContextSnapshot | null> {
  const path = join(dir, snapshotFileName(sessionId))
  let info
  try {
    info = await stat(path)
  } catch {
    cache.delete(path)
    return null
  }
  if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES) return null
  const cached = cache.get(path)
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.value
  let value: ContextSnapshot | null
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    // The file name is derived from the id, so check the id inside matches.
    value = isContextSnapshot(parsed) && parsed.sessionId === sessionId ? parsed : null
  } catch {
    value = null
  }
  cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, value })
  return value
}

/** Remove snapshots (and temp files a crash left behind) older than the retention window. */
export async function pruneContextSnapshots(dir = getContextSnapshotDir(), now = Date.now()): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  await Promise.all(names.map(async (name) => {
    if (!name.endsWith('.json') && !name.endsWith('.tmp')) return
    const path = join(dir, name)
    try {
      const info = await stat(path)
      if (info.isFile() && now - info.mtimeMs > SNAPSHOT_RETENTION_MS) await rm(path, { force: true })
    } catch {
      // Another process may have removed or replaced it; nothing to do.
    }
  }))
}
