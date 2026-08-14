import type { Confidence, Vec2 } from '../domain/contract'
import {
  decodeExternalGlbGeometry,
  type ExternalGlbGeometryPrimitive,
  type ExternalGlbTriangle,
} from '../integration/external-glb-geometry'
import {
  detectSemanticSpaces,
  type SemanticSpaceCandidate,
  type SemanticSpaceDetectionOptions,
  type SemanticSpaceDetectionResult,
  type SemanticSpaceDetectionStats,
  type SemanticTriangle,
} from './semantic-space-detection'

export type ExternalSpaceInput = ArrayBuffer | Uint8Array | readonly ExternalGlbGeometryPrimitive[]

export type ExistingSpacePolygon = readonly Vec2[] | { polygon: readonly Vec2[] }

export interface ExternalSpaceCandidatesOptions {
  /** World units represented by one raster cell. Defaults to 0.10 m. */
  cellSize?: number
  /** World-unit morphological closing distance. Defaults to 0.10 m. */
  gapClosingDistance?: number
  /** World-unit expansion applied to projected DOOR footprints. Defaults to 0.10 m. */
  doorPadding?: number
  /** Regions smaller than this world area are omitted. Defaults to 2 m². */
  minArea?: number
  /** Contour simplification tolerance in world units; never lower than cellSize. */
  simplifyTolerance?: number
  /** Alias for simplifyTolerance for callers that use the raster-engine name. */
  contourSimplifyTolerance?: number
  /** Hard upper bound on allocated raster cells. Defaults to 2,000,000. */
  maxCells?: number
  /** Total estimated source extraction, detection, and polygon-matching budget shared by both slices. Defaults to 240,000,000. */
  maxOperations?: number
  /** Hard bounds for first-run semantic geometry decoding. */
  maxDecodedNodes?: number
  maxDecodedPrimitives?: number
  maxDecodedTriangles?: number
  maxDecodedPositionElements?: number
  /** Confirmed SPACE polygons, which suppress equivalent inferred candidates. */
  existingSpacePolygons?: readonly ExistingSpacePolygon[]
  /** Alias accepting domain-like SPACE records containing a polygon. */
  existingSpaces?: readonly ExistingSpacePolygon[]
}

export interface ExternalSpaceCandidate extends Omit<SemanticSpaceCandidate, 'confidence'> {
  confidence: Extract<Confidence, 'inferred-high' | 'inferred-low'>
  /** The returned candidate was produced by the upper (62%) slice. */
  slice: 'upper'
  sliceHeight: number
  /** The equivalent middle-slice candidate used for confidence, when present. */
  equivalentMiddleCandidateId?: string
}

export interface ExternalSpaceCandidatesResult {
  /** Upper-slice candidates after existing SPACE exclusion and confidence assignment. */
  candidates: ExternalSpaceCandidate[]
  /** Absolute world heights derived from the semantic WALL vertical extent. */
  sliceHeights: { middle: number; upper: number }
  middleSliceHeight: number
  upperSliceHeight: number
  wallVerticalRange: { min: number; max: number }
  middleStats: SemanticSpaceDetectionStats
  upperStats: SemanticSpaceDetectionStats
  /** Convenience grouping for consumers that keep per-slice results together. */
  stats: { middle: SemanticSpaceDetectionStats; upper: SemanticSpaceDetectionStats }
  excludedExistingSpaceCount: number
  sourceSpaceCount: number
  sourceSpacePolygonCount: number
  matchingStats: {
    estimatedOperations: number
    maxOperations: number
    maxOperationsExceeded: boolean
  }
  sourceSpaceStats: {
    estimatedOperations: number
    maxOperations: number
    maxOperationsExceeded: boolean
  }
  reasons: string[]
}

const DEFAULTS = {
  cellSize: 0.1,
  gapClosingDistance: 0.1,
  doorPadding: 0.1,
  minArea: 2,
  maxCells: 2_000_000,
  maxOperations: 240_000_000,
  maxDecodedNodes: 50_000,
  maxDecodedPrimitives: 20_000,
  maxDecodedTriangles: 1_000_000,
  maxDecodedPositionElements: 2_000_000,
} as const

const EPSILON = 1e-7

function finiteOrDefault(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : value
}

function validateNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite number greater than or equal to zero`)
  return value
}

function normalizeOptions(options: ExternalSpaceCandidatesOptions): {
  cellSize: number
  gapClosingDistance: number
  doorPadding: number
  minArea: number
  contourSimplifyTolerance: number
  gapClosing: number
  maxCells: number
  maxOperations: number
  maxDecodedNodes: number
  maxDecodedPrimitives: number
  maxDecodedTriangles: number
  maxDecodedPositionElements: number
} {
  const cellSize = finiteOrDefault(options.cellSize, DEFAULTS.cellSize)
  if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error('cellSize must be a finite number greater than zero')
  const gapClosingDistance = validateNonNegative(finiteOrDefault(options.gapClosingDistance, DEFAULTS.gapClosingDistance), 'gapClosingDistance')
  const doorPadding = validateNonNegative(finiteOrDefault(options.doorPadding, DEFAULTS.doorPadding), 'doorPadding')
  const minArea = validateNonNegative(finiteOrDefault(options.minArea, DEFAULTS.minArea), 'minArea')
  const requestedTolerance = options.simplifyTolerance ?? options.contourSimplifyTolerance ?? cellSize
  const contourSimplifyTolerance = Math.max(cellSize, validateNonNegative(requestedTolerance, 'simplifyTolerance'))
  const maxCells = options.maxCells ?? DEFAULTS.maxCells
  if (!Number.isInteger(maxCells) || maxCells <= 0) throw new Error('maxCells must be a positive integer')
  const maxOperations = options.maxOperations ?? DEFAULTS.maxOperations
  if (!Number.isInteger(maxOperations) || maxOperations < 4) throw new Error('maxOperations must be an integer greater than three')
  const maxDecodedPrimitives = options.maxDecodedPrimitives ?? DEFAULTS.maxDecodedPrimitives
  const maxDecodedNodes = options.maxDecodedNodes ?? DEFAULTS.maxDecodedNodes
  const maxDecodedTriangles = options.maxDecodedTriangles ?? DEFAULTS.maxDecodedTriangles
  const maxDecodedPositionElements = options.maxDecodedPositionElements ?? DEFAULTS.maxDecodedPositionElements
  if (!Number.isInteger(maxDecodedNodes) || maxDecodedNodes <= 0) throw new Error('maxDecodedNodes must be a positive integer')
  if (!Number.isInteger(maxDecodedPrimitives) || maxDecodedPrimitives <= 0) throw new Error('maxDecodedPrimitives must be a positive integer')
  if (!Number.isInteger(maxDecodedTriangles) || maxDecodedTriangles <= 0) throw new Error('maxDecodedTriangles must be a positive integer')
  if (!Number.isInteger(maxDecodedPositionElements) || maxDecodedPositionElements <= 0) throw new Error('maxDecodedPositionElements must be a positive integer')
  return {
    cellSize,
    gapClosingDistance,
    doorPadding,
    minArea,
    contourSimplifyTolerance,
    gapClosing: Math.ceil(gapClosingDistance / cellSize),
    maxCells,
    maxOperations,
    maxDecodedNodes,
    maxDecodedPrimitives,
    maxDecodedTriangles,
    maxDecodedPositionElements,
  }
}

function isDecodedPrimitives(input: ExternalSpaceInput): input is readonly ExternalGlbGeometryPrimitive[] {
  return Array.isArray(input)
}

export function decodeExternalSpacePrimitives(
  input: ArrayBuffer | Uint8Array,
  options: Pick<ExternalSpaceCandidatesOptions, 'maxDecodedNodes' | 'maxDecodedPrimitives' | 'maxDecodedTriangles' | 'maxDecodedPositionElements'> = {},
): ExternalGlbGeometryPrimitive[] {
  const normalized = normalizeOptions(options)
  return decodeExternalGlbGeometry(input, {
    includeNode: (node) => node.extras.renderType === 'WALL' || node.extras.renderType === 'DOOR' || node.extras.renderType === 'WINDOW' || node.extras.renderType === 'SPACE',
    maxVisitedNodes: normalized.maxDecodedNodes,
    maxPrimitives: normalized.maxDecodedPrimitives,
    maxTriangles: normalized.maxDecodedTriangles,
    maxPositionElements: normalized.maxDecodedPositionElements,
  })
}

function sourceId(primitive: ExternalGlbGeometryPrimitive): string {
  const sid = primitive.extras.sid
  if (typeof sid === 'string' && sid.trim().length > 0) return sid
  return `node-${primitive.nodeIndex}`
}

function semanticTriangles(primitives: readonly ExternalGlbGeometryPrimitive[]): SemanticTriangle[] {
  return primitives.flatMap((primitive) => {
    const renderType = primitive.extras.renderType
    if (renderType !== 'WALL' && renderType !== 'DOOR' && renderType !== 'WINDOW') return []
    const id = sourceId(primitive)
    return primitive.triangles.map((triangle: ExternalGlbTriangle): SemanticTriangle => ({
      id,
      renderType,
      a: triangle[0],
      b: triangle[1],
      c: triangle[2],
    }))
  })
}

function wallVerticalRange(triangles: readonly SemanticTriangle[]): { min: number; max: number } | null {
  const walls = triangles.filter((triangle) => triangle.renderType === 'WALL')
  if (walls.length === 0) return null
  let min = Infinity
  let max = -Infinity
  for (const triangle of walls) {
    min = Math.min(min, triangle.a.y, triangle.b.y, triangle.c.y)
    max = Math.max(max, triangle.a.y, triangle.b.y, triangle.c.y)
  }
  return { min, max }
}

function emptyDetection(options: SemanticSpaceDetectionOptions): SemanticSpaceDetectionResult {
  return detectSemanticSpaces([], options)
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

function pointInPolygon(point: Vec2, polygon: readonly Vec2[]): boolean {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const start = polygon[previous]!
    const end = polygon[index]!
    const cross = (end.x - start.x) * (point.z - start.z) - (end.z - start.z) * (point.x - start.x)
    const onSegment = Math.abs(cross) <= EPSILON
      && point.x >= Math.min(start.x, end.x) - EPSILON && point.x <= Math.max(start.x, end.x) + EPSILON
      && point.z >= Math.min(start.z, end.z) - EPSILON && point.z <= Math.max(start.z, end.z) + EPSILON
    if (onSegment) return true
    const crosses = (start.z > point.z) !== (end.z > point.z)
      && point.x < ((end.x - start.x) * (point.z - start.z)) / (end.z - start.z) + start.x
    if (crosses) inside = !inside
  }
  return inside
}

function polygonBounds(polygon: readonly Vec2[]): { minX: number; maxX: number; minZ: number; maxZ: number } {
  return polygon.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    maxX: Math.max(bounds.maxX, point.x),
    minZ: Math.min(bounds.minZ, point.z),
    maxZ: Math.max(bounds.maxZ, point.z),
  }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity })
}

interface OperationBudget {
  limit: number
  used: number
  exceeded: boolean
}

interface PolygonOverlapMetrics {
  intersectionOverUnion: number
  smallerPolygonCoverage: number
}

function chargeOperations(budget: OperationBudget | undefined, amount: number): boolean {
  if (!budget) return true
  budget.used += Math.max(1, Math.ceil(amount))
  if (budget.used <= budget.limit) return true
  budget.exceeded = true
  return false
}

function sampledPolygonOverlap(left: readonly Vec2[], right: readonly Vec2[], budget?: OperationBudget): PolygonOverlapMetrics | null {
  if (!chargeOperations(budget, left.length + right.length)) return null
  const leftBounds = polygonBounds(left)
  const rightBounds = polygonBounds(right)
  const minX = Math.max(leftBounds.minX, rightBounds.minX)
  const maxX = Math.min(leftBounds.maxX, rightBounds.maxX)
  const minZ = Math.max(leftBounds.minZ, rightBounds.minZ)
  const maxZ = Math.min(leftBounds.maxZ, rightBounds.maxZ)
  const width = maxX - minX
  const depth = maxZ - minZ
  if (width <= EPSILON || depth <= EPSILON) return { intersectionOverUnion: 0, smallerPolygonCoverage: 0 }
  const leftArea = Math.abs(polygonArea(left))
  const rightArea = Math.abs(polygonArea(right))
  if (leftArea <= EPSILON || rightArea <= EPSILON) return { intersectionOverUnion: 0, smallerPolygonCoverage: 0 }
  const sampleBudget = 4_096
  const aspect = width / depth
  const xSteps = Math.max(8, Math.min(256, Math.ceil(Math.sqrt(sampleBudget * aspect))))
  const zSteps = Math.max(8, Math.min(256, Math.ceil(sampleBudget / xSteps)))
  const sampleCount = xSteps * zSteps
  if (!chargeOperations(budget, sampleCount * (left.length + right.length))) return null
  let intersection = 0
  for (let zIndex = 0; zIndex < zSteps; zIndex += 1) {
    const z = minZ + ((zIndex + 0.5) / zSteps) * depth
    for (let xIndex = 0; xIndex < xSteps; xIndex += 1) {
      const x = minX + ((xIndex + 0.5) / xSteps) * width
      const inLeft = pointInPolygon({ x, z }, left)
      const inRight = pointInPolygon({ x, z }, right)
      if (inLeft && inRight) intersection += 1
    }
  }
  const intersectionArea = Math.min(leftArea, rightArea, width * depth * intersection / sampleCount)
  const unionArea = leftArea + rightArea - intersectionArea
  return {
    intersectionOverUnion: unionArea > EPSILON ? intersectionArea / unionArea : 0,
    smallerPolygonCoverage: intersectionArea / Math.min(leftArea, rightArea),
  }
}

export function areSpacePolygonsEquivalent(left: readonly Vec2[], right: readonly Vec2[]): boolean {
  if (left.length < 3 || right.length < 3) return false
  const leftArea = Math.abs(polygonArea(left))
  const rightArea = Math.abs(polygonArea(right))
  if (leftArea <= EPSILON || rightArea <= EPSILON) return false
  const ratio = leftArea / rightArea
  if (ratio < 0.7 || ratio > 1.3) return false
  return (sampledPolygonOverlap(left, right)?.intersectionOverUnion ?? 0) >= 0.72
}

/** Material overlap is intentionally stricter than mere boundary contact and broader than duplicate equivalence. */
export function areSpacePolygonsMateriallyOverlapping(left: readonly Vec2[], right: readonly Vec2[]): boolean {
  if (left.length < 3 || right.length < 3) return false
  return (sampledPolygonOverlap(left, right)?.smallerPolygonCoverage ?? 0) >= 0.2
}

function projectedVertexKey(point: Vec2): string {
  return `${Math.round(point.x / 1e-6)},${Math.round(point.z / 1e-6)}`
}

function projectedEdgeKey(left: string, right: string): string {
  return left < right ? `${left}>${right}` : `${right}>${left}`
}

function canonicalizePolygon(polygon: Vec2[]): Vec2[] {
  let result = polygonArea(polygon) < 0 ? polygon.slice().reverse() : polygon.slice()
  let first = 0
  for (let index = 1; index < result.length; index += 1) {
    if (result[index]!.x < result[first]!.x - EPSILON
      || (Math.abs(result[index]!.x - result[first]!.x) <= EPSILON && result[index]!.z < result[first]!.z)) first = index
  }
  result = result.slice(first).concat(result.slice(0, first))
  return result
}

function extractCapBoundary(primitives: readonly ExternalGlbGeometryPrimitive[], targetY: number, tolerance: number, budget: OperationBudget): Vec2[] | null {
  const points = new Map<string, Vec2>()
  const edges = new Map<string, { left: string; right: string; count: number }>()
  let capTriangleCount = 0
  for (const primitive of primitives) {
    if (!chargeOperations(budget, 1)) return null
    for (const triangle of primitive.triangles) {
      if (!chargeOperations(budget, 1)) return null
      if (!triangle.every((point) => Math.abs(point.y - targetY) <= tolerance)) continue
      capTriangleCount += 1
      for (let index = 0; index < 3; index += 1) {
        const start = { x: triangle[index]!.x, z: triangle[index]!.z }
        const end = { x: triangle[(index + 1) % 3]!.x, z: triangle[(index + 1) % 3]!.z }
        const startKey = projectedVertexKey(start)
        const endKey = projectedVertexKey(end)
        if (startKey === endKey) continue
        points.set(startKey, points.get(startKey) ?? start)
        points.set(endKey, points.get(endKey) ?? end)
        const key = projectedEdgeKey(startKey, endKey)
        const existing = edges.get(key)
        if (existing) existing.count += 1
        else edges.set(key, { left: startKey, right: endKey, count: 1 })
      }
    }
  }
  if (capTriangleCount === 0) return null
  if (!chargeOperations(budget, edges.size)) return null
  const boundaryEdges = [...edges.values()].filter((edge) => edge.count === 1)
  if (boundaryEdges.length < 3) return null
  const adjacency = new Map<string, string[]>()
  for (const edge of boundaryEdges) {
    adjacency.set(edge.left, [...(adjacency.get(edge.left) ?? []), edge.right])
    adjacency.set(edge.right, [...(adjacency.get(edge.right) ?? []), edge.left])
  }
  if ([...adjacency.values()].some((neighbors) => neighbors.length !== 2)) return null
  for (const neighbors of adjacency.values()) {
    if (!chargeOperations(budget, neighbors.length * Math.max(1, Math.ceil(Math.log2(neighbors.length + 1))))) return null
    neighbors.sort()
  }

  if (!chargeOperations(budget, adjacency.size * Math.max(1, Math.ceil(Math.log2(adjacency.size + 1))))) return null
  const start = [...adjacency.keys()].sort()[0]
  if (!start) return null
  const polygon: Vec2[] = []
  const visited = new Set<string>()
  let previous: string | undefined
  let current = start
  while (polygon.length <= boundaryEdges.length) {
    polygon.push(points.get(current)!)
    const neighbors = adjacency.get(current)!
    const next = previous === undefined ? neighbors[0]! : neighbors.find((neighbor) => neighbor !== previous)
    if (!next) return null
    const edgeKey = projectedEdgeKey(current, next)
    if (visited.has(edgeKey)) return next === start && visited.size === boundaryEdges.length ? canonicalizePolygon(polygon) : null
    visited.add(edgeKey)
    previous = current
    current = next
    if (current === start) break
  }
  if (current !== start || visited.size !== boundaryEdges.length || polygon.length < 3 || Math.abs(polygonArea(polygon)) <= EPSILON) return null
  return canonicalizePolygon(polygon)
}

function sourceSpaceFootprints(primitives: readonly ExternalGlbGeometryPrimitive[], budget: OperationBudget): {
  polygons: Vec2[][]
  sourceSpaceCount: number
  unavailableNodeIndices: number[]
} {
  const groups = new Map<number, ExternalGlbGeometryPrimitive[]>()
  for (const primitive of primitives) {
    if (!chargeOperations(budget, 1)) break
    if (primitive.extras.renderType !== 'SPACE') continue
    const group = groups.get(primitive.nodeIndex)
    if (group) group.push(primitive)
    else groups.set(primitive.nodeIndex, [primitive])
  }
  const polygons: Vec2[][] = []
  const unavailableNodeIndices: number[] = []
  if (!chargeOperations(budget, groups.size * Math.max(1, Math.ceil(Math.log2(groups.size + 1))))) {
    return { polygons, sourceSpaceCount: groups.size, unavailableNodeIndices }
  }
  for (const [nodeIndex, group] of [...groups.entries()].sort((left, right) => left[0] - right[0])) {
    if (!chargeOperations(budget, group.length)) break
    let minY = Infinity
    let maxY = -Infinity
    for (const primitive of group) {
      minY = Math.min(minY, primitive.bounds.min.y)
      maxY = Math.max(maxY, primitive.bounds.max.y)
    }
    const tolerance = Math.max(1e-5, (maxY - minY) * 1e-5)
    const polygon = extractCapBoundary(group, minY, tolerance, budget) ?? (budget.exceeded ? null : extractCapBoundary(group, maxY, tolerance, budget))
    if (polygon) polygons.push(polygon)
    else unavailableNodeIndices.push(nodeIndex)
    if (budget.exceeded) break
  }
  return { polygons, sourceSpaceCount: groups.size, unavailableNodeIndices }
}

function existingPolygon(space: ExistingSpacePolygon): readonly Vec2[] {
  return 'polygon' in space ? space.polygon : space
}

function polygonsEquivalentWithBudget(left: readonly Vec2[], right: readonly Vec2[], budget: OperationBudget): boolean {
  if (!chargeOperations(budget, left.length + right.length)) return false
  const leftArea = Math.abs(polygonArea(left))
  const rightArea = Math.abs(polygonArea(right))
  if (leftArea <= EPSILON || rightArea <= EPSILON) return false
  const ratio = leftArea / rightArea
  if (ratio < 0.7 || ratio > 1.3) return false
  return (sampledPolygonOverlap(left, right, budget)?.intersectionOverUnion ?? 0) >= 0.72
}

function polygonsMateriallyOverlapWithBudget(left: readonly Vec2[], right: readonly Vec2[], budget: OperationBudget): boolean {
  if (left.length < 3 || right.length < 3) return false
  return (sampledPolygonOverlap(left, right, budget)?.smallerPolygonCoverage ?? 0) >= 0.2
}

function equivalentMiddleCandidate(candidate: SemanticSpaceCandidate, middle: readonly SemanticSpaceCandidate[], budget: OperationBudget): SemanticSpaceCandidate | undefined {
  for (const other of middle) {
    if (polygonsEquivalentWithBudget(candidate.polygon, other.polygon, budget)) return other
    if (budget.exceeded) return undefined
  }
  return undefined
}

function classifyCandidate(
  candidate: SemanticSpaceCandidate,
  middle: readonly SemanticSpaceCandidate[],
  upperHeight: number,
  id: string,
  budget: OperationBudget,
): ExternalSpaceCandidate | null {
  const equivalent = equivalentMiddleCandidate(candidate, middle, budget)
  if (budget.exceeded) return null
  const confidence: Confidence = equivalent ? 'inferred-high' : 'inferred-low'
  return {
    ...candidate,
    id,
    confidence,
    reasons: [
      ...candidate.reasons,
      ...(equivalent ? ['equivalent-middle-slice'] : ['no-equivalent-middle-slice']),
    ],
    slice: 'upper',
    sliceHeight: upperHeight,
    ...(equivalent ? { equivalentMiddleCandidateId: equivalent.id } : {}),
  }
}

function detectionOptions(normalized: ReturnType<typeof normalizeOptions>, sliceHeight: number, maxOperations: number): SemanticSpaceDetectionOptions {
  return {
    cellSize: normalized.cellSize,
    sliceHeights: [sliceHeight],
    gapClosing: normalized.gapClosing,
    doorPadding: normalized.doorPadding,
    minArea: normalized.minArea,
    contourSimplifyTolerance: normalized.contourSimplifyTolerance,
    maxCells: normalized.maxCells,
    maxOperations,
  }
}

/**
 * Decode external semantic GLB geometry (or accept already-decoded primitives),
 * rasterize middle and upper wall-height slices, and return transient upper-slice
 * space candidates with multi-slice confidence.
 */
export function detectExternalSpaceCandidates(
  input: ExternalSpaceInput,
  options: ExternalSpaceCandidatesOptions = {},
): ExternalSpaceCandidatesResult {
  const normalized = normalizeOptions(options)
  const primitives = isDecodedPrimitives(input) ? input : decodeExternalSpacePrimitives(input, normalized)
  const triangles = semanticTriangles(primitives)
  const range = wallVerticalRange(triangles) ?? { min: 0, max: 0 }
  const height = range.max - range.min
  const sliceHeights = {
    middle: range.min + height * 0.35,
    upper: range.min + height * 0.62,
  }
  const sourceSpaceMaxOperations = Math.max(1, Math.floor(normalized.maxOperations / 12))
  const matchingMaxOperations = Math.max(1, Math.floor(normalized.maxOperations / 6))
  const sliceMaxOperations = Math.max(1, Math.floor((normalized.maxOperations - sourceSpaceMaxOperations - matchingMaxOperations) / 2))
  const sourceSpaceBudget: OperationBudget = { limit: sourceSpaceMaxOperations, used: 0, exceeded: false }
  const matchingBudget: OperationBudget = { limit: matchingMaxOperations, used: 0, exceeded: false }
  const sourceSpaces = sourceSpaceFootprints(primitives, sourceSpaceBudget)
  const middle = range.max > range.min && !sourceSpaceBudget.exceeded
    ? detectSemanticSpaces(triangles, detectionOptions(normalized, sliceHeights.middle, sliceMaxOperations))
    : emptyDetection(detectionOptions(normalized, sliceHeights.middle, sliceMaxOperations))
  const upper = range.max > range.min && !sourceSpaceBudget.exceeded
    ? detectSemanticSpaces(triangles, detectionOptions(normalized, sliceHeights.upper, sliceMaxOperations))
    : emptyDetection(detectionOptions(normalized, sliceHeights.upper, sliceMaxOperations))
  const confirmedExisting = [
    ...(options.existingSpacePolygons ?? []),
    ...(options.existingSpaces ?? []),
  ].map(existingPolygon)
  const existing = [...confirmedExisting, ...sourceSpaces.polygons]
  const upperCandidates: SemanticSpaceCandidate[] = []
  let excludedExistingSpaceCount = 0
  let excludedSourceSpaceCount = 0
  if (!sourceSpaceBudget.exceeded && sourceSpaces.unavailableNodeIndices.length === 0) {
    for (const candidate of upper.candidates) {
      let excludedIndex = -1
      for (let index = 0; index < existing.length; index += 1) {
        if (polygonsMateriallyOverlapWithBudget(candidate.polygon, existing[index]!, matchingBudget)) {
          excludedIndex = index
          break
        }
        if (matchingBudget.exceeded) break
      }
      if (matchingBudget.exceeded) break
      if (excludedIndex >= 0) {
        excludedExistingSpaceCount += 1
        if (excludedIndex >= confirmedExisting.length) excludedSourceSpaceCount += 1
      } else upperCandidates.push(candidate)
    }
  }
  const candidates: ExternalSpaceCandidate[] = []
  if (!sourceSpaceBudget.exceeded && sourceSpaces.unavailableNodeIndices.length === 0 && !matchingBudget.exceeded) {
    for (const candidate of upperCandidates) {
      const classified = classifyCandidate(
        candidate,
        middle.candidates,
        sliceHeights.upper,
        `external-space-candidate-${String(candidates.length + 1).padStart(3, '0')}`,
        matchingBudget,
      )
      if (!classified || matchingBudget.exceeded) break
      candidates.push(classified)
    }
  }
  if (matchingBudget.exceeded) candidates.splice(0)
  const reasons = [
    ...(range.max > range.min ? [] : ['no-wall-vertical-range']),
    ...(middle.reasons.length > 0 ? [`middle-slice:${middle.reasons.join(',')}`] : []),
    ...(upper.reasons.length > 0 ? [`upper-slice:${upper.reasons.join(',')}`] : []),
    ...(sourceSpaceBudget.exceeded ? ['source-space-operations-exceeded'] : []),
    ...(sourceSpaces.unavailableNodeIndices.length > 0 ? ['source-space-boundary-unavailable'] : []),
    ...(matchingBudget.exceeded ? ['matching-operations-exceeded'] : []),
    ...(excludedExistingSpaceCount > 0 ? ['existing-space-overlap-exclusion-applied'] : []),
    ...(excludedSourceSpaceCount > 0 ? ['source-space-exclusion-applied'] : []),
  ]
  return {
    candidates,
    sliceHeights,
    middleSliceHeight: sliceHeights.middle,
    upperSliceHeight: sliceHeights.upper,
    wallVerticalRange: range,
    middleStats: middle.stats,
    upperStats: upper.stats,
    stats: { middle: middle.stats, upper: upper.stats },
    excludedExistingSpaceCount,
    sourceSpaceCount: sourceSpaces.sourceSpaceCount,
    sourceSpacePolygonCount: sourceSpaces.polygons.length,
    matchingStats: {
      estimatedOperations: matchingBudget.used,
      maxOperations: matchingBudget.limit,
      maxOperationsExceeded: matchingBudget.exceeded,
    },
    sourceSpaceStats: {
      estimatedOperations: sourceSpaceBudget.used,
      maxOperations: sourceSpaceBudget.limit,
      maxOperationsExceeded: sourceSpaceBudget.exceeded,
    },
    reasons,
  }
}

export const inferExternalSpaceCandidates = detectExternalSpaceCandidates
