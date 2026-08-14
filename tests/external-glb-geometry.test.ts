import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeExternalGlbGeometry, ExternalGlbGeometryError } from '../src/integration/external-glb-geometry'
import { encodeGlb } from '../src/glb/glb-codec'
import type { GlbJson } from '../src/glb/types'

interface TestGeometryOptions {
  interleaved?: boolean
  indexed?: boolean
  mode?: number
}

function testGlb(options: TestGeometryOptions = {}): Uint8Array {
  const interleaved = options.interleaved ?? false
  const indexed = options.indexed ?? true
  const bytes = new Uint8Array(interleaved ? 4 + 4 + 3 * 16 + (indexed ? 4 + 3 * 2 : 0) : 3 * 12 + (indexed ? 3 * 2 : 0))
  const view = new DataView(bytes.buffer)
  let positionViewOffset = 0
  let positionAccessorOffset = 0
  let positionStride = 12
  let positionLength = 3 * 12
  if (interleaved) {
    positionViewOffset = 4
    positionAccessorOffset = 4
    positionStride = 16
    positionLength = 3 * 16
    view.setUint32(0, 0xdecafbad, true)
  }
  const points = [[0, 0, 0], [1, 0, 0], [0, 0, 1]]
  points.forEach(([x, y, z], index) => {
    const offset = positionViewOffset + positionAccessorOffset + index * positionStride
    view.setFloat32(offset, x!, true)
    view.setFloat32(offset + 4, y!, true)
    view.setFloat32(offset + 8, z!, true)
    if (interleaved) view.setFloat32(offset + 12, 100 + index, true)
  })
  let indexAccessor: number | undefined
  let indexView: NonNullable<GlbJson['bufferViews']>[number] | undefined
  if (indexed) {
    const indexOffset = interleaved ? 4 + 4 + 3 * 16 : 3 * 12
    ;[0, 1, 2].forEach((value, index) => view.setUint16(indexOffset + index * 2, value, true))
    indexAccessor = 1
    indexView = { buffer: 0, byteOffset: indexOffset, byteLength: 6 }
  }
  const primitive: NonNullable<GlbJson['meshes']>[number]['primitives'][number] = {
    attributes: { POSITION: 0 },
    ...(indexAccessor === undefined ? {} : { indices: indexAccessor }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  }
  const json: GlbJson = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 2] }],
    nodes: [
      { name: 'parent', translation: [10, 0, 20], children: [1] },
      { name: 'shared-a', mesh: 0, translation: [1, 2, 3], scale: [2, 1, 2], extras: { sid: 'WALL_A_1F_01', renderType: 'WALL', custom: { keep: true } } },
      { name: 'shared-b', mesh: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -4, 5, 6, 1], extras: { sid: 'DOOR_A_1F_E_01', renderType: 'DOOR' } },
    ],
    meshes: [{ primitives: [primitive] }],
    buffers: [{ byteLength: bytes.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: positionViewOffset, byteLength: positionLength, ...(interleaved ? { byteStride: positionStride } : {}) },
      ...(indexView ? [indexView] : []),
    ],
    accessors: [
      { bufferView: 0, byteOffset: positionAccessorOffset, componentType: 5126, count: 3, type: 'VEC3' },
      ...(indexed ? [{ bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' as const }] : []),
    ],
  }
  return encodeGlb(json, bytes)
}

function meshlessChainGlb(length: number, cycle = false): Uint8Array {
  const nodes = Array.from({ length }, (_, index) => ({
    name: `meshless-${index}`,
    ...(index + 1 < length ? { children: [index + 1] } : {}),
  }))
  if (cycle && length > 0) nodes[length - 1]!.children = [0]
  return encodeGlb({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: length > 0 ? [0] : [] }],
    nodes,
  })
}

function wideMeshlessGlb(width: number, roots = false): Uint8Array {
  const childIndices = Array.from({ length: width }, (_, index) => index + (roots ? 0 : 1))
  return encodeGlb({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: roots ? childIndices : [0] }],
    nodes: roots
      ? childIndices.map((index) => ({ name: `root-${index}` }))
      : [{ name: 'parent', children: childIndices }, ...childIndices.map((index) => ({ name: `child-${index}` }))],
  })
}

function expectFiniteGeometry(result: ReturnType<typeof decodeExternalGlbGeometry>) {
  for (const primitive of result) {
    for (const triangle of primitive.triangles) {
      for (const point of triangle) expect(Object.values(point).every(Number.isFinite)).toBe(true)
    }
    expect(Object.values(primitive.bounds.min).every(Number.isFinite)).toBe(true)
    expect(Object.values(primitive.bounds.max).every(Number.isFinite)).toBe(true)
  }
}

describe('external GLB semantic geometry decoder', () => {
  it('traverses scene roots, composes parent TRS, handles matrix nodes, and reuses meshes per node', () => {
    const result = decodeExternalGlbGeometry(testGlb({ indexed: true }))
    expect(result).toHaveLength(2)
    expect(result.map((primitive) => primitive.meshIndex)).toEqual([0, 0])
    expect(result[0]!.nodeIndex).toBe(1)
    expect(result[0]!.triangles[0]![0]).toEqual({ x: 11, y: 2, z: 23 })
    expect(result[0]!.bounds).toEqual({ min: { x: 11, y: 2, z: 23 }, max: { x: 13, y: 2, z: 25 } })
    expect(result[0]!.extras).toEqual({ sid: 'WALL_A_1F_01', renderType: 'WALL', custom: { keep: true } })
    expect(result[1]!.triangles[0]![0]).toEqual({ x: -4, y: 5, z: 6 })
  })

  it('reads offset, interleaved POSITION data and optional non-indexed triangles', () => {
    const result = decodeExternalGlbGeometry(testGlb({ interleaved: true, indexed: false }))
    expect(result).toHaveLength(2)
    expect(result[0]!.triangles).toHaveLength(1)
    expect(result[0]!.triangles[0]![1]).toEqual({ x: 13, y: 2, z: 23 })
    expectFiniteGeometry(result)
  })

  it('rejects primitive modes other than TRIANGLES with a clear error', () => {
    expect(() => decodeExternalGlbGeometry(testGlb({ mode: 5 })))
      .toThrow(new ExternalGlbGeometryError('meshes[0].primitives[0] uses primitive mode 5; only TRIANGLES mode 4 is supported'))
  })

  it('filters nodes before decoding and enforces explicit allocation guards', () => {
    const filtered = decodeExternalGlbGeometry(testGlb(), {
      includeNode: (node) => node.extras.renderType === 'WALL',
      maxPrimitives: 1,
      maxTriangles: 1,
      maxPositionElements: 3,
    })
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.extras.renderType).toBe('WALL')

    expect(decodeExternalGlbGeometry(testGlb(), { includeNode: () => false, maxTriangles: 1 })).toEqual([])
    expect(() => decodeExternalGlbGeometry(testGlb(), { maxPrimitives: 1 })).toThrow(/decoded primitive limit exceeded/)
    expect(() => decodeExternalGlbGeometry(testGlb(), { maxTriangles: 1 })).toThrow(/decoded triangle limit exceeded/)
    expect(() => decodeExternalGlbGeometry(testGlb(), { maxPositionElements: 3 })).toThrow(/decoded POSITION element limit exceeded/)
  })

  it('iteratively traverses a deep meshless chain within the visit limit', () => {
    expect(decodeExternalGlbGeometry(meshlessChainGlb(20_000), { maxVisitedNodes: 20_000 })).toEqual([])
  })

  it('rejects a graph that exceeds maxVisitedNodes with a domain error', () => {
    const decodeOverLimit = () => decodeExternalGlbGeometry(meshlessChainGlb(3), { maxVisitedNodes: 2 })
    expect(decodeOverLimit).toThrow(ExternalGlbGeometryError)
    expect(decodeOverLimit).not.toThrow(RangeError)
    expect(decodeOverLimit).toThrow('visited node limit exceeded (2)')
    expect(() => decodeExternalGlbGeometry(meshlessChainGlb(1), { maxVisitedNodes: 0 }))
      .toThrow(new ExternalGlbGeometryError('maxVisitedNodes must be a positive integer'))
  })

  it('rejects wide roots and child fan-out before scheduling an oversized worklist', () => {
    expect(() => decodeExternalGlbGeometry(wideMeshlessGlb(20, true), { maxVisitedNodes: 10 }))
      .toThrow(new ExternalGlbGeometryError('visited node limit exceeded (10)'))
    expect(() => decodeExternalGlbGeometry(wideMeshlessGlb(20), { maxVisitedNodes: 10 }))
      .toThrow(new ExternalGlbGeometryError('visited node limit exceeded (10)'))
  })

  it('preserves active-path cycle detection during iterative traversal', () => {
    expect(() => decodeExternalGlbGeometry(meshlessChainGlb(3, true), { maxVisitedNodes: 10 }))
      .toThrow(new ExternalGlbGeometryError('node cycle detected at nodes[0]'))
  })

  it('decodes representative WALL and DOOR geometry in A_1F and A_2F', () => {
    for (const fileName of ['A_1F.glb', 'A_2F.glb']) {
      const result = decodeExternalGlbGeometry(new Uint8Array(readFileSync(fileName)))
      const wall = result.filter((primitive) => primitive.extras.renderType === 'WALL')
      const doors = result.filter((primitive) => primitive.extras.renderType === 'DOOR')
      expect(wall).toHaveLength(1)
      expect(doors.length).toBeGreaterThan(0)
      expectFiniteGeometry(result)
      expect(result.every((primitive) => primitive.triangles.length > 0)).toBe(true)
    }
  })
})
