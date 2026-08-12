import { describe, expect, it } from 'vitest'
import { addBuilding, addFloor, deleteFloorHierarchy } from '../src/domain/project-commands'
import { createBuilding, createDemoProject, createProject } from '../src/domain/project-factory'
import { initialEditorState, normalizeEditorState } from '../src/editor/editor-state'

describe('editor state normalization', () => {
  it('keeps a valid entity primary and filters duplicate, stale, and cross-floor IDs', () => {
    const original = createDemoProject()
    const building = original.buildings[0]!
    const project = addFloor(original, building.id, { level: 2, floorName: 'A_2F' })
    const primary = project.buildings[0]!.floors[0]!.entities[0]!
    const crossFloor = project.buildings[0]!.floors[1]!
    const crossFloorEntity = structuredClone(primary)
    crossFloorEntity.id = crypto.randomUUID()
    crossFloorEntity.floorId = crossFloor.id
    crossFloor.entities.push(crossFloorEntity)

    const normalized = normalizeEditorState(project, {
      currentBuildingId: crypto.randomUUID(),
      currentFloorId: crossFloor.id,
      treeSelection: { type: 'entity', id: primary.id },
      selectedIds: [primary.id, primary.id, crypto.randomUUID(), crossFloorEntity.id],
    })

    expect(normalized.currentBuildingId).toBe(building.id)
    expect(normalized.currentFloorId).toBe(primary.floorId)
    expect(normalized.treeSelection).toEqual({ type: 'entity', id: primary.id })
    expect(normalized.selectedIds).toEqual([primary.id])
  })

  it('repairs stale IDs after redo of a hierarchy deletion', () => {
    const original = createDemoProject()
    const deletedFloor = original.buildings[0]!.floors[0]!
    const deletedEntity = deletedFloor.entities[0]!
    const next = deleteFloorHierarchy(original, deletedFloor.id).project

    const normalized = normalizeEditorState(next, {
      currentBuildingId: original.buildings[0]!.id,
      currentFloorId: deletedFloor.id,
      treeSelection: { type: 'entity', id: deletedEntity.id },
      selectedIds: [deletedEntity.id],
    })

    const replacement = next.buildings[0]!.floors[0]!
    expect(normalized).toEqual({
      currentBuildingId: next.buildings[0]!.id,
      currentFloorId: replacement.id,
      treeSelection: { type: 'floor', id: replacement.id },
      selectedIds: [],
    })
  })

  it('uses a valid selected entity when the previous primary disappeared', () => {
    const project = createDemoProject()
    const survivor = project.buildings[0]!.floors[0]!.entities[1]!

    const normalized = normalizeEditorState(project, {
      currentBuildingId: '',
      currentFloorId: '',
      treeSelection: { type: 'entity', id: crypto.randomUUID() },
      selectedIds: [crypto.randomUUID(), survivor.id],
    })

    expect(normalized.treeSelection).toEqual({ type: 'entity', id: survivor.id })
    expect(normalized.selectedIds).toEqual([survivor.id])
    expect(normalized.currentFloorId).toBe(survivor.floorId)
  })

  it('preserves project focus but repairs its working building and floor', () => {
    const original = createDemoProject()
    const second = createBuilding('B', 'B栋')
    const project = addFloor(addBuilding(original, second), second.id, { level: 1, floorName: 'B_1F' })
    const floor = project.buildings[1]!.floors[0]!

    const normalized = normalizeEditorState(project, {
      currentBuildingId: crypto.randomUUID(),
      currentFloorId: floor.id,
      treeSelection: { type: 'project', id: project.projectId },
      selectedIds: [project.buildings[0]!.floors[0]!.entities[0]!.id],
    })

    expect(normalized.currentBuildingId).toBe(second.id)
    expect(normalized.currentFloorId).toBe(floor.id)
    expect(normalized.treeSelection).toEqual({ type: 'project', id: project.projectId })
    expect(normalized.selectedIds).toEqual([])
  })

  it('falls back safely for an empty project', () => {
    const project = createProject('Empty')
    expect(initialEditorState(project)).toEqual({
      currentBuildingId: '',
      currentFloorId: '',
      treeSelection: { type: 'project', id: project.projectId },
      selectedIds: [],
    })
  })
})
