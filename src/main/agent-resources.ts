import { app } from 'electron'
import { join } from 'path'

const RESOURCES_DIR_NAME = 'resources'

/**
 * A file the app ships in resources/ (copied as extraResources when packaged),
 * such as an agent extension both Pi and OMP load with `-e`.
 */
export function agentResourcePath(fileName: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, RESOURCES_DIR_NAME, fileName)
    : join(app.getAppPath(), RESOURCES_DIR_NAME, fileName)
}

/** Where the bundled pi-analytics package's built files ship (`packages/pi-analytics/dist` while developing). */
export function piAnalyticsPath(fileName: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'pi-analytics', fileName)
    : join(app.getAppPath(), 'packages', 'pi-analytics', 'dist', fileName)
}
