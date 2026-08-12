import { isSelfIntersectingPolygon, polygonArea } from '../domain/project-schema'
import type { Vec2 } from '../domain/contract'

export const MIN_SPACE_AREA = 0.01

const DEFAULT_POINT_EPSILON = 1e-9

export interface SpacePolygonMetrics {
  area: number
  centroidX: number
  centroidZ: number
  vertexCount: number
}

export type SpacePolygonCommitDecision =
  | {
      accepted: true
      polygon: Vec2[]
      area: number
      centroid: Vec2
    }
  | {
      accepted: false
      reason: 'too-few-points' | 'duplicate-points' | 'too-small' | 'self-intersection'
      area?: number
    }

export function pointsEqual(left: Vec2, right: Vec2, epsilon = DEFAULT_POINT_EPSILON): boolean {
  return Math.abs(left.x - right.x) <= epsilon && Math.abs(left.z - right.z) <= epsilon
}

function cloneAndNormalizePolygon(points: readonly Vec2[]): Vec2[] {
  const polygon = points.map((point) => ({ x: point.x, z: point.z }))
  if (polygon.length > 1 && pointsEqual(polygon[0]!, polygon[polygon.length - 1]!)) polygon.pop()
  return polygon
}

function hasDuplicatePoints(points: readonly Vec2[]): boolean {
  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 1; second < points.length; second += 1) {
      if (pointsEqual(points[first]!, points[second]!)) return true
    }
  }
  return false
}

export function spacePolygonMetrics(points: readonly Vec2[]): SpacePolygonMetrics {
  const polygon = cloneAndNormalizePolygon(points)
  const signedArea = polygonArea(polygon)
  const area = Math.abs(signedArea)

  if (polygon.length === 0) {
    return { area: 0, centroidX: 0, centroidZ: 0, vertexCount: 0 }
  }

  if (Math.abs(signedArea) <= DEFAULT_POINT_EPSILON) {
    const sum = polygon.reduce(
      (totals, point) => ({ x: totals.x + point.x, z: totals.z + point.z }),
      { x: 0, z: 0 },
    )
    return {
      area,
      centroidX: sum.x / polygon.length,
      centroidZ: sum.z / polygon.length,
      vertexCount: polygon.length,
    }
  }

  let centroidNumeratorX = 0
  let centroidNumeratorZ = 0
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]!
    const next = polygon[(index + 1) % polygon.length]!
    const cross = current.x * next.z - next.x * current.z
    centroidNumeratorX += (current.x + next.x) * cross
    centroidNumeratorZ += (current.z + next.z) * cross
  }

  return {
    area,
    centroidX: centroidNumeratorX / (6 * signedArea),
    centroidZ: centroidNumeratorZ / (6 * signedArea),
    vertexCount: polygon.length,
  }
}

export function decideSpacePolygonCommit(
  points: readonly Vec2[],
  minimumArea = MIN_SPACE_AREA,
): SpacePolygonCommitDecision {
  const polygon = cloneAndNormalizePolygon(points)
  if (polygon.length < 3) return { accepted: false, reason: 'too-few-points' }

  const area = Math.abs(polygonArea(polygon))
  if (hasDuplicatePoints(polygon)) return { accepted: false, reason: 'duplicate-points', area }
  if (isSelfIntersectingPolygon(polygon)) return { accepted: false, reason: 'self-intersection', area }
  if (area < minimumArea) return { accepted: false, reason: 'too-small', area }

  const metrics = spacePolygonMetrics(polygon)
  return {
    accepted: true,
    polygon,
    area,
    centroid: { x: metrics.centroidX, z: metrics.centroidZ },
  }
}
