import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { duplicateFloor } from '../src/domain/project-commands'
import { createDemoHospitalProject } from '../src/domain/project-factory'
import { parseProject, serializeProject } from '../src/domain/project-serializer'
import { createZip } from '../src/export/zip'
import { createGlbAuditReport, exportFloorToGlb } from '../src/glb'
import { validateProject } from '../src/validation/project-validator'
import { createTopologyAuthoringState } from '../src/topology/authoring'
import { generateTopology } from '../src/topology/generator'
import { readEmbeddedTopology } from '../src/topology/glb'
import { projectTopologyLayers } from '../src/topology/source-adapters'

const firstDraft=createDemoHospitalProject(),firstFloor=firstDraft.buildings[0]!.floors[0]!
const twoFloors=duplicateFloor(firstDraft,firstFloor.id,{floorName:'A_2F',name:'A栋2层',level:2,elevation:4.2})
twoFloors.topology=createTopologyAuthoringState(generateTopology(projectTopologyLayers(twoFloors)))
const source=serializeProject(twoFloors),project=parseProject(source),validation=validateProject(project,'release')
if(!validation.valid||validation.warnings.length)throw new Error(`Project release validation failed: ${validation.errors.length} errors, ${validation.warnings.length} warnings`)
const results=project.buildings.flatMap(building=>building.floors.map(floor=>exportFloorToGlb(project,floor.id)))
for(const result of results)if(!readEmbeddedTopology(result.bytes))throw new Error(`${result.fileName} lost sspTopology after final reload`)
const audit=createGlbAuditReport(project,results.map(result=>result.auditReport.files[0]!))
if(audit.summary.errors||audit.summary.warnings||audit.summary.metadataCoverage!==100||!audit.summary.reloadSuccess)throw new Error('Final GLB audit did not reach release criteria')
const modelIndex={metadataSpecVersion:project.metadataSpecVersion,projectId:project.projectId,projectName:project.name,files:results.map(result=>{const file=result.auditReport.files[0]!;return{file:result.fileName,sizeBytes:result.bytes.byteLength,floorName:file.sceneMetadata?.floorName,meshNodes:file.meshNodes,binHash:file.binHash,valid:true}})}
const entries=[...results.map(result=>({name:result.fileName,data:result.bytes})),{name:'model-index.json',data:JSON.stringify(modelIndex,null,2)},{name:'audit-report.json',data:JSON.stringify(audit,null,2)},{name:'Demo Hospital.sapmodel.json',data:source}]
const outputDir=resolve('outputs/demo-hospital');await mkdir(outputDir,{recursive:true})
for(const entry of entries)await writeFile(resolve(outputDir,entry.name),entry.data)
await writeFile(resolve(outputDir,'Demo Hospital-release.zip'),createZip(entries))
console.log(JSON.stringify({outputDir,files:results.length,meshNodes:audit.summary.meshNodes,metadataCoverage:audit.summary.metadataCoverage,errors:audit.summary.errors,warnings:audit.summary.warnings,reloadSuccess:audit.summary.reloadSuccess,binHashes:audit.files.map(file=>file.binHash)},null,2))
