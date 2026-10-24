import { open, readdir, realpath, stat } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import {
  DELEGATE_RUN_ID,
  summarizeSession,
  type AgentBoard,
  type AgentBoardChild,
  type AgentBoardRequest,
  type AgentSessionSummary,
} from '../shared/agent-board'
import { pathsEqual } from '../shared/path-compare'
import { listGitWorktrees } from './git-worktree'
import { getOmpSessionsRoot, getSessionRoots, isWithinSessionRoots } from './pi-paths'
import { JSONL_EXTENSION, ompSessionDirName, sanitizePath } from './session-paths'
import { parseSessionLines, readSessionEntries } from './session-jsonl'
import { getContextSnapshotDir, listContextSnapshots, readContextSnapshot } from './context-snapshots'

/** Larger session files are left out of the board rather than read whole on every poll. */
const MAX_SESSION_BYTES = 32 * 1024 * 1024
const MAX_CHILDREN = 40
/** Sessions started a little before the main one still count: clocks and file times differ. */
const START_SLACK_MS = 60_000
const WORKTREE_CACHE_MS = 30_000
const HEADER_BYTES = 8 * 1024
/** pi-subagents nests a child's own children under the child's folder; this deep is plenty. */
const MAX_SUBAGENT_DIR_DEPTH = 6
/** Delegates can start delegates; follow that chain this many levels. */
const MAX_DELEGATE_DEPTH = 4
/** billion-context's delegate session files: `<tmp>/acp-delegate/<run id>.session.jsonl`. */
const DELEGATE_DIR_NAME = 'acp-delegate'
const DELEGATE_SESSION_SUFFIX = '.session.jsonl'

interface CachedSummary {
  mtimeMs: number
  size: number
  value: AgentSessionSummary | null
}

const summaryCache = new Map<string, CachedSummary>()
const worktreeCache = new Map<string, { at: number; paths: string[] }>()

/** A session file's summary, cached by mtime and size since the panel polls. */
export async function readSessionSummary(path: string): Promise<AgentSessionSummary | null> {
  let info
  try {
    info = await stat(path)
  } catch {
    summaryCache.delete(path)
    return null
  }
  if (!info.isFile()) return null
  const cached = summaryCache.get(path)
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.value
  const entries = await readSessionEntries(path, MAX_SESSION_BYTES)
  const value = entries ? summarizeSession(entries, path) : null
  summaryCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, value })
  return value
}

/** The session header (first line) alone, for scanning a folder without reading every file. */
async function readHeader(path: string): Promise<Record<string, unknown> | null> {
  let handle
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0)
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)[0]
    return parseSessionLines(firstLine).find((entry) => entry.type === 'session') ?? null
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

/** Session files in a folder written since `since`, newest first. */
async function recentSessionFiles(dir: string, since: number): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const files = await Promise.all(names.filter((name) => name.endsWith(JSONL_EXTENSION)).map(async (name) => {
    const path = join(dir, name)
    try {
      const info = await stat(path)
      return info.isFile() && info.mtimeMs >= since ? { path, mtimeMs: info.mtimeMs } : null
    } catch {
      return null
    }
  }))
  return files
    .filter((file): file is { path: string; mtimeMs: number } => file !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((file) => file.path)
}

/**
 * Session files anywhere under `dir`: pi-subagents keeps a chat's children in
 * `<chat file without .jsonl>/<run id>/run-<n>/` and forks in `.../forks/`.
 */
async function sessionFilesUnder(dir: string, since: number, depth = MAX_SUBAGENT_DIR_DEPTH): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory() && depth > 0) found.push(...await sessionFilesUnder(path, since, depth - 1))
    else if (entry.isFile() && entry.name.endsWith(JSONL_EXTENSION)) {
      try {
        if ((await stat(path)).mtimeMs >= since) found.push(path)
      } catch {
        // Removed while scanning.
      }
    }
  }
  return found
}

/** pi-subagents' folder for a session's children. */
export function subagentDirFor(sessionFile: string): string {
  return join(dirname(sessionFile), basename(sessionFile, JSONL_EXTENSION))
}

/** billion-context's session file for a delegate run, or null for an id it would not write. */
export function delegateSessionFile(runId: string, tempDir = tmpdir()): string | null {
  DELEGATE_RUN_ID.lastIndex = 0
  const match = DELEGATE_RUN_ID.exec(runId)
  if (!match || match[0] !== runId) return null
  return join(tempDir, DELEGATE_DIR_NAME, `${runId}${DELEGATE_SESSION_SUFFIX}`)
}

/** The other worktrees of the repository `cwd` is in; none outside a repository. */
async function otherWorktrees(cwd: string, now: number): Promise<string[]> {
  const cached = worktreeCache.get(cwd)
  if (cached && now - cached.at < WORKTREE_CACHE_MS) return cached.paths
  let paths: string[]
  try {
    paths = (await listGitWorktrees(cwd)).filter((entry) => !entry.bare && !pathsEqual(entry.path, cwd)).map((entry) => entry.path)
  } catch {
    paths = []
  }
  worktreeCache.set(cwd, { at: now, paths })
  return paths
}

/** Every folder Pi or OMP keeps a project's sessions in. */
async function sessionDirsFor(projectPath: string): Promise<string[]> {
  const dirs = getSessionRoots().map((root) => join(root, sanitizePath(projectPath)))
  try {
    const [resolved, home, tmp] = await Promise.all([realpath(projectPath), realpath(homedir()), realpath(tmpdir())])
    dirs.push(join(getOmpSessionsRoot(), ompSessionDirName(resolved, home, tmp)))
  } catch {
    // The worktree is gone; its sessions may still be under the plain name.
  }
  return [...new Set(dirs)]
}

/**
 * The open chat and every session that belongs to it, read from the files
 * the agents already write, so no subagent extension needs changing:
 * - subagent rows the renderer knows about;
 * - pi-subagents children, saved under a folder named after the chat file;
 * - billion-context delegates, found by the run ids in the chat's tool results;
 * - sessions started in the repository's other worktrees since the chat began;
 * - sessions whose header names the chat as parent;
 * - sessions the recorder saw spawned from the chat.
 * Children are searched the same way for their own children. Each carries
 * its recorder snapshot when it has one.
 */
export async function readAgentBoard(
  request: AgentBoardRequest,
  now = Date.now(),
  snapshotDir = getContextSnapshotDir(),
  tempDir = tmpdir()
): Promise<AgentBoard> {
  const mainFile = request.sessionFile && isWithinSessionRoots(request.sessionFile) ? request.sessionFile : null
  const main = mainFile ? await readSessionSummary(mainFile) : null
  const since = (main?.startedAt ?? now) - START_SLACK_MS

  interface Found { kind: AgentBoardChild['kind']; agentName: string | null }
  const found = new Map<string, Found>()
  const add = (path: string, kind: Found['kind'], agentName: string | null = null, trusted = false): void => {
    if (mainFile && pathsEqual(path, mainFile)) return
    // Delegate files sit in the temp folder; their path is built here, never taken from the renderer.
    if (!trusted && !isWithinSessionRoots(path)) return
    const known = found.get(path)
    // A subagent row names the run better than where its file was found.
    if (!known || (kind === 'subagent' && known.kind !== 'subagent')) found.set(path, { kind, agentName: agentName ?? known?.agentName ?? null })
    else if (agentName && !known.agentName) known.agentName = agentName
  }
  const addDelegates = (summary: AgentSessionSummary): void => {
    for (const run of summary.delegateRuns) {
      const path = delegateSessionFile(run.runId, tempDir)
      if (path) add(path, 'subagent', run.agent, true)
    }
  }

  for (const path of request.subagentSessionFiles) add(path, 'subagent')

  if (main && mainFile) {
    addDelegates(main)
    for (const path of await sessionFilesUnder(subagentDirFor(mainFile), since)) add(path, 'subagent')
  }

  if (main?.cwd) {
    const worktrees = await otherWorktrees(main.cwd, now)
    for (const worktree of worktrees) {
      for (const dir of await sessionDirsFor(worktree)) {
        for (const path of await recentSessionFiles(dir, since)) add(path, 'worktree')
      }
    }
    // Sessions next to the chat count only when their header names it as parent.
    for (const dir of await sessionDirsFor(main.cwd)) {
      for (const path of await recentSessionFiles(dir, since)) {
        if (found.has(path) || (mainFile && pathsEqual(path, mainFile))) continue
        const parent = (await readHeader(path))?.parentSession
        if (typeof parent === 'string' && mainFile && (pathsEqual(parent, mainFile) || basename(parent) === basename(mainFile))) add(path, 'child')
      }
    }
  }

  for (const snapshot of await listContextSnapshots(snapshotDir, since)) {
    if (snapshot.parentSessionId === request.sessionId && snapshot.sessionFile) add(snapshot.sessionFile, 'child')
  }

  const children: AgentBoardChild[] = []
  const visited = new Set<string>()
  for (let depth = 0; depth <= MAX_DELEGATE_DEPTH; depth++) {
    const pending = [...found.keys()].filter((path) => !visited.has(path))
    if (pending.length === 0) break
    for (const path of pending) {
      visited.add(path)
      if (children.length >= MAX_CHILDREN) break
      const { kind, agentName } = found.get(path) as Found
      const summary = await readSessionSummary(path)
      if (!summary) continue
      // Worktree sessions that began before the chat are someone else's work.
      if (kind === 'worktree' && summary.startedAt !== null && summary.startedAt < since) continue
      const snapshot = await readContextSnapshot(summary.sessionId, snapshotDir)
      children.push({ kind, agentName, summary, snapshot })
      // A child's own delegates and pi-subagents children belong to the chat too.
      if (depth < MAX_DELEGATE_DEPTH) {
        addDelegates(summary)
        if (isWithinSessionRoots(path)) {
          for (const nested of await sessionFilesUnder(subagentDirFor(path), since)) add(nested, 'subagent')
        }
      }
    }
  }
  children.sort((a, b) => (a.summary.startedAt ?? 0) - (b.summary.startedAt ?? 0))
  return { main, children }
}
