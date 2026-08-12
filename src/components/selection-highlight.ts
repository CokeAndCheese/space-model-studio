import * as THREE from 'three'

export const SELECTION_OUTLINE_FLAG = 'selectionOutline'

function disposeOutline(outline: THREE.Object3D) {
  const renderable = outline as THREE.LineSegments<THREE.BufferGeometry, THREE.Material | THREE.Material[]>
  renderable.geometry?.dispose()
  const materials = Array.isArray(renderable.material) ? renderable.material : [renderable.material]
  materials.filter(Boolean).forEach((material) => material.dispose())
}

/** Change only material state and an auxiliary outline; the semantic mesh stays intact. */
export function applyMeshSelectionHighlight(
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>,
  selected: boolean,
) {
  const isSpace = mesh.userData.kind === 'space'
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  for (const material of materials) {
    if (!(material instanceof THREE.MeshStandardMaterial)) continue
    if (isSpace) {
      const originalOpacity = typeof mesh.userData.selectionOriginalOpacity === 'number'
        ? mesh.userData.selectionOriginalOpacity
        : material.opacity
      mesh.userData.selectionOriginalOpacity = originalOpacity
      material.opacity = selected ? Math.max(0.62, originalOpacity) : originalOpacity
    }
    material.emissive.set(selected ? 0x159b83 : 0x000000)
    material.emissiveIntensity = selected ? (isSpace ? 0.85 : 0.5) : 0
  }

  const existing = mesh.children.find((child) => child.userData[SELECTION_OUTLINE_FLAG] === true)
  if (selected && !existing) {
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry),
      new THREE.LineBasicMaterial({ color: isSpace ? 0xbaffef : 0x65f0d4, depthTest: false }),
    )
    outline.userData[SELECTION_OUTLINE_FLAG] = true
    outline.renderOrder = isSpace ? 80 : 50
    mesh.add(outline)
  } else if (!selected && existing) {
    mesh.remove(existing)
    disposeOutline(existing)
  }
}
