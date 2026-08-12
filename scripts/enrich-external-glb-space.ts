import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createBuilding, createFloor } from '../src/domain/project-factory'
import { makeSpace } from '../src/domain/entity-factory'
import { SPACE_TYPES, type FloorType, type SpaceType } from '../src/domain/contract'
import { appendExternalSpacesToGlb, parseGlb, validateGlb } from '../src/glb'

const [inputArg, outputArg, xArg, zArg, widthArg = '4', depthArg = '3', typeArg = 'OFFICE'] = process.argv.slice(2)
if (!inputArg || !outputArg || xArg === undefined || zArg === undefined) {
  throw new Error('Usage: vite-node scripts/enrich-external-glb-space.ts <input.glb> <output.glb> <centerX> <centerZ> [width] [depth] [spaceType]')
}

const inputPath = resolve(inputArg)
const outputPath = resolve(outputArg)
if (inputPath === outputPath) throw new Error('Output must be a new file; imported originals are never overwritten')
if (existsSync(outputPath)) throw new Error(`Output already exists: ${outputPath}`)

const centerX = Number(xArg)
const centerZ = Number(zArg)
const width = Number(widthArg)
const depth = Number(depthArg)
if (![centerX, centerZ, width, depth].every(Number.isFinite) || width <= 0 || depth <= 0) {
  throw new Error('centerX/centerZ must be finite and width/depth must be positive')
}
if (!SPACE_TYPES.includes(typeArg as SpaceType)) throw new Error(`Unsupported spaceType: ${typeArg}`)

const sourceBytes = new Uint8Array(readFileSync(inputPath))
const sourceValidation = validateGlb(sourceBytes, { fileName: inputPath })
if (!sourceValidation.valid || !sourceValidation.parsed) {
  throw new Error(sourceValidation.audit.errors[0]?.message ?? 'Source GLB failed validation')
}
const parsed = parseGlb(sourceBytes)
const scene = parsed.json.scenes?.[parsed.json.scene ?? -1]
const extras = scene?.extras
if (!extras || typeof extras.floorName !== 'string' || typeof extras.name !== 'string' || typeof extras.floorType !== 'string') {
  throw new Error('Source GLB scene.extras is incomplete')
}
const buildingCode = typeof extras.building === 'string' && extras.building ? extras.building : 'A'
const building = createBuilding(buildingCode, `${buildingCode}栋`)
const floor = createFloor({
  buildingId: building.id,
  buildingCode,
  floorName: extras.floorName,
  name: extras.name,
  level: typeof extras.level === 'number' ? extras.level : null,
  floorType: extras.floorType as FloorType,
  elevation: 0,
})
let sequence = 1
for (const node of parsed.json.nodes ?? []) {
  if (node.extras?.renderType !== 'SPACE' || node.extras.spaceType !== typeArg || typeof node.extras.sid !== 'string') continue
  const match = /_([0-9]+)$/u.exec(node.extras.sid)
  if (match) sequence = Math.max(sequence, Number(match[1]) + 1)
}
floor.entities.push(makeSpace(floor.id, {
  name: `手工空间 ${sequence}`,
  polygon: [
    { x: centerX - width / 2, z: centerZ - depth / 2 },
    { x: centerX + width / 2, z: centerZ - depth / 2 },
    { x: centerX + width / 2, z: centerZ + depth / 2 },
    { x: centerX - width / 2, z: centerZ + depth / 2 },
  ],
  spaceType: typeArg as SpaceType,
  metadata: { sequence },
}))

const result = appendExternalSpacesToGlb({ sourceBytes, floor, fileName: outputPath.split('/').at(-1)! })
writeFileSync(outputPath, result.bytes)
process.stdout.write(`${JSON.stringify({
  outputPath,
  sid: parseGlb(result.bytes).json.nodes?.at(-1)?.extras?.sid,
  sourceNodes: result.preservation.sourceArrayCounts.nodes,
  outputNodes: result.preservation.outputArrayCounts.nodes,
  preservedBinPrefix: result.preservation.preservedBinPrefix,
  metadataCoverage: result.audit.metadataCoverage,
  errors: result.audit.errors.length,
  warnings: result.audit.warnings.length,
}, null, 2)}\n`)
