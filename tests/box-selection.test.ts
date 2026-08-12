import { describe, expect, it } from 'vitest'
import {
  blankSelectionPayload,
  boxSelectionMode,
  exceedsDragThreshold,
  rectContains,
  rectIntersects,
  resolveSelectionContext,
  screenRectFromPoints,
  selectProjectedEntityIds,
  type ProjectedEntityBounds,
} from '../src/components/box-selection'

const entity = (
  id: string,
  left: number,
  top: number,
  right: number,
  bottom: number,
  options: { visible?: boolean; locked?: boolean } = {},
): ProjectedEntityBounds => ({
  id,
  bounds: { left, top, right, bottom },
  visible: options.visible ?? true,
  locked: options.locked ?? false,
})

describe('box selection geometry', () => {
  it('represents a blank primary click as an explicit clear-selection command', () => {
    expect(blankSelectionPayload()).toEqual({
      ids: [],
      operation: 'replace',
      source: 'blank',
    })
  })

  it('normalizes either drag direction and derives the CAD selection mode', () => {
    expect(screenRectFromPoints({ x: 80, y: 70 }, { x: 10, y: 20 })).toEqual({
      left: 10,
      top: 20,
      right: 80,
      bottom: 70,
    })
    expect(boxSelectionMode({ x: 10, y: 20 }, { x: 80, y: 70 })).toBe('window')
    expect(boxSelectionMode({ x: 80, y: 70 }, { x: 10, y: 20 })).toBe('crossing')
  })

  it('uses a pixel threshold to keep a light click from becoming a box drag', () => {
    expect(exceedsDragThreshold({ x: 10, y: 10 }, { x: 13, y: 14 }, 6)).toBe(false)
    expect(exceedsDragThreshold({ x: 10, y: 10 }, { x: 13, y: 14 }, 5)).toBe(true)
  })

  it('distinguishes full containment from any intersection, including touching edges', () => {
    const selection = { left: 10, top: 10, right: 80, bottom: 70 }
    expect(rectContains(selection, { left: 20, top: 20, right: 60, bottom: 60 })).toBe(true)
    expect(rectContains(selection, { left: 0, top: 20, right: 30, bottom: 60 })).toBe(false)
    expect(rectIntersects(selection, { left: 0, top: 20, right: 30, bottom: 60 })).toBe(true)
    expect(rectIntersects(selection, { left: 80, top: 30, right: 90, bottom: 50 })).toBe(true)
    expect(rectIntersects(selection, { left: 81, top: 30, right: 90, bottom: 50 })).toBe(false)
  })

  it('window-selects only fully enclosed visible and unlocked entities', () => {
    const candidates = [
      entity('inside', 20, 20, 40, 40),
      entity('partial', 0, 20, 30, 40),
      entity('hidden', 20, 20, 40, 40, { visible: false }),
      entity('locked', 20, 20, 40, 40, { locked: true }),
    ]
    expect(selectProjectedEntityIds(
      candidates,
      { left: 10, top: 10, right: 50, bottom: 50 },
      'window',
    )).toEqual(['inside'])
  })

  it('crossing-selects fully enclosed and partially intersecting entities', () => {
    const candidates = [
      entity('inside', 20, 20, 40, 40),
      entity('partial', 0, 20, 30, 40),
      entity('outside', 60, 20, 80, 40),
    ]
    expect(selectProjectedEntityIds(
      candidates,
      { left: 10, top: 10, right: 50, bottom: 50 },
      'crossing',
    )).toEqual(['inside', 'partial'])
  })

  it('replaces selection when context-clicking an unselected entity', () => {
    expect(resolveSelectionContext(['wall-a', 'wall-b'], 'door-c')).toEqual({
      ids: ['door-c'],
      selectHit: true,
    })
  })

  it('preserves a box selection when context-clicking a selected entity or blank canvas', () => {
    expect(resolveSelectionContext(['wall-a', 'wall-b'], 'wall-b')).toEqual({
      ids: ['wall-a', 'wall-b'],
      selectHit: false,
    })
    expect(resolveSelectionContext(['wall-a', 'wall-b'])).toEqual({
      ids: ['wall-a', 'wall-b'],
      selectHit: false,
    })
    expect(resolveSelectionContext([])).toEqual({ ids: [], selectHit: false })
  })
})
