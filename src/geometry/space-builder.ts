import type { Space } from '../domain/contract'
import { buildPolygonPrismGeometry } from './polygon-builder'

/** SPACE is projected as a selectable, very thin polygon prism. */
export function buildSpaceGeometry(entity: Space) {
  return buildPolygonPrismGeometry(entity.polygon, 0, entity.height, entity.id)
}
