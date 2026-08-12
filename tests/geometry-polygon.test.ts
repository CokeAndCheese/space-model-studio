import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import type { Ceiling, Slab, Space } from '../src/domain/contract'
import {
  buildCeilingGeometry,
  buildPolygonPrismGeometry,
  buildSlabGeometry,
  buildSpaceGeometry,
  GeometryBuildError,
} from '../src/geometry'

const polygon = [
  { x: 0, z: 0 },
  { x: 3, z: 0 },
  { x: 3, z: 1 },
  { x: 1, z: 1 },
  { x: 1, z: 3 },
  { x: 0, z: 3 },
]
const transform = { position: { x: 0, y: 0, z: 0 }, rotationY: 0 }
const metadata = {
  confidence: 'confirmed' as const,
  sidMode: 'auto' as const,
  directionMode: 'auto' as const,
  renderTypeMode: 'manual' as const,
  sequence: 1,
  renderType: 'CEILING' as const,
}

function horizontalAreaAt(geometry: ReturnType<typeof buildPolygonPrismGeometry>, y: number): number {
  const positions = geometry.getAttribute('position')
  let area = 0
  for (let offset = 0; offset < positions.count; offset += 3) {
    const a = new Vector3().fromBufferAttribute(positions, offset)
    const b = new Vector3().fromBufferAttribute(positions, offset + 1)
    const c = new Vector3().fromBufferAttribute(positions, offset + 2)
    if ([a.y, b.y, c.y].every((value) => Math.abs(value - y) < 1e-6)) {
      area += new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a)).length() / 2
    }
  }
  return area
}

describe('polygon geometry', () => {
  it('triangulates a concave polygon into a closed prism without using its bounding box as the footprint', () => {
    const geometry = buildPolygonPrismGeometry(polygon, 0.4, 0.2)
    geometry.computeBoundingBox()
    expect(geometry.boundingBox?.min.x).toBe(0)
    expect(geometry.boundingBox?.min.y).toBeCloseTo(0.4)
    expect(geometry.boundingBox?.min.z).toBe(0)
    expect(geometry.boundingBox?.max.x).toBe(3)
    expect(geometry.boundingBox?.max.y).toBeCloseTo(0.6)
    expect(geometry.boundingBox?.max.z).toBe(3)
    expect(horizontalAreaAt(geometry, 0.4)).toBeCloseTo(5)
    expect(horizontalAreaAt(geometry, 0.6)).toBeCloseTo(5)
    geometry.dispose()
  })

  it('uses polygon triangulation for slab, ceiling and SPACE projections', () => {
    const slab: Slab = {
      id: 'slab-1', floorId: 'floor-1', kind: 'slab', name: 'Slab', visible: true, locked: false,
      transform, polygon, baseOffset: -0.2, thickness: 0.2, metadata,
    }
    const ceiling: Ceiling = {
      id: 'ceiling-1', floorId: 'floor-1', kind: 'ceiling', name: 'Ceiling', visible: true, locked: false,
      transform, polygon, height: 3, thickness: 0.1, metadata,
    }
    const space: Space = {
      id: 'space-1', floorId: 'floor-1', kind: 'space', name: 'Space', visible: true, locked: false,
      transform, polygon, height: 0.02, spaceType: 'OFFICE',
      metadata: { ...metadata, renderType: 'SPACE' },
    }
    const geometries = [buildSlabGeometry(slab), buildCeilingGeometry(ceiling), buildSpaceGeometry(space)]
    expect(geometries.every((geometry) => geometry.userData.polygonVertexCount === polygon.length)).toBe(true)
    for (const geometry of geometries) geometry.dispose()
  })

  it('rejects self-intersection, duplicate points and non-positive thickness', () => {
    expect(() =>
      buildPolygonPrismGeometry([
        { x: 0, z: 0 }, { x: 2, z: 2 }, { x: 0, z: 2 }, { x: 2, z: 0 },
      ], 0, 0.1),
    ).toThrow(GeometryBuildError)
    expect(() => buildPolygonPrismGeometry([...polygon, polygon[1]!], 0, 0.1)).toThrow(/duplicate/i)
    expect(() => buildPolygonPrismGeometry(polygon, 0, 0)).toThrow(/greater than 0/i)
  })
})
