import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import type { ContextSnapshot } from '../../../resources/context-snapshot'
import { pruneContextSnapshots, readContextSnapshot } from '../context-snapshots'
import { appLog } from '../app-log'
import { assertTrustedSender, isString } from './validation'

export function registerContextHandlers(): void {
  void pruneContextSnapshots().catch((error: unknown) => {
    appLog.warn('context-snapshots', 'Could not prune old context snapshots', error)
  })

  ipcMain.handle(IPC_CHANNELS.CONTEXT_GET_SNAPSHOT, async (event: IpcMainInvokeEvent, sessionId: unknown): Promise<ContextSnapshot | null> => {
    assertTrustedSender(event)
    if (!isString(sessionId) || !sessionId) throw new Error('sessionId must be a non-empty string')
    return readContextSnapshot(sessionId)
  })
}
