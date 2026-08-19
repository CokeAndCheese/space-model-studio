import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createDemoHospitalProject, createDemoProject } from '../src/domain/project-factory'
import { parseProject, serializeProject } from '../src/domain/project-serializer'
import { ProjectHistory } from '../src/editor/project-history'
import { exportFloorToGlb } from '../src/glb/floor-exporter'
import { parseGlb } from '../src/glb/glb-codec'
import { listExternalGlbNodes } from '../src/integration/external-glb-nodes'
import { createTopologyAuthoringState, resolveTopology } from '../src/topology/authoring'
import { validateEmbeddedTopology, type EmbeddedTopology } from '../src/topology/contract'
import { generateTopology, topologyComponents } from '../src/topology/generator'
import { embedTopologyInGlb, readEmbeddedTopology } from '../src/topology/glb'
import { createTopologyReport } from '../src/topology/report'
import { externalTopologyLayer, projectTopologyLayers } from '../src/topology/source-adapters'

describe('topology V1 contract and deterministic generator', () => {
  it('accepts the Space AI Platform compatibility fixture', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/ai-topology-v1.json', import.meta.url), 'utf8'))
    expect(validateEmbeddedTopology(fixture)).toEqual([])
  })

  it('generates a byte-stable connected MST plus bounded KNN graph', () => {
    const layers = projectTopologyLayers(createDemoHospitalProject())
    const first = generateTopology(layers)
    const second = generateTopology(layers)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    for (const graph of first.graphs) {
      expect(topologyComponents(graph)).toHaveLength(1)
      expect(graph.nodes).toHaveLength(layers.find((layer) => layer.id === graph.layers[0]!.id)!.nodes.length)
      expect(graph.edges.filter((edge) => edge.tags?.includes('mst'))).toHaveLength(graph.nodes.length - 1)
      expect(graph.edges.every((edge) => edge.relation === 'LINK' && edge.direction === 'BIDIRECTIONAL')).toBe(true)
    }
  })

  it('reports missing connectorId without inventing cross-floor edges', () => {
    const project = createDemoHospitalProject()
    const topology = generateTopology(projectTopologyLayers(project))
    const report = createTopologyReport(topology)
    expect(report.missingConnectorIds.length).toBeGreaterThanOrEqual(2)
    expect(topology.graphs.flatMap((graph) => graph.edges).every((edge) => edge.relation === 'LINK')).toBe(true)
    expect(topology.diagnostics?.unresolvedNodes?.every((item) => item.reason === 'CONNECTOR_ID_MISSING')).toBe(true)
  })
})

describe('topology authoring state', () => {
  it('keeps baseline immutable while nodes, edges and via paths can be edited, deleted and restored', () => {
    const baseline = generateTopology(projectTopologyLayers(createDemoHospitalProject()))
    const baselineText = JSON.stringify(baseline)
    const state = createTopologyAuthoringState(baseline)
    const graph = baseline.graphs[0]!
    const node = graph.nodes[0]!
    const edge = graph.edges[0]!
    state.nodeEdits[node.id] = { position: { x: 99, y: node.position.y, z: 88 }, deleted: true }
    state.edgeEdits[edge.id] = { via: [{ x: 1, y: node.position.y, z: 1 }], deleted: true }
    expect(resolveTopology(state).graphs[0]!.nodes.some((item) => item.id === node.id)).toBe(false)
    expect(resolveTopology(state).graphs[0]!.edges.some((item) => item.id === edge.id)).toBe(false)
    state.nodeEdits[node.id]!.deleted = false
    state.edgeEdits[edge.id]!.deleted = false
    const restored = resolveTopology(state)
    expect(restored.graphs[0]!.nodes.find((item) => item.id === node.id)?.position.x).toBe(99)
    expect(restored.graphs[0]!.edges.find((item) => item.id === edge.id)?.path?.via).toEqual([{ x: 1, y: node.position.y, z: 1 }])
    expect(JSON.stringify(state.baseline)).toBe(baselineText)
  })

  it('participates in project snapshot undo/redo', () => {
    const project = createDemoProject()
    const history = new ProjectHistory(project)
    const before = structuredClone(project)
    project.topology = createTopologyAuthoringState(generateTopology(projectTopologyLayers(project)))
    history.record(before)
    const undone = history.undo(project)!
    expect(undone.topology).toBeUndefined()
    expect(history.redo(undone)?.topology?.baseline.schemaVersion).toBe(1)
  })

  it('round trips topology authoring state through sapmodel serialization', () => {
    const project = createDemoProject()
    project.topology = createTopologyAuthoringState(generateTopology(projectTopologyLayers(project)))
    const copy = parseProject(serializeProject(project))
    expect(copy.topology).toEqual(project.topology)
    expect(validateEmbeddedTopology(resolveTopology(copy.topology!))).toEqual([])
  })
})

describe('release topology embedding', () => {
  it('reparses and validates scene.extras.sspTopology from the emitted GLB', () => {
    const project = createDemoProject()
    project.topology = createTopologyAuthoringState(generateTopology(projectTopologyLayers(project)))
    const floor = project.buildings[0]!.floors[0]!
    const result = exportFloorToGlb(project, floor.id)
    const embedded = readEmbeddedTopology(result.bytes)
    expect(embedded?.schemaVersion).toBe(1)
    expect(embedded?.coordinateSpace).toBe('MODEL_LOCAL')
    expect(embedded?.graphs).toHaveLength(1)
    expect(embedded?.graphs[0]!.layers[0]!.id).toBe(floor.floorName)
    expect(validateEmbeddedTopology(embedded as EmbeddedTopology)).toEqual([])
  })

  it('generates from a real imported semantic GLB without overwriting its original bytes', () => {
    const source = new Uint8Array(readFileSync(new URL('../A_1F.glb', import.meta.url)))
    const original = source.slice()
    const parsed = parseGlb(source)
    const nodes = listExternalGlbNodes(parsed.json)
    const floor = createDemoProject().buildings[0]!.floors[0]!
    const baseline = generateTopology([externalTopologyLayer({ bytes: source, fileName: 'A_1F.glb', floor, nodes })])
    const output = embedTopologyInGlb(source, createTopologyAuthoringState(baseline), floor.floorName)
    expect(source).toEqual(original)
    expect(output).not.toEqual(source)
    expect(readEmbeddedTopology(output)?.graphs[0]!.nodes.length).toBe(nodes.filter((node) => ['SPACE', 'DOOR', 'STAIR', 'ELEVATOR', 'FACILITY'].includes(node.renderType)).length)
    expect(parsed.json.scenes?.[parsed.json.scene ?? 0]?.extras?.sspTopology).toBeUndefined()
  })
})

describe('topology UI wiring', () => {
  it('exposes a peer top action and a separate authoring workspace', () => {
    const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
    const workspace = readFileSync(new URL('../src/components/TopologyWorkspace.vue', import.meta.url), 'utf8')
    expect(app).toContain('生成拓扑')
    expect(app).toContain('<TopologyWorkspace')
    expect(workspace).toContain('Topology 工作区')
    expect(workspace).toContain("updateEdgeVia")
    expect(workspace).toContain('恢复已删除项')
    const viewport = readFileSync(new URL('../src/components/EditorViewport.vue', import.meta.url), 'utf8')
    expect(app).toContain(':topology-graph="activeTopologyGraph"')
    expect(app).toContain('@topology-select="selectTopologyFromViewport"')
    expect(viewport).toContain("topologyOverlay.name = 'topology-model-overlay'")
    expect(viewport).toContain('[source.position, ...(edge.path?.via ?? []), target.position]')
    expect(viewport).toContain("emit('topology-select', clickedTopology)")
  })
})
