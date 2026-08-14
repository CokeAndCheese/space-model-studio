import { parseGlb } from '../glb/glb-codec'
import type { GlbJson, ParsedGlb } from '../glb/types'

export interface ExternalGlbWorldVertex {
  x: number
  y: number
  z: number
}

export type ExternalGlbTriangle = readonly [
  ExternalGlbWorldVertex,
  ExternalGlbWorldVertex,
  ExternalGlbWorldVertex,
]

export interface ExternalGlbBounds {
  min: ExternalGlbWorldVertex
  max: ExternalGlbWorldVertex
}

export interface ExternalGlbGeometryPrimitive {
  nodeIndex: number
  nodeName: string
  meshIndex: number
  primitiveIndex: number
  /** A copy of the node extras, including semantic metadata. */
  extras: Record<string, unknown>
  triangles: ExternalGlbTriangle[]
  bounds: ExternalGlbBounds
}

export interface DecodeExternalGlbGeometryOptions {
  /** Defaults to the JSON scene, or scene 0 when JSON.scene is omitted. */
  sceneIndex?: number
  /** Overrides the selected scene's root nodes. */
  rootNodeIndices?: readonly number[]
  /** Skips mesh decoding for nodes outside the caller's semantic scope. */
  includeNode?: (node: ExternalGlbNodeGeometryContext) => boolean
  /** Maximum number of scene node entries to visit; defaults to 100,000. */
  maxVisitedNodes?: number
  /** Hard guards checked before allocating decoded geometry. */
  maxPrimitives?: number
  maxTriangles?: number
  maxPositionElements?: number
}

export interface ExternalGlbNodeGeometryContext {
  nodeIndex: number
  nodeName: string
  meshIndex: number
  extras: Record<string, unknown>
}

export class ExternalGlbGeometryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExternalGlbGeometryError'
  }
}

type Vec4 = [number, number, number, number]
type Matrix4 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
]

const IDENTITY: Matrix4 = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]

const COMPONENT_BYTES: Record<number, number> = {
  5121: 1,
  5123: 2,
  5125: 4,
  5126: 4,
}

// Keep traversal bounded for untrusted graphs while allowing ordinary large scenes.
const DEFAULT_MAX_VISITED_NODES = 100_000

function fail(message: string): never {
  throw new ExternalGlbGeometryError(message)
}

function normalizeLimit(value: number | undefined, name: string): number {
  if (value === undefined) return Infinity
  if (!Number.isInteger(value) || value <= 0) fail(`${name} must be a positive integer`)
  return value
}

function normalizeVisitedNodeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_VISITED_NODES
  if (!Number.isInteger(value) || value <= 0) fail('maxVisitedNodes must be a positive integer')
  return value
}

function asFinite(value: number, path: string): number {
  if (!Number.isFinite(value)) fail(`${path} contains a non-finite value`)
  return value
}

function matrixMultiply(left: Matrix4, right: Matrix4): Matrix4 {
  const result = Array<number>(16).fill(0) as Matrix4
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let k = 0; k < 4; k += 1) {
        result[column * 4 + row] += left[k * 4 + row]! * right[column * 4 + k]!
      }
    }
  }
  return result
}

function nodeMatrix(node: NonNullable<GlbJson['nodes']>[number], path: string): Matrix4 {
  if (node.matrix !== undefined) {
    if (node.matrix.length !== 16) fail(`${path}.matrix must contain 16 numbers`)
    return node.matrix.map((value, index) => asFinite(value!, `${path}.matrix[${index}]`)) as Matrix4
  }

  const translation = node.translation ?? [0, 0, 0]
  const scale = node.scale ?? [1, 1, 1]
  const rotation = node.rotation ?? [0, 0, 0, 1]
  if (translation.length !== 3) fail(`${path}.translation must contain 3 numbers`)
  if (scale.length !== 3) fail(`${path}.scale must contain 3 numbers`)
  if (rotation.length !== 4) fail(`${path}.rotation must contain 4 numbers`)
  const t = translation.map((value, index) => asFinite(value!, `${path}.translation[${index}]`))
  const s = scale.map((value, index) => asFinite(value!, `${path}.scale[${index}]`))
  const q = rotation.map((value, index) => asFinite(value!, `${path}.rotation[${index}]`)) as Vec4
  const [x, y, z, w] = q
  const length = Math.hypot(x, y, z, w)
  if (length === 0) fail(`${path}.rotation must not be a zero quaternion`)
  const nx = x / length
  const ny = y / length
  const nz = z / length
  const nw = w / length
  const xx = nx * nx
  const yy = ny * ny
  const zz = nz * nz
  const xy = nx * ny
  const xz = nx * nz
  const yz = ny * nz
  const wx = nw * nx
  const wy = nw * ny
  const wz = nw * nz

  // Column-major glTF matrix: T * R * S.
  return [
    (1 - 2 * (yy + zz)) * s[0]!, (2 * (xy + wz)) * s[0]!, (2 * (xz - wy)) * s[0]!, 0,
    (2 * (xy - wz)) * s[1]!, (1 - 2 * (xx + zz)) * s[1]!, (2 * (yz + wx)) * s[1]!, 0,
    (2 * (xz + wy)) * s[2]!, (2 * (yz - wx)) * s[2]!, (1 - 2 * (xx + yy)) * s[2]!, 0,
    t[0]!, t[1]!, t[2]!, 1,
  ]
}

function transformPoint(matrix: Matrix4, point: ExternalGlbWorldVertex, path: string): ExternalGlbWorldVertex {
  const x = matrix[0]! * point.x + matrix[4]! * point.y + matrix[8]! * point.z + matrix[12]!
  const y = matrix[1]! * point.x + matrix[5]! * point.y + matrix[9]! * point.z + matrix[13]!
  const z = matrix[2]! * point.x + matrix[6]! * point.y + matrix[10]! * point.z + matrix[14]!
  return { x: asFinite(x, path), y: asFinite(y, path), z: asFinite(z, path) }
}

function getDataView(parsed: ParsedGlb): { view: DataView; byteLength: number } {
  const buffer = parsed.json.buffers?.[0]
  if (!buffer) fail('GLB must declare an embedded buffers[0]')
  if (buffer.uri !== undefined) fail('External buffer URIs are not supported; use an embedded GLB BIN chunk')
  const bin = parsed.binChunk?.data
  if (!bin) fail('GLB must contain an embedded BIN chunk')
  if (buffer.byteLength > bin.byteLength) fail(`buffers[0].byteLength ${buffer.byteLength} exceeds BIN length ${bin.byteLength}`)
  return {
    view: new DataView(bin.buffer, bin.byteOffset, buffer.byteLength),
    byteLength: buffer.byteLength,
  }
}

function accessorLayout(
  json: GlbJson,
  accessorIndex: number,
  expectedType: string,
  path: string,
): { accessor: NonNullable<GlbJson['accessors']>[number]; view: NonNullable<GlbJson['bufferViews']>[number]; componentBytes: number; stride: number; start: number; elementBytes: number } {
  const accessor = json.accessors?.[accessorIndex]
  if (!accessor) fail(`${path} references missing accessor ${accessorIndex}`)
  if (accessor.type !== expectedType) fail(`${path} accessor must have type ${expectedType}`)
  const componentBytes = COMPONENT_BYTES[accessor.componentType]
  if (!componentBytes) fail(`${path} uses unsupported componentType ${accessor.componentType}`)
  const bufferViewIndex = accessor.bufferView
  if (bufferViewIndex === undefined) fail(`${path} accessor must reference a bufferView`)
  const view = json.bufferViews?.[bufferViewIndex]
  if (!view) fail(`${path} references missing bufferView ${bufferViewIndex}`)
  if (view.buffer !== 0) fail(`${path} references buffer ${view.buffer}; only embedded buffers[0] are supported`)
  const components = expectedType === 'VEC3' ? 3 : 1
  const elementBytes = componentBytes * components
  const stride = view.byteStride ?? elementBytes
  if (!Number.isInteger(stride) || stride < elementBytes) fail(`${path} bufferView.byteStride is smaller than the accessor element`)
  const accessorOffset = accessor.byteOffset ?? 0
  const viewOffset = view.byteOffset ?? 0
  if (!Number.isInteger(accessorOffset) || accessorOffset < 0) fail(`${path} accessor.byteOffset must be non-negative`)
  if (!Number.isInteger(viewOffset) || viewOffset < 0) fail(`${path} bufferView.byteOffset must be non-negative`)
  const lastByte = viewOffset + accessorOffset + Math.max(0, accessor.count - 1) * stride + elementBytes
  if (!Number.isInteger(accessor.count) || accessor.count < 0) fail(`${path} accessor.count must be a non-negative integer`)
  if (lastByte > viewOffset + view.byteLength) fail(`${path} exceeds its bufferView bounds`)
  return { accessor, view, componentBytes, stride, start: viewOffset + accessorOffset, elementBytes }
}

function readComponent(view: DataView, offset: number, componentType: number): number {
  if (componentType === 5121) return view.getUint8(offset)
  if (componentType === 5123) return view.getUint16(offset, true)
  if (componentType === 5125) return view.getUint32(offset, true)
  return view.getFloat32(offset, true)
}

function decodePositions(json: GlbJson, parsed: ParsedGlb, accessorIndex: number, path: string): ExternalGlbWorldVertex[] {
  const layout = accessorLayout(json, accessorIndex, 'VEC3', path)
  if (layout.accessor.componentType !== 5126) fail(`${path} POSITION accessor must use FLOAT componentType 5126`)
  const { view, byteLength } = getDataView(parsed)
  return Array.from({ length: layout.accessor.count }, (_, index) => {
    const offset = layout.start + index * layout.stride
    if (offset < 0 || offset + layout.elementBytes > byteLength) fail(`${path} reads beyond the embedded BIN chunk`)
    return {
      x: asFinite(view.getFloat32(offset, true), `${path}[${index}].x`),
      y: asFinite(view.getFloat32(offset + 4, true), `${path}[${index}].y`),
      z: asFinite(view.getFloat32(offset + 8, true), `${path}[${index}].z`),
    }
  })
}

function decodeIndices(json: GlbJson, parsed: ParsedGlb, accessorIndex: number, path: string): number[] {
  const layout = accessorLayout(json, accessorIndex, 'SCALAR', path)
  if (![5121, 5123, 5125].includes(layout.accessor.componentType)) {
    fail(`${path} indices must use UNSIGNED_BYTE, UNSIGNED_SHORT, or UNSIGNED_INT`)
  }
  const { view, byteLength } = getDataView(parsed)
  return Array.from({ length: layout.accessor.count }, (_, index) => {
    const offset = layout.start + index * layout.stride
    if (offset < 0 || offset + layout.componentBytes > byteLength) fail(`${path} reads beyond the embedded BIN chunk`)
    return readComponent(view, offset, layout.accessor.componentType)
  })
}

function makeBounds(triangles: ExternalGlbTriangle[]): ExternalGlbBounds {
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const triangle of triangles) {
    for (const point of triangle) {
      min.x = Math.min(min.x, point.x)
      min.y = Math.min(min.y, point.y)
      min.z = Math.min(min.z, point.z)
      max.x = Math.max(max.x, point.x)
      max.y = Math.max(max.y, point.y)
      max.z = Math.max(max.z, point.z)
    }
  }
  return { min, max }
}

/** Decode scene-reachable semantic mesh primitives into finite world-space triangles. */
export function decodeExternalGlbGeometry(
  input: ArrayBuffer | Uint8Array | ParsedGlb,
  options: DecodeExternalGlbGeometryOptions = {},
): ExternalGlbGeometryPrimitive[] {
  const parsed = 'json' in input && 'chunks' in input ? input : parseGlb(input)
  const json = parsed.json
  const nodes = json.nodes ?? []
  const meshes = json.meshes ?? []
  const scenes = json.scenes ?? []
  const sceneIndex = options.sceneIndex ?? json.scene ?? 0
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex >= scenes.length) {
    fail(`sceneIndex ${sceneIndex} is not present in the GLB scenes array`)
  }
  const roots = options.rootNodeIndices ?? scenes[sceneIndex]!.nodes ?? []
  const output: ExternalGlbGeometryPrimitive[] = []
  const active = new Set<number>()
  const maxPrimitives = normalizeLimit(options.maxPrimitives, 'maxPrimitives')
  const maxTriangles = normalizeLimit(options.maxTriangles, 'maxTriangles')
  const maxPositionElements = normalizeLimit(options.maxPositionElements, 'maxPositionElements')
  const maxVisitedNodes = normalizeVisitedNodeLimit(options.maxVisitedNodes)
  let primitiveCount = 0
  let triangleCount = 0
  let positionElementCount = 0

  type TraversalFrame =
    | { kind: 'enter'; nodeIndex: number; parentMatrix: Matrix4 }
    | { kind: 'exit'; nodeIndex: number }
  let scheduledNodeCount = roots.length
  if (scheduledNodeCount > maxVisitedNodes) fail(`visited node limit exceeded (${maxVisitedNodes})`)
  const traversal: TraversalFrame[] = roots.map((nodeIndex) => ({
    kind: 'enter',
    nodeIndex,
    parentMatrix: IDENTITY,
  }))
  traversal.reverse()
  let visitedNodeCount = 0

  while (traversal.length > 0) {
    const frame = traversal.pop()!
    if (frame.kind === 'exit') {
      active.delete(frame.nodeIndex)
      continue
    }

    const { nodeIndex, parentMatrix } = frame
    const node = nodes[nodeIndex]
    if (!node) fail(`scene references missing node ${nodeIndex}`)
    if (active.has(nodeIndex)) fail(`node cycle detected at nodes[${nodeIndex}]`)
    active.add(nodeIndex)
    visitedNodeCount += 1
    if (visitedNodeCount > maxVisitedNodes) fail(`visited node limit exceeded (${maxVisitedNodes})`)
    const worldMatrix = matrixMultiply(parentMatrix, nodeMatrix(node, `nodes[${nodeIndex}]`))

    if (node.mesh !== undefined) {
      const meshIndex = node.mesh
      const extras = node.extras ? { ...node.extras } : {}
      const context: ExternalGlbNodeGeometryContext = { nodeIndex, nodeName: node.name ?? `node_${nodeIndex}`, meshIndex, extras }
      if (!options.includeNode || options.includeNode(context)) {
        const mesh = meshes[meshIndex]
        if (!mesh) fail(`nodes[${nodeIndex}].mesh references missing mesh ${meshIndex}`)
        mesh.primitives.forEach((primitive, primitiveIndex) => {
          const primitivePath = `meshes[${meshIndex}].primitives[${primitiveIndex}]`
          primitiveCount += 1
          if (primitiveCount > maxPrimitives) fail(`decoded primitive limit exceeded (${maxPrimitives})`)
          if (primitive.mode !== undefined && primitive.mode !== 4) {
            fail(`${primitivePath} uses primitive mode ${primitive.mode}; only TRIANGLES mode 4 is supported`)
          }
          const positionAccessor = primitive.attributes.POSITION
          if (!Number.isInteger(positionAccessor)) fail(`${primitivePath} must reference a POSITION accessor`)
          const positionLayout = json.accessors?.[positionAccessor]
          if (!positionLayout || !Number.isInteger(positionLayout.count) || positionLayout.count < 0) fail(`${primitivePath}.attributes.POSITION references an invalid accessor`)
          positionElementCount += positionLayout.count
          if (positionElementCount > maxPositionElements) fail(`decoded POSITION element limit exceeded (${maxPositionElements})`)
          const indexCount = primitive.indices === undefined
            ? positionLayout.count
            : json.accessors?.[primitive.indices]?.count
          if (!Number.isInteger(indexCount) || indexCount! < 0 || indexCount! % 3 !== 0) fail(`${primitivePath} must contain a multiple of 3 vertices/indices`)
          const primitiveTriangleCount = indexCount! / 3
          triangleCount += primitiveTriangleCount
          if (triangleCount > maxTriangles) fail(`decoded triangle limit exceeded (${maxTriangles})`)
          const positions = decodePositions(json, parsed, positionAccessor, `${primitivePath}.attributes.POSITION`)
          const indices = primitive.indices === undefined
            ? Array.from({ length: positions.length }, (_, index) => index)
            : decodeIndices(json, parsed, primitive.indices, `${primitivePath}.indices`)
          if (indices.length === 0 || indices.length % 3 !== 0) fail(`${primitivePath} must contain a multiple of 3 vertices/indices`)
          const triangles: ExternalGlbTriangle[] = []
          for (let index = 0; index < indices.length; index += 3) {
            const points = indices.slice(index, index + 3).map((positionIndex) => {
              const point = positions[positionIndex]
              if (!point) fail(`${primitivePath} index ${positionIndex} is outside POSITION accessor bounds`)
              return transformPoint(worldMatrix, point, `${primitivePath}.worldPosition`)
            }) as [ExternalGlbWorldVertex, ExternalGlbWorldVertex, ExternalGlbWorldVertex]
            triangles.push(points)
          }
          output.push({
            nodeIndex,
            nodeName: context.nodeName,
            meshIndex,
            primitiveIndex,
            extras,
            triangles,
            bounds: makeBounds(triangles),
          })
        })
      }
    }

    traversal.push({ kind: 'exit', nodeIndex })
    const children = node.children ?? []
    scheduledNodeCount += children.length
    if (scheduledNodeCount > maxVisitedNodes) fail(`visited node limit exceeded (${maxVisitedNodes})`)
    for (let childIndex = children.length - 1; childIndex >= 0; childIndex -= 1) {
      traversal.push({ kind: 'enter', nodeIndex: children[childIndex]!, parentMatrix: worldMatrix })
    }
  }

  return output
}
