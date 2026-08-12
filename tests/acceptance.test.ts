import { describe, expect, it } from 'vitest'
import { duplicateFloor } from '../src/domain/project-commands'
import { createDemoHospitalProject } from '../src/domain/project-factory'
import { parseProject, serializeProject } from '../src/domain/project-serializer'
import { createZip } from '../src/export/zip'
import {
  createGlbAuditReport,
  exportFloorToGlb,
  parseGlb,
  validateGlb,
} from '../src/glb'
import { validateProject } from '../src/validation/project-validator'

const decoder = new TextDecoder()

/**
 * Reads the store-only local entries emitted by createZip. This deliberately
 * re-opens the final package bytes instead of trusting the source entry list.
 */
function readStoredZipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0

  while (offset + 4 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const compressionMethod = view.getUint16(offset + 8, true)
    const compressedSize = view.getUint32(offset + 18, true)
    const uncompressedSize = view.getUint32(offset + 22, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength + extraLength
    const dataEnd = dataStart + compressedSize

    expect(compressionMethod, 'acceptance package entries must use ZIP store mode').toBe(0)
    expect(compressedSize).toBe(uncompressedSize)
    expect(dataEnd).toBeLessThanOrEqual(bytes.byteLength)

    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength))
    expect(entries.has(name), `duplicate ZIP entry: ${name}`).toBe(false)
    entries.set(name, bytes.slice(dataStart, dataEnd))
    offset = dataEnd
  }

  return entries
}

describe('Demo Hospital release acceptance', () => {
  it('round-trips a two-floor project and re-opens every release artifact', () => {
    const firstDraft = createDemoHospitalProject()
    const firstFloor = firstDraft.buildings[0]!.floors[0]!
    const twoFloorDraft = duplicateFloor(firstDraft, firstFloor.id, {
      floorName: 'A_2F',
      name: 'A栋2层',
      level: 2,
      elevation: 4.2,
    })

    const sourceText = serializeProject(twoFloorDraft)
    const project = parseProject(sourceText)
    const building = project.buildings[0]!
    const floors = building.floors

    expect(project.name).toBe('Demo Hospital')
    expect(project.metadataSpecVersion).toBe('3.3-semantic')
    expect(building.code).toBe('A')
    expect(floors.map((floor) => floor.floorName)).toEqual(['A_1F', 'A_2F'])
    expect(floors.map((floor) => floor.elevation)).toEqual([0, 4.2])
    expect(floors.every((floor) => floor.entities.length === 13)).toBe(true)
    expect(new Set(floors.flatMap((floor) => floor.entities.map((entity) => entity.id))).size).toBe(26)
    expect(new Set(floors.flatMap((floor) => floor.entities.map((entity) => entity.kind)))).toEqual(
      new Set(['wall', 'slab', 'ceiling', 'door', 'window', 'space', 'facility', 'stair', 'elevator']),
    )
    expect(project).toEqual(JSON.parse(sourceText))

    const projectValidation = validateProject(project, 'release')
    const entityById = new Map(floors.flatMap((floor) => floor.entities.map((entity) => [entity.id, entity] as const)))
    expect(
      projectValidation.summary,
      projectValidation.errors.map((issue) => {
        const entity = issue.entityId ? entityById.get(issue.entityId) : undefined
        return `${issue.code} [${issue.floorId}/${issue.entityId} ${entity?.kind}/${entity?.name}] ${issue.path}: ${issue.message}`
      }).join('\n'),
    ).toMatchObject({
      buildings: 1,
      floors: 2,
      entities: 26,
      errors: 0,
      warnings: 0,
    })
    expect(projectValidation.errors).toEqual([])
    expect(projectValidation.warnings).toEqual([])

    const exports = floors.map((floor) => exportFloorToGlb(project, floor.id))
    const allSids: string[] = []
    const allFindIds: string[] = []

    exports.forEach((result, floorIndex) => {
      const floor = floors[floorIndex]!
      const parsed = parseGlb(result.bytes)
      const validation = validateGlb(result.bytes, {
        fileName: result.fileName,
        expectedEntityCount: floor.entities.length,
      })
      const nodes = parsed.json.nodes ?? []

      expect(result.fileName).toBe(`${floor.floorName}.glb`)
      expect(parsed.json.scenes?.[parsed.json.scene ?? -1]?.extras?.floorName).toBe(floor.floorName)
      expect(nodes).toHaveLength(floor.entities.length)
      expect(validation.valid).toBe(true)
      expect(validation.audit).toMatchObject({
        meshNodes: 13,
        sidCount: 13,
        findIdCount: 13,
        sidDuplicates: 0,
        findIdDuplicates: 0,
        metadataCoverage: 100,
        reloadSuccess: true,
        errors: [],
        warnings: [],
      })

      nodes.forEach((node, nodeIndex) => {
        expect(node.mesh).toBeDefined()
        expect(node.extras?.findId).toBe(`${floor.floorName}_mesh_${nodeIndex}`)
        expect(typeof node.extras?.sid).toBe('string')
        expect(typeof node.extras?.renderType).toBe('string')
        allSids.push(node.extras!.sid as string)
        allFindIds.push(node.extras!.findId as string)
      })
    })

    expect(allSids).toHaveLength(26)
    expect(allFindIds).toHaveLength(26)
    expect(new Set(allSids).size).toBe(allSids.length)
    expect(new Set(allFindIds).size).toBe(allFindIds.length)
    expect(allSids).toContain('DOOR_A_1F_E_01')
    expect(allSids).toContain('SPACE_A_1F_OFFICE_01')
    expect(allSids).toContain('FACILITY_A_1F_HYDRANT_01')
    expect(allSids).toContain('DOOR_A_2F_E_01')
    expect(allSids).toContain('SPACE_A_2F_OFFICE_01')
    expect(allSids).toContain('FACILITY_A_2F_HYDRANT_01')

    const audit = createGlbAuditReport(
      project,
      exports.map((result) => result.auditReport.files[0]!),
    )
    expect(audit.summary).toEqual({
      files: 2,
      meshNodes: 26,
      sidCount: 26,
      findIdCount: 26,
      sidDuplicates: 0,
      findIdDuplicates: 0,
      metadataCoverage: 100,
      reloadSuccess: true,
      errors: 0,
      warnings: 0,
    })
    expect(audit.renderTypeCounts).toMatchObject({
      CEILING: 4,
      WALL: 8,
      DOOR: 2,
      WINDOW: 4,
      ELEVATOR: 2,
      STAIR: 2,
      SPACE: 2,
      FACILITY: 2,
    })

    const modelIndex = {
      metadataSpecVersion: project.metadataSpecVersion,
      projectId: project.projectId,
      projectName: project.name,
      files: exports.map((result) => {
        const fileAudit = result.auditReport.files[0]!
        return {
          file: result.fileName,
          sizeBytes: result.bytes.byteLength,
          floorName: fileAudit.sceneMetadata?.floorName,
          meshNodes: fileAudit.meshNodes,
          valid: true,
        }
      }),
    }
    const projectFileName = `${project.name}.sapmodel.json`
    const packageBytes = createZip([
      ...exports.map((result) => ({ name: result.fileName, data: result.bytes })),
      { name: 'model-index.json', data: JSON.stringify(modelIndex, null, 2) },
      { name: 'audit-report.json', data: JSON.stringify(audit, null, 2) },
      { name: projectFileName, data: sourceText },
    ])

    const packageView = new DataView(
      packageBytes.buffer,
      packageBytes.byteOffset,
      packageBytes.byteLength,
    )
    const endRecordOffset = packageBytes.byteLength - 22
    expect(packageView.getUint32(endRecordOffset, true)).toBe(0x06054b50)
    expect(packageView.getUint16(endRecordOffset + 10, true)).toBe(5)

    const packageEntries = readStoredZipEntries(packageBytes)
    expect([...packageEntries.keys()].sort()).toEqual([
      'A_1F.glb',
      'A_2F.glb',
      'Demo Hospital.sapmodel.json',
      'audit-report.json',
      'model-index.json',
    ])

    const reopenedFromPackage = parseProject(decoder.decode(packageEntries.get(projectFileName)!))
    expect(reopenedFromPackage).toEqual(project)

    const packagedIndex = JSON.parse(decoder.decode(packageEntries.get('model-index.json')!)) as typeof modelIndex
    expect(packagedIndex.files.map((file) => file.file)).toEqual(['A_1F.glb', 'A_2F.glb'])
    expect(packagedIndex.files.every((file) => file.valid && file.meshNodes === 13)).toBe(true)

    const packagedAudit = JSON.parse(decoder.decode(packageEntries.get('audit-report.json')!)) as typeof audit
    expect(packagedAudit.summary).toEqual(audit.summary)

    for (const floor of floors) {
      const bytes = packageEntries.get(`${floor.floorName}.glb`)
      expect(bytes).toBeDefined()
      expect(parseGlb(bytes!).json.scenes?.[0]?.extras?.floorName).toBe(floor.floorName)
      const validation = validateGlb(bytes!, {
        fileName: `${floor.floorName}.glb`,
        expectedEntityCount: floor.entities.length,
      })
      expect(validation.valid).toBe(true)
      expect(validation.audit.errors).toEqual([])
      expect(validation.audit.warnings).toEqual([])
      expect(validation.audit.metadataCoverage).toBe(100)
    }
  })
})
