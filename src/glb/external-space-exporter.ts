import type { Floor, Space } from '../domain/contract'
import { generateEntitySid } from '../metadata/sid-generator'
import { validateGlb, type GlbValidationResult } from '../validation/glb-validator'
import { buildEntityGeometry } from './entity-geometry'
import { encodeGlb, parseGlb } from './glb-codec'
import { float32Bytes, indexBytes, positionBounds } from './mesh-packing'
import { GLB_BIN_CHUNK_TYPE, GLB_JSON_CHUNK_TYPE, type GlbFileAudit, type GlbJson, type GlbNodeExtras, type ParsedGlb } from './types'

const ALIGNMENT = 4
const ARRAY_NAMES = ['nodes', 'meshes', 'accessors', 'bufferViews', 'materials'] as const

type ArrayName = (typeof ARRAY_NAMES)[number]

export interface ExternalSpaceExportInput {
  sourceBytes: ArrayBuffer | Uint8Array
  floor: Floor
  fileName: string
}

export interface ExternalSpacePreservationSummary {
  sourceByteLength: number
  outputByteLength: number
  sourceBinByteLength: number
  outputBinByteLength: number
  appendedBinByteLength: number
  sourceArrayCounts: Record<ArrayName, number>
  outputArrayCounts: Record<ArrayName, number>
  appendedCounts: {
    materials: number
    bufferViews: number
    accessors: number
    meshes: number
    nodes: number
  }
  preservedArrayPrefixes: Record<ArrayName, boolean>
  preservedSceneNodePrefix: boolean
  preservedBinPrefix: boolean
}

export interface ExternalSpaceExportResult {
  fileName: string
  bytes: Uint8Array
  audit: GlbFileAudit
  preservation: ExternalSpacePreservationSummary
}

export class ExternalSpaceExportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExternalSpaceExportError'
  }
}

function align(value: number) {
  return (value + (ALIGNMENT - 1)) & ~(ALIGNMENT - 1)
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function equalJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function hasBytePrefix(output: Uint8Array, prefix: Uint8Array) {
  if (output.byteLength < prefix.byteLength) return false
  for (let index = 0; index < prefix.byteLength; index += 1) {
    if (output[index] !== prefix[index]) return false
  }
  return true
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ExternalSpaceExportError(message)
}

function requireArray<T>(json: GlbJson, name: ArrayName): T[] {
  const value = json[name]
  if (value === undefined) {
    const created: T[] = []
    json[name] = created as never
    return created
  }
  assert(Array.isArray(value), `Source GLB JSON ${name} must be an array`)
  return value as T[]
}

function sourceJsonCounts(json: GlbJson): Record<ArrayName, number> {
  return Object.fromEntries(ARRAY_NAMES.map((name) => [name, Array.isArray(json[name]) ? json[name]!.length : 0])) as Record<ArrayName, number>
}

function assertSourceContainer(parsed: ParsedGlb, sourceValidation: GlbValidationResult) {
  assert(
    parsed.chunks.length === 2
      && parsed.chunks[0]?.type === GLB_JSON_CHUNK_TYPE
      && parsed.chunks[1]?.type === GLB_BIN_CHUNK_TYPE
      && parsed.binChunk !== undefined,
    'Source GLB must contain exactly one JSON chunk followed by one BIN chunk',
  )
  assert(parsed.json.buffers?.length === 1, 'Source GLB must contain exactly one embedded buffer')
  assert(parsed.json.buffers[0]?.uri === undefined, 'Source GLB buffer must be embedded')
  assert(sourceValidation.valid && sourceValidation.audit.warnings.length === 0, sourceValidation.audit.errors[0]?.message ?? 'Source GLB failed strict validation')
  assert(parsed.json.scenes?.length === 1 && parsed.json.scene === 0, 'Source GLB must contain one default scene')
}

function sceneMetadata(parsed: ParsedGlb) {
  const scene = parsed.json.scenes?.[0]
  const extras = scene?.extras
  assert(scene && extras && typeof extras === 'object' && !Array.isArray(extras), 'Source default scene metadata is incomplete')
  assert(typeof extras.floorName === 'string' && extras.floorName.length > 0, 'Source scene metadata requires floorName')
  assert(typeof extras.name === 'string' && extras.name.length > 0, 'Source scene metadata requires name')
  assert(typeof extras.floorType === 'string' && extras.floorType.length > 0, 'Source scene metadata requires floorType')
  assert(typeof extras.level === 'number' || extras.level === null, 'Source scene metadata requires level')
  assert(typeof extras.building === 'string' || extras.building === null, 'Source scene metadata requires building')
  return {
    floorName: extras.floorName,
    building: extras.building,
    level: extras.level,
    floorType: extras.floorType,
    name: extras.name,
  }
}

function assertSpaceEntities(floor: Floor): asserts floor is Floor & { entities: Space[] } {
  assert(floor.entities.length > 0, `Floor ${floor.floorName} must contain at least one SPACE entity`)
  for (const entity of floor.entities) {
    assert(entity.kind === 'space', `External SPACE export rejects non-SPACE entity ${entity.id}`)
    assert(entity.metadata.renderType === 'SPACE', `SPACE entity ${entity.id} must have renderType SPACE`)
    assert(entity.floorId === floor.id, `SPACE entity ${entity.id} belongs to floor ${entity.floorId}, not ${floor.id}`)
  }
}

function appendBinary(source: Uint8Array, segments: Uint8Array[]) {
  let length = source.byteLength
  const offsets: number[] = []
  for (const segment of segments) {
    length = align(length)
    offsets.push(length)
    length += segment.byteLength
  }
  const output = new Uint8Array(align(length))
  output.set(source, 0)
  segments.forEach((segment, index) => output.set(segment, offsets[index]!))
  return { output, offsets }
}

function assertPreservation(
  source: ParsedGlb,
  output: ParsedGlb,
  sourceCounts: Record<ArrayName, number>,
  sourceArrays: Record<ArrayName, unknown[]>,
  sourceSceneNodes: number[],
) {
  const outputArrays = Object.fromEntries(ARRAY_NAMES.map((name) => [name, output.json[name] ?? []])) as Record<ArrayName, unknown[]>
  const preservedArrayPrefixes = Object.fromEntries(ARRAY_NAMES.map((name) => [
    name,
    equalJson(outputArrays[name].slice(0, sourceCounts[name]), sourceArrays[name]),
  ])) as Record<ArrayName, boolean>
  for (const name of ARRAY_NAMES) assert(preservedArrayPrefixes[name], `Output changed the source ${name} array prefix`)

  const outputSceneNodes = output.json.scenes?.[0]?.nodes ?? []
  assert(equalJson(outputSceneNodes.slice(0, sourceSceneNodes.length), sourceSceneNodes), 'Output changed the source scene.nodes prefix')
  assert(output.binChunk !== undefined && source.binChunk !== undefined, 'Output/source BIN chunk is missing')
  assert(hasBytePrefix(output.binChunk.data, source.binChunk.data), 'Output changed the source BIN byte prefix')

  return {
    preservedArrayPrefixes,
    preservedSceneNodePrefix: true,
    preservedBinPrefix: true,
  }
}

function appendExternalSpaces(input: ExternalSpaceExportInput): ExternalSpaceExportResult {
  assert(input.fileName.trim().length > 0, 'External SPACE export requires an output filename')
  assertSpaceEntities(input.floor)

  const sourceBytes = input.sourceBytes instanceof Uint8Array
    ? new Uint8Array(input.sourceBytes.buffer, input.sourceBytes.byteOffset, input.sourceBytes.byteLength)
    : new Uint8Array(input.sourceBytes)
  let source: ParsedGlb
  try {
    source = parseGlb(sourceBytes)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new ExternalSpaceExportError(`Source GLB could not be parsed: ${detail}`)
  }
  const sourceValidation = validateGlb(sourceBytes, { fileName: input.fileName })
  assertSourceContainer(source, sourceValidation)
  const metadata = sceneMetadata(source)
  assert(metadata.floorName === input.floor.floorName, `Source floorName ${metadata.floorName} does not match ${input.floor.floorName}`)
  assert(metadata.floorType === input.floor.floorType, `Source floorType ${metadata.floorType} does not match ${input.floor.floorType}`)
  assert(metadata.level === input.floor.level, `Source level ${metadata.level} does not match ${input.floor.level}`)

  const json = cloneJson(source.json)
  const sourceCounts = sourceJsonCounts(source.json)
  const sourceArrays = Object.fromEntries(ARRAY_NAMES.map((name) => [
    name,
    cloneJson(source.json[name] ?? []) as unknown[],
  ])) as Record<ArrayName, unknown[]>
  const sourceSceneNodes = [...(source.json.scenes?.[0]?.nodes ?? [])]
  const nodes = requireArray<NonNullable<GlbJson['nodes']>[number]>(json, 'nodes')
  const meshes = requireArray<NonNullable<GlbJson['meshes']>[number]>(json, 'meshes')
  const accessors = requireArray<NonNullable<GlbJson['accessors']>[number]>(json, 'accessors')
  const bufferViews = requireArray<NonNullable<GlbJson['bufferViews']>[number]>(json, 'bufferViews')
  const materials = requireArray<Record<string, unknown>>(json, 'materials')
  const scenes = json.scenes ?? []
  assert(scenes[0] !== undefined, 'Source default scene is missing')
  const sceneNodes = scenes[0].nodes ?? (scenes[0].nodes = [])
  const sourceSids = new Set<string>()
  const appendedSids = new Set<string>()
  const sourceFindIds = new Set<string>()
  for (const node of nodes) {
    if (typeof node.extras?.sid === 'string') sourceSids.add(node.extras.sid)
    if (typeof node.extras?.findId === 'string') sourceFindIds.add(node.extras.findId)
  }
  const newMaterialIndex = materials.length
  materials.push({
    name: 'Space Model Studio External SPACE',
    doubleSided: true,
    alphaMode: 'BLEND',
    pbrMetallicRoughness: {
      baseColorFactor: [0.17, 0.77, 0.65, 0.28],
      metallicFactor: 0,
      roughnessFactor: 0.82,
    },
  })

  const segments: Uint8Array[] = []
  for (const entity of input.floor.entities) {
    let sid: string
    try {
      sid = generateEntitySid(entity, input.floor)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new ExternalSpaceExportError(`SPACE entity ${entity.id} SID generation failed: ${detail}`)
    }
    assert(!sourceSids.has(sid), `SPACE SID collides with source metadata: ${sid}`)
    assert(!appendedSids.has(sid), `SPACE SID collides with another SPACE entity: ${sid}`)
    appendedSids.add(sid)

    const nodeIndex = nodes.length
    const findId = `${metadata.floorName}_mesh_${nodeIndex}`
    assert(!sourceFindIds.has(findId), `SPACE findId collides with source metadata: ${findId}`)
    sourceFindIds.add(findId)

    const geometry = buildEntityGeometry(entity, input.floor)
    assert(geometry.positions.length >= 9 && geometry.positions.length % 3 === 0, `SPACE entity ${entity.id} produced invalid POSITION data`)
    assert(geometry.indices.length >= 3 && geometry.indices.length % 3 === 0, `SPACE entity ${entity.id} produced invalid index data`)
    assert(geometry.positions.every(Number.isFinite), `SPACE entity ${entity.id} produced a non-finite vertex`)
    const vertexCount = geometry.positions.length / 3
    assert(geometry.indices.every((index) => Number.isInteger(index) && index >= 0 && index < vertexCount), `SPACE entity ${entity.id} produced an out-of-range index`)
    const useUint32 = vertexCount > 65_535
    const positionData = float32Bytes(geometry.positions)
    const indexData = indexBytes(geometry.indices, useUint32)
    segments.push(positionData, indexData)
    const positionBufferView = bufferViews.length
    const indicesBufferView = positionBufferView + 1
    const positionAccessor = accessors.length
    const indicesAccessor = positionAccessor + 1
    const bounds = positionBounds(geometry.positions)
    bufferViews.push(
      { buffer: 0, byteOffset: 0, byteLength: positionData.byteLength, target: 34962 },
      { buffer: 0, byteOffset: 0, byteLength: indexData.byteLength, target: 34963 },
    )
    accessors.push(
      { bufferView: positionBufferView, byteOffset: 0, componentType: 5126, count: vertexCount, type: 'VEC3', min: bounds.min, max: bounds.max },
      { bufferView: indicesBufferView, byteOffset: 0, componentType: useUint32 ? 5125 : 5123, count: geometry.indices.length, type: 'SCALAR', min: [0], max: [Math.max(...geometry.indices)] },
    )
    const meshIndex = meshes.length
    meshes.push({
      name: sid,
      primitives: [{ attributes: { POSITION: positionAccessor }, indices: indicesAccessor, material: newMaterialIndex, mode: 4 }],
    })
    const nodeExtras: GlbNodeExtras = {
      sid,
      findId,
      floorName: metadata.floorName,
      building: metadata.building,
      level: metadata.level,
      floorType: metadata.floorType as GlbNodeExtras['floorType'],
      name: `${metadata.name}${entity.name}`,
      renderType: 'SPACE',
      renderTypeConfidence: entity.metadata.confidence === 'inferred-low' ? 'low' : 'high',
      spaceType: entity.spaceType,
    }
    nodes.push({ name: sid, mesh: meshIndex, extras: nodeExtras })
    sceneNodes.push(nodeIndex)
  }

  const appended = appendBinary(source.binChunk!.data, segments)
  json.buffers![0]!.byteLength = appended.output.byteLength
  let segmentIndex = 0
  for (let index = 0; index < input.floor.entities.length; index += 1) {
    const positionBufferView = sourceCounts.bufferViews + index * 2
    const indicesBufferView = positionBufferView + 1
    bufferViews[positionBufferView]!.byteOffset = appended.offsets[segmentIndex++]!
    bufferViews[indicesBufferView]!.byteOffset = appended.offsets[segmentIndex++]!
  }

  const bytes = encodeGlb(json, appended.output)
  const output = parseGlb(bytes)
  const preservation = assertPreservation(source, output, sourceCounts, sourceArrays, sourceSceneNodes)
  const outputValidation = validateGlb(bytes, {
    fileName: input.fileName,
    expectedEntityCount: sourceValidation.audit.meshNodes + input.floor.entities.length,
  })
  assert(outputValidation.valid && outputValidation.audit.warnings.length === 0, outputValidation.audit.errors[0]?.message ?? 'Emitted external SPACE GLB failed strict validation')

  const outputCounts = sourceJsonCounts(output.json)
  const appendedCounts = {
    materials: outputCounts.materials - sourceCounts.materials,
    bufferViews: outputCounts.bufferViews - sourceCounts.bufferViews,
    accessors: outputCounts.accessors - sourceCounts.accessors,
    meshes: outputCounts.meshes - sourceCounts.meshes,
    nodes: outputCounts.nodes - sourceCounts.nodes,
  }
  assert(appendedCounts.materials === 1, 'External SPACE export must append exactly one material')
  assert(appendedCounts.bufferViews === input.floor.entities.length * 2, 'External SPACE export must append two bufferViews per SPACE')
  assert(appendedCounts.accessors === input.floor.entities.length * 2, 'External SPACE export must append two accessors per SPACE')
  assert(appendedCounts.meshes === input.floor.entities.length, 'External SPACE export must append one mesh per SPACE')
  assert(appendedCounts.nodes === input.floor.entities.length, 'External SPACE export must append one node per SPACE')

  return {
    fileName: input.fileName,
    bytes,
    audit: outputValidation.audit,
    preservation: {
      sourceByteLength: sourceBytes.byteLength,
      outputByteLength: bytes.byteLength,
      sourceBinByteLength: source.binChunk!.data.byteLength,
      outputBinByteLength: output.binChunk!.data.byteLength,
      appendedBinByteLength: output.binChunk!.data.byteLength - source.binChunk!.data.byteLength,
      sourceArrayCounts: sourceCounts,
      outputArrayCounts: outputCounts,
      appendedCounts,
      ...preservation,
    },
  }
}

export function appendExternalSpacesToGlb(input: ExternalSpaceExportInput): ExternalSpaceExportResult
export function appendExternalSpacesToGlb(sourceBytes: ArrayBuffer | Uint8Array, floor: Floor, fileName: string): ExternalSpaceExportResult
export function appendExternalSpacesToGlb(
  inputOrSource: ExternalSpaceExportInput | ArrayBuffer | Uint8Array,
  floor?: Floor,
  fileName?: string,
): ExternalSpaceExportResult {
  const input = inputOrSource instanceof Uint8Array || inputOrSource instanceof ArrayBuffer
    ? { sourceBytes: inputOrSource, floor: floor!, fileName: fileName! }
    : inputOrSource
  return appendExternalSpaces(input)
}
