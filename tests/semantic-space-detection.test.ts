import { describe, expect, it } from 'vitest'
import { detectSemanticSpaces, type SemanticTriangle } from '../src/inference/semantic-space-detection'

function triangle(id: string, renderType: 'WALL' | 'DOOR' | 'WINDOW', a: [number, number, number], b: [number, number, number], c: [number, number, number]): SemanticTriangle {
  const vertex = ([x, y, z]: [number, number, number]) => ({ x, y, z })
  return { id, renderType, a: vertex(a), b: vertex(b), c: vertex(c) }
}

function quad(id: string, renderType: 'WALL' | 'DOOR' | 'WINDOW', a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number]): SemanticTriangle[] {
  return [triangle(`${id}:0`, renderType, a, b, c), triangle(`${id}:1`, renderType, a, c, d)]
}

function roomWalls(x0 = 0, z0 = 0, x1 = 4, z1 = 3): SemanticTriangle[] {
  const y0 = 0
  const y1 = 2.8
  return [
    ...quad('south', 'WALL', [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]),
    ...quad('east', 'WALL', [x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]),
    ...quad('north', 'WALL', [x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1]),
    ...quad('west', 'WALL', [x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]),
  ]
}

function partitionedRooms(columns = 8, rows = 8): SemanticTriangle[] {
  const triangles = roomWalls(0, 0, columns, rows)
  for (let x = 1; x < columns; x += 1) {
    triangles.push(...quad(`divider-x-${x}`, 'WALL', [x, 0, 0], [x, 0, rows], [x, 2.8, rows], [x, 2.8, 0]))
  }
  for (let z = 1; z < rows; z += 1) {
    triangles.push(...quad(`divider-z-${z}`, 'WALL', [0, 0, z], [columns, 0, z], [columns, 2.8, z], [0, 2.8, z]))
  }
  return triangles
}

function polygonWalls(points: Array<[number, number]>): SemanticTriangle[] {
  return points.flatMap(([x, z], index) => {
    const [nextX, nextZ] = points[(index + 1) % points.length]!
    return quad(`polygon-wall-${index}`, 'WALL', [x, 0, z], [nextX, 0, nextZ], [nextX, 2.8, nextZ], [x, 2.8, z])
  })
}

function pointInPolygon(point: { x: number; z: number }, polygon: readonly { x: number; z: number }[]): boolean {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const start = polygon[previous]!
    const end = polygon[index]!
    if ((start.z > point.z) !== (end.z > point.z)
      && point.x < ((end.x - start.x) * (point.z - start.z)) / (end.z - start.z) + start.x) inside = !inside
  }
  return inside
}

describe('deterministic semantic raster space detection', () => {
  it('extracts a rectangular room from world-space wall triangles', () => {
    const result = detectSemanticSpaces(roomWalls(), { cellSize: 0.1, sliceHeights: [1.4], minArea: 1 })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.area).toBeGreaterThan(10)
    expect(result.candidates[0]?.polygon.length).toBe(4)
    expect(result.candidates[0]?.confidence).toBe('inferred-high')
  })

  it('uses a padded DOOR footprint to close a divider opening and separate rooms', () => {
    const walls = [
      ...roomWalls(),
      ...quad('divider-left', 'WALL', [2, 0, 0], [2, 0, 1.15], [2, 2.8, 1.15], [2, 2.8, 0]),
      ...quad('divider-right', 'WALL', [2, 0, 1.85], [2, 0, 3], [2, 2.8, 3], [2, 2.8, 1.85]),
      ...quad('door', 'DOOR', [2, 0, 1.15], [2, 0, 1.85], [2, 2.8, 1.85], [2, 2.8, 1.15]),
    ]
    const result = detectSemanticSpaces(walls, { cellSize: 0.1, sliceHeights: [1.4], doorPadding: 0.05, minArea: 1 })
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates.every((candidate) => candidate.reasons).valueOf()).toBe(true)
    expect(result.candidates.some((candidate) => candidate.stats.doorSourceIds.includes('door:0'))).toBe(true)
  })

  it('uses semantic WINDOW geometry as exterior boundary evidence', () => {
    const wallsAndWindow = [
      ...roomWalls().slice(0, 6),
      ...quad('west-window', 'WINDOW', [0, 0, 3], [0, 0, 0], [0, 2.8, 0], [0, 2.8, 3]),
    ]
    const result = detectSemanticSpaces(wallsAndWindow, { cellSize: 0.1, sliceHeights: [1.4], minArea: 1 })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.reasons).toContain('window-boundary-closed')
    expect(result.candidates[0]?.stats.windowSourceIds).toEqual(['west-window:0', 'west-window:1'])
  })

  it('rejects a free-space region with an occupied inner ring instead of filling across the hole', () => {
    const result = detectSemanticSpaces([
      ...roomWalls(0, 0, 5, 4),
      ...quad('solid-pillar', 'WALL', [2, 1.4, 1], [3, 1.4, 1], [3, 1.4, 2], [2, 1.4, 2]),
    ], { cellSize: 0.1, sliceHeights: [1.4], minArea: 1 })
    expect(result.candidates).toEqual([])
    expect(result.reasons).toContain('multi-contour-regions-excluded')
    expect(result.stats.multiContourRegionCount).toBe(1)
  })

  it('preserves a concave room boundary within the raster area instead of collapsing it', () => {
    const result = detectSemanticSpaces(polygonWalls([
      [0, 0], [6, 0], [6, 4], [4, 4], [4, 2], [2, 2], [2, 4], [0, 4],
    ]), { cellSize: 0.1, sliceHeights: [1.4], minArea: 1, contourSimplifyTolerance: 0.1 })
    expect(result.candidates).toHaveLength(1)
    const candidate = result.candidates[0]!
    expect(candidate.polygon.length).toBeGreaterThanOrEqual(8)
    expect(candidate.area).toBeGreaterThan(17.5)
    expect(Math.abs(candidate.area - candidate.stats.regionCellCount * 0.01)).toBeLessThan(0.25)
  })

  it('does not simplify across a shallow occupied wall recess', () => {
    const result = detectSemanticSpaces(polygonWalls([
      [0, 0], [4, 0], [4, 3], [2.2, 3], [2.2, 2.8], [1.8, 2.8], [1.8, 3], [0, 3],
    ]), { cellSize: 0.05, sliceHeights: [1.4], minArea: 1, contourSimplifyTolerance: 0.25 })
    expect(result.candidates).toHaveLength(1)
    const candidate = result.candidates[0]!
    expect(candidate.polygon.length).toBeGreaterThan(4)
    expect(pointInPolygon({ x: 2, z: 2.9 }, candidate.polygon)).toBe(false)
    expect(Math.abs(candidate.area - candidate.stats.regionCellCount * 0.05 * 0.05)).toBeLessThan(0.2)
    expect(detectSemanticSpaces(polygonWalls([
      [0, 0], [4, 0], [4, 3], [2.2, 3], [2.2, 2.8], [1.8, 2.8], [1.8, 3], [0, 3],
    ]), { cellSize: 0.05, sliceHeights: [1.4], minArea: 1, contourSimplifyTolerance: 0.25 })).toEqual(result)
  })

  it('ignores an open boundary because flood fill reaches its interior', () => {
    const result = detectSemanticSpaces(roomWalls().slice(0, 6), { cellSize: 0.1, sliceHeights: [1.4] })
    expect(result.candidates).toEqual([])
    expect(result.reasons).toContain('no-interior-regions')
  })

  it('filters a tiny enclosed raster region', () => {
    const result = detectSemanticSpaces(roomWalls(0, 0, 4, 3), { cellSize: 0.1, sliceHeights: [1.4], minArea: 20 })
    expect(result.candidates).toEqual([])
    expect(result.stats.discardedRegionCount).toBe(1)
    expect(result.reasons).toContain('interior-regions-rejected')
    expect(result.reasons).not.toContain('no-interior-regions')
  })

  it('is stable under source order and preserves non-zero world origin', () => {
    const input = roomWalls(100, -40, 104, -37)
    const first = detectSemanticSpaces(input, { cellSize: 0.1, sliceHeights: [1.4], minArea: 1 })
    const second = detectSemanticSpaces([...input].reverse(), { cellSize: 0.1, sliceHeights: [1.4], minArea: 1 })
    expect(second).toEqual(first)
    expect(first.candidates[0]?.polygon[0]?.x).toBeGreaterThan(99)
    expect(first.candidates[0]?.polygon[0]?.z).toBeLessThan(-36)
  })

  it('returns a deterministic guard result before allocating an oversized grid', () => {
    const result = detectSemanticSpaces(roomWalls(1000, 1000, 1100, 1100), { cellSize: 0.01, maxCells: 10_000 })
    expect(result.candidates).toEqual([])
    expect(result.reasons).toEqual(['max-cells-exceeded'])
    expect(result.stats.maxCellsExceeded).toBe(true)
    expect(result.stats.cellCount).toBeGreaterThan(10_000)
  })

  it('guards pathological morphology work before allocating raster buffers', () => {
    const result = detectSemanticSpaces(roomWalls(), {
      cellSize: 0.1,
      gapClosing: 100,
      maxOperations: 10_000,
    })
    expect(result.candidates).toEqual([])
    expect(result.reasons).toEqual(['max-operations-exceeded'])
    expect(result.stats.maxOperationsExceeded).toBe(true)
    expect(result.stats.estimatedMorphologyOperations).toBeGreaterThan(10_000)
  })

  it('guards contour work for a hostile region with many occupied islands before tracing rings', () => {
    const islands = Array.from({ length: 12 }, (_, index) => {
      const x = 1 + (index % 4) * 2
      const z = 1 + Math.floor(index / 4) * 2
      return quad(`island-${index}`, 'WALL', [x, 1.4, z], [x + 0.4, 1.4, z], [x + 0.4, 1.4, z + 0.4], [x, 1.4, z + 0.4])
    }).flat()
    const result = detectSemanticSpaces([...roomWalls(0, 0, 9, 7), ...islands], {
      cellSize: 0.05,
      sliceHeights: [1.4],
      maxOperations: 100_000,
    })
    expect(result.candidates).toEqual([])
    expect(result.reasons).toEqual(['max-operations-exceeded'])
    expect(result.stats.estimatedRegionOperations).toBeGreaterThan(100_000)
  })

  it('bounds pairwise contour validation for a jagged non-simplified enclosure', () => {
    const sawtooth: Array<[number, number]> = [[0, 0], [10, 0], [10, 5]]
    for (let index = 1; index <= 80; index += 1) {
      sawtooth.push([10 - index * 0.125, index % 2 ? 4.8 : 5])
    }
    const input = polygonWalls(sawtooth)
    const baseline = detectSemanticSpaces(input, {
      cellSize: 0.05,
      sliceHeights: [1.4],
      minArea: 1,
      contourSimplifyTolerance: 0,
      maxOperations: 20_000_000,
    })
    expect(baseline.candidates).toHaveLength(1)
    expect(baseline.stats.estimatedContourValidationOperations).toBeGreaterThan(100)
    const linearOperations = baseline.stats.estimatedRasterOperations
      + baseline.stats.estimatedMorphologyOperations
      + baseline.stats.estimatedRegionOperations
    const guardedMaxOperations = linearOperations + Math.floor(baseline.stats.estimatedContourValidationOperations / 2)
    const guarded = detectSemanticSpaces(input, {
      cellSize: 0.05,
      sliceHeights: [1.4],
      minArea: 1,
      contourSimplifyTolerance: 0,
      maxOperations: guardedMaxOperations,
    })
    expect(guarded.candidates).toEqual([])
    expect(guarded.reasons).toEqual(['max-operations-exceeded'])
    expect(guarded.stats.maxOperationsExceeded).toBe(true)
    expect(linearOperations + guarded.stats.estimatedContourValidationOperations).toBeGreaterThan(guardedMaxOperations)
  })

  it('guards many-region source association before scanning every triangle per candidate', () => {
    const triangles = partitionedRooms()
    const options = { cellSize: 0.1, sliceHeights: [1.4], minArea: 0.2, maxOperations: 1_000_000 }
    const baseline = detectSemanticSpaces(triangles, options)
    expect(baseline.candidates.length).toBeGreaterThan(40)
    expect(baseline.stats.estimatedSourceAssociationOperations).toBeGreaterThan(1_000)

    const nonAssociationOperations = baseline.stats.estimatedRasterOperations
      + baseline.stats.estimatedMorphologyOperations
      + baseline.stats.estimatedRegionOperations
    const guarded = detectSemanticSpaces(triangles, {
      ...options,
      maxOperations: nonAssociationOperations + Math.floor(baseline.stats.estimatedSourceAssociationOperations / 2),
    })
    expect(guarded.candidates).toEqual([])
    expect(guarded.reasons).toEqual(['max-operations-exceeded'])
    expect(guarded.stats.maxOperationsExceeded).toBe(true)
    expect(guarded.stats.estimatedSourceAssociationOperations).toBe(baseline.stats.estimatedSourceAssociationOperations)
  })
})
