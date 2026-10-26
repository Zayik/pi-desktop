import type { ContextSnapshot } from '../../../../resources/context-snapshot'
import type { AgentBoard } from '../../../../src/shared/agent-board'

export const LIVE_ENVELOPE_VERSION = 1

/**
 * working / idle: the Pi process is running, in a turn or between turns.
 * ended: the session closed (Pi quit, or moved to another session).
 * stopped: the process is gone without closing the session, as after a crash.
 * history: a saved session the recorder never saw, read from Pi's session log.
 */
export type LiveSessionState = 'working' | 'idle' | 'ended' | 'stopped' | 'history'

export interface LiveSessionRow {
  sessionId: string
  sessionFile: string | null
  /** The session's name, else the first line of its first prompt. */
  title: string | null
  cwd: string | null
  state: LiveSessionState
  /** `provider/model` of the latest call or selection. */
  model: string | null
  /** Unknown (null) for a session read only from its log. */
  cost: number | null
  /** Share of the model's context window the next request fills, 0-100. */
  contextPercent: number | null
  activeTool: string | null
  /** The session that started this one, when it is listed too. */
  parentSessionId: string | null
  updatedAt: number
}

export interface LiveSessionsEnvelope {
  kind: 'live-sessions'
  version: typeof LIVE_ENVELOPE_VERSION
  data: {
    sessions: LiveSessionRow[]
    /** The chat open in Pi Desktop, while it shares that. */
    desktopFocus: string | null
    generatedAt: number
  }
}

export interface LiveSessionEnvelope {
  kind: 'live-session'
  version: typeof LIVE_ENVELOPE_VERSION
  data: {
    sessionId: string
    row: LiveSessionRow | null
    snapshot: ContextSnapshot | null
    board: AgentBoard | null
    generatedAt: number
  }
}

/** `<analytics dir>/server.json`: where the running helper listens. */
export interface ServerInfo {
  app: 'pi-analytics'
  pid: number
  port: number
  startedAt: number
  version: number
}

export const SERVER_INFO_VERSION = 1
