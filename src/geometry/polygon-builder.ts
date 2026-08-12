import { BufferGeometry, Float32BufferAttribute, ShapeUtils, Vector2, type Vector3Tuple } from 'three'
import type { Vec2 } from '../domain/contract'
import { assertFinite, assertPositive, GeometryBuildError } from './geometry-error'

const EPSILON = 1e-8

function pointsEqual(left: Vec2, right: Vec2): boolean {
  return Math.abs(left.x - right.x) <= EPSILON && Math.abs(left.z - right.z) <= EPSILON
}

function signedArea(points: readonly Vec2[]): number {
  let twiceArea = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!
    const next = points[(index + 1) % points.length]!
    twiceArea += current.x * next.z - next.x * current.z
  }
  return twiceArea / 2
}

function orientation(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
}

function onSegment(a: Vec2, b: Vec2, point: Vec2): boolean {
  return (
    Math.abs(orientation(a, b, point)) <= EPSILON &&
    point.x >= Math.min(a.x, b.x) - EPSILON &&
    point.x <= Math.max(a.x, b.x) + EPSILON &&
    point.z >= Math.min(a.z, b.z) - EPSILON &&
    point.z <= Math.max(a.z, b.z) + EPSILON
  )
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const abC = orientation(a, b, c)
  const abD = orientation(a, b, d)
  const cdA = orientation(c, d, a)
  const cdB = orientation(c, d, b)
  if (
    ((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON)) &&
    ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON))
  ) {
    return true
  }
  return (
    (Math.abs(abC) <= EPSILON && onSegment(a, b, c)) ||
    (Math.abs(abD) <= EPSILON && onSegment(a, b, d)) ||
    (Math.abs(cdA) <= EPSILON && onSegment(c, d, a)) ||
    (Math.abs(cdB) <= EPSILON && onSegment(c, d, b))
  )
}

/** Validate and normalize an open polygon loop (the closing point is optional). */
export function normalizeSimplePolygon(polygon: readonly Vec2[], entityId?: string): Vec2[] {
  const points = polygon.map((point) => {
    assertFinite(point.x, 'polygon.x', entityId)
    assertFinite(point.z, 'polygon.z', entityId)
    return { x: point.x, z: point.z }
  })
  if (points.length > 1 && pointsEqual(points[0]!, points[points.length - 1]!)) points.pop()
  if (points.length < 3) {
    throw new GeometryBuildError('INVALID_POLYGON', 'Polygon must contain at least three points', entityId)
  }

  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 1; second < points.length; second += 1) {
      if (pointsEqual(points[first]!, points[second]!)) {
        throw new GeometryBuildError('INVALID_POLYGON', 'Polygon contains duplicate points', entityId)
      }
    }
  }

  const area = signedArea(points)
  if (Math.abs(area) <= EPSILON) {
    throw new GeometryBuildError('INVALID_POLYGON', 'Polygon area must be greater than 0', entityId)
  }

  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length
      if (first === second || firstNext === second || secondNext === first) continue
      if (first === 0 && secondNext === 0) continue
      if (segmentsIntersect(points[first]!, points[firstNext]!, points[second]!, points[secondNext]!)) {
        throw new GeometryBuildError('INVALID_POLYGON', 'Polygon must not self-intersect', entityId)
      }
    }
  }
  return points
}

function appendTriangle(target: number[], a: Vector3Tuple, b: Vector3Tuple, c: Vector3Tuple): void {
  target.push(...a, ...b, ...c)
}

/** Build a closed, triangulated vertical prism from a simple XZ polygon. */
export function buildPolygonPrismGeometry(
  polygon: readonly Vec2[],
  bottom: number,
  thickness: number,
  entityId?: string,
): BufferGeometry {
  assertFinite(bottom, 'polygon bottom', entityId)
  assertPositive(thickness, 'polygon thickness', entityId)
  const points = normalizeSimplePolygon(polygon, entityId)
  const area = signedArea(points)
  const faces = ShapeUtils.triangulateShape(
    points.map((point) => new Vector2(point.x, point.z)),
    [],
  )
  if (faces.length === 0) {
    throw new GeometryBuildError('INVALID_POLYGON', 'Polygon could not be triangulated', entityId)
  }

  const top = bottom + thickness
  const positions: number[] = []
  const pointAt = (index: number, y: number): Vector3Tuple => {
    const point = points[index]!
    return [point.x, y, point.z]
  }

  for (const [aIndex, bIndex, cIndex] of faces) {
    const a = points[aIndex]!
    const b = points[bIndex]!
    const c = points[cIndex]!
    const triangleArea = orientation(a, b, c)
    if (Math.abs(triangleArea) <= EPSILON) continue
    const bottomA = pointAt(aIndex, bottom)
    const bottomB = pointAt(bIndex, bottom)
    const bottomC = pointAt(cIndex, bottom)
    const topA = pointAt(aIndex, top)
    const topB = pointAt(bIndex, top)
    const topC = pointAt(cIndex, top)
    if (triangleArea > 0) {
      appendTriangle(positions, bottomA, bottomB, bottomC)
      appendTriangle(positions, topA, topC, topB)
    } else {
      appendTriangle(positions, bottomA, bottomC, bottomB)
      appendTriangle(positions, topA, topB, topC)
    }
  }

  for (let index = 0; index < points.length; index += 1) {
    const next = (index + 1) % points.length
    const bottomA = pointAt(index, bottom)
    const bottomB = pointAt(next, bottom)
    const topA = pointAt(index, top)
    const topB = pointAt(next, top)
    if (area > 0) {
      appendTriangle(positions, bottomA, topB, bottomB)
      appendTriangle(positions, bottomA, topA, topB)
    } else {
      appendTriangle(positions, bottomA, bottomB, topB)
      appendTriangle(positions, bottomA, topB, topA)
    }
  }

  if (positions.length === 0) {
    throw new GeometryBuildError('INVALID_POLYGON', 'Polygon produced no valid triangles', entityId)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  geometry.userData.polygonVertexCount = points.length
  return geometry
}
