import type { Vec2 } from '../domain/contract'

export interface ResolvedWallEndpoint {
  end: Vec2
  orthogonal: boolean
}

export interface WallPreviewMetrics {
  length: number
  angleDegrees: number
}

export const MIN_WALL_LENGTH = 0.1

export interface WallCommitDecision extends ResolvedWallEndpoint {
  accepted: boolean
  length: number
  minimum: number
}

export interface WallPreviewDimensions {
  height: number
  thickness: number
}

export interface CameraInteractionProfile {
  left: 'business'
  middle: 'pan'
  modifiedMiddle: 'rotate' | 'none'
  right: 'context-menu'
  wheel: 'zoom-to-pointer'
}

export type ViewportEscapeAction = 'cancel-active' | 'none'

/** Shared by hover preview and final click so the committed wall matches what was shown. */
export function resolveWallEndpoint(
  start: Vec2,
  pointer: Vec2,
  forceOrthogonal = false,
  autoOrthogonalRatio = 0.15,
): ResolvedWallEndpoint {
  const deltaX = Math.abs(pointer.x - start.x)
  const deltaZ = Math.abs(pointer.z - start.z)
  const longest = Math.max(deltaX, deltaZ)
  const orthogonal = forceOrthogonal
    || (longest > 0 && Math.min(deltaX, deltaZ) < longest * autoOrthogonalRatio)
  if (!orthogonal) return { end: { ...pointer }, orthogonal: false }
  return {
    end: deltaX >= deltaZ
      ? { x: pointer.x, z: start.z }
      : { x: start.x, z: pointer.z },
    orthogonal: true,
  }
}

export function wallPreviewMetrics(start: Vec2, end: Vec2): WallPreviewMetrics {
  const deltaX = end.x - start.x
  const deltaZ = end.z - start.z
  const rawDegrees = Math.atan2(deltaZ, deltaX) * 180 / Math.PI
  return {
    length: Math.hypot(deltaX, deltaZ),
    angleDegrees: (rawDegrees + 360) % 360,
  }
}

/** Resolve and validate the exact endpoint that would be committed. */
export function decideWallCommit(
  start: Vec2,
  pointer: Vec2,
  forceOrthogonal = false,
  minimum = MIN_WALL_LENGTH,
): WallCommitDecision {
  const resolved = resolveWallEndpoint(start, pointer, forceOrthogonal)
  const length = wallPreviewMetrics(start, resolved.end).length
  return { ...resolved, accepted: length > minimum, length, minimum }
}

/** Preview dimensions mirror the values passed to the final wall factory. */
export function resolveWallPreviewDimensions(
  floorClearHeight: number,
  wallHeight?: number,
  wallThickness?: number,
): WallPreviewDimensions {
  return {
    height: wallHeight ?? floorClearHeight,
    thickness: wallThickness ?? 0.2,
  }
}

export function resolveGridPoint(point: Vec2, gridSize: number, enabled: boolean): Vec2 {
  if (!enabled) return { ...point }
  const step = gridSize || 0.1
  return {
    x: Math.round(point.x / step) * step,
    z: Math.round(point.z / step) * step,
  }
}

/** OrbitControls uses Shift on a PAN mapping to invert it to ROTATE. */
export function cameraInteractionProfile(mode: '2D' | '3D'): CameraInteractionProfile {
  return {
    left: 'business',
    middle: 'pan',
    modifiedMiddle: mode === '3D' ? 'rotate' : 'none',
    right: 'context-menu',
    wheel: 'zoom-to-pointer',
  }
}

export function resolveViewportEscapeAction(
  _activeTool: string,
  hasPendingInteraction: boolean,
): ViewportEscapeAction {
  if (hasPendingInteraction) return 'cancel-active'
  return 'none'
}
