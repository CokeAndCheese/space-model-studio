import type { Building, Entity, Floor, Project } from '../domain/contract'
import { DomainError, findEntityLocation, findFloorLocation } from '../domain/project-commands'

export type TreeContextTarget =
  | { type: 'project'; id: string }
  | { type: 'building'; id: string }
  | { type: 'floor'; id: string }
  | { type: 'entity'; id: string }

export type TreeContextActionId =
  | 'add-building'
  | 'add-floor'
  | 'duplicate-floor'
  | 'delete-building'
  | 'delete-floor'
  | 'delete-entity'

export interface TreeContextAction {
  id: TreeContextActionId
  label: string
  destructive: boolean
}

/**
 * MVP tree actions. Keep this deliberately small: every entry maps to an
 * existing domain command and solves a concrete project-tree workflow.
 */
export const TREE_CONTEXT_ACTION_MATRIX: Readonly<Record<TreeContextTarget['type'], readonly TreeContextAction[]>> = {
  project: [{ id: 'add-building', label: '新增单体', destructive: false }],
  building: [
    { id: 'add-floor', label: '新增楼层', destructive: false },
    { id: 'delete-building', label: '删除单体', destructive: true },
  ],
  floor: [
    { id: 'duplicate-floor', label: '复制楼层', destructive: false },
    { id: 'delete-floor', label: '删除楼层', destructive: true },
  ],
  entity: [{ id: 'delete-entity', label: '删除构件', destructive: true }],
}

export function getTreeContextActions(target: TreeContextTarget): readonly TreeContextAction[] {
  return TREE_CONTEXT_ACTION_MATRIX[target.type]
}

export type HierarchyDeletionTarget = Exclude<TreeContextTarget, { type: 'entity' }>

export interface HierarchyDeletionCounts {
  projects: number
  buildings: number
  floors: number
  entities: number
}

export interface HierarchyReplacementCounts {
  projects: number
  buildings: number
  floors: number
}

/** Read-only information used to render the destructive-action confirmation. */
export interface HierarchyDeletionImpact {
  target: HierarchyDeletionTarget
  targetLabel: '项目' | '单体' | '楼层'
  targetName: string
  removed: HierarchyDeletionCounts
  replacementCreated: HierarchyReplacementCounts
  lockedEntityIds: string[]
  lockedEntityNames: string[]
  canDelete: boolean
  requiresConfirmation: true
  confirmTitle: string
  confirmMessage: string
}

interface LocatedHierarchy {
  targetLabel: HierarchyDeletionImpact['targetLabel']
  targetName: string
  buildings: Building[]
  floors: Floor[]
  entities: Entity[]
}

function locateHierarchy(project: Project, target: HierarchyDeletionTarget): LocatedHierarchy {
  if (target.type === 'project') {
    if (target.id !== project.projectId) {
      throw new DomainError('PROJECT_NOT_FOUND', `未找到项目 ${target.id}`, target.id)
    }
    const floors = project.buildings.flatMap((building) => building.floors)
    return {
      targetLabel: '项目',
      targetName: project.name,
      buildings: project.buildings,
      floors,
      entities: floors.flatMap((floor) => floor.entities),
    }
  }

  if (target.type === 'building') {
    const building = project.buildings.find((candidate) => candidate.id === target.id)
    if (!building) throw new DomainError('BUILDING_NOT_FOUND', `未找到楼栋 ${target.id}`, target.id)
    return {
      targetLabel: '单体',
      targetName: building.name,
      buildings: [building],
      floors: building.floors,
      entities: building.floors.flatMap((floor) => floor.entities),
    }
  }

  const location = findFloorLocation(project, target.id)
  if (!location) throw new DomainError('FLOOR_NOT_FOUND', `未找到楼层 ${target.id}`, target.id)
  return {
    targetLabel: '楼层',
    targetName: location.floor.floorName,
    buildings: [],
    floors: [location.floor],
    entities: location.floor.entities,
  }
}

function replacementCounts(project: Project, target: HierarchyDeletionTarget): HierarchyReplacementCounts {
  if (target.type === 'project') return { projects: 1, buildings: 1, floors: 1 }

  if (target.type === 'building') {
    const remaining = project.buildings.filter((building) => building.id !== target.id)
    if (remaining.length === 0) return { projects: 0, buildings: 1, floors: 1 }
    return {
      projects: 0,
      buildings: 0,
      floors: remaining.filter((building) => building.floors.length === 0).length,
    }
  }

  const location = findFloorLocation(project, target.id)
  if (!location) return { projects: 0, buildings: 0, floors: 0 }
  const otherEmptyBuildings = project.buildings.filter(
    (building) => building.id !== location.building.id && building.floors.length === 0,
  ).length
  return {
    projects: 0,
    buildings: 0,
    floors: otherEmptyBuildings + (location.building.floors.length === 1 ? 1 : 0),
  }
}

function countPhrase(counts: HierarchyDeletionCounts): string {
  const parts: string[] = []
  if (counts.buildings > 0) parts.push(`${counts.buildings} 个单体`)
  if (counts.floors > 0) parts.push(`${counts.floors} 个楼层`)
  if (counts.entities > 0) parts.push(`${counts.entities} 个构件`)
  return parts.join('、') || '该节点'
}

/**
 * Calculates cascade scope without mutating the project. The UI must still
 * execute deleteHierarchyNode after the user confirms.
 */
export function buildHierarchyDeletionImpact(
  project: Project,
  target: HierarchyDeletionTarget,
): HierarchyDeletionImpact {
  const located = locateHierarchy(project, target)
  const locked = located.entities.filter((entity) => entity.locked)
  const removed: HierarchyDeletionCounts = {
    projects: target.type === 'project' ? 1 : 0,
    buildings: located.buildings.length,
    floors: located.floors.length,
    entities: located.entities.length,
  }
  const blockedSuffix = locked.length > 0 ? `其中 ${locked.length} 个构件已锁定，需先解锁。` : '此操作可撤销。'
  return {
    target,
    targetLabel: located.targetLabel,
    targetName: located.targetName,
    removed,
    replacementCreated: replacementCounts(project, target),
    lockedEntityIds: locked.map((entity) => entity.id),
    lockedEntityNames: locked.map((entity) => entity.name),
    canDelete: locked.length === 0,
    requiresConfirmation: true,
    confirmTitle: `删除${located.targetLabel}“${located.targetName}”？`,
    confirmMessage: `将删除${countPhrase(removed)}。${blockedSuffix}`,
  }
}

/** A small guard for callers dispatching an action from a stale menu. */
export function isTreeContextTargetAvailable(project: Project, target: TreeContextTarget): boolean {
  if (target.type === 'project') return target.id === project.projectId
  if (target.type === 'building') return project.buildings.some((building) => building.id === target.id)
  if (target.type === 'floor') return Boolean(findFloorLocation(project, target.id))
  return Boolean(findEntityLocation(project, target.id))
}
