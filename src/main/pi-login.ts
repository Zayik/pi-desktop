import os from 'os'
import pty, { type IPty } from 'node-pty'
import { buildPiRunEnv, getPiCli } from './pi-rpc-manager'
import { interactivePiCommand, loginCommand } from './pi-providers'
import { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS, TERMINAL_TYPE } from './terminal-service'

/** Wait for Pi's screen to settle before typing, but never longer than this. */
const LOGIN_TYPE_QUIET_MS = 800
const LOGIN_TYPE_MAX_WAIT_MS = 15_000

type DataHandler = (data: string) => void
type ExitHandler = (event: { exitCode: number }) => void

/**
 * One interactive Pi in a PTY, opened on `/login`. Separate from the project
 * terminals: signing in needs no project, and it ends when the dialog closes.
 */
export class PiLoginTerminal {
  private terminal: IPty | null = null
  private disposables: { dispose(): void }[] = []
  private typeTimer: NodeJS.Timeout | null = null

  start(provider: string | null, cols: number, rows: number, onData: DataHandler, onExit: ExitHandler): void {
    this.stop()
    const cli = getPiCli()
    if (cli.failureReason) throw new Error('Pi was not found')
    const command = interactivePiCommand(cli, process.env.COMSPEC)
    const terminal = pty.spawn(command.file, command.args, {
      name: TERMINAL_TYPE,
      cols: cols || DEFAULT_TERMINAL_COLS,
      rows: rows || DEFAULT_TERMINAL_ROWS,
      cwd: os.homedir(),
      env: { ...buildPiRunEnv(false), TERM: TERMINAL_TYPE } as Record<string, string>,
      ...(process.platform === 'win32' ? {} : { encoding: 'utf8' }),
    })
    this.terminal = terminal

    // Type `/login` once Pi has drawn its screen: when output has been quiet
    // for a moment, or after a ceiling for a Pi that keeps redrawing.
    const startedAt = Date.now()
    let typed = false
    const typeLogin = (): void => {
      if (typed || this.terminal !== terminal) return
      typed = true
      terminal.write(`${loginCommand(provider)}\r`)
    }
    const schedule = (): void => {
      if (typed) return
      if (this.typeTimer) clearTimeout(this.typeTimer)
      const remaining = LOGIN_TYPE_MAX_WAIT_MS - (Date.now() - startedAt)
      this.typeTimer = setTimeout(typeLogin, Math.max(0, Math.min(LOGIN_TYPE_QUIET_MS, remaining)))
    }

    this.disposables.push(
      terminal.onData((data) => {
        schedule()
        onData(data)
      })
    )
    this.disposables.push(
      terminal.onExit(({ exitCode }) => {
        if (this.terminal === terminal) this.clear()
        onExit({ exitCode })
      })
    )
  }

  write(data: string): void {
    this.terminal?.write(data)
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.terminal?.resize(cols, rows)
  }

  stop(): void {
    const terminal = this.terminal
    this.clear()
    terminal?.kill()
  }

  private clear(): void {
    if (this.typeTimer) clearTimeout(this.typeTimer)
    this.typeTimer = null
    for (const d of this.disposables) d.dispose()
    this.disposables = []
    this.terminal = null
  }
}
