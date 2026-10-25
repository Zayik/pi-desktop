import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  advertisedCacheLifetime,
  fillCacheLifetime,
  CONTEXT_SNAPSHOT_VERSION,
  MAX_CATEGORY_ITEMS,
  MAX_RECORDED_CALLS,
  buildBreakdown,
  callFromMessage,
  capItems,
  classifyMessages,
  classifyTool,
  emptyTotals,
  estimateTextTokens,
  findPromptSections,
  isContextSnapshot,
  measureSystemPrompt,
  recordCall,
  snapshotFileName,
  snapshotModel,
  type ContextSnapshot,
  type ModelCall,
} from './context-snapshot'

const LABELS = { preamble: 'prompt', other: 'other text', user: 'user message', assistant: 'assistant message', bash: 'bash' }

const PROMPT = [
  'You are an expert coding assistant.',
  '<tools>',
  '- read: Read files',
  '- bash: Run commands',
  '</tools>',
  '<project_context>',
  '<project_instructions path="/repo/AGENTS.md">',
  'Use tabs. '.repeat(40),
  '</project_instructions>',
  '<project_instructions path="/repo/docs/AGENTS.md">',
  'Docs rules.',
  '</project_instructions>',
  '</project_context>',
  '<skills>',
  '<available_skills>',
  '<skill>',
  '<name>pdf</name>',
  '<description>Work with PDF &amp; forms</description>',
  '<location>/skills/pdf/SKILL.md</location>',
  '</skill>',
  '</available_skills>',
  '</skills>',
  'Extension text appended after the sections.',
].join('\n')

test('estimates tokens at 4 characters each, rounding up', () => {
  assert.equal(estimateTextTokens(''), 0)
  assert.equal(estimateTextTokens('abcd'), 1)
  assert.equal(estimateTextTokens('abcde'), 2)
})

test('finds top-level prompt sections and skips tags inside fenced code', () => {
  const prompt = 'intro\n```\n<tools>\nnot a section\n</tools>\n```\n<rules>\n- be brief\n</rules>\n'
  assert.deepEqual(findPromptSections(prompt).map((section) => section.name), ['rules'])
})

test('splits the system prompt into sections, instruction files, and skills', () => {
  const result = measureSystemPrompt(PROMPT, LABELS)
  assert.deepEqual(result.systemPrompt.map((entry) => entry.label), ['other text', 'tools'])
  assert.deepEqual(result.contextFiles.map((entry) => entry.label), ['/repo/AGENTS.md', '/repo/docs/AGENTS.md'])
  assert.ok(result.contextFiles[0].tokens > result.contextFiles[1].tokens)
  assert.deepEqual(result.skills.map((entry) => entry.label), ['pdf'])
})

test('a prompt with no sections is one preamble item', () => {
  const result = measureSystemPrompt('Just a custom prompt.', LABELS)
  assert.deepEqual(result.systemPrompt.map((entry) => entry.label), ['prompt'])
})

test('classifies tools as built-in, MCP, or extension tools', () => {
  assert.equal(classifyTool({ name: 'read', sourceInfo: { path: 'builtin:read', source: 'builtin' } }), 'built-in')
  assert.equal(classifyTool({ name: 'github_search', sourceInfo: { path: 'builtin:mcp', source: 'builtin' } }), 'mcp')
  assert.equal(classifyTool({ name: 'mcp__github__search' }), 'mcp')
  assert.equal(classifyTool({ name: 'suggest_next_steps', sourceInfo: { path: '/res/pi-desktop-next-steps.ts', source: 'local' } }), 'custom')
})

test('classifies conversation messages and groups tool calls and results by tool', () => {
  const result = classifyMessages([
    { role: 'system', content: 'prompt state' },
    { role: 'user', content: [{ type: 'text', text: 'Fix the bug\nin the parser' }, { type: 'image', data: 'x'.repeat(10_000) }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me look.' },
        { type: 'text', text: 'Reading the file.' },
        { type: 'toolCall', name: 'read', arguments: { path: 'a.ts' } },
        { type: 'toolCall', name: 'read', arguments: { path: 'b.ts' } },
      ],
    },
    { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'x'.repeat(400) }] },
    { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'y'.repeat(400) }] },
    { role: 'custom', customType: 'todo', content: 'remember' },
    { role: 'bashExecution', command: 'ls', output: 'a b', excludeFromContext: true },
    { role: 'compactionSummary', summary: 'Earlier we fixed the lexer.' },
  ], LABELS)
  assert.equal(result.user[0].label, 'Fix the bug')
  // The image is data, so the user message counts only its text.
  assert.equal(result.user[0].tokens, estimateTextTokens('Fix the bug\nin the parser\n'))
  assert.equal(result.assistant[0].label, 'Reading the file.')
  assert.equal(result.thinking.length, 1)
  assert.deepEqual(result.toolCalls.map((entry) => [entry.label, entry.count]), [['read', 2]])
  assert.deepEqual(result.toolResults.map((entry) => [entry.label, entry.count, entry.tokens]), [['read', 2, 200]])
  assert.deepEqual(result.extension.map((entry) => entry.label), ['todo'])
  assert.equal(result.compacted.length, 1)
})

test('folds the smallest items beyond the cap into one item', () => {
  const items = Array.from({ length: MAX_CATEGORY_ITEMS + 5 }, (_, index) => ({ label: `f${index}`, tokens: index + 1 }))
  const capped = capItems(items, (count) => `${count} more`)
  assert.equal(capped.length, MAX_CATEGORY_ITEMS)
  assert.equal(capped[0].label, `f${MAX_CATEGORY_ITEMS + 4}`)
  const last = capped.at(-1)
  assert.equal(last?.label, '6 more')
  assert.equal(last?.tokens, 1 + 2 + 3 + 4 + 5 + 6)
})

test('builds the breakdown in request order with exact category totals', () => {
  const breakdown = buildBreakdown({
    systemPrompt: PROMPT,
    tools: [
      { name: 'read', description: 'Read a file', parameters: { type: 'object' }, sourceInfo: { path: 'builtin:read', source: 'builtin' } },
      { name: 'todo', description: 'Track tasks', sourceInfo: { path: '/ext/todo.ts', source: 'local' } },
    ],
    messages: [{ role: 'user', content: 'hello there' }],
    capturedAt: 5,
  })
  assert.deepEqual(breakdown.categories.map((category) => category.id), [
    'system-prompt', 'context-files', 'skills', 'built-in-tools', 'custom-tools', 'user-messages',
  ])
  for (const category of breakdown.categories) {
    assert.equal(category.tokens, category.items.reduce((sum, entry) => sum + entry.tokens, 0), category.id)
  }
  assert.equal(breakdown.estimatedTokens, breakdown.categories.reduce((sum, category) => sum + category.tokens, 0))
  assert.equal(breakdown.capturedAt, 5)
  assert.equal(breakdown.fromSession, undefined)
})

test('reads a call from an assistant message with usage', () => {
  const call = callFromMessage({
    role: 'assistant',
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    timestamp: 1000,
    usage: { input: 2, output: 888, cacheRead: 124_000, cacheWrite: 422, cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 } },
  }, 99)
  assert.deepEqual(call, {
    at: 1000, provider: 'anthropic', model: 'claude-haiku-5-5', input: 2, output: 888, cacheRead: 124_000, cacheWrite: 422,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
  })
  assert.equal(callFromMessage({ role: 'user', content: 'hi' }, 1), null)
  assert.equal(callFromMessage({ role: 'assistant', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, 1), null)
})

test('keeps the newest calls and counts every call in the totals', () => {
  const holder = { calls: [] as ModelCall[], totals: emptyTotals() }
  for (let index = 0; index < MAX_RECORDED_CALLS + 3; index++) {
    recordCall(holder, {
      at: index, provider: 'p', model: 'm', input: 1, output: 2, cacheRead: 3, cacheWrite: 4,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
    })
  }
  assert.equal(holder.calls.length, MAX_RECORDED_CALLS)
  assert.equal(holder.calls[0].at, 3)
  assert.equal(holder.totals.calls, MAX_RECORDED_CALLS + 3)
  assert.equal(holder.totals.cacheWrite, 4 * (MAX_RECORDED_CALLS + 3))
  assert.equal(holder.totals.cost, 0.5 * (MAX_RECORDED_CALLS + 3))
})

test('keeps the model fields the panel needs, with its cache lifetimes', () => {
  assert.deepEqual(snapshotModel({
    provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 200_000, maxTokens: 64_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, promptCache: { short: 300, long: 3600 },
  }), {
    provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 200_000, maxTokens: 64_000,
    rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, promptCache: { short: 300, long: 3600 },
  })
  assert.equal(snapshotModel(undefined), null)
  assert.equal(snapshotModel({ provider: 'x', id: 'y' })?.promptCache, null)
})

test('derives a safe file name from the session id', () => {
  assert.equal(snapshotFileName('0193-abc_DEF'), '0193-abc_DEF.json')
  assert.equal(snapshotFileName('../../etc/passwd'), '______etc_passwd.json')
  assert.equal(snapshotFileName(''), 'session.json')
})

test('accepts only snapshots of the current version', () => {
  const snapshot: ContextSnapshot = {
    version: CONTEXT_SNAPSHOT_VERSION, sessionId: 's', sessionFile: null, updatedAt: 1, model: null,
    cacheRetention: 'short', cacheWarming: null, breakdown: null, reportedTokens: null, calls: [], totals: emptyTotals(),
    turnStartedAt: null, lastRequestAt: null, lastWarmAt: null,
  }
  assert.equal(isContextSnapshot(snapshot), true)
  assert.equal(isContextSnapshot({ ...snapshot, version: 0 }), false)
  assert.equal(isContextSnapshot({ ...snapshot, calls: 'no' }), false)
  assert.equal(isContextSnapshot({ ...snapshot, breakdown: { categories: 1 } }), false)
  assert.equal(isContextSnapshot(null), false)
})

test('copilot models get the vendor\'s advertised cache lifetimes', () => {
  assert.deepEqual(advertisedCacheLifetime('anthropic', 'claude-sonnet-5-5'), { short: 300, long: 3600 })
  assert.deepEqual(advertisedCacheLifetime('github-copilot', 'claude-opus-5-5'), { short: 300, long: 3600 })
  assert.deepEqual(advertisedCacheLifetime('github-copilot', 'gpt-6.1'), { short: 1800, long: 1800 })
  assert.deepEqual(advertisedCacheLifetime('openai', 'gpt-5.6'), { short: 1800, long: 1800 })
  assert.deepEqual(advertisedCacheLifetime('openai', 'gpt-5.5'), { short: 300, long: 1800 })
  assert.deepEqual(advertisedCacheLifetime('github-copilot', 'o4-mini'), { short: 300, long: 1800 })
  assert.equal(advertisedCacheLifetime('google', 'gemini-4-argon'), null)
})

test('fills only the cache lifetimes a model leaves out', () => {
  const copilot: Record<string, unknown> = { provider: 'github-copilot', id: 'claude-sonnet-5-5' }
  assert.equal(fillCacheLifetime(copilot), true)
  assert.deepEqual(copilot.promptCache, { short: 300, long: 3600 })
  assert.equal(fillCacheLifetime(copilot), false, 'nothing left to fill')
  const configured: Record<string, unknown> = { provider: 'github-copilot', id: 'gpt-6.1', promptCache: { short: 600 } }
  fillCacheLifetime(configured)
  assert.deepEqual(configured.promptCache, { short: 600, long: 1800 })
  const unknown: Record<string, unknown> = { provider: 'google', id: 'gemini-4-argon' }
  assert.equal(fillCacheLifetime(unknown), false)
  assert.equal(unknown.promptCache, undefined)
})
