import {
  CONFIDENCE_LEVELS,
  type Confidence,
  type Direction,
  type Entity,
  type EntityMetadata,
  type Floor,
  type Project,
  type Vec2,
} from '../domain/contract'
import { computeDirectionDetailed, directionFromVector, type DirectionResult } from './direction'

const confidenceRank = (confidence: Confidence): number => CONFIDENCE_LEVELS.length - CONFIDENCE_LEVELS.indexOf(confidence)

export function polygonCentroid(points: readonly Vec2[]): Vec2 {
  let areaFactor = 0
  let x = 0
  let z = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!
    const next = points[(index + 1) % points.length]!
    const factor = current.x * next.z - next.x * current.z
    areaFactor += factor
    x += (current.x + next.x) * factor
    z += (current.z + next.z) * factor
  }
  if (Math.abs(areaFactor) <= 1e-10) {
    return points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, z: sum.z + point.z / points.length }), { x: 0, z: 0 })
  }
  return { x: x / (3 * areaFactor), z: z / (3 * areaFactor) }
}

export function entityCenter(entity: Entity, floor?: Floor): Vec2 | undefined {
  switch (entity.kind) {
    case 'wall':
      return { x: (entity.start.x + entity.end.x) / 2, z: (entity.start.z + entity.end.z) / 2 }
    case 'door':
    case 'window': {
      const wall = floor?.entities.find((candidate) => candidate.id === entity.hostWallId && candidate.kind === 'wall')
      if (!wall || wall.kind !== 'wall') return undefined
      const length = Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z)
      if (length <= 1e-12) return undefined
      const ratio = entity.offset / length
      return { x: wall.start.x + (wall.end.x - wall.start.x) * ratio, z: wall.start.z + (wall.end.z - wall.start.z) * ratio }
    }
    case 'slab':
    case 'ceiling':
    case 'space':
      return polygonCentroid(entity.polygon)
    case 'facility':
      return { x: entity.position.x, z: entity.position.z }
    case 'stair':
      return { x: (entity.start.x + entity.end.x) / 2, z: (entity.start.z + entity.end.z) / 2 }
    case 'elevator':
      return { ...entity.center }
  }
}

function boundsCenter(points: readonly Vec2[]): Vec2 | undefined {
  if (points.length === 0) return undefined
  const xs = points.map((point) => point.x)
  const zs = points.map((point) => point.z)
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 }
}

export function floorCenter(floor: Floor): Vec2 {
  const slab = floor.entities.find((entity) => entity.kind === 'slab')
  if (slab?.kind === 'slab') return polygonCentroid(slab.polygon)

  const wallPoints = floor.entities.flatMap((entity) => (entity.kind === 'wall' ? [entity.start, entity.end] : []))
  const wallCenter = boundsCenter(wallPoints)
  if (wallCenter) return wallCenter

  const centers = floor.entities.map((entity) => entityCenter(entity, floor)).filter((point): point is Vec2 => point !== undefined)
  return boundsCenter(centers) ?? { x: 0, z: 0 }
}

function wallNormalDirection(entity: Extract<Entity, { kind: 'wall' }>, north: Vec2): Direction | undefined {
  const dx = entity.end.x - entity.start.x
  const dz = entity.end.z - entity.start.z
  return directionFromVector({ x: dz, z: -dx }, north)
}

export interface EntityDirectionResult extends DirectionResult {
  source?: 'position' | 'host-wall' | 'wall-normal' | 'manual'
  entityId: string
}

export function computeEntityDirection(project: Project, entityId: string): EntityDirectionResult {
  for (const building of project.buildings) {
    for (const floor of building.floors) {
      const entity = floor.entities.find((candidate) => candidate.id === entityId)
      if (!entity) continue
      if (entity.metadata.directionMode === 'manual' && entity.metadata.direction) {
        return { entityId, direction: entity.metadata.direction, distance: 0, source: 'manual' }
      }
      const center = entityCenter(entity, floor)
      if (!center) return { entityId, distance: 0, reason: 'CENTER_DEAD_ZONE' }
      const result = computeDirectionDetailed(center, floorCenter(floor), project.settings.north)
      if (result.direction) return { entityId, ...result, source: 'position' }

      if (entity.kind === 'door' || entity.kind === 'window') {
        const host = floor.entities.find((candidate) => candidate.id === entity.hostWallId)
        if (host?.kind === 'wall') {
          const direction = host.metadata.direction ?? wallNormalDirection(host, project.settings.north)
          if (direction) return { entityId, direction, distance: result.distance, source: 'host-wall' }
        }
      }
      if (entity.kind === 'wall') {
        const direction = wallNormalDirection(entity, project.settings.north)
        if (direction) return { entityId, direction, distance: result.distance, source: 'wall-normal' }
      }
      return { entityId, ...result }
    }
  }
  throw new Error(`未找到实体 ${entityId}`)
}

/** Recompute only auto direction. Manual direction is returned untouched. */
export function applyComputedDirection(metadata: EntityMetadata, direction: Direction | undefined): EntityMetadata {
  if (metadata.directionMode === 'manual' || !direction) return { ...metadata }
  return { ...metadata, direction }
}

export interface MetadataSuggestion {
  renderType?: EntityMetadata['renderType']
  direction?: Direction
  sub?: string
  sid?: string
}

/**
 * Applies inferred values without allowing them to replace confirmed/imported or
 * manually controlled semantics. This is the single precedence gate for importers.
 */
export function applyMetadataSuggestion(
  current: EntityMetadata,
  suggestion: MetadataSuggestion,
  suggestionConfidence: Extract<Confidence, 'inferred-high' | 'inferred-low'> = 'inferred-high',
): EntityMetadata {
  const next = { ...current }
  const mayReplaceSemantic =
    current.renderTypeMode !== 'manual' && confidenceRank(suggestionConfidence) > confidenceRank(current.confidence)
  if (suggestion.renderType && mayReplaceSemantic) next.renderType = suggestion.renderType
  if (suggestion.sub && (!current.sub || mayReplaceSemantic)) next.sub = suggestion.sub
  if (suggestion.direction && current.directionMode === 'auto') next.direction = suggestion.direction
  if (suggestion.sid && current.sidMode === 'auto') next.sid = suggestion.sid
  if (mayReplaceSemantic) next.confidence = suggestionConfidence
  return next
}

export function findFloorForEntity(project: Project, entityId: string): Floor | undefined {
  for (const building of project.buildings) {
    const floor = building.floors.find((candidate) => candidate.entities.some((entity) => entity.id === entityId))
    if (floor) return floor
  }
  return undefined
}
