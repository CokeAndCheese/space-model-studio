import type { Project } from '../domain/contract'
import { projectSchema } from '../domain/project-schema'
import { validateFloorMetadata } from '../metadata/metadata-validator'
import { computeEntityDirection } from '../metadata/semantic-generator'
import { collectSidDuplicates } from '../metadata/sid-generator'
import { createValidationReport, type ValidationIssue, type ValidationReport } from './validation-report'
import type { ValidationProfile } from './validation-profiles'

const pathToString = (path: (string | number)[]): string =>
  path.reduce<string>((result, part) => (typeof part === 'number' ? `${result}[${part}]` : result ? `${result}.${part}` : part), '')

export function validateProject(project: unknown, profile: ValidationProfile = 'release'): ValidationReport {
  const parsed = projectSchema.safeParse(project)
  const issues: ValidationIssue[] = []
  const source = project as Partial<Project>
  const buildings = Array.isArray(source?.buildings) ? source.buildings : []
  const floors = buildings.flatMap((building) => (Array.isArray(building?.floors) ? building.floors : []))
  const entities = floors.flatMap((floor) => (Array.isArray(floor?.entities) ? floor.entities : []))

  if (!parsed.success) {
    issues.push(
      ...parsed.error.issues.map((item) => ({
        code: `PROJECT_SCHEMA_${item.code.toUpperCase()}`,
        severity: 'error' as const,
        message: item.message,
        path: pathToString(item.path),
      })),
    )
    return createValidationReport(profile, issues, {
      buildings: buildings.length,
      floors: floors.length,
      entities: entities.length,
    })
  }

  const validProject = parsed.data as Project
  for (const building of validProject.buildings) {
    for (const floor of building.floors) {
      issues.push(
        ...validateFloorMetadata(floor, profile).map((metadataIssue) => ({
          ...metadataIssue,
          buildingId: building.id,
        })),
      )
      for (const entity of floor.entities) {
        if (
          entity.metadata.directionMode !== 'auto' ||
          entity.metadata.direction ||
          entity.metadata.renderType === 'CEILING' ||
          entity.metadata.renderType === 'FACILITY' ||
          entity.metadata.renderType === 'WALL' ||
          entity.metadata.renderType === 'SPACE'
        ) continue
        const result = computeEntityDirection(validProject, entity.id)
        if (!result.direction && result.reason === 'CENTER_DEAD_ZONE') {
          issues.push({
            code: 'DIRECTION_CENTER_UNRESOLVED',
            severity: profile === 'release' ? 'error' : 'warning',
            message: '实体位于楼层中心死区，无法可靠推断方位',
            path: 'metadata.direction',
            buildingId: building.id,
            floorId: floor.id,
            entityId: entity.id,
          })
        }
      }
    }
  }

  for (const [sid, ids] of collectSidDuplicates(validProject.buildings.flatMap((building) => building.floors))) {
    for (const entityId of ids) {
      if (issues.some((item) => item.code === 'SID_DUPLICATE' && item.entityId === entityId)) continue
      issues.push({ code: 'SID_DUPLICATE', severity: 'error', message: `SID 全局重复: ${sid}`, path: 'metadata.sid', entityId })
    }
  }

  return createValidationReport(profile, issues, {
    buildings: validProject.buildings.length,
    floors: validProject.buildings.reduce((sum, building) => sum + building.floors.length, 0),
    entities: validProject.buildings.reduce(
      (sum, building) => sum + building.floors.reduce((floorSum, floor) => floorSum + floor.entities.length, 0),
      0,
    ),
  })
}

export function assertValidProject(project: unknown, profile: ValidationProfile = 'release'): Project {
  const report = validateProject(project, profile)
  if (!report.valid) {
    const summary = report.errors.slice(0, 5).map((item) => `${item.path}: ${item.message}`).join('; ')
    throw new Error(`项目验证失败 (${report.errors.length} errors): ${summary}`)
  }
  return projectSchema.parse(project) as Project
}
