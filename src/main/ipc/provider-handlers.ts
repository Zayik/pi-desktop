import { app, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { assertTrustedSender, isObject, isString } from './validation'
import type { IpcContext } from './context'
import { PiLoginTerminal } from '../pi-login'
import { isProviderId, listPiProviders } from '../pi-providers'

// Upper bound on a renderer-reported column or row count.
const MAX_DIMENSION = 10000

function dimension(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_DIMENSION ? value : 0
}

export function registerProviderHandlers(ctx: IpcContext): void {
  const { broadcast } = ctx
  const login = new PiLoginTerminal()
  app.on('before-quit', () => login.stop())

  ipcMain.handle(IPC_CHANNELS.PI_PROVIDERS_LIST, async () => listPiProviders())

  ipcMain.handle(IPC_CHANNELS.PI_LOGIN_START, async (event, provider: unknown, size: unknown) => {
    assertTrustedSender(event)
    // Typed into Pi's screen, so only a plain provider id gets through.
    if (provider !== null && !isProviderId(provider)) throw new Error('invalid provider')
    const opts = isObject(size) ? size : {}
    login.start(
      provider,
      dimension(opts.cols),
      dimension(opts.rows),
      (data) => broadcast(IPC_CHANNELS.EVENT_PI_LOGIN_DATA, data),
      (exit) => broadcast(IPC_CHANNELS.EVENT_PI_LOGIN_EXIT, exit)
    )
  })

  ipcMain.handle(IPC_CHANNELS.PI_LOGIN_INPUT, async (event, data: unknown) => {
    assertTrustedSender(event)
    if (!isString(data)) throw new Error('login input must be a string')
    login.write(data)
  })

  ipcMain.handle(IPC_CHANNELS.PI_LOGIN_RESIZE, async (event, size: unknown) => {
    assertTrustedSender(event)
    const opts = isObject(size) ? size : {}
    login.resize(dimension(opts.cols), dimension(opts.rows))
  })

  ipcMain.handle(IPC_CHANNELS.PI_LOGIN_STOP, async (event) => {
    assertTrustedSender(event)
    login.stop()
  })
}
