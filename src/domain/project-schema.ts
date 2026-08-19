import { z } from 'zod'
import {
  CONFIDENCE_LEVELS,
  DIRECTIONS,
  FACILITY_SHAPES,
  FIRE_TYPES,
  FLOOR_TYPES,
  METADATA_SPEC_VERSION,
  PROJECT_SCHEMA_VERSION,
  RENDER_TYPE_BY_KIND,
  RENDER_TYPES,
  SPACE_TYPES,
  type Entity,
  type Project,
  type Vec2,
} from './contract'
import { topologyAuthoringStateSchema } from '../topology/authoring'

const finite = z.number().finite()
const positive = finite.positive()
const nonNegative = finite.nonnegative()
const idSchema = z.string().uuid()
const labelSchema = z.string().trim().min(1).max(200)

export const vec2Schema = z.object({ x: finite, z: finite }).strict()
export const vec3Schema = z.object({ x: finite, y: finite, z: finite }).strict()
export const transformSchema = z
  .object({
    position: vec3Schema.default({ x: 0, y: 0, z: 0 }),
    rotationY: finite.default(0),
  })
  .strict()

export const metadataSchema = z
  .object({
    renderType: z.enum(RENDER_TYPES),
    confidence: z.enum(CONFIDENCE_LEVELS).default('confirmed'),
    sidMode: z.enum(['auto', 'manual']).default('auto'),
    directionMode: z.enum(['auto', 'manual']).default('auto'),
    renderTypeMode: z.enum(['auto', 'manual']).default('manual'),
    direction: z.enum(DIRECTIONS).optional(),
    sequence: z.number().int().positive(),
    sid: z.string().trim().min(1).optional(),
    manualSid: z.string().trim().min(1).optional(),
    sub: z.string().trim().min(1).optional(),
  })
  .strict()

const baseEntityShape = {
  id: idSchema,
  floorId: idSchema,
  name: labelSchema,
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
  transform: transformSchema.default({ position: { x: 0, y: 0, z: 0 }, rotationY: 0 }),
}

function metadataFor<T extends (typeof RENDER_TYPES)[number]>(renderType: T) {
  return metadataSchema.extend({ renderType: z.literal(renderType) })
}

function cross(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
}

function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  const epsilon = 1e-9
  return (
    Math.abs(cross(a, b, p)) <= epsilon &&
    p.x >= Math.min(a.x, b.x) - epsilon &&
    p.x <= Math.max(a.x, b.x) + epsilon &&
    p.z >= Math.min(a.z, b.z) - epsilon &&
    p.z <= Math.max(a.z, b.z) + epsilon
  )
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const abC = cross(a, b, c)
  const abD = cross(a, b, d)
  const cdA = cross(c, d, a)
  const cdB = cross(c, d, b)
  if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) {
    return true
  }
  return (
    (Math.abs(abC) <= 1e-9 && onSegment(a, b, c)) ||
    (Math.abs(abD) <= 1e-9 && onSegment(a, b, d)) ||
    (Math.abs(cdA) <= 1e-9 && onSegment(c, d, a)) ||
    (Math.abs(cdB) <= 1e-9 && onSegment(c, d, b))
  )
}

export function polygonArea(polygon: readonly Vec2[]): number {
  let twiceArea = 0
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]!
    const next = polygon[(index + 1) % polygon.length]!
    twiceArea += current.x * next.z - next.x * current.z
  }
  return twiceArea / 2
}

export function isSelfIntersectingPolygon(polygon: readonly Vec2[]): boolean {
  for (let first = 0; first < polygon.length; first += 1) {
    const firstNext = (first + 1) % polygon.length
    for (let second = first + 1; second < polygon.length; second += 1) {
      const secondNext = (second + 1) % polygon.length
      if (first === second || firstNext === second || secondNext === first) continue
      if (first === 0 && secondNext === 0) continue
      if (segmentsIntersect(polygon[first]!, polygon[firstNext]!, polygon[second]!, polygon[secondNext]!)) return true
    }
  }
  return false
}

export const polygonSchema = z
  .array(vec2Schema)
  .min(3)
  .superRefine((polygon, context) => {
    const unique = new Set(polygon.map((point) => `${point.x}:${point.z}`))
    if (unique.size < 3 || Math.abs(polygonArea(polygon)) <= 1e-8) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: '多边形必须有至少 3 个有效点且面积大于 0' })
    }
    if (isSelfIntersectingPolygon(polygon)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: '多边形不能自交' })
    }
  })

export const wallSchema = z
  .object({
    ...baseEntityShape,
    kind: z.literal('wall'),
    start: vec2Schema,
    end: vec2Schema,
    baseOffset: finite,
    height: positive,
    thickness: positive,
    openings: z.array(idSchema),
    metadata: metadataFor('WALL'),
  })
  .strict()

export const doorSchema = z
  .object({
    ...baseEntityShape,
    kind: z.literal('door'),
    hostWallId: idSchema,
    offset: nonNegative,
    width: positive,
    height: positive,
    depth: positive,
    sillHeight: z.literal(0),
    metadata: metadataFor('DOOR'),
  })
  .strict()

export const windowSchema = z
  .object({
    ...baseEntityShape,
    kind: z.literal('window'),
    hostWallId: idSchema,
    offset: nonNegative,
    width: positive,
    height: positive,
    depth: positive,
    sillHeight: nonNegative,
    metadata: metadataFor('WINDOW'),
  })
  .strict()

export const slabSchema = z
  .object({
    ...baseEntityShape,
    kind: z.literal('slab'),
    polygon: polygonSchema,
    baseOffset: finite,
    thickness: positive,
    metadata: metadataFor('CEILING'),
  })
  .strict()

export const ceilingSchema = z
  .object({
    ...baseEntityShape,
    kind: z.literal('ceiling'),
    polygon: polygonSchema,
    height: nonNegative,
    thickness: positive,
    metadata: metadataFor('CEILING'),
  })
  .strict()

export const spaceSchema = z
  .object({
    ...baseEntityShape,
    kind: z.literal('space'),
    polygon: polygonSchema,
    height: positive,
    spaceType: z.enum(SPACE_TYPES),
    metadata: metadataFor('SPACE'),
  })
  .strict()

export const facilitySchema = z
  .object({
    ...baseEntityShape,
    kind: z.literal('facility'),
    facilityShape: z.enum(FACILITY_SHAPES),
    size: z.object({ width: positive, height: positive, depth: positive }).strict(),
    position: vec3Schema,
    mountHeight: nonNegative,
    fireType: z.enum(FIRE_TYPES),
    metadata: metadataFor('FACILITY'),
  })
  .strict()

export const stairSchema = z
  .object({
    ...baseEntityShape,
    kind: z.literal('stair'),
    start: vec2Schema,
    end: vec2Schema,
    width: positive,
    totalRise: positive,
    stepCount: z.number().int().min(2),
    position: vec3Schema,
    length: positive,
    height: positive,
    connectorId: z.string().trim().min(1).optional(),
    metadata: metadataFor('STAIR'),
  })
  .strict()

export const elevatorSchema = z
  .object({
    ...baseEntityShape,
    kind: z.literal('elevator'),
    center: vec2Schema,
    position: vec3Schema,
    width: positive,
    depth: positive,
    height: positive,
    connectorId: z.string().trim().min(1).optional(),
    metadata: metadataFor('ELEVATOR'),
  })
  .strict()

export const entitySchema = z.discriminatedUnion('kind', [
  wallSchema,
  slabSchema,
  ceilingSchema,
  doorSchema,
  windowSchema,
  spaceSchema,
  facilitySchema,
  stairSchema,
  elevatorSchema,
])

export const floorSchema = z
  .object({
    id: idSchema,
    buildingId: idSchema.nullable(),
    floorName: z.string().trim().min(1).max(100).regex(/^[A-Z0-9][A-Z0-9_-]*$/),
    name: labelSchema,
    level: z.number().int().nullable(),
    floorType: z.enum(FLOOR_TYPES),
    elevation: finite,
    clearHeight: positive,
    entities: z.array(entitySchema),
  })
  .strict()

export const buildingSchema = z
  .object({
    id: idSchema,
    code: z.string().trim().regex(/^[A-Z][A-Z0-9]*$/),
    name: labelSchema,
    floors: z.array(floorSchema),
  })
  .strict()

function addCustomIssue(context: z.RefinementCtx, path: (string | number)[], message: string): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message })
}

function wallLength(wall: Extract<Entity, { kind: 'wall' }>): number {
  return Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z)
}

function validateFloorRelations(
  floor: z.infer<typeof floorSchema>,
  buildingId: string,
  path: (string | number)[],
  context: z.RefinementCtx,
): void {
  const landscape = floor.floorType === 'LANDSCAPE_TERRAIN' || floor.floorType === 'LANDSCAPE_FACADE'
  if (landscape) {
    if (floor.buildingId !== null || floor.level !== null) {
      addCustomIssue(context, path, '景观楼层的 buildingId 和 level 必须为 null')
    }
  } else {
    if (floor.buildingId !== buildingId) addCustomIssue(context, [...path, 'buildingId'], '楼层 buildingId 与所属楼栋不一致')
    if (floor.level === null || floor.level === 0) addCustomIssue(context, [...path, 'level'], '非景观楼层 level 必须是非零整数')
  }

  const entities = new Map(floor.entities.map((entity) => [entity.id, entity]))
  const hostedByWall = new Map<string, string[]>()
  for (let entityIndex = 0; entityIndex < floor.entities.length; entityIndex += 1) {
    const entity = floor.entities[entityIndex]!
    const entityPath = [...path, 'entities', entityIndex]
    if (entity.floorId !== floor.id) addCustomIssue(context, [...entityPath, 'floorId'], '实体 floorId 与所属楼层不一致')
    if (entity.metadata.renderType !== RENDER_TYPE_BY_KIND[entity.kind]) {
      addCustomIssue(context, [...entityPath, 'metadata', 'renderType'], `kind=${entity.kind} 必须使用 ${RENDER_TYPE_BY_KIND[entity.kind]}`)
    }
    const directionRequired = !['CEILING', 'FACILITY', 'WALL', 'SPACE'].includes(entity.metadata.renderType)
    if (directionRequired && entity.metadata.directionMode === 'manual' && !entity.metadata.direction) {
      addCustomIssue(context, [...entityPath, 'metadata', 'direction'], '人工方位模式必须提供 direction')
    }
    if (entity.metadata.sidMode === 'manual' && !entity.metadata.manualSid && !entity.metadata.sid) {
      addCustomIssue(context, [...entityPath, 'metadata', 'manualSid'], '人工 SID 模式必须提供 manualSid')
    }

    if (entity.kind === 'wall') {
      if (wallLength(entity) <= 0.1) addCustomIssue(context, [...entityPath, 'end'], '墙长必须大于 0.1m')
      if (new Set(entity.openings).size !== entity.openings.length) {
        addCustomIssue(context, [...entityPath, 'openings'], '墙体 openings 不能包含重复 ID')
      }
    }

    if (entity.kind === 'door' || entity.kind === 'window') {
      const host = entities.get(entity.hostWallId)
      if (!host || host.kind !== 'wall') {
        addCustomIssue(context, [...entityPath, 'hostWallId'], '门窗必须宿主于同楼层墙体')
        continue
      }
      const length = wallLength(host)
      if (entity.offset - entity.width / 2 < -1e-9 || entity.offset + entity.width / 2 > length + 1e-9) {
        addCustomIssue(context, [...entityPath, 'offset'], '门窗洞口不能超出宿主墙体')
      }
      if (entity.sillHeight + entity.height > host.height + 1e-9) {
        addCustomIssue(context, [...entityPath, 'height'], '门窗洞口高度不能超出宿主墙体')
      }
      const siblings = hostedByWall.get(host.id) ?? []
      siblings.push(entity.id)
      hostedByWall.set(host.id, siblings)
    }
  }

  for (let entityIndex = 0; entityIndex < floor.entities.length; entityIndex += 1) {
    const entity = floor.entities[entityIndex]!
    if (entity.kind !== 'wall') continue
    const expected = new Set(hostedByWall.get(entity.id) ?? [])
    const actual = new Set(entity.openings)
    for (const openingId of actual) {
      const opening = entities.get(openingId)
      if (!opening || (opening.kind !== 'door' && opening.kind !== 'window') || opening.hostWallId !== entity.id) {
        addCustomIssue(context, [...path, 'entities', entityIndex, 'openings'], `宿主墙引用了无效洞口 ${openingId}`)
      }
    }
    for (const openingId of expected) {
      if (!actual.has(openingId)) {
        addCustomIssue(context, [...path, 'entities', entityIndex, 'openings'], `宿主墙缺少洞口引用 ${openingId}`)
      }
    }

    const openings: Array<{ id: string; offset: number; width: number }> = []
    for (const id of expected) {
      const opening = entities.get(id)
      if (opening?.kind === 'door' || opening?.kind === 'window') openings.push(opening)
    }
    openings.sort((left, right) => left.offset - left.width / 2 - (right.offset - right.width / 2))
    for (let index = 1; index < openings.length; index += 1) {
      const previous = openings[index - 1]!
      const current = openings[index]!
      if (current.offset - current.width / 2 < previous.offset + previous.width / 2 - 1e-9) {
        addCustomIssue(context, [...path, 'entities', entityIndex, 'openings'], `宿主墙上的洞口 ${previous.id} 与 ${current.id} 重叠`)
      }
    }
  }
}

export const projectSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
    metadataSpecVersion: z.literal(METADATA_SPEC_VERSION),
    projectId: idSchema,
    name: labelSchema,
    settings: z
      .object({
        unit: z.literal('m'),
        upAxis: z.literal('+Y'),
        north: vec2Schema,
        gridSize: positive,
        snapEnabled: z.boolean(),
      })
      .strict(),
    buildings: z.array(buildingSchema),
    topology: topologyAuthoringStateSchema.optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((project, context) => {
    if (Math.hypot(project.settings.north.x, project.settings.north.z) <= 1e-8) {
      addCustomIssue(context, ['settings', 'north'], '北向向量长度必须大于 0')
    }

    const buildingIds = new Set<string>()
    const buildingCodes = new Set<string>()
    const floorIds = new Set<string>()
    const floorNames = new Set<string>()
    const entityIds = new Set<string>()

    for (let buildingIndex = 0; buildingIndex < project.buildings.length; buildingIndex += 1) {
      const building = project.buildings[buildingIndex]!
      if (buildingIds.has(building.id)) addCustomIssue(context, ['buildings', buildingIndex, 'id'], '楼栋 ID 必须唯一')
      if (buildingCodes.has(building.code)) addCustomIssue(context, ['buildings', buildingIndex, 'code'], '楼栋 code 必须唯一')
      buildingIds.add(building.id)
      buildingCodes.add(building.code)

      for (let floorIndex = 0; floorIndex < building.floors.length; floorIndex += 1) {
        const floor = building.floors[floorIndex]!
        const floorPath = ['buildings', buildingIndex, 'floors', floorIndex] as (string | number)[]
        if (floorIds.has(floor.id)) addCustomIssue(context, [...floorPath, 'id'], '楼层 ID 必须全局唯一')
        if (floorNames.has(floor.floorName)) addCustomIssue(context, [...floorPath, 'floorName'], '楼层 floorName 必须全局唯一')
        floorIds.add(floor.id)
        floorNames.add(floor.floorName)

        for (let entityIndex = 0; entityIndex < floor.entities.length; entityIndex += 1) {
          const entity = floor.entities[entityIndex]!
          if (entityIds.has(entity.id)) addCustomIssue(context, [...floorPath, 'entities', entityIndex, 'id'], '实体 ID 必须全局唯一')
          entityIds.add(entity.id)
        }
        validateFloorRelations(floor, building.id, floorPath, context)
      }
    }
  })

export function parseProjectValue(value: unknown): Project {
  return projectSchema.parse(value) as Project
}

export function isProject(value: unknown): value is Project {
  return projectSchema.safeParse(value).success
}
