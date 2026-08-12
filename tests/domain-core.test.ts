import { describe, expect, it } from 'vitest'
import { CommandStack } from '../src/domain/command-stack'
import { createWall, createWindow } from '../src/domain/project-factory'
import { createDemoHospitalProject, createDemoProject, createFloor } from '../src/domain/project-factory'
import {
  addEntity,
  addFloor,
  duplicateFloor,
  projectCommands,
  removeEntity,
  updateEntity,
} from '../src/domain/project-commands'
import { projectSchema } from '../src/domain/project-schema'
import { parseProject, serializeProject } from '../src/domain/project-serializer'
import { generateEntitySid } from '../src/metadata/sid-generator'
import { validateProject } from '../src/validation/project-validator'

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
})
