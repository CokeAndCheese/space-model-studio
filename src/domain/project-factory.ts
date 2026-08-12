import {
  METADATA_SPEC_VERSION,
  PROJECT_SCHEMA_VERSION,
  type Building,
  type Direction,
  type Door,
  type Floor,
  type FloorType,
  type Project,
  type Wall,
  type WindowEntity,
} from './contract'
import {
  createId,
  makeCeiling,
  makeDoor,
  makeElevator,
  makeFacility,
  makeSlab,
  makeSpace,
  makeStair,
  makeWall,
  makeWindow,
} from './entity-factory'

const now = (): string => new Date().toISOString()

export interface CreateProjectOptions {
  name?: string
  north?: { x: number; z: number }
  gridSize?: number
  snapEnabled?: boolean
}

export function createProject(options: string | CreateProjectOptions = {}): Project {
  const normalized = typeof options === 'string' ? { name: options } : options
  const timestamp = now()
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    metadataSpecVersion: METADATA_SPEC_VERSION,
    projectId: createId(),
    name: normalized.name ?? 'Demo Hospital',
    settings: {
      unit: 'm',
      upAxis: '+Y',
      north: normalized.north ? { ...normalized.north } : { x: 0, z: -1 },
      gridSize: normalized.gridSize ?? 0.1,
      snapEnabled: normalized.snapEnabled ?? true,
    },
    buildings: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

export function createBuilding(code = 'A', name = `${code}栋`): Building {
  return { id: createId(), code, name, floors: [] }
}

export interface CreateFloorOptions {
  buildingId: string | null
  buildingCode?: string
  floorName?: string
  name?: string
  level?: number | null
  floorType?: FloorType
  elevation?: number
  clearHeight?: number
}

export function createFloor(buildingId: string, code?: string, level?: number): Floor
export function createFloor(options: CreateFloorOptions): Floor
export function createFloor(
  buildingOrOptions: string | CreateFloorOptions,
  code = 'A',
  level = 1,
): Floor {
  const options: CreateFloorOptions =
    typeof buildingOrOptions === 'string'
      ? { buildingId: buildingOrOptions, buildingCode: code, level }
      : buildingOrOptions
  const floorLevel = options.level === undefined ? 1 : options.level
  const buildingCode = options.buildingCode ?? code
  const floorName = options.floorName ?? `${buildingCode}_${floorLevel ?? 'L'}F`
  const landscape = options.floorType === 'LANDSCAPE_TERRAIN' || options.floorType === 'LANDSCAPE_FACADE'
  return {
    id: createId(),
    buildingId: landscape ? null : options.buildingId,
    floorName,
    name: options.name ?? `${buildingCode}栋${floorLevel ?? '景观'}层`,
    level: landscape ? null : floorLevel,
    floorType: options.floorType ?? 'FLOOR',
    elevation: options.elevation ?? (typeof floorLevel === 'number' ? (floorLevel - 1) * 4.2 : 0),
    clearHeight: options.clearHeight ?? 3.6,
    entities: [],
  }
}

/** Backward-compatible convenience factories used by the first editor shell. */
export function createWall(
  floorId: string,
  name: string,
  start: { x: number; z: number },
  end: { x: number; z: number },
  direction: Direction,
  sequence: number,
): Wall {
  return makeWall(floorId, { name, start, end, metadata: { direction, sequence } })
}

export function createDoor(floorId: string, hostWallId: string): Door {
  return makeDoor(floorId, {
    hostWallId,
    name: '东侧主入口门',
    offset: 2,
    metadata: { direction: 'E', sequence: 1 },
  })
}

export function createWindow(floorId: string, hostWallId: string, sequence: number, offset: number): WindowEntity {
  return makeWindow(floorId, {
    hostWallId,
    name: `北侧窗户 ${sequence}`,
    offset,
    metadata: { direction: 'N', sequence },
  })
}

/** Compact seven-entity project retained as the fast editor fixture. */
export function createDemoProject(): Project {
  const project = createProject()
  const building = createBuilding()
  const floor = createFloor(building.id)
  const walls = [
    createWall(floor.id, '北侧外墙', { x: -6, z: -4 }, { x: 6, z: -4 }, 'N', 1),
    createWall(floor.id, '东侧外墙', { x: 6, z: -4 }, { x: 6, z: 4 }, 'E', 2),
    createWall(floor.id, '南侧外墙', { x: 6, z: 4 }, { x: -6, z: 4 }, 'S', 3),
    createWall(floor.id, '西侧外墙', { x: -6, z: 4 }, { x: -6, z: -4 }, 'W', 4),
  ]
  const door = createDoor(floor.id, walls[1]!.id)
  const firstWindow = createWindow(floor.id, walls[0]!.id, 1, 3.2)
  const secondWindow = createWindow(floor.id, walls[0]!.id, 2, 8.8)
  walls[0]!.openings = [firstWindow.id, secondWindow.id]
  walls[1]!.openings = [door.id]
  floor.entities = [...walls, door, firstWindow, secondWindow]
  building.floors = [floor]
  project.buildings = [building]
  return project
}

/** Full acceptance fixture containing every supported semantic entity kind. */
export function createDemoHospitalProject(): Project {
  const project = createDemoProject()
  const floor = project.buildings[0]!.floors[0]!
  const polygon = [
    { x: -6, z: -4 },
    { x: 6, z: -4 },
    { x: 6, z: 4 },
    { x: -6, z: 4 },
  ]
  floor.entities.push(
    makeSlab(floor.id, { name: '一层楼板', polygon }),
    makeCeiling(floor.id, { name: '一层天花', polygon, height: 3.5 }),
    makeSpace(floor.id, { name: '一层办公室', polygon: polygon.map(({ x, z }) => ({ x: x * 0.95, z: z * 0.95 })), spaceType: 'OFFICE', metadata: { direction: 'N', directionMode: 'manual' } }),
    makeFacility(floor.id, { name: '一层东侧消火栓', position: { x: 5.7, y: 0.8, z: 0 }, fireType: 'HYDRANT', metadata: { direction: 'E' } }),
    makeStair(floor.id, { name: '北侧楼梯', start: { x: -1, z: -2 }, end: { x: -1, z: 1 }, metadata: { direction: 'N' } }),
    makeElevator(floor.id, { name: '东侧电梯', center: { x: 2.5, z: 0 }, metadata: { direction: 'E' } }),
  )
  return project
}

export {
  makeCeiling as createCeiling,
  makeElevator as createElevator,
  makeFacility as createFacility,
  makeSlab as createSlab,
  makeSpace as createSpace,
  makeStair as createStair,
}
