import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, X } from 'lucide-react'
import type { ContextSnapshot } from '../../../../resources/context-snapshot'
import type { AgentBoard, AgentBoardRequest } from '../../../shared/agent-board'
import { useAppStore } from '../store'
import { AgentBoardView, StopWarmingContext, taskSessionFile } from './agent-board-view'

/** The Context panel re-reads the session's snapshot this often while it is open. */
const SNAPSHOT_POLL_MS = 2_000
/** Reading every agent's session file costs more, so the board refreshes a little slower. */
const BOARD_POLL_MS = 3_000

/** The active session's context snapshot, re-read while the panel is open. */
function useContextSnapshot(sessionId: string | null): { snapshot: ContextSnapshot | null; loaded: boolean } {
  const [state, setState] = useState<{ sessionId: string | null; snapshot: ContextSnapshot | null; loaded: boolean }>({
    sessionId: null,
    snapshot: null,
    loaded: false,
  })
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    const load = (): void => {
      window.piDesktop.context.getSnapshot(sessionId)
        .then((snapshot) => {
          if (!cancelled) setState({ sessionId, snapshot, loaded: true })
        })
        .catch(() => {
          if (!cancelled) setState((previous) => ({ ...previous, sessionId, loaded: true }))
        })
    }
    load()
    const id = setInterval(load, SNAPSHOT_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [sessionId])
  // A snapshot of the previous session never shows under the new one.
  return state.sessionId === sessionId ? state : { snapshot: null, loaded: false }
}

/** The chat's agents board, re-read while the panel is open. */
function useAgentBoard(request: AgentBoardRequest | null): AgentBoard | null {
  const [state, setState] = useState<{ sessionId: string | null; board: AgentBoard | null }>({ sessionId: null, board: null })
  // Re-subscribe only when the request's content changes, not on every render.
  const key = request ? JSON.stringify(request) : null
  useEffect(() => {
    if (!key) return
    const parsed = JSON.parse(key) as AgentBoardRequest
    let cancelled = false
    const load = (): void => {
      window.piDesktop.context.getAgentBoard(parsed)
        .then((board) => {
          if (!cancelled) setState({ sessionId: parsed.sessionId, board })
        })
        .catch(() => {
          // Keep the last board; the next poll retries.
        })
    }
    load()
    const id = setInterval(load, BOARD_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [key])
  // A board of the previous chat never shows under the new one.
  return request && state.sessionId === request.sessionId ? state.board : null
}

/** Right-side Context panel: every agent of this chat, what fills its context, its prompt cache, and what calls cost. */
export function ContextPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const sessionId = useAppStore((state) => state.sessionState?.sessionId ?? null)
  const sessionFile = useAppStore((state) => state.sessionState?.sessionFile ?? null)
  const tasks = useAppStore((state) => state.subagentTasks)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const mainEffort = useAppStore((state) => state.sessionState?.thinkingLevel || null)
  const { snapshot, loaded } = useContextSnapshot(sessionId)
  const subagentFiles = useMemo(
    () => tasks.map(taskSessionFile).filter((file): file is string => file !== null).sort(),
    [tasks]
  )
  const request = useMemo<AgentBoardRequest | null>(
    () => (sessionId ? { sessionId, sessionFile, subagentSessionFiles: subagentFiles } : null),
    [sessionId, sessionFile, subagentFiles]
  )
  const board = useAgentBoard(request)
  const engine = useAppStore((state) => state.piEngine)
  // `/done` and `/away` come from pi-analytics, which Pi Desktop loads into Pi (not OMP); they reach the open chat only.
  const stopWarming = engine === 'pi' && !isStreaming
    ? (target: string, command: 'done' | 'away'): void => {
        if (target === useAppStore.getState().sessionState?.sessionId) void useAppStore.getState().sendPrompt(`/${command}`)
      }
    : null
  const [popOutError, setPopOutError] = useState<string | null>(null)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-medium text-secondary">{t('chat.contextPanel.title')}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void window.piDesktop.context.openSessionPage(sessionId).catch((error: unknown) => setPopOutError(error instanceof Error ? error.message : String(error)))}
          className="flex h-6 w-6 items-center justify-center rounded text-faint hover:text-muted"
          title={t('chat.contextPanel.openInBrowser')}
          aria-label={t('chat.contextPanel.openInBrowser')}
        >
          <ExternalLink size={13} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded text-faint hover:text-muted"
          title={t('chat.contextPanel.close')}
          aria-label={t('chat.contextPanel.close')}
        >
          <X size={13} />
        </button>
      </div>
      {popOutError && <p className="border-b border-border bg-error-bg px-3 py-1.5 text-[11px] text-error">{popOutError}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {!sessionId ? (
          <p className="py-6 text-center text-xs text-dim">{t('chat.contextPanel.noSession')}</p>
        ) : !snapshot && !board?.main ? (
          <p className="py-6 text-center text-xs text-dim">
            {loaded ? t('chat.contextPanel.noSnapshot') : t('chat.contextPanel.loading')}
          </p>
        ) : (
          <StopWarmingContext.Provider value={stopWarming}>
            <AgentBoardView snapshot={snapshot} board={board} tasks={tasks} isStreaming={isStreaming} mainEffort={mainEffort} />
          </StopWarmingContext.Provider>
        )}
      </div>
    </div>
  )
}

