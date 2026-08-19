import { encodeGlb, parseGlb } from '../glb/glb-codec'
import type { GlbJson } from '../glb/types'
import { graphForFloor, resolveTopology, type TopologyAuthoringState } from './authoring'
import {
  TOPOLOGY_SCENE_EXTRAS_KEY,
  assertEmbeddedTopology,
  validateEmbeddedTopology,
  type EmbeddedTopology,
} from './contract'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export function topologyForFloor(state: TopologyAuthoringState, floorName: string): EmbeddedTopology {
  const resolved = resolveTopology(state)
  const graph = graphForFloor(resolved, floorName)
  if (!graph) throw new Error(`Topology baseline does not contain floor ${floorName}`)
  return assertEmbeddedTopology({ ...resolved, graphs: [graph], diagnostics: undefined })
}

export function embedTopologyInJson(json: GlbJson, state: TopologyAuthoringState, floorName: string): GlbJson {
  const output = clone(json)
  const sceneIndex = output.scene ?? 0
  const scene = output.scenes?.[sceneIndex]
  if (!scene) throw new Error(`GLB scene ${sceneIndex} does not exist`)
  scene.extras = { ...(scene.extras ?? {}), [TOPOLOGY_SCENE_EXTRAS_KEY]: topologyForFloor(state, floorName) }
  return output
}

/** Embed without touching the original bytes, then parse and validate the emitted GLB again. */
export function embedTopologyInGlb(bytes: Uint8Array, state: TopologyAuthoringState, floorName: string): Uint8Array {
  const parsed = parseGlb(bytes)
  const json = embedTopologyInJson(parsed.json, state, floorName)
  const declaredLength = json.buffers?.[0]?.byteLength ?? 0
  const binary = parsed.binChunk?.data.slice(0, declaredLength) ?? new Uint8Array()
  const output = encodeGlb(json, binary)
  const reloaded = parseGlb(output)
  const embedded = reloaded.json.scenes?.[reloaded.json.scene ?? 0]?.extras?.[TOPOLOGY_SCENE_EXTRAS_KEY]
  const errors = validateEmbeddedTopology(embedded)
  if (errors.length) throw new Error(`Release sspTopology reload validation failed: ${errors.join('; ')}`)
  return output
}

export function readEmbeddedTopology(bytes: Uint8Array): EmbeddedTopology | undefined {
  const parsed = parseGlb(bytes)
  const value = parsed.json.scenes?.[parsed.json.scene ?? 0]?.extras?.[TOPOLOGY_SCENE_EXTRAS_KEY]
  if (value === undefined) return undefined
  return assertEmbeddedTopology(value)
}
