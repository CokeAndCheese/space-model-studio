import { describe, expect, it } from 'vitest'
import { createDemoProject } from '../src/domain/project-factory'
import { buildEntityDeletionPlan, positionContextMenu } from '../src/editor/entity-context-menu'

describe('entity tree context menu helpers', () => {
  it('places the menu near the pointer while keeping it inside the viewport', () => {
    expect(positionContextMenu(300, 240, 1000, 800)).toEqual({ x: 300, y: 240 })
    expect(positionContextMenu(990, 790, 1000, 800, { width: 176, height: 82, margin: 8 })).toEqual({ x: 816, y: 710 })
    expect(positionContextMenu(-20, -10, 1000, 800)).toEqual({ x: 8, y: 8 })
  })

  it('plans wall deletion with hosted openings and blocks an atomic cascade when one is locked', () => {
    const project = createDemoProject()
    const floor = project.buildings[0]!.floors[0]!
    const wall = floor.entities.find((entity) => entity.kind === 'wall' && entity.openings.length > 0)
    if (!wall || wall.kind !== 'wall') throw new Error('fixture wall missing')
    const opening = floor.entities.find((entity) => entity.id === wall.openings[0])!
    opening.locked = true

    const plan = buildEntityDeletionPlan(project, [wall.id])
    expect(plan.requestedIds).toEqual([wall.id])
    expect(plan.effectiveIds).toEqual(expect.arrayContaining([wall.id, ...wall.openings]))
    expect(plan.lockedIds).toEqual([opening.id])
  })

  it('ignores non-entity IDs so project/building/floor tree nodes cannot be deleted through this path', () => {
    const project = createDemoProject()
    const building = project.buildings[0]!
    const floor = building.floors[0]!
    expect(buildEntityDeletionPlan(project, [project.projectId, building.id, floor.id])).toEqual({
      requestedIds: [],
      effectiveIds: [],
      lockedIds: [],
    })
  })
})
