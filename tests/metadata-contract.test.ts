import { describe, expect, it } from 'vitest'
import { createEntityMetadata } from '../src/domain/entity-factory'
import { createDemoProject } from '../src/domain/project-factory'
import { DIRECTIONS, type Direction } from '../src/domain/contract'
import { applyComputedDirection, applyMetadataSuggestion } from '../src/metadata/semantic-generator'
import { computeDirection } from '../src/metadata/direction'
import { generateSid } from '../src/metadata/sid-generator'
import { validateProject } from '../src/validation/project-validator'

const pointAtClockwiseDegrees = (degrees: number, radius = 1): { x: number; z: number } => {
  const radians = (degrees * Math.PI) / 180
  return { x: Math.sin(radians) * radius, z: -Math.cos(radians) * radius }
}

describe('direction contract', () => {
  it('classifies all eight 45-degree sectors', () => {
    const values = DIRECTIONS.map((_, index) => computeDirection(pointAtClockwiseDegrees(index * 45), { x: 0, z: 0 }))
    expect(values).toEqual([...DIRECTIONS])
  })

  it('honours custom north and sector boundaries', () => {
    expect(computeDirection({ x: 1, z: 0 }, { x: 0, z: 0 }, { x: 1, z: 0 })).toBe('N')
    expect(computeDirection({ x: 0, z: 1 }, { x: 0, z: 0 }, { x: 1, z: 0 })).toBe('E')
    expect(computeDirection(pointAtClockwiseDegrees(22.49), { x: 0, z: 0 })).toBe('N')
    expect(computeDirection(pointAtClockwiseDegrees(22.51), { x: 0, z: 0 })).toBe('NE')
  })

  it('does not silently assign N inside the center dead-zone', () => {
    expect(computeDirection({ x: 0.05, z: 0 }, { x: 0, z: 0 })).toBeUndefined()
  })
})

describe('3.3-semantic SID contract', () => {
  it('generates directional components and semantic WALL/SPACE forms', () => {
    expect(generateSid({ renderType: 'DOOR', floorName: 'A_1F', direction: 'E', sequence: 1 })).toBe('DOOR_A_1F_E_01')
    expect(generateSid({ renderType: 'WINDOW', floorName: 'A_1F', direction: 'NW', sequence: 100 })).toBe('WINDOW_A_1F_NW_100')
    expect(generateSid({ renderType: 'SPACE', floorName: 'A_1F', spaceType: 'OFFICE', sequence: 1 })).toBe(
      'SPACE_A_1F_OFFICE_01',
    )
    expect(generateSid({ renderType: 'WALL', floorName: 'A_1F', sequence: 1 })).toBe('WALL_A_1F_01')
    expect(generateSid({ renderType: 'FACILITY', floorName: 'A_1F', fireType: 'HYDRANT', sequence: 1 })).toBe(
      'FACILITY_A_1F_HYDRANT_01',
    )
    expect(generateSid({ renderType: 'CEILING', floorName: 'A_1F', sub: 'LOWER', sequence: 1 })).toBe('CEILING_A_1F_LOWER')
    expect(generateSid({ renderType: 'CEILING', floorName: 'A_1F', sub: 'SLAB', sequence: 2 })).toBe('CEILING_A_1F_SLAB_02')
  })

  it('requires direction only for directional component types', () => {
    expect(() => generateSid({ renderType: 'DOOR', floorName: 'A_1F', sequence: 1 })).toThrow(/\u65b9\u4f4d/)
    expect(() => generateSid({ renderType: 'SPACE', floorName: 'A_1F', sequence: 1 })).toThrow(/spaceType/)
  })
})

describe('human metadata precedence', () => {
  it('never replaces manual direction', () => {
    const metadata = createEntityMetadata('WINDOW', { direction: 'W', directionMode: 'manual' })
    expect(applyComputedDirection(metadata, 'E').direction).toBe('W')
  })

  it('never replaces manually confirmed renderType with an inference', () => {
    const metadata = createEntityMetadata('WALL', { confidence: 'confirmed', renderTypeMode: 'manual' })
    expect(applyMetadataSuggestion(metadata, { renderType: 'WINDOW' }, 'inferred-high').renderType).toBe('WALL')
  })

  it('allows stronger inference to improve an automatic low-confidence value', () => {
    const metadata = createEntityMetadata('WALL', { confidence: 'inferred-low', renderTypeMode: 'auto' })
    expect(applyMetadataSuggestion(metadata, { renderType: 'WINDOW' }, 'inferred-high').renderType).toBe('WINDOW')
  })

  it('reports duplicate SIDs deterministically', () => {
    const project = createDemoProject()
    const floor = project.buildings[0]!.floors[0]!
    const windows = floor.entities.filter((entity) => entity.kind === 'window')
    windows[1]!.metadata.sequence = windows[0]!.metadata.sequence
    const report = validateProject(project, 'release')
    expect(report.errors.some((issue) => issue.code === 'SID_DUPLICATE')).toBe(true)
  })

  it.each<Direction>(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'])('accepts manual direction %s', (direction) => {
    const metadata = createEntityMetadata('DOOR', { direction, directionMode: 'manual' })
    expect(applyComputedDirection(metadata, 'N').direction).toBe(direction)
  })
})
