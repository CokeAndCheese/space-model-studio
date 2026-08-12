import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Box3, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { parseGlb, validateGlb } from '../src/glb'

const filePath = resolve(process.argv[2] ?? '')
if (!process.argv[2]) {
  throw new Error('Usage: npm exec vite-node scripts/audit-external-glb.ts -- /absolute/path/model.glb')
}

const file = await readFile(filePath)
const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
const parsed = parseGlb(bytes)
const validation = validateGlb(bytes, { fileName: filePath.split('/').at(-1) })
const arrayBuffer = bytes.buffer.slice(
  bytes.byteOffset,
  bytes.byteOffset + bytes.byteLength,
) as ArrayBuffer

// GLTFLoader only needs image dimensions while constructing textures for this
// headless structural audit. Browser rendering still decodes the real images.
Object.assign(globalThis, {
  self: globalThis,
  createImageBitmap: async () => ({ width: 1, height: 1, close() {} }),
})
const loaded = await new GLTFLoader().parseAsync(arrayBuffer, '')

loaded.scene.updateMatrixWorld(true)
const bounds = new Box3().setFromObject(loaded.scene)
const center = bounds.getCenter(new Vector3())
const size = bounds.getSize(new Vector3())
let objectCount = 0
let meshCount = 0
let visibleMeshCount = 0
let vertexCount = 0
let triangleCount = 0
let emptyGeometryCount = 0
const materialNames = new Set<string>()

loaded.scene.traverse((object) => {
  objectCount += 1
  if (!('isMesh' in object) || !object.isMesh) return
  meshCount += 1
  if (object.visible) visibleMeshCount += 1
  const mesh = object as typeof object & {
    geometry: {
      attributes: { position?: { count: number } }
      index?: { count: number } | null
    }
    material: { name?: string } | Array<{ name?: string }>
  }
  const positions = mesh.geometry.attributes.position?.count ?? 0
  vertexCount += positions
  if (positions === 0) emptyGeometryCount += 1
  triangleCount += Math.floor((mesh.geometry.index?.count ?? positions) / 3)
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  for (const material of materials) materialNames.add(material.name || '(unnamed)')
})

const finiteBounds = [bounds.min, bounds.max, center, size]
  .every((vector) => vector.toArray().every(Number.isFinite))

console.log(JSON.stringify({
  filePath,
  sizeBytes: bytes.byteLength,
  container: {
    version: parsed.header.version,
    totalLength: parsed.header.totalLength,
    chunks: parsed.chunks.map((chunk) => ({ type: chunk.type, byteLength: chunk.byteLength })),
  },
  gltf: {
    asset: parsed.json.asset,
    defaultScene: parsed.json.scene,
    scenes: parsed.json.scenes?.length ?? 0,
    nodes: parsed.json.nodes?.length ?? 0,
    meshes: parsed.json.meshes?.length ?? 0,
    materials: parsed.json.materials?.length ?? 0,
    accessors: parsed.json.accessors?.length ?? 0,
    bufferViews: parsed.json.bufferViews?.length ?? 0,
    extensionsUsed: parsed.json.extensionsUsed ?? [],
    extensionsRequired: parsed.json.extensionsRequired ?? [],
  },
  threeLoader: {
    sceneName: loaded.scene.name,
    animations: loaded.animations.length,
    cameras: loaded.cameras.length,
    objectCount,
    meshCount,
    visibleMeshCount,
    vertexCount,
    triangleCount,
    emptyGeometryCount,
    materialNames: [...materialNames].sort(),
    finiteBounds,
    bounds: {
      min: bounds.min.toArray(),
      max: bounds.max.toArray(),
      center: center.toArray(),
      size: size.toArray(),
    },
  },
  releaseProfile: {
    valid: validation.valid,
    audit: validation.audit,
  },
}, null, 2))
