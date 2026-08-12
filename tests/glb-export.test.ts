import { describe, expect, it } from 'vitest'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { createDemoHospitalProject, createDemoProject } from '../src/domain/project-factory'
import {
  encodeGlb,
  exportFloorToGlb,
  parseGlb,
  validateGlb,
} from '../src/glb'
import { sha256 } from '../src/glb/bin-integrity'

function demoFloor() {
  const project = createDemoProject()
  const floor = project.buildings[0]?.floors[0]
  if (!floor) throw new Error('Demo project must contain one floor')
  return { project, floor }
}

describe('floor GLB export and reload audit', () => {
  it('uses a deterministic SHA-256 BIN integrity hash', () => {
    expect(sha256(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('exports every supported semantic entity kind as one mesh', () => {
    const project = createDemoHospitalProject()
    const floor = project.buildings[0]!.floors[0]!
    const result = exportFloorToGlb(project, floor.id)
    const parsed = parseGlb(result.bytes)
    const kinds = new Set(floor.entities.map((entity) => entity.metadata.renderType))

    expect(kinds).toEqual(new Set([
      'CEILING', 'WALL', 'DOOR', 'WINDOW', 'ELEVATOR', 'STAIR', 'SPACE', 'FACILITY',
    ]))
    expect(parsed.json.nodes).toHaveLength(floor.entities.length)
    expect(parsed.json.meshes).toHaveLength(floor.entities.length)
    expect(result.auditReport.summary).toMatchObject({
      meshNodes: floor.entities.length,
      metadataCoverage: 100,
      errors: 0,
      warnings: 0,
    })
    for (const renderType of kinds) {
      expect(result.auditReport.renderTypeCounts[renderType]).toBeGreaterThan(0)
    }
  })

  it('emits a standard GLB 2.0 with one mesh node per Domain entity', () => {
    const { project, floor } = demoFloor()
    const result = exportFloorToGlb(project, floor.id)
    const parsed = parseGlb(result.bytes)
    const nodes = parsed.json.nodes ?? []
    const meshes = parsed.json.meshes ?? []

    expect(result.fileName).toBe(`${floor.floorName}.glb`)
    expect(parsed.header.magic).toBe(0x46546c67)
    expect(parsed.header.version).toBe(2)
    expect(parsed.header.totalLength).toBe(result.bytes.byteLength)
    expect(parsed.jsonChunk.byteLength % 4).toBe(0)
    expect(parsed.binChunk?.byteLength && parsed.binChunk.byteLength % 4).toBe(0)
    expect(result.auditReport.files[0]?.binHash).toBe(sha256(parsed.binChunk!.data))
    expect(nodes).toHaveLength(floor.entities.length)
    expect(meshes).toHaveLength(floor.entities.length)
    expect(new Set(nodes.map((node) => node.mesh)).size).toBe(floor.entities.length)

    const sids = new Set<string>()
    nodes.forEach((node, nodeIndex) => {
      expect(node.mesh).toBe(nodeIndex)
      expect(node.extras?._editorEntityId).toBeUndefined()
      expect(node.extras?.findId).toBe(`${floor.floorName}_mesh_${nodeIndex}`)
      expect(node.extras?.floorName).toBe(floor.floorName)
      expect(node.extras?.floorType).toBe(floor.floorType)
      expect(node.extras?.renderTypeConfidence).toBe('high')
      expect(typeof node.extras?.sid).toBe('string')
      sids.add(node.extras?.sid as string)
    })
    expect(sids.size).toBe(floor.entities.length)

    expect(result.auditReport.metadataSpecVersion).toBe('3.3-semantic')
    expect(result.auditReport.summary).toMatchObject({
      files: 1,
      meshNodes: floor.entities.length,
      sidCount: floor.entities.length,
      findIdCount: floor.entities.length,
      sidDuplicates: 0,
      findIdDuplicates: 0,
      metadataCoverage: 100,
      reloadSuccess: true,
      errors: 0,
      warnings: 0,
    })
  })

  it('loads through the independent Three.js GLTFLoader', async () => {
    const { project, floor } = demoFloor()
    const { bytes } = exportFloorToGlb(project, floor.id)
    const arrayBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer
    const loaded = await new Promise<Awaited<ReturnType<GLTFLoader['parseAsync']>>>((resolve, reject) => {
      new GLTFLoader().parse(arrayBuffer, '', resolve, reject)
    })
    const meshes: unknown[] = []
    loaded.scene.traverse((object) => {
      if (object.type === 'Mesh') meshes.push(object)
    })
    expect(meshes).toHaveLength(floor.entities.length)
  })

  it('cuts hosted openings while retaining one wall mesh', () => {
    const { project, floor } = demoFloor()
    const parsed = parseGlb(exportFloorToGlb(project, floor.id).bytes)
    const northWallNode = parsed.json.nodes?.find((node) => node.extras?.sid === 'WALL_A_1F_01')
    const mesh = parsed.json.meshes?.[northWallNode?.mesh ?? -1]
    const positionAccessorIndex = mesh?.primitives[0]?.attributes.POSITION ?? -1
    const positionAccessor = parsed.json.accessors?.[positionAccessorIndex]

    expect(northWallNode).toBeDefined()
    expect(mesh?.primitives).toHaveLength(1)
    expect(positionAccessor?.count).toBeGreaterThan(8)
  })

  it('puts floor fields only on scene.extras and complete semantics on node.extras', () => {
    const { project, floor } = demoFloor()
    const { bytes } = exportFloorToGlb(project, floor.id)
    const parsed = parseGlb(bytes)
    const extras = parsed.json.scenes?.[parsed.json.scene ?? -1]?.extras

    expect(extras).toEqual({
      floorName: floor.floorName,
      building: project.buildings[0]!.code,
      level: floor.level,
      floorType: floor.floorType,
      name: floor.name,
    })
    expect(extras).not.toHaveProperty('sid')
    expect(extras).not.toHaveProperty('findId')
    expect(extras).not.toHaveProperty('renderType')
    expect(parsed.json.nodes?.every((node) => (
      typeof node.extras?.sid === 'string'
      && typeof node.extras?.findId === 'string'
      && typeof node.extras?.renderType === 'string'
    ))).toBe(true)
  })

  it('preserves a manual SID and maps low inference confidence', () => {
    const { project, floor } = demoFloor()
    const wall = floor.entities.find((entity) => entity.kind === 'wall' && entity.metadata.direction === 'N')!
    wall.metadata.sidMode = 'manual'
    wall.metadata.sequence = 77
    wall.metadata.manualSid = 'WALL_A_1F_77'
    wall.metadata.confidence = 'inferred-low'
    const parsed = parseGlb(exportFloorToGlb(project, floor.id).bytes)
    const node = parsed.json.nodes?.find((candidate) => candidate.extras?.sid === wall.metadata.manualSid)

    expect(node?.extras?.sid).toBe('WALL_A_1F_77')
    expect(node?.extras?.renderTypeConfidence).toBe('low')
  })

  it('rejects duplicate SIDs after repacking and reloading the final GLB', () => {
    const { project, floor } = demoFloor()
    const { bytes } = exportFloorToGlb(project, floor.id)
    const parsed = parseGlb(bytes)
    const nodes = parsed.json.nodes ?? []
    expect(nodes.length).toBeGreaterThan(1)
    nodes[1]!.extras!.sid = nodes[0]!.extras!.sid
    const tampered = encodeGlb(parsed.json, parsed.binChunk!.data)
    const validation = validateGlb(tampered, { expectedEntityCount: floor.entities.length })

    expect(validation.valid).toBe(false)
    expect(validation.audit.sidDuplicates).toBe(1)
    expect(validation.audit.errors.some((error) => error.code === 'SID_DUPLICATE')).toBe(true)
  })

  it('allows semantic nodes to share a reusable glTF mesh definition', () => {
    const { project, floor } = demoFloor()
    const parsed = parseGlb(exportFloorToGlb(project, floor.id).bytes)
    const nodes = parsed.json.nodes ?? []
    expect(nodes.length).toBeGreaterThan(1)
    nodes[1]!.mesh = nodes[0]!.mesh

    const validation = validateGlb(encodeGlb(parsed.json, parsed.binChunk!.data))

    expect(validation.valid).toBe(true)
    expect(validation.audit.errors.some((error) => error.code === 'ENTITY_MESH_SHARED')).toBe(false)
  })

  it('rejects invalid primitive accessor formats, modes, and materials', () => {
    const { project, floor } = demoFloor()
    const source = parseGlb(exportFloorToGlb(project, floor.id).bytes)
    const binary = source.binChunk!.data
    const cases: Array<{ code: string; mutate: (json: typeof source.json) => void }> = [
      {
        code: 'GLTF_POSITION_FORMAT',
        mutate: (json) => { json.accessors![json.meshes![0]!.primitives[0]!.attributes.POSITION]!.type = 'VEC2' },
      },
      {
        code: 'GLTF_INDEX_FORMAT',
        mutate: (json) => { json.accessors![json.meshes![0]!.primitives[0]!.indices!]!.componentType = 5126 },
      },
      {
        code: 'GLTF_PRIMITIVE_MODE',
        mutate: (json) => { json.meshes![0]!.primitives[0]!.mode = 7 },
      },
      {
        code: 'GLTF_PRIMITIVE_MATERIAL',
        mutate: (json) => { json.meshes![0]!.primitives[0]!.material = 999 },
      },
    ]

    for (const testCase of cases) {
      const json = JSON.parse(JSON.stringify(source.json)) as typeof source.json
      testCase.mutate(json)
      const validation = validateGlb(encodeGlb(json, binary))
      expect(validation.valid).toBe(false)
      expect(validation.audit.reloadSuccess).toBe(false)
      expect(validation.audit.errors.some((error) => error.code === testCase.code)).toBe(true)
    }
  })

  it('reports a corrupted header as a failed reload', () => {
    const { project, floor } = demoFloor()
    const corrupted = exportFloorToGlb(project, floor.id).bytes.slice()
    new DataView(corrupted.buffer, corrupted.byteOffset, corrupted.byteLength)
      .setUint32(8, corrupted.byteLength - 4, true)
    const validation = validateGlb(corrupted)

    expect(validation.valid).toBe(false)
    expect(validation.audit.reloadSuccess).toBe(false)
    expect(validation.audit.errors[0]?.code).toBe('GLB_PARSE')
  })
})
