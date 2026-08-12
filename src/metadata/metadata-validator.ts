import { RENDER_TYPE_BY_KIND, type Entity, type Floor } from '../domain/contract'
import { generateEntitySid, generateSid } from './sid-generator'

export type MetadataValidationProfile = 'compat' | 'release'
export type MetadataIssueSeverity = 'error' | 'warning'

export interface MetadataIssue {
  code: string
  severity: MetadataIssueSeverity
  message: string
  entityId: string
  floorId: string
  path: string
}

const issue = (
  entity: Entity,
  severity: MetadataIssueSeverity,
  code: string,
  message: string,
  path: string,
): MetadataIssue => ({ code, severity, message, entityId: entity.id, floorId: entity.floorId, path })

export function expectedEntitySid(entity: Entity, floor: Floor): string | undefined {
  try {
    return generateSid({
      renderType: entity.metadata.renderType,
      floorName: floor.floorName,
      direction: entity.metadata.direction,
      sequence: entity.metadata.sequence,
      spaceType: entity.kind === 'space' ? entity.spaceType : undefined,
      fireType: entity.kind === 'facility' ? entity.fireType : undefined,
      sub: entity.metadata.sub,
    })
  } catch {
    return undefined
  }
}

export function validateEntityMetadata(
  entity: Entity,
  floor: Floor,
  profile: MetadataValidationProfile = 'release',
): MetadataIssue[] {
  const issues: MetadataIssue[] = []
  const missingSeverity = profile === 'release' ? 'error' : 'warning'
  const expectedRenderType = RENDER_TYPE_BY_KIND[entity.kind]
  if (entity.metadata.renderType !== expectedRenderType) {
    issues.push(issue(entity, 'error', 'RENDER_TYPE_KIND_MISMATCH', `kind=${entity.kind} 必须使用 ${expectedRenderType}`, 'metadata.renderType'))
  }
  if (!Number.isInteger(entity.metadata.sequence) || entity.metadata.sequence < 1) {
    issues.push(issue(entity, 'error', 'INVALID_SEQUENCE', 'sequence 必须是从 1 开始的整数', 'metadata.sequence'))
  }
  const directionRequired = !['CEILING', 'FACILITY', 'WALL', 'SPACE'].includes(entity.metadata.renderType)
  if (directionRequired && entity.metadata.directionMode === 'manual' && !entity.metadata.direction) {
    issues.push(issue(entity, 'error', 'MANUAL_DIRECTION_MISSING', '人工方位模式缺少 direction', 'metadata.direction'))
  }
  if (directionRequired && !entity.metadata.direction) {
    issues.push(issue(entity, missingSeverity, 'DIRECTION_MISSING', '带方位 SID 缺少 direction', 'metadata.direction'))
  }
  if (entity.kind === 'space' && !entity.spaceType) {
    issues.push(issue(entity, 'error', 'SPACE_TYPE_MISSING', 'SPACE 必须包含 spaceType', 'spaceType'))
  }
  if (entity.kind === 'facility' && !entity.fireType) {
    issues.push(issue(entity, 'error', 'FIRE_TYPE_MISSING', 'FACILITY 必须包含 fireType', 'fireType'))
  }

  const expected = expectedEntitySid(entity, floor)
  if (!expected) {
    issues.push(issue(entity, missingSeverity, 'SID_NOT_GENERATABLE', '当前语义字段无法生成合法 SID', 'metadata'))
    return issues
  }

  if (entity.metadata.sidMode === 'manual') {
    const manual = entity.metadata.manualSid ?? entity.metadata.sid
    if (!manual) {
      issues.push(issue(entity, 'error', 'MANUAL_SID_MISSING', '人工 SID 模式缺少 manualSid', 'metadata.manualSid'))
    } else if (manual !== expected) {
      issues.push(issue(entity, 'error', 'MANUAL_SID_MISMATCH', `人工 SID 与实体语义不一致，期望 ${expected}`, 'metadata.manualSid'))
    }
  } else if (entity.metadata.sid && entity.metadata.sid !== expected) {
    issues.push(issue(entity, 'error', 'AUTO_SID_STALE', `持久化 SID 已过期，期望 ${expected}`, 'metadata.sid'))
  }

  try {
    const actual = generateEntitySid(entity, floor)
    if (actual !== expected) {
      issues.push(issue(entity, 'error', 'SID_SEMANTIC_MISMATCH', `SID ${actual} 与语义字段不一致`, 'metadata.sid'))
    }
  } catch (error) {
    issues.push(issue(entity, missingSeverity, 'SID_MISSING', error instanceof Error ? error.message : 'SID 缺失', 'metadata.sid'))
  }
  return issues
}

export function validateFloorMetadata(
  floor: Floor,
  profile: MetadataValidationProfile = 'release',
): MetadataIssue[] {
  const issues = floor.entities.flatMap((entity) => validateEntityMetadata(entity, floor, profile))
  const bySid = new Map<string, Entity[]>()
  for (const entity of floor.entities) {
    try {
      const sid = generateEntitySid(entity, floor)
      const entities = bySid.get(sid) ?? []
      entities.push(entity)
      bySid.set(sid, entities)
    } catch {
      // Missing/invalid SID is already represented above.
    }
  }
  for (const [sid, entities] of bySid) {
    if (entities.length < 2) continue
    for (const entity of entities) issues.push(issue(entity, 'error', 'SID_DUPLICATE', `SID 重复: ${sid}`, 'metadata.sid'))
  }
  return issues
}
