import { BufferGeometry } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { GeometryBuildError } from './geometry-error'

/**
 * Merge geometry parts without creating material groups. The function takes
 * ownership of all input parts; merged-away parts are disposed immediately.
 */
export function mergeGeometryParts(parts: BufferGeometry[], entityId?: string): BufferGeometry {
  if (parts.length === 0) return new BufferGeometry()
  if (parts.length === 1) {
    const geometry = parts[0]!
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return geometry
  }

  let merged: BufferGeometry | null = null
  try {
    merged = mergeGeometries(parts, false)
  } catch (error) {
    for (const part of parts) part.dispose()
    const detail = error instanceof Error ? `: ${error.message}` : ''
    throw new GeometryBuildError('MERGE_FAILED', `Unable to merge geometry parts${detail}`, entityId)
  }

  for (const part of parts) part.dispose()
  if (!merged) throw new GeometryBuildError('MERGE_FAILED', 'Unable to merge geometry parts', entityId)
  merged.clearGroups()
  merged.computeBoundingBox()
  merged.computeBoundingSphere()
  return merged
}
