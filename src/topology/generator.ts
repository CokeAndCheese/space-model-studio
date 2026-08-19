import {
  MIN_TOPOLOGY_EDGE_LENGTH,
  TOPOLOGY_COORDINATE_SPACE,
  TOPOLOGY_GENERATOR_NAME,
  TOPOLOGY_GENERATOR_VERSION,
  TOPOLOGY_SCHEMA_VERSION,
  assertEmbeddedTopology,
  type EmbeddedTopology,
  type TopologyDiagnosticNode,
  type TopologyEdge,
  type TopologyGraph,
  type TopologyNode,
  type TopologyNodeKind,
  type TopologyPoint,
  type TopologyRenderType,
} from './contract'

export interface TopologySourceNode {
  sid: string
  label?: string
  renderType: TopologyRenderType
  subtype?: string
  connectorId?: string
  position: TopologyPoint
  sourcePosition?: TopologyPoint
  data?: Record<string, unknown>
}
export interface TopologySourceLayer {
  id: string
  label: string
  order: number
  floorElevation: number
  sourceAsset?: string
  nodes: TopologySourceNode[]
}
export interface TopologyGenerationOptions {
  coordinatePrecision?: number
  elevationOffset?: number
  nearestNeighbors?: number
}

const defaults = { coordinatePrecision: 6, elevationOffset: 0.08, nearestNeighbors: 3 }
const round = (value: number, precision: number) => {
  const result = Math.round(value * 10 ** precision) / 10 ** precision
  return Object.is(result, -0) ? 0 : result
}
const point = (value: TopologyPoint, precision: number): TopologyPoint => ({
  x: round(value.x, precision), y: round(value.y, precision), z: round(value.z, precision),
})
const slug = (value: string) => value.replace(/[^A-Za-z0-9:_-]+/g, '-').replace(/^-+|-+$/g, '') || 'node'
const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stableValue((value as Record<string, unknown>)[key])]))
  return value
}
const stableRecord = (value: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
  if (!value) return undefined
  return stableValue(value) as Record<string, unknown>
}
const kindFor = (renderType: TopologyRenderType): TopologyNodeKind => renderType === 'DOOR' ? 'PORTAL' : renderType === 'STAIR' || renderType === 'ELEVATOR' ? 'CONNECTOR' : renderType

interface Candidate { source: string; target: string; distance: number }
const candidateSort = (a: Candidate, b: Candidate) => a.distance - b.distance || a.source.localeCompare(b.source) || a.target.localeCompare(b.target)

export function createTopologyCandidates(nodes: readonly Pick<TopologyNode, 'id' | 'position'>[]): Candidate[] {
  const candidates: Candidate[] = []
  for (let left = 0; left < nodes.length; left += 1) for (let right = left + 1; right < nodes.length; right += 1) {
    const a = nodes[left]!
    const b = nodes[right]!
    const [source, target] = a.id.localeCompare(b.id) <= 0 ? [a, b] : [b, a]
    candidates.push({ source: source.id, target: target.id, distance: Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z) })
  }
  return candidates.sort(candidateSort)
}

export function createMinimumSpanningTree(nodes: readonly Pick<TopologyNode, 'id'>[], candidates: readonly Candidate[]): Candidate[] {
  const parent = new Map(nodes.map((node) => [node.id, node.id]))
  const find = (input: string): string => {
    let root = input
    while (parent.get(root) !== root) root = parent.get(root)!
    let current = input
    while (parent.get(current) !== current) {
      const next = parent.get(current)!
      parent.set(current, root)
      current = next
    }
    return root
  }
  const selected: Candidate[] = []
  for (const candidate of candidates) {
    const sourceRoot = find(candidate.source)
    const targetRoot = find(candidate.target)
    if (sourceRoot === targetRoot) continue
    parent.set(sourceRoot, targetRoot)
    selected.push(candidate)
    if (selected.length === Math.max(0, nodes.length - 1)) break
  }
  return selected
}

export function createKNearestNeighbors(nodes: readonly Pick<TopologyNode, 'id'>[], candidates: readonly Candidate[], requested: number): Candidate[] {
  const limit = Math.min(Math.max(0, Math.floor(requested)), Math.max(0, nodes.length - 1))
  const byNode = new Map(nodes.map((node) => [node.id, [] as Candidate[]]))
  for (const candidate of candidates) {
    const source = byNode.get(candidate.source)!
    if (source.length < limit) source.push(candidate)
    const target = byNode.get(candidate.target)!
    if (target.length < limit) target.push({ source: candidate.target, target: candidate.source, distance: candidate.distance })
  }
  return nodes.flatMap((node) => byNode.get(node.id) ?? [])
}

function mergeEdges(nodes: TopologyNode[], mst: Candidate[], knn: Candidate[], precision: number): TopologyEdge[] {
  const merged = new Map<string, Candidate & { inference: Set<string> }>()
  const add = (candidate: Candidate, inference: string) => {
    const [source, target] = [candidate.source, candidate.target].sort()
    const key = `${source}\u0000${target}`
    const entry = merged.get(key) ?? { source, target, distance: candidate.distance, inference: new Set<string>() }
    entry.inference.add(inference)
    merged.set(key, entry)
  }
  mst.forEach((candidate) => add(candidate, 'MST'))
  knn.forEach((candidate) => add(candidate, 'KNN'))
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  return [...merged.values()].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target)).map((candidate) => {
    const source = nodeById.get(candidate.source)!
    const target = nodeById.get(candidate.target)!
    const inferenceTypes = ['MST', 'KNN'].filter((value) => candidate.inference.has(value))
    const geometricDistance = round(candidate.distance, precision)
    const needsDetour = candidate.distance <= MIN_TOPOLOGY_EDGE_LENGTH
    const offset = Math.max(10 ** -precision, 0.01)
    const via = needsDetour ? [{ x: round(source.position.x + offset, precision), y: source.position.y, z: source.position.z }] : []
    const routingDistance = via.length
      ? round(Math.hypot(source.position.x - via[0]!.x, source.position.y - via[0]!.y, source.position.z - via[0]!.z) + Math.hypot(target.position.x - via[0]!.x, target.position.y - via[0]!.y, target.position.z - via[0]!.z), precision)
      : geometricDistance
    return {
      id: `edge:${candidate.source}--${candidate.target}`,
      source: candidate.source,
      target: candidate.target,
      relation: 'LINK',
      direction: 'BIDIRECTIONAL',
      ...(via.length ? { path: { type: 'POLYLINE' as const, via } } : {}),
      mode: 'WALK',
      tags: ['generated', 'inferred', 'walk', ...inferenceTypes.map((value) => value.toLowerCase()), ...(needsDetour ? ['short-edge-detour'] : [])],
      data: { generated: true, inference: inferenceTypes.join('+'), inferenceTypes, distance: routingDistance, routingDistance, geometricDistance },
    }
  })
}

export function topologyComponents(graph: Pick<TopologyGraph, 'nodes' | 'edges'>) {
  const adjacency = new Map(graph.nodes.map((node) => [node.id, new Set<string>()]))
  graph.edges.forEach((edge) => { adjacency.get(edge.source)?.add(edge.target); adjacency.get(edge.target)?.add(edge.source) })
  const visited = new Set<string>()
  const components: Array<{ id: string; nodeCount: number; nodeIds: string[] }> = []
  for (const nodeId of [...adjacency.keys()].sort()) {
    if (visited.has(nodeId)) continue
    const queue = [nodeId]
    const members: string[] = []
    visited.add(nodeId)
    while (queue.length) {
      const current = queue.shift()!
      members.push(current)
      for (const neighbor of [...(adjacency.get(current) ?? [])].sort()) if (!visited.has(neighbor)) { visited.add(neighbor); queue.push(neighbor) }
    }
    components.push({ id: `component-${String(components.length + 1).padStart(3, '0')}`, nodeCount: members.length, nodeIds: members.sort() })
  }
  return components
}

export function generateTopology(layers: readonly TopologySourceLayer[], requested: TopologyGenerationOptions = {}): EmbeddedTopology {
  const options = {
    coordinatePrecision: requested.coordinatePrecision ?? defaults.coordinatePrecision,
    elevationOffset: requested.elevationOffset ?? defaults.elevationOffset,
    nearestNeighbors: Math.max(0, Math.floor(requested.nearestNeighbors ?? defaults.nearestNeighbors)),
  }
  if (!layers.length) throw new Error('没有可用于生成拓扑的楼层')
  const diagnostics: TopologyDiagnosticNode[] = []
  const allComponents: Array<{ id: string; nodeCount: number; nodeIds: string[] }> = []
  const graphs = [...layers].sort((a, b) => a.id.localeCompare(b.id)).map((layer) => {
    const used = new Map<string, number>()
    const nodes: TopologyNode[] = [...layer.nodes].sort((a, b) => a.sid.localeCompare(b.sid) || (a.label ?? '').localeCompare(b.label ?? '')).map((source) => {
      const base = `semantic:${slug(source.sid)}`
      const count = (used.get(base) ?? 0) + 1
      used.set(base, count)
      const id = count === 1 ? base : `${base}:${String(count).padStart(3, '0')}`
      if ((source.renderType === 'STAIR' || source.renderType === 'ELEVATOR') && !source.connectorId) diagnostics.push({ id, sourceSid: source.sid, renderType: source.renderType, reason: 'CONNECTOR_ID_MISSING' })
      return {
        id,
        layerId: layer.id,
        position: point({ x: source.position.x, y: layer.floorElevation + options.elevationOffset, z: source.position.z }, options.coordinatePrecision),
        ...(source.connectorId ? { connectorId: source.connectorId } : {}),
        ...(source.label ? { label: source.label } : {}),
        kind: kindFor(source.renderType),
        subtype: source.subtype ?? source.renderType,
        tags: ['generated', 'semantic', source.renderType.toLowerCase(), 'walkable'],
        data: {
          generated: true,
          sourceSid: source.sid,
          renderType: source.renderType,
          role: kindFor(source.renderType),
          traversal: { mode: 'WALK', walkable: true },
          sourcePosition: point(source.sourcePosition ?? source.position, options.coordinatePrecision),
          ...(source.label ? { sourceLabel: source.label } : {}),
          ...(source.subtype ? { sourceSubtype: source.subtype } : {}),
          ...(source.data ? { sourceData: stableRecord(source.data) } : {}),
        },
      }
    })
    const candidates = createTopologyCandidates(nodes)
    const edges = mergeEdges(nodes, createMinimumSpanningTree(nodes, candidates), createKNearestNeighbors(nodes, candidates, options.nearestNeighbors), options.coordinatePrecision)
    const graph: TopologyGraph = {
      id: `model-topology:${slug(layer.id)}`,
      layers: [{ id: layer.id, label: layer.label, order: layer.order, elevation: round(layer.floorElevation + options.elevationOffset, options.coordinatePrecision), tags: ['generated'], data: { floorElevation: layer.floorElevation, walkingElevation: round(layer.floorElevation + options.elevationOffset, options.coordinatePrecision) } }],
      nodes,
      edges,
      tags: ['generated', 'model-topology', 'semantic-full-graph'],
      data: { ...(layer.sourceAsset ? { sourceAsset: layer.sourceAsset } : {}), strategy: 'SEMANTIC_NODE_MST_KNN', nearestNeighbors: options.nearestNeighbors },
    }
    const components = topologyComponents(graph)
    const componentByNode = new Map(components.flatMap((component) => component.nodeIds.map((nodeId) => [nodeId, component.id])))
    graph.nodes = graph.nodes.map((node) => ({ ...node, data: { ...node.data, componentId: componentByNode.get(node.id) } }))
    allComponents.push(...components.map((component) => ({ ...component, id: `${layer.id}:${component.id}` })))
    return graph
  })
  if (graphs.some((graph) => graph.nodes.length === 0)) throw new Error('至少一个楼层没有 SPACE、DOOR、STAIR、ELEVATOR 或 FACILITY 语义实体')
  return assertEmbeddedTopology({
    schemaVersion: TOPOLOGY_SCHEMA_VERSION,
    coordinateSpace: TOPOLOGY_COORDINATE_SPACE,
    generator: { name: TOPOLOGY_GENERATOR_NAME, version: TOPOLOGY_GENERATOR_VERSION, parameters: { strategy: 'SEMANTIC_NODE_MST_KNN', ...options } },
    graphs,
    diagnostics: {
      source: { layerCount: layers.length, routeNodeCount: graphs.reduce((sum, graph) => sum + graph.nodes.length, 0) },
      components: allComponents,
      unresolvedNodes: diagnostics.sort((a, b) => (a.id ?? '').localeCompare(b.id ?? '') || a.reason.localeCompare(b.reason)),
      warnings: diagnostics.length ? [`${diagnostics.length} semantic node diagnostics require review`] : [],
    },
  })
}
