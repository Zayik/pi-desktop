import { DatabaseSync } from 'node:sqlite'
import { copyFile, mkdir, readdir, readFile, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join, relative, sep } from 'path'
import { analyzeSession, SESSION_ANALYTICS_VERSION, type AnalyticsSource, type SessionAnalytics } from '../shared/session-analytics'
import { analyzeClaudeCodeSession } from '../shared/claude-code-session'
import { analyzeCodexSession } from '../shared/codex-session'
import { analyzeCopilotSession } from '../shared/copilot-session'
import {
  buildReport,
  rangeStart,
  type AnalyticsReport,
  type AnalyticsSessionKind,
  type IndexedSession,
  type OverviewRequest,
} from '../shared/analytics-report'
import { getGuiDataPath } from './app-data-paths'
import { getImportRoots, getSessionRoots, type ImportRoot } from './pi-paths'
import { JSONL_EXTENSION } from './session-paths'
import { parseSessionLines } from './session-jsonl'
import { mapWithConcurrency } from './map-concurrent'
import { pathsEqual } from '../shared/path-compare'

const DB_FILE_NAME = 'analytics.sqlite'
const ARCHIVE_DIR_NAME = 'analytics-archive'
/** billion-context's delegate sessions: `<tmp>/acp-delegate/<run id>.session.jsonl`. */
const DELEGATE_DIR_NAME = 'acp-delegate'
const DELEGATE_SESSION_SUFFIX = '.session.jsonl'
/** Larger files are left out rather than read whole. */
const MAX_SESSION_BYTES = 64 * 1024 * 1024
/** pi-subagents nests children a few folders under the chat file's folder. */
const MAX_SCAN_DEPTH = 8
const SCAN_CONCURRENCY = 4
/** A full scan at most this often, unless asked for. */
const SCAN_INTERVAL_MS = 30_000
/** Delegates can start delegates; follow children this many levels. */
const MAX_CHILD_DEPTH = 4
const SCHEMA_VERSION = '1'

interface Row {
  file: string
  session_id: string
  mtime_ms: number
  size: number
  version: number
  kind: string
  parent_file: string | null
  run_id: string | null
  cwd: string | null
  started_at: number | null
  last_at: number | null
  cost: number
  file_exists: number
  source: string
  facts: string
}

export interface SourceSummary {
  source: AnalyticsSource
  sessions: number
  firstAt: number | null
  lastAt: number | null
  cost: number
}

export interface AnalyticsIndexOptions {
  dbPath?: string
  sessionRoots?: string[]
  /** Other tools' session folders, read beside Pi's; empty to leave them out. */
  importRoots?: ImportRoot[]
  /** Where billion-context writes delegate sessions (the OS temp folder clears them). */
  delegateDir?: string
  /** Where delegate sessions are kept once copied out of the temp folder. */
  archiveDir?: string
}

/**
 * Lifetime analytics over every saved session. The session files stay the
 * source of truth: this keeps one row of facts per file, read again only when
 * the file changes, so a full rebuild is always possible. Rows outlive their
 * files, so deleting a session keeps its history. Delegate sessions live in
 * the temp folder, so they are copied into the archive before they are read.
 */
export class AnalyticsIndex {
  private readonly db: DatabaseSync
  private readonly sessionRoots: string[]
  private readonly importRoots: ImportRoot[]
  private readonly delegateDir: string
  private readonly archiveDir: string
  private lastScanAt = 0
  private scanning: Promise<void> | null = null

  constructor(options: AnalyticsIndexOptions = {}) {
    this.sessionRoots = options.sessionRoots ?? getSessionRoots()
    this.importRoots = options.importRoots ?? getImportRoots()
    this.delegateDir = options.delegateDir ?? join(tmpdir(), DELEGATE_DIR_NAME)
    this.archiveDir = options.archiveDir ?? join(getGuiDataPath(ARCHIVE_DIR_NAME), DELEGATE_DIR_NAME)
    this.db = new DatabaseSync(options.dbPath ?? getGuiDataPath(DB_FILE_NAME))
    this.migrate()
  }

  close(): void {
    this.db.close()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        file TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL,
        version INTEGER NOT NULL,
        kind TEXT NOT NULL,
        parent_file TEXT,
        run_id TEXT,
        cwd TEXT,
        started_at INTEGER,
        last_at INTEGER,
        cost REAL NOT NULL,
        file_exists INTEGER NOT NULL,
        facts TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_last_at ON sessions (last_at);
      CREATE INDEX IF NOT EXISTS sessions_parent ON sessions (parent_file);
      CREATE INDEX IF NOT EXISTS sessions_run ON sessions (run_id);
    `)
    const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as unknown as { name: string }[]
    if (!columns.some((column) => column.name === 'source')) this.db.exec(`ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'pi'`)
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema', SCHEMA_VERSION)
  }

  /** Read every changed session file. Runs one scan at a time; recent scans are reused unless forced. */
  async refresh(force = false, now = Date.now()): Promise<void> {
    if (this.scanning) return this.scanning
    if (!force && now - this.lastScanAt < SCAN_INTERVAL_MS) return
    this.scanning = this.scan().finally(() => {
      this.lastScanAt = Date.now()
      this.scanning = null
    })
    return this.scanning
  }

  private async scan(): Promise<void> {
    await this.archiveDelegates()
    const files: string[] = []
    for (const root of this.sessionRoots) files.push(...await jsonlFilesUnder(root, MAX_SCAN_DEPTH))
    for (const { root, depth } of this.importRoots) files.push(...await jsonlFilesUnder(root, depth))
    files.push(...await jsonlFilesUnder(this.archiveDir, 0))
    const seen = new Set(files)
    await mapWithConcurrency(files, SCAN_CONCURRENCY, (file) => this.indexFile(file))
    // Rows whose file is gone keep their facts; they are only marked.
    const rows = this.db.prepare('SELECT file FROM sessions WHERE file_exists = 1').all() as unknown as { file: string }[]
    const markGone = this.db.prepare('UPDATE sessions SET file_exists = 0 WHERE file = ?')
    for (const { file } of rows) if (!seen.has(file) && !existsSync(file)) markGone.run(file)
  }

  /**
   * Read every file again. Rows of deleted files are kept: their facts can
   * no longer be rebuilt, and their history is the point of keeping them.
   */
  async rebuild(): Promise<void> {
    await this.scanning
    this.db.prepare('DELETE FROM sessions WHERE file_exists = 1').run()
    await this.refresh(true)
  }

  /** Copy delegate sessions out of the temp folder, so they outlive it. */
  private async archiveDelegates(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.delegateDir)
    } catch {
      return
    }
    await mkdir(this.archiveDir, { recursive: true })
    for (const name of names) {
      if (!name.endsWith(DELEGATE_SESSION_SUFFIX)) continue
      const source = join(this.delegateDir, name)
      const target = join(this.archiveDir, name)
      try {
        const [from, to] = await Promise.all([stat(source), stat(target).catch(() => null)])
        if (from.isFile() && (!to || to.size !== from.size || to.mtimeMs < from.mtimeMs)) await copyFile(source, target)
      } catch {
        // Removed while copying; the next scan tries again.
      }
    }
  }

  /** Read one session file if it changed since its row was written. */
  async indexFile(file: string): Promise<void> {
    let info
    try {
      info = await stat(file)
    } catch {
      return
    }
    if (!info.isFile() || info.size > MAX_SESSION_BYTES) return
    const known = this.db.prepare('SELECT mtime_ms, size, version, file_exists FROM sessions WHERE file = ?').get(file) as
      | { mtime_ms: number; size: number; version: number; file_exists: number }
      | undefined
    if (known && known.mtime_ms === info.mtimeMs && known.size === info.size && known.version === SESSION_ANALYTICS_VERSION) {
      if (!known.file_exists) this.db.prepare('UPDATE sessions SET file_exists = 1 WHERE file = ?').run(file)
      return
    }
    const source = this.sourceOf(file)
    let facts: SessionAnalytics | null
    try {
      const lines = parseSessionLines(await readFile(file, 'utf8'))
      facts = source === 'claude-code' ? analyzeClaudeCodeSession(lines, file)
        : source === 'codex' ? analyzeCodexSession(lines, file)
          : source === 'copilot' ? analyzeCopilotSession(lines, file)
            : analyzeSession(lines, file)
    } catch {
      return
    }
    if (!facts) return
    const { kind, parentFile, runId } = this.placeSession(file, facts)
    this.db.prepare(`
      INSERT OR REPLACE INTO sessions
        (file, session_id, mtime_ms, size, version, kind, parent_file, run_id, cwd, started_at, last_at, cost, file_exists, source, facts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      file, facts.sessionId, info.mtimeMs, info.size, SESSION_ANALYTICS_VERSION, kind, parentFile, runId,
      facts.cwd, facts.startedAt, facts.lastActivityAt, facts.cost, source, JSON.stringify(facts)
    )
  }

  /** The tool that wrote a file, by the folder it is in. */
  private sourceOf(file: string): AnalyticsSource {
    return this.importRoots.find(({ root }) => isInside(file, root))?.source ?? 'pi'
  }

  /** Sessions read from each tool, with the time they span, for `pi-analytics sources`. */
  sources(): SourceSummary[] {
    const rows = this.db.prepare(`
      SELECT source, COUNT(*) AS sessions, MIN(started_at) AS first_at, MAX(last_at) AS last_at, SUM(cost) AS cost
      FROM sessions GROUP BY source ORDER BY source
    `).all() as unknown as { source: AnalyticsSource; sessions: number; first_at: number | null; last_at: number | null; cost: number | null }[]
    return rows.map((row) => ({ source: row.source, sessions: row.sessions, firstAt: row.first_at, lastAt: row.last_at, cost: row.cost ?? 0 }))
  }

  /** The folders each tool's sessions are read from. */
  roots(): { source: AnalyticsSource; root: string }[] {
    return [
      ...this.sessionRoots.map((root) => ({ source: 'pi' as const, root })),
      ...this.importRoots.map(({ source, root }) => ({ source, root })),
    ]
  }

  /**
   * Where a session sits: a delegate (by its run id), a pi-subagents child
   * (in a folder named after its chat file), a fork or harness child (its
   * header names a parent), or a root.
   */
  private placeSession(file: string, facts: SessionAnalytics): { kind: AnalyticsSessionKind; parentFile: string | null; runId: string | null } {
    if (pathsEqual(dirname(file), this.archiveDir) && basename(file).endsWith(DELEGATE_SESSION_SUFFIX)) {
      return { kind: 'delegate', parentFile: null, runId: basename(file, DELEGATE_SESSION_SUFFIX) }
    }
    // Claude Code keeps subagents beside their session the way pi-subagents does.
    const chat = subagentParentFile(file, [...this.sessionRoots, ...this.importRoots.filter((root) => root.source === 'claude-code').map(({ root }) => root)])
    if (chat) return { kind: 'subagent', parentFile: chat, runId: null }
    if (facts.parentSession) return { kind: 'child', parentFile: facts.parentSession, runId: null }
    return { kind: 'main', parentFile: null, runId: null }
  }

  /** A session and every agent session that belongs to it. */
  async sessionReport(sessionFile: string): Promise<AnalyticsReport | null> {
    await this.indexFile(sessionFile)
    await this.archiveDelegates()
    const root = this.row(sessionFile)
    if (!root) return null
    const sessions: IndexedSession[] = [toIndexed(root, 'main', null)]
    const visited = new Set([root.file])
    let level: Row[] = [root]
    for (let depth = 0; depth < MAX_CHILD_DEPTH && level.length > 0; depth++) {
      const next: Row[] = []
      for (const parent of level) {
        for (const child of await this.childrenOf(parent)) {
          if (visited.has(child.row.file)) continue
          visited.add(child.row.file)
          sessions.push(toIndexed(child.row, child.row.kind as AnalyticsSessionKind, child.agentName))
          next.push(child.row)
        }
      }
      level = next
    }
    return buildReport('session', sessions)
  }

  /** Every session active in the range, optionally in one project. */
  async overview(request: OverviewRequest, now = Date.now()): Promise<AnalyticsReport> {
    await this.refresh(false, now)
    const from = rangeStart(request.range, now)
    const rows = (from === null
      ? this.db.prepare('SELECT * FROM sessions').all()
      : this.db.prepare('SELECT * FROM sessions WHERE last_at >= ?').all(from)) as unknown as Row[]
    const project = request.projectPath
    const inProject = (cwd: string | null): boolean =>
      project === null || (cwd !== null && (pathsEqual(cwd, project) || isInside(cwd, project)))
    const agentNames = delegateAgentNames(rows)
    const sessions = rows
      .filter((row) => inProject(row.cwd))
      .map((row) => toIndexed(row, row.kind as AnalyticsSessionKind, row.run_id ? agentNames.get(row.run_id) ?? null : null))
    return buildReport('overall', sessions, from, from === null ? null : now)
  }

  private row(file: string): Row | null {
    return (this.db.prepare('SELECT * FROM sessions WHERE file = ?').get(file) as unknown as Row | undefined) ?? null
  }

  private async childrenOf(parent: Row): Promise<{ row: Row; agentName: string | null }[]> {
    const children: { row: Row; agentName: string | null }[] = []
    // pi-subagents children and forks name the parent file; read new ones first.
    for (const file of await jsonlFilesUnder(join(dirname(parent.file), basename(parent.file, JSONL_EXTENSION)), MAX_SCAN_DEPTH)) {
      await this.indexFile(file)
    }
    const named = this.db.prepare('SELECT * FROM sessions WHERE parent_file = ? OR parent_file = ?').all(parent.file, basename(parent.file)) as unknown as Row[]
    for (const row of named) children.push({ row, agentName: null })
    const facts = JSON.parse(parent.facts) as SessionAnalytics
    for (const run of facts.delegateRuns) {
      const file = join(this.archiveDir, `${run.runId}${DELEGATE_SESSION_SUFFIX}`)
      await this.indexFile(file)
      const row = this.row(file)
      if (row) children.push({ row, agentName: run.agent })
    }
    return children
  }
}

function toIndexed(row: Row, kind: AnalyticsSessionKind, agentName: string | null): IndexedSession {
  return { kind, agentName, fileExists: row.file_exists === 1, facts: JSON.parse(row.facts) as SessionAnalytics }
}

/** Delegate roles, from the tool calls of the sessions that started them. */
function delegateAgentNames(rows: Row[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const row of rows) {
    if (!row.facts.includes('"delegateRuns":[{')) continue
    const facts = JSON.parse(row.facts) as SessionAnalytics
    for (const run of facts.delegateRuns) if (run.agent) names.set(run.runId, run.agent)
  }
  return names
}

function isInside(path: string, folder: string): boolean {
  const rel = relative(folder, path)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel)
}

/**
 * The chat a pi-subagents child belongs to: its files sit under
 * `<chat file without .jsonl>/`, below a project folder of the store.
 */
export function subagentParentFile(file: string, roots: string[]): string | null {
  const root = roots.find((candidate) => isInside(file, candidate))
  if (!root) return null
  // A chat is <root>/<project>/<chat>.jsonl; the nearest folder with a chat file beside it is the parent.
  let dir = dirname(file)
  while (isInside(dir, root)) {
    const chat = `${dir}${JSONL_EXTENSION}`
    if (existsSync(chat)) return chat
    dir = dirname(dir)
  }
  return null
}

async function jsonlFilesUnder(dir: string, depth: number): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory() && depth > 0) found.push(...await jsonlFilesUnder(path, depth - 1))
    else if (entry.isFile() && entry.name.endsWith(JSONL_EXTENSION)) found.push(path)
  }
  return found
}

let shared: AnalyticsIndex | null = null

/** The app's index, opened on first use. */
export function getAnalyticsIndex(): AnalyticsIndex {
  shared ??= new AnalyticsIndex()
  return shared
}
