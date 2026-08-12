import { ZodError } from 'zod'
import type { Project } from './contract'
import { projectSchema } from './project-schema'

const LEGACY_METADATA_SPEC_VERSION = '3.2-directional'

function migrateProject(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const project = value as Record<string, unknown>
  if (project.metadataSpecVersion !== LEGACY_METADATA_SPEC_VERSION) return value
  project.metadataSpecVersion = '3.3-semantic'
  const buildings = Array.isArray(project.buildings) ? project.buildings : []
  for (const building of buildings) {
    if (!building || typeof building !== 'object') continue
    const floors = Array.isArray((building as Record<string, unknown>).floors)
      ? (building as Record<string, unknown>).floors as unknown[]
      : []
    for (const floor of floors) {
      if (!floor || typeof floor !== 'object') continue
      const entities = Array.isArray((floor as Record<string, unknown>).entities)
        ? (floor as Record<string, unknown>).entities as unknown[]
        : []
      for (const entity of entities) {
        if (!entity || typeof entity !== 'object') continue
        const record = entity as Record<string, unknown>
        if (record.kind !== 'wall' && record.kind !== 'space') continue
        const metadata = record.metadata
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue
        const typed = metadata as Record<string, unknown>
        // Auto SIDs are projections and must be regenerated under 3.3. Manual
        // human identifiers are retained verbatim for explicit review.
        if (typed.sidMode !== 'manual') delete typed.sid
      }
    }
  }
  return project
}

export class ProjectFormatError extends Error {
  readonly issues: readonly { path: string; message: string }[]

  constructor(message: string, issues: readonly { path: string; message: string }[] = []) {
    super(message)
    this.name = 'ProjectFormatError'
    this.issues = issues
  }
}

function formatZodError(error: ZodError): ProjectFormatError {
  const issues = error.issues.map((item) => ({ path: item.path.join('.'), message: item.message }))
  const detail = issues.slice(0, 5).map((item) => `${item.path || '<root>'}: ${item.message}`).join('; ')
  return new ProjectFormatError(`不支持或损坏的 Space Model Studio 项目: ${detail}`, issues)
}

/** Parses JSON and rejects unknown, malformed, cross-floor or host-invalid data. */
export function parseProject(text: string): Project {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new ProjectFormatError(`项目 JSON 无法解析: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return projectSchema.parse(migrateProject(value)) as Project
  } catch (error) {
    if (error instanceof ZodError) throw formatZodError(error)
    throw error
  }
}

/** Validates before writing and never mutates the caller's in-memory project. */
export function serializeProject(project: Project, space = 2): string {
  try {
    const checked = projectSchema.parse(JSON.parse(JSON.stringify(project))) as Project
    checked.updatedAt = new Date().toISOString()
    return JSON.stringify(projectSchema.parse(checked), null, space)
  } catch (error) {
    if (error instanceof ZodError) throw formatZodError(error)
    throw error
  }
}

export function cloneProject(project: Project): Project {
  return projectSchema.parse(JSON.parse(JSON.stringify(project))) as Project
}
