import { BoxGeometry } from 'three'
import type { WindowEntity } from '../domain/contract'
import { assertNonNegative, assertPositive } from './geometry-error'

export function buildWindowGeometry(entity: WindowEntity): BoxGeometry {
  assertPositive(entity.width, 'window width', entity.id)
  assertPositive(entity.height, 'window height', entity.id)
  assertPositive(entity.depth, 'window depth', entity.id)
  assertNonNegative(entity.sillHeight, 'window sill height', entity.id)
  return new BoxGeometry(entity.width, entity.height, entity.depth)
}
