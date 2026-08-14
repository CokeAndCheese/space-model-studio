import { describe, expect, it } from 'vitest'
import { CommandStack } from '../src/domain/command-stack'
import { createSpace, createWall, createWindow } from '../src/domain/project-factory'
import { createBuilding, createDemoHospitalProject, createDemoProject, createFloor, createProject } from '../src/domain/project-factory'
import {
  addEntity,
  addFloor,
  duplicateFloor,
  projectCommands,
  removeEntity,
  updateSpaceTypeForEntity,
  updateSpaceTypeForEntities,
  updateEntity,
} from '../src/domain/project-commands'
import { projectSchema } from '../src/domain/project-schema'
import { parseProject, serializeProject } from '../src/domain/project-serializer'
import { generateEntitySid } from '../src/metadata/sid-generator'
import { validateProject } from '../src/validation/project-validator'

function emptySpaceProject() {
  const project = createProject({ name: '空间类型命令测试' })
  const building = createBuilding('A', 'A栋')
  const floor = createFloor(building.id, building.code, 1)
  building.floors.push(floor)
  project.buildings.push(building)
  return { project, floor }
}

describe('complete domain contract', () => {
  it('represents and validates every supported entity kind', () => {
    const project = createDemoHospitalProject()
    const floor = project.buildings[0]!.floors[0]!
    expect(new Set(floor.entities.map((entity) => entity.kind))).toEqual(
      new Set(['wall', 'door', 'window', 'slab', 'ceiling', 'space', 'facility', 'stair', 'elevator']),
    )
    expect(projectSchema.safeParse(project).success).toBe(true)
    const report = validateProject(project, 'release')
    expect(report.errors, report.errors.map((issue) => issue.message).join('\n')).toHaveLength(0)
  })

  it('strictly rejects unknown persisted fields and keeps serialization non-mutating', () => {
    const project = createDemoProject()
    const originalUpdatedAt = project.updatedAt
    const text = serializeProject(project)
    expect(project.updatedAt).toBe(originalUpdatedAt)
    expect(parseProject(text).projectId).toBe(project.projectId)

    const value = JSON.parse(text) as Record<string, unknown>
    value.unknownEditorState = true
    expect(() => parseProject(JSON.stringify(value))).toThrow(/unknownEditorState|Unrecognized key/)
  })
})

describe('project commands and host invariants', () => {
  it('adds and duplicates floors with fresh IDs and remapped host relations', () => {
    const source = createDemoProject()
    const sourceFloor = source.buildings[0]!.floors[0]!
    const result = duplicateFloor(source, sourceFloor.id, { floorName: 'A_2F', level: 2, elevation: 4.2 })
    const copy = result.buildings[0]!.floors[1]!
    expect(copy.id).not.toBe(sourceFloor.id)
    expect(copy.entities.map((entity) => entity.id)).not.toEqual(sourceFloor.entities.map((entity) => entity.id))
    expect(new Set(copy.entities.map((entity) => entity.id)).size).toBe(copy.entities.length)

    const copyWindow = copy.entities.find((entity) => entity.kind === 'window')!
    expect(copyWindow.kind).toBe('window')
    if (copyWindow.kind !== 'window') throw new Error('expected window')
    const host = copy.entities.find((entity) => entity.id === copyWindow.hostWallId)
    expect(host?.kind).toBe('wall')
    if (host?.kind === 'wall') expect(host.openings).toContain(copyWindow.id)
    expect(generateEntitySid(copyWindow, copy)).toContain('_A_2F_')
    expect(projectSchema.safeParse(result).success).toBe(true)
  })

  it('requires valid host openings and rejects a wall shrink that clips a window', () => {
    const project = createDemoProject()
    const floor = project.buildings[0]!.floors[0]!
    const northWall = floor.entities.find((entity) => entity.kind === 'wall' && entity.metadata.direction === 'N')!
    expect(() => updateEntity(project, northWall.id, { end: { x: -4, z: -4 } })).toThrow(/\u6d1e\u53e3|wall|opening/i)

    const orphan = createWindow(floor.id, crypto.randomUUID(), 1, 1)
    expect(() => addEntity(project, floor.id, orphan)).toThrow(/\u5bbf\u4e3b/)
  })

  it('does not silently delete hosted openings when removing a wall', () => {
    const project = createDemoProject()
    const floor = project.buildings[0]!.floors[0]!
    const wall = floor.entities.find((entity) => entity.kind === 'wall' && entity.openings.length > 0)!
    expect(() => removeEntity(project, wall.id)).toThrow(/cascadeOpenings/)
    const result = removeEntity(project, wall.id, { cascadeOpenings: true })
    expect(result.buildings[0]!.floors[0]!.entities.some((entity) => entity.id === wall.id)).toBe(false)
    expect(project.buildings[0]!.floors[0]!.entities.some((entity) => entity.id === wall.id)).toBe(true)
  })

  it('allocates the next stable sequence when adding to an occupied SID group', () => {
    const project = createDemoProject()
    const floor = project.buildings[0]!.floors[0]!
    const northWall = floor.entities.find((entity) => entity.kind === 'wall' && entity.metadata.direction === 'N')!
    const candidate = createWindow(floor.id, northWall.id, 1, 5.8)
    const result = addEntity(project, floor.id, candidate)
    const added = result.buildings[0]!.floors[0]!.entities.find((entity) => entity.id === candidate.id)!
    expect(added.metadata.sequence).toBe(3)
  })

  it('supports add floor plus 100-step undo/redo semantics and clears redo on a new branch', () => {
    const project = createDemoProject()
    const building = project.buildings[0]!
    const stack = new CommandStack(project)
    stack.markClean()
    stack.execute(projectCommands.addFloor(building.id, { floorName: 'A_2F', level: 2 }))
    expect(stack.project.buildings[0]!.floors).toHaveLength(2)
    expect(stack.isDirty).toBe(true)
    stack.undo()
    expect(stack.project.buildings[0]!.floors).toHaveLength(1)
    expect(stack.isDirty).toBe(false)
    stack.redo()
    expect(stack.project.buildings[0]!.floors).toHaveLength(2)
    stack.undo()
    stack.execute(projectCommands.addFloor(building.id, { floorName: 'A_3F', level: 3 }))
    expect(stack.canRedo).toBe(false)
    expect(stack.project.buildings[0]!.floors[1]!.floorName).toBe('A_3F')
  })

  it('rejects direct malformed floor source records', () => {
    const project = createDemoProject()
    const building = project.buildings[0]!
    const floor = createFloor(building.id, building.code, 2)
    floor.floorName = project.buildings[0]!.floors[0]!.floorName
    expect(() => addFloor(project, building.id, floor)).toThrow(/floorName/)

    const invalidWall = createWall(floor.id, '\u65e0\u6548\u5899', { x: 0, z: 0 }, { x: 0.05, z: 0 }, 'N', 1)
    floor.entities.push(invalidWall)
    expect(projectSchema.safeParse({ ...project, buildings: [{ ...building, floors: [floor] }] }).success).toBe(false)
  })

  it('confirms a single SPACE type edit and refreshes its persisted auto SID', () => {
    const { project, floor } = emptySpaceProject()
    const space = createSpace(floor.id, {
      name: '待确认空间',
      polygon: [{ x: 0, z: 0 }, { x: 3, z: 0 }, { x: 3, z: 3 }, { x: 0, z: 3 }],
      spaceType: 'OFFICE',
      metadata: { confidence: 'inferred-low', sequence: 1, sid: 'SPACE_A_1F_OFFICE_01' },
    })
    floor.entities.push(space)

    const result = updateSpaceTypeForEntity(project, space.id, 'KITCHEN')
    const updated = result.buildings[0]!.floors[0]!.entities.find((entity) => entity.id === space.id)

    expect(updated?.kind).toBe('space')
    if (!updated || updated.kind !== 'space') throw new Error('expected updated SPACE')
    expect(updated.spaceType).toBe('KITCHEN')
    expect(updated.metadata.confidence).toBe('confirmed')
    expect(updated.metadata.sid).toBe('SPACE_A_1F_KITCHEN_01')
    expect(validateProject(result, 'release').issues.filter((issue) => issue.code === 'AUTO_SID_STALE')).toEqual([])
  })

  it('atomically updates several confirmed spaces and preserves manual SIDs', () => {
    const { project, floor } = emptySpaceProject()
    const autoSpace = createSpace(floor.id, {
      name: '自动空间',
      polygon: [{ x: 0, z: 0 }, { x: 3, z: 0 }, { x: 3, z: 3 }, { x: 0, z: 3 }],
      spaceType: 'OFFICE',
      metadata: { sequence: 1 },
    })
    const manualSpace = createSpace(floor.id, {
      name: '人工空间',
      polygon: [{ x: 4, z: 0 }, { x: 7, z: 0 }, { x: 7, z: 3 }, { x: 4, z: 3 }],
      spaceType: 'BEDROOM',
      metadata: {
        sidMode: 'manual',
        sid: 'SPACE_A_1F_BEDROOM_77',
        manualSid: 'SPACE_A_1F_BEDROOM_77',
        sequence: 77,
      },
    })
    floor.entities.push(autoSpace, manualSpace)
    const source = structuredClone(project)

    const result = updateSpaceTypeForEntities(project, [autoSpace.id, manualSpace.id, autoSpace.id], 'KITCHEN')
    const spaces = result.buildings[0]!.floors[0]!.entities.filter((entity) => entity.kind === 'space')

    expect(spaces.map((space) => space.kind === 'space' && space.spaceType)).toEqual(['KITCHEN', 'KITCHEN'])
    expect(spaces[0]!.metadata.sid).toBe('SPACE_A_1F_KITCHEN_01')
    expect(spaces[1]!.metadata).toMatchObject({
      sidMode: 'manual',
      sid: 'SPACE_A_1F_BEDROOM_77',
      manualSid: 'SPACE_A_1F_BEDROOM_77',
      sequence: 77,
    })
    expect(project).toEqual(source)
    expect(projectSchema.safeParse(result).success).toBe(true)
  })

  it('allocates deterministic destination sequences and refreshes auto SIDs on collision', () => {
    const { project, floor } = emptySpaceProject()
    const existingKitchen = createSpace(floor.id, {
      name: '已有厨房',
      polygon: [{ x: 0, z: 0 }, { x: 3, z: 0 }, { x: 3, z: 3 }, { x: 0, z: 3 }],
      spaceType: 'KITCHEN',
      metadata: { sequence: 1 },
    })
    const firstOffice = createSpace(floor.id, {
      name: '办公室一',
      polygon: [{ x: 4, z: 0 }, { x: 7, z: 0 }, { x: 7, z: 3 }, { x: 4, z: 3 }],
      spaceType: 'OFFICE',
      metadata: { sequence: 1 },
    })
    const secondOffice = createSpace(floor.id, {
      name: '办公室二',
      polygon: [{ x: 8, z: 0 }, { x: 11, z: 0 }, { x: 11, z: 3 }, { x: 8, z: 3 }],
      spaceType: 'OFFICE',
      metadata: { sequence: 1 },
    })
    floor.entities.push(existingKitchen, firstOffice, secondOffice)

    const result = updateSpaceTypeForEntities(project, [secondOffice.id, firstOffice.id], 'KITCHEN')
    const updatedFloor = result.buildings[0]!.floors[0]!
    const updated = updatedFloor.entities.filter((entity) => entity.kind === 'space')

    expect(updated.map((space) => space.kind === 'space' && space.metadata.sequence)).toEqual([1, 2, 3])
    expect(updated.map((space) => generateEntitySid(space, updatedFloor))).toEqual([
      'SPACE_A_1F_KITCHEN_01',
      'SPACE_A_1F_KITCHEN_02',
      'SPACE_A_1F_KITCHEN_03',
    ])
    expect(updated.slice(1).map((space) => space.metadata.sid)).toEqual([
      'SPACE_A_1F_KITCHEN_02',
      'SPACE_A_1F_KITCHEN_03',
    ])
  })

  it('rejects an invalid batch atomically before changing the source project', () => {
    const { project, floor } = emptySpaceProject()
    const confirmedSpace = createSpace(floor.id, {
      name: '已确认空间',
      polygon: [{ x: 0, z: 0 }, { x: 3, z: 0 }, { x: 3, z: 3 }, { x: 0, z: 3 }],
      spaceType: 'OFFICE',
    })
    const inferredSpace = createSpace(floor.id, {
      name: '未确认空间',
      polygon: [{ x: 4, z: 0 }, { x: 7, z: 0 }, { x: 7, z: 3 }, { x: 4, z: 3 }],
      spaceType: 'OFFICE',
      metadata: { confidence: 'inferred-high' },
    })
    const lockedSpace = createSpace(floor.id, {
      name: '锁定空间',
      polygon: [{ x: 8, z: 0 }, { x: 11, z: 0 }, { x: 11, z: 3 }, { x: 8, z: 3 }],
      spaceType: 'OFFICE',
      locked: true,
    })
    const wall = createWall(floor.id, '墙体', { x: 12, z: 0 }, { x: 15, z: 0 }, 'N', 1)
    floor.entities.push(confirmedSpace, inferredSpace, lockedSpace, wall)

    const invalidBatches: Array<{ ids: string[]; message: RegExp }> = [
      { ids: [], message: /至少选择一个空间实体/ },
      { ids: [confirmedSpace.id, crypto.randomUUID()], message: /未找到实体/ },
      { ids: [wall.id], message: /实体不是空间/ },
      { ids: [inferredSpace.id], message: /已确认实体/ },
      { ids: [lockedSpace.id], message: /已锁定/ },
    ]

    for (const batch of invalidBatches) {
      const source = structuredClone(project)
      expect(() => updateSpaceTypeForEntities(project, batch.ids, 'KITCHEN')).toThrow(batch.message)
      expect(project).toEqual(source)
    }
  })
})
