import { describe, expect, it } from 'vitest'
import { CommandStack } from '../src/domain/command-stack'
import { createBuilding, createDemoProject, createFloor } from '../src/domain/project-factory'
import {
  addBuilding,
  addFloor,
  deleteBuildingHierarchy,
  deleteFloorHierarchy,
  deleteHierarchyNode,
  deleteProjectHierarchy,
  projectCommands,
  removeBuilding,
  removeFloor,
} from '../src/domain/project-commands'
import { projectSchema } from '../src/domain/project-schema'
import { validateProject } from '../src/validation/project-validator'

const allIds = (project: ReturnType<typeof createDemoProject>): Set<string> =>
  new Set([
    project.projectId,
    ...project.buildings.flatMap((building) => [
      building.id,
      ...building.floors.flatMap((floor) => [floor.id, ...floor.entities.map((entity) => entity.id)]),
    ]),
  ])

describe('pure hierarchy delete commands', () => {
  it('cascades a non-last floor and selects the nearest remaining floor', () => {
    const original = createDemoProject()
    const building = original.buildings[0]!
    const withSecondFloor = addFloor(original, building.id, { floorName: 'A_2F', level: 2, elevation: 4.2 })
    const sourceFloor = withSecondFloor.buildings[0]!.floors[0]!
    const fallbackFloor = withSecondFloor.buildings[0]!.floors[1]!
    const removedEntityIds = sourceFloor.entities.map((entity) => entity.id)

    const result = deleteFloorHierarchy(withSecondFloor, sourceFloor.id)

    expect(result.project.buildings[0]!.floors.map((floor) => floor.id)).toEqual([fallbackFloor.id])
    expect(result.currentBuildingId).toBe(building.id)
    expect(result.currentFloorId).toBe(fallbackFloor.id)
    expect(result.selection).toEqual({ type: 'floor', id: fallbackFloor.id })
    expect(result.selectedIds).toEqual([])
    expect(result.replacementCreated).toBe(false)
    expect(result.removedIds.entityIds).toEqual(removedEntityIds)
    expect(withSecondFloor.buildings[0]!.floors).toHaveLength(2)
  })

  it('replaces the last floor with a fresh empty 1F and keeps legacy removeFloor safe', () => {
    const original = createDemoProject()
    const oldFloor = original.buildings[0]!.floors[0]!
    const result = deleteFloorHierarchy(original, oldFloor.id)

    const replacement = result.project.buildings[0]!.floors[0]!
    expect(result.replacementCreated).toBe(true)
    expect(replacement.id).not.toBe(oldFloor.id)
    expect(replacement.floorName).toBe('A_1F')
    expect(replacement.entities).toEqual([])
    expect(result.fallbackFloorId).toBe(replacement.id)
    expect(projectSchema.safeParse(result.project).success).toBe(true)
    expect(validateProject(result.project, 'release').errors).toEqual([])

    const legacyResult = removeFloor(original, oldFloor.id)
    expect(legacyResult.buildings[0]!.floors).toHaveLength(1)
    expect(legacyResult.buildings[0]!.floors[0]!.id).not.toBe(oldFloor.id)
  })

  it('cascades a building and falls back to the adjacent building and its floor', () => {
    const original = createDemoProject()
    const secondBuilding = createBuilding('B', 'B栋')
    secondBuilding.floors.push(createFloor(secondBuilding.id, 'B', 1))
    const project = addBuilding(original, secondBuilding)
    const removedBuilding = project.buildings[0]!

    const result = deleteBuildingHierarchy(project, removedBuilding.id)

    expect(result.project.buildings.map((building) => building.id)).toEqual([secondBuilding.id])
    expect(result.selection).toEqual({ type: 'building', id: secondBuilding.id })
    expect(result.currentBuildingId).toBe(secondBuilding.id)
    expect(result.currentFloorId).toBe(secondBuilding.floors[0]!.id)
    expect(result.removedIds.floorIds).toEqual(removedBuilding.floors.map((floor) => floor.id))
    expect(result.replacementCreated).toBe(false)
  })

  it('replaces the last building with a fresh editable A building and 1F', () => {
    const original = createDemoProject()
    const oldBuilding = original.buildings[0]!
    const result = deleteBuildingHierarchy(original, oldBuilding.id)

    const replacement = result.project.buildings[0]!
    expect(result.replacementCreated).toBe(true)
    expect(replacement.id).not.toBe(oldBuilding.id)
    expect(replacement.code).toBe('A')
    expect(replacement.name).toBe('A栋')
    expect(replacement.floors).toHaveLength(1)
    expect(replacement.floors[0]!.floorName).toBe('A_1F')
    expect(replacement.floors[0]!.entities).toEqual([])
    expect(result.project.projectId).toBe(original.projectId)

    const legacyResult = removeBuilding(original, oldBuilding.id)
    expect(legacyResult.buildings).toHaveLength(1)
    expect(legacyResult.buildings[0]!.floors).toHaveLength(1)
  })

  it('repairs an empty fallback building so current floor IDs never dangle', () => {
    const original = createDemoProject()
    const emptyBuilding = createBuilding('B', 'B栋')
    const project = addBuilding(original, emptyBuilding)
    const result = deleteBuildingHierarchy(project, original.buildings[0]!.id)

    expect(result.replacementCreated).toBe(true)
    expect(result.currentBuildingId).toBe(emptyBuilding.id)
    expect(result.project.buildings[0]!.floors).toHaveLength(1)
    expect(result.currentFloorId).toBe(result.project.buildings[0]!.floors[0]!.id)
    expect(projectSchema.safeParse(result.project).success).toBe(true)
  })

  it('deletes a project into a new blank project with collision-free IDs', () => {
    const original = createDemoProject()
    const oldIds = allIds(original)
    const result = deleteProjectHierarchy(original)
    const replacement = result.project

    expect(replacement.projectId).not.toBe(original.projectId)
    expect(replacement.name).toBe('未命名建筑项目')
    expect(replacement.buildings[0]!.code).toBe('A')
    expect(replacement.buildings[0]!.floors[0]!.floorName).toBe('A_1F')
    expect(replacement.buildings[0]!.floors[0]!.entities).toEqual([])
    expect(result.selection).toEqual({ type: 'project', id: replacement.projectId })
    expect(result.selectedIds).toEqual([])
    for (const id of allIds(replacement)) expect(oldIds.has(id)).toBe(false)
    expect(projectSchema.safeParse(replacement).success).toBe(true)
    expect(original.buildings[0]!.floors[0]!.entities.length).toBeGreaterThan(0)
  })

  it('is undoable through the existing command stack', () => {
    const original = createDemoProject()
    const stack = new CommandStack(original)
    stack.execute(projectCommands.deleteProject())
    expect(stack.project.projectId).not.toBe(original.projectId)
    expect(stack.project.buildings[0]!.floors[0]!.entities).toEqual([])

    const restored = stack.undo()
    expect(restored.projectId).toBe(original.projectId)
    expect(restored.buildings[0]!.floors[0]!.entities).toHaveLength(7)
    expect(stack.redo().projectId).not.toBe(original.projectId)
  })

  it('routes generic hierarchy targets and rejects a stale project ID', () => {
    const original = createDemoProject()
    const floorId = original.buildings[0]!.floors[0]!.id
    expect(deleteHierarchyNode(original, { type: 'floor', id: floorId }).replacementCreated).toBe(true)
    expect(() => deleteHierarchyNode(original, { type: 'project', id: crypto.randomUUID() })).toThrow(/PROJECT_NOT_FOUND|未找到项目/)
  })
})
