import { z } from 'zod'

export const TOPOLOGY_SCHEMA_VERSION = 1 as const
export const TOPOLOGY_COORDINATE_SPACE = 'MODEL_LOCAL' as const
export const TOPOLOGY_SCENE_EXTRAS_KEY = 'sspTopology' as const
export const TOPOLOGY_GENERATOR_NAME = 'ssp-glb-topology' as const
export const TOPOLOGY_GENERATOR_VERSION = '0.1.0' as const
export const MAX_TOPOLOGY_VIA_POINTS = 64
export const MIN_TOPOLOGY_EDGE_LENGTH = 1e-6

export type TopologyNodeKind = 'SPACE' | 'PORTAL' | 'CONNECTOR' | 'FACILITY'
export type TopologyRenderType = 'SPACE' | 'DOOR' | 'STAIR' | 'ELEVATOR' | 'FACILITY'

export interface TopologyPoint { x: number; y: number; z: number }
export interface TopologyLayer {
  id: string
  label?: string
  order?: number
  elevation?: number
  tags?: string[]
  data?: Record<string, unknown>
}
export interface TopologyNode {
  id: string
  layerId: string
  position: TopologyPoint
  connectorId?: string
  label?: string
  kind?: TopologyNodeKind
  subtype?: string
  tags?: string[]
  data?: Record<string, unknown>
}
export interface TopologyEdge {
  id: string
  source: string
  target: string
  relation: 'LINK' | 'CONNECTOR'
  direction: 'FORWARD' | 'BIDIRECTIONAL'
  path?: { type: 'POLYLINE'; via: TopologyPoint[] }
  weight?: number
  mode?: string
  tags?: string[]
  data?: Record<string, unknown>
  initialState?: { enabled?: boolean; weightOverride?: number | null; blockerIds?: string[] }
}
export interface TopologyGraph {
  id: string
  layers: TopologyLayer[]
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  tags?: string[]
  data?: Record<string, unknown>
}
export interface TopologyDiagnosticNode {
  id?: string
  sourceSid: string
  renderType: TopologyRenderType
  reason: 'CONNECTOR_ID_MISSING' | 'EMPTY_GEOMETRY' | 'SOURCE_POSITION_MISSING'
}
export interface EmbeddedTopology {
  schemaVersion: typeof TOPOLOGY_SCHEMA_VERSION
  coordinateSpace: typeof TOPOLOGY_COORDINATE_SPACE
  generator?: { name: string; version: string; parameters?: Record<string, unknown> }
  graphs: TopologyGraph[]
  diagnostics?: Record<string, unknown> & {
    source?: Record<string, unknown>
    components?: Array<{ id: string; nodeCount: number; nodeIds: string[] }>
    unresolvedNodes?: TopologyDiagnosticNode[]
    warnings?: string[]
  }
}

const finite = z.number().finite()
const nonEmpty = z.string().min(1)
const pointSchema = z.object({ x: finite, y: finite, z: finite }).strict()
const dataSchema = z.record(z.unknown())
const layerSchema = z.object({
  id: nonEmpty,
  label: nonEmpty.optional(),
  order: finite.optional(),
  elevation: finite.optional(),
  tags: z.array(nonEmpty).optional(),
  data: dataSchema.optional(),
}).strict()
export const topologyNodeSchema = z.object({
  id: nonEmpty,
  layerId: nonEmpty,
  position: pointSchema,
  connectorId: nonEmpty.optional(),
  label: nonEmpty.optional(),
  kind: z.enum(['SPACE', 'PORTAL', 'CONNECTOR', 'FACILITY']).optional(),
  subtype: nonEmpty.optional(),
  tags: z.array(nonEmpty).optional(),
  data: dataSchema.optional(),
}).strict()
export const topologyEdgeSchema = z.object({
  id: nonEmpty,
  source: nonEmpty,
  target: nonEmpty,
  relation: z.enum(['LINK', 'CONNECTOR']),
  direction: z.enum(['FORWARD', 'BIDIRECTIONAL']),
  path: z.object({ type: z.literal('POLYLINE'), via: z.array(pointSchema).max(MAX_TOPOLOGY_VIA_POINTS) }).strict().optional(),
  weight: finite.optional(),
  mode: nonEmpty.optional(),
  tags: z.array(nonEmpty).optional(),
  data: dataSchema.optional(),
  initialState: z.object({
    enabled: z.boolean().optional(),
    weightOverride: finite.nullable().optional(),
    blockerIds: z.array(nonEmpty).optional(),
  }).strict().optional(),
}).strict()
const graphSchema = z.object({
  id: nonEmpty,
  layers: z.array(layerSchema).min(1),
  nodes: z.array(topologyNodeSchema).min(1),
  edges: z.array(topologyEdgeSchema),
  tags: z.array(nonEmpty).optional(),
  data: dataSchema.optional(),
}).strict()

export const embeddedTopologySchema = z.object({
  schemaVersion: z.literal(TOPOLOGY_SCHEMA_VERSION),
  coordinateSpace: z.literal(TOPOLOGY_COORDINATE_SPACE),
  generator: z.object({ name: nonEmpty, version: nonEmpty, parameters: dataSchema.optional() }).strict().optional(),
  graphs: z.array(graphSchema).min(1),
  diagnostics: dataSchema.optional(),
}).strict()

function distance(a: TopologyPoint, b: TopologyPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/** The single structural and geometric validator used by authoring and release export. */
export function validateEmbeddedTopology(value: unknown): string[] {
  const parsed = embeddedTopologySchema.safeParse(value)
  if (!parsed.success) return parsed.error.issues.map((issue) => `${issue.path.join('.') || 'sspTopology'}: ${issue.message}`)
  const errors: string[] = []
  const graphIds = new Set<string>()
  for (const [graphIndex, graph] of parsed.data.graphs.entries()) {
    const prefix = `graphs[${graphIndex}]`
    if (graphIds.has(graph.id)) errors.push(`${prefix}.id duplicates graph "${graph.id}"`)
    graphIds.add(graph.id)
    const layerIds = new Set<string>()
    for (const [index, layer] of graph.layers.entries()) {
      if (layerIds.has(layer.id)) errors.push(`${prefix}.layers[${index}].id duplicates layer "${layer.id}"`)
      layerIds.add(layer.id)
    }
    const nodeIds = new Set<string>()
    const nodeById = new Map<string, TopologyNode>()
    for (const [index, node] of graph.nodes.entries()) {
      if (nodeIds.has(node.id)) errors.push(`${prefix}.nodes[${index}].id duplicates node "${node.id}"`)
      nodeIds.add(node.id)
      nodeById.set(node.id, node as TopologyNode)
      if (!layerIds.has(node.layerId)) errors.push(`${prefix}.nodes[${index}].layerId is unknown`)
    }
    const edgeIds = new Set<string>()
    for (const [index, edge] of graph.edges.entries()) {
      const path = `${prefix}.edges[${index}]`
      if (edgeIds.has(edge.id)) errors.push(`${path}.id duplicates edge "${edge.id}"`)
      edgeIds.add(edge.id)
      const source = nodeById.get(edge.source)
      const target = nodeById.get(edge.target)
      if (!source) errors.push(`${path}.source is unknown`)
      if (!target) errors.push(`${path}.target is unknown`)
      if (edge.source === edge.target) errors.push(`${path} must not be a self edge`)
      if (!source || !target) continue
      const crossLayer = source.layerId !== target.layerId
      if (!crossLayer && edge.relation !== 'LINK') errors.push(`${path}.relation must be LINK for a same-layer edge`)
      if (crossLayer && edge.relation !== 'CONNECTOR') errors.push(`${path}.relation must be CONNECTOR for a cross-layer edge`)
      if (crossLayer && (!source.connectorId || source.connectorId !== target.connectorId)) {
        errors.push(`${path} cross-layer endpoints must share a non-empty connectorId`)
      }
      const points = [source.position, ...(edge.path?.via ?? []), target.position]
      if (points.some((point, pointIndex) => pointIndex > 0 && distance(points[pointIndex - 1]!, point) <= MIN_TOPOLOGY_EDGE_LENGTH)) {
        errors.push(`${path}.path contains equal or effectively equal adjacent points`)
      }
    }
  }
  return errors
}

export function assertEmbeddedTopology(value: unknown): EmbeddedTopology {
  const errors = validateEmbeddedTopology(value)
  if (errors.length) throw new Error(`sspTopology validation failed: ${errors.join('; ')}`)
  return value as EmbeddedTopology
}
