import { topologyComponents } from './generator'
import { MIN_TOPOLOGY_EDGE_LENGTH, validateEmbeddedTopology, type EmbeddedTopology, type TopologyPoint } from './contract'

export interface TopologyGraphReport {
  graphId: string
  nodes: number
  edges: number
  components: number
  isolatedNodes: string[]
  invalidEdgeIds: string[]
}
export interface TopologyReport {
  valid: boolean
  errors: string[]
  graphs: TopologyGraphReport[]
  missingConnectorIds: string[]
}

const distance = (a: TopologyPoint, b: TopologyPoint) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

export function createTopologyReport(topology: EmbeddedTopology): TopologyReport {
  const errors = validateEmbeddedTopology(topology)
  const missingConnectorIds: string[] = []
  const graphs = topology.graphs.map((graph) => {
    const degrees = new Map(graph.nodes.map((node) => [node.id, 0]))
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
    const invalidEdgeIds: string[] = []
    for (const edge of graph.edges) {
      degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1)
      degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1)
      const source = nodeById.get(edge.source)
      const target = nodeById.get(edge.target)
      if (!source || !target) { invalidEdgeIds.push(edge.id); continue }
      const points = [source.position, ...(edge.path?.via ?? []), target.position]
      if (points.some((point, index) => index > 0 && distance(points[index - 1]!, point) <= MIN_TOPOLOGY_EDGE_LENGTH)) invalidEdgeIds.push(edge.id)
    }
    for (const node of graph.nodes) {
      const renderType = node.data?.renderType
      if ((renderType === 'STAIR' || renderType === 'ELEVATOR') && !node.connectorId) missingConnectorIds.push(node.id)
    }
    return {
      graphId: graph.id,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      components: topologyComponents(graph).length,
      isolatedNodes: [...degrees].filter(([, degree]) => degree === 0).map(([id]) => id).sort(),
      invalidEdgeIds: invalidEdgeIds.sort(),
    }
  })
  return { valid: errors.length === 0 && graphs.every((graph) => graph.components === 1 && graph.invalidEdgeIds.length === 0), errors, graphs, missingConnectorIds: missingConnectorIds.sort() }
}
