import { spawn } from 'child_process'

/** Open a file or a web address with the system's default app. */
export function openFile(target: string): void {
  const isUrl = /^https?:\/\//.test(target)
  const [command, args] = process.platform === 'darwin' ? ['open', [target]]
    // `start` goes through cmd, which would split an address at `&`.
    : process.platform === 'win32' ? (isUrl ? ['rundll32', ['url.dll,FileProtocolHandler', target]] : ['cmd', ['/c', 'start', '', target]])
      : ['xdg-open', [target]]
  try {
    spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref()
  } catch {
    // No opener: the path is printed.
  }
}
