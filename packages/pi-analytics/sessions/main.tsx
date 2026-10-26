import React, { useEffect, useMemo, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { I18nextProvider, useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { i18n, type Translate } from '../../../src/shared/i18n'
import { AgentBoardView, formatUsd } from '../../../src/renderer/src/components/agent-board-view'
import { formatRelativeTime } from '../../../src/renderer/src/utils/format-relative-time'
import {
  LIVE_ENVELOPE_VERSION,
  type LiveSessionEnvelope,
  type LiveSessionRow,
  type LiveSessionState,
  type LiveSessionsEnvelope,
} from '../src/live/envelope'
import './sessions.css'

/**
 * The live session page: every Pi session on this machine on the left, and
 * the same board as Pi Desktop's Context panel for the one picked. It only
 * reads; nothing on it changes a session.
 */

function readHash(): { session: string | null; follow: boolean } {
  const params = new URLSearchParams(window.location.hash.slice(1))
  return { session: params.get('session'), follow: params.get('follow') === 'desktop' }
}

function writeHash(session: string | null, follow: boolean): void {
  const params = new URLSearchParams()
  if (session) params.set('session', session)
  if (follow) params.set('follow', 'desktop')
  const hash = params.toString()
  window.history.replaceState(null, '', `${window.location.pathname}${hash ? `#${hash}` : ''}`)
}

/** The latest message of a server stream; the browser reconnects by itself when the helper restarts. */
function useStream<T extends { kind: string; version: number }>(url: string | null, kind: T['kind']): { value: T | null; connected: boolean } {
  const [state, setState] = useState<{ url: string | null; value: T | null; connected: boolean }>({ url: null, value: null, connected: false })
  useEffect(() => {
    if (!url) return
    const source = new EventSource(url)
    source.onopen = () => setState((previous) => ({ ...previous, url, connected: true }))
    source.onerror = () => setState((previous) => ({ ...previous, url, connected: false }))
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        const value = JSON.parse(event.data) as T
        if (value.kind === kind && value.version === LIVE_ENVELOPE_VERSION) setState({ url, value, connected: true })
      } catch {
        // A message this page cannot read; the next one replaces it.
      }
    }
    return () => source.close()
  }, [url, kind])
  return state.url === url ? state : { value: null, connected: false }
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

function stateLabel(state: LiveSessionState, t: Translate): string {
  switch (state) {
    case 'working': return t('sessionPage.state.working')
    case 'idle': return t('sessionPage.state.idle')
    case 'ended': return t('sessionPage.state.ended')
    case 'stopped': return t('sessionPage.state.stopped')
    case 'history': return t('sessionPage.state.history')
  }
}

const STATE_DOT: Record<LiveSessionState, string> = {
  working: 'bg-success animate-pulse',
  idle: 'bg-success',
  ended: 'bg-faint',
  stopped: 'bg-warning',
  history: 'bg-ghost',
}

function folderName(cwd: string | null): string | null {
  if (!cwd) return null
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? cwd
}

function rowTitle(row: LiveSessionRow, t: Translate): string {
  return row.title ?? t('sessionPage.untitled')
}

/** Rows in list order, each followed by the sessions it started. */
function nested(rows: LiveSessionRow[]): { row: LiveSessionRow; depth: number }[] {
  const children = new Map<string, LiveSessionRow[]>()
  for (const row of rows) {
    if (!row.parentSessionId) continue
    const list = children.get(row.parentSessionId) ?? []
    list.push(row)
    children.set(row.parentSessionId, list)
  }
  const out: { row: LiveSessionRow; depth: number }[] = []
  const seen = new Set<string>()
  const add = (row: LiveSessionRow, depth: number): void => {
    if (seen.has(row.sessionId)) return
    seen.add(row.sessionId)
    out.push({ row, depth })
    for (const child of children.get(row.sessionId) ?? []) add(child, Math.min(depth + 1, 3))
  }
  for (const row of rows) if (!row.parentSessionId) add(row, 0)
  // A child whose parent fell off the list still shows.
  for (const row of rows) add(row, 0)
  return out
}

function SessionRowButton({ row, depth, selected, now, onSelect }: {
  row: LiveSessionRow
  depth: number
  selected: boolean
  now: number
  onSelect: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const folder = folderName(row.cwd)
  return (
    <button
      type="button"
      onClick={() => onSelect(row.sessionId)}
      aria-current={selected ? 'true' : undefined}
      className={clsx(
        'flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
        selected ? 'bg-surface-hover' : 'hover:bg-surface'
      )}
      style={depth > 0 ? { paddingLeft: `${0.5 + depth * 0.75}rem` } : undefined}
    >
      <span className={clsx('mt-1.5 h-2 w-2 shrink-0 rounded-full', STATE_DOT[row.state])} title={stateLabel(row.state, t)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-primary">{rowTitle(row, t)}</span>
        <span className="flex gap-1.5 truncate text-[11px] text-dim">
          {row.state === 'working' && row.activeTool ? <span className="truncate text-success">{row.activeTool}</span> : <span>{stateLabel(row.state, t)}</span>}
          {folder && <span className="truncate">· {folder}</span>}
          <span className="ml-auto shrink-0 tabular-nums">{row.cost !== null ? formatUsd(row.cost) : formatRelativeTime(row.updatedAt, now)}</span>
        </span>
      </span>
    </button>
  )
}

function Sidebar({ rows, selected, now, connected, onSelect }: {
  rows: LiveSessionRow[]
  selected: string | null
  now: number
  connected: boolean
  onSelect: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const live = rows.filter((row) => row.state === 'working' || row.state === 'idle')
  const recent = rows.filter((row) => row.state !== 'working' && row.state !== 'idle')
  const group = (label: string, list: LiveSessionRow[]): React.JSX.Element | null => list.length === 0 ? null : (
    <section className="flex flex-col gap-0.5">
      <h2 className="px-2 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-dim">{label} <span className="tabular-nums">{list.length}</span></h2>
      {nested(list).map(({ row, depth }) => (
        <SessionRowButton key={row.sessionId} row={row} depth={depth} selected={row.sessionId === selected} now={now} onSelect={onSelect} />
      ))}
    </section>
  )
  return (
    <aside className="hidden w-72 shrink-0 flex-col border-r border-border md:flex">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <h1 className="text-sm font-semibold text-primary">{t('sessionPage.title')}</h1>
        <span className={clsx('ml-auto flex items-center gap-1.5 text-[11px]', connected ? 'text-dim' : 'text-warning')}>
          <span className={clsx('h-1.5 w-1.5 rounded-full', connected ? 'bg-success' : 'bg-warning')} />
          {connected ? t('sessionPage.live') : t('sessionPage.reconnecting')}
        </span>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label={t('sessionPage.title')}>
        {rows.length === 0 ? <p className="px-2 py-6 text-center text-xs text-dim">{t('sessionPage.none')}</p> : (
          <>
            {group(t('sessionPage.running'), live)}
            {group(t('sessionPage.recent'), recent)}
          </>
        )}
      </nav>
    </aside>
  )
}

/** On a narrow screen the list is a picker above the board. */
function MobilePicker({ rows, selected, onSelect }: { rows: LiveSessionRow[]; selected: string | null; onSelect: (id: string) => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="border-b border-border px-4 py-2 md:hidden">
      <select
        data-themed-select
        value={selected ?? ''}
        onChange={(event) => onSelect(event.target.value)}
        aria-label={t('sessionPage.title')}
        className="w-full rounded-md border border-border-strong bg-surface px-2 py-1.5 text-sm text-primary"
      >
        {!selected && <option value="">{t('sessionPage.pick')}</option>}
        {rows.map((row) => <option key={row.sessionId} value={row.sessionId}>{`${rowTitle(row, t)} · ${stateLabel(row.state, t)}`}</option>)}
      </select>
    </div>
  )
}

function SessionView({ sessionId, row }: { sessionId: string; row: LiveSessionRow | null }): React.JSX.Element {
  const { t } = useTranslation()
  const { value } = useStream<LiveSessionEnvelope>(`/api/session?id=${encodeURIComponent(sessionId)}`, 'live-session')
  const data = value?.data.sessionId === sessionId ? value.data : null
  const current = data?.row ?? row
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          {current && <span className={clsx('h-2 w-2 shrink-0 rounded-full', STATE_DOT[current.state])} />}
          <h2 className="min-w-0 truncate text-base font-semibold text-primary">{current ? rowTitle(current, t) : sessionId}</h2>
        </div>
        <p className="flex flex-wrap gap-x-2 text-xs text-dim">
          {current && <span>{stateLabel(current.state, t)}</span>}
          {current?.model && <span>· {current.model}</span>}
        </p>
        {current?.cwd && <p className="truncate font-mono text-[11px] text-dim" title={current.cwd}>{current.cwd}</p>}
        {current?.state === 'history' && <p className="text-xs text-dim">{t('sessionPage.historyNote')}</p>}
        {current?.state === 'stopped' && <p className="text-xs text-warning">{t('sessionPage.stoppedNote')}</p>}
      </header>
      {!data ? (
        <p className="py-10 text-center text-xs text-dim">{t('sessionPage.loading')}</p>
      ) : !data.snapshot && !data.board?.main ? (
        <p className="py-10 text-center text-xs text-dim">{t('sessionPage.noData')}</p>
      ) : (
        <AgentBoardView
          snapshot={data.snapshot}
          board={data.board}
          tasks={[]}
          isStreaming={current?.state === 'working'}
          mainEffort={data.snapshot?.thinkingLevel ?? null}
        />
      )}
    </div>
  )
}

function Page(): React.JSX.Element {
  const { t } = useTranslation()
  const initial = useMemo(readHash, [])
  const [selected, setSelected] = useState<string | null>(initial.session)
  const [follow, setFollow] = useState(initial.follow)
  const { value, connected } = useStream<LiveSessionsEnvelope>('/api/sessions', 'live-sessions')
  const rows = useMemo(() => value?.data.sessions ?? [], [value])
  const focus = value?.data.desktopFocus ?? null
  const now = useNow(15_000)

  // Following Pi Desktop: its open chat is the one shown.
  useEffect(() => {
    if (follow && focus) setSelected(focus)
  }, [follow, focus])
  // Nothing picked: the busiest session.
  useEffect(() => {
    if (!selected && rows.length > 0) setSelected(rows[0].sessionId)
  }, [selected, rows])
  useEffect(() => writeHash(selected, follow), [selected, follow])

  const pick = (id: string): void => {
    // Picking by hand stops following the app.
    setFollow(false)
    setSelected(id)
  }
  const row = rows.find((candidate) => candidate.sessionId === selected) ?? null

  return (
    <div className="flex h-screen min-h-0 bg-app text-primary">
      <Sidebar rows={rows} selected={selected} now={now} connected={connected} onSelect={pick} />
      <main className="flex min-w-0 flex-1 flex-col">
        <MobilePicker rows={rows} selected={selected} onSelect={pick} />
        {focus && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-b border-border px-4 py-1.5 text-xs text-dim">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
              {t('sessionPage.followDesktop')}
            </label>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {selected ? <SessionView key={selected} sessionId={selected} row={row} /> : (
            <p className="py-16 text-center text-xs text-dim">{connected ? t('sessionPage.none') : t('sessionPage.reconnecting')}</p>
          )}
        </div>
      </main>
    </div>
  )
}

// The address carried the token; the helper has set its cookie, so take it out of the address bar.
if (new URLSearchParams(window.location.search).has('token')) {
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`)
}
document.documentElement.lang = i18n.language

const root = document.getElementById('root')
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <I18nextProvider i18n={i18n}>
        <Page />
      </I18nextProvider>
    </React.StrictMode>,
  )
}
