import type { Vec2, Wall } from './contract'

/** The part of a Wall that is needed to derive an enclosure. */
export type WallCenterlineSegment = Pick<Wall, 'id' | 'start' | 'end'>

export interface WallEnclosure {
  /** A rotation- and input-order-independent key for the polygon. */
  key: string
  polygon: Vec2[]
  area: number
  /** IDs of the (possibly coalesced) centerline edges on the face boundary. */
  wallIds: string[]
}

/** Compatibility name used by room-generation integration. */
export type ExtractedWallEnclosure = WallEnclosure

export type WallEnclosureDiagnosticCode =
  | 'DUPLICATE_EDGE'
  | 'DEGENERATE_EDGE'
  | 'NON_ENDPOINT_INTERSECTION'
  | 'NO_BOUNDED_FACE'

export interface WallEnclosureDiagnostic {
  code: WallEnclosureDiagnosticCode
  wallIds: string[]
}

export interface WallEnclosureResult {
  rooms: WallEnclosure[]
  diagnostics: WallEnclosureDiagnostic[]
}

export interface WallEnclosureOptions {
  /** Maximum distance at which two wall endpoints are treated as one vertex. */
  endpointTolerance?: number
  /** Minimum absolute area retained as a bounded face. */
  areaTolerance?: number
}

interface Endpoint {
  point: Vec2
  wallIndex: number
  side: 0 | 1
}

interface Vertex {
  point: Vec2
  endpointIndexes: number[]
  tieKey: string
}

interface GraphEdge {
  a: number
  b: number
  wallIds: string[]
}

interface HalfEdge {
  origin: number
  target: number
  twin: number
  edgeIndex: number
  next: number
}

const DEFAULT_ENDPOINT_TOLERANCE = 1e-6
const DEFAULT_AREA_TOLERANCE = 1e-10

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function comparePoints(left: Vec2, right: Vec2): number {
  return compareNumbers(left.x, right.x) || compareNumbers(left.z, right.z)
}

function finitePoint(point: Vec2): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.z)
}

function canonicalNumber(value: number): string {
  return String(Object.is(value, -0) ? 0 : value)
}

function pointKey(point: Vec2): string {
  return `${canonicalNumber(point.x)},${canonicalNumber(point.z)}`
}

function distance(left: Vec2, right: Vec2): number {
  return Math.hypot(left.x - right.x, left.z - right.z)
}

function signedArea(polygon: readonly Vec2[]): number {
  let twiceArea = 0
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]!
    const next = polygon[(index + 1) % polygon.length]!
    twiceArea += current.x * next.z - next.x * current.z
  }
  return twiceArea / 2
}

function orientation(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
}

function onSegment(a: Vec2, b: Vec2, point: Vec2, epsilon: number): boolean {
  return (
    Math.abs(orientation(a, b, point)) <= epsilon &&
    point.x >= Math.min(a.x, b.x) - epsilon &&
    point.x <= Math.max(a.x, b.x) + epsilon &&
    point.z >= Math.min(a.z, b.z) - epsilon &&
    point.z <= Math.max(a.z, b.z) + epsilon
  )
}

function pointOnSegmentWithinTolerance(a: Vec2, b: Vec2, point: Vec2, tolerance: number): boolean {
  const length = distance(a, b)
  if (length <= tolerance) return distance(a, point) <= tolerance
  return Math.abs(orientation(a, b, point)) / length <= tolerance && onSegment(a, b, point, tolerance)
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2, epsilon: number): boolean {
  const abC = orientation(a, b, c)
  const abD = orientation(a, b, d)
  const cdA = orientation(c, d, a)
  const cdB = orientation(c, d, b)
  if (
    ((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon)) &&
    ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon))
  ) {
    return true
  }
  return (
    (Math.abs(abC) <= epsilon && onSegment(a, b, c, epsilon)) ||
    (Math.abs(abD) <= epsilon && onSegment(a, b, d, epsilon)) ||
    (Math.abs(cdA) <= epsilon && onSegment(c, d, a, epsilon)) ||
    (Math.abs(cdB) <= epsilon && onSegment(c, d, b, epsilon))
  )
}

function segmentsCrossInTheirInteriors(a: Vec2, b: Vec2, c: Vec2, d: Vec2, epsilon: number): boolean {
  const abC = orientation(a, b, c)
  const abD = orientation(a, b, d)
  const cdA = orientation(c, d, a)
  const cdB = orientation(c, d, b)
  return (
    ((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon))
    && ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon))
  )
}

function isSimplePolygon(polygon: readonly Vec2[], epsilon: number): boolean {
  const vertexKeys = new Set(polygon.map(pointKey))
  if (vertexKeys.size !== polygon.length) return false

  for (let first = 0; first < polygon.length; first += 1) {
    const firstNext = (first + 1) % polygon.length
    for (let second = first + 1; second < polygon.length; second += 1) {
      const secondNext = (second + 1) % polygon.length
      if (firstNext === second || secondNext === first) continue
      if (segmentsIntersect(polygon[first]!, polygon[firstNext]!, polygon[second]!, polygon[secondNext]!, epsilon)) {
        return false
      }
    }
  }
  return true
}

function canonicalizePolygon(polygon: readonly Vec2[]): Vec2[] {
  const points = polygon.map((point) => ({ x: point.x, z: point.z }))
  let first = 0
  for (let index = 1; index < points.length; index += 1) {
    if (comparePoints(points[index]!, points[first]!) < 0) first = index
  }
  return points.slice(first).concat(points.slice(0, first))
}

function polygonKey(polygon: readonly Vec2[]): string {
  return polygon.map(pointKey).join('|')
}

class DisjointSet {
  private readonly parents: number[]

  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index)
  }

  find(value: number): number {
    let root = value
    while (this.parents[root] !== root) root = this.parents[root]!
    while (this.parents[value] !== value) {
      const parent = this.parents[value]!
      this.parents[value] = root
      value = parent
    }
    return root
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left)
    const rightRoot = this.find(right)
    if (leftRoot !== rightRoot) this.parents[rightRoot] = leftRoot
  }
}

function validateOption(value: number | undefined, name: string, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a finite number greater than 0`)
  }
  return resolved
}

function buildVertices(
  walls: readonly WallCenterlineSegment[],
  endpointTolerance: number,
): { vertices: Vertex[]; endpointVertexIndexes: number[] } {
  const endpoints: Endpoint[] = []
  for (let wallIndex = 0; wallIndex < walls.length; wallIndex += 1) {
    const wall = walls[wallIndex]!
    if (!finitePoint(wall.start) || !finitePoint(wall.end)) {
      throw new RangeError(`Wall ${wall.id} has a non-finite endpoint`)
    }
    endpoints.push({ point: { ...wall.start }, wallIndex, side: 0 })
    endpoints.push({ point: { ...wall.end }, wallIndex, side: 1 })
  }

  const sortedEndpointIndexes = endpoints
    .map((_, index) => index)
    .sort((left, right) => {
      const comparison = comparePoints(endpoints[left]!.point, endpoints[right]!.point)
      if (comparison !== 0) return comparison
      const leftWall = walls[endpoints[left]!.wallIndex]!.id
      const rightWall = walls[endpoints[right]!.wallIndex]!.id
      return leftWall.localeCompare(rightWall) || endpoints[left]!.side - endpoints[right]!.side
    })
  const sets = new DisjointSet(endpoints.length)
  for (let first = 0; first < sortedEndpointIndexes.length; first += 1) {
    for (let second = first + 1; second < sortedEndpointIndexes.length; second += 1) {
      const left = endpoints[sortedEndpointIndexes[first]!]!
      const right = endpoints[sortedEndpointIndexes[second]!]!
      if (right.point.x - left.point.x > endpointTolerance) break
      if (distance(left.point, right.point) > endpointTolerance) continue
      sets.union(sortedEndpointIndexes[first]!, sortedEndpointIndexes[second]!)
    }
  }

  const clusters = new Map<number, number[]>()
  for (let index = 0; index < endpoints.length; index += 1) {
    const root = sets.find(index)
    const members = clusters.get(root)
    if (members) members.push(index)
    else clusters.set(root, [index])
  }
  const vertices = [...clusters.values()]
    .map((endpointIndexes) => {
      const ordered = [...endpointIndexes].sort((left, right) => {
        const comparison = comparePoints(endpoints[left]!.point, endpoints[right]!.point)
        if (comparison !== 0) return comparison
        const leftEndpoint = endpoints[left]!
        const rightEndpoint = endpoints[right]!
        const leftWall = walls[leftEndpoint.wallIndex]!.id
        const rightWall = walls[rightEndpoint.wallIndex]!.id
        return leftWall.localeCompare(rightWall) || leftEndpoint.side - rightEndpoint.side || left - right
      })
      const point = ordered.reduce(
        (sum, endpointIndex) => ({
          x: sum.x + endpoints[endpointIndex]!.point.x,
          z: sum.z + endpoints[endpointIndex]!.point.z,
        }),
        { x: 0, z: 0 },
      )
      return {
        endpointIndexes: ordered,
        point: { x: point.x / ordered.length, z: point.z / ordered.length },
        tieKey: ordered
          .map((endpointIndex) => `${walls[endpoints[endpointIndex]!.wallIndex]!.id}:${endpoints[endpointIndex]!.side}`)
          .join('|'),
      }
    })
    .sort((left, right) => comparePoints(left.point, right.point) || left.tieKey.localeCompare(right.tieKey))

  const endpointVertexIndexes = Array.from({ length: endpoints.length }, () => -1)
  for (let vertexIndex = 0; vertexIndex < vertices.length; vertexIndex += 1) {
    for (const endpointIndex of vertices[vertexIndex]!.endpointIndexes) endpointVertexIndexes[endpointIndex] = vertexIndex
  }
  return { vertices, endpointVertexIndexes }
}

function buildEdges(
  walls: readonly WallCenterlineSegment[],
  vertices: readonly Vertex[],
  endpointVertexIndexes: readonly number[],
  endpointTolerance: number,
): GraphEdge[] {
  const byKey = new Map<string, GraphEdge>()
  for (let wallIndex = 0; wallIndex < walls.length; wallIndex += 1) {
    const start = walls[wallIndex]!.start
    const end = walls[wallIndex]!.end
    const startVertex = endpointVertexIndexes[wallIndex * 2]!
    const endVertex = endpointVertexIndexes[wallIndex * 2 + 1]!
    const pointsOnWall = vertices
      .map((vertex, vertexIndex) => ({
        vertexIndex,
        parameter: ((vertex.point.x - start.x) * (end.x - start.x) + (vertex.point.z - start.z) * (end.z - start.z))
          / Math.max(distance(start, end) ** 2, Number.EPSILON),
        onWall: pointOnSegmentWithinTolerance(start, end, vertex.point, endpointTolerance),
      }))
      .filter((candidate) => candidate.onWall)
      .sort((left, right) => left.parameter - right.parameter || left.vertexIndex - right.vertexIndex)
    if (!pointsOnWall.some((candidate) => candidate.vertexIndex === startVertex)) pointsOnWall.unshift({ vertexIndex: startVertex, parameter: 0, onWall: true })
    if (!pointsOnWall.some((candidate) => candidate.vertexIndex === endVertex)) pointsOnWall.push({ vertexIndex: endVertex, parameter: 1, onWall: true })
    for (let pointIndex = 0; pointIndex < pointsOnWall.length - 1; pointIndex += 1) {
      const a = pointsOnWall[pointIndex]!.vertexIndex
      const b = pointsOnWall[pointIndex + 1]!.vertexIndex
      if (a === b) continue
      const low = Math.min(a, b)
      const high = Math.max(a, b)
      const key = `${low}:${high}`
      const existing = byKey.get(key)
      if (existing) {
        existing.wallIds.push(walls[wallIndex]!.id)
      } else {
        byKey.set(key, { a: low, b: high, wallIds: [walls[wallIndex]!.id] })
      }
    }
  }
  return [...byKey.values()]
    .map((edge) => ({ ...edge, wallIds: [...new Set(edge.wallIds)].sort((left, right) => left.localeCompare(right)) }))
    .sort((left, right) => left.a - right.a || left.b - right.b)
}

function buildHalfEdges(edges: readonly GraphEdge[], vertices: readonly Vertex[]): { halfEdges: HalfEdge[]; outgoing: number[][] } {
  const halfEdges: HalfEdge[] = []
  const outgoing = vertices.map(() => []) as number[][]
  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
    const edge = edges[edgeIndex]!
    const forward = halfEdges.length
    const backward = forward + 1
    halfEdges.push(
      { origin: edge.a, target: edge.b, twin: backward, edgeIndex, next: -1 },
      { origin: edge.b, target: edge.a, twin: forward, edgeIndex, next: -1 },
    )
    outgoing[edge.a]!.push(forward)
    outgoing[edge.b]!.push(backward)
  }
  for (const candidates of outgoing) {
    candidates.sort((left, right) => {
      const leftHalfEdge = halfEdges[left]!
      const rightHalfEdge = halfEdges[right]!
      const leftOrigin = vertices[leftHalfEdge.origin]!.point
      const rightOrigin = vertices[rightHalfEdge.origin]!.point
      const leftTarget = vertices[leftHalfEdge.target]!.point
      const rightTarget = vertices[rightHalfEdge.target]!.point
      const leftAngle = Math.atan2(leftTarget.z - leftOrigin.z, leftTarget.x - leftOrigin.x)
      const rightAngle = Math.atan2(rightTarget.z - rightOrigin.z, rightTarget.x - rightOrigin.x)
      return compareNumbers(leftAngle, rightAngle) || leftHalfEdge.target - rightHalfEdge.target || left - right
    })
  }
  for (let halfEdgeIndex = 0; halfEdgeIndex < halfEdges.length; halfEdgeIndex += 1) {
    const halfEdge = halfEdges[halfEdgeIndex]!
    const candidates = outgoing[halfEdge.target]!
    const twinPosition = candidates.indexOf(halfEdge.twin)
    if (twinPosition < 0) throw new Error('Wall enclosure graph has an invalid twin edge')
    halfEdge.next = candidates[(twinPosition - 1 + candidates.length) % candidates.length]!
  }
  return { halfEdges, outgoing }
}

interface BuiltWallGraph {
  endpointTolerance: number
  areaTolerance: number
  vertices: Vertex[]
  endpointVertexIndexes: number[]
  edges: GraphEdge[]
}

function buildWallGraph(
  walls: readonly WallCenterlineSegment[],
  options: WallEnclosureOptions = {},
): BuiltWallGraph {
  const endpointTolerance = validateOption(options.endpointTolerance, 'endpointTolerance', DEFAULT_ENDPOINT_TOLERANCE)
  const areaTolerance = validateOption(options.areaTolerance, 'areaTolerance', DEFAULT_AREA_TOLERANCE)
  const { vertices, endpointVertexIndexes } = buildVertices(walls, endpointTolerance)
  const edges = buildEdges(walls, vertices, endpointVertexIndexes, endpointTolerance)
  return { endpointTolerance, areaTolerance, vertices, endpointVertexIndexes, edges }
}

function extractBoundedFacesFromGraph(graph: BuiltWallGraph): WallEnclosure[] {
  const { endpointTolerance, areaTolerance, vertices, edges } = graph
  if (edges.length === 0) return []
  const { halfEdges } = buildHalfEdges(edges, vertices)
  const visited = new Set<number>()
  const enclosures: WallEnclosure[] = []
  const simpleEpsilon = Math.max(areaTolerance, endpointTolerance * endpointTolerance)

  for (let start = 0; start < halfEdges.length; start += 1) {
    if (visited.has(start)) continue
    const faceHalfEdges: number[] = []
    let current = start
    let closed = false
    for (let step = 0; step <= halfEdges.length; step += 1) {
      if (visited.has(current)) {
        closed = current === start
        break
      }
      visited.add(current)
      faceHalfEdges.push(current)
      current = halfEdges[current]!.next
    }
    if (!closed || faceHalfEdges.length < 3) continue
    const polygon = faceHalfEdges.map((halfEdgeIndex) => vertices[halfEdges[halfEdgeIndex]!.origin]!.point)
    if (signedArea(polygon) <= areaTolerance || !isSimplePolygon(polygon, simpleEpsilon)) continue
    const canonicalPolygon = canonicalizePolygon(polygon)
    const wallIds = [...new Set(faceHalfEdges.map((halfEdgeIndex) => edges[halfEdges[halfEdgeIndex]!.edgeIndex]!.wallIds).flat())]
      .sort((left, right) => left.localeCompare(right))
    enclosures.push({ key: polygonKey(canonicalPolygon), polygon: canonicalPolygon, area: signedArea(canonicalPolygon), wallIds })
  }

  return enclosures.sort((left, right) => left.key.localeCompare(right.key) || left.wallIds.join('|').localeCompare(right.wallIds.join('|')))
}

/**
 * Extract bounded faces from a planar wall graph. Endpoints that land on another
 * wall are used to split that wall; strict interior-to-interior crossings are not.
 */
export function extractBoundedFaces(
  walls: readonly WallCenterlineSegment[],
  options: WallEnclosureOptions = {},
): WallEnclosure[] {
  return extractBoundedFacesFromGraph(buildWallGraph(walls, options))
}

/**
 * Integration-facing form of bounded-face extraction. Diagnostics are warnings
 * about input graph data that was coalesced or could not form a bounded room.
 */
export function extractWallEnclosures(
  walls: readonly WallCenterlineSegment[],
  options: WallEnclosureOptions = {},
): WallEnclosureResult {
  const graph = buildWallGraph(walls, options)
  const diagnostics: WallEnclosureDiagnostic[] = []
  const crossingWallIds = new Set<string>()
  for (let first = 0; first < walls.length; first += 1) {
    for (let second = first + 1; second < walls.length; second += 1) {
      const left = walls[first]!
      const right = walls[second]!
      if (!segmentsCrossInTheirInteriors(left.start, left.end, right.start, right.end, graph.endpointTolerance)) continue
      crossingWallIds.add(left.id)
      crossingWallIds.add(right.id)
    }
  }
  if (crossingWallIds.size > 0) {
    diagnostics.push({
      code: 'NON_ENDPOINT_INTERSECTION',
      wallIds: [...crossingWallIds].sort((left, right) => left.localeCompare(right)),
    })
  }

  const rooms = crossingWallIds.size > 0 ? [] : extractBoundedFacesFromGraph(graph)
  const { endpointVertexIndexes, edges } = graph
  const duplicateWallIds = edges
    .filter((edge) => edge.wallIds.length > 1)
    .flatMap((edge) => edge.wallIds)
    .sort((left, right) => left.localeCompare(right))
  if (duplicateWallIds.length > 0) {
    diagnostics.push({ code: 'DUPLICATE_EDGE', wallIds: duplicateWallIds })
  }

  const degenerateWallIds = walls
    .filter((_, wallIndex) => endpointVertexIndexes[wallIndex * 2] === endpointVertexIndexes[wallIndex * 2 + 1])
    .map((wall) => wall.id)
    .sort((left, right) => left.localeCompare(right))
  if (degenerateWallIds.length > 0) {
    diagnostics.push({ code: 'DEGENERATE_EDGE', wallIds: degenerateWallIds })
  }
  if (rooms.length === 0 && walls.length > 0 && crossingWallIds.size === 0) {
    diagnostics.push({
      code: 'NO_BOUNDED_FACE',
      wallIds: [...new Set(walls.map((wall) => wall.id))].sort((left, right) => left.localeCompare(right)),
    })
  }
  return { rooms, diagnostics }
}
