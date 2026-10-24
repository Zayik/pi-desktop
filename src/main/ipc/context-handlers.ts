import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { isCacheMode, type CacheModeChoice, type ContextSnapshot } from '../../../resources/context-snapshot'
import { enableIdleCacheWarming, readCacheMode, readPiCacheWarming, writeCacheMode } from '../cache-modes'
import { pruneContextSnapshots, readContextSnapshot } from '../context-snapshots'
import { readAgentBoard } from '../agent-board'
import type { AgentBoard, AgentBoardRequest } from '../../shared/agent-board'
import { appLog } from '../app-log'
import { assertTrustedSender, isObject, isString } from './validation'

/** A renderer could send any number of paths; a chat never has this many subagents open. */
const MAX_SUBAGENT_FILES = 100

export function registerContextHandlers(): void {
  void pruneContextSnapshots().catch((error: unknown) => {
    appLog.warn('context-snapshots', 'Could not prune old context snapshots', error)
  })

  ipcMain.handle(IPC_CHANNELS.CONTEXT_GET_SNAPSHOT, async (event: IpcMainInvokeEvent, sessionId: unknown): Promise<ContextSnapshot | null> => {
    assertTrustedSender(event)
    return readContextSnapshot(parseSessionId(sessionId))
  })

  ipcMain.handle(IPC_CHANNELS.CONTEXT_GET_AGENT_BOARD, async (event: IpcMainInvokeEvent, request: unknown): Promise<AgentBoard> => {
    assertTrustedSender(event)
    return readAgentBoard(parseBoardRequest(request))
  })

  ipcMain.handle(IPC_CHANNELS.CONTEXT_GET_CACHE_MODE, async (event: IpcMainInvokeEvent, sessionId: unknown): Promise<CacheModeChoice | null> => {
    assertTrustedSender(event)
    return readCacheMode(parseSessionId(sessionId))
  })

  ipcMain.handle(IPC_CHANNELS.CONTEXT_SET_CACHE_MODE, async (event: IpcMainInvokeEvent, sessionId: unknown, mode: unknown): Promise<CacheModeChoice> => {
    assertTrustedSender(event)
    if (!isCacheMode(mode)) throw new Error('mode must be a cache mode')
    return writeCacheMode(parseSessionId(sessionId), mode)
  })

  ipcMain.handle(IPC_CHANNELS.CONTEXT_GET_CACHE_WARMING, async (event: IpcMainInvokeEvent): Promise<string | null> => {
    assertTrustedSender(event)
    return readPiCacheWarming()
  })

  ipcMain.handle(IPC_CHANNELS.CONTEXT_ENABLE_IDLE_CACHE_WARMING, async (event: IpcMainInvokeEvent): Promise<void> => {
    assertTrustedSender(event)
    await enableIdleCacheWarming()
  })
}

function parseSessionId(value: unknown): string {
  if (!isString(value) || !value) throw new Error('sessionId must be a non-empty string')
  return value
}

function parseBoardRequest(value: unknown): AgentBoardRequest {
  if (!isObject(value) || !isString(value.sessionId) || !value.sessionId) throw new Error('sessionId must be a non-empty string')
  const sessionFile = value.sessionFile
  if (sessionFile !== null && !isString(sessionFile)) throw new Error('sessionFile must be a string or null')
  const files = Array.isArray(value.subagentSessionFiles) ? value.subagentSessionFiles : []
  return {
    sessionId: value.sessionId,
    sessionFile: sessionFile || null,
    // Each path is checked against the session stores before it is read.
    subagentSessionFiles: files.filter((file): file is string => isString(file) && file.length > 0).slice(0, MAX_SUBAGENT_FILES),
  }
}
