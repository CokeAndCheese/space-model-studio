import { Mesh } from 'three'
import { describe, expect, it } from 'vitest'
import type { Entity, RenderType } from '../src/domain/contract'
import { buildEntityMeshes, geometryRegistry } from '../src/geometry'
import { makeElevator, makeFacility, makeWall } from '../src/domain/entity-factory'

const floorId = 'floor-1'
const transform = { position: { x: 0, y: 0, z: 0 }, rotationY: 0 }
function base<T extends RenderType>(id: string, name: string, renderType: T) {
  return {
    id,
    floorId,
    name,
    visible: true,
    locked: false,
    transform,
    metadata: {
      renderType,
      confidence: 'confirmed' as const,
      sidMode: 'auto' as const,
      directionMode: 'auto' as const,
      renderTypeMode: 'manual' as const,
      sequence: 1,
    },
  }
}

function allEntityFixtures(): Entity[] {
  const polygon = [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 4 }, { x: 0, z: 4 }]
  return [
    {
      ...base('wall', 'Wall', 'WALL'), kind: 'wall', start: { x: 0, z: 0 }, end: { x: 8, z: 0 },
      baseOffset: 0, height: 3, thickness: 0.2, openings: ['door', 'window'],
    },
    {
      ...base('door', 'Door', 'DOOR'), kind: 'door', hostWallId: 'wall', offset: 2, width: 1,
      height: 2.1, depth: 0.08, sillHeight: 0,
    },
    {
      ...base('window', 'Window', 'WINDOW'), kind: 'window', hostWallId: 'wall', offset: 5, width: 1.4,
      height: 1.2, depth: 0.08, sillHeight: 0.9,
    },
    { ...base('slab', 'Slab', 'CEILING'), kind: 'slab', polygon, baseOffset: -0.2, thickness: 0.2 },
    { ...base('ceiling', 'Ceiling', 'CEILING'), kind: 'ceiling', polygon, height: 3, thickness: 0.1 },
    { ...base('space', 'Space', 'SPACE'), kind: 'space', polygon, height: 0.02, spaceType: 'OFFICE' },
    {
      ...base('facility', 'Hydrant', 'FACILITY'), kind: 'facility', facilityShape: 'cylinder',
      size: { width: 0.6, height: 1.5, depth: 0.3 }, position: { x: 1, y: 0.8, z: 2 },
      mountHeight: 0.8, fireType: 'HYDRANT',
    },
    {
      ...base('stair', 'Stair', 'STAIR'), kind: 'stair', start: { x: 0, z: 5 }, end: { x: 4, z: 5 },
      width: 1.2, totalRise: 3, stepCount: 12, position: { x: 0, y: 0, z: 5 }, length: 4, height: 3,
    },
    {
      ...base('elevator', 'Elevator', 'ELEVATOR'), kind: 'elevator', center: { x: 4, z: 2 },
      position: { x: 4, y: 0, z: 2 }, width: 2, depth: 2, height: 3,
    },
  ]
}

describe('entity geometry registry', () => {
  it('contains every entity kind and projects each semantic entity to exactly one Mesh', () => {
    expect(Object.keys(geometryRegistry).sort()).toEqual(
      ['ceiling', 'door', 'elevator', 'facility', 'slab', 'space', 'stair', 'wall', 'window'],
    )
    const entities = allEntityFixtures()
    const meshes = buildEntityMeshes(entities, { floorElevation: 4 })
    expect(meshes).toHaveLength(entities.length)
    meshes.forEach((mesh, index) => {
      expect(mesh).toBeInstanceOf(Mesh)
      const meshDescendants: Mesh[] = []
      mesh.traverse((object) => {
        if (object instanceof Mesh) meshDescendants.push(object)
      })
      expect(meshDescendants).toHaveLength(1)
      expect(mesh.userData.entityId).toBe(entities[index]!.id)
      expect(mesh.geometry.getAttribute('position').count).toBeGreaterThan(0)
      mesh.geometry.dispose()
      mesh.material.dispose()
    })
  })

  it('does not double-apply factory positions when projecting editor entities', () => {
    const wall = makeWall(floorId, { start: { x: -6, z: -4 }, end: { x: 6, z: -4 } })
    const facility = makeFacility(floorId, { position: { x: 5, y: 0.8, z: 1 }, fireType: 'HYDRANT' })
    const elevator = makeElevator(floorId, { center: { x: 2.5, z: 1 } })
    const meshes = buildEntityMeshes([wall, facility, elevator])
    expect(meshes[0]!.position.toArray()).toEqual([-6, 0, -4])
    expect(meshes[1]!.position.x).toBe(5)
    expect(meshes[1]!.position.z).toBe(1)
    expect(meshes[2]!.position.x).toBe(2.5)
    expect(meshes[2]!.position.z).toBe(1)
    meshes.forEach((mesh) => { mesh.geometry.dispose(); mesh.material.dispose() })
  })
})
