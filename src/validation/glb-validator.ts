import {
  DIRECTIONS,
  FLOOR_TYPES,
  METADATA_SPEC_VERSION,
  RENDER_TYPES,
  type Project,
  type RenderType,
} from '../domain/contract'
import { GlbParseError, parseGlb } from '../glb/glb-codec'
import { sha256 } from '../glb/bin-integrity'
import {
  GLB_BIN_CHUNK_TYPE,
  GLB_JSON_CHUNK_TYPE,
  type GlbAuditReport,
  type GlbFileAudit,
  type GlbJson,
  type GlbSceneExtras,
  type GlbValidationIssue,
  type ParsedGlb,
} from '../glb/types'

export interface ValidateGlbOptions {
  fileName?: string
  expectedEntityCount?: number
}

export interface GlbValidationResult {
  valid: boolean
  parsed?: ParsedGlb
  audit: GlbFileAudit
}

const COMPONENT_BYTES: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
}

const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function duplicateCount(values: string[]) {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0)
}

function sidMatchesMetadata(sid: string, extras: Record<string, unknown>): boolean {
  const renderType = extras.renderType
  const floorName = extras.floorName
  if (!nonEmptyString(renderType) || !RENDER_TYPES.includes(renderType as RenderType)) return false
  if (!nonEmptyString(floorName)) return false

  const prefix = `${renderType}_${floorName}_`
  if (!sid.startsWith(prefix)) return false
  const suffix = sid.slice(prefix.length)
  const positiveSequence = (value: string) => /^\d+$/u.test(value) && Number(value) > 0

  if (renderType === 'FACILITY') {
    const fireType = extras.fireType
    if (!nonEmptyString(fireType) || !suffix.startsWith(`${fireType}_`)) return false
    return positiveSequence(suffix.slice(fireType.length + 1))
  }

  if (renderType === 'SPACE') {
    const spaceType = extras.spaceType
    if (!nonEmptyString(spaceType)) return false
    const semanticPrefix = `${spaceType}_`
    if (suffix.startsWith(semanticPrefix) && positiveSequence(suffix.slice(semanticPrefix.length))) return true
    // Read compatibility for already-delivered directional SPACE artifacts.
    return DIRECTIONS.some((direction) => {
      const directionalPrefix = `${direction}_${spaceType}_`
      return suffix.startsWith(directionalPrefix)
        && positiveSequence(suffix.slice(directionalPrefix.length))
    })
  }

  // CEILING carries a slab/surface subtype instead of a direction.
  if (renderType === 'CEILING') {
    if (suffix === 'LOWER' || suffix === 'UPPER') return true
    if (suffix.startsWith('SLAB_') && positiveSequence(suffix.slice('SLAB_'.length))) return true
  }

  if (renderType === 'WALL') {
    // Native output uses a sequence. Imported, human-confirmed artifacts may use
    // a stable semantic subtype such as PARTITION; neither requires direction.
    if (positiveSequence(suffix)) return true
    if (/^[A-Z][A-Z0-9_-]*$/u.test(suffix)) return true
  }

  return DIRECTIONS.some((direction) => {
    const directionalPrefix = `${direction}_`
    return suffix.startsWith(directionalPrefix)
      && positiveSequence(suffix.slice(directionalPrefix.length))
  })
}

function addIssue(
  target: GlbValidationIssue[],
  severity: 'error' | 'warning',
  code: string,
  message: string,
  path?: string,
) {
  target.push({ severity, code, message, ...(path ? { path } : {}) })
}

function validateGraph(json: GlbJson, parsed: ParsedGlb, issues: GlbValidationIssue[]) {
  if (!isRecord(json.asset) || json.asset.version !== '2.0') {
    addIssue(issues, 'error', 'GLTF_ASSET_VERSION', 'asset.version must be "2.0"', 'asset.version')
  }

  const buffers = Array.isArray(json.buffers) ? json.buffers : []
  const bufferViews = Array.isArray(json.bufferViews) ? json.bufferViews : []
  const accessors = Array.isArray(json.accessors) ? json.accessors : []
  const meshes = Array.isArray(json.meshes) ? json.meshes : []
  const materials = Array.isArray(json.materials) ? json.materials : []
  const nodes = Array.isArray(json.nodes) ? json.nodes : []

  if (buffers.length === 0) {
    addIssue(issues, 'error', 'GLTF_BUFFER_MISSING', 'A release GLB must contain a binary buffer', 'buffers')
  } else {
    buffers.forEach((buffer, index) => {
      if (!Number.isInteger(buffer.byteLength) || buffer.byteLength < 0) {
        addIssue(issues, 'error', 'GLTF_BUFFER_LENGTH', 'buffer.byteLength must be a non-negative integer', `buffers[${index}].byteLength`)
      }
      if (buffer.uri !== undefined) {
        addIssue(issues, 'error', 'GLTF_EXTERNAL_BUFFER', 'Release GLB buffers must be embedded', `buffers[${index}].uri`)
      }
    })
  }

  if (buffers.length === 1) {
    const binLength = parsed.binChunk?.byteLength ?? 0
    const declared = buffers[0]!.byteLength
    if (!parsed.binChunk) {
      addIssue(issues, 'error', 'GLB_BIN_MISSING', 'The embedded buffer requires a BIN chunk')
    } else if (declared > binLength || binLength - declared > 3) {
      addIssue(issues, 'error', 'GLB_BIN_LENGTH', `BIN chunk ${binLength} does not match buffer byteLength ${declared}`, 'buffers[0].byteLength')
    }
  } else if (buffers.length > 1) {
    addIssue(issues, 'error', 'GLB_BUFFER_COUNT', 'This release profile supports exactly one embedded buffer', 'buffers')
  }

  bufferViews.forEach((bufferView, index) => {
    const path = `bufferViews[${index}]`
    if (!Number.isInteger(bufferView.buffer) || bufferView.buffer < 0 || bufferView.buffer >= buffers.length) {
      addIssue(issues, 'error', 'GLTF_BUFFERVIEW_BUFFER', 'bufferView references an invalid buffer', `${path}.buffer`)
      return
    }
    const byteOffset = bufferView.byteOffset ?? 0
    if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset % 4 !== 0) {
      addIssue(issues, 'error', 'GLTF_BUFFERVIEW_OFFSET', 'bufferView.byteOffset must be a non-negative 4-byte multiple', `${path}.byteOffset`)
    }
    if (!Number.isInteger(bufferView.byteLength) || bufferView.byteLength < 0) {
      addIssue(issues, 'error', 'GLTF_BUFFERVIEW_LENGTH', 'bufferView.byteLength must be a non-negative integer', `${path}.byteLength`)
    } else if (byteOffset + bufferView.byteLength > buffers[bufferView.buffer]!.byteLength) {
      addIssue(issues, 'error', 'GLTF_BUFFERVIEW_BOUNDS', 'bufferView exceeds its buffer bounds', path)
    }
  })

  accessors.forEach((accessor, index) => {
    const path = `accessors[${index}]`
    if (accessor.bufferView === undefined) {
      addIssue(issues, 'error', 'GLTF_ACCESSOR_BUFFERVIEW', 'Exported mesh accessors must reference a bufferView', `${path}.bufferView`)
      return
    }
    if (!Number.isInteger(accessor.bufferView) || accessor.bufferView < 0 || accessor.bufferView >= bufferViews.length) {
      addIssue(issues, 'error', 'GLTF_ACCESSOR_BUFFERVIEW', 'accessor references an invalid bufferView', `${path}.bufferView`)
      return
    }
    const componentBytes = COMPONENT_BYTES[accessor.componentType]
    const componentCount = TYPE_COMPONENTS[accessor.type]
    if (!componentBytes) {
      addIssue(issues, 'error', 'GLTF_ACCESSOR_COMPONENT', `Unsupported componentType ${accessor.componentType}`, `${path}.componentType`)
      return
    }
    if (!componentCount) {
      addIssue(issues, 'error', 'GLTF_ACCESSOR_TYPE', `Unsupported accessor type ${accessor.type}`, `${path}.type`)
      return
    }
    if (!Number.isInteger(accessor.count) || accessor.count < 0) {
      addIssue(issues, 'error', 'GLTF_ACCESSOR_COUNT', 'accessor.count must be a non-negative integer', `${path}.count`)
      return
    }
    const accessorOffset = accessor.byteOffset ?? 0
    if (!Number.isInteger(accessorOffset) || accessorOffset < 0 || accessorOffset % componentBytes !== 0) {
      addIssue(issues, 'error', 'GLTF_ACCESSOR_OFFSET', 'accessor.byteOffset is not aligned to its component type', `${path}.byteOffset`)
      return
    }
    const bufferView = bufferViews[accessor.bufferView]!
    const elementBytes = componentBytes * componentCount
    const stride = bufferView.byteStride ?? elementBytes
    const requiredBytes = accessor.count === 0
      ? accessorOffset
      : accessorOffset + (accessor.count - 1) * stride + elementBytes
    if (requiredBytes > bufferView.byteLength) {
      addIssue(issues, 'error', 'GLTF_ACCESSOR_BOUNDS', 'accessor exceeds its bufferView bounds', path)
    }
  })

  const meshUsage = new Map<number, number>()
  nodes.forEach((node, nodeIndex) => {
    const references = [...(Array.isArray(node.children) ? node.children : [])]
    for (const child of references) {
      if (!Number.isInteger(child) || child < 0 || child >= nodes.length) {
        addIssue(issues, 'error', 'GLTF_NODE_CHILD', 'node references an invalid child', `nodes[${nodeIndex}].children`)
      }
    }
    if (node.mesh === undefined) return
    if (!Number.isInteger(node.mesh) || node.mesh < 0 || node.mesh >= meshes.length) {
      addIssue(issues, 'error', 'GLTF_NODE_MESH', 'node references an invalid mesh', `nodes[${nodeIndex}].mesh`)
      return
    }
    meshUsage.set(node.mesh, (meshUsage.get(node.mesh) ?? 0) + 1)
  })

  meshes.forEach((mesh, meshIndex) => {
    const path = `meshes[${meshIndex}]`
    if (!Array.isArray(mesh.primitives) || mesh.primitives.length === 0) {
      addIssue(issues, 'error', 'GLTF_MESH_PRIMITIVE', 'mesh must contain at least one primitive', `${path}.primitives`)
      return
    }
    mesh.primitives.forEach((primitive, primitiveIndex) => {
      const primitivePath = `${path}.primitives[${primitiveIndex}]`
      const position = primitive.attributes?.POSITION
      if (!Number.isInteger(position) || position < 0 || position >= accessors.length) {
        addIssue(issues, 'error', 'GLTF_POSITION_ACCESSOR', 'mesh primitive must reference a valid POSITION accessor', `${primitivePath}.attributes.POSITION`)
      } else {
        const positionAccessor = accessors[position]!
        if (positionAccessor.componentType !== 5126 || positionAccessor.type !== 'VEC3' || positionAccessor.count < 1) {
          addIssue(issues, 'error', 'GLTF_POSITION_FORMAT', 'POSITION accessor must be non-empty FLOAT VEC3', `${primitivePath}.attributes.POSITION`)
        }
      }
      if (primitive.indices !== undefined) {
        if (!Number.isInteger(primitive.indices) || primitive.indices < 0 || primitive.indices >= accessors.length) {
          addIssue(issues, 'error', 'GLTF_INDEX_ACCESSOR', 'mesh primitive references an invalid index accessor', `${primitivePath}.indices`)
        } else {
          const indexAccessor = accessors[primitive.indices]!
          if (![5121, 5123, 5125].includes(indexAccessor.componentType) || indexAccessor.type !== 'SCALAR' || indexAccessor.count < 1) {
            addIssue(issues, 'error', 'GLTF_INDEX_FORMAT', 'indices accessor must be a non-empty unsigned SCALAR', `${primitivePath}.indices`)
          }
        }
      }
      if (primitive.mode !== undefined && (!Number.isInteger(primitive.mode) || primitive.mode < 0 || primitive.mode > 6)) {
        addIssue(issues, 'error', 'GLTF_PRIMITIVE_MODE', 'primitive mode must be an integer from 0 through 6', `${primitivePath}.mode`)
      }
      if (primitive.material !== undefined && (!Number.isInteger(primitive.material) || primitive.material < 0 || primitive.material >= materials.length)) {
        addIssue(issues, 'error', 'GLTF_PRIMITIVE_MATERIAL', 'primitive references an invalid material', `${primitivePath}.material`)
      }
    })
    const usage = meshUsage.get(meshIndex) ?? 0
    if (usage === 0) addIssue(issues, 'warning', 'GLTF_UNUSED_MESH', 'mesh is not referenced by a node', path)
    // Reusable glTF mesh definitions are allowed. Semantic identity belongs to
    // each node's unique sid/findId, not to meshes[meshIndex].
  })
}

/** Validate a final, reloaded GLB using the platform release profile. */
export function validateGlb(input: ArrayBuffer | Uint8Array, options: ValidateGlbOptions = {}): GlbValidationResult {
  const bytes = input instanceof Uint8Array
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input)
  const issues: GlbValidationIssue[] = []
  const fileName = options.fileName ?? 'model.glb'
  let parsed: ParsedGlb

  try {
    parsed = parseGlb(bytes)
  } catch (error) {
    const message = error instanceof GlbParseError || error instanceof Error ? error.message : String(error)
    addIssue(issues, 'error', 'GLB_PARSE', message)
    const errors = issues.filter((issue) => issue.severity === 'error')
    return {
      valid: false,
      audit: {
        fileName,
        sizeBytes: bytes.byteLength,
        sceneMetadata: null,
        meshNodes: 0,
        sidCount: 0,
        findIdCount: 0,
        sidDuplicates: 0,
        findIdDuplicates: 0,
        metadataCoverage: 0,
        reloadSuccess: false,
        binHash: null,
        renderTypeCounts: {},
        errors,
        warnings: [],
      },
    }
  }

  if (parsed.chunks.some((chunk) => chunk.type !== GLB_JSON_CHUNK_TYPE && chunk.type !== GLB_BIN_CHUNK_TYPE)) {
    addIssue(issues, 'warning', 'GLB_UNKNOWN_CHUNK', 'GLB contains an unknown extension chunk')
  }
  validateGraph(parsed.json, parsed, issues)

  const scenes = Array.isArray(parsed.json.scenes) ? parsed.json.scenes : []
  const nodes = Array.isArray(parsed.json.nodes) ? parsed.json.nodes : []
  const sceneIndex = parsed.json.scene
  let sceneMetadata: Partial<GlbSceneExtras> | null = null
  let sceneExtras: Record<string, unknown> | null = null
  const reachableNodes = new Set<number>()

  if (scenes.length !== 1) {
    addIssue(issues, 'error', 'SCENE_COUNT', 'A floor GLB must contain exactly one scene', 'scenes')
  }
  if (!Number.isInteger(sceneIndex) || (sceneIndex as number) < 0 || (sceneIndex as number) >= scenes.length) {
    addIssue(issues, 'error', 'SCENE_DEFAULT', 'Default scene index is missing or invalid', 'scene')
  } else {
    const scene = scenes[sceneIndex as number]!
    sceneExtras = isRecord(scene.extras) ? scene.extras : null
    if (!sceneExtras) {
      addIssue(issues, 'error', 'SCENE_METADATA', 'scene.extras is required', `scenes[${sceneIndex}].extras`)
    } else {
      sceneMetadata = {
        ...(nonEmptyString(sceneExtras.floorName) ? { floorName: sceneExtras.floorName } : {}),
        ...(typeof sceneExtras.building === 'string' || sceneExtras.building === null ? { building: sceneExtras.building } : {}),
        ...(typeof sceneExtras.level === 'number' || sceneExtras.level === null ? { level: sceneExtras.level } : {}),
        ...(typeof sceneExtras.floorType === 'string' ? { floorType: sceneExtras.floorType as GlbSceneExtras['floorType'] } : {}),
        ...(nonEmptyString(sceneExtras.name) ? { name: sceneExtras.name } : {}),
      }
      if (!nonEmptyString(sceneExtras.floorName)) addIssue(issues, 'error', 'SCENE_FLOOR_NAME', 'scene floorName is required', `scenes[${sceneIndex}].extras.floorName`)
      if (!FLOOR_TYPES.includes(sceneExtras.floorType as GlbSceneExtras['floorType'])) addIssue(issues, 'error', 'SCENE_FLOOR_TYPE', 'scene floorType is invalid', `scenes[${sceneIndex}].extras.floorType`)
      if (!nonEmptyString(sceneExtras.name)) addIssue(issues, 'error', 'SCENE_NAME', 'scene name is required', `scenes[${sceneIndex}].extras.name`)
      const landscape = sceneExtras.floorType === 'LANDSCAPE_TERRAIN' || sceneExtras.floorType === 'LANDSCAPE_FACADE'
      if (landscape) {
        if (sceneExtras.building !== null || sceneExtras.level !== null) {
          addIssue(issues, 'error', 'SCENE_LANDSCAPE_LOCATION', 'Landscape floors require null building and level', `scenes[${sceneIndex}].extras`)
        }
      } else {
        if (!nonEmptyString(sceneExtras.building)) addIssue(issues, 'error', 'SCENE_BUILDING', 'building is required for a building floor', `scenes[${sceneIndex}].extras.building`)
        if (!Number.isInteger(sceneExtras.level)) addIssue(issues, 'error', 'SCENE_LEVEL', 'level must be an integer for a building floor', `scenes[${sceneIndex}].extras.level`)
      }
      for (const forbidden of ['sid', 'findId', 'renderType', 'spaceType', 'fireType', 'node', 'nodes']) {
        if (forbidden in sceneExtras) addIssue(issues, 'error', 'SCENE_NODE_METADATA', `scene.extras must not contain ${forbidden}`, `scenes[${sceneIndex}].extras.${forbidden}`)
      }
    }
    const sceneNodes = Array.isArray(scene.nodes) ? scene.nodes : []
    for (const nodeIndex of sceneNodes) {
      if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= nodes.length) {
        addIssue(issues, 'error', 'SCENE_NODE_REFERENCE', 'scene references an invalid node', `scenes[${sceneIndex}].nodes`)
      }
    }
    const visitNode = (nodeIndex: number) => {
      if (reachableNodes.has(nodeIndex) || nodeIndex < 0 || nodeIndex >= nodes.length) return
      reachableNodes.add(nodeIndex)
      for (const child of nodes[nodeIndex]!.children ?? []) {
        if (Number.isInteger(child)) visitNode(child)
      }
    }
    sceneNodes.forEach(visitNode)
  }

  const sids: string[] = []
  const findIds: string[] = []
  const renderTypeCounts: Partial<Record<RenderType, number>> = {}
  let meshNodes = 0
  let coveredMeshNodes = 0

  nodes.forEach((node, nodeIndex) => {
    const extras = isRecord(node.extras) ? node.extras : null
    if (node.mesh === undefined) {
      if (extras && (nonEmptyString(extras.sid) || nonEmptyString(extras.renderType))) {
        addIssue(issues, 'error', 'NON_MESH_SEMANTICS', 'Non-mesh nodes must not carry sid or renderType', `nodes[${nodeIndex}].extras`)
      }
      return
    }

    meshNodes += 1
    const path = `nodes[${nodeIndex}].extras`
    if (!reachableNodes.has(nodeIndex)) {
      addIssue(issues, 'error', 'NODE_NOT_IN_SCENE', 'Semantic mesh node is not reachable from the default scene', `nodes[${nodeIndex}]`)
    }
    if (!extras) {
      addIssue(issues, 'error', 'NODE_METADATA', 'Semantic mesh node extras are required', path)
      return
    }
    if ('_editorEntityId' in extras) {
      addIssue(issues, 'error', 'NODE_EDITOR_FIELD', '_editorEntityId must be removed from final GLB metadata', `${path}._editorEntityId`)
    }

    const renderType = extras.renderType
    const validRenderType = nonEmptyString(renderType) && RENDER_TYPES.includes(renderType as RenderType)
    if (!validRenderType) {
      addIssue(issues, 'error', 'NODE_RENDER_TYPE', 'renderType is missing or invalid', `${path}.renderType`)
    } else {
      const typed = renderType as RenderType
      renderTypeCounts[typed] = (renderTypeCounts[typed] ?? 0) + 1
    }

    if (nonEmptyString(extras.sid)) {
      sids.push(extras.sid)
      if (!sidMatchesMetadata(extras.sid, extras)) {
        addIssue(issues, 'error', 'NODE_SID_FORMAT', 'SID does not match 3.3-semantic node metadata', `${path}.sid`)
      }
    } else {
      addIssue(issues, 'error', 'NODE_SID', 'sid is required', `${path}.sid`)
    }

    if (nonEmptyString(extras.findId)) {
      findIds.push(extras.findId)
      if (sceneExtras && nonEmptyString(sceneExtras.floorName)) {
        const expected = `${sceneExtras.floorName}_mesh_${nodeIndex}`
        if (extras.findId !== expected) {
          addIssue(issues, 'error', 'NODE_FIND_ID', `findId must use final node index: ${expected}`, `${path}.findId`)
        }
      }
    } else {
      addIssue(issues, 'error', 'NODE_FIND_ID', 'findId is required', `${path}.findId`)
    }

    if (extras.renderTypeConfidence !== 'high' && extras.renderTypeConfidence !== 'low') {
      addIssue(issues, 'error', 'NODE_CONFIDENCE', 'renderTypeConfidence must be high or low', `${path}.renderTypeConfidence`)
    }

    for (const field of ['floorName', 'building', 'level', 'floorType'] as const) {
      if (sceneExtras && extras[field] !== sceneExtras[field]) {
        addIssue(issues, 'error', 'NODE_SCENE_MISMATCH', `${field} must match scene.extras`, `${path}.${field}`)
      }
    }
    if (!nonEmptyString(extras.name)) addIssue(issues, 'error', 'NODE_NAME', 'name is required', `${path}.name`)
    if (renderType === 'SPACE' && !nonEmptyString(extras.spaceType)) {
      addIssue(issues, 'error', 'NODE_SPACE_TYPE', 'SPACE requires spaceType', `${path}.spaceType`)
    }
    if (renderType === 'FACILITY' && !nonEmptyString(extras.fireType)) {
      addIssue(issues, 'error', 'NODE_FIRE_TYPE', 'FACILITY requires fireType', `${path}.fireType`)
    }

    const commonCoverage = nonEmptyString(extras.sid)
      && nonEmptyString(extras.findId)
      && validRenderType
      && nonEmptyString(extras.floorName)
      && (typeof extras.building === 'string' || extras.building === null)
      && (typeof extras.level === 'number' || extras.level === null)
      && FLOOR_TYPES.includes(extras.floorType as GlbSceneExtras['floorType'])
      && nonEmptyString(extras.name)
      && (extras.renderTypeConfidence === 'high' || extras.renderTypeConfidence === 'low')
    const conditionalCoverage = renderType === 'SPACE'
      ? nonEmptyString(extras.spaceType)
      : renderType === 'FACILITY'
        ? nonEmptyString(extras.fireType)
        : true
    if (commonCoverage && conditionalCoverage) coveredMeshNodes += 1
  })

  const sidDuplicates = duplicateCount(sids)
  const findIdDuplicates = duplicateCount(findIds)
  if (sidDuplicates > 0) addIssue(issues, 'error', 'SID_DUPLICATE', `${sidDuplicates} duplicate SID value(s) found`)
  if (findIdDuplicates > 0) addIssue(issues, 'error', 'FIND_ID_DUPLICATE', `${findIdDuplicates} duplicate findId value(s) found`)
  if (options.expectedEntityCount !== undefined && meshNodes !== options.expectedEntityCount) {
    addIssue(issues, 'error', 'ENTITY_MESH_COUNT', `Expected ${options.expectedEntityCount} entity meshes, found ${meshNodes}`)
  }

  const errors = issues.filter((issue) => issue.severity === 'error')
  const warnings = issues.filter((issue) => issue.severity === 'warning')
  const metadataCoverage = meshNodes === 0 ? 100 : (coveredMeshNodes / meshNodes) * 100
  const audit: GlbFileAudit = {
    fileName,
    sizeBytes: bytes.byteLength,
    sceneMetadata,
    meshNodes,
    sidCount: sids.length,
    findIdCount: findIds.length,
    sidDuplicates,
    findIdDuplicates,
    metadataCoverage,
    reloadSuccess: errors.length === 0,
    binHash: parsed.binChunk ? sha256(parsed.binChunk.data) : null,
    renderTypeCounts,
    errors,
    warnings,
  }

  return { valid: errors.length === 0, parsed, audit }
}

export function createGlbAuditReport(
  project: Pick<Project, 'projectId' | 'name'>,
  files: GlbFileAudit[],
): GlbAuditReport {
  const renderTypeCounts: Partial<Record<RenderType, number>> = {}
  for (const file of files) {
    for (const renderType of RENDER_TYPES) {
      renderTypeCounts[renderType] = (renderTypeCounts[renderType] ?? 0) + (file.renderTypeCounts[renderType] ?? 0)
    }
  }
  const meshNodes = files.reduce((total, file) => total + file.meshNodes, 0)
  const weightedCoverage = meshNodes === 0
    ? 100
    : files.reduce((total, file) => total + file.metadataCoverage * file.meshNodes, 0) / meshNodes
  return {
    metadataSpecVersion: METADATA_SPEC_VERSION,
    project: { id: project.projectId, name: project.name },
    summary: {
      files: files.length,
      meshNodes,
      sidCount: files.reduce((total, file) => total + file.sidCount, 0),
      findIdCount: files.reduce((total, file) => total + file.findIdCount, 0),
      sidDuplicates: files.reduce((total, file) => total + file.sidDuplicates, 0),
      findIdDuplicates: files.reduce((total, file) => total + file.findIdDuplicates, 0),
      metadataCoverage: weightedCoverage,
      reloadSuccess: files.every((file) => file.reloadSuccess),
      errors: files.reduce((total, file) => total + file.errors.length, 0),
      warnings: files.reduce((total, file) => total + file.warnings.length, 0),
    },
    renderTypeCounts,
    files,
  }
}
