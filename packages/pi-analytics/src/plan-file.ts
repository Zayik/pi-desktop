import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { emptyPlan, isCachePlan, type CachePlan } from './cache-plan'

/** The plan on disk, or an empty one when there is none or it does not parse. */
export function readPlan(path: string): CachePlan {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isCachePlan(parsed) ? parsed : emptyPlan(0)
  } catch {
    return emptyPlan(0)
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temp, path)
}
