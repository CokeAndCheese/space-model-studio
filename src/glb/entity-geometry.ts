import type {
  Entity,
  Facility,
  Floor,
  PolygonEntity,
  Stair,
  Vec2,
  Wall,
} from '../domain/contract'

export interface EntityMeshGeometry {
  positions: number[]
  indices: number[]
}

export class EntityGeometryError extends Error {
  constructor(readonly entityId: string, message: string) {
    super(message)
    this.name = 'EntityGeometryError'
  }
}

const EPSILON = 1e-7

function finitePositive(value: number) {
  return Number.isFinite(value) && value > 0
}

function assertPositive(entity: Entity, fields: Array<[name: string, value: number]>) {
  for (const [name, value] of fields) {
    if (!finitePositive(value)) {
      throw new EntityGeometryError(entity.id, `${entity.kind}.${name} must be greater than zero`)
    }
  }
}

function appendGeometry(target: EntityMeshGeometry, source: EntityMeshGeometry) {
  const vertexOffset = target.positions.length / 3
  target.positions.push(...source.positions)
  target.indices.push(...source.indices.map((index) => index + vertexOffset))
}

function boxGeometry(
  center: [number, number, number],
  size: [number, number, number],
  yaw = 0,
): EntityMeshGeometry {
  const [cx, cy, cz] = center
  const [sx, sy, sz] = size
  const hx = sx / 2
  const hy = sy / 2
  const hz = sz / 2
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const local: Array<[number, number, number]> = [
    [-hx, -hy, -hz],
    [hx, -hy, -hz],
    [hx, -hy, hz],
    [-hx, -hy, hz],
    [-hx, hy, -hz],
    [hx, hy, -hz],
    [hx, hy, hz],
    [-hx, hy, hz],
  ]
  const positions = local.flatMap(([x, y, z]) => [
    cx + x * cos + z * sin,
    cy + y,
    cz - x * sin + z * cos,
  ])
  return {
    positions,
    indices: [
      0, 2, 1, 0, 3, 2,
      4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4,
      1, 2, 6, 1, 6, 5,
      2, 3, 7, 2, 7, 6,
      3, 0, 4, 3, 4, 7,
    ],
  }
}

function cylinderGeometry(
  center: [number, number, number],
  size: [number, number, number],
  segments = 16,
): EntityMeshGeometry {
  const [cx, cy, cz] = center
  const [width, height, depth] = size
  const positions: number[] = [cx, cy - height / 2, cz, cx, cy + height / 2, cz]
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2
    const x = cx + Math.cos(angle) * width / 2
    const z = cz + Math.sin(angle) * depth / 2
    positions.push(x, cy - height / 2, z, x, cy + height / 2, z)
  }
  const indices: number[] = []
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments
    const bottom = 2 + index * 2
    const top = bottom + 1
    const nextBottom = 2 + next * 2
    const nextTop = nextBottom + 1
    indices.push(0, nextBottom, bottom)
    indices.push(1, top, nextTop)
    indices.push(bottom, nextBottom, nextTop, bottom, nextTop, top)
  }
  return { positions, indices }
}

function signedArea(points: Vec2[]) {
  let area = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!
    const next = points[(index + 1) % points.length]!
    area += current.x * next.z - next.x * current.z
  }
  return area / 2
}

function cross(a: Vec2, b: Vec2, c: Vec2) {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
}

function pointInTriangle(point: Vec2, a: Vec2, b: Vec2, c: Vec2) {
  const c1 = cross(a, b, point)
  const c2 = cross(b, c, point)
  const c3 = cross(c, a, point)
  return c1 >= -EPSILON && c2 >= -EPSILON && c3 >= -EPSILON
}

function triangulatePolygon(entity: PolygonEntity): { points: Vec2[]; triangles: number[][] } {
  const points = entity.polygon.filter((point, index, source) => {
    if (index === 0) return true
    const previous = source[index - 1]!
    return Math.hypot(point.x - previous.x, point.z - previous.z) > EPSILON
  })
  if (points.length > 2) {
    const first = points[0]!
    const last = points.at(-1)!
    if (Math.hypot(first.x - last.x, first.z - last.z) <= EPSILON) points.pop()
  }
  if (points.length < 3 || Math.abs(signedArea(points)) <= EPSILON) {
    throw new EntityGeometryError(entity.id, `${entity.kind}.polygon must contain at least three non-collinear points`)
  }

  const remaining = points.map((_, index) => index)
  if (signedArea(points) < 0) remaining.reverse()
  const triangles: number[][] = []
  let guard = remaining.length * remaining.length
  while (remaining.length > 3 && guard > 0) {
    let clipped = false
    for (let cursor = 0; cursor < remaining.length; cursor += 1) {
      const previous = remaining[(cursor - 1 + remaining.length) % remaining.length]!
      const current = remaining[cursor]!
      const next = remaining[(cursor + 1) % remaining.length]!
      if (cross(points[previous]!, points[current]!, points[next]!) <= EPSILON) continue
      const containsPoint = remaining.some((candidate) => (
        candidate !== previous
        && candidate !== current
        && candidate !== next
        && pointInTriangle(points[candidate]!, points[previous]!, points[current]!, points[next]!)
      ))
      if (containsPoint) continue
      triangles.push([previous, current, next])
      remaining.splice(cursor, 1)
      clipped = true
      break
    }
    if (!clipped) break
    guard -= 1
  }
  if (remaining.length === 3) triangles.push([...remaining])
  if (triangles.length !== points.length - 2) {
    throw new EntityGeometryError(entity.id, `${entity.kind}.polygon is self-intersecting or cannot be triangulated`)
  }
  return { points, triangles }
}

function polygonPrismGeometry(entity: PolygonEntity, bottom: number, height: number): EntityMeshGeometry {
  assertPositive(entity, [['height', height]])
  const { points, triangles } = triangulatePolygon(entity)
  const positions = [
    ...points.flatMap((point) => [point.x, bottom, point.z]),
    ...points.flatMap((point) => [point.x, bottom + height, point.z]),
  ]
  const topOffset = points.length
  const indices: number[] = []
  for (const [a, b, c] of triangles as Array<[number, number, number]>) {
    indices.push(a, b, c)
    indices.push(a + topOffset, c + topOffset, b + topOffset)
  }
  for (let index = 0; index < points.length; index += 1) {
    const next = (index + 1) % points.length
    indices.push(index, next, next + topOffset, index, next + topOffset, index + topOffset)
  }
  return { positions, indices }
}

function openingGeometry(entity: Extract<Entity, { kind: 'door' | 'window' }>, floor: Floor): EntityMeshGeometry {
  assertPositive(entity, [['width', entity.width], ['height', entity.height], ['depth', entity.depth]])
  const host = floor.entities.find((candidate): candidate is Wall => (
    candidate.kind === 'wall' && candidate.id === entity.hostWallId
  ))
  if (!host) throw new EntityGeometryError(entity.id, `${entity.kind}.hostWallId does not reference a wall on this floor`)
  // start/end are the persisted wall geometry. Wall.transform is a derived editor
  // handle in the Domain factory, so applying it here would translate the wall twice.
  const start = host.start
  const end = host.end
  const length = Math.hypot(end.x - start.x, end.z - start.z)
  if (length <= EPSILON) throw new EntityGeometryError(entity.id, 'Host wall has zero length')
  if (entity.offset - entity.width / 2 < -EPSILON || entity.offset + entity.width / 2 > length + EPSILON) {
    throw new EntityGeometryError(entity.id, `${entity.kind} extends beyond its host wall`)
  }
  const dx = (end.x - start.x) / length
  const dz = (end.z - start.z) / length
  const centerX = start.x + dx * entity.offset
  const centerZ = start.z + dz * entity.offset
  const bottom = floor.elevation + host.baseOffset + entity.sillHeight
  return boxGeometry(
    [centerX, bottom + entity.height / 2, centerZ],
    [entity.width, entity.height, entity.depth],
    Math.atan2(-dz, dx),
  )
}

function wallGeometry(entity: Wall, floor: Floor): EntityMeshGeometry {
  assertPositive(entity, [['height', entity.height], ['thickness', entity.thickness]])
  const dx = entity.end.x - entity.start.x
  const dz = entity.end.z - entity.start.z
  const length = Math.hypot(dx, dz)
  if (length <= 0.1) throw new EntityGeometryError(entity.id, 'wall length must be greater than 0.1m')

  const openings = entity.openings.map((openingId) => {
    const opening = floor.entities.find((candidate) => candidate.id === openingId)
    if (!opening || (opening.kind !== 'door' && opening.kind !== 'window')) {
      throw new EntityGeometryError(entity.id, `wall opening ${openingId} is not a Door or Window on this floor`)
    }
    if (opening.hostWallId !== entity.id) {
      throw new EntityGeometryError(entity.id, `wall opening ${openingId} points to a different host wall`)
    }
    assertPositive(opening, [['width', opening.width], ['height', opening.height]])
    const left = opening.offset - opening.width / 2
    const right = opening.offset + opening.width / 2
    if (left < -EPSILON || right > length + EPSILON) {
      throw new EntityGeometryError(opening.id, `${opening.kind} extends beyond its host wall`)
    }
    return {
      left: Math.max(0, left),
      right: Math.min(length, right),
      bottom: Math.max(0, opening.sillHeight),
      top: Math.min(entity.height, opening.sillHeight + opening.height),
    }
  }).filter((opening) => opening.top - opening.bottom > EPSILON)

  const boundaries = [...new Set([
    0,
    length,
    ...openings.flatMap((opening) => [opening.left, opening.right]),
  ])].sort((left, right) => left - right)
  const directionX = dx / length
  const directionZ = dz / length
  const yaw = Math.atan2(-directionZ, directionX)
  const geometry: EntityMeshGeometry = { positions: [], indices: [] }

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const left = boundaries[index]!
    const right = boundaries[index + 1]!
    const segmentLength = right - left
    if (segmentLength <= EPSILON) continue
    const middle = (left + right) / 2
    const blocked = openings
      .filter((opening) => middle > opening.left - EPSILON && middle < opening.right + EPSILON)
      .map((opening) => [opening.bottom, opening.top] as [number, number])
      .sort((first, second) => first[0] - second[0])
    const merged: Array<[number, number]> = []
    for (const interval of blocked) {
      const previous = merged.at(-1)
      if (!previous || interval[0] > previous[1] + EPSILON) merged.push([...interval])
      else previous[1] = Math.max(previous[1], interval[1])
    }

    const solids: Array<[number, number]> = []
    let cursor = 0
    for (const [bottom, top] of merged) {
      if (bottom > cursor + EPSILON) solids.push([cursor, bottom])
      cursor = Math.max(cursor, top)
    }
    if (cursor < entity.height - EPSILON) solids.push([cursor, entity.height])

    for (const [bottom, top] of solids) {
      const segmentHeight = top - bottom
      appendGeometry(geometry, boxGeometry(
        [
          entity.start.x + directionX * middle,
          floor.elevation + entity.baseOffset + bottom + segmentHeight / 2,
          entity.start.z + directionZ * middle,
        ],
        [segmentLength, segmentHeight, entity.thickness],
        yaw,
      ))
    }
  }

  if (geometry.indices.length === 0) {
    throw new EntityGeometryError(entity.id, 'wall openings remove the entire wall geometry')
  }
  return geometry
}

function stairGeometry(entity: Stair, floor: Floor): EntityMeshGeometry {
  assertPositive(entity, [
    ['width', entity.width],
    ['totalRise', entity.totalRise],
    ['stepCount', entity.stepCount],
  ])
  if (!Number.isInteger(entity.stepCount)) {
    throw new EntityGeometryError(entity.id, 'stair.stepCount must be an integer')
  }
  const dx = entity.end.x - entity.start.x
  const dz = entity.end.z - entity.start.z
  const length = Math.hypot(dx, dz)
  if (length <= EPSILON) throw new EntityGeometryError(entity.id, 'stair start and end cannot coincide')
  const stepLength = length / entity.stepCount
  const stepRise = entity.totalRise / entity.stepCount
  const yaw = Math.atan2(-dz, dx)
  const geometry: EntityMeshGeometry = { positions: [], indices: [] }
  for (let index = 0; index < entity.stepCount; index += 1) {
    const height = stepRise * (index + 1)
    const distance = stepLength * (index + 0.5)
    appendGeometry(geometry, boxGeometry(
      [
        entity.start.x + dx / length * distance,
        floor.elevation + entity.position.y + height / 2,
        entity.start.z + dz / length * distance,
      ],
      [stepLength, height, entity.width],
      yaw,
    ))
  }
  return geometry
}

function facilityGeometry(entity: Facility, floor: Floor): EntityMeshGeometry {
  assertPositive(entity, [
    ['size.width', entity.size.width],
    ['size.height', entity.size.height],
    ['size.depth', entity.size.depth],
  ])
  const center: [number, number, number] = [
    entity.position.x,
    floor.elevation + entity.position.y,
    entity.position.z,
  ]
  const size: [number, number, number] = [entity.size.width, entity.size.height, entity.size.depth]
  return entity.facilityShape === 'cylinder'
    ? cylinderGeometry(center, size)
    : boxGeometry(center, size)
}

/** Build one indexed triangle mesh for exactly one semantic Domain entity. */
export function buildEntityGeometry(entity: Entity, floor: Floor): EntityMeshGeometry {
  switch (entity.kind) {
    case 'wall': {
      return wallGeometry(entity, floor)
    }
    case 'door':
    case 'window':
      return openingGeometry(entity, floor)
    case 'slab':
      return polygonPrismGeometry(entity, floor.elevation + entity.baseOffset, entity.thickness)
    case 'ceiling':
      return polygonPrismGeometry(entity, floor.elevation + entity.height, entity.thickness)
    case 'space':
      return polygonPrismGeometry(entity, floor.elevation, entity.height)
    case 'facility':
      return facilityGeometry(entity, floor)
    case 'stair':
      return stairGeometry(entity, floor)
    case 'elevator': {
      assertPositive(entity, [['width', entity.width], ['depth', entity.depth], ['height', entity.height]])
      return boxGeometry(
        [entity.center.x, floor.elevation + entity.position.y + entity.height / 2, entity.center.z],
        [entity.width, entity.height, entity.depth],
      )
    }
  }
}
