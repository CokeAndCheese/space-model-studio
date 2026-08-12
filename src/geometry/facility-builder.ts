import { BoxGeometry, CylinderGeometry, type BufferGeometry } from 'three'
import type { Facility } from '../domain/contract'
import { assertNonNegative, assertPositive } from './geometry-error'

export function buildFacilityGeometry(entity: Facility): BufferGeometry {
  const { width, height, depth } = entity.size
  assertPositive(width, 'facility width', entity.id)
  assertPositive(height, 'facility height', entity.id)
  assertPositive(depth, 'facility depth', entity.id)
  assertNonNegative(entity.mountHeight, 'facility mount height', entity.id)
  if (entity.facilityShape === 'cylinder') {
    const geometry = new CylinderGeometry(0.5, 0.5, 1, 20)
    geometry.scale(width, height, depth)
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return geometry
  }
  // The demo icon representation remains volumetric, so it is pickable from all views.
  return new BoxGeometry(width, height, depth)
}
