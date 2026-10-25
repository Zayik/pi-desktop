/**
 * Questions a pi-subagents child asks its parent chat (`contact_supervisor`).
 * The extension injects each one into the parent as a custom message of type
 * `subagent_supervisor_request`, and journals the parent's answer as a
 * `subagent_supervisor_reply` entry. Read from those, so the extension needs
 * no change. billion-context delegates run headless and never ask.
 */

export const SUPERVISOR_REQUEST_TYPE = 'subagent_supervisor_request'
export const SUPERVISOR_REPLY_TYPE = 'subagent_supervisor_reply'
/** pi-subagents gives up on an unanswered question after this long (`PI_INTERCOM_ASK_TIMEOUT_MS`). */
export const QUESTION_TIMEOUT_MS = 10 * 60 * 1000
/** A child that wrote this long after asking has its answer, however it got it. */
const ANSWER_SLACK_MS = 2_000
const MAX_QUESTION_CHARS = 2_000

export interface SubagentQuestion {
  requestId: string
  /** pi-subagents' run id: the child's session sits under `<run id>/run-<child index>/`. */
  runId: string | null
  childIndex: number | null
  agent: string | null
  /** `need_decision` or `interview_request`. */
  reason: string | null
  /** What the child asked, as it wrote it. */
  body: string
  at: number
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('')
}

/**
 * The question a custom message carries, or null when it is not a question
 * that waits for an answer (progress updates do not). Takes a session entry's
 * `custom_message` fields or a live agent message with role `custom`.
 */
export function questionFromCustomMessage(customType: unknown, details: unknown, content: unknown, at: number): SubagentQuestion | null {
  if (customType !== SUPERVISOR_REQUEST_TYPE || !isRecord(details) || details.expectsReply !== true) return null
  const requestId = str(details.requestId) ?? str(details.id)
  if (!requestId) return null
  const body = (str(details.requestBody) ?? textOf(content)).trim().slice(0, MAX_QUESTION_CHARS)
  return {
    requestId,
    runId: str(details.runId),
    childIndex: typeof details.childIndex === 'number' && Number.isFinite(details.childIndex) ? details.childIndex : null,
    agent: str(details.agent),
    reason: str(details.reason),
    body,
    at,
  }
}

/** The request id a session entry answers, when it is a journaled supervisor reply. */
export function answeredRequestId(entry: UnknownRecord): string | null {
  if (entry.type !== 'custom' || entry.customType !== SUPERVISOR_REPLY_TYPE || !isRecord(entry.data)) return null
  return str(entry.data.requestId)
}

/** Whether a question belongs to the child whose session file is at `sessionFile`. */
export function questionIsFor(question: SubagentQuestion, sessionFile: string): boolean {
  if (!question.runId) return false
  const parts = sessionFile.split(/[\\/]/)
  const run = parts.indexOf(question.runId)
  if (run < 0) return false
  return parts[run + 1] === `run-${question.childIndex ?? 0}`
}

/**
 * The question a child is still waiting on: unanswered, not yet timed out,
 * and asked after the child last wrote (a child that went on has its answer).
 */
export function pendingQuestionFor(
  questions: SubagentQuestion[],
  sessionFile: string,
  lastActivityAt: number | null,
  now: number
): SubagentQuestion | null {
  let latest: SubagentQuestion | null = null
  for (const question of questions) {
    if (!questionIsFor(question, sessionFile)) continue
    if (now - question.at > QUESTION_TIMEOUT_MS) continue
    if (lastActivityAt !== null && lastActivityAt > question.at + ANSWER_SLACK_MS) continue
    if (!latest || question.at > latest.at) latest = question
  }
  return latest
}
