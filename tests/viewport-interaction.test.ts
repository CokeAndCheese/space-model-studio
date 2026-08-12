import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  cameraInteractionProfile,
  decideWallCommit,
  resolveGridPoint,
  resolveViewportEscapeAction,
  resolveWallEndpoint,
  resolveWallPreviewDimensions,
  wallPreviewMetrics,
} from '../src/components/viewport-interaction'

describe('wall drawing preview interaction', () => {
  it('keeps a free-angle endpoint unchanged when it is not close to an axis', () => {
    expect(resolveWallEndpoint({ x: 1, z: 2 }, { x: 4, z: 4 })).toEqual({
      end: { x: 4, z: 4 },
      orthogonal: false,
    })
  })

  it('auto-snaps near an axis and force-snaps the dominant axis with Shift', () => {
    expect(resolveWallEndpoint({ x: 0, z: 0 }, { x: 6, z: 0.3 })).toEqual({
      end: { x: 6, z: 0 },
      orthogonal: true,
    })
    expect(resolveWallEndpoint({ x: 0, z: 0 }, { x: 2, z: 5 }, true)).toEqual({
      end: { x: 0, z: 5 },
      orthogonal: true,
    })
  })

  it('reports stable live length and direction metrics', () => {
    expect(wallPreviewMetrics({ x: 1, z: 1 }, { x: 4, z: 5 })).toEqual({
      length: 5,
      angleDegrees: expect.closeTo(53.130102, 5),
    })
    expect(wallPreviewMetrics({ x: 0, z: 0 }, { x: 0, z: -2 }).angleDegrees).toBe(270)
  })

  it('keeps a too-short wall command anchored so the user can retry', () => {
    expect(decideWallCommit({ x: 0, z: 0 }, { x: 0.1, z: 0 })).toMatchObject({
      accepted: false,
      length: 0.1,
      minimum: 0.1,
    })
    expect(decideWallCommit({ x: 0, z: 0 }, { x: 0.11, z: 0 })).toMatchObject({
      accepted: true,
      length: 0.11,
    })
  })

  it('uses the same explicit dimensions as the final wall factory', () => {
    expect(resolveWallPreviewDimensions(3.6, 4.2, 0.25)).toEqual({
      height: 4.2,
      thickness: 0.25,
    })
    expect(resolveWallPreviewDimensions(3.3)).toEqual({ height: 3.3, thickness: 0.2 })
  })
})

describe('viewport command and camera interaction', () => {
  it('keeps primary and secondary buttons for business interactions', () => {
    expect(cameraInteractionProfile('2D')).toEqual({
      left: 'business',
      middle: 'pan',
      modifiedMiddle: 'none',
      right: 'context-menu',
      wheel: 'zoom-to-pointer',
    })
    expect(cameraInteractionProfile('3D').modifiedMiddle).toBe('rotate')
  })

  it('returns free coordinates when snapping is disabled', () => {
    expect(resolveGridPoint({ x: 1.24, z: -2.37 }, 0.5, false)).toEqual({ x: 1.24, z: -2.37 })
    expect(resolveGridPoint({ x: 1.24, z: -2.37 }, 0.5, true)).toEqual({ x: 1, z: -2.5 })
  })

  it('uses Escape only to cancel pending work and never switches tools', () => {
    expect(resolveViewportEscapeAction('墙体', true)).toBe('cancel-active')
    expect(resolveViewportEscapeAction('墙体', false)).toBe('none')
    expect(resolveViewportEscapeAction('空间', true)).toBe('cancel-active')
    expect(resolveViewportEscapeAction('空间', false)).toBe('none')
    expect(resolveViewportEscapeAction('选择', true)).toBe('cancel-active')
    expect(resolveViewportEscapeAction('选择', false)).toBe('none')
  })

  it('wires the MVP interaction contract into the viewport component', () => {
    const source = readFileSync(new URL('../src/components/EditorViewport.vue', import.meta.url), 'utf8')
    expect(source).toContain("emit('selection', blankSelectionPayload())")
    expect(source).toContain("emit('wall-rejected'")
    expect(source).toContain("event.key === 'Enter' && props.activeTool === '空间'")
    expect(source).toContain('document.activeElement === renderer.domElement')
    expect(source).toContain('renderer.domElement.tabIndex = 0')
    expect(source).toContain('commitSpaceDraft()')
    expect(source).toContain("decision.reason === 'self-intersection'")
    expect(source).toContain('spaceDraft.pop()')
    expect(source).toContain('defineExpose({ fitView, cancelActiveCommand })')
    expect(source).toContain('props.snapEnabled !== false')
    expect(source).toContain('LEFT: null')
    expect(source).toContain('MIDDLE: THREE.MOUSE.PAN')
    expect(source).toContain('RIGHT: null')
  })
})
