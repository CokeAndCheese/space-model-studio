import type { Direction, Entity, Floor, PolygonEntity, Vec2 } from './contract'
import { makeCeiling, makeSlab, makeSpace } from './entity-factory'
import { polygonArea } from './project-schema'
import { computeDirection, directionFromVector } from '../metadata/direction'
import { floorCenter, polygonCentroid } from '../metadata/semantic-generator'
import { extractWallEnclosures, type WallEnclosure } from './wall-enclosure'

const POINT_TOLERANCE = 1e-6

export interface GeneratedRoomSet {
  enclosure: WallEnclosure
  entities: Entity[]
}

export interface RoomGenerationResult {
  rooms: WallEnclosure[]
  generated: GeneratedRoomSet[]
  entities: Entity[]
}

function pointOnSegment(point: Vec2, start: Vec2, end: Vec2): boolean {
  const cross = (end.x - start.x) * (point.z - start.z) - (end.z - start.z) * (point.x - start.x)
  if (Math.abs(cross) > POINT_TOLERANCE) return false
  return point.x >= Math.min(start.x, end.x) - POINT_TOLERANCE
    && point.x <= Math.max(start.x, end.x) + POINT_TOLERANCE
    && point.z >= Math.min(start.z, end.z) - POINT_TOLERANCE
    && point.z <= Math.max(start.z, end.z) + POINT_TOLERANCE
}

function pointInPolygon(point: Vec2, polygon: readonly Vec2[]): boolean {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const start = polygon[previous]!
    const end = polygon[index]!
    if (pointOnSegment(point, start, end)) return true
    const crosses = (start.z > point.z) !== (end.z > point.z)
      && point.x < ((end.x - start.x) * (point.z - start.z)) / (end.z - start.z) + start.x
    if (crosses) inside = !inside
  }
  return inside
}

function sameRoom(existing: PolygonEntity, enclosure: WallEnclosure): boolean {
  const existingArea = Math.abs(polygonArea(existing.polygon))
  if (existingArea <= POINT_TOLERANCE) return false
  const ratio = existingArea / enclosure.area
  if (ratio < 0.7 || ratio > 1.3) return false
  const existingCenter = polygonCentroid(existing.polygon)
  const roomCenter = polygonCentroid(enclosure.polygon)
  return pointInPolygon(existingCenter, enclosure.polygon) && pointInPolygon(roomCenter, existing.polygon)
}

function surfaceCoversRoom(existing: PolygonEntity, enclosure: WallEnclosure): boolean {
  const existingArea = Math.abs(polygonArea(existing.polygon))
  if (existingArea < enclosure.area * 0.9) return false
  return pointInPolygon(polygonCentroid(enclosure.polygon), existing.polygon)
}

function fallbackRoomDirection(polygon: readonly Vec2[], north: Vec2): Direction | undefined {
  let longest: { start: Vec2; end: Vec2; length: number } | undefined
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index]!
    const end = polygon[(index + 1) % polygon.length]!
    const length = Math.hypot(end.x - start.x, end.z - start.z)
    if (!longest || length > longest.length) longest = { start, end, length }
  }
  if (!longest) return undefined
  const dx = longest.end.x - longest.start.x
  const dz = longest.end.z - longest.start.z
  return directionFromVector({ x: -dz, z: dx }, north)
}

function roomDirection(floor: Floor, polygon: readonly Vec2[], north: Vec2): Direction | undefined {
  return computeDirection(polygonCentroid(polygon), floorCenter(floor), north)
    ?? fallbackRoomDirection(polygon, north)
}

function nextCeilingIndex(floor: Floor): number {
  let maximum = 0
  for (const entity of floor.entities) {
    if (entity.metadata.renderType !== 'CEILING') continue
    maximum = Math.max(maximum, entity.metadata.sequence)
    const match = /^SLAB_([0-9]+)$/i.exec(entity.metadata.sub ?? '')
    if (match) maximum = Math.max(maximum, Number(match[1]))
  }
  return maximum + 1
}

function nextSpaceSequence(floor: Floor): number {
  let sequence = 1
  for (const entity of floor.entities) {
    if (entity.kind !== 'space' || entity.spaceType !== 'OFFICE') continue
    sequence = Math.max(sequence, entity.metadata.sequence + 1)
  }
  return sequence
}

/**
 * Detect wall-bounded rooms and create only the missing semantic/physical entities.
 * Existing entities are never modified or deleted, so confirmed human work always wins.
 */
export function generateMissingRoomEntities(floor: Floor, north: Vec2): RoomGenerationResult {
  const extraction = extractWallEnclosures(floor.entities.filter((entity) => entity.kind === 'wall'))
  const existingSpaces = floor.entities.filter((entity): entity is Extract<Entity, { kind: 'space' }> => entity.kind === 'space')
  const existingSlabs = floor.entities.filter((entity): entity is Extract<Entity, { kind: 'slab' }> => entity.kind === 'slab')
  const existingCeilings = floor.entities.filter((entity): entity is Extract<Entity, { kind: 'ceiling' }> => entity.kind === 'ceiling')
  const generated: GeneratedRoomSet[] = []
  let ceilingIndex = nextCeilingIndex(floor)
  let spaceSequence = nextSpaceSequence(floor)
  let roomNumber = existingSpaces.length + 1
  let slabNumber = existingSlabs.length + 1
  let ceilingNumber = existingCeilings.length + 1

  for (const enclosure of extraction.rooms) {
    const entities: Entity[] = []
    const direction = roomDirection(floor, enclosure.polygon, north)

    if (!existingSpaces.some((entity) => sameRoom(entity, enclosure))) {
      const space = makeSpace(floor.id, {
        polygon: enclosure.polygon,
        spaceType: 'OFFICE',
        name: `自动空间 ${roomNumber}`,
        metadata: {
          confidence: 'inferred-low',
          ...(direction ? { direction } : {}),
          directionMode: 'auto',
          renderTypeMode: 'auto',
          sequence: spaceSequence++,
        },
      })
      entities.push(space)
      existingSpaces.push(space)
      roomNumber += 1
    }

    if (!existingSlabs.some((entity) => surfaceCoversRoom(entity, enclosure))) {
      const index = ceilingIndex++
      const slab = makeSlab(floor.id, {
        polygon: enclosure.polygon,
        baseOffset: -0.2,
        thickness: 0.2,
        name: `自动地板 ${slabNumber}`,
        metadata: {
          confidence: 'inferred-high',
          renderTypeMode: 'auto',
          sequence: index,
          sub: `SLAB_${String(index).padStart(2, '0')}`,
        },
      })
      entities.push(slab)
      existingSlabs.push(slab)
      slabNumber += 1
    }

    if (!existingCeilings.some((entity) => surfaceCoversRoom(entity, enclosure))) {
      const index = ceilingIndex++
      const ceiling = makeCeiling(floor.id, {
        polygon: enclosure.polygon,
        height: Math.max(0, floor.clearHeight - 0.1),
        thickness: 0.1,
        name: `自动天花 ${ceilingNumber}`,
        metadata: {
          confidence: 'inferred-high',
          renderTypeMode: 'auto',
          sequence: index,
          sub: `SLAB_${String(index).padStart(2, '0')}`,
        },
      })
      entities.push(ceiling)
      existingCeilings.push(ceiling)
      ceilingNumber += 1
    }

    if (entities.length) generated.push({ enclosure, entities })
  }

  return { rooms: extraction.rooms, generated, entities: generated.flatMap((item) => item.entities) }
}
