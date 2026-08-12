import { describe, expect, it } from 'vitest'
import type { Direction, Floor, Project, Vec2 } from '../src/domain/contract'
import { makeCeiling, makeSlab, makeSpace, makeWall } from '../src/domain/entity-factory'
import { createBuilding, createFloor, createProject } from '../src/domain/project-factory'
import { generateEntitySid } from '../src/metadata/sid-generator'
import { generateMissingRoomEntities } from '../src/domain/room-generation'
import { validateProject } from '../src/validation/project-validator'

interface WallSpec {
  id: string
  start: Vec2
  end: Vec2
  direction: Direction
  sequence: number
}

function makeTestProject(specs: readonly WallSpec[]): { project: Project; floor: Floor } {
  const project = createProject({ name: 'Room generation test' })
  const building = createBuilding('A')
  const floor = createFloor({
    buildingId: building.id,
    buildingCode: building.code,
    floorName: 'A_1F',
    level: 1,
  })
  floor.entities = specs.map(({ id, start, end, direction }, index) => makeWall(floor.id, {
    name: id,
    start,
    end,
    metadata: { direction, directionMode: 'manual', sequence: index + 1 },
  }))
  building.floors = [floor]
  project.buildings = [building]
  return { project, floor }
}

const rectangle: readonly WallSpec[] = [
  { id: 'south', start: { x: 0, z: 0 }, end: { x: 4, z: 0 }, direction: 'N', sequence: 1 },
  { id: 'east', start: { x: 4, z: 0 }, end: { x: 4, z: 3 }, direction: 'E', sequence: 1 },
  { id: 'north', start: { x: 4, z: 3 }, end: { x: 0, z: 3 }, direction: 'S', sequence: 1 },
  { id: 'west', start: { x: 0, z: 3 }, end: { x: 0, z: 0 }, direction: 'W', sequence: 1 },
]

const adjacentRooms: readonly WallSpec[] = [
  { id: 'south', start: { x: 0, z: 0 }, end: { x: 4, z: 0 }, direction: 'N', sequence: 1 },
  { id: 'east', start: { x: 4, z: 0 }, end: { x: 4, z: 3 }, direction: 'E', sequence: 1 },
  { id: 'north', start: { x: 4, z: 3 }, end: { x: 0, z: 3 }, direction: 'S', sequence: 1 },
  { id: 'west', start: { x: 0, z: 3 }, end: { x: 0, z: 0 }, direction: 'W', sequence: 1 },
  { id: 'divider', start: { x: 2, z: 0 }, end: { x: 2, z: 3 }, direction: 'E', sequence: 2 },
]

function generatedKinds(floor: Floor): string[] {
  return floor.entities.filter((entity) => entity.kind !== 'wall').map((entity) => entity.kind)
}

describe('automatic room entity generation', () => {
  it('generates nothing for open walls', () => {
    const { floor } = makeTestProject(rectangle.slice(0, 3))

    const result = generateMissingRoomEntities(floor, { x: 0, z: -1 })

    expect(result.rooms).toEqual([])
    expect(result.generated).toEqual([])
    expect(result.entities).toEqual([])
    expect(generatedKinds(floor)).toEqual([])
  })

  it('creates one space, slab, and ceiling with the enclosure polygon and inferred metadata', () => {
    const { floor } = makeTestProject(rectangle)

    const result = generateMissingRoomEntities(floor, { x: 0, z: -1 })

    expect(result.rooms).toHaveLength(1)
    expect(result.generated).toHaveLength(1)
    expect(result.entities).toHaveLength(3)
    expect(result.entities.map((entity) => entity.kind)).toEqual(['space', 'slab', 'ceiling'])
    for (const entity of result.entities) {
      if (entity.kind === 'space' || entity.kind === 'slab' || entity.kind === 'ceiling') {
        expect(entity.polygon).toEqual(result.rooms[0]!.polygon)
      }
    }

    const space = result.entities.find((entity) => entity.kind === 'space')!
    expect(space.metadata).toMatchObject({
      confidence: 'inferred-low',
      directionMode: 'auto',
      renderTypeMode: 'auto',
      sidMode: 'auto',
      direction: 'S',
      renderType: 'SPACE',
    })
    expect(space.kind === 'space' && space.spaceType).toBe('OFFICE')

    for (const kind of ['slab', 'ceiling'] as const) {
      const surface = result.entities.find((entity) => entity.kind === kind)!
      expect(surface.metadata).toMatchObject({
        confidence: 'inferred-high',
        directionMode: 'auto',
        renderTypeMode: 'auto',
        sidMode: 'auto',
        renderType: 'CEILING',
      })
    }
  })

  it('is idempotent after appending the generated entities to the floor', () => {
    const { floor } = makeTestProject(rectangle)
    const first = generateMissingRoomEntities(floor, { x: 0, z: -1 })
    floor.entities.push(...first.entities)

    const second = generateMissingRoomEntities(floor, { x: 0, z: -1 })

    expect(second.rooms).toHaveLength(1)
    expect(second.generated).toEqual([])
    expect(second.entities).toEqual([])
    expect(floor.entities).toHaveLength(7)
  })

  it('does not duplicate existing covering slabs or ceilings', () => {
    const { floor } = makeTestProject(rectangle)
    const polygon = rectangle.map(({ start }) => start)
    const slab = makeSlab(floor.id, { id: 'existing-slab', polygon, name: 'Existing slab' })
    const ceiling = makeCeiling(floor.id, { id: 'existing-ceiling', polygon, name: 'Existing ceiling' })
    floor.entities.push(slab, ceiling)

    const result = generateMissingRoomEntities(floor, { x: 0, z: -1 })

    expect(result.entities).toHaveLength(1)
    expect(result.entities[0]?.kind).toBe('space')
    expect(floor.entities.filter((entity) => entity.kind === 'slab')).toHaveLength(1)
    expect(floor.entities.filter((entity) => entity.kind === 'ceiling')).toHaveLength(1)
  })

  it('preserves a confirmed human space covering the same room', () => {
    const { floor } = makeTestProject(rectangle)
    floor.entities.push(makeSpace(floor.id, {
      polygon: [
        { x: 0.2, z: 0.2 },
        { x: 3.8, z: 0.2 },
        { x: 3.8, z: 2.8 },
        { x: 0.2, z: 2.8 },
      ],
      spaceType: 'MEETING_ROOM',
      name: '人工会议室',
      metadata: { confidence: 'confirmed', direction: 'S', directionMode: 'manual' },
    }))

    const result = generateMissingRoomEntities(floor, { x: 0, z: -1 })

    expect(result.entities.filter((entity) => entity.kind === 'space')).toEqual([])
    expect(floor.entities.filter((entity) => entity.kind === 'space')).toHaveLength(1)
  })

  it('gives adjacent rooms unique SIDs accepted by release validation', () => {
    const { project, floor } = makeTestProject(adjacentRooms)
    const result = generateMissingRoomEntities(floor, { x: 0, z: -1 })
    floor.entities.push(...result.entities)

    expect(result.rooms).toHaveLength(2)
    expect(result.entities).toHaveLength(6)
    const report = validateProject(project, 'release')

    expect(report.errors, report.errors.map((issue) => issue.message).join('\n')).toEqual([])
    const generatedSids = result.entities.map((entity) => generateEntitySid(entity, floor))
    expect(new Set(generatedSids).size).toBe(generatedSids.length)
  })

  it('increments SPACE sequences when a generation batch contains rooms in the same direction', () => {
    const { project, floor } = makeTestProject(adjacentRooms)
    floor.entities.push(makeSlab(floor.id, {
      polygon: [
        { x: -20, z: -2 },
        { x: -18, z: -2 },
        { x: -18, z: 2 },
        { x: -20, z: 2 },
      ],
      metadata: { sequence: 10, sub: 'SLAB_10' },
    }))

    const result = generateMissingRoomEntities(floor, { x: 0, z: -1 })
    floor.entities.push(...result.entities)
    const spaces = result.entities.filter((entity): entity is Extract<typeof entity, { kind: 'space' }> => entity.kind === 'space')

    expect(spaces).toHaveLength(2)
    expect(spaces.map((space) => space.metadata.direction)).toEqual(['E', 'E'])
    expect(spaces.map((space) => space.metadata.sequence)).toEqual([1, 2])
    expect(validateProject(project, 'release').errors).toEqual([])
  })

  it('does not generate semantic entities for unsupported interior wall crossings', () => {
    const crossingSpecs: readonly WallSpec[] = [
      ...rectangle,
      { id: 'horizontal', start: { x: 0, z: 1.5 }, end: { x: 4, z: 1.5 }, direction: 'N', sequence: 2 },
      { id: 'vertical', start: { x: 2, z: 0 }, end: { x: 2, z: 3 }, direction: 'E', sequence: 2 },
    ]
    const { floor } = makeTestProject(crossingSpecs)

    const result = generateMissingRoomEntities(floor, { x: 0, z: -1 })

    expect(result.rooms).toEqual([])
    expect(result.entities).toEqual([])
  })
})
