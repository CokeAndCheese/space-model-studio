import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three'
import { describe, expect, it } from 'vitest'
import { applyMeshSelectionHighlight, SELECTION_OUTLINE_FLAG } from '../src/components/selection-highlight'

describe('viewport selection highlight lifecycle', () => {
  it('does not replace, hide, detach, or dispose the semantic mesh while selection changes', () => {
    const geometry = new BoxGeometry(4, 3, 0.2)
    const material = new MeshStandardMaterial({ color: 0x93a4b5 })
    const mesh = new Mesh(geometry, material)
    const parent = new Group()
    parent.add(mesh)

    applyMeshSelectionHighlight(mesh, true)
    applyMeshSelectionHighlight(mesh, true)
    expect(mesh.geometry).toBe(geometry)
    expect(mesh.material).toBe(material)
    expect(mesh.visible).toBe(true)
    expect(mesh.parent).toBe(parent)
    expect(mesh.children.filter((child) => child.userData[SELECTION_OUTLINE_FLAG])).toHaveLength(1)
    expect(material.emissiveIntensity).toBe(0.5)

    applyMeshSelectionHighlight(mesh, false)
    expect(mesh.geometry).toBe(geometry)
    expect(mesh.material).toBe(material)
    expect(mesh.visible).toBe(true)
    expect(mesh.parent).toBe(parent)
    expect(mesh.children.filter((child) => child.userData[SELECTION_OUTLINE_FLAG])).toHaveLength(0)
    expect(material.emissiveIntensity).toBe(0)

    geometry.dispose()
    material.dispose()
  })

  it('makes selected SPACE fill and outline visibly stronger, then restores opacity', () => {
    const geometry = new BoxGeometry(4, 0.02, 3)
    const material = new MeshStandardMaterial({ color: 0x2cc5a7, transparent: true, opacity: 0.26 })
    const mesh = new Mesh(geometry, material)
    mesh.userData.kind = 'space'
    const materialVersion = material.version

    applyMeshSelectionHighlight(mesh, true)
    expect(material.opacity).toBe(0.62)
    expect(material.emissiveIntensity).toBe(0.85)
    expect(mesh.children.some((child) => child.userData[SELECTION_OUTLINE_FLAG])).toBe(true)
    expect(mesh.children.find((child) => child.userData[SELECTION_OUTLINE_FLAG])?.renderOrder).toBe(80)
    expect(material.version).toBe(materialVersion)

    applyMeshSelectionHighlight(mesh, false)
    expect(material.opacity).toBe(0.26)
    expect(material.emissiveIntensity).toBe(0)

    geometry.dispose()
    material.dispose()
  })
})
