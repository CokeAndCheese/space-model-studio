import { BoxGeometry, type BufferGeometry } from 'three'
import type { Entity, OpeningEntity, Wall } from '../domain/contract'
import { assertFinite, assertNonNegative, assertPositive, GeometryBuildError } from './geometry-error'
import { mergeGeometryParts } from './geometry-merge'

const EPSILON = 1e-8
export const MIN_WALL_LENGTH = 0.1

interface OpeningRect {
  entity: OpeningEntity
  left: number
  right: number
  bottom: number
  top: number
}

export interface WallSegment {
  /** Coordinates in the wall's local frame. */
  left: number
  right: number
  bottom: number
  top: number
  width: number
  height: number
}

export function wallLength(wall: Wall): number {
  return Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z)
}

function assertWallDimensions(wall: Wall): number {
  assertFinite(wall.start.x, 'wall start.x', wall.id)
  assertFinite(wall.start.z, 'wall start.z', wall.id)
  assertFinite(wall.end.x, 'wall end.x', wall.id)
  assertFinite(wall.end.z, 'wall end.z', wall.id)
  assertFinite(wall.baseOffset, 'wall base offset', wall.id)
  assertPositive(wall.height, 'wall height', wall.id)
  assertPositive(wall.thickness, 'wall thickness', wall.id)
  const length = wallLength(wall)
  if (!Number.isFinite(length) || length <= MIN_WALL_LENGTH) {
    throw new GeometryBuildError(
      'INVALID_DIMENSION',
      `wall length must be greater than ${MIN_WALL_LENGTH}m`,
      wall.id,
    )
  }
  return length
}

/** Resolve references in authoritative wall.openings order and reject relation drift. */
export function resolveWallOpenings(wall: Wall, entities: readonly Entity[]): OpeningEntity[] {
  const entityById = new Map<string, Entity>()
  for (const entity of entities) {
    if (entityById.has(entity.id)) {
      throw new GeometryBuildError('INVALID_OPENING', `Duplicate entity id ${entity.id}`, wall.id)
    }
    entityById.set(entity.id, entity)
  }
  const referenced = new Set<string>()
  const openings = wall.openings.map((openingId) => {
    if (referenced.has(openingId)) {
      throw new GeometryBuildError('INVALID_OPENING', `Wall contains duplicate opening ${openingId}`, wall.id)
    }
    referenced.add(openingId)
    const entity = entityById.get(openingId)
    if (!entity || (entity.kind !== 'door' && entity.kind !== 'window')) {
      throw new GeometryBuildError('INVALID_OPENING', `Wall references missing opening ${openingId}`, wall.id)
    }
    if (entity.hostWallId !== wall.id) {
      throw new GeometryBuildError('INVALID_OPENING', `Opening ${openingId} belongs to another wall`, wall.id)
    }
    return entity
  })

  for (const entity of entities) {
    if ((entity.kind === 'door' || entity.kind === 'window') && entity.hostWallId === wall.id && !referenced.has(entity.id)) {
      throw new GeometryBuildError('INVALID_OPENING', `Wall is missing hosted opening reference ${entity.id}`, wall.id)
    }
  }
  return openings
}

function validateOpenings(wall: Wall, openings: readonly OpeningEntity[], length: number): OpeningRect[] {
  const expected = new Set(wall.openings)
  if (expected.size !== wall.openings.length) {
    throw new GeometryBuildError('INVALID_OPENING', 'Wall contains duplicate opening references', wall.id)
  }
  const received = new Set<string>()
  for (const opening of openings) {
    if (received.has(opening.id)) {
      throw new GeometryBuildError('INVALID_OPENING', `Opening ${opening.id} was provided more than once`, wall.id)
    }
    received.add(opening.id)
    if (!expected.has(opening.id)) {
      throw new GeometryBuildError('INVALID_OPENING', `Opening ${opening.id} is not referenced by the wall`, wall.id)
    }
  }
  for (const openingId of expected) {
    if (!received.has(openingId)) {
      throw new GeometryBuildError('INVALID_OPENING', `Wall opening ${openingId} was not supplied`, wall.id)
    }
  }

  const rects = openings.map((opening): OpeningRect => {
    if (opening.hostWallId !== wall.id) {
      throw new GeometryBuildError('INVALID_OPENING', `Opening ${opening.id} belongs to another wall`, wall.id)
    }
    assertNonNegative(opening.offset, 'opening offset', opening.id)
    assertPositive(opening.width, 'opening width', opening.id)
    assertPositive(opening.height, 'opening height', opening.id)
    assertPositive(opening.depth, 'opening depth', opening.id)
    assertNonNegative(opening.sillHeight, 'opening sill height', opening.id)
    const left = opening.offset - opening.width / 2
    const right = opening.offset + opening.width / 2
    const bottom = opening.sillHeight
    const top = opening.sillHeight + opening.height
    if (left < -EPSILON || right > length + EPSILON) {
      throw new GeometryBuildError('INVALID_OPENING', `Opening ${opening.id} exceeds wall length`, wall.id)
    }
    if (top > wall.height + EPSILON) {
      throw new GeometryBuildError('INVALID_OPENING', `Opening ${opening.id} exceeds wall height`, wall.id)
    }
    return {
      entity: opening,
      left: Math.max(0, left),
      right: Math.min(length, right),
      bottom: Math.max(0, bottom),
      top: Math.min(wall.height, top),
    }
  })
  rects.sort((left, right) => left.left - right.left || left.right - right.right || left.entity.id.localeCompare(right.entity.id))
  for (let index = 1; index < rects.length; index += 1) {
    const previous = rects[index - 1]!
    const current = rects[index]!
    if (current.left < previous.right - EPSILON) {
      throw new GeometryBuildError(
        'INVALID_OPENING',
        `Openings ${previous.entity.id} and ${current.entity.id} overlap`,
        wall.id,
      )
    }
  }
  return rects
}

function uniqueSorted(values: number[]): number[] {
  values.sort((left, right) => left - right)
  const unique: number[] = []
  for (const value of values) {
    if (unique.length === 0 || Math.abs(value - unique[unique.length - 1]!) > EPSILON) unique.push(value)
  }
  return unique
}

function remainingVerticalIntervals(height: number, holes: readonly OpeningRect[]): Array<[number, number]> {
  if (holes.length === 0) return [[0, height]]
  const intervals = holes
    .map((hole): [number, number] => [hole.bottom, hole.top])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const merged: Array<[number, number]> = []
  for (const interval of intervals) {
    const previous = merged[merged.length - 1]
    if (!previous || interval[0] > previous[1] + EPSILON) merged.push([...interval])
    else previous[1] = Math.max(previous[1], interval[1])
  }
  const remaining: Array<[number, number]> = []
  let cursor = 0
  for (const [bottom, top] of merged) {
    if (bottom > cursor + EPSILON) remaining.push([cursor, bottom])
    cursor = Math.max(cursor, top)
  }
  if (cursor < height - EPSILON) remaining.push([cursor, height])
  return remaining
}

/** Partition a wall in local XY, subtracting every rectangular opening without CSG. */
export function computeWallSegments(wall: Wall, openings: readonly OpeningEntity[]): WallSegment[] {
  const length = assertWallDimensions(wall)
  const rects = validateOpenings(wall, openings, length)
  const cuts = uniqueSorted([0, length, ...rects.flatMap((opening) => [opening.left, opening.right])])
  const segments: WallSegment[] = []
  for (let index = 0; index < cuts.length - 1; index += 1) {
    const left = cuts[index]!
    const right = cuts[index + 1]!
    const width = right - left
    if (width <= EPSILON) continue
    const activeHoles = rects.filter((opening) => opening.left < right - EPSILON && opening.right > left + EPSILON)
    for (const [relativeBottom, relativeTop] of remainingVerticalIntervals(wall.height, activeHoles)) {
      const segmentHeight = relativeTop - relativeBottom
      if (segmentHeight <= EPSILON) continue
      segments.push({
        left,
        right,
        bottom: wall.baseOffset + relativeBottom,
        top: wall.baseOffset + relativeTop,
        width,
        height: segmentHeight,
      })
    }
  }
  if (segments.length === 0) {
    throw new GeometryBuildError('INVALID_OPENING', 'Openings remove the entire wall solid', wall.id)
  }
  return segments
}

/** Build all remaining wall solids and merge them into one BufferGeometry. */
export function buildWallGeometry(wall: Wall, openings: readonly OpeningEntity[] = []): BufferGeometry {
  const segments = computeWallSegments(wall, openings)
  const parts = segments.map((segment) => {
    const geometry = new BoxGeometry(segment.width, segment.height, wall.thickness)
    geometry.translate((segment.left + segment.right) / 2, (segment.bottom + segment.top) / 2, 0)
    return geometry
  })
  const geometry = mergeGeometryParts(parts, wall.id)
  geometry.userData.wallSegmentCount = segments.length
  geometry.userData.openingCount = openings.length
  return geometry
}
