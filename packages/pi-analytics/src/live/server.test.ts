import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { request } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { CONTEXT_SNAPSHOT_VERSION, emptyTotals, snapshotFileName, type ContextSnapshot } from '../../../../resources/context-snapshot'
import { DESKTOP_FOCUS_FILE, TOKEN_COOKIE, helloAt, readServerInfo, serve, serverInfoPath } from './server'
import type { LiveSessionsEnvelope } from './envelope'

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'live-server-'))
  mkdirSync(join(dir, 'context'), { recursive: true })
  return dir
}

function snapshot(sessionId: string, process: ContextSnapshot['process']): ContextSnapshot {
  return {
    version: CONTEXT_SNAPSHOT_VERSION, sessionId, sessionFile: null, updatedAt: Date.now(), model: null,
    cacheRetention: 'short', cacheWarming: null, breakdown: null, reportedTokens: null, calls: [], totals: emptyTotals(),
    turnStartedAt: null, lastRequestAt: null, lastWarmAt: null, process, agentRunning: false, endedAt: null,
  }
}

function writeSnapshot(dir: string, value: ContextSnapshot): void {
  writeFileSync(join(dir, 'context', snapshotFileName(value.sessionId)), JSON.stringify(value))
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** The first `count` messages of a server stream. */
function events(port: number, path: string, count: number, headers: Record<string, string> = {}): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const messages: unknown[] = []
      let buffer = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buffer += chunk
        let end
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const data = block.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n')
          if (data) messages.push(JSON.parse(data))
          if (messages.length >= count) {
            req.destroy()
            resolve(messages)
          }
        }
      })
    })
    req.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error)
    })
    req.end()
  })
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''])
  await new Promise((resolve) => child.on('exit', resolve))
  return child.pid as number
}

test('serves only on its own address, only with its token', async () => {
  const dir = tempDir()
  const server = await serve({ dir, port: 0, sessions: { sessionRoots: [] } })
  assert.ok(server)
  try {
    const host = { Host: `127.0.0.1:${server.port}` }
    assert.equal((await get(server.port, '/api/hello', host)).status, 200)
    assert.equal((await get(server.port, '/', host)).status, 401)
    assert.equal((await get(server.port, `/?token=${'0'.repeat(48)}`, host)).status, 401)
    // A site that points its own name at 127.0.0.1 still sends that name.
    assert.equal((await get(server.port, `/?token=${server.token}`, { Host: `evil.example:${server.port}` })).status, 403)
    const page = await get(server.port, `/?token=${server.token}`, host)
    assert.equal(page.status, 200)
    assert.match(String(page.headers['set-cookie']), new RegExp(`${TOKEN_COOKIE}=${server.token}; HttpOnly; SameSite=Strict`))
    assert.match(String(page.headers['content-security-policy']), /connect-src 'self'/)
    // The cookie the page got is enough afterwards.
    assert.equal((await get(server.port, '/api/sessions-nope', { ...host, Cookie: `${TOKEN_COOKIE}=${server.token}` })).status, 404)
    const info = readServerInfo(dir)
    assert.equal(info?.pid, process.pid)
    assert.equal(info?.port, server.port)
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(existsSync(serverInfoPath(dir)), false)
})

test('streams the sessions, with a crashed one shown as stopped, and a second helper defers to the first', async () => {
  const dir = tempDir()
  const pid = await deadPid()
  writeSnapshot(dir, snapshot('alive', { pid: process.pid, startedAt: Date.now() - process.uptime() * 1000, cwd: '/a' }))
  writeSnapshot(dir, snapshot('crashed', { pid, startedAt: Date.now() - 1000, cwd: '/b' }))
  writeFileSync(join(dir, DESKTOP_FOCUS_FILE), JSON.stringify({ sessionId: 'alive' }))
  const server = await serve({ dir, port: 0, sessions: { sessionRoots: [] } })
  assert.ok(server)
  try {
    const headers = { Host: `127.0.0.1:${server.port}`, Cookie: `${TOKEN_COOKIE}=${server.token}` }
    const [first] = await events(server.port, '/api/sessions', 1, headers) as LiveSessionsEnvelope[]
    assert.equal(first.kind, 'live-sessions')
    assert.deepEqual(first.data.sessions.map((row) => [row.sessionId, row.state]), [['alive', 'idle'], ['crashed', 'stopped']])
    assert.equal(first.data.desktopFocus, 'alive')

    // Started again on the same port, a helper finds this one and leaves.
    assert.equal(await serve({ dir, port: server.port }), null)
    assert.equal(await helloAt(server.port), true)

    // A change shows up without a reload.
    const stream = events(server.port, '/api/sessions', 2, headers)
    await new Promise((resolve) => setTimeout(resolve, 300))
    writeSnapshot(dir, { ...snapshot('alive', { pid: process.pid, startedAt: Date.now() - process.uptime() * 1000, cwd: '/a' }), agentRunning: true })
    const [, second] = await stream as LiveSessionsEnvelope[]
    assert.equal(second.data.sessions.find((row) => row.sessionId === 'alive')?.state, 'working')
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a page reconnecting after the helper restarts gets the sessions again', async () => {
  const dir = tempDir()
  writeSnapshot(dir, snapshot('s', { pid: process.pid, startedAt: Date.now() - process.uptime() * 1000, cwd: '/a' }))
  const first = await serve({ dir, port: 0, sessions: { sessionRoots: [] } })
  assert.ok(first)
  const port = first.port
  await first.close()
  assert.equal(await helloAt(port), false)
  const second = await serve({ dir, port, sessions: { sessionRoots: [] } })
  assert.ok(second)
  try {
    assert.equal(second.port, port, 'the same address, so an open page reconnects by itself')
    assert.equal(second.token, first.token, 'the same token, so a bookmarked page keeps working')
    const [envelope] = await events(port, '/api/sessions', 1, { Host: `127.0.0.1:${port}`, Cookie: `${TOKEN_COOKIE}=${second.token}` }) as LiveSessionsEnvelope[]
    assert.equal(envelope.data.sessions[0]?.sessionId, 's')
  } finally {
    await second.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stops by itself when no page is open and no session runs', async () => {
  const dir = tempDir()
  let exited = false
  const server = await serve({ dir, port: 0, idleMs: 0, sessions: { sessionRoots: [] }, onExit: () => { exited = true } })
  assert.ok(server)
  try {
    for (let i = 0; i < 40 && !exited; i++) await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(exited, true)
    assert.equal(existsSync(serverInfoPath(dir)), false)
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the token survives a restart and is readable only by its owner', { skip: process.platform === 'win32' }, async () => {
  const dir = tempDir()
  const server = await serve({ dir, port: 0, sessions: { sessionRoots: [] } })
  assert.ok(server)
  await server.close()
  const { statSync } = await import('fs')
  assert.equal(statSync(join(dir, 'server-token')).mode & 0o077, 0)
  assert.equal(readFileSync(join(dir, 'server-token'), 'utf8').trim(), server.token)
  rmSync(dir, { recursive: true, force: true })
})
