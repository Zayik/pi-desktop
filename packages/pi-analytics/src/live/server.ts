/**
 * The session page's helper: one small local web server per machine that
 * reads the recorder's snapshots and streams them to the page. It runs on its
 * own, apart from any Pi session, so sessions starting and quitting never move
 * it. It answers only on 127.0.0.1, only to requests that carry its token,
 * and only reads. It stops by itself once nothing has needed it for a while.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomBytes, timingSafeEqual } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { pruneContextSnapshots } from '../../../../src/main/context-snapshots'
import { analyticsDir, contextDir } from '../paths'
import { LiveSessions, type LiveSessionsOptions } from './sessions'
import { LIVE_ENVELOPE_VERSION, SERVER_INFO_VERSION, type LiveSessionRow, type LiveSessionsEnvelope, type ServerInfo } from './envelope'

export const DEFAULT_PORT = 47615
export const PORT_ENV = 'PI_ANALYTICS_PORT'
export const SERVER_INFO_FILE = 'server.json'
export const TOKEN_FILE = 'server-token'
/** Pi Desktop writes the chat it has open here while its pop-out page follows it. */
export const DESKTOP_FOCUS_FILE = 'desktop-focus.json'
export const SESSIONS_PAGE_FILE = 'sessions.html'
export const TOKEN_COOKIE = 'pi_analytics_token'
/** With no page open and no session running for this long, the helper stops. */
export const IDLE_EXIT_MS = 10 * 60_000
/** The folder is also scanned on a timer: file watching misses changes on some systems and network drives. */
const SCAN_MS = 1_500
const IDLE_SCAN_MS = 15_000
const WATCH_DEBOUNCE_MS = 100
const HELLO_TIMEOUT_MS = 1_500
const MAX_SESSION_ID_CHARS = 200

export function serverInfoPath(dir = analyticsDir()): string {
  return join(dir, SERVER_INFO_FILE)
}

export function readServerInfo(dir = analyticsDir()): ServerInfo | null {
  try {
    const value = JSON.parse(readFileSync(serverInfoPath(dir), 'utf8')) as Partial<ServerInfo>
    return value.app === 'pi-analytics' && typeof value.port === 'number' && typeof value.pid === 'number' ? value as ServerInfo : null
  } catch {
    return null
  }
}

export function writeAtomic(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, text, mode === undefined ? undefined : { mode })
  renameWithRetry(temp, path)
}

/** Windows can hold a file briefly (a reader, an indexer, antivirus); a rename then fails and succeeds a moment later. */
function renameWithRetry(from: string, to: string, attempts = 5): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= attempts || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * attempt)
    }
  }
}

/** The token the page's address carries. Kept across restarts, so a bookmarked page keeps working. */
export function serverToken(dir = analyticsDir()): string {
  const path = join(dir, TOKEN_FILE)
  try {
    const token = readFileSync(path, 'utf8').trim()
    if (/^[a-f0-9]{32,}$/.test(token)) return token
  } catch {
    // Not made yet.
  }
  const token = randomBytes(24).toString('hex')
  writeAtomic(path, `${token}\n`, 0o600)
  return token
}

export function pageUrl(port: number, token: string, sessionId?: string | null, follow = false): string {
  const hash = [sessionId ? `session=${encodeURIComponent(sessionId)}` : '', follow ? 'follow=desktop' : ''].filter(Boolean).join('&')
  return `http://127.0.0.1:${port}/?token=${token}${hash ? `#${hash}` : ''}`
}

/** Whether a pi-analytics helper answers on the port. */
export function helloAt(port: number, timeoutMs = HELLO_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/hello', timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => {
        try {
          resolve((JSON.parse(body) as { app?: unknown }).app === 'pi-analytics')
        } catch {
          resolve(false)
        }
      })
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
    req.end()
  })
}

/** The built page, beside the bundle or a chunk folder below it. */
export function sessionsPagePath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [join(here, SESSIONS_PAGE_FILE), join(here, '..', SESSIONS_PAGE_FILE), join(here, '..', '..', 'dist', SESSIONS_PAGE_FILE)]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function tokenMatches(given: string | null, token: string): boolean {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function cookieToken(req: IncomingMessage): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === TOKEN_COOKIE) return value.join('=')
  }
  return null
}

function readDesktopFocus(dir: string): string | null {
  try {
    const value = JSON.parse(readFileSync(join(dir, DESKTOP_FOCUS_FILE), 'utf8')) as { sessionId?: unknown }
    return typeof value.sessionId === 'string' ? value.sessionId : null
  } catch {
    return null
  }
}

export interface ServeOptions {
  dir?: string
  port?: number
  idleMs?: number
  /** For tests: where sessions and their logs are read. */
  sessions?: Partial<LiveSessionsOptions>
  page?: string
  log?: (line: string) => void
  /** Called once the helper has stopped. */
  onExit?: () => void
}

export interface RunningServer {
  port: number
  token: string
  url: (sessionId?: string | null) => string
  close: () => Promise<void>
}

interface Subscriber {
  res: ServerResponse
  /** Null for the session list. */
  sessionId: string | null
  last: string | null
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Start the helper, or return null when one already answers on the port.
 * A port taken by something else falls back to a free one; `server.json`
 * says which.
 */
export async function serve(options: ServeOptions = {}): Promise<RunningServer | null> {
  const dir = options.dir ?? analyticsDir()
  const ctxDir = options.sessions?.contextDir ?? contextDir(dir)
  const wanted = options.port ?? (Number(process.env[PORT_ENV]) || DEFAULT_PORT)
  const idleMs = options.idleMs ?? IDLE_EXIT_MS
  const log = options.log ?? (() => {})
  const token = serverToken(dir)
  const pagePath = options.page ?? sessionsPagePath()
  const page = pagePath ? readFileSync(pagePath, 'utf8') : '<!doctype html><p>The session page is not built: run "npm run build:pi-analytics".</p>'
  const live = new LiveSessions({ contextDir: ctxDir, ...options.sessions })
  const subscribers = new Set<Subscriber>()
  let rows: LiveSessionRow[] = []
  let lastBusyAt = Date.now()
  let closed = false

  const server = createServer((req, res) => handle(req, res))
  let port: number
  try {
    port = await listen(server, wanted)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    if (await helloAt(wanted)) {
      log(`pi-analytics is already serving on port ${wanted}`)
      return null
    }
    port = await listen(server, 0)
    log(`port ${wanted} is taken; serving on ${port}`)
  }

  const info: ServerInfo = { app: 'pi-analytics', pid: process.pid, port, startedAt: Date.now(), version: SERVER_INFO_VERSION }
  writeAtomic(serverInfoPath(dir), JSON.stringify(info))
  void pruneContextSnapshots(ctxDir).catch(() => {})

  function allowedHost(req: IncomingMessage): boolean {
    const host = req.headers.host ?? ''
    // A page on another site that renames itself to 127.0.0.1 (DNS rebinding) still sends its own name.
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`
  }

  function send(res: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers })
    res.end(body)
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    if (!allowedHost(req) || req.method !== 'GET') return send(res, 403, 'text/plain', 'Forbidden')
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    if (url.pathname === '/api/hello') return send(res, 200, 'application/json', JSON.stringify({ app: 'pi-analytics', version: SERVER_INFO_VERSION }))
    const given = url.searchParams.get('token') ?? cookieToken(req)
    if (!tokenMatches(given, token)) return send(res, 401, 'text/plain', 'This page needs the address pi-analytics printed (it carries a token).')
    lastBusyAt = Date.now()
    if (url.pathname === '/') {
      return send(res, 200, 'text/html; charset=utf-8', page, {
        'Set-Cookie': `${TOKEN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'self'",
        'Referrer-Policy': 'no-referrer',
      })
    }
    if (url.pathname === '/api/sessions' || url.pathname === '/api/session') {
      const sessionId = url.pathname === '/api/session' ? url.searchParams.get('id') : null
      if (url.pathname === '/api/session' && (!sessionId || sessionId.length > MAX_SESSION_ID_CHARS)) return send(res, 400, 'text/plain', 'Name a session')
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
      // The browser reconnects by itself; this tells it how soon.
      res.write('retry: 1000\n\n')
      const subscriber: Subscriber = { res, sessionId, last: null }
      subscribers.add(subscriber)
      req.on('close', () => subscribers.delete(subscriber))
      schedule(0)
      return
    }
    send(res, 404, 'text/plain', 'Not found')
  }

  function push(subscriber: Subscriber, envelope: { data: { generatedAt: number } }): void {
    // Compare without the time, so an unchanged session sends nothing.
    const { generatedAt: _generatedAt, ...rest } = envelope.data
    const fingerprint = JSON.stringify(rest)
    if (fingerprint === subscriber.last) return
    subscriber.last = fingerprint
    subscriber.res.write(`data: ${JSON.stringify(envelope)}\n\n`)
  }

  let running = false
  let again = false
  async function refresh(): Promise<void> {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      const now = Date.now()
      rows = await live.list(now)
      if (subscribers.size > 0 || rows.some((row) => row.state === 'working' || row.state === 'idle')) lastBusyAt = now
      const list: LiveSessionsEnvelope = {
        kind: 'live-sessions',
        version: LIVE_ENVELOPE_VERSION,
        data: { sessions: rows, desktopFocus: readDesktopFocus(dir), generatedAt: now },
      }
      const sessionIds = new Set([...subscribers].flatMap((s) => (s.sessionId ? [s.sessionId] : [])))
      const details = new Map(await Promise.all([...sessionIds].map(async (id) => [id, await live.session(id, rows, now)] as const)))
      for (const subscriber of subscribers) {
        const envelope = subscriber.sessionId ? details.get(subscriber.sessionId) : list
        if (envelope) push(subscriber, envelope)
      }
    } catch (error) {
      log(`refresh failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      running = false
    }
    if (again) {
      again = false
      void refresh()
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  function schedule(delay: number): void {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void tick(), delay)
  }

  async function tick(): Promise<void> {
    await refresh()
    const now = Date.now()
    const current = readServerInfo(dir)
    // Another helper took over (this one fell back to a spare port): leave once no page uses this one.
    const replaced = current !== null && current.pid !== process.pid && subscribers.size === 0
    if (replaced || (subscribers.size === 0 && now - lastBusyAt > idleMs)) {
      log(replaced ? 'another helper took over; stopping' : 'idle; stopping')
      await close()
      return
    }
    schedule(subscribers.size > 0 ? SCAN_MS : IDLE_SCAN_MS)
  }

  let watcher: FSWatcher | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null
  try {
    mkdirSync(ctxDir, { recursive: true })
    watcher = watch(ctxDir, () => {
      if (subscribers.size === 0) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => schedule(0), WATCH_DEBOUNCE_MS)
    })
    watcher.on('error', () => {
      watcher?.close()
      watcher = null
    })
  } catch {
    // The timer still picks changes up.
  }

  async function close(): Promise<void> {
    if (closed) return
    closed = true
    if (timer) clearTimeout(timer)
    if (debounce) clearTimeout(debounce)
    watcher?.close()
    for (const subscriber of subscribers) subscriber.res.end()
    subscribers.clear()
    if (readServerInfo(dir)?.pid === process.pid) rmSync(serverInfoPath(dir), { force: true })
    await new Promise<void>((resolve) => server.close(() => resolve()))
    options.onExit?.()
  }

  schedule(0)
  log(`serving on ${pageUrl(port, token)}`)
  return { port, token, url: (sessionId) => pageUrl(port, token, sessionId), close }
}
