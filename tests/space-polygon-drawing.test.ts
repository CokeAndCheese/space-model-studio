import { describe, expect, it } from 'vitest'
import {
  MIN_SPACE_AREA,
  decideSpacePolygonCommit,
  pointsEqual,
  spacePolygonMetrics,
} from '../src/components/space-polygon-drawing'

describe('SPACE polygon drawing', () => {
  it('accepts a concave polygon and reports its area and centroid', () => {
    const polygon = [
      { x: 0, z: 0 },
      { x: 4, z: 0 },
      { x: 4, z: 4 },
      { x: 2, z: 2 },
      { x: 0, z: 4 },
    ]

    expect(decideSpacePolygonCommit(polygon)).toEqual({
      accepted: true,
      polygon,
      area: 12,
      centroid: { x: 2, z: 14 / 9 },
    })
  })

  it('rejects fewer than three points', () => {
    expect(decideSpacePolygonCommit([{ x: 0, z: 0 }, { x: 1, z: 0 }])).toEqual({
      accepted: false,
      reason: 'too-few-points',
    })
  })

  it('rejects duplicate vertices while allowing a repeated closing point', () => {
    expect(decideSpacePolygonCommit([
      { x: 0, z: 0 },
      { x: 2, z: 0 },
      { x: 2, z: 2 },
      { x: 2, z: 2 },
      { x: 0, z: 2 },
    ])).toMatchObject({ accepted: false, reason: 'duplicate-points' })

    const closed = [{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 2 }, { x: 0, z: 2 }, { x: 0, z: 0 }]
    expect(decideSpacePolygonCommit(closed)).toMatchObject({
      accepted: true,
      polygon: closed.slice(0, -1),
      area: 4,
    })
  })

  it('rejects tiny and zero-area polygons', () => {
    expect(decideSpacePolygonCommit([
      { x: 0, z: 0 },
      { x: MIN_SPACE_AREA / 2, z: 0 },
      { x: 0, z: MIN_SPACE_AREA / 2 },
    ])).toMatchObject({ accepted: false, reason: 'too-small' })
    expect(decideSpacePolygonCommit([
      { x: 0, z: 0 },
      { x: 1, z: 1 },
      { x: 2, z: 2 },
    ])).toMatchObject({ accepted: false, reason: 'too-small', area: 0 })
  })

  it('rejects self-intersecting polygons', () => {
    expect(decideSpacePolygonCommit([
      { x: 0, z: 0 },
      { x: 2, z: 2 },
      { x: 0, z: 2 },
      { x: 2, z: 0 },
    ])).toMatchObject({ accepted: false, reason: 'self-intersection' })
  })

  it('returns cloned points and accurate metrics', () => {
    const points = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 2 }, { x: 0, z: 2 }]
    const decision = decideSpacePolygonCommit(points)
    expect(decision.accepted).toBe(true)
    if (decision.accepted) {
      expect(decision.polygon).not.toBe(points)
      expect(decision.polygon[0]).not.toBe(points[0])
    }
    expect(spacePolygonMetrics(points)).toEqual({
      area: 8,
      centroidX: 2,
      centroidZ: 1,
      vertexCount: 4,
    })
    expect(spacePolygonMetrics([{ x: 0, z: 0 }, { x: 2, z: 2 }, { x: 4, z: 4 }])).toEqual({
      area: 0,
      centroidX: 2,
      centroidZ: 2,
      vertexCount: 3,
    })
    expect(pointsEqual({ x: 1, z: 1 }, { x: 1 + 1e-10, z: 1 - 1e-10 })).toBe(true)
  })
})
