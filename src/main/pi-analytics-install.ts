import { readFileSync } from 'fs'
import { join } from 'path'

/** Pi's global settings file, where the packages installed with `pi install` are listed. */
export function piGlobalSettingsPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ||
    join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.pi', 'agent')
  return join(agentDir, 'settings.json')
}

/** Whether the user installed pi-analytics in Pi (`pi install`), which then loads it in every session. */
export function piAnalyticsInstalled(path = piGlobalSettingsPath()): boolean {
  try {
    const packages: unknown = (JSON.parse(readFileSync(path, 'utf8')) as { packages?: unknown }).packages
    return Array.isArray(packages) && packages.some((entry) => {
      const source = typeof entry === 'string' ? entry : (entry as { source?: unknown } | null)?.source
      return typeof source === 'string' && /(^|[/:@])pi-analytics(@|$|\/|\\)/.test(source)
    })
  } catch {
    return false
  }
}
