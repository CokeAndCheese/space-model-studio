export interface ScreenPoint {
  x: number
  y: number
}

export interface ScreenRect {
  left: number
  top: number
  right: number
  bottom: number
}

export type BoxSelectionMode = 'window' | 'crossing'
export type SelectionOperation = 'replace' | 'merge'
export type SelectionSource = 'box' | 'blank'

export interface ProjectedEntityBounds {
  id: string
  bounds: ScreenRect
  visible: boolean
  locked: boolean
}

export interface ViewportSelectionPayload {
  ids: string[]
  /** Only box selections have a CAD window/crossing mode. */
  boxMode?: BoxSelectionMode
  operation: SelectionOperation
  source?: SelectionSource
}

export interface SelectionContextPayload {
  clientX: number
  clientY: number
  ids: string[]
}

export interface SelectionContextResolution {
  ids: string[]
  selectHit: boolean
}

export function screenRectFromPoints(start: ScreenPoint, end: ScreenPoint): ScreenRect {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    right: Math.max(start.x, end.x),
    bottom: Math.max(start.y, end.y),
  }
}

/** CAD convention: left-to-right is Window; right-to-left is Crossing. */
export function boxSelectionMode(start: ScreenPoint, end: ScreenPoint): BoxSelectionMode {
  return end.x >= start.x ? 'window' : 'crossing'
}

export function exceedsDragThreshold(start: ScreenPoint, end: ScreenPoint, threshold = 5): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) >= threshold
}

export function rectContains(container: ScreenRect, candidate: ScreenRect): boolean {
  return candidate.left >= container.left
    && candidate.top >= container.top
    && candidate.right <= container.right
    && candidate.bottom <= container.bottom
}

export function rectIntersects(first: ScreenRect, second: ScreenRect): boolean {
  return first.left <= second.right
    && first.right >= second.left
    && first.top <= second.bottom
    && first.bottom >= second.top
}

export function selectProjectedEntityIds(
  entities: readonly ProjectedEntityBounds[],
  selection: ScreenRect,
  mode: BoxSelectionMode,
): string[] {
  const matches = mode === 'window' ? rectContains : rectIntersects
  return entities
    .filter((entity) => entity.visible && !entity.locked && matches(selection, entity.bounds))
    .map((entity) => entity.id)
}

/** A blank primary click is an explicit replace-with-empty selection command. */
export function blankSelectionPayload(): ViewportSelectionPayload {
  return { ids: [], operation: 'replace', source: 'blank' }
}

/** Resolve a right-click without mutating the parent's current selection. */
export function resolveSelectionContext(
  selectedIds: readonly string[],
  hitId?: string,
): SelectionContextResolution {
  const current = [...new Set(selectedIds.filter(Boolean))]
  if (hitId && !current.includes(hitId)) return { ids: [hitId], selectHit: true }
  return { ids: current, selectHit: false }
}
