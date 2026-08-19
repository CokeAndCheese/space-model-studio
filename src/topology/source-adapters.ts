import type { Entity, Floor, Project } from '../domain/contract'
import { decodeExternalGlbGeometry } from '../integration/external-glb-geometry'
import type { ExternalGlbNodeSummary } from '../integration/external-glb-nodes'
import { entityCenter } from '../metadata/semantic-generator'
import { generateEntitySid } from '../metadata/sid-generator'
import type { TopologyRenderType } from './contract'
import type { TopologySourceLayer, TopologySourceNode } from './generator'

const ROUTE_TYPES = new Set<TopologyRenderType>(['SPACE', 'DOOR', 'STAIR', 'ELEVATOR', 'FACILITY'])

function entitySubtype(entity: Entity): string | undefined {
  if (entity.kind === 'space') return entity.spaceType
  if (entity.kind === 'facility') return entity.fireType
  return entity.metadata.renderType
}

function entityY(entity: Entity, floor: Floor): number {
  if (entity.kind === 'facility' || entity.kind === 'stair' || entity.kind === 'elevator') return floor.elevation + entity.position.y
  return floor.elevation
}

export function projectTopologyLayers(project: Project): TopologySourceLayer[] {
  return project.buildings.flatMap((building) => building.floors.map((floor) => ({
    id: floor.floorName,
    label: floor.name,
    order: floor.level ?? 0,
    floorElevation: floor.elevation,
    nodes: floor.entities.filter((entity) => ROUTE_TYPES.has(entity.metadata.renderType as TopologyRenderType)).map((entity) => {
      const center = entityCenter(entity, floor)
      if (!center) throw new Error(`实体 ${entity.name} 无法计算 topology 中心`)
      return {
        sid: generateEntitySid(entity, floor),
        label: entity.name,
        renderType: entity.metadata.renderType as TopologyRenderType,
        subtype: entitySubtype(entity),
        ...((entity.kind === 'stair' || entity.kind === 'elevator') && entity.connectorId ? { connectorId: entity.connectorId } : {}),
        position: { x: center.x, y: entityY(entity, floor), z: center.z },
        data: { entityId: entity.id, confidence: entity.metadata.confidence },
      } satisfies TopologySourceNode
    }),
  })))
}

export interface ExternalTopologySourceInput {
  bytes: Uint8Array
  fileName: string
  floor: Floor
  nodes: readonly ExternalGlbNodeSummary[]
}

export function externalTopologyLayer(input: ExternalTopologySourceInput): TopologySourceLayer {
  const routeNodes = input.nodes.filter((node) => ROUTE_TYPES.has(node.renderType as TopologyRenderType))
  const routeIndices = new Set(routeNodes.map((node) => node.nodeIndex))
  const primitives = decodeExternalGlbGeometry(input.bytes, { includeNode: (node) => routeIndices.has(node.nodeIndex) })
  const bounds = new Map<number, { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }>()
  for (const primitive of primitives) {
    const current = bounds.get(primitive.nodeIndex)
    if (!current) bounds.set(primitive.nodeIndex, { min: { ...primitive.bounds.min }, max: { ...primitive.bounds.max } })
    else {
      current.min.x = Math.min(current.min.x, primitive.bounds.min.x); current.min.y = Math.min(current.min.y, primitive.bounds.min.y); current.min.z = Math.min(current.min.z, primitive.bounds.min.z)
      current.max.x = Math.max(current.max.x, primitive.bounds.max.x); current.max.y = Math.max(current.max.y, primitive.bounds.max.y); current.max.z = Math.max(current.max.z, primitive.bounds.max.z)
    }
  }
  const sourceNodes: TopologySourceNode[] = routeNodes.map((node) => {
    const value = bounds.get(node.nodeIndex)
    if (!value) throw new Error(`外部语义节点 ${node.sid} 没有可解码几何，无法生成 topology`)
    const extras = input.nodes.find((candidate) => candidate.nodeIndex === node.nodeIndex)
    return {
      sid: node.sid,
      label: node.name,
      renderType: node.renderType as TopologyRenderType,
      subtype: node.spaceType ?? node.fireType ?? node.renderType,
      connectorId: extras?.connectorId,
      position: { x: (value.min.x + value.max.x) / 2, y: (value.min.y + value.max.y) / 2, z: (value.min.z + value.max.z) / 2 },
      data: { sourceNodeIndex: node.nodeIndex, sourceFindId: node.findId, confidence: node.renderTypeConfidence },
    }
  })
  const existingSids = new Set(sourceNodes.map((node) => node.sid))
  for (const entity of input.floor.entities) {
    if (!ROUTE_TYPES.has(entity.metadata.renderType as TopologyRenderType)) continue
    const sid = generateEntitySid(entity, input.floor)
    if (existingSids.has(sid)) continue
    const center = entityCenter(entity, input.floor)
    if (!center) continue
    sourceNodes.push({ sid, label: entity.name, renderType: entity.metadata.renderType as TopologyRenderType, subtype: entitySubtype(entity), position: { x: center.x, y: entityY(entity, input.floor), z: center.z }, data: { entityId: entity.id, appendedByStudio: true } })
  }
  const yValues = sourceNodes.map((node) => node.position.y)
  return { id: input.floor.floorName, label: input.floor.name, order: input.floor.level ?? 0, floorElevation: yValues.length ? Math.min(...yValues) : input.floor.elevation, sourceAsset: input.fileName, nodes: sourceNodes }
}
