/**
 * Space Model Studio's persisted domain contract.
 *
 * This module deliberately contains data only. Rendering objects are projections of
 * these records and must never become the source of truth.
 */
export const PROJECT_SCHEMA_VERSION = '1.0.0' as const
export const METADATA_SPEC_VERSION = '3.3-semantic' as const

export const RENDER_TYPES = [
  'WINDOW',
  'DOOR',
  'ELEVATOR',
  'STAIR',
  'CEILING',
  'WALL',
  'SPACE',
  'FACILITY',
] as const

export const FLOOR_TYPES = [
  'FLOOR',
  'TOWER',
  'ROOF',
  'BASEMENT',
  'LANDSCAPE_TERRAIN',
  'LANDSCAPE_FACADE',
  'FACILITY',
] as const

export const DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const
export const CONFIDENCE_LEVELS = ['confirmed', 'imported', 'inferred-high', 'inferred-low'] as const
export const SPACE_TYPES = [
  'TOILET',
  'LAUNDRY',
  'KITCHEN',
  'OFFICE',
  'MEETING_ROOM',
  'BEDROOM',
  'CORRIDOR',
  'STAIRWELL',
  'ELEVATOR_HALL',
  'MECHANICAL_ROOM',
  'STORAGE',
  'LOBBY',
  'BALCONY',
] as const
export const FIRE_TYPES = [
  'HYDRANT',
  'SMOKE_DETECTOR',
  'SPRINKLER',
  'EXTINGUISHER',
  'EMERGENCY_LIGHT',
  'EXIT_SIGN',
  'BREAK_GLASS',
  'ALARM_BELL',
  'FIRE_HOSE',
  'FIRE_DOOR',
  'OTHER',
] as const
export const FACILITY_SHAPES = ['box', 'cylinder', 'icon'] as const

export type RenderType = (typeof RENDER_TYPES)[number]
export type FloorType = (typeof FLOOR_TYPES)[number]
export type Direction = (typeof DIRECTIONS)[number]
export type Confidence = (typeof CONFIDENCE_LEVELS)[number]
export type SpaceType = (typeof SPACE_TYPES)[number]
export type FireType = (typeof FIRE_TYPES)[number]
export type FacilityShape = (typeof FACILITY_SHAPES)[number]
export type EntityKind =
  | 'wall'
  | 'slab'
  | 'ceiling'
  | 'door'
  | 'window'
  | 'space'
  | 'facility'
  | 'stair'
  | 'elevator'

export interface Vec2 {
  x: number
  z: number
}

export interface Vec3 extends Vec2 {
  y: number
}

export interface EntityTransform {
  position: Vec3
  rotationY: number
}

export interface EntityMetadata {
  renderType: RenderType
  confidence: Confidence
  sidMode: 'auto' | 'manual'
  directionMode: 'auto' | 'manual'
  /** Whether renderType was explicitly selected by a human. */
  renderTypeMode: 'auto' | 'manual'
  /** Optional semantic direction. WALL and SPACE never require it. */
  direction?: Direction
  sequence: number
  /** Persisted SID preview. Auto SIDs are regenerated from semantic fields. */
  sid?: string
  /** Explicit human SID. It is required when sidMode is manual. */
  manualSid?: string
  /** CEILING subtype, for example LOWER, UPPER or SLAB_01. */
  sub?: string
}

export interface BaseEntity {
  id: string
  kind: EntityKind
  floorId: string
  name: string
  visible: boolean
  locked: boolean
  transform: EntityTransform
  metadata: EntityMetadata
}

export interface Wall extends BaseEntity {
  kind: 'wall'
  start: Vec2
  end: Vec2
  baseOffset: number
  height: number
  thickness: number
  /** IDs of Door and Window entities hosted by this wall. */
  openings: string[]
}

export interface Door extends BaseEntity {
  kind: 'door'
  hostWallId: string
  /** Distance in metres from wall start to opening centre. */
  offset: number
  width: number
  height: number
  depth: number
  sillHeight: 0
}

export interface WindowEntity extends BaseEntity {
  kind: 'window'
  hostWallId: string
  offset: number
  width: number
  height: number
  depth: number
  sillHeight: number
}

export type Window = WindowEntity

export interface Slab extends BaseEntity {
  kind: 'slab'
  polygon: Vec2[]
  baseOffset: number
  thickness: number
}

export interface Ceiling extends BaseEntity {
  kind: 'ceiling'
  polygon: Vec2[]
  /** Bottom elevation relative to the floor elevation. */
  height: number
  thickness: number
}

export interface Space extends BaseEntity {
  kind: 'space'
  polygon: Vec2[]
  height: number
  spaceType: SpaceType
}

export interface Facility extends BaseEntity {
  kind: 'facility'
  facilityShape: FacilityShape
  size: {
    width: number
    height: number
    depth: number
  }
  position: Vec3
  /** Mount height retained separately for editor controls. */
  mountHeight: number
  fireType: FireType
}

export interface Stair extends BaseEntity {
  kind: 'stair'
  start: Vec2
  end: Vec2
  width: number
  totalRise: number
  stepCount: number
  /** Editor-friendly aliases kept in sync by domain factories/commands. */
  position: Vec3
  length: number
  height: number
}

export interface Elevator extends BaseEntity {
  kind: 'elevator'
  center: Vec2
  /** Editor-friendly alias of center plus vertical position. */
  position: Vec3
  width: number
  depth: number
  height: number
}

export type OpeningEntity = Door | WindowEntity
export type PolygonEntity = Slab | Ceiling | Space
export type Entity =
  | Wall
  | Slab
  | Ceiling
  | Door
  | WindowEntity
  | Space
  | Facility
  | Stair
  | Elevator

export interface Floor {
  id: string
  buildingId: string | null
  floorName: string
  name: string
  level: number | null
  floorType: FloorType
  elevation: number
  clearHeight: number
  entities: Entity[]
}

export interface Building {
  id: string
  code: string
  name: string
  floors: Floor[]
}

export interface ProjectSettings {
  unit: 'm'
  upAxis: '+Y'
  north: Vec2
  gridSize: number
  snapEnabled: boolean
}

export interface Project {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION
  metadataSpecVersion: typeof METADATA_SPEC_VERSION
  projectId: string
  name: string
  settings: ProjectSettings
  buildings: Building[]
  createdAt: string
  updatedAt: string
}

export const RENDER_TYPE_BY_KIND: Readonly<Record<EntityKind, RenderType>> = {
  wall: 'WALL',
  slab: 'CEILING',
  ceiling: 'CEILING',
  door: 'DOOR',
  window: 'WINDOW',
  space: 'SPACE',
  facility: 'FACILITY',
  stair: 'STAIR',
  elevator: 'ELEVATOR',
}
