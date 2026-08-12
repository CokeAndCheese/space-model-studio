import type { Entity, Project } from '../domain/contract'

export interface ContextMenuPosition {
  x: number
  y: number
}

export interface ContextMenuBounds {
  width?: number
  height?: number
  margin?: number
}

/** Keeps a fixed-position context menu inside the visible browser viewport. */
export function positionContextMenu(
  clientX: number,
  clientY: number,
  viewportWidth: number,
  viewportHeight: number,
  bounds: ContextMenuBounds = {},
): ContextMenuPosition {
  const width = bounds.width ?? 176
  const height = bounds.height ?? 82
  const margin = bounds.margin ?? 8
  const maximumX = Math.max(margin, viewportWidth - width - margin)
  const maximumY = Math.max(margin, viewportHeight - height - margin)
  return {
    x: Math.min(Math.max(margin, clientX), maximumX),
    y: Math.min(Math.max(margin, clientY), maximumY),
  }
}

export interface EntityDeletionPlan {
  /** Existing explicitly requested entities, in stable request order. */
  requestedIds: string[]
  /** Requested entities plus door/window children removed by wall cascade. */
  effectiveIds: string[]
  /** Any locked requested or cascading entity makes the whole deletion atomic no-op. */
  lockedIds: string[]
}

/** Mirrors the domain wall-opening cascade before committing a delete command. */
export function buildEntityDeletionPlan(project: Project, entityIds: readonly string[]): EntityDeletionPlan {
  const entities = new Map<string, Entity>()
  for (const building of project.buildings) {
    for (const floor of building.floors) {
      for (const entity of floor.entities) entities.set(entity.id, entity)
    }
  }

  const requestedIds = [...new Set(entityIds)].filter((id) => entities.has(id))
  const effectiveIds = new Set(requestedIds)
  for (const id of requestedIds) {
    const entity = entities.get(id)
    if (entity?.kind === 'wall') {
      for (const openingId of entity.openings) {
        if (entities.has(openingId)) effectiveIds.add(openingId)
      }
    }
  }
  const effective = [...effectiveIds]
  return {
    requestedIds,
    effectiveIds: effective,
    lockedIds: effective.filter((id) => entities.get(id)?.locked),
  }
}
