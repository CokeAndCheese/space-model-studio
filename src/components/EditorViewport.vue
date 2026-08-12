<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { Entity, Floor, Vec2 } from '../domain/contract'
import { buildEntityMesh } from '../geometry'
import {
  blankSelectionPayload,
  boxSelectionMode,
  exceedsDragThreshold,
  screenRectFromPoints,
  selectProjectedEntityIds,
  resolveSelectionContext,
  type BoxSelectionMode,
  type ProjectedEntityBounds,
  type ScreenPoint,
  type SelectionContextPayload,
  type ViewportSelectionPayload,
} from './box-selection'
import {
  cameraInteractionProfile,
  decideWallCommit,
  resolveGridPoint,
  resolveViewportEscapeAction,
  resolveWallEndpoint,
  resolveWallPreviewDimensions,
  wallPreviewMetrics,
} from './viewport-interaction'
import { applyMeshSelectionHighlight } from './selection-highlight'
import { decideSpacePolygonCommit, pointsEqual } from './space-polygon-drawing'

interface GroundPointResult {
  point: Vec2
  alignedX: boolean
  alignedZ: boolean
}

const props = withDefaults(defineProps<{
  floor: Floor
  mode: '2D' | '3D'
  selectedId?: string
  /** Optional multi-selection projection; selectedId remains backward compatible. */
  selectedIds?: string[]
  activeTool: string
  gridSize: number
  snapEnabled?: boolean
  /** Must match the values passed to the final wall factory. */
  wallHeight?: number
  wallThickness?: number
  /** Optional read-only imported model, kept in native coordinates. */
  externalGlb?: ArrayBuffer
  /** Elevation of the interaction plane and Domain projections. */
  floorElevation?: number
}>(), {
  floorElevation: 0,
})

const emit = defineEmits<{
  select: [id: string, additive?: boolean]
  selection: [payload: ViewportSelectionPayload]
  'selection-context': [payload: SelectionContextPayload]
  create: [payload: { tool: string; point: Vec2; end?: Vec2; polygon?: Vec2[] }]
  'wall-rejected': [payload: { reason: 'too-short'; length: number; minimum: number }]
  pointer: [point: Vec2]
  'external-load-error': [message: string]
}>()

const BOX_DRAG_THRESHOLD = 5
const wallAlignmentTolerance = 0.16
const WALL_ALIGNMENT_VIEW_PADDING = 3
const host = ref<HTMLDivElement>()
const hint = ref('')
const selectionBox = ref<{ start: ScreenPoint; end: ScreenPoint }>()

let renderer: THREE.WebGLRenderer
let scene: THREE.Scene
let perspective: THREE.PerspectiveCamera
let orthographic: THREE.OrthographicCamera
let controls: OrbitControls
let objects = new THREE.Group()
let externalModel = new THREE.Group()
let grid = new THREE.GridHelper(60, 60, 0x334556, 0x1d2935)
const gltfLoader = new GLTFLoader()
let externalLoadRequest = 0
const EXTERNAL_LOG_PREFIX = '[SpaceModelStudio][ExternalGLB]'
let raycaster = new THREE.Raycaster()
let pointer = new THREE.Vector2()
let wallStart: Vec2 | undefined
let wallPreview = new THREE.Group()
let wallPreviewMesh: THREE.Mesh
let wallPreviewLine: THREE.Line
let wallPreviewStartMarker: THREE.Mesh
let wallPreviewEndMarker: THREE.Mesh
let spaceDraft: Vec2[] = []
let spaceHover: Vec2 | undefined
let spacePreview = new THREE.Group()
let spacePreviewFill: THREE.Mesh
let spacePreviewLine: THREE.Line
let spacePreviewMarkers = new THREE.Group()
let pendingSpaceHover: Vec2 | undefined
let spacePreviewFrame = 0
let wallAlignmentGuideGroup = new THREE.Group()
let wallAlignmentLineX: THREE.Line
let wallAlignmentLineZ: THREE.Line
let resizeObserver: ResizeObserver
let frame = 0
let selectionDrag: {
  pointerId: number
  start: ScreenPoint
  end: ScreenPoint
  additive: boolean
  pressedEntityId?: string
  cameraState: {
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera
    position: THREE.Vector3
    quaternion: THREE.Quaternion
    zoom: number
    target: THREE.Vector3
  }
} | undefined
let suppressNextClick = false

const colors: Record<string, number> = {
  wall: 0x93a4b5,
  door: 0xd9a455,
  window: 0x31d0b3,
  slab: 0x516273,
  ceiling: 0x75869a,
  space: 0x2cc5a7,
  facility: 0xef6f78,
  stair: 0xb28be8,
  elevator: 0x6795e8,
}

const externalPlanColors: Record<string, number> = {
  CEILING: 0x76808b,
  WALL: 0xf2f5f8,
  DOOR: 0xf06449,
  WINDOW: 0x25c8e0,
  ELEVATOR: 0x9c7cf4,
  STAIR: 0xe5b85c,
  FACILITY: 0xff6b78,
  SPACE: 0x3cd5b3,
}

const currentBoxMode = computed<BoxSelectionMode>(() => (
  selectionBox.value
    ? boxSelectionMode(selectionBox.value.start, selectionBox.value.end)
    : 'window'
))

const selectionBoxStyle = computed(() => {
  if (!selectionBox.value) return undefined
  const rect = screenRectFromPoints(selectionBox.value.start, selectionBox.value.end)
  return {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.right - rect.left}px`,
    height: `${rect.bottom - rect.top}px`,
  }
})

function activeCamera() {
  return props.mode === '2D' ? orthographic : perspective
}

function material(kind: string, transparent = false) {
  return new THREE.MeshStandardMaterial({
    color: colors[kind] ?? 0x8292a5,
    roughness: 0.78,
    metalness: 0.05,
    transparent,
    opacity: transparent ? 0.26 : 1,
    side: THREE.DoubleSide,
  })
}

function entityMesh(entity: Entity) {
  const mesh = buildEntityMesh(entity, {
    entities: props.floor.entities,
    floorElevation: props.floorElevation ?? 0,
    material: () => material(entity.kind, entity.kind === 'space'),
  })
  mesh.castShadow = true
  mesh.receiveShadow = true
  if (entity.kind === 'space') applySpaceViewMode(mesh)
  return mesh
}

function applySpaceViewMode(mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>) {
  const plan = props.mode === '2D'
  mesh.renderOrder = plan ? 65 : 0
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  for (const current of materials) {
    current.depthTest = !plan
    current.depthWrite = false
    current.needsUpdate = true
  }
}

function applyDomainViewMode() {
  for (const object of objects.children) {
    const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>
    if (mesh.userData.kind === 'space') applySpaceViewMode(mesh)
  }
}

function disposeObjectResources(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  root.traverse((object) => {
    const renderable = object as THREE.Mesh
    if (renderable.geometry) geometries.add(renderable.geometry)
    const renderableMaterial = renderable.material
    const values = Array.isArray(renderableMaterial) ? renderableMaterial : renderableMaterial ? [renderableMaterial] : []
    for (const current of values) {
      materials.add(current)
      for (const value of Object.values(current)) {
        if (value instanceof THREE.Texture) textures.add(value)
      }
    }
    const original = renderable.userData.externalOriginalMaterial as THREE.Material | THREE.Material[] | undefined
    for (const current of Array.isArray(original) ? original : original ? [original] : []) {
      materials.add(current)
      for (const value of Object.values(current)) {
        if (value instanceof THREE.Texture) textures.add(value)
      }
    }
    const planMaterial = renderable.userData.externalPlanMaterial as THREE.Material | undefined
    if (planMaterial) materials.add(planMaterial)
  })
  for (const texture of textures) {
    const image = texture.source?.data as { close?: () => void } | undefined
    texture.dispose()
    image?.close?.()
  }
  materials.forEach((current) => current.dispose())
  geometries.forEach((current) => current.dispose())
}

function disposeExternalModel() {
  disposeObjectResources(externalModel)
  externalModel.clear()
}

function prepareExternalModel(root: THREE.Object3D) {
  let semanticNodes = 0
  let meshObjects = 0
  const visit = (object: THREE.Object3D, inheritedType?: string) => {
    const renderType = typeof object.userData.renderType === 'string'
      ? object.userData.renderType
      : inheritedType
    if (typeof object.userData.renderType === 'string') semanticNodes++
    if ((object as THREE.Mesh).isMesh) {
      const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>
      meshObjects++
      mesh.userData.externalRenderType = renderType
      mesh.userData.externalOriginalMaterial = mesh.material
      mesh.userData.externalOriginalRenderOrder = mesh.renderOrder
      mesh.userData.externalPlanMaterial = new THREE.MeshBasicMaterial({
        color: externalPlanColors[renderType ?? ''] ?? 0xaab5c1,
        transparent: true,
        opacity: renderType === 'CEILING' ? 0.16 : 0.88,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      })
      if (renderType !== 'CEILING') {
        const outline = new THREE.LineSegments(
          new THREE.EdgesGeometry(mesh.geometry, 28),
          new THREE.LineBasicMaterial({
            color: externalPlanColors[renderType ?? ''] ?? 0xe5edf5,
            transparent: true,
            opacity: 0.95,
            depthTest: false,
            depthWrite: false,
            toneMapped: false,
          }),
        )
        outline.name = '__external-plan-outline'
        outline.userData.externalPlanOutline = true
        outline.renderOrder = 120
        outline.visible = false
        mesh.add(outline)
      }
    }
    for (const child of object.children.filter((candidate) => !candidate.userData.externalPlanOutline)) {
      visit(child, renderType)
    }
  }
  visit(root)
  return { semanticNodes, meshObjects }
}

function applyExternalViewMode() {
  const plan = props.mode === '2D'
  externalModel.traverse((object) => {
    if (object.userData.externalPlanOutline) {
      object.visible = plan
      return
    }
    if (!(object as THREE.Mesh).isMesh) return
    const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>
    const original = mesh.userData.externalOriginalMaterial as THREE.Material | THREE.Material[] | undefined
    const planMaterial = mesh.userData.externalPlanMaterial as THREE.Material | undefined
    if (!original || !planMaterial) return
    mesh.material = plan ? planMaterial : original
    const renderType = mesh.userData.externalRenderType as string | undefined
    mesh.renderOrder = plan
      ? (renderType === 'CEILING' ? 1 : 40)
      : (mesh.userData.externalOriginalRenderOrder as number | undefined) ?? 0
  })
  if (scene) scene.fog = plan && externalModel.children.length === 0
    ? new THREE.Fog(0x0f161f, 28, 70)
    : null
}

function externalLoadErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message) return message
  }
  return 'Failed to load external GLB'
}

function loadExternalGlb(data: ArrayBuffer | undefined) {
  const request = ++externalLoadRequest
  if (!data) {
    disposeExternalModel()
    applyExternalViewMode()
    if (scene) fitView()
    return
  }

  console.info(`${EXTERNAL_LOG_PREFIX} load:start`, { request, bytes: data.byteLength })
  try {
    gltfLoader.parse(
      data,
      '',
      (gltf) => {
        if (request !== externalLoadRequest || !scene) {
          disposeObjectResources(gltf.scene)
          return
        }
        disposeExternalModel()
        externalModel.add(gltf.scene)
        const summary = prepareExternalModel(gltf.scene)
        applyExternalViewMode()
        fitView()
        console.info(`${EXTERNAL_LOG_PREFIX} load:success`, {
          request,
          ...summary,
          animations: gltf.animations.length,
        })
      },
      (error) => {
        if (request !== externalLoadRequest || !scene) return
        disposeExternalModel()
        const message = externalLoadErrorMessage(error)
        console.error(`${EXTERNAL_LOG_PREFIX} load:error`, { request, message, error })
        emit('external-load-error', message)
      },
    )
  } catch (error) {
    if (request !== externalLoadRequest || !scene) return
    disposeExternalModel()
    const message = externalLoadErrorMessage(error)
    console.error(`${EXTERNAL_LOG_PREFIX} load:error`, { request, message, error })
    emit('external-load-error', message)
  }
}

function syncSelectionHighlight() {
  if (!scene) return
  const selected = new Set(props.selectedIds ?? [])
  if (props.selectedId) selected.add(props.selectedId)
  for (const object of objects.children) {
    const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>
    const entityId = objectEntityId(mesh)
    const isSelected = entityId ? selected.has(entityId) : false
    applyMeshSelectionHighlight(mesh, isSelected)
  }
}

function rebuild() {
  if (!scene) return
  for (const child of [...objects.children]) {
    disposeObjectResources(child)
    objects.remove(child)
  }
  for (const entity of props.floor.entities) {
    if (entity.visible !== false) objects.add(entityMesh(entity))
  }
  applyDomainViewMode()
  syncSelectionHighlight()
}

function configureCamera() {
  if (!host.value || !controls) return
  const width = host.value.clientWidth
  const height = Math.max(1, host.value.clientHeight)
  const aspect = width / height
  orthographic.left = -10 * aspect
  orthographic.right = 10 * aspect
  orthographic.top = 10
  orthographic.bottom = -10
  orthographic.updateProjectionMatrix()
  perspective.aspect = aspect
  perspective.updateProjectionMatrix()
  controls.object = activeCamera()
  const profile = cameraInteractionProfile(props.mode)
  controls.enableRotate = profile.modifiedMiddle === 'rotate'
  controls.enablePan = true
  controls.enableZoom = true
  controls.zoomToCursor = true
  controls.enableDamping = true
  controls.mouseButtons = {
    LEFT: null,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: null,
  }
  controls.update()
}

function fitView() {
  const box = new THREE.Box3()
  box.expandByObject(objects)
  box.expandByObject(externalModel)
  if (box.isEmpty()) return
  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  const aspect = Math.max(0.1, (host.value?.clientWidth ?? 1) / (host.value?.clientHeight ?? 1))
  grid.position.x = center.x
  grid.position.z = center.z
  if (props.mode === '2D') {
    const halfHeight = Math.max(size.z / 2, size.x / (2 * aspect), 1) * 1.12
    orthographic.left = -halfHeight * aspect
    orthographic.right = halfHeight * aspect
    orthographic.top = halfHeight
    orthographic.bottom = -halfHeight
    orthographic.position.set(center.x, 30, center.z)
    orthographic.near = 0.01
    orthographic.far = Math.max(100, size.y + 60)
    orthographic.lookAt(center.x, center.y, center.z)
    orthographic.updateProjectionMatrix()
  } else {
    const verticalFov = THREE.MathUtils.degToRad(perspective.fov)
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect)
    const limitingFov = Math.min(verticalFov, horizontalFov)
    const distance = (Math.max(size.y, size.z, size.x) / 2) / Math.tan(limitingFov / 2) * 1.15
    const viewDirection = new THREE.Vector3(0.75, 0.65, 1).normalize()
    perspective.position.copy(center).addScaledVector(viewDirection, distance)
    perspective.near = Math.max(0.01, distance / 100)
    perspective.far = Math.max(100, distance * 10)
    perspective.updateProjectionMatrix()
  }
  controls.target.copy(center)
  controls.update()
  console.info(`${EXTERNAL_LOG_PREFIX} view:fit`, {
    mode: props.mode,
    center: center.toArray().map((value) => Number(value.toFixed(3))),
    size: size.toArray().map((value) => Number(value.toFixed(3))),
    camera: activeCamera().position.toArray().map((value) => Number(value.toFixed(3))),
    fog: scene.fog instanceof THREE.Fog
      ? { near: scene.fog.near, far: scene.fog.far }
      : scene.fog ? { density: scene.fog.density } : null,
  })
}

function localPointer(event: MouseEvent | PointerEvent): ScreenPoint | undefined {
  if (!host.value) return undefined
  const rect = host.value.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function updateRayPointer(event: MouseEvent | PointerEvent) {
  if (!host.value) return false
  const rect = host.value.getBoundingClientRect()
  pointer.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  )
  activeCamera().updateMatrixWorld(true)
  objects.updateMatrixWorld(true)
  raycaster.setFromCamera(pointer, activeCamera())
  return true
}

function objectEntityId(object: THREE.Object3D): string | undefined {
  let current: THREE.Object3D | null = object
  while (current && current !== objects) {
    if (typeof current.userData.entityId === 'string') return current.userData.entityId
    current = current.parent
  }
  return undefined
}

function pickedEntityId(event: MouseEvent | PointerEvent) {
  if (!updateRayPointer(event)) return undefined
  for (const hit of raycaster.intersectObjects(objects.children, true)) {
    const entityId = objectEntityId(hit.object)
    if (entityId) return entityId
  }
  return undefined
}

function resolveAlignedGroundPoint(event: MouseEvent | PointerEvent): GroundPointResult | undefined {
  if (!updateRayPointer(event)) return undefined
  const output = new THREE.Vector3()
  const floorElevation = props.floorElevation ?? 0
  if (!raycaster.ray.intersectPlane(
    new THREE.Plane(new THREE.Vector3(0, 1, 0), -floorElevation),
    output,
  )) return undefined
  const step = props.gridSize || 0.1
  const snapEnabled = props.snapEnabled !== false
  const allowAlign = snapEnabled && !event.altKey
  const snapped = resolveGridPoint({ x: output.x, z: output.z }, step, snapEnabled)
  if (!allowAlign) return { point: snapped, alignedX: false, alignedZ: false }
  let nearest: Vec2 | undefined
  let nearestDistance = Math.max(0.2, step * 2)
  for (const entity of props.floor.entities) {
    if (entity.kind !== 'wall') continue
    for (const endpoint of [entity.start, entity.end]) {
      const distance = Math.hypot(endpoint.x - snapped.x, endpoint.z - snapped.z)
      if (distance < nearestDistance) {
        nearest = endpoint
        nearestDistance = distance
      }
    }
  }
  if (nearest) return { point: nearest, alignedX: true, alignedZ: true }

  const guideX = new Set<number>()
  const guideZ = new Set<number>()
  if (wallStart) {
    guideX.add(wallStart.x)
    guideZ.add(wallStart.z)
  }
  for (const entity of props.floor.entities) {
    if (entity.kind !== 'wall') continue
    guideX.add(entity.start.x)
    guideX.add(entity.end.x)
    guideZ.add(entity.start.z)
    guideZ.add(entity.end.z)
  }
  const guideAligned = { ...snapped }
  const guideTolerance = Math.max(wallAlignmentTolerance, step / 2.5)
  let snappedByGuide = false
  let nearestGuideX: { value: number; distance: number } | undefined
  for (const x of guideX) {
    const distance = Math.abs(x - snapped.x)
    if (distance <= guideTolerance && (!nearestGuideX || distance < nearestGuideX.distance)) {
      nearestGuideX = { value: x, distance }
    }
  }
  if (nearestGuideX) {
    guideAligned.x = nearestGuideX.value
    snappedByGuide = true
  }
  let nearestGuideZ: { value: number; distance: number } | undefined
  for (const z of guideZ) {
    const distance = Math.abs(z - snapped.z)
    if (distance <= guideTolerance && (!nearestGuideZ || distance < nearestGuideZ.distance)) {
      nearestGuideZ = { value: z, distance }
    }
  }
  if (nearestGuideZ) {
    guideAligned.z = nearestGuideZ.value
    snappedByGuide = true
  }
  if (snappedByGuide) {
    return {
      point: guideAligned,
      alignedX: Boolean(nearestGuideX),
      alignedZ: Boolean(nearestGuideZ),
    }
  }
  return {
    point: snapped,
    alignedX: false,
    alignedZ: false,
  }
}

function updateWallAlignmentGuides(point: Vec2, alignedX: boolean, alignedZ: boolean) {
  if (!alignedX && !alignedZ) {
    hideWallAlignmentGuides()
    return
  }

  const bounds = new THREE.Box3().setFromObject(objects)
  const hasBounds = !bounds.isEmpty()
  const minX = (hasBounds ? bounds.min.x : -20) - WALL_ALIGNMENT_VIEW_PADDING
  const maxX = (hasBounds ? bounds.max.x : 20) + WALL_ALIGNMENT_VIEW_PADDING
  const minZ = (hasBounds ? bounds.min.z : -20) - WALL_ALIGNMENT_VIEW_PADDING
  const maxZ = (hasBounds ? bounds.max.z : 20) + WALL_ALIGNMENT_VIEW_PADDING
  const guideY = (props.floorElevation ?? 0) + 0.03

  if (alignedX) {
    const position = wallAlignmentLineX.geometry.getAttribute('position') as THREE.BufferAttribute
    position.setXYZ(0, point.x, guideY, minZ)
    position.setXYZ(1, point.x, guideY, maxZ)
    position.needsUpdate = true
    wallAlignmentLineX.computeLineDistances()
    wallAlignmentLineX.geometry.computeBoundingSphere()
    wallAlignmentLineX.visible = true
  } else {
    wallAlignmentLineX.visible = false
  }

  if (alignedZ) {
    const position = wallAlignmentLineZ.geometry.getAttribute('position') as THREE.BufferAttribute
    position.setXYZ(0, minX, guideY, point.z)
    position.setXYZ(1, maxX, guideY, point.z)
    position.needsUpdate = true
    wallAlignmentLineZ.computeLineDistances()
    wallAlignmentLineZ.geometry.computeBoundingSphere()
    wallAlignmentLineZ.visible = true
  } else {
    wallAlignmentLineZ.visible = false
  }

  wallAlignmentGuideGroup.visible = alignedX || alignedZ
}

function hideWallAlignmentGuides() {
  wallAlignmentGuideGroup.visible = false
  wallAlignmentLineX.visible = false
  wallAlignmentLineZ.visible = false
}

function initializeWallPreview() {
  const fillMaterial = new THREE.MeshBasicMaterial({
    color: 0x4ce0bd,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
  })
  wallPreviewMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), fillMaterial)
  wallPreviewMesh.renderOrder = 40
  wallPreviewLine = new THREE.Line(
    new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3)),
    new THREE.LineBasicMaterial({ color: 0xbaffef, depthTest: false }),
  )
  wallPreviewLine.renderOrder = 42
  const markerGeometry = new THREE.SphereGeometry(0.1, 12, 8)
  wallPreviewStartMarker = new THREE.Mesh(
    markerGeometry,
    new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }),
  )
  wallPreviewEndMarker = new THREE.Mesh(
    markerGeometry.clone(),
    new THREE.MeshBasicMaterial({ color: 0x4ce0bd, depthTest: false }),
  )
  wallPreviewStartMarker.renderOrder = 43
  wallPreviewEndMarker.renderOrder = 43
  wallPreview.add(wallPreviewMesh, wallPreviewLine, wallPreviewStartMarker, wallPreviewEndMarker)
  wallPreview.visible = false
  scene.add(wallPreview)

  const guideMaterial = new THREE.LineDashedMaterial({
    color: 0xffe066,
    dashSize: 0.26,
    gapSize: 0.12,
    transparent: true,
    opacity: 0.85,
  })
  const guideLineGeometry = new THREE.BufferGeometry().setAttribute(
    'position',
    new THREE.Float32BufferAttribute(new Float32Array(6), 3),
  )
  wallAlignmentLineX = new THREE.Line(guideLineGeometry, guideMaterial.clone())
  wallAlignmentLineZ = new THREE.Line(guideLineGeometry.clone(), guideMaterial.clone())
  wallAlignmentLineX.renderOrder = 44
  wallAlignmentLineZ.renderOrder = 44
  wallAlignmentLineX.visible = false
  wallAlignmentLineZ.visible = false
  wallAlignmentGuideGroup = new THREE.Group()
  wallAlignmentGuideGroup.name = 'wall-alignment-guides'
  wallAlignmentGuideGroup.visible = false
  wallAlignmentGuideGroup.add(wallAlignmentLineX, wallAlignmentLineZ)
  scene.add(wallAlignmentGuideGroup)
  wallAlignmentLineX.computeLineDistances()
  wallAlignmentLineZ.computeLineDistances()
}

function initializeSpacePreview() {
  spacePreview.name = 'space-polygon-preview'
  spacePreviewFill = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({
      color: 0x35d7b5,
      transparent: true,
      opacity: 0.28,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  )
  spacePreviewFill.renderOrder = 70
  spacePreviewFill.visible = false
  spacePreviewLine = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x9fffea, depthTest: false, depthWrite: false }),
  )
  spacePreviewLine.renderOrder = 72
  spacePreviewLine.visible = false
  spacePreview.add(spacePreviewFill, spacePreviewLine, spacePreviewMarkers)
  spacePreview.visible = false
  scene.add(spacePreview)
}

function replaceSpacePreviewFill(points: readonly Vec2[]) {
  spacePreviewFill.geometry.dispose()
  if (points.length < 3) {
    spacePreviewFill.geometry = new THREE.BufferGeometry()
    spacePreviewFill.visible = false
    return
  }
  const shape = new THREE.Shape()
  shape.moveTo(points[0]!.x, points[0]!.z)
  for (const point of points.slice(1)) shape.lineTo(point.x, point.z)
  shape.closePath()
  const geometry = new THREE.ShapeGeometry(shape)
  geometry.rotateX(Math.PI / 2)
  spacePreviewFill.geometry = geometry
  spacePreviewFill.position.y = (props.floorElevation ?? 0) + 0.035
  spacePreviewFill.visible = true
}

function rebuildSpacePreviewMarkers() {
  for (const child of [...spacePreviewMarkers.children]) {
    disposeObjectResources(child)
    spacePreviewMarkers.remove(child)
  }
  const elevation = (props.floorElevation ?? 0) + 0.065
  for (const [index, point] of spaceDraft.entries()) {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(index === 0 ? 0.14 : 0.1, 12, 8),
      new THREE.MeshBasicMaterial({
        color: index === 0 ? 0xffffff : 0x4ce0bd,
        depthTest: false,
        depthWrite: false,
      }),
    )
    marker.position.set(point.x, elevation, point.z)
    marker.renderOrder = 73
    spacePreviewMarkers.add(marker)
  }
}

function updateSpacePreview(hover?: Vec2) {
  spaceHover = hover ? { ...hover } : undefined
  spacePreview.visible = spaceDraft.length > 0
  if (spaceDraft.length === 0) {
    spacePreviewLine.visible = false
    replaceSpacePreviewFill([])
    return
  }
  const candidate = hover && !pointsEqual(hover, spaceDraft[spaceDraft.length - 1]!)
    ? [...spaceDraft, hover]
    : [...spaceDraft]
  const linePoints = candidate.map((point) => new THREE.Vector3(
    point.x,
    (props.floorElevation ?? 0) + 0.06,
    point.z,
  ))
  if (candidate.length >= 3) {
    const first = candidate[0]!
    linePoints.push(new THREE.Vector3(first.x, (props.floorElevation ?? 0) + 0.06, first.z))
  }
  spacePreviewLine.geometry.dispose()
  spacePreviewLine.geometry = new THREE.BufferGeometry().setFromPoints(linePoints)
  spacePreviewLine.visible = linePoints.length >= 2
  replaceSpacePreviewFill(candidate)
  hint.value = `${spaceDraft.length} 个顶点 · 继续点击添加${spaceDraft.length >= 3 ? ' · Enter 生成空间' : ''} · Esc 取消当前多边形`
}

function scheduleSpacePreview(hover: Vec2) {
  pendingSpaceHover = { ...hover }
  if (spacePreviewFrame) return
  spacePreviewFrame = requestAnimationFrame(() => {
    spacePreviewFrame = 0
    const next = pendingSpaceHover
    pendingSpaceHover = undefined
    if (next && props.activeTool === '空间' && spaceDraft.length) updateSpacePreview(next)
  })
}

function clearSpaceDraft() {
  const hadDraft = spaceDraft.length > 0
  spaceDraft = []
  spaceHover = undefined
  pendingSpaceHover = undefined
  if (spacePreviewFrame) cancelAnimationFrame(spacePreviewFrame)
  spacePreviewFrame = 0
  spacePreview.visible = false
  spacePreviewLine.visible = false
  replaceSpacePreviewFill([])
  rebuildSpacePreviewMarkers()
  return hadDraft
}

function addSpaceDraftPoint(point: Vec2) {
  if (spaceDraft.some((current) => pointsEqual(current, point))) {
    hint.value = '该顶点与已有顶点重复，请选择其他位置 · Esc 取消当前多边形'
    return
  }
  spaceDraft.push({ ...point })
  rebuildSpacePreviewMarkers()
  updateSpacePreview(point)
}

function commitSpaceDraft() {
  const decision = decideSpacePolygonCommit(spaceDraft)
  if (!decision.accepted) {
    const message = {
      'too-few-points': '至少需要 3 个顶点才能生成空间',
      'duplicate-points': '空间边界包含重复顶点',
      'too-small': '空间面积过小，请扩大边界',
      'self-intersection': '空间边界不能自交，已撤销最后一个顶点',
    }[decision.reason]
    if (decision.reason === 'self-intersection') {
      spaceDraft.pop()
      rebuildSpacePreviewMarkers()
      updateSpacePreview(spaceDraft[spaceDraft.length - 1])
    }
    hint.value = `${message} · 继续绘制或按 Esc 取消`
    return false
  }
  emit('create', {
    tool: '空间',
    point: decision.centroid,
    polygon: decision.polygon,
  })
  clearSpaceDraft()
  hint.value = `空间已创建 · 继续点击绘制下一个空间 · Enter 确定 · Esc 取消当前多边形`
  return true
}

function updateWallPreview(point: Vec2, forceOrthogonal = false) {
  if (!wallStart || !wallPreviewMesh) return undefined
  const resolved = resolveWallEndpoint(wallStart, point, forceOrthogonal)
  const metrics = wallPreviewMetrics(wallStart, resolved.end)
  const dimensions = resolveWallPreviewDimensions(
    props.floor.clearHeight,
    props.wallHeight,
    props.wallThickness,
  )
  const previewHeight = dimensions.height
  const previewThickness = dimensions.thickness
  const floorElevation = props.floorElevation ?? 0
  const angle = -Math.atan2(resolved.end.z - wallStart.z, resolved.end.x - wallStart.x)
  wallPreview.visible = true
  wallPreviewStartMarker.visible = true
  wallPreviewStartMarker.position.set(wallStart.x, floorElevation + previewHeight + 0.04, wallStart.z)
  wallPreviewEndMarker.visible = metrics.length > 1e-6
  wallPreviewEndMarker.position.set(resolved.end.x, floorElevation + previewHeight + 0.04, resolved.end.z)
  wallPreviewMesh.visible = metrics.length > 1e-6
  wallPreviewMesh.position.set(
    (wallStart.x + resolved.end.x) / 2,
    floorElevation + previewHeight / 2,
    (wallStart.z + resolved.end.z) / 2,
  )
  wallPreviewMesh.rotation.y = angle
  wallPreviewMesh.scale.set(Math.max(metrics.length, 1e-6), previewHeight, previewThickness)
  wallPreviewLine.visible = metrics.length > 1e-6
  const position = wallPreviewLine.geometry.getAttribute('position') as THREE.BufferAttribute
  position.setXYZ(0, wallStart.x, floorElevation + previewHeight + 0.04, wallStart.z)
  position.setXYZ(1, resolved.end.x, floorElevation + previewHeight + 0.04, resolved.end.z)
  position.needsUpdate = true
  wallPreviewLine.geometry.computeBoundingSphere()
  hint.value = metrics.length > 1e-6
    ? `长度 ${metrics.length.toFixed(2)} m · 方向 ${metrics.angleDegrees.toFixed(1)}°${resolved.orthogonal ? ' · 正交' : ''} · 点击完成 · Esc 退出绘制`
    : '移动鼠标预览墙体 · Shift 正交 · Esc 退出绘制'
  return resolved.end
}

function clearWallPreview() {
  wallPreview.visible = false
  wallPreviewMesh && (wallPreviewMesh.visible = false)
  wallPreviewLine && (wallPreviewLine.visible = false)
  wallPreviewStartMarker && (wallPreviewStartMarker.visible = false)
  wallPreviewEndMarker && (wallPreviewEndMarker.visible = false)
  hideWallAlignmentGuides()
}

function projectEntityBounds(): ProjectedEntityBounds[] {
  if (!host.value) return []
  const width = host.value.clientWidth
  const height = host.value.clientHeight
  if (width <= 0 || height <= 0) return []

  const camera = activeCamera()
  camera.updateMatrixWorld(true)
  objects.updateMatrixWorld(true)
  const viewProjection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  const frustum = new THREE.Frustum().setFromProjectionMatrix(viewProjection)
  const objectByEntityId = new Map<string, THREE.Object3D>()
  for (const object of objects.children) {
    const entityId = objectEntityId(object)
    if (entityId) objectByEntityId.set(entityId, object)
  }

  const projected: ProjectedEntityBounds[] = []
  for (const entity of props.floor.entities) {
    const object = objectByEntityId.get(entity.id)
    if (!object) continue
    const worldBounds = new THREE.Box3().setFromObject(object)
    if (worldBounds.isEmpty() || !frustum.intersectsBox(worldBounds)) continue

    const mesh = object as THREE.Mesh
    const geometry = mesh.geometry
    geometry.computeBoundingBox()
    const localBounds = geometry.boundingBox
    if (!localBounds) continue
    let left = Number.POSITIVE_INFINITY
    let top = Number.POSITIVE_INFINITY
    let right = Number.NEGATIVE_INFINITY
    let bottom = Number.NEGATIVE_INFINITY
    for (const x of [localBounds.min.x, localBounds.max.x]) {
      for (const y of [localBounds.min.y, localBounds.max.y]) {
        for (const z of [localBounds.min.z, localBounds.max.z]) {
          const corner = new THREE.Vector3(x, y, z).applyMatrix4(object.matrixWorld).project(camera)
          const screenX = (corner.x + 1) * 0.5 * width
          const screenY = (1 - corner.y) * 0.5 * height
          if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) continue
          left = Math.min(left, screenX)
          top = Math.min(top, screenY)
          right = Math.max(right, screenX)
          bottom = Math.max(bottom, screenY)
        }
      }
    }
    if (![left, top, right, bottom].every(Number.isFinite)) continue
    projected.push({
      id: entity.id,
      bounds: { left, top, right, bottom },
      visible: entity.visible !== false,
      locked: entity.locked,
    })
  }
  return projected
}

function clearSelectionDrag() {
  const drag = selectionDrag
  if (drag) {
    const camera = drag.cameraState.camera
    camera.position.copy(drag.cameraState.position)
    camera.quaternion.copy(drag.cameraState.quaternion)
    camera.zoom = drag.cameraState.zoom
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld(true)
    controls.target.copy(drag.cameraState.target)
  }
  const pointerId = selectionDrag?.pointerId
  if (pointerId !== undefined && renderer?.domElement.hasPointerCapture(pointerId)) {
    renderer.domElement.releasePointerCapture(pointerId)
  }
  selectionDrag = undefined
  selectionBox.value = undefined
  if (controls) controls.enabled = true
}

function onSelectionPointerDown(event: PointerEvent) {
  if (props.activeTool !== '选择' || !renderer || !host.value) return
  if (event.button === 2) {
    event.preventDefault()
    event.stopImmediatePropagation()
    return
  }
  if (event.button !== 0) return
  renderer.domElement.focus({ preventScroll: true })
  suppressNextClick = false
  const start = localPointer(event)
  if (!start) return
  const camera = activeCamera()
  selectionDrag = {
    pointerId: event.pointerId,
    start,
    end: start,
    additive: event.shiftKey,
    pressedEntityId: pickedEntityId(event),
    cameraState: {
      camera,
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      zoom: camera.zoom,
      target: controls.target.clone(),
    },
  }
  controls.enabled = false
  renderer.domElement.setPointerCapture(event.pointerId)
  event.preventDefault()
  event.stopImmediatePropagation()
}

function onSelectionPointerMove(event: PointerEvent) {
  if (!selectionDrag || event.pointerId !== selectionDrag.pointerId) return
  const end = localPointer(event)
  if (!end) return
  selectionDrag.end = end
  if (exceedsDragThreshold(selectionDrag.start, end, BOX_DRAG_THRESHOLD)) {
    selectionBox.value = { start: selectionDrag.start, end }
  }
  event.preventDefault()
  event.stopImmediatePropagation()
}

function onSelectionPointerUp(event: PointerEvent) {
  if (!selectionDrag || event.pointerId !== selectionDrag.pointerId) return
  const drag = selectionDrag
  const end = localPointer(event) ?? drag.end
  const dragged = exceedsDragThreshold(drag.start, end, BOX_DRAG_THRESHOLD)
  let payload: ViewportSelectionPayload | undefined
  let clickedEntityId: string | undefined
  if (dragged) {
    const boxMode = boxSelectionMode(drag.start, end)
    payload = {
      ids: selectProjectedEntityIds(
        projectEntityBounds(),
        screenRectFromPoints(drag.start, end),
        boxMode,
      ),
      boxMode,
      operation: drag.additive || event.shiftKey ? 'merge' : 'replace',
      source: 'box',
    }
  } else {
    clickedEntityId = pickedEntityId(event) ?? drag.pressedEntityId
    if (!clickedEntityId) payload = blankSelectionPayload()
  }
  clearSelectionDrag()
  suppressNextClick = true
  if (payload) {
    emit('selection', payload)
  } else if (clickedEntityId) {
    emit('select', clickedEntityId, drag.additive || event.shiftKey)
  }
  event.preventDefault()
  event.stopImmediatePropagation()
}

function onSelectionPointerCancel(event: PointerEvent) {
  if (!selectionDrag || event.pointerId !== selectionDrag.pointerId) return
  clearSelectionDrag()
  event.stopImmediatePropagation()
}

function currentSelectionIds() {
  const ids = [...(props.selectedIds ?? [])]
  if (props.selectedId && !ids.includes(props.selectedId)) ids.unshift(props.selectedId)
  return ids
}

function onSelectionContextMenu(event: MouseEvent) {
  if (props.activeTool !== '选择') return
  event.preventDefault()
  event.stopImmediatePropagation()
  const resolution = resolveSelectionContext(currentSelectionIds(), pickedEntityId(event))
  if (resolution.selectHit) emit('select', resolution.ids[0]!, false)
  if (resolution.ids.length === 0) return
  emit('selection-context', {
    clientX: event.clientX,
    clientY: event.clientY,
    ids: resolution.ids,
  })
}

function onPointerMove(event: PointerEvent) {
  const aligned = resolveAlignedGroundPoint(event)
  if (!aligned) return
  emit('pointer', aligned.point)
  if (props.activeTool === '墙体' && wallStart) {
    const snappedPoint = updateWallPreview(aligned.point, event.shiftKey)
    if (snappedPoint) {
      updateWallAlignmentGuides(snappedPoint, aligned.alignedX, aligned.alignedZ)
    } else {
      hideWallAlignmentGuides()
    }
  } else if (props.activeTool === '空间' && props.mode === '2D' && spaceDraft.length) {
    scheduleSpacePreview(aligned.point)
    hideWallAlignmentGuides()
  } else {
    hideWallAlignmentGuides()
  }
}

function onClick(event: MouseEvent) {
  if (suppressNextClick) {
    suppressNextClick = false
    event.preventDefault()
    return
  }
  if (props.activeTool === '选择') {
    const entityId = pickedEntityId(event)
    if (entityId) emit('select', entityId, event.shiftKey)
    else emit('selection', blankSelectionPayload())
    return
  }
  renderer.domElement.focus({ preventScroll: true })
  const aligned = resolveAlignedGroundPoint(event)
  if (!aligned) return
  const point = aligned.point
  if (props.activeTool === '空间') {
    if (props.mode !== '2D') {
      hint.value = '空间边界请在 2D 平面视图中绘制'
      return
    }
    addSpaceDraftPoint(point)
  } else if (props.activeTool === '墙体') {
    if (!wallStart) {
      wallStart = point
      updateWallPreview(point, event.shiftKey)
      hideWallAlignmentGuides()
    } else {
      const start = wallStart
      const decision = decideWallCommit(start, point, event.shiftKey)
      if (!decision.accepted) {
        updateWallPreview(point, event.shiftKey)
        updateWallAlignmentGuides(point, aligned.alignedX, aligned.alignedZ)
        hint.value = `墙长需大于 ${decision.minimum.toFixed(2)} m · 请重新指定终点 · Esc 取消`
        emit('wall-rejected', {
          reason: 'too-short',
          length: decision.length,
          minimum: decision.minimum,
        })
        return
      }
      wallStart = decision.end
      updateWallPreview(wallStart, event.shiftKey)
      hideWallAlignmentGuides()
      hint.value = `已完成一段墙体 · 点击新终点继续绘制，或按 Esc 退出`
      emit('create', { tool: props.activeTool, point: start, end: decision.end })
    }
  } else {
    emit('create', { tool: props.activeTool, point })
  }
}

function cancelActiveCommand() {
  const cancelled = Boolean(wallStart || spaceDraft.length || selectionDrag || selectionBox.value)
  wallStart = undefined
  hint.value = ''
  clearWallPreview()
  clearSpaceDraft()
  clearSelectionDrag()
  suppressNextClick = false
  hideWallAlignmentGuides()
  return cancelled
}

function onKey(event: KeyboardEvent) {
  const viewportHasFocus = Boolean(renderer && document.activeElement === renderer.domElement)
  if (event.key === 'Enter' && props.activeTool === '空间' && spaceDraft.length > 0 && viewportHasFocus) {
    event.preventDefault()
    event.stopImmediatePropagation()
    commitSpaceDraft()
    return
  }
  if (event.key !== 'Escape') return
  const action = resolveViewportEscapeAction(
    props.activeTool,
    Boolean(wallStart || spaceDraft.length || selectionDrag || selectionBox.value),
  )
  if (action === 'none') return
  event.preventDefault()
  event.stopImmediatePropagation()
  cancelActiveCommand()
}

defineExpose({ fitView, cancelActiveCommand })

onMounted(() => {
  if (!host.value) return
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0f161f)
  scene.fog = new THREE.Fog(0x0f161f, 28, 70)
  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.domElement.tabIndex = 0
  renderer.domElement.setAttribute('aria-label', '模型绘制视口')
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.outputColorSpace = THREE.SRGBColorSpace
  host.value.prepend(renderer.domElement)
  perspective = new THREE.PerspectiveCamera(42, 1, 0.05, 300)
  perspective.position.set(11, 10, 14)
  orthographic = new THREE.OrthographicCamera(-12, 12, 10, -10, 0.01, 100)
  orthographic.position.set(0, 30, 0)
  orthographic.up.set(0, 0, -1)
  orthographic.lookAt(0, 0, 0)
  controls = new OrbitControls(activeCamera(), renderer.domElement)
  controls.target.set(0, 0, 0)
  controls.enableDamping = true
  grid.position.y = (props.floorElevation ?? 0) - 0.015
  scene.add(grid, objects, externalModel, new THREE.HemisphereLight(0xb8d8ff, 0x27303a, 2.4))
  initializeWallPreview()
  initializeSpacePreview()
  const sun = new THREE.DirectionalLight(0xffffff, 2.2)
  sun.position.set(8, 15, 7)
  sun.castShadow = true
  scene.add(sun)
  resizeObserver = new ResizeObserver(() => {
    if (!host.value) return
    renderer.setSize(host.value.clientWidth, host.value.clientHeight, false)
    configureCamera()
  })
  resizeObserver.observe(host.value)
  rebuild()
  configureCamera()
  fitView()
  loadExternalGlb(props.externalGlb)

  renderer.domElement.addEventListener('pointerdown', onSelectionPointerDown, true)
  renderer.domElement.addEventListener('pointermove', onSelectionPointerMove, true)
  renderer.domElement.addEventListener('pointerup', onSelectionPointerUp, true)
  renderer.domElement.addEventListener('pointercancel', onSelectionPointerCancel, true)
  renderer.domElement.addEventListener('contextmenu', onSelectionContextMenu, true)
  renderer.domElement.addEventListener('click', onClick)
  renderer.domElement.addEventListener('pointermove', onPointerMove)
  window.addEventListener('keydown', onKey)
  const animate = () => {
    frame = requestAnimationFrame(animate)
    if (!selectionDrag) controls.update()
    renderer.render(scene, activeCamera())
  }
  animate()
})

watch(() => props.floor, rebuild, { deep: true })
watch(() => props.externalGlb, loadExternalGlb)
watch(() => props.floorElevation, () => {
  grid.position.y = (props.floorElevation ?? 0) - 0.015
  rebuild()
  fitView()
})
watch(() => props.floor.id, () => cancelActiveCommand())
watch(() => [props.selectedId, ...(props.selectedIds ?? [])], syncSelectionHighlight)
watch(() => props.mode, () => {
  cancelActiveCommand()
  configureCamera()
  applyDomainViewMode()
  applyExternalViewMode()
  fitView()
  console.info(`${EXTERNAL_LOG_PREFIX} view:mode`, { mode: props.mode })
})
watch(() => props.activeTool, () => {
  cancelActiveCommand()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  clearSelectionDrag()
  resizeObserver?.disconnect()
  renderer?.domElement.removeEventListener('pointerdown', onSelectionPointerDown, true)
  renderer?.domElement.removeEventListener('pointermove', onSelectionPointerMove, true)
  renderer?.domElement.removeEventListener('pointerup', onSelectionPointerUp, true)
  renderer?.domElement.removeEventListener('pointercancel', onSelectionPointerCancel, true)
  renderer?.domElement.removeEventListener('contextmenu', onSelectionContextMenu, true)
  renderer?.domElement.removeEventListener('click', onClick)
  renderer?.domElement.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('keydown', onKey)
  disposeObjectResources(wallPreview)
  disposeObjectResources(spacePreview)
  disposeObjectResources(wallAlignmentGuideGroup)
  disposeObjectResources(objects)
  disposeObjectResources(grid)
  ++externalLoadRequest
  disposeExternalModel()
  scene?.remove(wallAlignmentGuideGroup)
  scene?.remove(wallPreview)
  scene?.remove(spacePreview)
  scene?.remove(objects)
  scene?.remove(grid)
  controls?.dispose()
  renderer?.dispose()
})
</script>

<template>
  <div
    ref="host"
    class="viewport-host"
    :class="{ 'is-select-tool': activeTool === '选择', 'is-space-tool': activeTool === '空间', 'is-box-selecting': !!selectionBox }"
  >
    <div
      v-if="selectionBox"
      class="selection-box"
      :class="`selection-box--${currentBoxMode}`"
      :style="selectionBoxStyle"
    >
      <span>{{ currentBoxMode === 'window' ? '窗口选择' : '交叉选择' }}</span>
    </div>
    <div class="north">N<span /></div>
    <div v-if="activeTool !== '选择'" class="tool-hint">
      {{ hint || (activeTool === '空间' ? '空间工具 · 逐点绘制边界 · Enter 确定 · Esc 取消' : `${activeTool}工具 · 在网格中点击放置`) }}
    </div>
    <slot />
  </div>
</template>

<style scoped>
.viewport-host {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #0f161f;
  user-select: none;
}

.viewport-host :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
  outline: none;
}

.viewport-host.is-select-tool :deep(canvas) { cursor: crosshair; }
.viewport-host.is-space-tool :deep(canvas) { cursor: crosshair; }

.selection-box {
  position: absolute;
  z-index: 4;
  box-sizing: border-box;
  pointer-events: none;
}

.selection-box span {
  position: absolute;
  left: 5px;
  top: 5px;
  padding: 2px 5px;
  border-radius: 3px;
  color: #effffb;
  font-size: 9px;
  line-height: 1.3;
  white-space: nowrap;
  backdrop-filter: blur(4px);
}

.selection-box--window {
  border: 1px solid #4ce0bd;
  background: rgb(43 203 166 / 13%);
  box-shadow: inset 0 0 0 1px rgb(76 224 189 / 12%);
}

.selection-box--window span {
  border: 1px solid rgb(76 224 189 / 55%);
  background: rgb(15 83 70 / 88%);
}

.selection-box--crossing {
  border: 1px dashed #f0b85f;
  background:
    repeating-linear-gradient(
      -45deg,
      rgb(240 184 95 / 9%) 0,
      rgb(240 184 95 / 9%) 5px,
      rgb(240 184 95 / 3%) 5px,
      rgb(240 184 95 / 3%) 10px
    );
}

.selection-box--crossing span {
  border: 1px dashed rgb(240 184 95 / 65%);
  background: rgb(91 62 22 / 90%);
}

.north {
  position: absolute;
  right: 18px;
  top: 15px;
  z-index: 2;
  color: #f06a73;
  font-size: 10px;
  text-align: center;
  pointer-events: none;
}

.north span {
  display: block;
  height: 22px;
  border-left: 1px solid #f06a73;
  margin: 3px 0 0 4px;
}

.tool-hint {
  position: absolute;
  left: 50%;
  top: 14px;
  z-index: 2;
  transform: translateX(-50%);
  color: #baf7eb;
  background: #173831e8;
  border: 1px solid #2d967f;
  border-radius: 5px;
  padding: 6px 11px;
  font-size: 10px;
  pointer-events: none;
}
</style>
