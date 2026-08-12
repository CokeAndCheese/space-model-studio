import { describe, expect, it } from 'vitest'
import type { Vec2 } from '../src/domain/contract'
import { extractBoundedFaces, extractWallEnclosures, type WallCenterlineSegment } from '../src/domain/wall-enclosure'

function wall(id: string, start: Vec2, end: Vec2): WallCenterlineSegment {
  return { id, start, end }
}

const rectangle = [
  wall('south', { x: 0, z: 0 }, { x: 4, z: 0 }),
  wall('east', { x: 4, z: 0 }, { x: 4, z: 3 }),
  wall('north', { x: 4, z: 3 }, { x: 0, z: 3 }),
  wall('west', { x: 0, z: 3 }, { x: 0, z: 0 }),
]

function area(polygon: readonly Vec2[]): number {
  let result = 0
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]!
    const next = polygon[(index + 1) % polygon.length]!
    result += current.x * next.z - next.x * current.z
  }
  return result / 2
}

describe('wall centerline bounded-face extraction', () => {
  it('extracts one deterministic CCW rectangle with canonical key and wall IDs', () => {
    const [face] = extractBoundedFaces(rectangle)
    expect(face).toBeDefined()
    expect(face?.polygon).toEqual([
      { x: 0, z: 0 },
      { x: 4, z: 0 },
      { x: 4, z: 3 },
      { x: 0, z: 3 },
    ])
    expect(area(face!.polygon)).toBeGreaterThan(0)
    expect(face?.key).toBe('0,0|4,0|4,3|0,3')
    expect(face?.wallIds).toEqual(['east', 'north', 'south', 'west'])
  })

  it('extracts adjacent rooms on both sides of a shared wall', () => {
    const walls = [
      ...rectangle,
      wall('divider', { x: 2, z: 0 }, { x: 2, z: 3 }),
    ]
    const faces = extractBoundedFaces(walls)
    expect(faces).toHaveLength(2)
    expect(faces.map((face) => face.key)).toEqual([
      '0,0|2,0|2,3|0,3',
      '2,0|4,0|4,3|2,3',
    ])
    expect(faces[0]?.wallIds).toContain('divider')
    expect(faces[1]?.wallIds).toContain('divider')
  })

  it('is stable under random wall order and independent segment reversal', () => {
    const shuffled = [
      wall('north', { x: 0, z: 3 }, { x: 4, z: 3 }),
      wall('south', { x: 4, z: 0 }, { x: 0, z: 0 }),
      wall('west', { x: 0, z: 0 }, { x: 0, z: 3 }),
      wall('east', { x: 4, z: 3 }, { x: 4, z: 0 }),
    ]
    expect(extractBoundedFaces(shuffled)).toEqual(extractBoundedFaces(rectangle))
  })

  it('coalesces endpoints within the configured tolerance', () => {
    const nearRectangle = [
      wall('south', { x: 0, z: 0 }, { x: 4.0000002, z: 0 }),
      wall('east', { x: 4, z: 0.0000002 }, { x: 4, z: 3 }),
      wall('north', { x: 4, z: 3 }, { x: 0, z: 3.0000002 }),
      wall('west', { x: 0, z: 3 }, { x: 0, z: 0 }),
    ]
    const [face] = extractBoundedFaces(nearRectangle, { endpointTolerance: 1e-5 })
    expect(face).toBeDefined()
    expect(face?.polygon).toHaveLength(4)
    expect(area(face!.polygon)).toBeGreaterThan(0)
  })

  it('returns no face for an open graph', () => {
    expect(extractBoundedFaces(rectangle.slice(0, 3))).toEqual([])
  })

  it('deduplicates a repeated geometric edge without duplicating the face', () => {
    const result = extractWallEnclosures([
      ...rectangle,
      wall('south-copy', { x: 4, z: 0 }, { x: 0, z: 0 }),
    ])
    expect(result.rooms).toHaveLength(1)
    expect(result.rooms[0]?.wallIds).toContain('south')
    expect(result.rooms[0]?.wallIds).toContain('south-copy')
    expect(result.rooms[0]?.area).toBe(12)
    expect(result.diagnostics).toEqual([{ code: 'DUPLICATE_EDGE', wallIds: ['south', 'south-copy'] }])
  })

  it('returns rooms and a no-bounded-face diagnostic for an open graph', () => {
    const result = extractWallEnclosures(rectangle.slice(0, 3))
    expect(result.rooms).toEqual([])
    expect(result.diagnostics).toEqual([{ code: 'NO_BOUNDED_FACE', wallIds: ['east', 'north', 'south'] }])
  })

  it('fails closed when walls cross in both segment interiors', () => {
    const result = extractWallEnclosures([
      ...rectangle,
      wall('horizontal', { x: 0, z: 1.5 }, { x: 4, z: 1.5 }),
      wall('vertical', { x: 2, z: 0 }, { x: 2, z: 3 }),
    ])

    expect(result.rooms).toEqual([])
    expect(result.diagnostics).toContainEqual({
      code: 'NON_ENDPOINT_INTERSECTION',
      wallIds: ['horizontal', 'vertical'],
    })
  })
})
