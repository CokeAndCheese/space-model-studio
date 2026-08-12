import { describe, expect, it } from 'vitest'
import { addBuilding, addFloor } from '../src/domain/project-commands'
import { createBuilding, createDemoProject } from '../src/domain/project-factory'
import {
  TREE_CONTEXT_ACTION_MATRIX,
  buildHierarchyDeletionImpact,
  getTreeContextActions,
  isTreeContextTargetAvailable,
} from '../src/editor/tree-context-actions'

describe('MVP tree context actions', () => {
  it('exposes only the approved action matrix', () => {
    expect(Object.fromEntries(Object.entries(TREE_CONTEXT_ACTION_MATRIX).map(([type, actions]) => [
      type,
      actions.map((action) => action.id),
    ]))).toEqual({
      project: ['add-building'],
      building: ['add-floor', 'delete-building'],
      floor: ['duplicate-floor', 'delete-floor'],
      entity: ['delete-entity'],
    })
    expect(getTreeContextActions({ type: 'floor', id: 'unused' })[1]).toMatchObject({
      id: 'delete-floor',
      destructive: true,
    })
  })

  it('reports floor cascade counts and the replacement floor before confirmation', () => {
    const project = createDemoProject()
    const floor = project.buildings[0]!.floors[0]!
    floor.entities[0]!.locked = true

    const impact = buildHierarchyDeletionImpact(project, { type: 'floor', id: floor.id })

    expect(impact.targetName).toBe(floor.floorName)
    expect(impact.removed).toEqual({ projects: 0, buildings: 0, floors: 1, entities: 7 })
    expect(impact.replacementCreated).toEqual({ projects: 0, buildings: 0, floors: 1 })
    expect(impact.lockedEntityIds).toEqual([floor.entities[0]!.id])
    expect(impact.canDelete).toBe(false)
    expect(impact.requiresConfirmation).toBe(true)
    expect(impact.confirmMessage).toContain('1 个楼层、7 个构件')
    expect(impact.confirmMessage).toContain('需先解锁')
  })

  it('reports a building cascade without predicting a replacement when another building remains', () => {
    const original = createDemoProject()
    const second = createBuilding('B', 'B栋')
    const project = addFloor(addBuilding(original, second), second.id, { level: 1, floorName: 'B_1F' })
    const target = project.buildings[0]!

    const impact = buildHierarchyDeletionImpact(project, { type: 'building', id: target.id })

    expect(impact.removed).toEqual({ projects: 0, buildings: 1, floors: 1, entities: 7 })
    expect(impact.replacementCreated).toEqual({ projects: 0, buildings: 0, floors: 0 })
    expect(impact.canDelete).toBe(true)
    expect(impact.confirmTitle).toContain(target.name)
  })

  it('rejects stale hierarchy targets and identifies menu targets that still exist', () => {
    const project = createDemoProject()
    const floor = project.buildings[0]!.floors[0]!
    const entity = floor.entities[0]!
    expect(isTreeContextTargetAvailable(project, { type: 'entity', id: entity.id })).toBe(true)
    expect(isTreeContextTargetAvailable(project, { type: 'floor', id: crypto.randomUUID() })).toBe(false)
    expect(() => buildHierarchyDeletionImpact(project, { type: 'floor', id: crypto.randomUUID() })).toThrow(/未找到楼层/)
  })
})
