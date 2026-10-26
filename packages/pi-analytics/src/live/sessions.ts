/**
 * The sessions the page lists and the data it shows for one, read from the
 * files the recorder writes (one snapshot per session) and from Pi's own
 * session logs. Nothing here writes; a Pi session's only job is its snapshot.
 */
import { open, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { contextTokens, contextWindow } from '../../../../src/shared/context-view'
import { parseSessionLines } from '../../../../src/main/session-jsonl'
import { JSONL_EXTENSION } from '../../../../src/main/session-paths'
import { getSessionRoots } from '../../../../src/main/pi-paths'
import { listContextSnapshots, readContextSnapshot } from '../../../../src/main/context-snapshots'
import { readAgentBoard } from '../../../../src/main/agent-board'
import type { ContextSnapshot } from '../../../../resources/context-snapshot'
import { LivenessTracker, type LivenessDeps } from './liveness'
import { LIVE_ENVELOPE_VERSION, type LiveSessionEnvelope, type LiveSessionRow, type LiveSessionState } from './envelope'

/** Sessions touched this long ago or less are listed. */
export const LIST_WINDOW_MS = 7 * 24 * 60 * 60_000
export const MAX_LISTED_SESSIONS = 200
/** A snapshot from before the recorder named its process counts as running while it changed this recently. */
const UNTRACKED_RECENT_MS = 45_000
const HEADER_BYTES = 64 * 1024
const MAX_TITLE_CHARS = 120

export interface LiveSessionsOptions {
  contextDir: string
  /** Pi's (and OMP's) session folders, for sessions the recorder never saw. */
  sessionRoots?: string[]
  liveness?: LivenessDeps
}

interface SessionHead {
  sessionId: string | null
  cwd: string | null
  title: string | null
}

interface CachedHead {
  mtimeMs: number
  value: SessionHead
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstLine(content: unknown): string | null {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('\n')
      : ''
  const line = text.split('\n').map((part) => part.trim()).find(Boolean)
  if (!line) return null
  return line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS - 1)}…` : line
}

/** The id, folder and first prompt of a session file, from its first lines. */
export function parseSessionHead(text: string): SessionHead {
  // The last line may be cut off at the read limit; parseSessionLines drops it.
  const entries = parseSessionLines(text)
  const header = entries.find((entry) => entry.type === 'session')
  let name: string | null = null
  let prompt: string | null = null
  for (const entry of entries) {
    if (entry.type === 'session_info' && typeof entry.name === 'string') name = entry.name || null
    if (!prompt && entry.type === 'message' && isRecord(entry.message) && entry.message.role === 'user') prompt = firstLine(entry.message.content)
  }
  return {
    sessionId: typeof header?.id === 'string' ? header.id : null,
    cwd: typeof header?.cwd === 'string' ? header.cwd : null,
    title: name ?? prompt,
  }
}

function modelLabel(snapshot: ContextSnapshot): string | null {
  const last = snapshot.calls.at(-1)
  if (snapshot.model) return `${snapshot.model.provider}/${snapshot.model.id}`
  return last ? `${last.provider}/${last.model}` : null
}

function contextPercent(snapshot: ContextSnapshot): number | null {
  const tokens = contextTokens(snapshot)
  const window = contextWindow(snapshot)
  return tokens !== null && window ? Math.min(100, Math.round((tokens / window) * 100)) : null
}

const STATE_ORDER: Record<LiveSessionState, number> = { working: 0, idle: 1, stopped: 2, ended: 2, history: 2 }

export function sortRows(rows: LiveSessionRow[]): LiveSessionRow[] {
  return rows.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.updatedAt - a.updatedAt)
}

export class LiveSessions {
  private readonly liveness: LivenessTracker
  private readonly heads = new Map<string, CachedHead>()
  private readonly contextDir: string
  private readonly sessionRoots: string[]

  constructor(options: LiveSessionsOptions) {
    this.contextDir = options.contextDir
    this.sessionRoots = options.sessionRoots ?? getSessionRoots()
    this.liveness = new LivenessTracker(options.liveness)
  }

  /** A session file's head, read again only when the file changed and had no title yet. */
  private async head(path: string, mtimeMs: number): Promise<SessionHead> {
    const cached = this.heads.get(path)
    if (cached && (cached.mtimeMs === mtimeMs || cached.value.title)) return cached.value
    let value: SessionHead = { sessionId: null, cwd: null, title: null }
    try {
      const handle = await open(path, 'r')
      try {
        const buffer = Buffer.alloc(HEADER_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0)
        value = parseSessionHead(buffer.subarray(0, bytesRead).toString('utf8'))
      } finally {
        await handle.close()
      }
    } catch {
      // Removed or unreadable: listed without a title.
    }
    this.heads.set(path, { mtimeMs, value })
    return value
  }

  /** Session files in Pi's folders changed since `since`, newest first, at most `limit`. */
  private async recentSessionFiles(since: number, limit: number): Promise<{ path: string; mtimeMs: number }[]> {
    const files: { path: string; mtimeMs: number }[] = []
    for (const root of this.sessionRoots) {
      let projects
      try {
        projects = await readdir(root, { withFileTypes: true })
      } catch {
        continue
      }
      for (const project of projects) {
        if (!project.isDirectory()) continue
        const dir = join(root, project.name)
        let names: string[]
        try {
          names = await readdir(dir)
        } catch {
          continue
        }
        for (const name of names) {
          if (!name.endsWith(JSONL_EXTENSION)) continue
          const path = join(dir, name)
          try {
            const info = await stat(path)
            if (info.isFile() && info.mtimeMs >= since) files.push({ path, mtimeMs: info.mtimeMs })
          } catch {
            // Removed while listing.
          }
        }
      }
    }
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)
  }

  private async stateOf(snapshots: ContextSnapshot[], now: number): Promise<Map<string, LiveSessionState>> {
    const refs = snapshots.flatMap((snapshot) => (snapshot.process && !snapshot.endedAt ? [snapshot.process] : []))
    const alive = await this.liveness.check(refs)
    const states = new Map<string, LiveSessionState>()
    for (const snapshot of snapshots) {
      let state: LiveSessionState
      if (snapshot.endedAt) state = 'ended'
      else if (snapshot.process) state = !alive.has(LivenessTracker.key(snapshot.process)) ? 'stopped' : snapshot.agentRunning ? 'working' : 'idle'
      else state = now - snapshot.updatedAt < UNTRACKED_RECENT_MS ? 'idle' : 'ended'
      states.set(snapshot.sessionId, state)
    }
    return states
  }

  private async rowOf(snapshot: ContextSnapshot, state: LiveSessionState): Promise<LiveSessionRow> {
    let title = snapshot.sessionName ?? null
    let cwd = snapshot.process?.cwd ?? null
    if ((!title || !cwd) && snapshot.sessionFile) {
      try {
        const head = await this.head(snapshot.sessionFile, (await stat(snapshot.sessionFile)).mtimeMs)
        title ??= head.title
        cwd ??= head.cwd
      } catch {
        // The session file is gone; the snapshot still has the figures.
      }
    }
    return {
      sessionId: snapshot.sessionId,
      sessionFile: snapshot.sessionFile,
      title,
      cwd,
      state,
      model: modelLabel(snapshot),
      cost: snapshot.totals.cost,
      contextPercent: contextPercent(snapshot),
      activeTool: state === 'working' ? snapshot.activeTool ?? null : null,
      parentSessionId: snapshot.parentSessionId ?? null,
      updatedAt: snapshot.updatedAt,
    }
  }

  /** Every session touched in the last week: the recorded ones, then the rest of Pi's log. */
  async list(now = Date.now()): Promise<LiveSessionRow[]> {
    const since = now - LIST_WINDOW_MS
    const snapshots = await listContextSnapshots(this.contextDir, since)
    const states = await this.stateOf(snapshots, now)
    const rows = await Promise.all(snapshots.map((snapshot) => this.rowOf(snapshot, states.get(snapshot.sessionId) ?? 'ended')))
    const recorded = new Set(rows.map((row) => row.sessionId))
    const recordedFiles = new Set(rows.flatMap((row) => (row.sessionFile ? [row.sessionFile] : [])))
    for (const file of await this.recentSessionFiles(since, MAX_LISTED_SESSIONS)) {
      if (recordedFiles.has(file.path)) continue
      const head = await this.head(file.path, file.mtimeMs)
      if (!head.sessionId || recorded.has(head.sessionId)) continue
      recorded.add(head.sessionId)
      rows.push({
        sessionId: head.sessionId,
        sessionFile: file.path,
        title: head.title,
        cwd: head.cwd,
        state: 'history',
        model: null,
        cost: null,
        contextPercent: null,
        activeTool: null,
        parentSessionId: null,
        updatedAt: file.mtimeMs,
      })
    }
    for (const row of rows) if (row.parentSessionId && !recorded.has(row.parentSessionId)) row.parentSessionId = null
    return sortRows(rows).slice(0, MAX_LISTED_SESSIONS)
  }

  /** What the page shows for one session: its snapshot, and the board of it and the agents it started. */
  async session(sessionId: string, rows: LiveSessionRow[], now = Date.now()): Promise<LiveSessionEnvelope> {
    const row = rows.find((candidate) => candidate.sessionId === sessionId) ?? null
    const snapshot = await readContextSnapshot(sessionId, this.contextDir)
    const sessionFile = snapshot?.sessionFile ?? row?.sessionFile ?? null
    let board = null
    if (sessionFile) {
      try {
        board = await readAgentBoard({ sessionId, sessionFile, subagentSessionFiles: [] }, now, this.contextDir)
      } catch {
        board = null
      }
    }
    return {
      kind: 'live-session',
      version: LIVE_ENVELOPE_VERSION,
      data: { sessionId, row, snapshot, board, generatedAt: now },
    }
  }
}
