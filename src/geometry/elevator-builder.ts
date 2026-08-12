import { BoxGeometry } from 'three'
import type { Elevator } from '../domain/contract'
import { assertPositive } from './geometry-error'

export function buildElevatorGeometry(entity: Elevator): BoxGeometry {
  assertPositive(entity.width, 'elevator width', entity.id)
  assertPositive(entity.depth, 'elevator depth', entity.id)
  assertPositive(entity.height, 'elevator height', entity.id)
  return new BoxGeometry(entity.width, entity.height, entity.depth)
}
