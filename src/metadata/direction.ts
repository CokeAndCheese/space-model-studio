import { DIRECTIONS, type Direction, type Vec2 } from '../domain/contract'

export const DEFAULT_DIRECTION_DEAD_ZONE = 0.1

export interface DirectionResult {
  direction?: Direction
  distance: number
  angle?: number
  reason?: 'CENTER_DEAD_ZONE' | 'INVALID_NORTH'
}

export function normalizeVector(vector: Vec2): Vec2 | undefined {
  const length = Math.hypot(vector.x, vector.z)
  if (!Number.isFinite(length) || length <= 1e-12) return undefined
  return { x: vector.x / length, z: vector.z / length }
}

/** Clockwise in plan view where north -Z rotates to east +X. */
export function rotateClockwise90(vector: Vec2): Vec2 {
  return { x: -vector.z, z: vector.x }
}

export function computeDirectionDetailed(
  point: Vec2,
  center: Vec2,
  north: Vec2 = { x: 0, z: -1 },
  deadZone = DEFAULT_DIRECTION_DEAD_ZONE,
): DirectionResult {
  const normalizedNorth = normalizeVector(north)
  const dx = point.x - center.x
  const dz = point.z - center.z
  const distance = Math.hypot(dx, dz)
  if (!normalizedNorth) return { distance, reason: 'INVALID_NORTH' }
  if (!Number.isFinite(distance) || distance < deadZone) return { distance, reason: 'CENTER_DEAD_ZONE' }

  const normalizedOffset = { x: dx / distance, z: dz / distance }
  const east = rotateClockwise90(normalizedNorth)
  const northComponent = normalizedOffset.x * normalizedNorth.x + normalizedOffset.z * normalizedNorth.z
  const eastComponent = normalizedOffset.x * east.x + normalizedOffset.z * east.z
  const angle = Math.atan2(eastComponent, northComponent)
  const normalizedAngle = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
  const index = Math.floor((normalizedAngle + Math.PI / 8) / (Math.PI / 4)) % DIRECTIONS.length
  return { direction: DIRECTIONS[index]!, distance, angle }
}

/**
 * Returns undefined inside the centre dead-zone. Callers must surface a
 * validation issue or use a documented wall/host fallback instead of assuming N.
 */
export function computeDirection(
  point: Vec2,
  center: Vec2,
  north: Vec2 = { x: 0, z: -1 },
  deadZone = DEFAULT_DIRECTION_DEAD_ZONE,
): Direction | undefined {
  return computeDirectionDetailed(point, center, north, deadZone).direction
}

export function directionFromVector(vector: Vec2, north: Vec2 = { x: 0, z: -1 }): Direction | undefined {
  return computeDirection(vector, { x: 0, z: 0 }, north, 1e-12)
}
