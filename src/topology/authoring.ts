import { z } from 'zod'
import {
  embeddedTopologySchema,
  topologyEdgeSchema,
  topologyNodeSchema,
  type EmbeddedTopology,
  type TopologyEdge,
  type TopologyGraph,
  type TopologyNode,
  type TopologyPoint,
} from './contract'

export interface TopologyNodeEdit {
  deleted?: boolean
  position?: TopologyPoint
  connectorId?: string | null
  label?: string
}
export interface TopologyEdgeEdit {
  deleted?: boolean
  via?: TopologyPoint[]
}
export interface TopologyAuthoringState {
  baseline: EmbeddedTopology
  addedNodes: TopologyNode[]
  addedEdges: TopologyEdge[]
  nodeEdits: Record<string, TopologyNodeEdit>
  edgeEdits: Record<string, TopologyEdgeEdit>
}

const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict()
const nodeEditSchema = z.object({
  deleted: z.boolean().optional(),
  position: pointSchema.optional(),
  connectorId: z.string().min(1).nullable().optional(),
  label: z.string().min(1).optional(),
}).strict()
const edgeEditSchema = z.object({ deleted: z.boolean().optional(), via: z.array(pointSchema).max(64).optional() }).strict()

export const topologyAuthoringStateSchema = z.object({
  baseline: embeddedTopologySchema,
  addedNodes: z.array(topologyNodeSchema),
  addedEdges: z.array(topologyEdgeSchema),
  nodeEdits: z.record(nodeEditSchema),
  edgeEdits: z.record(edgeEditSchema),
}).strict()

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export function createTopologyAuthoringState(baseline: EmbeddedTopology): TopologyAuthoringState {
  return { baseline: clone(baseline), addedNodes: [], addedEdges: [], nodeEdits: {}, edgeEdits: {} }
}

export function resolveTopology(state: TopologyAuthoringState): EmbeddedTopology {
  const resolved = clone(state.baseline)
  const addedNodesByLayer = new Map<string, TopologyNode[]>()
  for (const node of state.addedNodes) {
    const values = addedNodesByLayer.get(node.layerId) ?? []
    values.push(clone(node))
    addedNodesByLayer.set(node.layerId, values)
  }
  for (const graph of resolved.graphs) {
    const layerIds = new Set(graph.layers.map((layer) => layer.id))
    const additions = [...addedNodesByLayer.entries()].filter(([layerId]) => layerIds.has(layerId)).flatMap(([, nodes]) => nodes)
    graph.nodes.push(...additions)
    graph.edges.push(...state.addedEdges.filter((edge) => {
      const nodeIds = new Set(graph.nodes.map((node) => node.id))
      return nodeIds.has(edge.source) && nodeIds.has(edge.target)
    }).map(clone))
    graph.nodes = graph.nodes.map((node) => {
      const edit = state.nodeEdits[node.id]
      if (!edit) return node
      return {
        ...node,
        ...(edit.position ? { position: clone(edit.position) } : {}),
        ...(edit.label ? { label: edit.label } : {}),
        ...(edit.connectorId === null ? { connectorId: undefined } : edit.connectorId ? { connectorId: edit.connectorId } : {}),
      }
    }).filter((node) => !state.nodeEdits[node.id]?.deleted)
    const nodeIds = new Set(graph.nodes.map((node) => node.id))
    graph.edges = graph.edges.map((edge) => {
      const edit = state.edgeEdits[edge.id]
      if (!edit?.via) return edge
      return { ...edge, path: edit.via.length ? { type: 'POLYLINE' as const, via: clone(edit.via) } : undefined, weight: undefined }
    }).filter((edge) => !state.edgeEdits[edge.id]?.deleted && nodeIds.has(edge.source) && nodeIds.has(edge.target))
    graph.nodes.sort((left, right) => left.id.localeCompare(right.id))
    graph.edges.sort((left, right) => left.id.localeCompare(right.id))
  }
  resolved.diagnostics = undefined
  return resolved
}

export function findTopologyGraph(state: TopologyAuthoringState, graphId: string): TopologyGraph | undefined {
  return resolveTopology(state).graphs.find((graph) => graph.id === graphId)
}

export function nextManualId(state: TopologyAuthoringState, kind: 'node' | 'edge'): string {
  const existing = new Set(resolveTopology(state).graphs.flatMap((graph) => kind === 'node' ? graph.nodes.map((node) => node.id) : graph.edges.map((edge) => edge.id)))
  let index = 1
  while (existing.has(`manual-${kind}-${String(index).padStart(3, '0')}`)) index += 1
  return `manual-${kind}-${String(index).padStart(3, '0')}`
}

export function graphForFloor(topology: EmbeddedTopology, floorName: string): TopologyGraph | undefined {
  return topology.graphs.find((graph) => graph.layers.some((layer) => layer.id === floorName))
}
