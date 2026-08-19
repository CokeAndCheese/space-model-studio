import {
  RENDER_TYPE_BY_KIND,
  type Building,
  type Entity,
  type Floor,
  type Project,
  type RenderType,
} from '../domain/contract'
import { generateEntitySid } from '../metadata/sid-generator'
import { createGlbAuditReport, validateGlb } from '../validation/glb-validator'
import { validateProject } from '../validation/project-validator'
import { buildEntityGeometry, type EntityMeshGeometry } from './entity-geometry'
import { encodeGlb } from './glb-codec'
import { sha256 } from './bin-integrity'
import { embedTopologyInJson, readEmbeddedTopology } from '../topology/glb'
import { float32Bytes, indexBytes, positionBounds } from './mesh-packing'
import type {
  FloorGlbExportResult,
  GlbJson,
  GlbNodeExtras,
  GlbSceneExtras,
} from './types'

const RENDER_TYPE_ORDER: Readonly<Record<RenderType, number>> = {
  CEILING: 0,
  WALL: 1,
  DOOR: 2,
  WINDOW: 3,
  ELEVATOR: 4,
  STAIR: 5,
  SPACE: 6,
  FACILITY: 7,
}

interface BinarySegment {
  byteOffset: number
  bytes: Uint8Array
}

class BinaryBuilder {
  private length = 0
  private readonly segments: BinarySegment[] = []

  append(bytes: Uint8Array) {
    this.length = (this.length + 3) & ~3
    const byteOffset = this.length
    this.segments.push({ byteOffset, bytes })
    this.length += bytes.byteLength
    return byteOffset
  }

  finish() {
    const output = new Uint8Array((this.length + 3) & ~3)
    for (const segment of this.segments) output.set(segment.bytes, segment.byteOffset)
    return output
  }
}

export class GlbExportError extends Error {
  constructor(
    message: string,
    readonly auditReport?: FloorGlbExportResult['auditReport'],
  ) {
    super(message)
    this.name = 'GlbExportError'
  }
}

function assertGeometry(entity: Entity, geometry: EntityMeshGeometry) {
  if (geometry.positions.length < 9 || geometry.positions.length % 3 !== 0) {
    throw new GlbExportError(`${entity.kind} ${entity.id} did not produce valid POSITION data`)
  }
  const vertexCount = geometry.positions.length / 3
  if (geometry.indices.length < 3 || geometry.indices.length % 3 !== 0) {
    throw new GlbExportError(`${entity.kind} ${entity.id} did not produce triangle indices`)
  }
  if (geometry.positions.some((value) => !Number.isFinite(value))) {
    throw new GlbExportError(`${entity.kind} ${entity.id} produced a non-finite vertex`)
  }
  if (geometry.indices.some((index) => !Number.isInteger(index) || index < 0 || index >= vertexCount)) {
    throw new GlbExportError(`${entity.kind} ${entity.id} produced an out-of-range triangle index`)
  }
}

function locateFloor(project: Project, floorId: string): { building: Building; floor: Floor } {
  for (const building of project.buildings) {
    const floor = building.floors.find((candidate) => candidate.id === floorId)
    if (floor) return { building, floor }
  }
  throw new GlbExportError(`Floor ${floorId} was not found in project ${project.projectId}`)
}

function sortedEntities(floor: Floor) {
  return [...floor.entities].sort((left, right) => (
    RENDER_TYPE_ORDER[left.metadata.renderType] - RENDER_TYPE_ORDER[right.metadata.renderType]
    || left.metadata.sequence - right.metadata.sequence
    || left.id.localeCompare(right.id)
  ))
}

function finalSid(entity: Entity, floor: Floor) {
  try {
    return generateEntitySid(entity, floor)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new GlbExportError(`Entity ${entity.id} SID generation failed: ${detail}`)
  }
}

function nodeMetadata(
  entity: Entity,
  floor: Floor,
  buildingCode: string | null,
  nodeIndex: number,
): GlbNodeExtras {
  const renderTypeConfidence = entity.metadata.confidence === 'inferred-low' ? 'low' : 'high'
  return {
    sid: finalSid(entity, floor),
    findId: `${floor.floorName}_mesh_${nodeIndex}`,
    floorName: floor.floorName,
    building: buildingCode,
    level: floor.level,
    floorType: floor.floorType,
    name: `${floor.name}${entity.name}`,
    renderType: entity.metadata.renderType,
    renderTypeConfidence,
    ...(entity.kind === 'space' ? { spaceType: entity.spaceType } : {}),
    ...(entity.kind === 'facility' ? { fireType: entity.fireType } : {}),
    ...((entity.kind === 'stair' || entity.kind === 'elevator') && entity.connectorId ? { connectorId: entity.connectorId } : {}),
  }
}

function buildFloorJson(
  floor: Floor,
  building: Building,
  entities: Entity[],
): { json: GlbJson; binary: Uint8Array } {
  const binaryBuilder = new BinaryBuilder()
  const bufferViews: NonNullable<GlbJson['bufferViews']> = []
  const accessors: NonNullable<GlbJson['accessors']> = []
  const meshes: NonNullable<GlbJson['meshes']> = []
  const nodes: NonNullable<GlbJson['nodes']> = []

  for (const entity of entities) {
    if (entity.floorId !== floor.id) {
      throw new GlbExportError(`Entity ${entity.id} belongs to floor ${entity.floorId}, not ${floor.id}`)
    }
    if (entity.metadata.renderType !== RENDER_TYPE_BY_KIND[entity.kind]) {
      throw new GlbExportError(
        `Entity ${entity.id} kind ${entity.kind} cannot export as ${entity.metadata.renderType}`,
      )
    }
    const geometry = buildEntityGeometry(entity, floor)
    assertGeometry(entity, geometry)
    const vertexCount = geometry.positions.length / 3
    const useUint32 = vertexCount > 65_535
    const positionData = float32Bytes(geometry.positions)
    const indicesData = indexBytes(geometry.indices, useUint32)
    const positionOffset = binaryBuilder.append(positionData)
    const indicesOffset = binaryBuilder.append(indicesData)
    const positionBufferView = bufferViews.length
    bufferViews.push({
      buffer: 0,
      byteOffset: positionOffset,
      byteLength: positionData.byteLength,
      target: 34962,
    })
    const indicesBufferView = bufferViews.length
    bufferViews.push({
      buffer: 0,
      byteOffset: indicesOffset,
      byteLength: indicesData.byteLength,
      target: 34963,
    })
    const bounds = positionBounds(geometry.positions)
    const positionAccessor = accessors.length
    accessors.push({
      bufferView: positionBufferView,
      byteOffset: 0,
      componentType: 5126,
      count: vertexCount,
      type: 'VEC3',
      min: bounds.min,
      max: bounds.max,
    })
    const indicesAccessor = accessors.length
    accessors.push({
      bufferView: indicesBufferView,
      byteOffset: 0,
      componentType: useUint32 ? 5125 : 5123,
      count: geometry.indices.length,
      type: 'SCALAR',
      min: [0],
      max: [Math.max(...geometry.indices)],
    })
    const meshIndex = meshes.length
    meshes.push({
      name: entity.name,
      primitives: [{
        attributes: { POSITION: positionAccessor },
        indices: indicesAccessor,
        material: 0,
        mode: 4,
      }],
    })
    nodes.push({
      name: entity.name,
      mesh: meshIndex,
      extras: { _editorEntityId: entity.id },
    })
  }

  const buildingCode = floor.buildingId === null ? null : building.code
  const sceneExtras: GlbSceneExtras = {
    floorName: floor.floorName,
    building: buildingCode,
    level: floor.level,
    floorType: floor.floorType,
    name: floor.name,
  }
  const binary = binaryBuilder.finish()
  const json: GlbJson = {
    asset: { version: '2.0', generator: 'Space Model Studio 0.1' },
    scene: 0,
    scenes: [{ name: floor.name, nodes: nodes.map((_, index) => index), extras: sceneExtras }],
    nodes,
    meshes,
    materials: [{
      name: 'Space Model Studio Default',
      doubleSided: true,
      pbrMetallicRoughness: {
        baseColorFactor: [0.64, 0.7, 0.78, 1],
        metallicFactor: 0,
        roughnessFactor: 0.82,
      },
    }],
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews,
    accessors,
  }

  // Post-process only after the final nodes array exists. findId is derived from
  // the actual GLB node index, and the editor-only correlation key is removed.
  const byId = new Map(entities.map((entity) => [entity.id, entity]))
  nodes.forEach((node, nodeIndex) => {
    const entityId = node.extras?._editorEntityId
    if (typeof entityId !== 'string') throw new GlbExportError(`Node ${nodeIndex} lost its entity correlation key`)
    const entity = byId.get(entityId)
    if (!entity) throw new GlbExportError(`Node ${nodeIndex} references unknown entity ${entityId}`)
    node.name = finalSid(entity, floor)
    node.extras = nodeMetadata(entity, floor, buildingCode, nodeIndex)
  })

  return { json, binary }
}

/**
 * Compile one Domain floor to GLB and accept it only after parsing and release validation.
 * The editable project is never mutated.
 */
export function exportFloorToGlb(project: Project, floorId: string): FloorGlbExportResult {
  if (project.metadataSpecVersion !== '3.3-semantic') {
    throw new GlbExportError(`Project metadata spec ${project.metadataSpecVersion} is not exportable`)
  }
  const projectValidation = validateProject(project, 'release')
  if (!projectValidation.valid || projectValidation.warnings.length > 0) {
    const first = projectValidation.errors[0] ?? projectValidation.warnings[0]
    throw new GlbExportError(
      `Project failed release validation${first ? `: ${first.path}: ${first.message}` : ''}`,
    )
  }
  const { building, floor } = locateFloor(project, floorId)
  const entities = sortedEntities(floor)
  if (entities.length === 0) throw new GlbExportError(`Floor ${floor.floorName} has no semantic entities to export`)
  const built = buildFloorJson(floor, building, entities)
  const json = project.topology ? embedTopologyInJson(built.json, project.topology, floor.floorName) : built.json
  const binary = built.binary
  const bytes = encodeGlb(json, binary)
  const fileName = `${floor.floorName}.glb`

  // This is intentionally a fresh container parse, not validation of the in-memory JSON.
  const validation = validateGlb(bytes, { fileName, expectedEntityCount: entities.length })
  const sourceBinHash = sha256(binary)
  if (validation.audit.binHash !== sourceBinHash) {
    throw new GlbExportError(`Exported ${fileName} changed BIN bytes during metadata packaging`)
  }
  const auditReport = createGlbAuditReport(project, [validation.audit])
  if (!validation.valid || auditReport.summary.warnings > 0) {
    const first = validation.audit.errors[0] ?? validation.audit.warnings[0]
    throw new GlbExportError(
      `Exported ${fileName} failed reload validation${first ? `: ${first.message}` : ''}`,
      auditReport,
    )
  }
  if (project.topology && !readEmbeddedTopology(bytes)) {
    throw new GlbExportError(`Exported ${fileName} lost scene.extras.sspTopology during reload validation`)
  }

  return { fileName, bytes, auditReport }
}
