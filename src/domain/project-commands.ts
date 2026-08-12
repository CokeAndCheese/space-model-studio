import {
  RENDER_TYPE_BY_KIND,
  type Building,
  type Direction,
  type Entity,
  type EntityMetadata,
  type Floor,
  type FloorType,
  type Project,
  type Vec2,
  type Vec3,
  type Wall,
} from './contract'
import { createProjectCommand, type ProjectCommand } from './command-stack'
import { createId } from './entity-factory'
import { createBuilding, createFloor, createProject } from './project-factory'
import { projectSchema } from './project-schema'
import { computeEntityDirection } from '../metadata/semantic-generator'
import { allocateNextSequence, generateEntitySid, sidGroupKey } from '../metadata/sid-generator'

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly targetId?: string,
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

export interface EntityLocation {
  building: Building
  floor: Floor
  entity: Entity
  buildingIndex: number
  floorIndex: number
  entityIndex: number
}

export interface FloorLocation {
  building: Building
  floor: Floor
  buildingIndex: number
  floorIndex: number
}

export function findFloorLocation(project: Project, floorId: string): FloorLocation | undefined {
  for (let buildingIndex = 0; buildingIndex < project.buildings.length; buildingIndex += 1) {
    const building = project.buildings[buildingIndex]!
    const floorIndex = building.floors.findIndex((floor) => floor.id === floorId)
    if (floorIndex >= 0) return { building, floor: building.floors[floorIndex]!, buildingIndex, floorIndex }
  }
  return undefined
}

export function findEntityLocation(project: Project, entityId: string): EntityLocation | undefined {
  for (let buildingIndex = 0; buildingIndex < project.buildings.length; buildingIndex += 1) {
    const building = project.buildings[buildingIndex]!
    for (let floorIndex = 0; floorIndex < building.floors.length; floorIndex += 1) {
      const floor = building.floors[floorIndex]!
      const entityIndex = floor.entities.findIndex((entity) => entity.id === entityId)
      if (entityIndex >= 0) return { building, floor, entity: floor.entities[entityIndex]!, buildingIndex, floorIndex, entityIndex }
    }
  }
  return undefined
}

function cloneForMutation(project: Project): Project {
  return structuredClone(project)
}

function commit(project: Project): Project {
  project.updatedAt = new Date().toISOString()
  return projectSchema.parse(project) as Project
}

function withMutation(project: Project, mutation: (draft: Project) => void): Project {
  const draft = cloneForMutation(project)
  mutation(draft)
  return commit(draft)
}

function requireBuilding(project: Project, buildingId: string): Building {
  const building = project.buildings.find((candidate) => candidate.id === buildingId)
  if (!building) throw new DomainError('BUILDING_NOT_FOUND', `未找到楼栋 ${buildingId}`, buildingId)
  return building
}

function requireFloor(project: Project, floorId: string): FloorLocation {
  const location = findFloorLocation(project, floorId)
  if (!location) throw new DomainError('FLOOR_NOT_FOUND', `未找到楼层 ${floorId}`, floorId)
  return location
}

function requireEntity(project: Project, entityId: string): EntityLocation {
  const location = findEntityLocation(project, entityId)
  if (!location) throw new DomainError('ENTITY_NOT_FOUND', `未找到实体 ${entityId}`, entityId)
  return location
}

function wallLength(wall: Wall): number {
  return Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z)
}

function refreshAutoDirectionAndSid(project: Project, entity: Entity, floor: Floor): void {
  if (entity.metadata.directionMode === 'auto' && entity.metadata.renderType !== 'CEILING') {
    entity.metadata.direction = computeEntityDirection(project, entity.id).direction
  }
  if (entity.metadata.sidMode === 'auto') {
    try {
      entity.metadata.sid = generateEntitySid(entity, floor)
    } catch {
      entity.metadata.sid = undefined
    }
  }
}

function refreshFloorSids(project: Project, floor: Floor): void {
  for (const entity of floor.entities) refreshAutoDirectionAndSid(project, entity, floor)
}

export type HierarchySelection =
  | { type: 'project'; id: string }
  | { type: 'building'; id: string }
  | { type: 'floor'; id: string }

export type HierarchyDeleteTarget = HierarchySelection

export interface HierarchyDeleteResult {
  project: Project
  selection: HierarchySelection
  currentBuildingId: string
  currentFloorId: string
  /** Entity selection is always cleared after deleting a non-entity hierarchy node. */
  selectedIds: string[]
  fallbackBuildingId: string
  fallbackFloorId: string
  replacementCreated: boolean
  removedIds: {
    projectIds: string[]
    buildingIds: string[]
    floorIds: string[]
    entityIds: string[]
  }
}

export interface DeleteProjectOptions {
  name?: string
}

function collectFloorRemoval(floor: Floor): HierarchyDeleteResult['removedIds'] {
  return { projectIds: [], buildingIds: [], floorIds: [floor.id], entityIds: floor.entities.map((entity) => entity.id) }
}

function collectBuildingRemoval(building: Building): HierarchyDeleteResult['removedIds'] {
  return {
    projectIds: [],
    buildingIds: [building.id],
    floorIds: building.floors.map((floor) => floor.id),
    entityIds: building.floors.flatMap((floor) => floor.entities.map((entity) => entity.id)),
  }
}

function uniqueReplacementFloorName(project: Project, building: Building): string {
  const used = new Set(project.buildings.flatMap((item) => item.floors.map((floor) => floor.floorName)))
  const base = `${building.code}_1F`
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(`${base}_${suffix}`)) suffix += 1
  return `${base}_${suffix}`
}

function appendReplacementFloor(project: Project, building: Building): Floor {
  const floor = createFloor({
    buildingId: building.id,
    buildingCode: building.code,
    floorName: uniqueReplacementFloorName(project, building),
    name: `${building.name}1层`,
    level: 1,
    floorType: 'FLOOR',
    elevation: 0,
    clearHeight: 3.6,
  })
  building.floors.push(floor)
  return floor
}

function appendReplacementBuilding(project: Project): { building: Building; floor: Floor } {
  const building = createBuilding('A', 'A栋')
  project.buildings.push(building)
  return { building, floor: appendReplacementFloor(project, building) }
}

function ensureEditableFloors(project: Project): boolean {
  let created = false
  for (const building of project.buildings) {
    if (building.floors.length === 0) {
      appendReplacementFloor(project, building)
      created = true
    }
  }
  return created
}

function hierarchyResult(
  project: Project,
  selection: HierarchySelection,
  building: Building,
  floor: Floor,
  replacementCreated: boolean,
  removedIds: HierarchyDeleteResult['removedIds'],
): HierarchyDeleteResult {
  const checked = commit(project)
  return {
    project: checked,
    selection,
    currentBuildingId: building.id,
    currentFloorId: floor.id,
    selectedIds: [],
    fallbackBuildingId: building.id,
    fallbackFloorId: floor.id,
    replacementCreated,
    removedIds,
  }
}

/** Cascades a floor and guarantees the owning building still has an editable floor. */
export function deleteFloorHierarchy(project: Project, floorId: string): HierarchyDeleteResult {
  const draft = cloneForMutation(project)
  const location = requireFloor(draft, floorId)
  const removedIds = collectFloorRemoval(location.floor)
  location.building.floors.splice(location.floorIndex, 1)
  let replacementCreated = false
  let fallback = location.building.floors[Math.min(location.floorIndex, location.building.floors.length - 1)]
  if (!fallback) {
    fallback = appendReplacementFloor(draft, location.building)
    replacementCreated = true
  }
  replacementCreated = ensureEditableFloors(draft) || replacementCreated
  return hierarchyResult(draft, { type: 'floor', id: fallback.id }, location.building, fallback, replacementCreated, removedIds)
}

/** Cascades a building and guarantees the project still has a building with a floor. */
export function deleteBuildingHierarchy(project: Project, buildingId: string): HierarchyDeleteResult {
  const draft = cloneForMutation(project)
  const buildingIndex = draft.buildings.findIndex((building) => building.id === buildingId)
  if (buildingIndex < 0) throw new DomainError('BUILDING_NOT_FOUND', `未找到楼栋 ${buildingId}`, buildingId)
  const removed = draft.buildings[buildingIndex]!
  const removedIds = collectBuildingRemoval(removed)
  draft.buildings.splice(buildingIndex, 1)
  let replacementCreated = false
  let fallback = draft.buildings[Math.min(buildingIndex, draft.buildings.length - 1)]
  let fallbackFloor: Floor
  if (!fallback) {
    const replacement = appendReplacementBuilding(draft)
    fallback = replacement.building
    fallbackFloor = replacement.floor
    replacementCreated = true
  } else {
    replacementCreated = ensureEditableFloors(draft)
    fallbackFloor = fallback.floors[0]!
  }
  return hierarchyResult(draft, { type: 'building', id: fallback.id }, fallback, fallbackFloor, replacementCreated, removedIds)
}

/** Replaces the whole source with a fresh editable project; the old object is untouched. */
export function deleteProjectHierarchy(project: Project, options: DeleteProjectOptions = {}): HierarchyDeleteResult {
  if (project.projectId.length === 0) throw new DomainError('PROJECT_NOT_FOUND', '项目 ID 不能为空')
  const removedIds: HierarchyDeleteResult['removedIds'] = {
    projectIds: [project.projectId],
    buildingIds: project.buildings.map((building) => building.id),
    floorIds: project.buildings.flatMap((building) => building.floors.map((floor) => floor.id)),
    entityIds: project.buildings.flatMap((building) => building.floors.flatMap((floor) => floor.entities.map((entity) => entity.id))),
  }
  const replacement = createProject({ name: options.name ?? '未命名建筑项目' })
  const { building, floor } = appendReplacementBuilding(replacement)
  return hierarchyResult(replacement, { type: 'project', id: replacement.projectId }, building, floor, true, removedIds)
}

export function deleteHierarchyNode(
  project: Project,
  target: HierarchyDeleteTarget,
  options: DeleteProjectOptions = {},
): HierarchyDeleteResult {
  if (target.type === 'floor') return deleteFloorHierarchy(project, target.id)
  if (target.type === 'building') return deleteBuildingHierarchy(project, target.id)
  if (target.id !== project.projectId) throw new DomainError('PROJECT_NOT_FOUND', `未找到项目 ${target.id}`, target.id)
  return deleteProjectHierarchy(project, options)
}

export interface AddBuildingInput {
  id?: string
  code: string
  name?: string
}

export function addBuilding(project: Project, input: Building | AddBuildingInput): Project {
  return withMutation(project, (draft) => {
    const building: Building = 'floors' in input ? structuredClone(input) : createBuilding(input.code, input.name ?? `${input.code}栋`)
    if ('id' in input && input.id) building.id = input.id
    if (draft.buildings.some((candidate) => candidate.id === building.id)) throw new DomainError('DUPLICATE_BUILDING_ID', '楼栋 ID 已存在', building.id)
    if (draft.buildings.some((candidate) => candidate.code === building.code)) throw new DomainError('DUPLICATE_BUILDING_CODE', '楼栋 code 已存在', building.code)
    draft.buildings.push(building)
  })
}

export function updateBuilding(project: Project, buildingId: string, patch: Partial<Pick<Building, 'code' | 'name'>>): Project {
  return withMutation(project, (draft) => {
    const building = requireBuilding(draft, buildingId)
    if (patch.code && draft.buildings.some((candidate) => candidate.id !== buildingId && candidate.code === patch.code)) {
      throw new DomainError('DUPLICATE_BUILDING_CODE', '楼栋 code 已存在', patch.code)
    }
    Object.assign(building, patch)
  })
}

export function removeBuilding(project: Project, buildingId: string): Project {
  return deleteBuildingHierarchy(project, buildingId).project
}

export interface AddFloorInput {
  id?: string
  floorName?: string
  name?: string
  level?: number | null
  floorType?: FloorType
  elevation?: number
  clearHeight?: number
}

export function addFloor(project: Project, buildingId: string, input: Floor | AddFloorInput = {}): Project {
  return withMutation(project, (draft) => {
    const building = requireBuilding(draft, buildingId)
    let floor: Floor
    if ('entities' in input) {
      floor = structuredClone(input)
      if (floor.buildingId !== null) floor.buildingId = building.id
    } else {
      const candidateLevel = input.level ?? Math.max(0, ...building.floors.map((item) => item.level ?? 0)) + 1
      floor = createFloor({
        buildingId,
        buildingCode: building.code,
        floorName: input.floorName,
        name: input.name,
        level: candidateLevel,
        floorType: input.floorType,
        elevation: input.elevation,
        clearHeight: input.clearHeight,
      })
      if (input.id) floor.id = input.id
    }
    if (draft.buildings.some((item) => item.floors.some((candidate) => candidate.id === floor.id))) {
      throw new DomainError('DUPLICATE_FLOOR_ID', '楼层 ID 已存在', floor.id)
    }
    if (draft.buildings.some((item) => item.floors.some((candidate) => candidate.floorName === floor.floorName))) {
      throw new DomainError('DUPLICATE_FLOOR_NAME', '楼层 floorName 已存在', floor.floorName)
    }
    building.floors.push(floor)
  })
}

export type FloorPatch = Partial<Pick<Floor, 'floorName' | 'name' | 'level' | 'floorType' | 'elevation' | 'clearHeight'>>

export function updateFloor(project: Project, floorId: string, patch: FloorPatch): Project {
  return withMutation(project, (draft) => {
    const { floor } = requireFloor(draft, floorId)
    if (patch.floorName && patch.floorName !== floor.floorName) {
      const duplicate = draft.buildings.some((building) => building.floors.some((candidate) => candidate.id !== floorId && candidate.floorName === patch.floorName))
      if (duplicate) throw new DomainError('DUPLICATE_FLOOR_NAME', '楼层 floorName 已存在', patch.floorName)
      const manualSidEntity = floor.entities.find((entity) => entity.metadata.sidMode === 'manual')
      if (manualSidEntity) {
        throw new DomainError('MANUAL_SID_FLOOR_RENAME', '楼层包含人工 SID，请先切换为自动 SID 再重命名', manualSidEntity.id)
      }
    }
    Object.assign(floor, patch)
    refreshFloorSids(draft, floor)
  })
}

export function removeFloor(project: Project, floorId: string): Project {
  return deleteFloorHierarchy(project, floorId).project
}

export interface DuplicateFloorTarget extends AddFloorInput {
  buildingId?: string
}

export function duplicateFloor(project: Project, floorId: string, target: DuplicateFloorTarget = {}): Project {
  return withMutation(project, (draft) => {
    const source = requireFloor(draft, floorId)
    const targetBuilding = requireBuilding(draft, target.buildingId ?? source.building.id)
    const level = target.level ?? Math.max(0, ...targetBuilding.floors.map((floor) => floor.level ?? 0)) + 1
    const floorName = target.floorName ?? `${targetBuilding.code}_${level}F`
    if (draft.buildings.some((building) => building.floors.some((floor) => floor.floorName === floorName))) {
      throw new DomainError('DUPLICATE_FLOOR_NAME', '目标 floorName 已存在', floorName)
    }

    const copy = structuredClone(source.floor)
    copy.id = target.id ?? createId()
    copy.buildingId = targetBuilding.id
    copy.floorName = floorName
    copy.name = target.name ?? `${targetBuilding.name}${level}层`
    copy.level = level
    copy.floorType = target.floorType ?? source.floor.floorType
    copy.elevation = target.elevation ?? source.floor.elevation + (level - (source.floor.level ?? 0)) * (source.floor.clearHeight + 0.6)
    copy.clearHeight = target.clearHeight ?? source.floor.clearHeight

    const idMap = new Map<string, string>()
    for (const entity of copy.entities) idMap.set(entity.id, createId())
    for (const entity of copy.entities) {
      const previousId = entity.id
      entity.id = idMap.get(previousId)!
      entity.floorId = copy.id
      entity.metadata.sidMode = 'auto'
      entity.metadata.manualSid = undefined
      entity.metadata.sid = undefined
      if (entity.kind === 'wall') entity.openings = entity.openings.map((id) => idMap.get(id) ?? id)
      if (entity.kind === 'door' || entity.kind === 'window') entity.hostWallId = idMap.get(entity.hostWallId) ?? entity.hostWallId
    }
    targetBuilding.floors.push(copy)
    refreshFloorSids(draft, copy)
  })
}

export interface UpdateEntityOptions {
  source?: 'user' | 'system'
}

export interface EntityPatch {
  name?: string
  visible?: boolean
  locked?: boolean
  transform?: { position?: Partial<Vec3>; rotationY?: number }
  metadata?: Partial<EntityMetadata>
  start?: Vec2
  end?: Vec2
  baseOffset?: number
  height?: number
  thickness?: number
  hostWallId?: string
  offset?: number
  width?: number
  depth?: number
  sillHeight?: number
  polygon?: Vec2[]
  spaceType?: Extract<Entity, { kind: 'space' }>['spaceType']
  facilityShape?: Extract<Entity, { kind: 'facility' }>['facilityShape']
  size?: Extract<Entity, { kind: 'facility' }>['size']
  position?: Vec3
  mountHeight?: number
  fireType?: Extract<Entity, { kind: 'facility' }>['fireType']
  totalRise?: number
  stepCount?: number
  length?: number
  center?: Vec2
}

function moveByTransform(entity: Entity, positionPatch: Partial<Vec3>): void {
  const previous = entity.transform.position
  const next = { ...previous, ...positionPatch }
  const delta = { x: next.x - previous.x, y: next.y - previous.y, z: next.z - previous.z }
  entity.transform.position = next
  switch (entity.kind) {
    case 'wall':
      entity.start = { x: entity.start.x + delta.x, z: entity.start.z + delta.z }
      entity.end = { x: entity.end.x + delta.x, z: entity.end.z + delta.z }
      entity.baseOffset += delta.y
      break
    case 'slab':
    case 'ceiling':
    case 'space':
      entity.polygon = entity.polygon.map((point) => ({ x: point.x + delta.x, z: point.z + delta.z }))
      if (entity.kind === 'slab') entity.baseOffset += delta.y
      if (entity.kind === 'ceiling') entity.height += delta.y
      break
    case 'facility':
      entity.position = { ...next }
      entity.mountHeight = next.y
      break
    case 'stair':
      entity.start = { x: entity.start.x + delta.x, z: entity.start.z + delta.z }
      entity.end = { x: entity.end.x + delta.x, z: entity.end.z + delta.z }
      entity.position = { ...next }
      break
    case 'elevator':
      entity.center = { x: next.x, z: next.z }
      entity.position = { ...next }
      break
    case 'door':
    case 'window':
      // Hosted openings move by offset; transform is only a render projection.
      break
  }
}

function synchronizeAliases(entity: Entity, patch: EntityPatch): void {
  if (entity.kind === 'wall' && (patch.start || patch.end)) {
    entity.transform.position = {
      x: (entity.start.x + entity.end.x) / 2,
      y: entity.baseOffset,
      z: (entity.start.z + entity.end.z) / 2,
    }
    entity.transform.rotationY = Math.atan2(entity.end.z - entity.start.z, entity.end.x - entity.start.x)
  }
  if (entity.kind === 'facility' && patch.position) {
    entity.position = { ...patch.position }
    entity.transform.position = { ...patch.position }
    if (patch.mountHeight === undefined) entity.mountHeight = patch.position.y
  }
  if (entity.kind === 'stair') {
    if (patch.start || patch.end) {
      entity.length = Math.hypot(entity.end.x - entity.start.x, entity.end.z - entity.start.z)
      entity.position = { x: (entity.start.x + entity.end.x) / 2, y: entity.position.y, z: (entity.start.z + entity.end.z) / 2 }
      entity.transform.position = { ...entity.position }
    }
    if (patch.totalRise !== undefined) entity.height = patch.totalRise
    else if (patch.height !== undefined) entity.totalRise = patch.height
  }
  if (entity.kind === 'elevator') {
    if (patch.center) {
      entity.position = { ...entity.position, x: patch.center.x, z: patch.center.z }
      entity.transform.position = { ...entity.position }
    } else if (patch.position) {
      entity.center = { x: patch.position.x, z: patch.position.z }
      entity.transform.position = { ...patch.position }
    }
  }
}

function updateMetadata(entity: Entity, patch: Partial<EntityMetadata>, source: 'user' | 'system'): void {
  const allowed = { ...patch }
  if (source === 'system') {
    if (entity.metadata.renderTypeMode === 'manual') delete allowed.renderType
    if (entity.metadata.directionMode === 'manual') delete allowed.direction
    if (entity.metadata.sidMode === 'manual') {
      delete allowed.sid
      delete allowed.manualSid
    }
  }
  entity.metadata = { ...entity.metadata, ...allowed }
  if (entity.metadata.renderType !== RENDER_TYPE_BY_KIND[entity.kind]) {
    throw new DomainError('RENDER_TYPE_KIND_MISMATCH', `kind=${entity.kind} 不能使用 ${entity.metadata.renderType}`, entity.id)
  }
  if (source === 'user') {
    if (patch.renderType !== undefined && patch.renderTypeMode === undefined) entity.metadata.renderTypeMode = 'manual'
    if (patch.direction !== undefined && patch.directionMode === undefined) entity.metadata.directionMode = 'manual'
    if ((patch.sid !== undefined || patch.manualSid !== undefined) && patch.sidMode === undefined) entity.metadata.sidMode = 'manual'
    if (patch.renderType !== undefined || patch.direction !== undefined || patch.sid !== undefined || patch.manualSid !== undefined) {
      entity.metadata.confidence = 'confirmed'
    }
  }
}

export function addEntity(project: Project, floorId: string, input: Entity): Project {
  return withMutation(project, (draft) => {
    const { floor } = requireFloor(draft, floorId)
    const entity = structuredClone(input)
    if (findEntityLocation(draft, entity.id)) throw new DomainError('DUPLICATE_ENTITY_ID', '实体 ID 已存在', entity.id)
    entity.floorId = floor.id
    if (entity.kind === 'door' || entity.kind === 'window') {
      const host = floor.entities.find((candidate) => candidate.id === entity.hostWallId)
      if (!host || host.kind !== 'wall') throw new DomainError('HOST_WALL_NOT_FOUND', '门窗必须宿主于同楼层墙体', entity.hostWallId)
      host.openings.push(entity.id)
    }
    floor.entities.push(entity)
    refreshAutoDirectionAndSid(draft, entity, floor)
    const siblings = floor.entities.filter((candidate) => candidate.id !== entity.id)
    if (siblings.some((candidate) => sidGroupKey(candidate) === sidGroupKey(entity) && candidate.metadata.sequence === entity.metadata.sequence)) {
      entity.metadata.sequence = allocateNextSequence({ ...floor, entities: siblings }, entity)
      refreshAutoDirectionAndSid(draft, entity, floor)
    }
  })
}

export function updateEntity(
  project: Project,
  entityId: string,
  patch: EntityPatch,
  options: UpdateEntityOptions = {},
): Project {
  return withMutation(project, (draft) => {
    const location = requireEntity(draft, entityId)
    const entity = location.entity
    if (entity.locked && !(Object.keys(patch).every((key) => key === 'locked' || key === 'visible'))) {
      throw new DomainError('ENTITY_LOCKED', '实体已锁定，不能修改', entityId)
    }
    const oldHostId = entity.kind === 'door' || entity.kind === 'window' ? entity.hostWallId : undefined
    if (patch.transform?.position) moveByTransform(entity, patch.transform.position)
    if (patch.transform?.rotationY !== undefined) entity.transform.rotationY = patch.transform.rotationY

    const { metadata, transform, ...flatPatch } = patch
    Object.assign(entity, flatPatch)
    if (metadata) updateMetadata(entity, metadata, options.source ?? 'user')
    synchronizeAliases(entity, patch)

    if ((entity.kind === 'door' || entity.kind === 'window') && entity.hostWallId !== oldHostId) {
      const oldHost = location.floor.entities.find((candidate) => candidate.id === oldHostId)
      if (oldHost?.kind === 'wall') oldHost.openings = oldHost.openings.filter((id) => id !== entity.id)
      const newHost = location.floor.entities.find((candidate) => candidate.id === entity.hostWallId)
      if (!newHost || newHost.kind !== 'wall') throw new DomainError('HOST_WALL_NOT_FOUND', '新宿主墙不存在', entity.hostWallId)
      newHost.openings.push(entity.id)
    }
    refreshAutoDirectionAndSid(draft, entity, location.floor)
  })
}

export interface RemoveEntityOptions {
  cascadeOpenings?: boolean
}

export function removeEntity(project: Project, entityId: string, options: RemoveEntityOptions = {}): Project {
  return withMutation(project, (draft) => {
    const location = requireEntity(draft, entityId)
    if (location.entity.locked) throw new DomainError('ENTITY_LOCKED', '实体已锁定，不能删除', entityId)
    if (location.entity.kind === 'wall' && location.entity.openings.length > 0) {
      if (!options.cascadeOpenings) {
        throw new DomainError('WALL_HAS_OPENINGS', '墙体包含门窗，删除时必须明确 cascadeOpenings', entityId)
      }
      const openingIds = new Set(location.entity.openings)
      location.floor.entities = location.floor.entities.filter((entity) => !openingIds.has(entity.id) && entity.id !== entityId)
      return
    }
    const entity = location.entity
    if (entity.kind === 'door' || entity.kind === 'window') {
      const hostWallId = entity.hostWallId
      const host = location.floor.entities.find((candidate) => candidate.id === hostWallId)
      if (host?.kind === 'wall') host.openings = host.openings.filter((id) => id !== entityId)
    }
    location.floor.entities.splice(location.entityIndex, 1)
  })
}

export const projectCommands = {
  deleteProject: (options: DeleteProjectOptions = {}): ProjectCommand =>
    createProjectCommand('删除项目', (project) => deleteProjectHierarchy(project, options).project),
  deleteHierarchyNode: (target: HierarchyDeleteTarget, options: DeleteProjectOptions = {}): ProjectCommand =>
    createProjectCommand('删除层级节点', (project) => deleteHierarchyNode(project, target, options).project),
  addBuilding: (input: Building | AddBuildingInput): ProjectCommand => createProjectCommand('新增楼栋', (project) => addBuilding(project, input)),
  updateBuilding: (buildingId: string, patch: Partial<Pick<Building, 'code' | 'name'>>): ProjectCommand =>
    createProjectCommand('修改楼栋', (project) => updateBuilding(project, buildingId, patch)),
  removeBuilding: (buildingId: string): ProjectCommand => createProjectCommand('删除楼栋', (project) => removeBuilding(project, buildingId)),
  addFloor: (buildingId: string, input: Floor | AddFloorInput = {}): ProjectCommand =>
    createProjectCommand('新增楼层', (project) => addFloor(project, buildingId, input)),
  updateFloor: (floorId: string, patch: FloorPatch): ProjectCommand => createProjectCommand('修改楼层', (project) => updateFloor(project, floorId, patch)),
  removeFloor: (floorId: string): ProjectCommand => createProjectCommand('删除楼层', (project) => removeFloor(project, floorId)),
  duplicateFloor: (floorId: string, target: DuplicateFloorTarget = {}): ProjectCommand =>
    createProjectCommand('复制楼层', (project) => duplicateFloor(project, floorId, target)),
  addEntity: (floorId: string, entity: Entity): ProjectCommand => createProjectCommand('创建实体', (project) => addEntity(project, floorId, entity)),
  updateEntity: (entityId: string, patch: EntityPatch, options: UpdateEntityOptions = {}): ProjectCommand =>
    createProjectCommand('修改实体', (project) => updateEntity(project, entityId, patch, options)),
  removeEntity: (entityId: string, options: RemoveEntityOptions = {}): ProjectCommand =>
    createProjectCommand('删除实体', (project) => removeEntity(project, entityId, options)),
}

export function projectDirectionPatch(direction: Direction): EntityPatch {
  return { metadata: { direction, directionMode: 'manual', confidence: 'confirmed' } }
}

export function currentWallLength(project: Project, wallId: string): number {
  const location = requireEntity(project, wallId)
  if (location.entity.kind !== 'wall') throw new DomainError('NOT_A_WALL', '实体不是墙体', wallId)
  return wallLength(location.entity)
}
