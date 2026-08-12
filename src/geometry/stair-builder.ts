import { BoxGeometry } from 'three'
import type { Stair } from '../domain/contract'
import { assertFinite, assertPositive, GeometryBuildError } from './geometry-error'
import { mergeGeometryParts } from './geometry-merge'

/** Generate one solid per tread, then collapse every tread into one BufferGeometry. */
export function buildStairGeometry(entity: Stair) {
  assertFinite(entity.start.x, 'stair start.x', entity.id)
  assertFinite(entity.start.z, 'stair start.z', entity.id)
  assertFinite(entity.end.x, 'stair end.x', entity.id)
  assertFinite(entity.end.z, 'stair end.z', entity.id)
  assertPositive(entity.width, 'stair width', entity.id)
  assertPositive(entity.totalRise, 'stair total rise', entity.id)
  if (!Number.isInteger(entity.stepCount) || entity.stepCount < 2) {
    throw new GeometryBuildError('INVALID_DIMENSION', 'stair step count must be an integer of at least 2', entity.id)
  }

  const runLength = Math.hypot(entity.end.x - entity.start.x, entity.end.z - entity.start.z)
  assertPositive(runLength, 'stair run length', entity.id)
  const treadRun = runLength / entity.stepCount
  const riserHeight = entity.totalRise / entity.stepCount
  const parts: BoxGeometry[] = []
  for (let index = 0; index < entity.stepCount; index += 1) {
    const stepHeight = riserHeight * (index + 1)
    const part = new BoxGeometry(treadRun, stepHeight, entity.width)
    part.translate(treadRun * (index + 0.5), stepHeight / 2, 0)
    parts.push(part)
  }
  const geometry = mergeGeometryParts(parts, entity.id)
  geometry.userData.stepCount = entity.stepCount
  return geometry
}
