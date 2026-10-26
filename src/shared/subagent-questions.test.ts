import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QUESTION_TIMEOUT_MS, answeredRequestId, pendingQuestionFor, questionFromCustomMessage, questionIsFor } from './subagent-questions'

const DETAILS = { id: 'req-1', requestId: 'req-1', reason: 'need_decision', expectsReply: true, runId: 'run-abc', agent: 'worker', childIndex: 1, requestBody: 'Use Postgres or SQLite?' }

test('reads a question from the custom message pi-subagents injects', () => {
  assert.deepEqual(questionFromCustomMessage('subagent_supervisor_request', DETAILS, 'visible text', 50), {
    requestId: 'req-1', runId: 'run-abc', childIndex: 1, agent: 'worker', reason: 'need_decision', body: 'Use Postgres or SQLite?', at: 50,
  })
  // Progress updates expect no reply, and other custom messages are not questions.
  assert.equal(questionFromCustomMessage('subagent_supervisor_request', { ...DETAILS, expectsReply: false }, '', 0), null)
  assert.equal(questionFromCustomMessage('other', DETAILS, '', 0), null)
  assert.equal(questionFromCustomMessage('subagent_supervisor_request', { ...DETAILS, requestBody: undefined }, [{ type: 'text', text: ' from content ' }], 0)?.body, 'from content')
})

test('reads the request a journaled reply answers', () => {
  assert.equal(answeredRequestId({ type: 'custom', customType: 'subagent_supervisor_reply', data: { requestId: 'req-1' } }), 'req-1')
  assert.equal(answeredRequestId({ type: 'custom', customType: 'other', data: { requestId: 'req-1' } }), null)
})

test('matches a question to the child session under its run and index, on either path style', () => {
  const question = questionFromCustomMessage('subagent_supervisor_request', DETAILS, '', 0)!
  assert.equal(questionIsFor(question, '/s/chat/run-abc/run-1/child.jsonl'), true)
  assert.equal(questionIsFor(question, 'C:\\Users\\d\\.pi\\chat\\run-abc\\run-1\\child.jsonl'), true)
  assert.equal(questionIsFor(question, '/s/chat/run-abc/run-0/child.jsonl'), false)
  assert.equal(questionIsFor(question, '/s/chat/run-xyz/run-1/child.jsonl'), false)
})

test('a question is pending until it times out or the child writes again', () => {
  const question = questionFromCustomMessage('subagent_supervisor_request', DETAILS, '', 10_000)!
  const file = '/s/chat/run-abc/run-1/child.jsonl'
  assert.equal(pendingQuestionFor([question], file, 9_000, 20_000)?.requestId, 'req-1')
  assert.equal(pendingQuestionFor([question], file, 30_000, 40_000), null)
  assert.equal(pendingQuestionFor([question], file, 9_000, 10_000 + QUESTION_TIMEOUT_MS + 1), null)
})
