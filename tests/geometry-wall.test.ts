import {
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Vector3,
} from 'three'
import { describe, expect, it } from 'vitest'
import type { Door, Wall, WindowEntity } from '../src/domain/contract'
import {
  buildEntityMesh,
  buildWallGeometry,
  computeWallSegments,
  GeometryBuildError,
} from '../src/geometry'

const transform = { position: { x: 0, y: 0, z: 0 }, rotationY: 0 }
const commonMetadata = {
  confidence: 'confirmed' as const,
  sidMode: 'auto' as const,
  directionMode: 'auto' as const,
  renderTypeMode: 'manual' as const,
  sequence: 1,
}

function fixture() {
  const wall: Wall = {
    id: 'wall-1',
    floorId: 'floor-1',
    kind: 'wall',
    name: 'Opening wall',
    visible: true,
    locked: false,
    transform,
    start: { x: 0, z: 0 },
    end: { x: 10, z: 0 },
    baseOffset: 0,
    height: 3,
    thickness: 0.2,
    openings: ['door-1', 'window-1'],
    metadata: { ...commonMetadata, renderType: 'WALL' },
  }
  const door: Door = {
    id: 'door-1',
    floorId: 'floor-1',
    kind: 'door',
    name: 'Door',
    visible: true,
    locked: false,
    transform,
    hostWallId: wall.id,
    offset: 2,
    width: 2,
    height: 2.1,
    depth: 0.08,
    sillHeight: 0,
    metadata: { ...commonMetadata, renderType: 'DOOR' },
  }
  const window: WindowEntity = {
    id: 'window-1',
    floorId: 'floor-1',
    kind: 'window',
    name: 'Window',
    visible: true,
    locked: false,
    transform,
    hostWallId: wall.id,
    offset: 6,
    width: 2,
    height: 1,
    depth: 0.08,
    sillHeight: 1,
    metadata: { ...commonMetadata, renderType: 'WINDOW' },
  }
  return { wall, door, window }
}

function rayHits(mesh: Mesh, x: number, y: number): number {
  mesh.updateMatrixWorld(true)
  return new Raycaster(new Vector3(x, y, 1), new Vector3(0, 0, -1), 0, 2).intersectObject(mesh, false).length
}

describe('wall opening geometry', () => {
  it('subtracts door and window rectangles while keeping one BufferGeometry', () => {
    const { wall, door, window } = fixture()
    const geometry = buildWallGeometry(wall, [door, window])
    const material = new MeshBasicMaterial({ side: DoubleSide })
    const mesh = new Mesh(geometry, material)

    expect(geometry.userData.openingCount).toBe(2)
    expect(geometry.userData.wallSegmentCount).toBeGreaterThan(1)
    expect(rayHits(mesh, door.offset, 1)).toBe(0)
    expect(rayHits(mesh, door.offset, 2.6)).toBeGreaterThan(0)
    expect(rayHits(mesh, window.offset, 1.5)).toBe(0)
    expect(rayHits(mesh, window.offset, 0.5)).toBeGreaterThan(0)
    expect(rayHits(mesh, 9, 1.5)).toBeGreaterThan(0)

    geometry.dispose()
    material.dispose()
  })

  it('never creates zero or negative wall blocks at wall-aligned opening boundaries', () => {
    const { wall, door, window } = fixture()
    const leftDoor: Door = { ...door, offset: 1 }
    const rightWindow: WindowEntity = { ...window, offset: 9 }
    const segments = computeWallSegments(wall, [leftDoor, rightWindow])
    expect(segments.length).toBeGreaterThan(0)
    expect(segments.every((segment) => segment.width > 0 && segment.height > 0)).toBe(true)
    expect(segments.every((segment) => segment.right > segment.left && segment.top > segment.bottom)).toBe(true)
  })

  it('rejects invalid dimensions, overlapping openings and missing references', () => {
    const { wall, door, window } = fixture()
    expect(() => buildWallGeometry({ ...wall, thickness: -0.2 }, [door, window])).toThrow(GeometryBuildError)
    expect(() =>
      buildWallGeometry(wall, [door, { ...window, offset: 2.5 }]),
    ).toThrow(/overlap/i)
    expect(() => buildWallGeometry(wall, [door])).toThrow(/not supplied/i)
    expect(() => buildWallGeometry({ ...wall, openings: ['door-1', 'door-1'] }, [door])).toThrow(/duplicate/i)
  })

  it('places hosted meshes in the wall local frame and includes floor elevation', () => {
    const { wall, door, window } = fixture()
    const verticalWall: Wall = {
      ...wall,
      start: { x: 1, z: 2 },
      end: { x: 1, z: 12 },
      baseOffset: 0.2,
    }
    const mesh = buildEntityMesh(door, { entities: [verticalWall, door, window], floorElevation: 4 })
    expect(mesh.position.x).toBeCloseTo(1)
    expect(mesh.position.z).toBeCloseTo(4)
    expect(mesh.position.y).toBeCloseTo(4 + 0.2 + door.height / 2)
    expect(mesh.rotation.y).toBeCloseTo(-Math.PI / 2)
    mesh.geometry.dispose()
    mesh.material.dispose()
  })
})
