import type { Confidence, RenderType, Vec2, Vec3 } from '../domain/contract'

export type SemanticTriangleRenderType = Extract<RenderType, 'WALL' | 'DOOR' | 'WINDOW'>

/** A renderer-independent triangle in world coordinates. */
export interface SemanticTriangle {
  id: string
  renderType: SemanticTriangleRenderType
  a: Vec3
  b: Vec3
  c: Vec3
}

export interface WallVerticalOverlap {
  minY?: number
  maxY?: number
  min?: number
  max?: number
}

export interface SemanticSpaceDetectionOptions {
  /** World units represented by one raster cell. */
  cellSize: number
  /** A triangle participates when it intersects any selected horizontal slice. */
  sliceHeights?: readonly number[]
  /** If supplied, only triangles overlapping this vertical interval participate. */
  wallVerticalOverlap?: WallVerticalOverlap
  /** Morphological closing radius, in cells, applied to WALL occupancy. */
  gapClosing?: number
  /** World-unit expansion applied to projected DOOR footprints. */
  doorPadding?: number
  /** Regions smaller than this world area are omitted. */
  minArea?: number
  /** Maximum point-to-segment deviation allowed during contour simplification. */
  contourSimplifyTolerance?: number
  /** Hard upper bound on allocated raster cells. */
  maxCells?: number
  /** Hard upper bound on estimated raster, morphology, region, and source-association work. */
  maxOperations?: number
}

export interface SemanticSpaceCandidateStats {
  cellCount: number
  occupiedCellCount: number
  regionCellCount: number
  contourVertexCount: number
  sourceIds: string[]
  wallSourceIds: string[]
  doorSourceIds: string[]
  windowSourceIds: string[]
}

export interface SemanticSpaceCandidate {
  id: string
  polygon: Vec2[]
  area: number
  confidence: Confidence
  reasons: string[]
  stats: SemanticSpaceCandidateStats
}

export interface SemanticSpaceDetectionStats {
  cellSize: number
  origin: Vec2 | null
  dimensions: { x: number; z: number }
  cellCount: number
  occupiedCellCount: number
  exteriorCellCount: number
  interiorCellCount: number
  discardedRegionCount: number
  multiContourRegionCount: number
  maxCellsExceeded: boolean
  estimatedRasterOperations: number
  estimatedMorphologyOperations: number
  estimatedRegionOperations: number
  estimatedContourValidationOperations: number
  estimatedSourceAssociationOperations: number
  maxOperationsExceeded: boolean
}

export interface SemanticSpaceDetectionResult {
  candidates: SemanticSpaceCandidate[]
  reasons: string[]
  stats: SemanticSpaceDetectionStats
}

const EPSILON = 1e-9
const DEFAULT_OPTIONS: Required<Pick<SemanticSpaceDetectionOptions, 'cellSize' | 'gapClosing' | 'doorPadding' | 'minArea' | 'contourSimplifyTolerance' | 'maxCells' | 'maxOperations'>> = {
  cellSize: 0.25,
  gapClosing: 0,
  doorPadding: 0,
  minArea: 0.01,
  contourSimplifyTolerance: 0,
  maxCells: 2_000_000,
  maxOperations: 60_000_000,
}

interface ProjectedTriangle {
  source: SemanticTriangle
  points: Vec2[]
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

interface Grid {
  width: number
  height: number
  origin: Vec2
  cellSize: number
  occupied: Uint8Array
}

interface Region {
  cellCount: number
  polygon: Vec2[]
  area: number
  contourCount: number
  bounds: RegionBounds
}

interface RegionBounds {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value)
}

function normalizeNonNegative(value: number | undefined, fallback: number): number {
  return value === undefined || !isFiniteNumber(value) ? fallback : Math.max(0, value)
}

function triangleVerticalRange(triangle: SemanticTriangle): [number, number] {
  return [Math.min(triangle.a.y, triangle.b.y, triangle.c.y), Math.max(triangle.a.y, triangle.b.y, triangle.c.y)]
}

function intersectsSelectedHeight(triangle: SemanticTriangle, options: SemanticSpaceDetectionOptions): boolean {
  const [minY, maxY] = triangleVerticalRange(triangle)
  const slices = options.sliceHeights
  if (slices && slices.length > 0 && !slices.some((height) => height >= minY - EPSILON && height <= maxY + EPSILON)) {
    return false
  }

  const overlap = options.wallVerticalOverlap
  if (!overlap) return true
  const requestedMin = overlap.minY ?? overlap.min ?? -Infinity
  const requestedMax = overlap.maxY ?? overlap.max ?? Infinity
  return maxY >= requestedMin - EPSILON && minY <= requestedMax + EPSILON
}

function projectTriangle(triangle: SemanticTriangle): ProjectedTriangle {
  const points = [
    { x: triangle.a.x, z: triangle.a.z },
    { x: triangle.b.x, z: triangle.b.z },
    { x: triangle.c.x, z: triangle.c.z },
  ]
  return {
    source: triangle,
    points,
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minZ: Math.min(...points.map((point) => point.z)),
    maxZ: Math.max(...points.map((point) => point.z)),
  }
}

function cross(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
}

function pointInTriangle(point: Vec2, triangle: readonly Vec2[]): boolean {
  const first = cross(triangle[0]!, triangle[1]!, point)
  const second = cross(triangle[1]!, triangle[2]!, point)
  const third = cross(triangle[2]!, triangle[0]!, point)
  return (first >= -EPSILON && second >= -EPSILON && third >= -EPSILON) || (first <= EPSILON && second <= EPSILON && third <= EPSILON)
}

function pointInRect(point: Vec2, minX: number, maxX: number, minZ: number, maxZ: number): boolean {
  return point.x >= minX - EPSILON && point.x <= maxX + EPSILON && point.z >= minZ - EPSILON && point.z <= maxZ + EPSILON
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const first = cross(a, b, c)
  const second = cross(a, b, d)
  const third = cross(c, d, a)
  const fourth = cross(c, d, b)
  if (((first > EPSILON && second < -EPSILON) || (first < -EPSILON && second > EPSILON)) && ((third > EPSILON && fourth < -EPSILON) || (third < -EPSILON && fourth > EPSILON))) {
    return true
  }
  const onSegment = (start: Vec2, end: Vec2, point: Vec2) =>
    Math.abs(cross(start, end, point)) <= EPSILON &&
    point.x >= Math.min(start.x, end.x) - EPSILON && point.x <= Math.max(start.x, end.x) + EPSILON &&
    point.z >= Math.min(start.z, end.z) - EPSILON && point.z <= Math.max(start.z, end.z) + EPSILON
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b)
}

function triangleIntersectsCell(triangle: readonly Vec2[], minX: number, maxX: number, minZ: number, maxZ: number): boolean {
  if (triangle.some((point) => pointInRect(point, minX, maxX, minZ, maxZ))) return true
  const corners = [{ x: minX, z: minZ }, { x: maxX, z: minZ }, { x: maxX, z: maxZ }, { x: minX, z: maxZ }]
  if (Math.abs(cross(triangle[0]!, triangle[1]!, triangle[2]!)) <= EPSILON) {
    const rectEdges: [Vec2, Vec2][] = [[corners[0]!, corners[1]!], [corners[1]!, corners[2]!], [corners[2]!, corners[3]!], [corners[3]!, corners[0]!]]
    for (let index = 0; index < triangle.length; index += 1) {
      const edge: [Vec2, Vec2] = [triangle[index]!, triangle[(index + 1) % triangle.length]!]
      if (rectEdges.some(([start, end]) => segmentsIntersect(edge[0], edge[1], start, end))) return true
    }
    return false
  }
  if (corners.some((point) => pointInTriangle(point, triangle))) return true
  const rectEdges: [Vec2, Vec2][] = [[corners[0]!, corners[1]!], [corners[1]!, corners[2]!], [corners[2]!, corners[3]!], [corners[3]!, corners[0]!]]
  for (let index = 0; index < triangle.length; index += 1) {
    const edge: [Vec2, Vec2] = [triangle[index]!, triangle[(index + 1) % triangle.length]!]
    if (rectEdges.some(([start, end]) => segmentsIntersect(edge[0], edge[1], start, end))) return true
  }
  return false
}

function expandedBounds(triangle: ProjectedTriangle, padding: number): [number, number, number, number] {
  return [triangle.minX - padding, triangle.maxX + padding, triangle.minZ - padding, triangle.maxZ + padding]
}

function cellIndex(x: number, z: number, width: number): number {
  return z * width + x
}

function eachNeighbor(x: number, z: number, width: number, height: number, callback: (nx: number, nz: number) => void): void {
  if (x > 0) callback(x - 1, z)
  if (x + 1 < width) callback(x + 1, z)
  if (z > 0) callback(x, z - 1)
  if (z + 1 < height) callback(x, z + 1)
}

function applyGapClosing(grid: Grid, radius: number): void {
  if (radius <= 0) return
  const dilated = new Uint8Array(grid.occupied.length)
  for (let z = 0; z < grid.height; z += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      let value = false
      for (let dz = -radius; dz <= radius && !value; dz += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx
          const nz = z + dz
          if (nx >= 0 && nx < grid.width && nz >= 0 && nz < grid.height && grid.occupied[cellIndex(nx, nz, grid.width)]) {
            value = true
            break
          }
        }
      }
      dilated[cellIndex(x, z, grid.width)] = value ? 1 : 0
    }
  }
  const closed = new Uint8Array(grid.occupied.length)
  for (let z = 0; z < grid.height; z += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      let value = true
      for (let dz = -radius; dz <= radius && value; dz += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx
          const nz = z + dz
          if (nx < 0 || nx >= grid.width || nz < 0 || nz >= grid.height || !dilated[cellIndex(nx, nz, grid.width)]) {
            value = false
            break
          }
        }
      }
      closed[cellIndex(x, z, grid.width)] = value ? 1 : 0
    }
  }
  grid.occupied = closed
}

function floodExterior(grid: Grid): { exterior: Uint8Array; exteriorCount: number } {
  const exterior = new Uint8Array(grid.occupied.length)
  const queue = new Int32Array(grid.occupied.length)
  let head = 0
  let tail = 0
  const enqueue = (x: number, z: number) => {
    const index = cellIndex(x, z, grid.width)
    if (grid.occupied[index] || exterior[index]) return
    exterior[index] = 1
    queue[tail] = index
    tail += 1
  }
  for (let x = 0; x < grid.width; x += 1) {
    enqueue(x, 0)
    enqueue(x, grid.height - 1)
  }
  for (let z = 1; z + 1 < grid.height; z += 1) {
    enqueue(0, z)
    enqueue(grid.width - 1, z)
  }
  while (head < tail) {
    const index = queue[head]!
    head += 1
    const x = index % grid.width
    const z = Math.floor(index / grid.width)
    eachNeighbor(x, z, grid.width, grid.height, enqueue)
  }
  return { exterior, exteriorCount: tail }
}

function polygonArea(polygon: readonly Vec2[]): number {
  let area = 0
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]!
    const next = polygon[(index + 1) % polygon.length]!
    area += current.x * next.z - next.x * current.z
  }
  return area / 2
}

function pointSegmentDistance(point: Vec2, start: Vec2, end: Vec2): number {
  const dx = end.x - start.x
  const dz = end.z - start.z
  const lengthSquared = dx * dx + dz * dz
  if (lengthSquared <= EPSILON) return Math.hypot(point.x - start.x, point.z - start.z)
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared))
  return Math.hypot(point.x - (start.x + t * dx), point.z - (start.z + t * dz))
}

function properSegmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const ab = cross(a, b, c)
  const ad = cross(a, b, d)
  const cd = cross(c, d, a)
  const cb = cross(c, d, b)
  return ((ab > EPSILON && ad < -EPSILON) || (ab < -EPSILON && ad > EPSILON)) && ((cd > EPSILON && cb < -EPSILON) || (cd < -EPSILON && cb > EPSILON))
}

interface ContourValidationBudget {
  limit: number
  used: number
  exceeded: boolean
}

function chargeContourValidation(budget: ContourValidationBudget, amount = 1): boolean {
  budget.used += amount
  if (budget.used <= budget.limit) return true
  budget.exceeded = true
  return false
}

function isSelfIntersecting(polygon: readonly Vec2[], budget: ContourValidationBudget): boolean {
  for (let first = 0; first < polygon.length; first += 1) {
    const firstNext = (first + 1) % polygon.length
    for (let second = first + 1; second < polygon.length; second += 1) {
      const secondNext = (second + 1) % polygon.length
      if (first === second || firstNext === second || secondNext === first || (first === 0 && secondNext === 0)) continue
      if (!chargeContourValidation(budget)) return true
      if (properSegmentsIntersect(polygon[first]!, polygon[firstNext]!, polygon[second]!, polygon[secondNext]!)) return true
    }
  }
  return false
}

interface SimplificationBudget {
  remaining: number
}

function simplifyOpenChain(points: readonly Vec2[], tolerance: number, budget: SimplificationBudget): Vec2[] | null {
  if (points.length <= 2) return points.map((point) => ({ ...point }))
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: Array<[number, number]> = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [startIndex, endIndex] = stack.pop()!
    let farthestIndex = -1
    let farthestDistance = tolerance
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      if (budget.remaining <= 0) return null
      budget.remaining -= 1
      const distance = pointSegmentDistance(points[index]!, points[startIndex]!, points[endIndex]!)
      if (distance > farthestDistance + EPSILON) {
        farthestDistance = distance
        farthestIndex = index
      }
    }
    if (farthestIndex >= 0) {
      keep[farthestIndex] = 1
      stack.push([farthestIndex, endIndex], [startIndex, farthestIndex])
    }
  }
  return points.filter((_, index) => keep[index]).map((point) => ({ ...point }))
}

function ringChain(polygon: readonly Vec2[], start: number, end: number): Vec2[] {
  const chain: Vec2[] = []
  for (let index = start; ; index = (index + 1) % polygon.length) {
    chain.push(polygon[index]!)
    if (index === end) return chain
  }
}

function removeCollinearVertices(polygon: readonly Vec2[]): Vec2[] {
  if (polygon.length <= 3) return polygon.map((point) => ({ ...point }))
  const result = polygon.filter((point, index) => Math.abs(cross(polygon[(index + polygon.length - 1) % polygon.length]!, point, polygon[(index + 1) % polygon.length]!)) > EPSILON)
  return result.length >= 3 ? result.map((point) => ({ ...point })) : polygon.map((point) => ({ ...point }))
}

function simplifyClosedRingUnchecked(polygon: Vec2[], tolerance: number, budget: SimplificationBudget, validationBudget: ContourValidationBudget): Vec2[] | null {
  if (polygon.length <= 3) return polygon
  let anchorIndex = 0
  for (let index = 1; index < polygon.length; index += 1) {
    if (comparePoints(polygon[index]!, polygon[anchorIndex]!) < 0) anchorIndex = index
  }
  const anchor = polygon[anchorIndex]!
  let oppositeIndex = (anchorIndex + 1) % polygon.length
  let oppositeDistance = -Infinity
  for (let index = 0; index < polygon.length; index += 1) {
    if (index === anchorIndex) continue
    const point = polygon[index]!
    const distance = (point.x - anchor.x) ** 2 + (point.z - anchor.z) ** 2
    if (distance > oppositeDistance + EPSILON) {
      oppositeDistance = distance
      oppositeIndex = index
    }
  }
  const forward = simplifyOpenChain(ringChain(polygon, anchorIndex, oppositeIndex), tolerance, budget)
  if (!forward) return null
  const backward = simplifyOpenChain(ringChain(polygon, oppositeIndex, anchorIndex), tolerance, budget)
  if (!backward) return null
  const result = [...forward.slice(0, -1), ...backward.slice(0, -1)]
  if (result.length < 3 || Math.abs(polygonArea(result)) <= EPSILON || isSelfIntersecting(result, validationBudget)) return polygon
  return result
}

function segmentInteriorStaysInRegion(start: Vec2, end: Vec2, grid: Grid, members: ReadonlySet<number>): boolean {
  const dx = end.x - start.x
  const dz = end.z - start.z
  const length = Math.hypot(dx, dz)
  if (length <= EPSILON) return true
  const sampleCount = Math.max(1, Math.ceil(length / grid.cellSize))
  const inwardX = (-dz / length) * grid.cellSize * 0.25
  const inwardZ = (dx / length) * grid.cellSize * 0.25
  for (let index = 0; index < sampleCount; index += 1) {
    const t = (index + 0.5) / sampleCount
    const x = Math.floor((start.x + dx * t + inwardX - grid.origin.x) / grid.cellSize)
    const z = Math.floor((start.z + dz * t + inwardZ - grid.origin.z) / grid.cellSize)
    if (x < 0 || x >= grid.width || z < 0 || z >= grid.height || !members.has(cellIndex(x, z, grid.width))) return false
  }
  return true
}

function simplifiedContourStaysInRegion(polygon: readonly Vec2[], grid: Grid, members: ReadonlySet<number>): boolean {
  for (let index = 0; index < polygon.length; index += 1) {
    if (!segmentInteriorStaysInRegion(polygon[index]!, polygon[(index + 1) % polygon.length]!, grid, members)) return false
  }
  return true
}

function simplifyContour(polygon: Vec2[], tolerance: number, grid: Grid, members: ReadonlySet<number>, validationBudget: ContourValidationBudget): Vec2[] {
  const simplified = simplifyClosedRingUnchecked(polygon, tolerance, { remaining: Math.max(1, members.size * 4) }, validationBudget) ?? removeCollinearVertices(polygon)
  if (simplifiedContourStaysInRegion(simplified, grid, members)) return simplified
  const collinearOnly = removeCollinearVertices(polygon)
  return simplifiedContourStaysInRegion(collinearOnly, grid, members) ? collinearOnly : polygon
}

function comparePoints(left: Vec2, right: Vec2): number {
  return left.x - right.x || left.z - right.z
}

function canonicalizeContour(contour: Vec2[]): Vec2[] {
  let result = contour.slice()
  if (polygonArea(result) < 0) result = result.reverse()
  let bestIndex = 0
  for (let index = 1; index < result.length; index += 1) {
    if (comparePoints(result[index]!, result[bestIndex]!) < 0) bestIndex = index
  }
  return result.slice(bestIndex).concat(result.slice(0, bestIndex))
}

interface BoundaryEdge {
  start: Vec2
  end: Vec2
  startKey: string
  endKey: string
}

function pointKey(point: Vec2): string {
  const quantize = (value: number) => Math.round(value / 1e-8) * 1e-8
  return `${quantize(point.x)},${quantize(point.z)}`
}

function traceRegionContours(cells: readonly number[], grid: Grid, members: ReadonlySet<number>): Vec2[][] {
  const hasCell = (x: number, z: number): boolean => x >= 0 && x < grid.width && z >= 0 && z < grid.height && members.has(cellIndex(x, z, grid.width))
  const edges = new Map<string, BoundaryEdge>()
  const addEdge = (start: Vec2, end: Vec2) => {
    const edge: BoundaryEdge = { start, end, startKey: pointKey(start), endKey: pointKey(end) }
    const reverse = `${edge.endKey}>${edge.startKey}`
    const key = `${edge.startKey}>${edge.endKey}`
    if (edges.has(reverse)) edges.delete(reverse)
    else edges.set(key, edge)
  }
  for (const index of cells) {
    const x = index % grid.width
    const z = Math.floor(index / grid.width)
    const x0 = grid.origin.x + x * grid.cellSize
    const x1 = x0 + grid.cellSize
    const z0 = grid.origin.z + z * grid.cellSize
    const z1 = z0 + grid.cellSize
    if (!hasCell(x, z - 1)) addEdge({ x: x0, z: z0 }, { x: x1, z: z0 })
    if (!hasCell(x + 1, z)) addEdge({ x: x1, z: z0 }, { x: x1, z: z1 })
    if (!hasCell(x, z + 1)) addEdge({ x: x1, z: z1 }, { x: x0, z: z1 })
    if (!hasCell(x - 1, z)) addEdge({ x: x0, z: z1 }, { x: x0, z: z0 })
  }
  if (edges.size === 0) return []
  const outgoing = new Map<string, BoundaryEdge[]>()
  for (const edge of edges.values()) {
    const list = outgoing.get(edge.startKey) ?? []
    list.push(edge)
    outgoing.set(edge.startKey, list)
  }
  for (const list of outgoing.values()) list.sort((left, right) => comparePoints(left.end, right.end))

  const unused = new Set(edges.keys())
  const orderedEdgeKeys = [...unused].sort()
  let orderedEdgeIndex = 0
  const contours: Vec2[][] = []
  while (unused.size > 0) {
    while (orderedEdgeIndex < orderedEdgeKeys.length && !unused.has(orderedEdgeKeys[orderedEdgeIndex]!)) orderedEdgeIndex += 1
    const firstKey = orderedEdgeKeys[orderedEdgeIndex]
    if (!firstKey) break
    const first = edges.get(firstKey)!
    const contour: Vec2[] = [first.start]
    let current = first
    unused.delete(`${current.startKey}>${current.endKey}`)
    while (current.endKey !== first.startKey) {
      const next = (outgoing.get(current.endKey) ?? []).find((edge) => unused.has(`${edge.startKey}>${edge.endKey}`))
      if (!next) break
      contour.push(next.start)
      unused.delete(`${next.startKey}>${next.endKey}`)
      current = next
    }
    if (current.endKey === first.startKey && contour.length >= 3) contours.push(contour)
  }
  const canonical = contours.map(canonicalizeContour)
  canonical.sort((left, right) => Math.abs(polygonArea(right)) - Math.abs(polygonArea(left)) || pointKey(left[0]!).localeCompare(pointKey(right[0]!)))
  return canonical
}

function collectRegionSources(regionBounds: RegionBounds, grid: Grid, triangles: readonly ProjectedTriangle[]) {
  const ids = new Set<string>()
  const wallIds = new Set<string>()
  const doorIds = new Set<string>()
  const windowIds = new Set<string>()
  for (const triangle of triangles) {
    const [minX, maxX, minZ, maxZ] = expandedBounds(triangle, triangle.source.renderType === 'DOOR' ? grid.cellSize * 2 : grid.cellSize)
    const contributes = minX <= regionBounds.maxX + EPSILON && maxX >= regionBounds.minX - EPSILON && minZ <= regionBounds.maxZ + EPSILON && maxZ >= regionBounds.minZ - EPSILON
    if (contributes) {
      ids.add(triangle.source.id)
      if (triangle.source.renderType === 'WALL') wallIds.add(triangle.source.id)
      else if (triangle.source.renderType === 'DOOR') doorIds.add(triangle.source.id)
      else windowIds.add(triangle.source.id)
    }
  }
  return { sourceIds: [...ids].sort(), wallSourceIds: [...wallIds].sort(), doorSourceIds: [...doorIds].sort(), windowSourceIds: [...windowIds].sort() }
}

function validateOptions(options: SemanticSpaceDetectionOptions): Required<Pick<SemanticSpaceDetectionOptions, 'cellSize' | 'gapClosing' | 'doorPadding' | 'minArea' | 'contourSimplifyTolerance' | 'maxCells' | 'maxOperations'>> {
  const cellSize = options.cellSize ?? DEFAULT_OPTIONS.cellSize
  if (!isFiniteNumber(cellSize) || cellSize <= 0) throw new Error('cellSize must be a finite number greater than zero')
  const maxCells = options.maxCells ?? DEFAULT_OPTIONS.maxCells
  if (!Number.isInteger(maxCells) || maxCells <= 0) throw new Error('maxCells must be a positive integer')
  const maxOperations = options.maxOperations ?? DEFAULT_OPTIONS.maxOperations
  if (!Number.isInteger(maxOperations) || maxOperations <= 0) throw new Error('maxOperations must be a positive integer')
  return {
    cellSize,
    gapClosing: Math.floor(normalizeNonNegative(options.gapClosing, DEFAULT_OPTIONS.gapClosing)),
    doorPadding: normalizeNonNegative(options.doorPadding, DEFAULT_OPTIONS.doorPadding),
    minArea: normalizeNonNegative(options.minArea, DEFAULT_OPTIONS.minArea),
    contourSimplifyTolerance: normalizeNonNegative(options.contourSimplifyTolerance, DEFAULT_OPTIONS.contourSimplifyTolerance),
    maxCells,
    maxOperations,
  }
}

/** Rasterize semantic WALL/DOOR triangles and return deterministic enclosed-space candidates. */
export function detectSemanticSpaces(triangles: readonly SemanticTriangle[], options: SemanticSpaceDetectionOptions): SemanticSpaceDetectionResult {
  const normalized = validateOptions(options)
  const active = triangles
    .filter((triangle) => (triangle.renderType === 'WALL' || triangle.renderType === 'DOOR' || triangle.renderType === 'WINDOW') && intersectsSelectedHeight(triangle, options))
    .map(projectTriangle)
    .sort((left, right) => left.source.id.localeCompare(right.source.id) || left.source.renderType.localeCompare(right.source.renderType))
  const emptyStats: SemanticSpaceDetectionStats = {
    cellSize: normalized.cellSize,
    origin: null,
    dimensions: { x: 0, z: 0 },
    cellCount: 0,
    occupiedCellCount: 0,
    exteriorCellCount: 0,
    interiorCellCount: 0,
    discardedRegionCount: 0,
    multiContourRegionCount: 0,
    maxCellsExceeded: false,
    estimatedRasterOperations: 0,
    estimatedMorphologyOperations: 0,
    estimatedRegionOperations: 0,
    estimatedContourValidationOperations: 0,
    estimatedSourceAssociationOperations: 0,
    maxOperationsExceeded: false,
  }
  if (active.length === 0) return { candidates: [], reasons: ['no-active-triangles'], stats: emptyStats }

  const padding = Math.max(normalized.doorPadding, normalized.cellSize)
  const minX = Math.min(...active.map((triangle) => triangle.minX)) - padding
  const maxX = Math.max(...active.map((triangle) => triangle.maxX)) + padding
  const minZ = Math.min(...active.map((triangle) => triangle.minZ)) - padding
  const maxZ = Math.max(...active.map((triangle) => triangle.maxZ)) + padding
  const margin = Math.max(2, normalized.gapClosing + 1)
  const origin = {
    x: Math.floor(minX / normalized.cellSize) * normalized.cellSize - margin * normalized.cellSize,
    z: Math.floor(minZ / normalized.cellSize) * normalized.cellSize - margin * normalized.cellSize,
  }
  const width = Math.max(1, Math.ceil((maxX - origin.x) / normalized.cellSize) + margin)
  const height = Math.max(1, Math.ceil((maxZ - origin.z) / normalized.cellSize) + margin)
  const cellCount = width * height
  const estimatedRasterOperations = active.reduce((sum, triangle) => {
    const sourcePadding = triangle.source.renderType === 'DOOR' ? normalized.doorPadding : 0
    const lowX = Math.max(0, Math.floor((triangle.minX - sourcePadding - origin.x) / normalized.cellSize))
    const highX = Math.min(width - 1, Math.ceil((triangle.maxX + sourcePadding - origin.x) / normalized.cellSize))
    const lowZ = Math.max(0, Math.floor((triangle.minZ - sourcePadding - origin.z) / normalized.cellSize))
    const highZ = Math.min(height - 1, Math.ceil((triangle.maxZ + sourcePadding - origin.z) / normalized.cellSize))
    return sum + Math.max(0, highX - lowX + 1) * Math.max(0, highZ - lowZ + 1)
  }, 0)
  const morphologyDiameter = normalized.gapClosing * 2 + 1
  const estimatedMorphologyOperations = normalized.gapClosing > 0 ? cellCount * morphologyDiameter * morphologyDiameter * 2 : 0
  // Pre-reserve all flood, boundary-edge, deterministic worklist, and contour-validation work.
  // A cell contributes at most four boundary edges and four inward containment samples.
  const estimatedRegionOperations = cellCount * 14
  const estimatedContourValidationOperations = 0
  const estimatedSourceAssociationOperations = 0
  const maxOperationsExceeded = estimatedRasterOperations + estimatedMorphologyOperations + estimatedRegionOperations > normalized.maxOperations
  const baseStats = { cellSize: normalized.cellSize, origin, dimensions: { x: width, z: height }, cellCount, occupiedCellCount: 0, exteriorCellCount: 0, interiorCellCount: 0, discardedRegionCount: 0, multiContourRegionCount: 0, maxCellsExceeded: cellCount > normalized.maxCells, estimatedRasterOperations, estimatedMorphologyOperations, estimatedRegionOperations, estimatedContourValidationOperations, estimatedSourceAssociationOperations, maxOperationsExceeded }
  if (cellCount > normalized.maxCells) return { candidates: [], reasons: ['max-cells-exceeded'], stats: baseStats }
  if (maxOperationsExceeded) return { candidates: [], reasons: ['max-operations-exceeded'], stats: baseStats }
  const contourValidationBudget: ContourValidationBudget = {
    limit: normalized.maxOperations - estimatedRasterOperations - estimatedMorphologyOperations - estimatedRegionOperations,
    used: 0,
    exceeded: false,
  }

  const grid: Grid = { width, height, origin, cellSize: normalized.cellSize, occupied: new Uint8Array(cellCount) }
  for (const triangle of active) {
    const trianglePoints = triangle.source.renderType === 'DOOR' && normalized.doorPadding > 0
      ? [{ x: triangle.minX - normalized.doorPadding, z: triangle.minZ - normalized.doorPadding }, { x: triangle.maxX + normalized.doorPadding, z: triangle.minZ - normalized.doorPadding }, { x: triangle.maxX + normalized.doorPadding, z: triangle.maxZ + normalized.doorPadding }, { x: triangle.minX - normalized.doorPadding, z: triangle.maxZ + normalized.doorPadding }]
      : triangle.points
    const lowX = Math.max(0, Math.floor((triangle.minX - (triangle.source.renderType === 'DOOR' ? normalized.doorPadding : 0) - origin.x) / normalized.cellSize))
    const highX = Math.min(width - 1, Math.ceil((triangle.maxX + (triangle.source.renderType === 'DOOR' ? normalized.doorPadding : 0) - origin.x) / normalized.cellSize))
    const lowZ = Math.max(0, Math.floor((triangle.minZ - (triangle.source.renderType === 'DOOR' ? normalized.doorPadding : 0) - origin.z) / normalized.cellSize))
    const highZ = Math.min(height - 1, Math.ceil((triangle.maxZ + (triangle.source.renderType === 'DOOR' ? normalized.doorPadding : 0) - origin.z) / normalized.cellSize))
    for (let z = lowZ; z <= highZ; z += 1) {
      for (let x = lowX; x <= highX; x += 1) {
        const cellMinX = origin.x + x * normalized.cellSize
        const cellMinZ = origin.z + z * normalized.cellSize
        if (triangleIntersectsCell(trianglePoints, cellMinX, cellMinX + normalized.cellSize, cellMinZ, cellMinZ + normalized.cellSize)) grid.occupied[cellIndex(x, z, width)] = 1
      }
    }
  }
  applyGapClosing(grid, normalized.gapClosing)
  const occupiedCellCount = grid.occupied.reduce((sum, value) => sum + (value ? 1 : 0), 0)
  const { exterior, exteriorCount } = floodExterior(grid)
  const visited = new Uint8Array(cellCount)
  const regions: Region[] = []
  for (let index = 0; index < cellCount; index += 1) {
    if (grid.occupied[index] || exterior[index] || visited[index]) continue
    const cells = [index]
    let minCellX = index % width
    let maxCellX = minCellX
    let minCellZ = Math.floor(index / width)
    let maxCellZ = minCellZ
    visited[index] = 1
    for (let head = 0; head < cells.length; head += 1) {
      const current = cells[head]!
      const x = current % width
      const z = Math.floor(current / width)
      eachNeighbor(x, z, width, height, (nx, nz) => {
        const next = cellIndex(nx, nz, width)
        if (!grid.occupied[next] && !exterior[next] && !visited[next]) {
          visited[next] = 1
          cells.push(next)
          minCellX = Math.min(minCellX, nx)
          maxCellX = Math.max(maxCellX, nx)
          minCellZ = Math.min(minCellZ, nz)
          maxCellZ = Math.max(maxCellZ, nz)
        }
      })
    }
    const members = new Set(cells)
    const contours = traceRegionContours(cells, grid, members)
    const contour = contours.length === 1
      ? canonicalizeContour(simplifyContour(contours[0]!, normalized.contourSimplifyTolerance, grid, members, contourValidationBudget))
      : contours[0] ?? []
    const area = Math.abs(polygonArea(contour))
    regions.push({
      cellCount: cells.length,
      polygon: contour,
      area,
      contourCount: contours.length,
      bounds: {
        minX: origin.x + minCellX * normalized.cellSize,
        maxX: origin.x + (maxCellX + 1) * normalized.cellSize,
        minZ: origin.z + minCellZ * normalized.cellSize,
        maxZ: origin.z + (maxCellZ + 1) * normalized.cellSize,
      },
    })
    if (contourValidationBudget.exceeded) break
  }
  if (contourValidationBudget.exceeded) {
    return {
      candidates: [],
      reasons: ['max-operations-exceeded'],
      stats: {
        ...baseStats,
        occupiedCellCount,
        exteriorCellCount: exteriorCount,
        interiorCellCount: regions.reduce((sum, region) => sum + region.cellCount, 0),
        discardedRegionCount: regions.length,
        multiContourRegionCount: regions.filter((region) => region.contourCount > 1).length,
        estimatedContourValidationOperations: contourValidationBudget.used,
        maxOperationsExceeded: true,
      },
    }
  }
  regions.sort((left, right) => right.area - left.area || pointKey(left.polygon[0] ?? { x: 0, z: 0 }).localeCompare(pointKey(right.polygon[0] ?? { x: 0, z: 0 })))
  const multiContourRegionCount = regions.filter((region) => region.contourCount > 1).length
  const validRegions: Region[] = []
  for (const region of regions) {
    if (region.contourCount !== 1 || region.polygon.length < 3 || region.area < normalized.minArea) continue
    if (!isSelfIntersecting(region.polygon, contourValidationBudget)) validRegions.push(region)
    if (contourValidationBudget.exceeded) break
  }
  const discardedRegionCount = regions.length - validRegions.length
  const interiorCellCount = regions.reduce((sum, region) => sum + region.cellCount, 0)
  const totalSourceAssociationOperations = validRegions.length * active.length
  const totalEstimatedOperations = estimatedRasterOperations + estimatedMorphologyOperations + estimatedRegionOperations + contourValidationBudget.used + totalSourceAssociationOperations
  if (contourValidationBudget.exceeded || totalEstimatedOperations > normalized.maxOperations) {
    return {
      candidates: [],
      reasons: ['max-operations-exceeded'],
      stats: {
        ...baseStats,
        occupiedCellCount,
        exteriorCellCount: exteriorCount,
        interiorCellCount,
        discardedRegionCount,
        multiContourRegionCount,
        estimatedContourValidationOperations: contourValidationBudget.used,
        estimatedSourceAssociationOperations: totalSourceAssociationOperations,
        maxOperationsExceeded: true,
      },
    }
  }

  const candidates: SemanticSpaceCandidate[] = []
  for (const region of validRegions) {
    const sourceSets = collectRegionSources(region.bounds, grid, active)
    const candidateIndex = candidates.length + 1
    candidates.push({
      id: `space-candidate-${String(candidateIndex).padStart(3, '0')}`,
      polygon: region.polygon,
      area: region.area,
      confidence: 'inferred-high',
      reasons: ['closed-wall-boundary', ...(sourceSets.doorSourceIds.length > 0 ? ['door-boundary-closed'] : []), ...(sourceSets.windowSourceIds.length > 0 ? ['window-boundary-closed'] : []), ...(normalized.gapClosing > 0 ? ['gap-closing-applied'] : [])],
      stats: {
        cellCount: region.cellCount,
        occupiedCellCount,
        regionCellCount: region.cellCount,
        contourVertexCount: region.polygon.length,
        sourceIds: [...new Set([...sourceSets.sourceIds, ...sourceSets.wallSourceIds, ...sourceSets.doorSourceIds, ...sourceSets.windowSourceIds])].sort(),
        wallSourceIds: sourceSets.wallSourceIds,
        doorSourceIds: sourceSets.doorSourceIds,
        windowSourceIds: sourceSets.windowSourceIds,
      },
    })
  }
  return {
    candidates,
    reasons: [
      ...(candidates.length > 0 ? [] : [regions.length > 0 ? 'interior-regions-rejected' : 'no-interior-regions']),
      ...(multiContourRegionCount > 0 ? ['multi-contour-regions-excluded'] : []),
    ],
    stats: { ...baseStats, occupiedCellCount, exteriorCellCount: exteriorCount, interiorCellCount, discardedRegionCount, multiContourRegionCount, estimatedContourValidationOperations: contourValidationBudget.used, estimatedSourceAssociationOperations: totalSourceAssociationOperations },
  }
}

export const detectSemanticSpaceCandidates = detectSemanticSpaces
