import type { Project } from '../domain/contract'
import { findEntityLocation, findFloorLocation, type HierarchySelection } from '../domain/project-commands'

export type EditorTreeSelection = HierarchySelection | { type: 'entity'; id: string }

export interface EditorSelectionState {
  currentBuildingId: string
  currentFloorId: string
  treeSelection: EditorTreeSelection
  selectedIds: string[]
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function projectFallback(project: Project): EditorSelectionState {
  const building = project.buildings[0]
  const floor = building?.floors[0]
  return {
    currentBuildingId: building?.id ?? '',
    currentFloorId: floor?.id ?? '',
    treeSelection: floor
      ? { type: 'floor', id: floor.id }
      : building
        ? { type: 'building', id: building.id }
        : { type: 'project', id: project.projectId },
    selectedIds: [],
  }
}

/**
 * Repairs editor-only IDs after project replacement, hierarchy deletion,
 * undo, or redo. It never mutates the project or the incoming state.
 */
export function normalizeEditorState(project: Project, state: EditorSelectionState): EditorSelectionState {
  const selection = state.treeSelection

  if (selection.type === 'entity') {
    const primary = findEntityLocation(project, selection.id)
    if (primary) {
      const selectedIds = unique([selection.id, ...state.selectedIds]).filter((id) => {
        const location = findEntityLocation(project, id)
        return location?.floor.id === primary.floor.id
      })
      return {
        currentBuildingId: primary.building.id,
        currentFloorId: primary.floor.id,
        treeSelection: selection,
        selectedIds,
      }
    }

    for (const id of unique(state.selectedIds)) {
      const location = findEntityLocation(project, id)
      if (!location) continue
      const selectedIds = unique(state.selectedIds).filter(
        (candidate) => findEntityLocation(project, candidate)?.floor.id === location.floor.id,
      )
      return {
        currentBuildingId: location.building.id,
        currentFloorId: location.floor.id,
        treeSelection: { type: 'entity', id },
        selectedIds,
      }
    }
  }

  if (selection.type === 'floor') {
    const location = findFloorLocation(project, selection.id)
    if (location) {
      return {
        currentBuildingId: location.building.id,
        currentFloorId: location.floor.id,
        treeSelection: selection,
        selectedIds: [],
      }
    }
  }

  if (selection.type === 'building') {
    const building = project.buildings.find((candidate) => candidate.id === selection.id)
    if (building) {
      const currentFloor = building.floors.find((floor) => floor.id === state.currentFloorId) ?? building.floors[0]
      return {
        currentBuildingId: building.id,
        currentFloorId: currentFloor?.id ?? '',
        treeSelection: selection,
        selectedIds: [],
      }
    }
  }

  if (selection.type === 'project' && selection.id === project.projectId) {
    const currentFloor = findFloorLocation(project, state.currentFloorId)
    const currentBuilding = project.buildings.find((building) => building.id === state.currentBuildingId)
    const building = currentFloor?.building ?? currentBuilding ?? project.buildings[0]
    const floor = currentFloor?.building.id === building?.id
      ? currentFloor.floor
      : building?.floors[0]
    return {
      currentBuildingId: building?.id ?? '',
      currentFloorId: floor?.id ?? '',
      treeSelection: selection,
      selectedIds: [],
    }
  }

  const currentFloor = findFloorLocation(project, state.currentFloorId)
  if (currentFloor) {
    return {
      currentBuildingId: currentFloor.building.id,
      currentFloorId: currentFloor.floor.id,
      treeSelection: { type: 'floor', id: currentFloor.floor.id },
      selectedIds: [],
    }
  }

  const currentBuilding = project.buildings.find((building) => building.id === state.currentBuildingId)
  if (currentBuilding) {
    const floor = currentBuilding.floors[0]
    return {
      currentBuildingId: currentBuilding.id,
      currentFloorId: floor?.id ?? '',
      treeSelection: floor ? { type: 'floor', id: floor.id } : { type: 'building', id: currentBuilding.id },
      selectedIds: [],
    }
  }

  return projectFallback(project)
}

export function initialEditorState(project: Project): EditorSelectionState {
  return projectFallback(project)
}
