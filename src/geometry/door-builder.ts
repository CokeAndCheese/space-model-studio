import { BoxGeometry } from 'three'
import type { Door } from '../domain/contract'
import { assertPositive } from './geometry-error'

export function buildDoorGeometry(entity: Door): BoxGeometry {
  assertPositive(entity.width, 'door width', entity.id)
  assertPositive(entity.height, 'door height', entity.id)
  assertPositive(entity.depth, 'door depth', entity.id)
  return new BoxGeometry(entity.width, entity.height, entity.depth)
}
