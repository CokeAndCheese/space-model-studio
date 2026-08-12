import { describe, expect, it } from 'vitest'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { createDemoHospitalProject, createSpace } from '../src/domain/project-factory'
import { exportFloorToGlb } from '../src/glb/floor-exporter'
import { encodeGlb, parseGlb } from '../src/glb/glb-codec'
import {
  appendExternalSpacesToGlb,
  ExternalSpaceExportError,
} from '../src/glb/external-space-exporter'
import { generateEntitySid } from '../src/metadata/sid-generator'

function sourceAndFloor() {
  const project = createDemoHospitalProject()
  const floor = project.buildings[0]!.floors[0]!
  const source = exportFloorToGlb(project, floor.id)
  return { floor, source }
}

function appendedFloor(floor: ReturnType<typeof sourceAndFloor>['floor']) {
  const space = createSpace(floor.id, {
    name: '外部厨房',
    polygon: [{ x: 10, z: 0 }, { x: 12, z: 0 }, { x: 12, z: 2 }, { x: 10, z: 2 }],
    height: 2.8,
    spaceType: 'KITCHEN',
    metadata: { direction: 'E', sequence: 88 },
  })
  return { ...floor, entities: [space] }
}

describe('append-only external SPACE GLB export', () => {
  it('preserves source prefixes while appending validated SPACE geometry and metadata', async () => {
    const { floor, source } = sourceAndFloor()
    const externalFloor = appendedFloor(floor)
    const sourceParsed = parseGlb(source.bytes)
    const sourceBytesBefore = [...source.bytes]
    const floorBefore = JSON.stringify(floor)
    const result = appendExternalSpacesToGlb({
      sourceBytes: source.bytes,
      floor: externalFloor,
      fileName: 'A_1F-with-external-space.glb',
    })
    const outputParsed = parseGlb(result.bytes)
    const sourceBin = sourceParsed.binChunk!.data
    const outputBin = outputParsed.binChunk!.data

    for (const name of ['nodes', 'meshes', 'accessors', 'bufferViews', 'materials'] as const) {
      const sourceArray = sourceParsed.json[name] ?? []
      const outputArray = outputParsed.json[name] ?? []
      expect(outputArray.slice(0, sourceArray.length)).toEqual(sourceArray)
    }
    expect([...outputBin.slice(0, sourceBin.length)]).toEqual([...sourceBin])
    expect(outputParsed.json.scenes![0]!.nodes!.slice(0, sourceParsed.json.scenes![0]!.nodes!.length))
      .toEqual(sourceParsed.json.scenes![0]!.nodes)

    expect(outputParsed.json.nodes).toHaveLength(sourceParsed.json.nodes!.length + 1)
    expect(outputParsed.json.meshes).toHaveLength(sourceParsed.json.meshes!.length + 1)
    expect(outputParsed.json.accessors).toHaveLength(sourceParsed.json.accessors!.length + 2)
    expect(outputParsed.json.bufferViews).toHaveLength(sourceParsed.json.bufferViews!.length + 2)
    expect(outputParsed.json.materials).toHaveLength(sourceParsed.json.materials!.length + 1)
    expect(result.preservation.appendedCounts).toEqual({
      materials: 1,
      bufferViews: 2,
      accessors: 2,
      meshes: 1,
      nodes: 1,
    })
    expect(result.preservation.preservedBinPrefix).toBe(true)
    expect(result.preservation.preservedArrayPrefixes).toEqual({
      nodes: true,
      meshes: true,
      accessors: true,
      bufferViews: true,
      materials: true,
    })
    expect(result.audit.errors).toHaveLength(0)
    expect(result.audit.warnings).toHaveLength(0)
    expect(result.audit.reloadSuccess).toBe(true)
    expect([...source.bytes]).toEqual(sourceBytesBefore)
    expect(JSON.stringify(floor)).toBe(floorBefore)

    const nodeIndex = outputParsed.json.nodes!.length - 1
    const node = outputParsed.json.nodes![nodeIndex]!
    expect(node.extras).toMatchObject({
      sid: generateEntitySid(externalFloor.entities[0]!, externalFloor),
      findId: `A_1F_mesh_${nodeIndex}`,
      floorName: 'A_1F',
      floorType: 'FLOOR',
      renderType: 'SPACE',
      renderTypeConfidence: 'high',
      spaceType: 'KITCHEN',
    })
    expect(outputParsed.json.buffers![0]!.byteLength).toBe(outputBin.length)

    const arrayBuffer = result.bytes.buffer.slice(
      result.bytes.byteOffset,
      result.bytes.byteOffset + result.bytes.byteLength,
    ) as ArrayBuffer
    const loaded = await new Promise<Awaited<ReturnType<GLTFLoader['parseAsync']>>>((resolve, reject) => {
      new GLTFLoader().parse(arrayBuffer, '', resolve, reject)
    })
    const meshes: unknown[] = []
    loaded.scene.traverse((object) => {
      if (object.type === 'Mesh') meshes.push(object)
    })
    expect(meshes).toHaveLength(sourceParsed.json.nodes!.length + 1)
  })

  it('rejects a floor without SPACE entities', () => {
    const { floor, source } = sourceAndFloor()
    expect(() => appendExternalSpacesToGlb({ sourceBytes: source.bytes, floor: { ...floor, entities: [] }, fileName: 'empty.glb' }))
      .toThrow(ExternalSpaceExportError)
  })

  it('rejects non-SPACE entities', () => {
    const { floor, source } = sourceAndFloor()
    const wall = floor.entities.find((entity) => entity.kind === 'wall')!
    expect(() => appendExternalSpacesToGlb({ sourceBytes: source.bytes, floor: { ...floor, entities: [wall] }, fileName: 'wall.glb' }))
      .toThrow(/rejects non-SPACE/)
  })

  it('rejects malformed source GLB bytes', () => {
    const { floor } = sourceAndFloor()
    const spaceFloor = appendedFloor(floor)
    expect(() => appendExternalSpacesToGlb({ sourceBytes: new Uint8Array([1, 2, 3]), floor: spaceFloor, fileName: 'invalid.glb' }))
      .toThrow()
  })

  it('rejects a parseable source with invalid primitive semantics', () => {
    const { floor, source } = sourceAndFloor()
    const parsed = parseGlb(source.bytes)
    const positionAccessor = parsed.json.meshes![0]!.primitives[0]!.attributes.POSITION
    parsed.json.accessors![positionAccessor]!.type = 'VEC2'
    const invalidSource = encodeGlb(parsed.json, parsed.binChunk!.data)

    expect(() => appendExternalSpacesToGlb({
      sourceBytes: invalidSource,
      floor: appendedFloor(floor),
      fileName: 'invalid-primitive.glb',
    })).toThrow(/POSITION accessor/)
  })

  it('rejects a SPACE SID collision with source metadata', () => {
    const { floor, source } = sourceAndFloor()
    const sourceSpace = floor.entities.find((entity) => entity.kind === 'space')!
    const collidingSpace = createSpace(floor.id, {
      name: '重复空间',
      polygon: [{ x: 10, z: 0 }, { x: 12, z: 0 }, { x: 12, z: 2 }],
      spaceType: 'OFFICE',
      metadata: {
        sidMode: 'manual',
        manualSid: generateEntitySid(sourceSpace, floor),
        direction: 'N',
        sequence: 99,
      },
    })
    expect(() => appendExternalSpacesToGlb({ sourceBytes: source.bytes, floor: { ...floor, entities: [collidingSpace] }, fileName: 'collision.glb' }))
      .toThrow(/collides with source metadata/)
  })
})
