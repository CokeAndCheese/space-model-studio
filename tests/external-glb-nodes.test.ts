import { describe, expect, it } from 'vitest'
import { listExternalGlbNodes } from '../src/integration/external-glb-nodes'
import type { GlbJson } from '../src/glb/types'

describe('external GLB read-only nodes', () => {
  it('lists semantic mesh nodes without turning them into Domain entities', () => {
    const json: GlbJson = {
      asset: { version: '2.0' },
      nodes: [
        { name: 'root', children: [1] },
        { name: 'Wall 01', mesh: 0, extras: { sid: 'WALL_A_1F_01', findId: 'A_1F_mesh_1', renderType: 'WALL', renderTypeConfidence: 'high' } },
        { name: 'Door 01', mesh: 1, extras: { sid: 'DOOR_A_1F_E_01', findId: 'A_1F_mesh_2', renderType: 'DOOR', renderTypeConfidence: 'low' } },
      ],
    }

    expect(listExternalGlbNodes(json)).toEqual([
      { nodeIndex: 1, meshIndex: 0, name: 'Wall 01', sid: 'WALL_A_1F_01', findId: 'A_1F_mesh_1', renderType: 'WALL', renderTypeConfidence: 'high', spaceType: undefined, fireType: undefined },
      { nodeIndex: 2, meshIndex: 1, name: 'Door 01', sid: 'DOOR_A_1F_E_01', findId: 'A_1F_mesh_2', renderType: 'DOOR', renderTypeConfidence: 'low', spaceType: undefined, fireType: undefined },
    ])
  })

  it('ignores non-mesh and incomplete nodes', () => {
    const json: GlbJson = {
      asset: { version: '2.0' },
      nodes: [
        { name: 'group' },
        { name: 'missing metadata', mesh: 0 },
      ],
    }
    expect(listExternalGlbNodes(json)).toEqual([])
  })
})
