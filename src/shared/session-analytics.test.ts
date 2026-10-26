import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeSession, classifyCommand, classifyToolCall, skillFromPath } from './session-analytics'

const T0 = Date.parse('2026-10-24T10:00:00.000Z')
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString()

type Entry = Record<string, unknown>

/** A model call that paid `price` per prompt token, so carried cost is easy to check. */
function assistant(id: string, parentId: string | null, offsetMs: number, calls: { id: string; name: string; args?: Entry }[] = [], promptTokens = 1000, price = 0.000001): Entry {
  return {
    type: 'message', id, parentId, timestamp: iso(offsetMs),
    message: {
      role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-5-5', timestamp: T0 + offsetMs,
      content: [{ type: 'text', text: 'ok' }, ...calls.map((call) => ({ type: 'toolCall', id: call.id, name: call.name, arguments: call.args ?? {} }))],
      usage: {
        input: 0, output: 50, cacheRead: promptTokens, cacheWrite: 0,
        cost: { input: 0, output: 0.001, cacheRead: promptTokens * price, cacheWrite: 0, total: 0.001 + promptTokens * price },
      },
    },
  }
}

function result(id: string, parentId: string, offsetMs: number, toolCallId: string, toolName: string, text: string, isError = false): Entry {
  return { type: 'message', id, parentId, timestamp: iso(offsetMs), message: { role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text }], isError } }
}

function user(id: string, parentId: string | null, offsetMs: number, text: string): Entry {
  return { type: 'message', id, parentId, timestamp: iso(offsetMs), message: { role: 'user', content: [{ type: 'text', text }] } }
}

const header = { type: 'session', id: 'sess-1', timestamp: iso(0), cwd: '/repo' }

test('sorts shell commands by what they run', () => {
  assert.equal(classifyCommand('npm test'), 'test')
  assert.equal(classifyCommand('cd app && npm run build && npx vitest run src/a.test.ts'), 'test')
  assert.equal(classifyCommand('CI=1 pytest -x tests/test_api.py'), 'test')
  assert.equal(classifyCommand('npx tsx --test $(find src -name "*.test.ts")'), 'test')
  assert.equal(classifyCommand('npm run build'), 'build')
  assert.equal(classifyCommand('npm run typecheck'), 'lint')
  assert.equal(classifyCommand('npx eslint src'), 'lint')
  assert.equal(classifyCommand('npm ci'), 'install')
  assert.equal(classifyCommand('git status --short'), 'git')
  assert.equal(classifyCommand('ls -la'), 'shell')
  assert.equal(classifyToolCall('read', { path: 'a.ts' }), 'read')
  assert.equal(classifyToolCall('grep', {}), 'search')
  assert.equal(classifyToolCall('acp_delegate', {}), 'subagent')
  assert.equal(classifyToolCall('bash', { command: 'go test ./...' }), 'test')
})

test('names a skill from its SKILL.md path', () => {
  assert.equal(skillFromPath('/home/me/.pi/agent/skills/pdf-tools/SKILL.md'), 'pdf-tools')
  assert.equal(skillFromPath('C:\\Users\\me\\.agents\\skills\\retro\\SKILL.md'), 'retro')
  assert.equal(skillFromPath('/repo/README.md'), null)
})

test('times tool calls, counts test runs and failures, and charges carried cost', () => {
  const entries = [
    header,
    user('u1', null, 1_000, 'Add the export button'),
    assistant('a1', 'u1', 2_000, [{ id: 'c1', name: 'bash', args: { command: 'npm test' } }]),
    // A 4000-character result is 1000 estimated tokens.
    result('r1', 'a1', 182_000, 'c1', 'bash', 'x'.repeat(4000), true),
    assistant('a2', 'r1', 183_000, [{ id: 'c2', name: 'read', args: { path: '/skills/tdd/SKILL.md' } }]),
    result('r2', 'a2', 184_000, 'c2', 'read', 'y'.repeat(400)),
    assistant('a3', 'r2', 185_000, [{ id: 'c3', name: 'bash', args: { command: 'npm test' } }]),
    result('r3', 'a3', 245_000, 'c3', 'bash', 'ok'),
    assistant('a4', 'r3', 246_000),
  ]
  const facts = analyzeSession(entries, '/s/a.jsonl')
  assert.ok(facts)
  assert.equal(facts.turns, 1)
  assert.equal(facts.calls, 4)
  const tests = facts.categories.find((stat) => stat.category === 'test')
  assert.ok(tests)
  assert.equal(tests.calls, 2)
  assert.equal(tests.errors, 1)
  assert.equal(tests.durationMs, 180_000 + 60_000)
  assert.deepEqual(facts.testRuns.map((run) => [run.durationMs, run.failed]), [[180_000, true], [60_000, false]])
  assert.deepEqual(facts.failedCommands, [{ command: 'npm test', category: 'test', failures: 1 }])
  assert.equal(facts.slowCalls[0].durationMs, 180_000)
  // r1 (1000 tokens) is resent by a2, a3 and a4, each paying 0.000001 per prompt token.
  const bash = facts.tools.find((stat) => stat.tool === 'bash')
  assert.ok(bash)
  assert.ok(Math.abs(bash.carriedCost - (1000 * 3 * 0.000001 + 1 * 1 * 0.000001)) < 1e-12)
  const skill = facts.skills.find((stat) => stat.skill === 'tdd')
  assert.ok(skill)
  assert.equal(skill.uses, 1)
  assert.ok(Math.abs(skill.carriedCost - 100 * 2 * 0.000001) < 1e-12)
  assert.equal(facts.turnFacts.length, 1)
  assert.equal(facts.turnFacts[0].durationMs, 245_000)
  assert.equal(facts.turnFacts[0].toolCalls, 3)
  assert.equal(Object.keys(facts.days).length, 1)
  // The three-minute test run is active time, though no entry was written meanwhile.
  assert.equal(facts.activeMs, 246_000)
})

test('parallel calls of one message split the wall-clock time between them', () => {
  const facts = analyzeSession([
    header,
    user('u1', null, 0, 'go'),
    assistant('a1', 'u1', 1_000, [{ id: 'c1', name: 'grep' }, { id: 'c2', name: 'grep' }]),
    result('r1', 'a1', 11_000, 'c1', 'grep', 'a'),
    result('r2', 'r1', 13_000, 'c2', 'grep', 'b'),
  ], '/s/a.jsonl')
  assert.equal(facts?.tools.find((stat) => stat.tool === 'grep')?.durationMs, 12_000)
})

test('a compaction stops earlier results from being carried', () => {
  const facts = analyzeSession([
    header,
    user('u1', null, 0, 'go'),
    assistant('a1', 'u1', 1_000, [{ id: 'c1', name: 'read', args: { path: 'big.ts' } }]),
    result('r1', 'a1', 2_000, 'c1', 'read', 'z'.repeat(4000)),
    assistant('a2', 'r1', 3_000),
    { type: 'compaction', id: 'k1', parentId: 'a2', timestamp: iso(4_000), summary: 's', firstKeptEntryId: 'a2' },
    assistant('a3', 'k1', 5_000),
  ], '/s/a.jsonl')
  assert.equal(facts?.compactions, 1)
  // Only a2 resent the read.
  assert.ok(Math.abs((facts?.tools.find((stat) => stat.tool === 'read')?.carriedCost ?? 0) - 1000 * 0.000001) < 1e-12)
})

test('an abandoned branch is not charged for calls on another branch', () => {
  const facts = analyzeSession([
    header,
    user('u1', null, 0, 'go'),
    assistant('a1', 'u1', 1_000, [{ id: 'c1', name: 'read' }]),
    result('r1', 'a1', 2_000, 'c1', 'read', 'z'.repeat(4000)),
    // The user went back to u1 and asked again: a2 never saw r1.
    assistant('a2', 'u1', 3_000),
  ], '/s/a.jsonl')
  assert.equal(facts?.tools.find((stat) => stat.tool === 'read')?.carriedCost, 0)
  assert.equal(facts?.calls, 2)
})

test('a fork does not count the entries it copied from its parent', () => {
  const forkHeader = { type: 'session', id: 'fork-1', timestamp: iso(100_000), cwd: '/repo', parentSession: '/s/parent.jsonl' }
  const facts = analyzeSession([
    forkHeader,
    user('u1', null, 0, 'original prompt'),
    assistant('a1', 'u1', 1_000, [{ id: 'c1', name: 'bash', args: { command: 'npm test' } }]),
    result('r1', 'a1', 50_000, 'c1', 'bash', 'w'.repeat(4000)),
    user('u2', 'r1', 101_000, 'try another way'),
    assistant('a2', 'u2', 102_000),
  ], '/s/fork.jsonl')
  assert.ok(facts)
  assert.equal(facts.calls, 1)
  assert.equal(facts.turns, 1)
  assert.equal(facts.testRuns.length, 0)
  assert.equal(facts.label, 'try another way')
  // The copied result still cost the fork's own call to resend.
  assert.ok((facts.tools.find((stat) => stat.tool === 'bash')?.carriedCost ?? 0) > 0)
})

test('a /skill: command counts as a skill load', () => {
  const facts = analyzeSession([
    header,
    user('u1', null, 0, '<skill name="pi-retro" location="/r/SKILL.md">\nSteps\n</skill>\n\nRun a retrospective'),
    assistant('a1', 'u1', 1_000),
  ], '/s/a.jsonl')
  assert.equal(facts?.skills[0].skill, 'pi-retro')
  assert.equal(facts?.label, 'Run a retrospective')
})

test('needs a session header', () => {
  assert.equal(analyzeSession([user('u1', null, 0, 'hi')], '/x.jsonl'), null)
})

test("records Pi's cache-warming pings as billed pings, not calls", () => {
  const warm = (id: string, parentId: string, offsetMs: number, cacheRead: number): Entry => ({
    type: 'usage', id, parentId, timestamp: iso(offsetMs), kind: 'cache_warm', provider: 'anthropic', model: 'claude-sonnet-5-5-20261001',
    usage: { input: 2, output: 1, cacheRead, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: cacheRead * 0.0000003, cacheWrite: 0, total: cacheRead * 0.0000003 } },
  })
  const entries = [
    header,
    user('u1', null, 1000, 'hello'),
    assistant('a1', 'u1', 2000, [], 20_000),
    warm('w1', 'a1', 272_000, 20_000),
    warm('w2', 'w1', 542_000, 20_000),
    user('u2', 'w2', 600_000, 'again'),
    assistant('a2', 'u2', 601_000, [], 20_500),
  ]
  const facts = analyzeSession(entries, '/s.jsonl')!
  assert.equal(facts.calls, 2)
  assert.equal(facts.warmPings, 2)
  assert.ok(Math.abs(facts.warmCost - 2 * 20_000 * 0.0000003) < 1e-12)
  assert.equal(facts.cacheCalls.length, 4)
  assert.deepEqual(facts.cacheCalls.map((call) => call[9] ?? 0), [0, 1, 1, 0])
  // The ping's dated model name still files it under the chat's model.
  assert.deepEqual(facts.cacheModels, ['anthropic/claude-sonnet-5-5'])
})
