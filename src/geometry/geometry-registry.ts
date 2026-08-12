import {
  BufferGeometry,
  Material,
  Mesh,
  MeshStandardMaterial,
  Vector3,
  type ColorRepresentation,
} from 'three'
import type {
  Entity,
  EntityKind,
  Floor,
  OpeningEntity,
  Wall,
} from '../domain/contract'
import { buildDoorGeometry } from './door-builder'
import { buildElevatorGeometry } from './elevator-builder'
import { assertFinite, GeometryBuildError } from './geometry-error'
import { buildFacilityGeometry } from './facility-builder'
import { buildCeilingGeometry, buildSlabGeometry } from './slab-builder'
import { buildSpaceGeometry } from './space-builder'
import { buildStairGeometry } from './stair-builder'
import { buildWallGeometry, computeWallSegments, resolveWallOpenings } from './wall-builder'
import { buildWindowGeometry } from './window-builder'

export interface EntityGeometryProjection {
  geometry: BufferGeometry
  position: Vector3
  rotationY: number
}

export interface GeometryBuildContext {
  entities: readonly Entity[]
  entityById: ReadonlyMap<string, Entity>
  floorElevation: number
}

export type EntityGeometryBuilder = (entity: Entity, context: GeometryBuildContext) => EntityGeometryProjection

export interface BuildEntityMeshOptions {
  /** Required for walls with openings and for hosted door/window entities. */
  entities?: readonly Entity[]
  /** Floor elevation is applied at Mesh level, preserving reusable entity geometry. */
  floorElevation?: number
  material?: Material | ((entity: Entity) => Material)
}

const COLORS: Readonly<Record<EntityKind, ColorRepresentation>> = {
  wall: 0x8c9bab,
  slab: 0x66717f,
  ceiling: 0xaeb9c5,
  door: 0xa8794f,
  window: 0x4da6c8,
  space: 0x42bfa5,
  facility: 0xe34f5f,
  stair: 0xa6aebb,
  elevator: 0x69798e,
}

function defaultMaterial(entity: Entity): Material {
  const transparent = entity.kind === 'space'
  return new MeshStandardMaterial({
    color: COLORS[entity.kind],
    roughness: 0.78,
    metalness: 0.04,
    transparent,
    opacity: transparent ? 0.28 : 1,
  })
}

function getTransform(entity: Entity) {
  const transform = entity.transform ?? { position: { x: 0, y: 0, z: 0 }, rotationY: 0 }
  assertFinite(transform.position.x, 'transform position.x', entity.id)
  assertFinite(transform.position.y, 'transform position.y', entity.id)
  assertFinite(transform.position.z, 'transform position.z', entity.id)
  assertFinite(transform.rotationY, 'transform rotationY', entity.id)
  return transform
}

function lineAngle(entity: Pick<Wall, 'start' | 'end'>): number {
  return -Math.atan2(entity.end.z - entity.start.z, entity.end.x - entity.start.x)
}

function findHostWall(opening: OpeningEntity, context: GeometryBuildContext): Wall {
  const host = context.entityById.get(opening.hostWallId)
  if (!host || host.kind !== 'wall') {
    throw new GeometryBuildError('MISSING_HOST', `Opening ${opening.id} has no wall host`, opening.id)
  }
  // This validates wall references, opening bounds and overlap even for a standalone opening build.
  computeWallSegments(host, resolveWallOpenings(host, context.entities))
  return host
}

function projectWall(entity: Wall, context: GeometryBuildContext): EntityGeometryProjection {
  const openings = resolveWallOpenings(entity, context.entities)
  const transform = getTransform(entity)
  return {
    geometry: buildWallGeometry(entity, openings),
    position: new Vector3(
      entity.start.x + transform.position.x,
      context.floorElevation + transform.position.y,
      entity.start.z + transform.position.z,
    ),
    rotationY: lineAngle(entity) + transform.rotationY,
  }
}

function projectOpening(
  entity: OpeningEntity,
  context: GeometryBuildContext,
): EntityGeometryProjection {
  const host = findHostWall(entity, context)
  const geometry = entity.kind === 'door' ? buildDoorGeometry(entity) : buildWindowGeometry(entity)
  const hostTransform = getTransform(host)
  const transform = getTransform(entity)
  const rotationY = lineAngle(host) + hostTransform.rotationY
  const offsetX = Math.cos(rotationY) * entity.offset
  const offsetZ = -Math.sin(rotationY) * entity.offset
  return {
    geometry,
    position: new Vector3(
      host.start.x + hostTransform.position.x + offsetX + transform.position.x,
      context.floorElevation +
        hostTransform.position.y +
        host.baseOffset +
        entity.sillHeight +
        entity.height / 2 +
        transform.position.y,
      host.start.z + hostTransform.position.z + offsetZ + transform.position.z,
    ),
    rotationY: rotationY + transform.rotationY,
  }
}

function projectPolygon(entity: Extract<Entity, { kind: 'slab' | 'ceiling' | 'space' }>, context: GeometryBuildContext) {
  const transform = getTransform(entity)
  const geometry =
    entity.kind === 'slab'
      ? buildSlabGeometry(entity)
      : entity.kind === 'ceiling'
        ? buildCeilingGeometry(entity)
        : buildSpaceGeometry(entity)
  return {
    geometry,
    position: new Vector3(
      transform.position.x,
      context.floorElevation + transform.position.y,
      transform.position.z,
    ),
    rotationY: transform.rotationY,
  }
}

function projectStair(entity: Extract<Entity, { kind: 'stair' }>, context: GeometryBuildContext) {
  const transform = getTransform(entity)
  assertFinite(entity.position.y, 'stair position.y', entity.id)
  return {
    geometry: buildStairGeometry(entity),
    position: new Vector3(
      entity.start.x + transform.position.x,
      context.floorElevation + entity.position.y + transform.position.y,
      entity.start.z + transform.position.z,
    ),
    rotationY: lineAngle(entity) + transform.rotationY,
  }
}

function projectElevator(entity: Extract<Entity, { kind: 'elevator' }>, context: GeometryBuildContext) {
  const transform = getTransform(entity)
  assertFinite(entity.center.x, 'elevator center.x', entity.id)
  assertFinite(entity.center.z, 'elevator center.z', entity.id)
  assertFinite(entity.position.y, 'elevator position.y', entity.id)
  return {
    geometry: buildElevatorGeometry(entity),
    position: new Vector3(
      entity.center.x + transform.position.x,
      context.floorElevation + entity.position.y + entity.height / 2 + transform.position.y,
      entity.center.z + transform.position.z,
    ),
    rotationY: transform.rotationY,
  }
}

function projectFacility(entity: Extract<Entity, { kind: 'facility' }>, context: GeometryBuildContext) {
  const transform = getTransform(entity)
  assertFinite(entity.position.x, 'facility position.x', entity.id)
  assertFinite(entity.position.y, 'facility position.y', entity.id)
  assertFinite(entity.position.z, 'facility position.z', entity.id)
  return {
    geometry: buildFacilityGeometry(entity),
    position: new Vector3(
      entity.position.x + transform.position.x,
      context.floorElevation + entity.mountHeight + entity.size.height / 2 + transform.position.y,
      entity.position.z + transform.position.z,
    ),
    rotationY: transform.rotationY,
  }
}

function expectKind<K extends EntityKind>(entity: Entity, kind: K): Extract<Entity, { kind: K }> {
  if (entity.kind !== kind) {
    throw new GeometryBuildError('UNSUPPORTED_ENTITY', `Expected ${kind}, received ${entity.kind}`, entity.id)
  }
  return entity as Extract<Entity, { kind: K }>
}

/** Public registry: exactly one projection builder exists for every Domain entity kind. */
export const geometryRegistry: Readonly<Record<EntityKind, EntityGeometryBuilder>> = Object.freeze({
  wall: (entity, context) => projectWall(expectKind(entity, 'wall'), context),
  slab: (entity, context) => projectPolygon(expectKind(entity, 'slab'), context),
  ceiling: (entity, context) => projectPolygon(expectKind(entity, 'ceiling'), context),
  space: (entity, context) => projectPolygon(expectKind(entity, 'space'), context),
  door: (entity, context) => {
    const door = expectKind(entity, 'door')
    return projectOpening(door, context)
  },
  window: (entity, context) => {
    const window = expectKind(entity, 'window')
    return projectOpening(window, context)
  },
  stair: (entity, context) => projectStair(expectKind(entity, 'stair'), context),
  elevator: (entity, context) => projectElevator(expectKind(entity, 'elevator'), context),
  facility: (entity, context) => projectFacility(expectKind(entity, 'facility'), context),
})

function createContext(entity: Entity, options: BuildEntityMeshOptions): GeometryBuildContext {
  const entities = options.entities ?? [entity]
  const entityById = new Map<string, Entity>()
  for (const item of entities) {
    if (entityById.has(item.id)) {
      throw new GeometryBuildError('UNSUPPORTED_ENTITY', `Duplicate entity id ${item.id}`, item.id)
    }
    entityById.set(item.id, item)
  }
  const floorElevation = options.floorElevation ?? 0
  assertFinite(floorElevation, 'floor elevation', entity.id)
  return { entities, entityById, floorElevation }
}

/** Project one semantic entity to exactly one THREE.Mesh, never a Group. */
export function buildEntityMesh(entity: Entity, options: BuildEntityMeshOptions = {}): Mesh<BufferGeometry, Material> {
  const context = createContext(entity, options)
  const builder = geometryRegistry[entity.kind]
  if (!builder) {
    throw new GeometryBuildError('UNSUPPORTED_ENTITY', `Unsupported entity kind: ${String(entity.kind)}`, entity.id)
  }
  const projection = builder(entity, context)
  const material = typeof options.material === 'function' ? options.material(entity) : options.material ?? defaultMaterial(entity)
  const mesh = new Mesh(projection.geometry, material)
  mesh.position.copy(projection.position)
  mesh.rotation.y = projection.rotationY
  mesh.name = entity.metadata.sid ?? entity.name
  mesh.visible = entity.visible
  mesh.userData.entityId = entity.id
  mesh.userData.kind = entity.kind
  mesh.userData.semanticEntity = true
  return mesh
}

export function buildEntityMeshes(
  entities: readonly Entity[],
  options: Omit<BuildEntityMeshOptions, 'entities'> = {},
): Array<Mesh<BufferGeometry, Material>> {
  return entities.map((entity) => buildEntityMesh(entity, { ...options, entities }))
}

export function buildFloorMeshes(
  floor: Floor,
  options: Omit<BuildEntityMeshOptions, 'entities' | 'floorElevation'> = {},
): Array<Mesh<BufferGeometry, Material>> {
  return buildEntityMeshes(floor.entities, { ...options, floorElevation: floor.elevation })
}
