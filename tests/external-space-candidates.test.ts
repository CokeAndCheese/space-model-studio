import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createDemoHospitalProject } from '../src/domain/project-factory'
import { exportFloorToGlb } from '../src/glb/floor-exporter'
import {
  areSpacePolygonsEquivalent,
  areSpacePolygonsMateriallyOverlapping,
  detectExternalSpaceCandidates,
  type ExternalSpaceInput,
} from '../src/inference/external-space-candidates'
import type { ExternalGlbGeometryPrimitive } from '../src/integration/external-glb-geometry'

type Point = [number, number, number]

function triangle(a: Point, b: Point, c: Point) {
  return [{ x: a[0], y: a[1], z: a[2] }, { x: b[0], y: b[1], z: b[2] }, { x: c[0], y: c[1], z: c[2] }] as const
}

function quad(
  source: string,
  renderType: 'WALL' | 'DOOR' | 'SPACE',
  a: Point,
  b: Point,
  c: Point,
  d: Point,
): ExternalGlbGeometryPrimitive {
  return {
    nodeIndex: Number(source.replace(/\D/g, '')) || 0,
    nodeName: source,
    meshIndex: 0,
    primitiveIndex: 0,
    extras: { sid: source, renderType },
    triangles: [triangle(a, b, c), triangle(a, c, d)],
    bounds: {
      min: {
        x: Math.min(a[0], b[0], c[0], d[0]),
        y: Math.min(a[1], b[1], c[1], d[1]),
        z: Math.min(a[2], b[2], c[2], d[2]),
      },
      max: {
        x: Math.max(a[0], b[0], c[0], d[0]),
        y: Math.max(a[1], b[1], c[1], d[1]),
        z: Math.max(a[2], b[2], c[2], d[2]),
      },
    },
  }
}

function roomPrimitives(height = 4): ExternalGlbGeometryPrimitive[] {
  return [
    quad('wall-south', 'WALL', [0, 0, 0], [4, 0, 0], [4, height, 0], [0, height, 0]),
    quad('wall-east', 'WALL', [4, 0, 0], [4, 0, 3], [4, height, 3], [4, height, 0]),
    quad('wall-north', 'WALL', [4, 0, 3], [0, 0, 3], [0, height, 3], [4, height, 3]),
    quad('wall-west', 'WALL', [0, 0, 3], [0, 0, 0], [0, height, 0], [0, height, 3]),
  ]
}

function roomPrimitivesAt(prefix: string, x: number, z: number, height = 4): ExternalGlbGeometryPrimitive[] {
  return [
    quad(`${prefix}-south`, 'WALL', [x, 0, z], [x + 4, 0, z], [x + 4, height, z], [x, height, z]),
    quad(`${prefix}-east`, 'WALL', [x + 4, 0, z], [x + 4, 0, z + 3], [x + 4, height, z + 3], [x + 4, height, z]),
    quad(`${prefix}-north`, 'WALL', [x + 4, 0, z + 3], [x, 0, z + 3], [x, height, z + 3], [x + 4, height, z + 3]),
    quad(`${prefix}-west`, 'WALL', [x, 0, z + 3], [x, 0, z], [x, height, z], [x, height, z + 3]),
  ]
}

function sourceSpacePrimitive(): ExternalGlbGeometryPrimitive {
  return {
    nodeIndex: 999,
    nodeName: 'confirmed-source-space',
    meshIndex: 1,
    primitiveIndex: 0,
    extras: { sid: 'source-space-001', renderType: 'SPACE' },
    triangles: [
      triangle([0.1, 0, 0.1], [3.9, 0, 0.1], [3.9, 0, 2.9]),
      triangle([0.1, 0, 0.1], [3.9, 0, 2.9], [0.1, 0, 2.9]),
    ],
    bounds: { min: { x: 0.1, y: 0, z: 0.1 }, max: { x: 3.9, y: 0, z: 2.9 } },
  }
}

function inputWithUpperOnlyRoom(): ExternalSpaceGeometryPrimitive[] {
  const [south, east, north] = roomPrimitives()
  return [
    south!,
    east!,
    north!,
    quad('wall-west-lower', 'WALL', [0, 0, 3], [0, 0, 0], [0, 1, 0], [0, 1, 3]),
    quad('wall-west-upper', 'WALL', [0, 2, 3], [0, 2, 0], [0, 4, 0], [0, 4, 3]),
  ]
}

type ExternalSpaceGeometryPrimitive = ExternalGlbGeometryPrimitive

describe('external multi-slice space candidate integration', () => {
  it('rejects a total operation budget too small for all four bounded phases', () => {
    expect(() => detectExternalSpaceCandidates([], { maxOperations: 3 })).toThrow(/greater than three/)
    expect(() => detectExternalSpaceCandidates([], { maxOperations: 4 })).not.toThrow()
  })

  it('uses overlap rather than centroid coincidence for polygon equivalence', () => {
    const rectangle = (x: number) => [{ x, z: 0 }, { x: x + 10, z: 0 }, { x: x + 10, z: 10 }, { x, z: 10 }]
    expect(areSpacePolygonsEquivalent(rectangle(0), rectangle(0.1))).toBe(true)
    expect(areSpacePolygonsEquivalent(rectangle(0), rectangle(4.9))).toBe(false)
    const concave = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 1 }, { x: 1, z: 1 }, { x: 1, z: 4 }, { x: 0, z: 4 }]
    expect(areSpacePolygonsEquivalent(concave, concave)).toBe(true)
    expect(areSpacePolygonsMateriallyOverlapping(rectangle(0), rectangle(4.9))).toBe(true)
    expect(areSpacePolygonsMateriallyOverlapping(rectangle(0), rectangle(10))).toBe(false)
  })

  it('derives slices, converts world gap distance to cells, and assigns multi-slice confidence', () => {
    const result = detectExternalSpaceCandidates(roomPrimitives(), {
      cellSize: 0.1,
      gapClosingDistance: 0.11,
      minArea: 1,
    })

    expect(result.sliceHeights).toEqual({ middle: 1.4, upper: 2.48 })
    expect(result.wallVerticalRange).toEqual({ min: 0, max: 4 })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.confidence).toBe('inferred-high')
    expect(result.candidates[0]?.reasons).toContain('equivalent-middle-slice')
    expect(result.middleStats.cellSize).toBe(0.1)
    expect(result.upperStats.cellSize).toBe(0.1)
    expect(result.upperStats.occupiedCellCount).toBeGreaterThan(0)
    expect(result.candidates[0]?.stats.sourceIds).toEqual(['wall-east', 'wall-north', 'wall-south', 'wall-west'])
  })

  it('marks an upper-only region inferred-low with an explicit reason', () => {
    const result = detectExternalSpaceCandidates(inputWithUpperOnlyRoom(), {
      gapClosingDistance: 0.11,
      minArea: 1,
    })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.confidence).toBe('inferred-low')
    expect(result.candidates[0]?.reasons).toContain('no-equivalent-middle-slice')
  })

  it('excludes an equivalent confirmed SPACE polygon', () => {
    const detected = detectExternalSpaceCandidates(roomPrimitives(), { gapClosingDistance: 0.11, minArea: 1 })
    const result = detectExternalSpaceCandidates(roomPrimitives(), {
      gapClosingDistance: 0.11,
      minArea: 1,
      existingSpacePolygons: [detected.candidates[0]!.polygon],
    })

    expect(result.candidates).toEqual([])
    expect(result.excludedExistingSpaceCount).toBe(1)
    expect(result.reasons).toContain('existing-space-overlap-exclusion-applied')
  })

  it('excludes a candidate that materially overlaps a confirmed SPACE without being equivalent', () => {
    const result = detectExternalSpaceCandidates(roomPrimitives(), {
      gapClosingDistance: 0.11,
      minArea: 1,
      existingSpacePolygons: [[
        { x: 1, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 3 }, { x: 1, z: 3 },
      ]],
    })
    expect(result.candidates).toEqual([])
    expect(result.excludedExistingSpaceCount).toBe(1)
    expect(result.reasons).toContain('existing-space-overlap-exclusion-applied')
  })

  it('extracts and honors an existing SPACE footprint from source GLB primitives', () => {
    const result = detectExternalSpaceCandidates([...roomPrimitives(), sourceSpacePrimitive()], {
      gapClosingDistance: 0.11,
      minArea: 1,
    })
    expect(result.candidates).toEqual([])
    expect(result.sourceSpaceCount).toBe(1)
    expect(result.sourceSpacePolygonCount).toBe(1)
    expect(result.excludedExistingSpaceCount).toBe(1)
    expect(result.reasons).toContain('source-space-exclusion-applied')
  })

  it('preserves source SPACE precedence through the real encoded GLB byte path', () => {
    const project = createDemoHospitalProject()
    const floor = project.buildings[0]!.floors[0]!
    const exported = exportFloorToGlb(project, floor.id)
    const result = detectExternalSpaceCandidates(exported.bytes, { minArea: 1 })
    expect(result.sourceSpaceCount).toBe(1)
    expect(result.sourceSpacePolygonCount).toBe(1)
    expect(result.candidates).toEqual([])
    expect(result.excludedExistingSpaceCount).toBe(1)
    expect(result.reasons).toContain('source-space-exclusion-applied')
  })

  it('fails closed when source SPACE geometry has no recoverable cap boundary', () => {
    const invalidSourceSpace = quad('source-space-invalid', 'SPACE', [0, 0, 0], [4, 0, 0], [4, 3, 0], [0, 3, 0])
    invalidSourceSpace.nodeIndex = 998
    const result = detectExternalSpaceCandidates([...roomPrimitives(), invalidSourceSpace], { minArea: 1 })
    expect(result.candidates).toEqual([])
    expect(result.sourceSpaceCount).toBe(1)
    expect(result.sourceSpacePolygonCount).toBe(0)
    expect(result.reasons).toContain('source-space-boundary-unavailable')
  })

  it('bounds source SPACE grouping and footprint extraction inside the shared operation budget', () => {
    const sourcePrimitives = Array.from({ length: 500 }, (_, index) => ({
      ...sourceSpacePrimitive(),
      primitiveIndex: index,
    }))
    const result = detectExternalSpaceCandidates(sourcePrimitives, { maxOperations: 300 })
    expect(result.candidates).toEqual([])
    expect(result.reasons).toContain('source-space-operations-exceeded')
    expect(result.sourceSpaceStats.maxOperationsExceeded).toBe(true)
    expect(result.sourceSpaceStats.estimatedOperations).toBeGreaterThan(result.sourceSpaceStats.maxOperations)
  })

  it('bounds cross-slice polygon matching with the shared operation budget', () => {
    const manyRooms = Array.from({ length: 16 }, (_, index) => roomPrimitivesAt(
      `room-${index}`,
      (index % 4) * 5,
      Math.floor(index / 4) * 4,
    )).flat()
    const result = detectExternalSpaceCandidates(manyRooms, {
      cellSize: 0.25,
      gapClosingDistance: 0,
      doorPadding: 0,
      minArea: 1,
      maxOperations: 1_000_000,
    })
    expect(result.candidates).toEqual([])
    expect(result.reasons).toContain('matching-operations-exceeded')
    expect(result.matchingStats.maxOperationsExceeded).toBe(true)
    expect(result.matchingStats.estimatedOperations).toBeGreaterThan(result.matchingStats.maxOperations)
  })

  it('is deterministic under primitive order and accepts bytes or decoded primitives', () => {
    const primitives = roomPrimitives()
    const first = detectExternalSpaceCandidates(primitives, { gapClosingDistance: 0.11, minArea: 1 })
    const second = detectExternalSpaceCandidates([...primitives].reverse(), { gapClosingDistance: 0.11, minArea: 1 })
    expect(second).toEqual(first)

    const bytesOrPrimitives: ExternalSpaceInput = primitives
    expect(detectExternalSpaceCandidates(bytesOrPrimitives, { gapClosingDistance: 0.11, minArea: 1 })).toEqual(first)
    expect(first.candidates[0]?.id).toBe('external-space-candidate-001')
  })

  it('keeps deterministic golden candidate counts for both real semantic GLB samples', () => {
    const expected = {
      'A_1F.glb': { candidates: 86, highConfidence: 9 },
      'A_2F.glb': { candidates: 78, highConfidence: 12 },
    } as const
    for (const fileName of Object.keys(expected) as Array<keyof typeof expected>) {
      const result = detectExternalSpaceCandidates(new Uint8Array(readFileSync(fileName)))
      const repeated = detectExternalSpaceCandidates(new Uint8Array(readFileSync(fileName)))
      expect(result.candidates.length, fileName).toBe(expected[fileName].candidates)
      expect(result.candidates.filter((candidate) => candidate.confidence === 'inferred-high').length, fileName).toBe(expected[fileName].highConfidence)
      expect(result.middleStats.cellCount, fileName).toBeGreaterThan(0)
      expect(result.upperStats.cellCount, fileName).toBeGreaterThan(0)
      expect(result.candidates.some((candidate) => candidate.stats.windowSourceIds.length > 0), fileName).toBe(true)
      expect(result.candidates.every((candidate) => candidate.confidence === 'inferred-high' || candidate.confidence === 'inferred-low'), fileName).toBe(true)
      expect(repeated).toEqual(result)
    }
  })
})
