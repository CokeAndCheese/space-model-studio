import type { Ceiling, Slab } from '../domain/contract'
import { assertNonNegative } from './geometry-error'
import { buildPolygonPrismGeometry } from './polygon-builder'

export function buildSlabGeometry(entity: Slab) {
  return buildPolygonPrismGeometry(entity.polygon, entity.baseOffset, entity.thickness, entity.id)
}

export function buildCeilingGeometry(entity: Ceiling) {
  assertNonNegative(entity.height, 'ceiling height', entity.id)
  return buildPolygonPrismGeometry(entity.polygon, entity.height, entity.thickness, entity.id)
}
