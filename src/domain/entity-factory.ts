import {
  type Ceiling,
  type Confidence,
  type Direction,
  type Door,
  type Elevator,
  type EntityMetadata,
  type Facility,
  type FacilityShape,
  type FireType,
  type RenderType,
  type Slab,
  type Space,
  type SpaceType,
  type Stair,
  type Vec2,
  type Vec3,
  type Wall,
  type WindowEntity,
} from './contract'

export function createId(): string {
  return globalThis.crypto.randomUUID()
}

const origin = (): Vec3 => ({ x: 0, y: 0, z: 0 })

export interface MetadataOptions {
  confidence?: Confidence
  sidMode?: 'auto' | 'manual'
  directionMode?: 'auto' | 'manual'
  renderTypeMode?: 'auto' | 'manual'
  direction?: Direction
  sequence?: number
  sid?: string
  manualSid?: string
  sub?: string
}

export function createEntityMetadata(renderType: RenderType, options: MetadataOptions = {}): EntityMetadata {
  return {
    renderType,
    confidence: options.confidence ?? 'confirmed',
    sidMode: options.sidMode ?? 'auto',
    directionMode: options.directionMode ?? 'auto',
    renderTypeMode: options.renderTypeMode ?? 'manual',
    direction: options.direction,
    sequence: options.sequence ?? 1,
    sid: options.sid,
    manualSid: options.manualSid,
    sub: options.sub,
  }
}

interface CommonInput {
  id?: string
  name?: string
  visible?: boolean
  locked?: boolean
  position?: Vec3
  rotationY?: number
  metadata?: MetadataOptions
}

export interface WallInput extends CommonInput {
  start: Vec2
  end: Vec2
  baseOffset?: number
  height?: number
  thickness?: number
  openings?: string[]
}

export function makeWall(floorId: string, input: WallInput): Wall {
  return {
    id: input.id ?? createId(),
    kind: 'wall',
    floorId,
    name: input.name ?? '墙体',
    visible: input.visible ?? true,
    locked: input.locked ?? false,
    transform: {
      position: input.position ?? origin(),
      rotationY: input.rotationY ?? 0,
    },
    start: { ...input.start },
    end: { ...input.end },
    baseOffset: input.baseOffset ?? 0,
    height: input.height ?? 3.6,
    thickness: input.thickness ?? 0.2,
    openings: [...(input.openings ?? [])],
    metadata: createEntityMetadata('WALL', input.metadata),
  }
}

export interface OpeningInput extends CommonInput {
  hostWallId: string
  offset: number
  width?: number
  height?: number
  depth?: number
  sillHeight?: number
}

export function makeDoor(floorId: string, input: OpeningInput): Door {
  return {
    id: input.id ?? createId(),
    kind: 'door',
    floorId,
    hostWallId: input.hostWallId,
    name: input.name ?? '门',
    visible: input.visible ?? true,
    locked: input.locked ?? false,
    transform: { position: input.position ?? origin(), rotationY: input.rotationY ?? 0 },
    offset: input.offset,
    width: input.width ?? 1.2,
    height: input.height ?? 2.1,
    depth: input.depth ?? 0.08,
    sillHeight: 0,
    metadata: createEntityMetadata('DOOR', input.metadata),
  }
}

export function makeWindow(floorId: string, input: OpeningInput): WindowEntity {
  return {
    id: input.id ?? createId(),
    kind: 'window',
    floorId,
    hostWallId: input.hostWallId,
    name: input.name ?? '窗',
    visible: input.visible ?? true,
    locked: input.locked ?? false,
    transform: { position: input.position ?? origin(), rotationY: input.rotationY ?? 0 },
    offset: input.offset,
    width: input.width ?? 1.4,
    height: input.height ?? 1.4,
    depth: input.depth ?? 0.08,
    sillHeight: input.sillHeight ?? 0.9,
    metadata: createEntityMetadata('WINDOW', input.metadata),
  }
}

export interface PolygonEntityInput extends CommonInput {
  polygon: Vec2[]
  thickness?: number
  height?: number
  baseOffset?: number
}

export function makeSlab(floorId: string, input: PolygonEntityInput): Slab {
  return {
    id: input.id ?? createId(),
    kind: 'slab',
    floorId,
    name: input.name ?? '楼板',
    visible: input.visible ?? true,
    locked: input.locked ?? false,
    transform: { position: input.position ?? origin(), rotationY: input.rotationY ?? 0 },
    polygon: input.polygon.map((point) => ({ ...point })),
    baseOffset: input.baseOffset ?? 0,
    thickness: input.thickness ?? 0.2,
    metadata: createEntityMetadata('CEILING', { sub: 'SLAB', ...input.metadata }),
  }
}

export function makeCeiling(floorId: string, input: PolygonEntityInput): Ceiling {
  return {
    id: input.id ?? createId(),
    kind: 'ceiling',
    floorId,
    name: input.name ?? '天花板',
    visible: input.visible ?? true,
    locked: input.locked ?? false,
    transform: { position: input.position ?? origin(), rotationY: input.rotationY ?? 0 },
    polygon: input.polygon.map((point) => ({ ...point })),
    height: input.height ?? 3.4,
    thickness: input.thickness ?? 0.1,
    metadata: createEntityMetadata('CEILING', { sub: 'UPPER', ...input.metadata }),
  }
}

export interface SpaceInput extends CommonInput {
  polygon: Vec2[]
  height?: number
  spaceType: SpaceType
}

export function makeSpace(floorId: string, input: SpaceInput): Space {
  return {
    id: input.id ?? createId(),
    kind: 'space',
    floorId,
    name: input.name ?? '空间',
    visible: input.visible ?? true,
    locked: input.locked ?? false,
    transform: { position: input.position ?? origin(), rotationY: input.rotationY ?? 0 },
    polygon: input.polygon.map((point) => ({ ...point })),
    height: input.height ?? 0.02,
    spaceType: input.spaceType,
    metadata: createEntityMetadata('SPACE', input.metadata),
  }
}

export interface FacilityInput extends CommonInput {
  facilityShape?: FacilityShape
  size?: { width: number; height: number; depth: number }
  position: Vec3
  mountHeight?: number
  fireType: FireType
}

export function makeFacility(floorId: string, input: FacilityInput): Facility {
  const position = { ...input.position }
  return {
    id: input.id ?? createId(),
    kind: 'facility',
    floorId,
    name: input.name ?? '设施',
    visible: input.visible ?? true,
    locked: input.locked ?? false,
    transform: { position: origin(), rotationY: input.rotationY ?? 0 },
    facilityShape: input.facilityShape ?? 'box',
    size: { ...(input.size ?? { width: 0.7, height: 1.6, depth: 0.25 }) },
    position,
    mountHeight: input.mountHeight ?? position.y,
    fireType: input.fireType,
    metadata: createEntityMetadata('FACILITY', input.metadata),
  }
}

export interface StairInput extends CommonInput {
  start: Vec2
  end: Vec2
  width?: number
  totalRise?: number
  stepCount?: number
  connectorId?: string
}

export function makeStair(floorId: string, input: StairInput): Stair {
  const totalRise = input.totalRise ?? 3.6
  const length = Math.hypot(input.end.x - input.start.x, input.end.z - input.start.z)
  const position = input.position ?? { x: (input.start.x + input.end.x) / 2, y: 0, z: (input.start.z + input.end.z) / 2 }
  return {
    id: input.id ?? createId(),
    kind: 'stair',
    floorId,
    name: input.name ?? '楼梯',
    visible: input.visible ?? true,
    locked: input.locked ?? false,
    transform: { position: origin(), rotationY: input.rotationY ?? 0 },
    start: { ...input.start },
    end: { ...input.end },
    width: input.width ?? 1.2,
    totalRise,
    stepCount: input.stepCount ?? 18,
    position: { ...position },
    length,
    height: totalRise,
    connectorId: input.connectorId,
    metadata: createEntityMetadata('STAIR', input.metadata),
  }
}

export interface ElevatorInput extends CommonInput {
  center: Vec2
  width?: number
  depth?: number
  height?: number
  connectorId?: string
}

export function makeElevator(floorId: string, input: ElevatorInput): Elevator {
  const position = input.position ?? { x: input.center.x, y: 0, z: input.center.z }
  return {
    id: input.id ?? createId(),
    kind: 'elevator',
    floorId,
    name: input.name ?? '电梯',
    visible: input.visible ?? true,
    locked: input.locked ?? false,
    transform: { position: origin(), rotationY: input.rotationY ?? 0 },
    center: { ...input.center },
    position: { ...position },
    width: input.width ?? 2.2,
    depth: input.depth ?? 2,
    height: input.height ?? 3.6,
    connectorId: input.connectorId,
    metadata: createEntityMetadata('ELEVATOR', input.metadata),
  }
}
