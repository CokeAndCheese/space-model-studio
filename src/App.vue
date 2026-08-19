<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import EditorViewport from './components/EditorViewport.vue'
import TopologyWorkspace from './components/TopologyWorkspace.vue'
import type { SelectionContextPayload, ViewportSelectionPayload } from './components/box-selection'
import {
  DIRECTIONS, FIRE_TYPES, RENDER_TYPES, SPACE_TYPES,
  type Direction, type Entity, type Floor, type Project, type RenderType, type Space, type SpaceType, type Vec2, type Wall,
} from './domain/contract'
import { createId, makeCeiling, makeDoor, makeElevator, makeFacility, makeSlab, makeSpace, makeStair, makeWall, makeWindow } from './domain/entity-factory'
import { createBuilding, createDemoHospitalProject, createFloor, createProject } from './domain/project-factory'
import { parseProject, serializeProject } from './domain/project-serializer'
import { deleteHierarchyNode, findEntityLocation, findFloorLocation, removeEntity as removeDomainEntity, updateSpaceTypeForEntities, updateSpaceTypeForEntity } from './domain/project-commands'
import { validateProject } from './validation/project-validator'
import { computeDirection } from './metadata/direction'
import { generateEntitySid } from './metadata/sid-generator'
import { appendExternalSpacesToGlb, createGlbAuditReport, exportFloorToGlb, validateGlb, type ExternalSpaceExportResult, type GlbFileAudit } from './glb'
import { ProjectHistory } from './editor/project-history'
import { TransientCandidateHistory, type TransientCandidateState } from './editor/transient-candidate-history'
import { buildEntityDeletionPlan, positionContextMenu } from './editor/entity-context-menu'
import { shouldHandleDeleteShortcut } from './editor/delete-shortcut'
import { normalizeEditorState, type EditorTreeSelection } from './editor/editor-state'
import { buildHierarchyDeletionImpact, getTreeContextActions, type TreeContextActionId, type TreeContextTarget } from './editor/tree-context-actions'
import { createZip } from './export/zip'
import { glbInjectionUrlWithReturn, resolveGlbInjectionUrl } from './integration/glb-injection'
import { listExternalGlbNodes, type ExternalGlbNodeSummary } from './integration/external-glb-nodes'
import type { ExternalGlbGeometryPrimitive } from './integration/external-glb-geometry'
import { generateMissingRoomEntities } from './domain/room-generation'
import { spacePolygonMetrics } from './components/space-polygon-drawing'
import { decodeExternalSpacePrimitives, detectExternalSpaceCandidates, type ExternalSpaceCandidatesResult } from './inference/external-space-candidates'
import {
  confirmExternalSpaceCandidates,
  makeExternalSpaceCandidateDrafts,
  type ExternalSpaceCandidateDraft,
} from './inference/space-candidate-workflow'
import { createTopologyAuthoringState, nextManualId, resolveTopology } from './topology/authoring'
import { generateTopology } from './topology/generator'
import { externalTopologyLayer, projectTopologyLayers } from './topology/source-adapters'
import { embedTopologyInGlb } from './topology/glb'
import type { TopologyPoint } from './topology/contract'

type Tool='选择'|'墙体'|'门'|'窗'|'楼板'|'天花'|'空间'|'楼梯'|'电梯'|'设施'
type UiIssue={severity:'error'|'warning'|'info';code:string;message:string;entityId?:string}
type ExportLog={time:string;label:string;status:'passed'|'failed';detail:string}
type TreeSelection=EditorTreeSelection
type DeleteContextTarget={type:'entities';ids:string[]}|TreeSelection
type ConfirmationState={title:string;message:string;confirmLabel:string;secondaryLabel?:string;danger?:boolean;onConfirm:()=>void;onSecondary?:()=>void}
type ExternalWorkspace={fileName:string;bytes:Uint8Array;arrayBuffer:ArrayBuffer;nodes:ExternalGlbNodeSummary[];sourceFloorId:string}
type SpaceDetectionOptions={cellSize:number;gapClosingDistance:number;doorPadding:number;minArea:number}
const tools:{id:Tool;icon:string}[]=[{id:'选择',icon:'↖'},{id:'墙体',icon:'╱'},{id:'门',icon:'▯'},{id:'窗',icon:'⊞'},{id:'楼板',icon:'▱'},{id:'天花',icon:'═'},{id:'空间',icon:'⬡'},{id:'楼梯',icon:'≋'},{id:'电梯',icon:'⇅'},{id:'设施',icon:'✦'}]
const navigator=window.navigator
const glbInjectionUrl=resolveGlbInjectionUrl(import.meta.env.VITE_GLB_INJECTION_URL)
let bypassNextUnload=false
let validatedExternalExport:{revision:number;workspace:ExternalWorkspace;result:ExternalSpaceExportResult}|undefined
let externalGeometryCache:{workspace:ExternalWorkspace;primitives:readonly ExternalGlbGeometryPrimitive[]}|undefined
let spaceDetectionRequest=0

function cloneFloorForLevel(source:Floor,buildingId:string,buildingCode:string,level:number):Floor{
  const floorId=createId(),idMap=new Map(source.entities.map(e=>[e.id,createId()]));const cloned=JSON.parse(JSON.stringify(source)) as Floor
  cloned.id=floorId;cloned.buildingId=buildingId;cloned.level=level;cloned.floorName=`${buildingCode}_${level}F`;cloned.name=`${buildingCode}栋${level}层`;cloned.elevation=(level-1)*4.2
  cloned.entities=cloned.entities.map(entity=>{entity.id=idMap.get(entity.id)!;entity.floorId=floorId;entity.metadata.sid=undefined;entity.metadata.manualSid=undefined;entity.metadata.sidMode='auto';if(entity.kind==='wall')entity.openings=entity.openings.map(id=>idMap.get(id)!).filter(Boolean);if(entity.kind==='door'||entity.kind==='window')entity.hostWallId=idMap.get(entity.hostWallId)!;return entity})
  return cloned
}
function initialProject(){const value=createDemoHospitalProject(),building=value.buildings[0]!,first=building.floors[0]!;building.floors.push(cloneFloorForLevel(first,building.id,building.code,2));return value}
function initialTreeSelection(value:Project):TreeSelection{const firstBuilding=value.buildings[0],firstFloor=firstBuilding?.floors[0],firstEntity=firstFloor?.entities[0];if(firstEntity)return{type:'entity',id:firstEntity.id};if(firstFloor)return{type:'floor',id:firstFloor.id};if(firstBuilding)return{type:'building',id:firstBuilding.id};return{type:'project',id:value.projectId}}

const project=ref<Project>(initialProject())
let history=new ProjectHistory(project.value)
let candidateHistory=new TransientCandidateHistory<ExternalSpaceCandidateDraft>()
const historyVersion=ref(0),mode=ref<'2D'|'3D'>('2D'),tool=ref<Tool>('选择'),currentBuildingId=ref(project.value.buildings[0]!.id),currentFloorId=ref(project.value.buildings[0]!.floors[0]!.id)
const selectedIds=ref<string[]>([project.value.buildings[0]!.floors[0]!.entities[0]!.id]),search=ref(''),renderFilter=ref<'ALL'|RenderType>('ALL'),issues=ref<UiIssue[]>([]),issueTab=ref<'issues'|'objects'|'exports'>('issues'),exportLogs=ref<ExportLog[]>([]),pointer=ref<Vec2>({x:0,z:0}),toast=ref(''),busy=ref(false),openInput=ref<HTMLInputElement>(),glbInput=ref<HTMLInputElement>(),viewport=ref<InstanceType<typeof EditorViewport>>(),externalWorkspace=ref<ExternalWorkspace>()
const spaceCandidates=ref<ExternalSpaceCandidateDraft[]>([]),selectedCandidateIds=ref<string[]>([]),detectingSpaces=ref(false),lastSpaceDetection=ref<ExternalSpaceCandidatesResult>()
const spaceDetectionOptions=ref<SpaceDetectionOptions>({cellSize:.1,gapClosingDistance:.1,doorPadding:.1,minArea:2})
const treeSelection=ref<TreeSelection>(initialTreeSelection(project.value))
const selectedExternalNodeIndex=ref<number>()
const entityContextMenu=ref<{target:DeleteContextTarget;x:number;y:number}>(),contextMenuElement=ref<HTMLElement>(),contextDeleteButton=ref<HTMLButtonElement>()
const confirmation=ref<ConfirmationState>()
const topologyOpen=ref(false),topologyBusy=ref(false)
const topologyVisible=ref(true),selectedTopologyNodeId=ref<string>(),selectedTopologyEdgeId=ref<string>()
const building=computed(()=>project.value.buildings.find(b=>b.id===currentBuildingId.value)??project.value.buildings[0]!)
const floor=computed(()=>building.value.floors.find(f=>f.id===currentFloorId.value)??building.value.floors[0]!)
const effectiveTopology=computed(()=>project.value.topology?resolveTopology(project.value.topology):undefined)
const activeTopologyGraph=computed(()=>effectiveTopology.value?.graphs.find(graph=>graph.layers.some(layer=>layer.id===floor.value.floorName)))
const selected=computed(()=>treeSelection.value.type==='entity'?floor.value.entities.find(e=>e.id===treeSelection.value.id):undefined)
const selectedEntities=computed(()=>selectedIds.value.map(id=>floor.value.entities.find(entity=>entity.id===id)).filter((entity):entity is Entity=>!!entity))
const canBatchEditSpaceType=computed(()=>selectedEntities.value.length>1&&selectedEntities.value.every(entity=>entity.kind==='space'&&entity.metadata.confidence==='confirmed'&&!entity.locked))
const batchSpaceTypeDisabledReason=computed(()=>{if(selectedEntities.value.some(entity=>entity.kind!=='space'))return'批量 Space Type 仅支持全部为 SPACE 的选择';if(selectedEntities.value.some(entity=>entity.metadata.confidence!=='confirmed'))return'请先确认所选 SPACE，再统一修改类型';if(selectedEntities.value.some(entity=>entity.locked))return'所选 SPACE 中包含锁定对象，请先解锁';return''})
const selectedSpaceTypeValue=computed<SpaceType|''>(()=>{const values=new Set(selectedEntities.value.filter((entity):entity is Space=>entity.kind==='space').map(entity=>entity.spaceType));return values.size===1?[...values][0]!:''})
const activeSpaceCandidates=computed(()=>spaceCandidates.value.filter(candidate=>candidate.floorId===floor.value.id))
const isExternalSourceFloor=computed(()=>!externalWorkspace.value||externalWorkspace.value.sourceFloorId===floor.value.id)
const selectedCandidates=computed(()=>{const selected=new Set(selectedCandidateIds.value);return activeSpaceCandidates.value.filter(candidate=>selected.has(candidate.id))})
const selectedCandidateId=computed(()=>selectedCandidateIds.value[0])
const selectedCandidate=computed(()=>activeSpaceCandidates.value.find(candidate=>candidate.id===selectedCandidateId.value))
const selectedCandidateHighCount=computed(()=>selectedCandidates.value.filter(candidate=>candidate.confidence==='inferred-high').length)
const filteredSpaceCandidates=computed(()=>activeSpaceCandidates.value.filter(candidate=>(renderFilter.value==='ALL'||renderFilter.value==='SPACE')&&(!search.value||`${candidate.name} SPACE ${candidate.confidence}`.toLowerCase().includes(search.value.toLowerCase()))))
const spaceCandidatePreviews=computed(()=>activeSpaceCandidates.value.map(candidate=>({id:candidate.id,polygon:candidate.polygon,confidence:candidate.confidence==='inferred-high'?'high' as const:'low' as const})))
const highConfidenceCandidateCount=computed(()=>activeSpaceCandidates.value.filter(candidate=>candidate.confidence==='inferred-high').length)
const skippedMultiContourRegionCount=computed(()=>lastSpaceDetection.value?lastSpaceDetection.value.middleStats.multiContourRegionCount+lastSpaceDetection.value.upperStats.multiContourRegionCount:0)
const externalNodes=computed(()=>externalWorkspace.value?.nodes??[])
const filteredExternalNodes=computed(()=>externalNodes.value.filter(node=>(renderFilter.value==='ALL'||node.renderType===renderFilter.value)&&(!search.value||`${node.name} ${node.renderType} ${node.sid} ${node.findId}`.toLowerCase().includes(search.value.toLowerCase()))))
const selectedExternalNode=computed(()=>externalNodes.value.find(node=>node.nodeIndex===selectedExternalNodeIndex.value))
const displayedObjectCount=computed(()=>floor.value.entities.length+externalNodes.value.length)
const inspectedBuilding=computed(()=>treeSelection.value.type==='building'?project.value.buildings.find(item=>item.id===treeSelection.value.id):undefined)
const inspectedFloor=computed(()=>treeSelection.value.type==='floor'?project.value.buildings.flatMap(item=>item.floors).find(item=>item.id===treeSelection.value.id):undefined)
const contextEntities=computed(()=>entityContextMenu.value?.target.type==='entities'?entityContextMenu.value.target.ids.map(id=>findEntityLocation(project.value,id)?.entity).filter((entity):entity is Entity=>!!entity):[])
const canDeleteSelection=computed(()=>selectedCandidateIds.value.length>0||(selectedExternalNodeIndex.value===undefined&&(selectedIds.value.length>0||treeSelection.value.type!=='entity')))
const filteredEntities=computed(()=>floor.value.entities.filter(e=>(renderFilter.value==='ALL'||e.metadata.renderType===renderFilter.value)&&(!search.value||`${e.name} ${e.metadata.renderType} ${sidFor(e)}`.toLowerCase().includes(search.value.toLowerCase()))))
const isDirty=computed(()=>{historyVersion.value;return history.isDirty(project.value)})
const canUndo=computed(()=>{historyVersion.value;return history.canUndo}),canRedo=computed(()=>{historyVersion.value;return history.canRedo})
const errorCount=computed(()=>issues.value.filter(i=>i.severity==='error').length),warningCount=computed(()=>issues.value.filter(i=>i.severity==='warning').length)
const availableTools=computed(()=>externalWorkspace.value?tools.filter(item=>item.id==='选择'||item.id==='空间'):tools)
function targetEntities(target:DeleteContextTarget){if(target.type==='entities')return target.ids.map(id=>findEntityLocation(project.value,id)?.entity).filter((entity):entity is Entity=>!!entity);if(target.type==='entity'){const entity=findEntityLocation(project.value,target.id)?.entity;return entity?[entity]:[]}if(target.type==='floor')return project.value.buildings.flatMap(item=>item.floors).find(item=>item.id===target.id)?.entities??[];if(target.type==='building')return project.value.buildings.find(item=>item.id===target.id)?.floors.flatMap(item=>item.entities)??[];return project.value.buildings.flatMap(item=>item.floors.flatMap(current=>current.entities))}
const contextLockedEntities=computed(()=>{const target=entityContextMenu.value?.target;if(!target)return[];if(target.type==='entities')return buildEntityDeletionPlan(project.value,target.ids).lockedIds.map(id=>findEntityLocation(project.value,id)?.entity).filter((entity):entity is Entity=>!!entity);return targetEntities(target).filter(entity=>entity.locked)})
const contextMenuTitle=computed(()=>{const target=entityContextMenu.value?.target;if(!target)return'';if(target.type==='entities')return contextEntities.value.length===1?contextEntities.value[0]!.name:`已选 ${contextEntities.value.length} 个构件`;if(target.type==='project')return project.value.name;if(target.type==='building')return project.value.buildings.find(item=>item.id===target.id)?.name??'单体';if(target.type==='floor')return project.value.buildings.flatMap(item=>item.floors).find(item=>item.id===target.id)?.name??'楼层';return findEntityLocation(project.value,target.id)?.entity.name??'构件'})
const contextMenuIcon=computed(()=>{const target=entityContextMenu.value?.target;if(!target)return'◆';if(target.type==='project')return'▣';if(target.type==='building')return'▤';if(target.type==='floor')return'▰';const entity=target.type==='entities'?contextEntities.value[0]:findEntityLocation(project.value,target.id)?.entity;return entity?entityIcon(entity.kind):'◆'})
const contextDeleteLabel=computed(()=>{const target=entityContextMenu.value?.target;if(!target)return'删除';if(target.type==='entities')return`删除 ${Math.max(1,contextEntities.value.length)} 个构件`;return target.type==='project'?'删除项目':target.type==='building'?'删除单体':target.type==='floor'?'删除楼层':'删除构件'})
function contextTreeTarget(target:DeleteContextTarget|undefined):TreeContextTarget|undefined{if(!target)return;if(target.type==='entities')return target.ids[0]?{type:'entity',id:target.ids[0]}:undefined;return target}
const contextAuxActions=computed(()=>{if(externalWorkspace.value)return[];const target=contextTreeTarget(entityContextMenu.value?.target);return target?getTreeContextActions(target).filter(action=>!action.destructive):[]})

function say(message:string){toast.value=message;window.setTimeout(()=>{if(toast.value===message)toast.value=''},2400)}
function showConfirmation(value:ConfirmationState){closeEntityContextMenu();confirmation.value=value}
function chooseConfirmation(choice:'confirm'|'secondary'){const current=confirmation.value;confirmation.value=undefined;if(!current)return;try{if(choice==='confirm')current.onConfirm();else current.onSecondary?.()}catch(error){say(error instanceof Error?error.message:'操作失败')}}
function cancelViewportInteraction(){viewport.value?.cancelActiveCommand()}
function candidateState():TransientCandidateState<ExternalSpaceCandidateDraft>{return{candidates:spaceCandidates.value,selectedCandidateIds:selectedCandidateIds.value,selectedEntityIds:selectedIds.value}}
function restoreCandidateState(state:TransientCandidateState<ExternalSpaceCandidateDraft>){spaceCandidates.value=state.candidates;selectedCandidateIds.value=state.selectedCandidateIds}
function touch(action:()=>void){const before=JSON.parse(JSON.stringify(project.value)) as Project,candidatesBefore=candidateState();action();project.value.updatedAt=new Date().toISOString();history.record(before);candidateHistory.record(candidatesBefore);historyVersion.value++;issues.value=[]}
function closeEntityContextMenu(){entityContextMenu.value=undefined}
function openContextMenuAt(clientX:number,clientY:number,target:DeleteContextTarget){const position=positionContextMenu(clientX,clientY,window.innerWidth,window.innerHeight,{height:208});entityContextMenu.value={target,...position};void nextTick(()=>contextDeleteButton.value?.focus())}
function normalizeTreeSelection(){const normalized=normalizeEditorState(project.value,{currentBuildingId:currentBuildingId.value,currentFloorId:currentFloorId.value,treeSelection:treeSelection.value,selectedIds:selectedIds.value});currentBuildingId.value=normalized.currentBuildingId;currentFloorId.value=normalized.currentFloorId;treeSelection.value=normalized.treeSelection;selectedIds.value=normalized.selectedIds}
function resetProject(next:Project,workspace?:ExternalWorkspace){cancelViewportInteraction();closeEntityContextMenu();spaceDetectionRequest++;detectingSpaces.value=false;externalGeometryCache=undefined;externalWorkspace.value=workspace;spaceCandidates.value=[];selectedCandidateIds.value=[];lastSpaceDetection.value=undefined;selectedExternalNodeIndex.value=undefined;project.value=next;history=new ProjectHistory(next);candidateHistory.reset();historyVersion.value++;currentBuildingId.value=next.buildings[0]?.id??'';currentFloorId.value=next.buildings[0]?.floors[0]?.id??'';treeSelection.value=initialTreeSelection(next);selectedIds.value=treeSelection.value.type==='entity'?[treeSelection.value.id]:[];issues.value=[]}
function restoreHistorySelection(state:TransientCandidateState<ExternalSpaceCandidateDraft>|undefined){if(!state)return;if(state.selectedCandidateIds.length)selectSpaceCandidates(state.selectedCandidateIds,'replace');else if(state.selectedEntityIds.length)selectEntitySet(state.selectedEntityIds)}
function undo(){const value=history.undo(project.value);if(value){const candidateValue=candidateHistory.undo(candidateState());project.value=value;if(candidateValue)restoreCandidateState(candidateValue);normalizeTreeSelection();restoreHistorySelection(candidateValue);historyVersion.value++;say('已撤销上一步操作')}}
function redo(){const value=history.redo(project.value);if(value){const candidateValue=candidateHistory.redo(candidateState());project.value=value;if(candidateValue)restoreCandidateState(candidateValue);normalizeTreeSelection();restoreHistorySelection(candidateValue);historyVersion.value++;say('已重做操作')}}
function createEmptyProject(){const p=createProject({name:'未命名建筑项目'}),b=createBuilding('A','A栋'),f=createFloor({buildingId:b.id,buildingCode:'A',level:1});b.floors.push(f);p.buildings.push(b);resetProject(p);say('已创建空白项目')}
function download(name:string,data:BlobPart,type='application/octet-stream'){const blob=new Blob([data],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000)}
function saveProject(){try{const text=serializeProject(project.value);download(`${project.value.name}.sapmodel.json`,text,'application/json');const parsed=parseProject(text);project.value.updatedAt=parsed.updatedAt;history.markClean(project.value);historyVersion.value++;say('项目已保存并通过回读校验');return true}catch(error){say(error instanceof Error?error.message:'项目保存失败');return false}}
function guardUnsaved(action:()=>void,title:string){if(!isDirty.value){action();return}showConfirmation({title,message:'当前项目有未保存修改。你可以先保存、放弃修改，或取消本次操作。',confirmLabel:'保存并继续',secondaryLabel:'放弃修改',onConfirm:()=>{if(saveProject())action()},onSecondary:action})}
function requestNewProject(){guardUnsaved(createEmptyProject,'新建项目？')}
async function loadProjectFile(file:File){try{resetProject(parseProject(await file.text()));say(`已打开 ${file.name}`)}catch(error){say(error instanceof Error?error.message:'无法打开项目')}}
function openProject(event:Event){const input=event.target as HTMLInputElement,file=input.files?.[0];input.value='';if(!file)return;guardUnsaved(()=>{void loadProjectFile(file)},'打开其他项目？')}
async function loadExternalGlb(file:File){try{const bytes=new Uint8Array(await file.arrayBuffer()),validation=validateGlb(bytes,{fileName:file.name});if(!validation.valid||!validation.parsed){const first=validation.audit.errors[0];throw new Error(first?`${first.code}: ${first.message}`:'GLB 未通过交付规范验证')}const scene=validation.parsed.json.scenes?.[validation.parsed.json.scene??-1],extras=scene?.extras;if(!extras||typeof extras.floorName!=='string'||typeof extras.name!=='string'||typeof extras.floorType!=='string')throw new Error('GLB 缺少完整 scene.extras 楼层元数据');const buildingCode=typeof extras.building==='string'&&extras.building?extras.building:'A',next=createProject({name:`${file.name.replace(/\.glb$/i,'')} 空间补充`}),nextBuilding=createBuilding(buildingCode,`${buildingCode}栋`),nextFloor=createFloor({buildingId:nextBuilding.id,buildingCode,floorName:extras.floorName,name:extras.name,level:typeof extras.level==='number'?extras.level:null,floorType:extras.floorType as Floor['floorType'],elevation:0,clearHeight:3.6});nextBuilding.floors.push(nextFloor);next.buildings.push(nextBuilding);const arrayBuffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer,nodes=listExternalGlbNodes(validation.parsed.json);resetProject(next,{fileName:file.name,bytes,arrayBuffer,nodes,sourceFloorId:nextFloor.id});mode.value='2D';tool.value='空间';say(`已导入 ${file.name}：显示 ${nodes.length} 个只读节点，现在可添加 SPACE`);window.setTimeout(()=>viewport.value?.fitView(),0)}catch(error){say(error instanceof Error?error.message:'无法导入 GLB')}}
function importGlb(event:Event){const input=event.target as HTMLInputElement,file=input.files?.[0];input.value='';if(!file)return;guardUnsaved(()=>{void loadExternalGlb(file)},'导入外部 GLB？')}
async function detectSpacesFromExternalGlb(){
  const workspace=externalWorkspace.value
  if(!workspace||detectingSpaces.value)return
  if(workspace.sourceFloorId!==floor.value.id){say('外部 GLB 工作区仅允许在其来源楼层识别空间');return}
  const requestId=++spaceDetectionRequest,sourceProjectId=project.value.projectId,sourceFloorId=floor.value.id
  detectingSpaces.value=true
  try{
    await nextTick()
    await new Promise<void>(resolve=>window.setTimeout(resolve,0))
    if(requestId!==spaceDetectionRequest||externalWorkspace.value!==workspace||project.value.projectId!==sourceProjectId||floor.value.id!==sourceFloorId)return
    const sourceFloor=findFloorLocation(project.value,sourceFloorId)?.floor
    if(!sourceFloor)return
    const existingSpaces=sourceFloor.entities.filter((entity):entity is Space=>entity.kind==='space')
    const primitives=externalGeometryCache?.workspace===workspace?externalGeometryCache.primitives:decodeExternalSpacePrimitives(workspace.bytes)
    externalGeometryCache={workspace,primitives}
    const result=detectExternalSpaceCandidates(primitives,{...spaceDetectionOptions.value,existingSpaces})
    lastSpaceDetection.value=result
    const drafts=makeExternalSpaceCandidateDrafts(result.candidates,existingSpaces.length,sourceFloorId)
    spaceCandidates.value=[...spaceCandidates.value.filter(candidate=>candidate.floorId!==sourceFloorId),...drafts]
    const initiallySelected=drafts.find(candidate=>candidate.confidence==='inferred-high')??drafts[0]
    selectedCandidateIds.value=initiallySelected?[initiallySelected.id]:[]
    selectedExternalNodeIndex.value=undefined
    selectedIds.value=[]
    treeSelection.value={type:'floor',id:sourceFloorId}
    mode.value='2D'
    tool.value='选择'
    const high=drafts.filter(candidate=>candidate.confidence==='inferred-high').length
    const low=drafts.length-high
    if(drafts.length)say(`已生成 ${drafts.length} 个 SPACE 候选：高置信 ${high}，需复核 ${low}`)
    else if(result.sourceSpaceStats.maxOperationsExceeded)say('源 GLB 的 SPACE 几何超过安全处理上限；已停止自动候选，请使用手绘修正')
    else if(result.reasons.includes('source-space-boundary-unavailable'))say('源 GLB 已包含 SPACE，但无法安全恢复其边界；已停止自动候选，请使用手绘修正')
    else if(result.matchingStats.maxOperationsExceeded)say('空间候选匹配超过复杂度上限；请提高最小面积或改用手绘修正')
    else if(result.excludedExistingSpaceCount)say(`未发现新候选；已跳过 ${result.excludedExistingSpaceCount} 个重叠的已确认或源空间`)
    else say('未识别到封闭空间；可提高精度、调整补缝参数或使用“空间”手绘')
    window.setTimeout(()=>viewport.value?.fitView(),0)
  }catch(error){say(error instanceof Error?error.message:'空间自动识别失败')}
  finally{if(requestId===spaceDetectionRequest)detectingSpaces.value=false}
}
function dismissSpaceCandidate(id:string,showToast=true){
  const index=spaceCandidates.value.findIndex(candidate=>candidate.id===id)
  if(index<0)return false
  const wasSelected=selectedCandidateIds.value.includes(id)
  spaceCandidates.value.splice(index,1)
  if(wasSelected){selectedCandidateIds.value=selectedCandidateIds.value.filter(candidateId=>candidateId!==id);if(!selectedCandidateIds.value.length&&activeSpaceCandidates.value[0])selectedCandidateIds.value=[activeSpaceCandidates.value[0].id]}
  if(showToast)say('候选已忽略；Domain Model 未发生变化')
  return true
}
function dismissSelectedSpaceCandidates(){const ids=[...selectedCandidateIds.value];if(!ids.length)return false;for(const id of ids)dismissSpaceCandidate(id,false);say(`已忽略 ${ids.length} 个候选；Domain Model 未发生变化`);return true}
function clearSpaceCandidates(){spaceCandidates.value=spaceCandidates.value.filter(candidate=>candidate.floorId!==floor.value.id);selectedCandidateIds.value=[];lastSpaceDetection.value=undefined;say('已清空当前楼层临时候选；已确认 SPACE 不受影响')}
function confirmCandidateSet(candidates:readonly ExternalSpaceCandidateDraft[]){
  if(!candidates.length)return false
  try{
    const floorId=candidates[0]!.floorId
    if(!floorId||candidates.some(candidate=>candidate.floorId!==floorId))throw new Error('候选必须属于同一楼层')
    if(externalWorkspace.value&&externalWorkspace.value.sourceFloorId!==floorId)throw new Error('候选不属于当前外部 GLB 的来源楼层')
    const source=JSON.parse(JSON.stringify(project.value)) as Project
    const result=confirmExternalSpaceCandidates(source,floorId,candidates)
    touch(()=>{project.value=result.project})
    const confirmedIds=new Set(candidates.map(candidate=>candidate.id))
    spaceCandidates.value=spaceCandidates.value.filter(candidate=>!confirmedIds.has(candidate.id))
    selectedCandidateIds.value=[]
    if(result.entityIds.length)selectEntitySet(result.entityIds)
    say(`已人工确认并写入 ${result.entityIds.length} 个 SPACE；可撤销`)
    return true
  }catch(error){say(error instanceof Error?error.message:'候选确认失败');return false}
}
function confirmSpaceCandidate(id=selectedCandidateId.value){const candidate=spaceCandidates.value.find(item=>item.id===id);return candidate?confirmCandidateSet([candidate]):false}
function confirmSelectedSpaceCandidates(){if(!selectedCandidates.value.length){say('请先框选需要确认的 SPACE 候选');return false}return confirmCandidateSet(selectedCandidates.value)}
function confirmHighConfidenceCandidates(){const candidates=activeSpaceCandidates.value.filter(candidate=>candidate.confidence==='inferred-high');if(!candidates.length){say('当前没有高置信候选');return false}return confirmCandidateSet(candidates)}
function startManualSpaceCorrection(){if(!selectedCandidate.value)return;cancelViewportInteraction();mode.value='2D';tool.value='空间';say('已进入手绘空间：候选轮廓保留作参考，完成后将替代该候选')}
function candidateConfidenceLabel(candidate:ExternalSpaceCandidateDraft){return candidate.confidence==='inferred-high'?'高置信 · 双切片一致':'需复核 · 仅上切片封闭'}
function candidateReasonLabel(reason:string){return({
  'closed-wall-boundary':'墙体形成封闭边界',
  'door-boundary-closed':'门洞已纳入边界闭合',
  'window-boundary-closed':'窗体已纳入外围边界闭合',
  'gap-closing-applied':'已应用小缝隙补偿',
  'equivalent-middle-slice':'中层与上层切片结果一致',
  'no-equivalent-middle-slice':'中层切片未找到一致边界',
} as Record<string,string>)[reason]??reason}
function navigateToGlbInjection(){guardUnsaved(()=>{void openGlbInjection()},'离开并打开 GLB 模型数据注入？')}
async function openGlbInjection(){try{await fetch(glbInjectionUrl,{method:'HEAD',mode:'no-cors',cache:'no-store'});bypassNextUnload=true;window.location.assign(glbInjectionUrlWithReturn(glbInjectionUrl,window.location.href))}catch{say('GLB 模型数据注入服务未启动，请在项目目录运行 npm run injector')}}

function sidFor(entity:Entity){try{return generateEntitySid(entity,floor.value)}catch{return 'SID 待修复'}}
function nextSequence(renderType:RenderType,direction?:Direction){return Math.max(0,...floor.value.entities.filter(e=>e.metadata.renderType===renderType&&(!direction||e.metadata.direction===direction)).map(e=>e.metadata.sequence))+1}
function selectProjectNode(){closeEntityContextMenu();selectedCandidateIds.value=[];selectedExternalNodeIndex.value=undefined;treeSelection.value={type:'project',id:project.value.projectId};selectedIds.value=[]}
function selectBuildingNode(id:string){closeEntityContextMenu();selectedCandidateIds.value=[];selectedExternalNodeIndex.value=undefined;const target=project.value.buildings.find(item=>item.id===id);if(!target)return;const nextFloorId=target.floors.some(item=>item.id===currentFloorId.value)?currentFloorId.value:(target.floors[0]?.id??'');if(nextFloorId!==currentFloorId.value)cancelViewportInteraction();treeSelection.value={type:'building',id};selectedIds.value=[];currentBuildingId.value=id;currentFloorId.value=nextFloorId;window.setTimeout(()=>viewport.value?.fitView(),0)}
function selectEntitySet(ids:readonly string[]){const first=ids.map(id=>findEntityLocation(project.value,id)).find(Boolean);if(!first)return;currentBuildingId.value=first.building.id;currentFloorId.value=first.floor.id;selectedCandidateIds.value=[];selectedExternalNodeIndex.value=undefined;selectedIds.value=[...new Set(ids)].filter(id=>first.floor.entities.some(entity=>entity.id===id));treeSelection.value={type:'entity',id:selectedIds.value[0]!}}
function selectEntity(id:string,multi=false){selectedCandidateIds.value=[];selectedExternalNodeIndex.value=undefined;const location=findEntityLocation(project.value,id);if(!location)return;currentBuildingId.value=location.building.id;currentFloorId.value=location.floor.id;selectedIds.value=multi?[...new Set([...selectedIds.value,id])]:[id];treeSelection.value={type:'entity',id:multi?(selectedIds.value[0]??id):id}}
function selectExternalNode(nodeIndex:number){closeEntityContextMenu();selectedCandidateIds.value=[];selectedExternalNodeIndex.value=nodeIndex;selectedIds.value=[];treeSelection.value={type:'floor',id:floor.value.id}}
function selectSpaceCandidates(ids:readonly string[],operation:'replace'|'merge'){
  const activeIds=new Set(activeSpaceCandidates.value.map(candidate=>candidate.id))
  const valid=[...new Set(ids)].filter(id=>activeIds.has(id))
  selectedCandidateIds.value=operation==='merge'?[...new Set([...selectedCandidateIds.value,...valid])]:valid
  closeEntityContextMenu();selectedExternalNodeIndex.value=undefined;selectedIds.value=[];treeSelection.value={type:'floor',id:floor.value.id};mode.value='2D';tool.value='选择'
}
function selectSpaceCandidate(id:string,additive=false){if(!activeSpaceCandidates.value.some(candidate=>candidate.id===id))return;const current=selectedCandidateIds.value;if(!additive){selectSpaceCandidates([id],'replace');return}selectSpaceCandidates(current.includes(id)?current.filter(candidateId=>candidateId!==id):[id,...current],'replace')}
function applyViewportSelection(payload:ViewportSelectionPayload){
  selectedCandidateIds.value=[]
  selectedExternalNodeIndex.value=undefined
  selectedIds.value=payload.operation==='merge'?[...new Set([...selectedIds.value,...payload.ids])]:payload.ids
  treeSelection.value=selectedIds.value.length?{type:'entity',id:selectedIds.value[0]!}:{type:'floor',id:currentFloorId.value}
  if(payload.source==='box')say(`${payload.boxMode==='window'?'窗口选择':'交叉选择'}：${payload.ids.length} 个构件`)
}
function applyCandidateViewportSelection(payload:ViewportSelectionPayload){selectSpaceCandidates(payload.ids,payload.operation);if(payload.source==='box')say(`${payload.boxMode==='window'?'窗口选择':'交叉选择'}：${payload.ids.length} 个 SPACE 候选`)}
function setFloor(id:string,buildingId?:string){closeEntityContextMenu();selectedCandidateIds.value=[];selectedExternalNodeIndex.value=undefined;const owner=buildingId?project.value.buildings.find(item=>item.id===buildingId):project.value.buildings.find(item=>item.floors.some(candidate=>candidate.id===id));if(!owner)return;if(id!==currentFloorId.value)cancelViewportInteraction();currentBuildingId.value=owner.id;currentFloorId.value=id;treeSelection.value={type:'floor',id};selectedIds.value=[];issues.value=[];window.setTimeout(()=>viewport.value?.fitView(),0)}
function openEntityContextMenu(event:MouseEvent,entity:Entity){const keepGroup=selectedIds.value.length>1&&selectedIds.value.includes(entity.id);const ids=keepGroup?[...selectedIds.value]:[entity.id];if(!keepGroup)selectEntity(entity.id);openContextMenuAt(event.clientX,event.clientY,{type:'entities',ids});const plan=buildEntityDeletionPlan(project.value,ids);if(plan.lockedIds.length)say('所选构件中存在锁定对象，无法删除')}
function openHierarchyContextMenu(event:MouseEvent,target:TreeSelection){if(target.type==='project')selectProjectNode();else if(target.type==='building')selectBuildingNode(target.id);else if(target.type==='floor')setFloor(target.id);else selectEntity(target.id);openContextMenuAt(event.clientX,event.clientY,target);if(targetEntities(target).some(entity=>entity.locked))say('该层级中存在锁定构件，无法级联删除')}
function openViewportSelectionContextMenu(payload:SelectionContextPayload){const ids=[...new Set(payload.ids)].filter(id=>!!findEntityLocation(project.value,id));if(!ids.length)return;selectedCandidateIds.value=[];selectedExternalNodeIndex.value=undefined;selectedIds.value=ids;treeSelection.value={type:'entity',id:ids[0]!};openContextMenuAt(payload.clientX,payload.clientY,{type:'entities',ids});if(buildEntityDeletionPlan(project.value,ids).lockedIds.length)say('所选构件中存在锁定对象，无法删除')}
function onWindowPointerDown(event:PointerEvent){if(entityContextMenu.value&&!contextMenuElement.value?.contains(event.target as Node))closeEntityContextMenu()}
function onWindowKeyDown(event:KeyboardEvent){if(event.key==='Escape'&&confirmation.value){event.preventDefault();confirmation.value=undefined;return}if(event.key==='Escape'&&entityContextMenu.value){event.preventDefault();closeEntityContextMenu();return}if(confirmation.value)return;if(shouldHandleDeleteShortcut(event)){event.preventDefault();closeEntityContextMenu();removeCurrentSelection()}}
function closestWall(point:Vec2){let best:{wall:Wall;offset:number;distance:number}|undefined;for(const item of floor.value.entities){if(item.kind!=='wall')continue;const dx=item.end.x-item.start.x,dz=item.end.z-item.start.z,length2=dx*dx+dz*dz,t=Math.max(0,Math.min(1,((point.x-item.start.x)*dx+(point.z-item.start.z)*dz)/length2)),x=item.start.x+dx*t,z=item.start.z+dz*t,distance=Math.hypot(point.x-x,point.z-z);if(!best||distance<best.distance)best={wall:item,offset:t*Math.sqrt(length2),distance}}return best}
function rectangle(point:Vec2,w=4,d=3){return[{x:point.x-w/2,z:point.z-d/2},{x:point.x+w/2,z:point.z-d/2},{x:point.x+w/2,z:point.z+d/2},{x:point.x-w/2,z:point.z+d/2}]}
function spaceMetrics(space:Space){return spacePolygonMetrics(space.polygon)}
function onCreate(payload:{tool:string;point:Vec2;end?:Vec2;polygon?:Vec2[]}){
  let entity:Entity|undefined;let host:Wall|undefined;let generatedRooms=0;let generatedEntities=0;const replacedCandidateId=payload.tool==='空间'?selectedCandidateId.value:undefined,center={x:0,z:0},direction=computeDirection(payload.point,center,project.value.settings.north)
  if(payload.tool==='墙体'){if(!payload.end||Math.hypot(payload.end.x-payload.point.x,payload.end.z-payload.point.z)<=.1){say('墙体长度不足，请移动终点至 0.1 m 以外');return}entity=makeWall(floor.value.id,{start:payload.point,end:payload.end,height:floor.value.clearHeight,thickness:.2,name:`墙体 ${floor.value.entities.filter(e=>e.kind==='wall').length+1}`,metadata:{sequence:nextSequence('WALL')}})}
  else if(payload.tool==='门'||payload.tool==='窗'){const match=closestWall(payload.point);if(!match||match.distance>2){say('请在距离墙体 2m 内放置门窗');return}host=match.wall;const wallLength=Math.hypot(host.end.x-host.start.x,host.end.z-host.start.z),width=payload.tool==='门'?1.2:1.4,offset=Math.max(width/2+.05,Math.min(wallLength-width/2-.05,match.offset));if(wallLength<=width+.1){say('宿主墙长度不足');return}const overlaps=host.openings.map(id=>floor.value.entities.find(e=>e.id===id)).some(e=>(e?.kind==='door'||e?.kind==='window')&&Math.abs(e.offset-offset)<(e.width+width)/2+.02);if(overlaps){say('门窗洞口不能重叠，请换一个位置');return}const dir=host.metadata.direction??direction;entity=payload.tool==='门'?makeDoor(floor.value.id,{hostWallId:host.id,offset,name:'新门',metadata:{direction:dir,sequence:nextSequence('DOOR',dir)}}):makeWindow(floor.value.id,{hostWallId:host.id,offset,name:'新窗',metadata:{direction:dir,sequence:nextSequence('WINDOW',dir)}})
  } else if(payload.tool==='楼板')entity=makeSlab(floor.value.id,{polygon:rectangle(payload.point,4,3),name:'新楼板',metadata:{sequence:nextSequence('CEILING'),sub:`SLAB_${String(nextSequence('CEILING')).padStart(2,'0')}`}})
  else if(payload.tool==='天花'){const existing=floor.value.entities.find(e=>e.kind==='ceiling');if(existing){selectEntity(existing.id);say('当前楼层已有天花，请编辑现有对象');return}entity=makeCeiling(floor.value.id,{polygon:rectangle(payload.point,4,3),height:floor.value.clearHeight-.1,name:'新天花',metadata:{sequence:nextSequence('CEILING'),sub:'UPPER'}})}
  else if(payload.tool==='空间'){if(!payload.polygon){say('空间边界数据缺失');return}entity=makeSpace(floor.value.id,{polygon:payload.polygon,spaceType:'OFFICE',name:`新空间 ${floor.value.entities.filter(e=>e.kind==='space').length+1}`,metadata:{sequence:nextSequence('SPACE')}})}
  else if(payload.tool==='设施')entity=makeFacility(floor.value.id,{position:{x:payload.point.x,y:.8,z:payload.point.z},fireType:'HYDRANT',name:'新消防设施',metadata:{direction,sequence:nextSequence('FACILITY')}})
  else if(payload.tool==='楼梯')entity=makeStair(floor.value.id,{start:{x:payload.point.x,z:payload.point.z-1.5},end:{x:payload.point.x,z:payload.point.z+1.5},name:'新楼梯',metadata:{direction,sequence:nextSequence('STAIR',direction)}})
  else if(payload.tool==='电梯')entity=makeElevator(floor.value.id,{center:payload.point,name:'新电梯',metadata:{direction,sequence:nextSequence('ELEVATOR',direction)}})
  if(!entity)return;touch(()=>{floor.value.entities.push(entity!);if(host)host.openings.push(entity!.id);if(entity!.kind==='wall'){const result=generateMissingRoomEntities(floor.value,project.value.settings.north);generatedRooms=result.generated.length;generatedEntities=result.entities.length;floor.value.entities.push(...result.entities)}});if(replacedCandidateId)dismissSpaceCandidate(replacedCandidateId,false);say(replacedCandidateId?`${entity.name} 已创建并替代自动候选`:generatedRooms?`${entity.name} 已创建；已识别 ${generatedRooms} 个封闭空间并生成 ${generatedEntities} 个对象`:`${entity.name} 已创建`);selectEntity(entity.id)
}
function deleteEntities(entityIds:readonly string[]){closeEntityContextMenu();const plan=buildEntityDeletionPlan(project.value,entityIds);if(!plan.requestedIds.length)return false;if(plan.lockedIds.length){const lockedNames=plan.lockedIds.map(id=>findEntityLocation(project.value,id)?.entity.name).filter(Boolean).join('、');say(`${lockedNames||'所选构件'}已锁定，无法删除`);return false}try{let next=JSON.parse(JSON.stringify(project.value)) as Project;for(const id of plan.requestedIds){const location=findEntityLocation(next,id);if(!location)continue;next=removeDomainEntity(next,id,{cascadeOpenings:location.entity.kind==='wall'})}touch(()=>{project.value=next});const removed=new Set(plan.effectiveIds);selectedIds.value=selectedIds.value.filter(id=>!removed.has(id));if(treeSelection.value.type==='entity'&&removed.has(treeSelection.value.id))treeSelection.value={type:'floor',id:currentFloorId.value};say(plan.effectiveIds.length>plan.requestedIds.length?`已删除 ${plan.effectiveIds.length} 个构件（含宿主门窗）`:`已删除 ${plan.effectiveIds.length} 个构件`);return true}catch(error){say(error instanceof Error?error.message:'构件删除失败');return false}}
function deleteHierarchySelection(target:Exclude<TreeSelection,{type:'entity'}>){cancelViewportInteraction();closeEntityContextMenu();try{const source=JSON.parse(JSON.stringify(project.value)) as Project;const result=deleteHierarchyNode(source,target,{name:'未命名建筑项目'});touch(()=>{project.value=result.project});currentBuildingId.value=result.currentBuildingId;currentFloorId.value=result.currentFloorId;treeSelection.value=result.selection;selectedIds.value=[];normalizeTreeSelection();const label=target.type==='project'?'项目':target.type==='building'?'单体':'楼层';say(result.replacementCreated?`已删除${label}，并创建空白${target.type==='project'?'项目':target.type==='building'?'单体与楼层':'楼层'}`:`已删除${label}`);window.setTimeout(()=>viewport.value?.fitView(),0);return true}catch(error){say(error instanceof Error?error.message:`${target.type} 删除失败`);return false}}
function requestDelete(target:DeleteContextTarget){closeEntityContextMenu();if(externalWorkspace.value&&target.type!=='entities'&&target.type!=='entity'){say('外部 GLB 工作区的项目层级为只读');return false}if(target.type==='entities'||target.type==='entity'){const ids=target.type==='entities'?target.ids:[target.id],plan=buildEntityDeletionPlan(project.value,ids);if(!plan.requestedIds.length)return false;if(plan.lockedIds.length){const lockedNames=plan.lockedIds.map(id=>findEntityLocation(project.value,id)?.entity.name).filter(Boolean);say(`${lockedNames.slice(0,3).join('、')||'所选构件'}${lockedNames.length>3?' 等':''}已锁定，无法删除`);return false}if(plan.effectiveIds.length>plan.requestedIds.length){showConfirmation({title:'删除墙体及宿主门窗？',message:`将删除 ${plan.requestedIds.length} 个所选构件，并级联删除 ${plan.effectiveIds.length-plan.requestedIds.length} 个门窗。此操作可撤销。`,confirmLabel:'确认删除',danger:true,onConfirm:()=>{deleteEntities(plan.requestedIds)}});return true}return deleteEntities(plan.requestedIds)}const impact=buildHierarchyDeletionImpact(project.value,target);if(!impact.canDelete){say(`${impact.lockedEntityNames.slice(0,3).join('、')}${impact.lockedEntityNames.length>3?' 等':''}已锁定，无法级联删除`);return false}showConfirmation({title:impact.confirmTitle,message:impact.confirmMessage,confirmLabel:'确认删除',danger:true,onConfirm:()=>{deleteHierarchySelection(target)}});return true}
function removeSelected(){if(selectedIds.value.length)requestDelete({type:'entities',ids:[...selectedIds.value]})}
function removeCurrentSelection(){if(selectedCandidateIds.value.length)return dismissSelectedSpaceCandidates();if(selectedExternalNodeIndex.value!==undefined){say('原 GLB 节点为只读，不能删除');return false}if(selectedIds.value.length)return requestDelete({type:'entities',ids:[...selectedIds.value]});if(treeSelection.value.type!=='entity')return requestDelete(treeSelection.value);return requestDelete(treeSelection.value)}
function deleteContextEntity(){const target=entityContextMenu.value?.target;if(!target)return false;return requestDelete(target)}
function nextBuildingCode(){const used=new Set(project.value.buildings.map(item=>item.code));let index=0;while(true){const code=index<26?String.fromCharCode(65+index):`B${index+1}`;if(!used.has(code))return code;index++}}
function addBuildingNode(){if(externalWorkspace.value){say('外部 GLB 工作区固定为单一来源楼层');return}const code=nextBuildingCode(),next=createBuilding(code,`${code}栋`),first=createFloor({buildingId:next.id,buildingCode:code,level:1});next.floors.push(first);touch(()=>project.value.buildings.push(next));currentBuildingId.value=next.id;currentFloorId.value=first.id;treeSelection.value={type:'building',id:next.id};selectedIds.value=[];window.setTimeout(()=>viewport.value?.fitView(),0);say(`已创建 ${next.name}`)}
function addFloor(buildingId=currentBuildingId.value){if(externalWorkspace.value){say('外部 GLB 工作区固定为单一来源楼层');return}const target=project.value.buildings.find(item=>item.id===buildingId);if(!target){say('目标单体不存在');return}const level=Math.max(0,...target.floors.map(item=>item.level??0))+1,next=createFloor({buildingId:target.id,buildingCode:target.code,level});touch(()=>target.floors.push(next));setFloor(next.id,target.id);say(`已创建 ${next.floorName}`)}
function duplicateFloor(floorId=currentFloorId.value){if(externalWorkspace.value){say('外部 GLB 工作区固定为单一来源楼层');return}const location=findFloorLocation(project.value,floorId);if(!location){say('目标楼层不存在');return}const level=Math.max(0,...location.building.floors.map(item=>item.level??0))+1,copy=cloneFloorForLevel(location.floor,location.building.id,location.building.code,level);touch(()=>location.building.floors.push(copy));setFloor(copy.id,location.building.id);say(`已复制为 ${copy.floorName}`)}
function runContextAction(actionId:TreeContextActionId){const target=contextTreeTarget(entityContextMenu.value?.target);closeEntityContextMenu();if(!target)return;if(actionId==='add-building')addBuildingNode();else if(actionId==='add-floor'&&target.type==='building')addFloor(target.id);else if(actionId==='duplicate-floor'&&target.type==='floor')duplicateFloor(target.id)}
function toggleEntity(entity:Entity,key:'visible'|'locked'){touch(()=>{entity[key]=!entity[key]})}
function updateEntity(mutator:(entity:Entity)=>void){if(!selected.value)return;if(selected.value.locked){say('该构件已锁定，请先解锁后编辑');return}touch(()=>mutator(selected.value!))}
function applySpaceTypeUpdate(update:(source:Project)=>Project,successMessage:string){try{const source=JSON.parse(JSON.stringify(project.value)) as Project,next=update(source);touch(()=>{project.value=next});say(successMessage);return true}catch(error){say(error instanceof Error?error.message:'修改 Space Type 失败');return false}}
function updateSelectedSpaceTypes(event:Event){const spaceType=eventText(event) as SpaceType;if(!SPACE_TYPES.includes(spaceType)||!canBatchEditSpaceType.value)return;const entityIds=[...selectedIds.value];applySpaceTypeUpdate(source=>updateSpaceTypeForEntities(source,entityIds,spaceType),`已统一修改 ${entityIds.length} 个 SPACE 的类型，可撤销`)}
function updateSingleSpaceType(event:Event){const entity=selected.value,spaceType=eventText(event) as SpaceType;if(entity?.kind!=='space'||!SPACE_TYPES.includes(spaceType))return;applySpaceTypeUpdate(source=>updateSpaceTypeForEntity(source,entity.id,spaceType),'已修改并人工确认 SPACE 类型，可撤销')}
function renameProject(event:Event){const name=eventText(event).trim();if(name)touch(()=>{project.value.name=name})}
function renameBuilding(event:Event){const target=inspectedBuilding.value,name=eventText(event).trim();if(target&&name)touch(()=>{target.name=name})}
function renameFloor(event:Event){const target=inspectedFloor.value,name=eventText(event).trim();if(target&&name)touch(()=>{target.name=name})}
function eventText(event:Event){return(event.target as HTMLInputElement|HTMLSelectElement).value}function eventNumber(event:Event){return Number(eventText(event))}function eventChecked(event:Event){return(event.target as HTMLInputElement).checked}

function externalOutputFileName(){const source=externalWorkspace.value?.fileName??'model.glb';return`${source.replace(/\.glb$/i,'')}-space-enriched.glb`}
function buildExternalGlb(){const workspace=externalWorkspace.value;if(!workspace)throw new Error('当前没有外部 GLB 工作区');return appendExternalSpacesToGlb({sourceBytes:workspace.bytes,floor:floor.value,fileName:externalOutputFileName()})}
function buildValidatedExternalGlb(){const result=buildExternalGlb();if(!project.value.topology)return result;const bytes=embedTopologyInGlb(result.bytes,project.value.topology,floor.value.floorName),validation=validateGlb(bytes,{fileName:result.fileName});if(!validation.valid)throw new Error(validation.audit.errors[0]?.message??'嵌入 topology 后的 GLB 回读校验失败');return{...result,bytes,audit:validation.audit,preservation:{...result.preservation,outputByteLength:bytes.byteLength}}}
function runValidation(showToast=true){const report=validateProject(project.value,'release');const next:UiIssue[]=report.issues.map(item=>({severity:item.severity,code:item.code,message:`${item.path}: ${item.message}`,entityId:item.entityId}));if(report.valid){if(externalWorkspace.value){try{const result=buildValidatedExternalGlb();validatedExternalExport={revision:historyVersion.value,workspace:externalWorkspace.value,result}}catch(error){validatedExternalExport=undefined;next.push({severity:'error',code:'EXTERNAL_GLB_RELEASE',message:error instanceof Error?error.message:'外部 GLB 补充验证失败'})}}else{for(const b of project.value.buildings)for(const f of b.floors)try{exportFloorToGlb(project.value,f.id)}catch(error){next.push({severity:'error',code:'GLB_RELEASE',message:error instanceof Error?`${f.floorName}: ${error.message}`:`${f.floorName}: 导出验证失败`})}}}issues.value=next;if(showToast)say(next.length?`验证发现 ${next.length} 个问题`:externalWorkspace.value?'外部 GLB 与新增 SPACE 验证通过':`Release 验证通过：${report.summary.floors} 个楼层`);return next.length===0}
function exportProject(){busy.value=true;try{if(!runValidation(false))throw new Error('Release 验证失败，已阻止下载');if(externalWorkspace.value){const cached=validatedExternalExport;if(!cached||cached.revision!==historyVersion.value||cached.workspace!==externalWorkspace.value)throw new Error('外部 GLB 验证结果已过期');const result=cached.result;download(result.fileName,result.bytes,'model/gltf-binary');history.markClean(project.value);historyVersion.value++;exportLogs.value.unshift({time:new Date().toLocaleTimeString(),label:result.fileName,status:'passed',detail:`新增 ${result.preservation.appendedCounts.nodes} SPACE · 原 BIN 前缀已保留 · 0 errors`});say('补充后 GLB 已导出；原始文件未被覆盖');return}const results=[] as ReturnType<typeof exportFloorToGlb>[];const audits:GlbFileAudit[]=[];for(const b of project.value.buildings)for(const f of b.floors){const result=exportFloorToGlb(project.value,f.id);results.push(result);audits.push(result.auditReport.files[0]!)}const audit=createGlbAuditReport(project.value,audits),index={metadataSpecVersion:project.value.metadataSpecVersion,projectId:project.value.projectId,projectName:project.value.name,files:results.map(r=>({file:r.fileName,sizeBytes:r.bytes.length,floorName:r.auditReport.files[0]?.sceneMetadata?.floorName,meshNodes:r.auditReport.files[0]?.meshNodes,valid:true}))};const entries=[...results.map(r=>({name:r.fileName,data:r.bytes})),{name:'model-index.json',data:JSON.stringify(index,null,2)},{name:'audit-report.json',data:JSON.stringify(audit,null,2)},{name:`${project.value.name}.sapmodel.json`,data:serializeProject(project.value)}];download(`${project.value.name}-release.zip`,createZip(entries),'application/zip');exportLogs.value.unshift({time:new Date().toLocaleTimeString(),label:`${results.length} 个楼层`,status:'passed',detail:`${audit.summary.meshNodes} meshes · 100% metadata · 0 errors`});say('Release 包已导出并通过最终 GLB 回读验证')}catch(error){exportLogs.value.unshift({time:new Date().toLocaleTimeString(),label:externalWorkspace.value?'外部 GLB 导出':'项目导出',status:'failed',detail:error instanceof Error?error.message:'未知错误'});say(error instanceof Error?error.message:'导出失败')}finally{busy.value=false}}
function issueClick(item:UiIssue){if(item.entityId)selectEntity(item.entityId)}
async function generateProjectTopology(){if(topologyBusy.value)return;topologyBusy.value=true;try{await nextTick();await new Promise<void>(resolve=>window.setTimeout(resolve,0));const workspace=externalWorkspace.value,layers=workspace?[externalTopologyLayer({bytes:workspace.bytes,fileName:workspace.fileName,floor:floor.value,nodes:workspace.nodes})]:projectTopologyLayers(project.value);const baseline=generateTopology(layers);touch(()=>{project.value.topology=createTopologyAuthoringState(baseline)});say(`已生成 topology baseline：${baseline.graphs.reduce((sum,graph)=>sum+graph.nodes.length,0)} 个节点`)}catch(error){say(error instanceof Error?error.message:'生成 topology 失败')}finally{topologyBusy.value=false}}
function selectTopologyNode(id:string){selectedTopologyNodeId.value=id}
function selectTopologyEdge(id:string){selectedTopologyEdgeId.value=id}
function selectTopologyFromViewport(value:{type:'node'|'edge';id:string}){if(value.type==='node'){selectedTopologyNodeId.value=value.id;selectedTopologyEdgeId.value=undefined}else{selectedTopologyEdgeId.value=value.id;selectedTopologyNodeId.value=undefined}topologyOpen.value=true}
function requireTopology(){const state=project.value.topology;if(!state)throw new Error('请先生成 topology baseline');return state}
function topologyAddNode(value:{layerId:string;label:string;position:TopologyPoint}){try{touch(()=>{const state=requireTopology(),id=nextManualId(state,'node');state.addedNodes.push({id,layerId:value.layerId,label:value.label||id,position:value.position,kind:'SPACE',subtype:'MANUAL',tags:['manual','walkable'],data:{generated:false,renderType:'SPACE',role:'SPACE',traversal:{mode:'WALK',walkable:true}}})});say('已新增 topology 节点，可撤销')}catch(error){say(error instanceof Error?error.message:'新增失败')}}
function topologyUpdateNode(value:{id:string;position:TopologyPoint;connectorId:string|null}){touch(()=>{const state=requireTopology(),current=state.nodeEdits[value.id]??{};state.nodeEdits[value.id]={...current,position:value.position,connectorId:value.connectorId}});say('已调整 topology 节点，可撤销')}
function topologyDeleteNode(id:string){touch(()=>{const state=requireTopology();state.nodeEdits[id]={...(state.nodeEdits[id]??{}),deleted:true}});say('已删除 topology 节点，可恢复或撤销')}
function topologyRestoreNode(id:string){touch(()=>{const state=requireTopology(),edit=state.nodeEdits[id];if(edit)edit.deleted=false});say('已恢复 topology 节点')}
function topologyAddEdge(value:{source:string;target:string}){try{touch(()=>{const state=requireTopology(),topology=resolveTopology(state),nodes=topology.graphs.flatMap(graph=>graph.nodes),source=nodes.find(node=>node.id===value.source),target=nodes.find(node=>node.id===value.target);if(!source||!target)throw new Error('边端点不存在');if(source.layerId!==target.layerId)throw new Error('当前版本不会猜测跨楼层连接');const id=nextManualId(state,'edge'),short=Math.hypot(source.position.x-target.position.x,source.position.y-target.position.y,source.position.z-target.position.z)<=1e-6;state.addedEdges.push({id,source:source.id,target:target.id,relation:'LINK',direction:'BIDIRECTIONAL',...(short?{path:{type:'POLYLINE',via:[{x:source.position.x+.01,y:source.position.y,z:source.position.z}]}}:{}),mode:'WALK',tags:['manual','walk'],data:{generated:false}})});say('已新增 topology 边，可撤销')}catch(error){say(error instanceof Error?error.message:'新增边失败')}}
function topologyUpdateEdgeVia(value:{id:string;via:TopologyPoint[]}){touch(()=>{const state=requireTopology();state.edgeEdits[value.id]={...(state.edgeEdits[value.id]??{}),via:value.via}});say('已更新 via 路径，可撤销')}
function topologyDeleteEdge(id:string){touch(()=>{const state=requireTopology();state.edgeEdits[id]={...(state.edgeEdits[id]??{}),deleted:true}});say('已删除 topology 边，可恢复或撤销')}
function topologyRestoreEdge(id:string){touch(()=>{const state=requireTopology(),edit=state.edgeEdits[id];if(edit)edit.deleted=false});say('已恢复 topology 边')}
function onBeforeUnload(event:BeforeUnloadEvent){if(!bypassNextUnload&&isDirty.value){event.preventDefault();event.returnValue=''}}
window.addEventListener('beforeunload',onBeforeUnload)
window.addEventListener('pointerdown',onWindowPointerDown)
window.addEventListener('keydown',onWindowKeyDown)
window.addEventListener('scroll',closeEntityContextMenu,true)
window.addEventListener('resize',closeEntityContextMenu)
onBeforeUnmount(()=>{window.removeEventListener('beforeunload',onBeforeUnload);window.removeEventListener('pointerdown',onWindowPointerDown);window.removeEventListener('keydown',onWindowKeyDown);window.removeEventListener('scroll',closeEntityContextMenu,true);window.removeEventListener('resize',closeEntityContextMenu)})
function entityIcon(kind:string){return({wall:'╱',door:'▯',window:'⊞',slab:'▱',ceiling:'═',space:'⬡',facility:'✦',stair:'≋',elevator:'⇅'} as Record<string,string>)[kind]??'◆'}
</script>

<template>
<div class="app-shell" @contextmenu.prevent="closeEntityContextMenu">
  <input ref="openInput" class="hidden-input" type="file" accept=".json,.sapmodel.json" @change="openProject">
  <input ref="glbInput" class="hidden-input" type="file" accept=".glb,model/gltf-binary" @change="importGlb">
  <header class="topbar"><div class="brand"><span class="brand-mark">S</span><div><strong>Space Model Studio</strong><small>语义建筑建模工作台</small></div></div><div class="project-title"><span class="status-dot"></span>{{externalWorkspace?externalWorkspace.fileName:project.name}}<span class="dirty" :class="{unsaved:isDirty}">{{isDirty?'未保存':'已同步'}}</span></div><div class="top-actions"><button @click="requestNewProject">新建</button><button @click="openInput?.click()">打开项目</button><button @click="glbInput?.click()">导入 GLB 补空间</button><button :disabled="!!externalWorkspace" @click="saveProject">保存项目</button><button title="打开已验收的 V0.4 工具" @click="navigateToGlbInjection">GLB模型数据注入</button><button @click="topologyOpen=true">生成拓扑</button><button @click="runValidation()">验证</button><button class="primary" :disabled="busy" @click="exportProject">{{busy?'验证中…':externalWorkspace?'导出补充后 GLB':'导出 Release'}}</button></div></header>
  <nav class="toolstrip"><div class="toolgroup"><button v-for="item in availableTools" :key="item.id" :class="{active:tool===item.id}" @click="tool=item.id"><span>{{item.icon}}</span>{{item.id}}</button></div><div class="history"><button :disabled="!canUndo" title="撤销" @click="undo">↶</button><button :disabled="!canRedo" title="重做" @click="redo">↷</button><button :disabled="!canDeleteSelection" title="删除当前选择（Backspace / Delete）" @click="removeCurrentSelection">⌫</button><i></i><label>吸附 <input :checked="project.settings.snapEnabled" type="checkbox" @change="touch(()=>project.settings.snapEnabled=eventChecked($event))"></label></div></nav>
  <aside class="sidebar left"><div class="panel-head"><span>项目结构</span><div><button title="新增楼层" :disabled="!!externalWorkspace" @click="addFloor()">＋</button><button title="复制当前楼层" :disabled="!!externalWorkspace" @click="duplicateFloor()">⧉</button></div></div><div class="tree-tools"><input v-model="search" placeholder="搜索名称或 SID"><select v-model="renderFilter"><option value="ALL">全部类型</option><option v-for="type in RENDER_TYPES" :key="type">{{type}}</option></select></div><div class="tree"><div class="tree-row root" :class="{current:treeSelection.type==='project'&&treeSelection.id===project.projectId}" @click="selectProjectNode" @contextmenu.prevent.stop="openHierarchyContextMenu($event,{type:'project',id:project.projectId})"><span>⌄</span><b>▣</b>{{project.name}}</div><template v-for="b in project.buildings" :key="b.id"><div class="tree-row level1" :class="{current:treeSelection.type==='building'&&treeSelection.id===b.id}" @click="selectBuildingNode(b.id)" @contextmenu.prevent.stop="openHierarchyContextMenu($event,{type:'building',id:b.id})"><span>⌄</span><b>▤</b>{{b.name}}<em>{{b.floors.length}}</em></div><template v-for="f in b.floors" :key="f.id"><div class="tree-row level2" :class="{current:treeSelection.type==='floor'&&treeSelection.id===f.id,selected:currentFloorId===f.id}" @click="setFloor(f.id,b.id)" @contextmenu.prevent.stop="openHierarchyContextMenu($event,{type:'floor',id:f.id})"><span>⌄</span><b>▰</b>{{f.floorName}}<em>{{externalWorkspace?displayedObjectCount:f.entities.length}}</em></div><template v-if="currentFloorId===f.id"><template v-if="externalWorkspace"><div v-if="activeSpaceCandidates.length" class="tree-row level3 candidate-root"><span>⌄</span><b>◎</b><span class="entity-label">自动候选 SPACE</span><em>{{filteredSpaceCandidates.length}} / {{activeSpaceCandidates.length}}</em></div><div v-for="candidate in filteredSpaceCandidates" :key="candidate.id" class="tree-row level4 candidate-node" :class="{current:selectedCandidateId===candidate.id,low:candidate.confidence==='inferred-low'}" @click="selectSpaceCandidate(candidate.id)"><span></span><b>⬡</b><span class="entity-label">{{candidate.name}}</span><i>{{candidate.confidence==='inferred-high'?'高':'复核'}}</i></div><div class="tree-row level3 external-root"><span>⌄</span><b>◇</b><span class="entity-label">原 GLB 节点（只读）</span><em>{{filteredExternalNodes.length}} / {{externalNodes.length}}</em></div><div v-for="node in filteredExternalNodes" :key="node.nodeIndex" class="tree-row level4 external-node" :class="{current:selectedExternalNodeIndex===node.nodeIndex}" @click="selectExternalNode(node.nodeIndex)"><span></span><b>◆</b><span class="entity-label">{{node.name}}</span><i>{{node.renderType}}</i></div><div v-if="floor.entities.length" class="tree-row level3 external-root"><span>⌄</span><b>⬡</b><span class="entity-label">新增 SPACE（可编辑）</span><em>{{floor.entities.length}}</em></div></template><div v-for="e in filteredEntities" :key="e.id" class="tree-row level3" :class="{current:selectedIds.includes(e.id)}" @click="selectEntity(e.id,$event.shiftKey)" @contextmenu.prevent.stop="openEntityContextMenu($event,e)"><span></span><b>{{entityIcon(e.kind)}}</b><span class="entity-label">{{e.name}}</span><i>{{e.metadata.renderType}}</i><button class="tree-action" :class="{off:!e.visible}" title="显示/隐藏" @click.stop="toggleEntity(e,'visible')">◉</button><button class="tree-action" :class="{off:!e.locked}" title="锁定" @click.stop="toggleEntity(e,'locked')">◆</button></div></template></template></template></div><div class="layers"><template v-if="externalWorkspace"><div class="panel-head"><span>SPACE 自动生成</span></div><div class="space-detection-controls"><label>识别精度<select v-model.number="spaceDetectionOptions.cellSize"><option :value=".1">快速 · 0.10 m</option><option :value=".05">精细 · 0.05 m</option></select></label><label>缝隙补偿<input v-model.number="spaceDetectionOptions.gapClosingDistance" type="number" min="0" max="1" step=".05"><span>m</span></label><label>门洞补偿<input v-model.number="spaceDetectionOptions.doorPadding" type="number" min="0" max="1" step=".05"><span>m</span></label><label>最小面积<input v-model.number="spaceDetectionOptions.minArea" type="number" min=".01" step=".5"><span>m²</span></label><button class="detect-spaces" :disabled="detectingSpaces||!isExternalSourceFloor" @click="detectSpacesFromExternalGlb">{{detectingSpaces?'识别中…':'自动识别空间'}}</button><div v-if="activeSpaceCandidates.length" class="candidate-batch"><button :disabled="!highConfidenceCandidateCount" @click="confirmHighConfidenceCandidates">确认高置信 {{highConfidenceCandidateCount}}</button><button @click="clearSpaceCandidates">清空候选</button></div><small v-if="lastSpaceDetection?.reasons.includes('source-space-boundary-unavailable')" class="detection-warning">源 GLB 已包含无法安全恢复边界的 SPACE；自动候选已停止，请使用手绘修正。</small><small v-else-if="lastSpaceDetection?.sourceSpaceStats.maxOperationsExceeded" class="detection-warning">源 GLB 的 SPACE 几何超过安全处理上限；自动候选已停止，请使用手绘修正。</small><small v-if="lastSpaceDetection">双切片 {{lastSpaceDetection.middleSliceHeight.toFixed(2)}} / {{lastSpaceDetection.upperSliceHeight.toFixed(2)}} m；已跳过 {{skippedMultiContourRegionCount}} 个带内洞区域<span v-if="lastSpaceDetection.sourceSpacePolygonCount">；已保护源 GLB 的 {{lastSpaceDetection.sourceSpacePolygonCount}} 个 SPACE</span>；黄色候选请人工复核。</small><small v-else>结果先作为临时候选；人工确认后才写入 Domain Model。</small></div></template><div class="panel-head"><span>项目设置</span></div><label>网格步长 <input :value="project.settings.gridSize" type="number" step="0.1" @change="touch(()=>project.settings.gridSize=eventNumber($event))"> m</label><label>北向 X/Z <span>{{project.settings.north.x}} / {{project.settings.north.z}}</span></label></div></aside>
  <main class="workspace">
    <div class="viewport-head"><div class="segmented"><button :class="{active:mode==='2D'}" @click="mode='2D'">2D 平面</button><button :class="{active:mode==='3D'}" @click="mode='3D'">3D 透视</button></div><div class="view-actions"><span>{{floor.floorName}}{{externalWorkspace?' · 外部模型只读':''}}</span><button v-if="activeTopologyGraph" :class="{active:topologyVisible}" @click="topologyVisible=!topologyVisible">{{topologyVisible?'隐藏拓扑':'显示拓扑'}}</button><button v-if="externalWorkspace" :disabled="detectingSpaces||!isExternalSourceFloor" @click="detectSpacesFromExternalGlb">{{detectingSpaces?'识别中…':'自动识别 SPACE'}}</button><button @click="viewport?.fitView()">适配视图</button></div></div>
    <EditorViewport
      ref="viewport"
      :floor="floor"
      :mode="mode"
      :selected-id="selectedIds[0]"
      :selected-ids="selectedIds"
      :active-tool="tool"
      :grid-size="project.settings.gridSize"
      :snap-enabled="project.settings.snapEnabled"
      :wall-height="floor.clearHeight"
      :wall-thickness="0.2"
      :floor-elevation="floor.elevation"
      :external-glb="externalWorkspace?.arrayBuffer"
      :space-candidates="spaceCandidatePreviews"
      :selected-candidate-ids="selectedCandidateIds"
      :topology-graph="activeTopologyGraph"
      :topology-visible="topologyVisible"
      :selected-topology-node-id="selectedTopologyNodeId"
      :selected-topology-edge-id="selectedTopologyEdgeId"
      @external-load-error="say($event)"
      @candidate-select="selectSpaceCandidate"
      @candidate-selection="applyCandidateViewportSelection"
      @topology-select="selectTopologyFromViewport"
      @select="selectEntity"
      @selection="applyViewportSelection"
      @selection-context="openViewportSelectionContextMenu"
      @create="onCreate"
      @wall-rejected="say('墙体长度不足，请移动终点至 0.1 m 以外')"
      @pointer="pointer=$event"
    ><div class="coordinates">X {{pointer.x.toFixed(3)}}&nbsp;&nbsp; Z {{pointer.z.toFixed(3)}}&nbsp;&nbsp; |&nbsp;&nbsp; 网格 {{Math.round(project.settings.gridSize*1000)}} mm</div></EditorViewport>
    <section class="issues"><div class="issue-tabs"><button :class="{active:issueTab==='issues'}" @click="issueTab='issues'">问题 <span>{{issues.length}}</span></button><button :class="{active:issueTab==='objects'}" @click="issueTab='objects'">对象清单 <span>{{displayedObjectCount}}</span></button><button :class="{active:issueTab==='exports'}" @click="issueTab='exports'">导出记录 <span>{{exportLogs.length}}</span></button><i></i><span class="passed" :class="{failed:errorCount}">● {{errorCount?`${errorCount} errors`:'Release 检查就绪'}}</span></div><div v-if="issueTab==='issues'" class="issue-content"><div v-if="!issues.length" class="empty-issues"><span>✓</span><div><b>当前项目未发现问题</b><small>点击“验证”执行项目与最终 GLB 回读检查</small></div></div><button v-for="item in issues" :key="item.code+item.message" class="issue-row" :class="item.severity" @click="issueClick(item)"><b>{{item.severity==='error'?'×':'!'}}</b><span><strong>{{item.code}}</strong>{{item.message}}</span></button></div><div v-else-if="issueTab==='objects'" class="object-summary"><span v-for="type in RENDER_TYPES" :key="type"><b>{{floor.entities.filter(e=>e.metadata.renderType===type).length+externalNodes.filter(node=>node.renderType===type).length}}</b>{{type}}</span></div><div v-else class="export-list"><div v-if="!exportLogs.length" class="empty-log">尚无导出记录</div><div v-for="log in exportLogs" :key="log.time+log.label"><b :class="log.status">{{log.status==='passed'?'✓':'×'}}</b><span><strong>{{log.label}}</strong><small>{{log.time}} · {{log.detail}}</small></span></div></div></section>
  </main>
  <aside class="sidebar right">
    <template v-if="selectedCandidates.length>1">
      <div class="inspector-title candidate-inspector"><div><span class="object-icon">◎</span><div><strong>已选 {{selectedCandidates.length}} 个候选</strong><small>高置信 {{selectedCandidateHighCount}} · 待复核 {{selectedCandidates.length-selectedCandidateHighCount}}</small></div></div><span class="candidate-badge">批量确认</span></div>
      <section><h3>候选批次</h3><div class="batch-selection-summary"><span><b>{{selectedCandidates.length}}</b>个 SPACE 候选</span><span><b>{{selectedCandidates.reduce((sum,candidate)=>sum+candidate.area,0).toFixed(2)}}</b>m² 推断面积</span></div><div class="candidate-note">所选候选将作为一个原子批次写入 Domain Model；任一候选校验失败时整批都不会写入。</div></section>
      <section class="candidate-actions"><button class="primary" @click="confirmSelectedSpaceCandidates">统一确认 {{selectedCandidates.length}} 个 SPACE</button><button @click="dismissSelectedSpaceCandidates">忽略所选候选</button></section>
    </template>
    <template v-else-if="selectedCandidate">
      <div class="inspector-title candidate-inspector"><div><span class="object-icon">◎</span><div><strong>{{selectedCandidate.name}}</strong><small>{{candidateConfidenceLabel(selectedCandidate)}}</small></div></div><span class="candidate-badge" :class="{low:selectedCandidate.confidence==='inferred-low'}">临时候选</span></div>
      <section><h3>人工确认</h3><label>空间名称<input v-model="selectedCandidate.name"></label><label>Space Type<select v-model="selectedCandidate.spaceType"><option v-for="value in SPACE_TYPES" :key="value">{{value}}</option></select></label><div class="field-pair"><label>推断面积<input :value="selectedCandidate.area.toFixed(2)" readonly><span>m²</span></label><label>顶点数<input :value="selectedCandidate.polygon.length" readonly></label></div><div class="field-pair"><label>切片高度<input :value="selectedCandidate.sliceHeight?.toFixed(2)??'—'" readonly><span v-if="selectedCandidate.sliceHeight!==undefined">m</span></label><label>证据节点<input :value="selectedCandidate.sourceIds.length" readonly></label></div></section>
      <section><h3>识别依据</h3><ul class="candidate-reasons"><li v-for="reason in selectedCandidate.reasons" :key="reason">{{candidateReasonLabel(reason)}}</li></ul><div class="candidate-note">候选不会保存或导出。只有点击“确认写入 SPACE”后，才会以人工确认 metadata 写入 Domain Model。</div></section>
      <section class="candidate-actions"><button class="primary" @click="confirmSpaceCandidate(selectedCandidate.id)">确认写入 SPACE</button><button @click="startManualSpaceCorrection">手绘修正边界</button><button @click="dismissSpaceCandidate(selectedCandidate.id)">忽略候选</button></section>
    </template>
    <template v-else-if="selectedEntities.length>1">
      <div class="inspector-title batch-inspector"><div><span class="object-icon">⬡</span><div><strong>已选 {{selectedEntities.length}} 个构件</strong><small>{{canBatchEditSpaceType?'SPACE · 批量编辑':'多选'}}</small></div></div></div>
      <section><h3>批量空间属性</h3><label>Space Type<select :value="selectedSpaceTypeValue" :disabled="!canBatchEditSpaceType" @change="updateSelectedSpaceTypes"><option value="" disabled>{{selectedSpaceTypeValue?'请选择类型':'混合值'}}</option><option v-for="value in SPACE_TYPES" :key="value">{{value}}</option></select></label><div v-if="batchSpaceTypeDisabledReason" class="batch-edit-note warning">{{batchSpaceTypeDisabledReason}}</div><div v-else class="batch-edit-note">选择类型后将统一修改 {{selectedEntities.length}} 个 SPACE；一次撤销可恢复整个批次。</div></section>
    </template>
    <template v-else-if="selected">
      <div class="inspector-title"><div><span class="object-icon">{{entityIcon(selected.kind)}}</span><div><strong>{{selected.name}}</strong><small>{{selected.metadata.renderType}} · {{selected.metadata.confidence}}</small></div></div><button title="更多操作" @click="openEntityContextMenu($event,selected)">•••</button></div>
      <section><h3>标识</h3><label>对象名称<input :value="selected.name" :disabled="selected.locked" @change="updateEntity(e=>e.name=eventText($event))"></label><label>内部 ID<input :value="selected.id" readonly></label><label>SID<div class="sid"><input :value="sidFor(selected)" readonly><button title="复制" @click="navigator.clipboard?.writeText(sidFor(selected));say('SID 已复制')">⧉</button></div></label></section>
      <section><h3>语义</h3><label>构件类型<input :value="selected.metadata.renderType" readonly></label><label v-if="!['FACILITY','CEILING','WALL','SPACE'].includes(selected.metadata.renderType)">方位<select :value="selected.metadata.direction" :disabled="selected.locked" @change="updateEntity(e=>{e.metadata.direction=eventText($event) as Direction;e.metadata.directionMode='manual'})"><option v-for="d in DIRECTIONS" :key="d">{{d}}</option></select></label><label>序号<input :value="selected.metadata.sequence" :disabled="selected.locked" type="number" min="1" @change="updateEntity(e=>e.metadata.sequence=Math.max(1,eventNumber($event)))"></label><label>置信度<div class="confirmed"><span>✓</span>{{selected.metadata.confidence==='confirmed'?'人工确认':selected.metadata.confidence}}</div></label></section>
      <section v-if="selected.kind==='space'"><h3>空间属性</h3><label>Space Type<select :value="selected.spaceType" :disabled="selected.locked" @change="updateSingleSpaceType"><option v-for="v in SPACE_TYPES" :key="v">{{v}}</option></select></label><div class="field-pair"><label>面积<input :value="spaceMetrics(selected).area.toFixed(2)" readonly><span>m²</span></label><label>顶点数<input :value="spaceMetrics(selected).vertexCount" readonly></label></div><div class="field-pair"><label>质心 X<input :value="spaceMetrics(selected).centroidX.toFixed(3)" readonly></label><label>质心 Z<input :value="spaceMetrics(selected).centroidZ.toFixed(3)" readonly></label></div><small class="locked-hint">边界为多边形；需要调整形状时请删除后重新绘制。</small></section>
      <section v-if="selected.kind==='facility'"><h3>设施属性</h3><label>Fire Type<select :value="selected.fireType" :disabled="selected.locked" @change="updateEntity(e=>{if(e.kind==='facility')e.fireType=eventText($event) as typeof e.fireType})"><option v-for="v in FIRE_TYPES" :key="v">{{v}}</option></select></label><label>安装高度<input :value="selected.mountHeight" :disabled="selected.locked" type="number" step="0.1" @change="updateEntity(e=>{if(e.kind==='facility'){e.mountHeight=eventNumber($event);e.position.y=e.mountHeight}})"></label></section>
      <section v-if="selected.kind==='wall'"><h3>墙体参数</h3><div class="field-pair"><label>高度<input :value="selected.height" :disabled="selected.locked" type="number" step="0.1" @change="updateEntity(e=>{if(e.kind==='wall')e.height=eventNumber($event)})"><span>m</span></label><label>厚度<input :value="selected.thickness" :disabled="selected.locked" type="number" step="0.05" @change="updateEntity(e=>{if(e.kind==='wall')e.thickness=eventNumber($event)})"><span>m</span></label></div><label>洞口数量<input :value="`${selected.openings.length} 个`" readonly></label></section>
      <section v-if="selected.kind==='door'||selected.kind==='window'"><h3>洞口参数</h3><div class="field-pair"><label>宽度<input :value="selected.width" :disabled="selected.locked" type="number" step="0.1" @change="updateEntity(e=>{if(e.kind==='door'||e.kind==='window')e.width=eventNumber($event)})"><span>m</span></label><label>高度<input :value="selected.height" :disabled="selected.locked" type="number" step="0.1" @change="updateEntity(e=>{if(e.kind==='door'||e.kind==='window')e.height=eventNumber($event)})"><span>m</span></label></div><label>墙上偏移<input :value="selected.offset" :disabled="selected.locked" type="number" step="0.1" @change="updateEntity(e=>{if(e.kind==='door'||e.kind==='window')e.offset=eventNumber($event)})"></label></section>
      <section><h3>状态</h3><small v-if="selected.locked" class="locked-hint">已锁定：属性编辑和删除已禁用</small><label class="toggle-row">显示对象<input :checked="selected.visible" type="checkbox" @change="toggleEntity(selected,'visible')"></label><label class="toggle-row">锁定编辑<input :checked="selected.locked" type="checkbox" @change="toggleEntity(selected,'locked')"></label></section>
    </template>
    <template v-else-if="selectedExternalNode">
      <div class="inspector-title readonly-inspector"><div><span class="object-icon">◆</span><div><strong>{{selectedExternalNode.name}}</strong><small>{{selectedExternalNode.renderType}} · 原 GLB 只读节点</small></div></div><span class="readonly-badge">只读</span></div>
      <section><h3>节点标识</h3><label>节点名称<input :value="selectedExternalNode.name" readonly></label><div class="field-pair"><label>Node Index<input :value="selectedExternalNode.nodeIndex" readonly></label><label>Mesh Index<input :value="selectedExternalNode.meshIndex" readonly></label></div><label>SID<div class="sid"><input :value="selectedExternalNode.sid" readonly><button title="复制" @click="navigator.clipboard?.writeText(selectedExternalNode.sid);say('SID 已复制')">⧉</button></div></label><label>findId<input :value="selectedExternalNode.findId" readonly></label></section>
      <section><h3>语义 metadata</h3><label>构件类型<input :value="selectedExternalNode.renderType" readonly></label><label>置信度<input :value="selectedExternalNode.renderTypeConfidence" readonly></label><label v-if="selectedExternalNode.spaceType">Space Type<input :value="selectedExternalNode.spaceType" readonly></label><label v-if="selectedExternalNode.fireType">Fire Type<input :value="selectedExternalNode.fireType" readonly></label></section>
      <section><h3>状态</h3><div class="readonly-note">原始 GLB 节点仅用于查看，不进入可编辑 Domain，也不会被 Studio 改写。</div></section>
    </template>
    <template v-else-if="treeSelection.type==='project'">
      <div class="inspector-title hierarchy-inspector"><div><span class="object-icon">▣</span><div><strong>{{project.name}}</strong><small>PROJECT · 项目根</small></div></div><button title="更多操作" @click="openHierarchyContextMenu($event,{type:'project',id:project.projectId})">•••</button></div>
      <section><h3>项目标识</h3><label>项目名称<input :value="project.name" @change="renameProject"></label><label>项目 ID<input :value="project.projectId" readonly></label></section>
      <section><h3>项目概要</h3><div class="hierarchy-stats"><span><b>{{project.buildings.length}}</b>个单体</span><span><b>{{project.buildings.reduce((sum,item)=>sum+item.floors.length,0)}}</b>个楼层</span><span><b>{{project.buildings.reduce((sum,item)=>sum+item.floors.reduce((count,current)=>count+current.entities.length,0),0)+externalNodes.length}}</b>个对象</span></div><label>Schema<input :value="project.schemaVersion" readonly></label><label>Metadata<input :value="project.metadataSpecVersion" readonly></label></section>
    </template>
    <template v-else-if="inspectedBuilding">
      <div class="inspector-title hierarchy-inspector"><div><span class="object-icon">▤</span><div><strong>{{inspectedBuilding.name}}</strong><small>BUILDING · {{inspectedBuilding.code}}</small></div></div><button title="更多操作" @click="openHierarchyContextMenu($event,{type:'building',id:inspectedBuilding.id})">•••</button></div>
      <section><h3>单体标识</h3><label>单体名称<input :value="inspectedBuilding.name" @change="renameBuilding"></label><label>单体编码<input :value="inspectedBuilding.code" readonly></label><label>内部 ID<input :value="inspectedBuilding.id" readonly></label></section>
      <section><h3>单体概要</h3><div class="hierarchy-stats"><span><b>{{inspectedBuilding.floors.length}}</b>个楼层</span><span><b>{{inspectedBuilding.floors.reduce((sum,item)=>sum+item.entities.length,0)+externalNodes.length}}</b>个对象</span></div></section>
    </template>
    <template v-else-if="inspectedFloor">
      <div class="inspector-title hierarchy-inspector"><div><span class="object-icon">▰</span><div><strong>{{inspectedFloor.name}}</strong><small>FLOOR · {{inspectedFloor.floorName}}</small></div></div><button title="更多操作" @click="openHierarchyContextMenu($event,{type:'floor',id:inspectedFloor.id})">•••</button></div>
      <section><h3>楼层标识</h3><label>楼层名称<input :value="inspectedFloor.name" @change="renameFloor"></label><label>Floor Name<input :value="inspectedFloor.floorName" readonly></label><label>内部 ID<input :value="inspectedFloor.id" readonly></label></section>
      <section><h3>楼层概要</h3><div class="hierarchy-stats"><span v-if="externalWorkspace"><b>{{externalNodes.length}}</b>原 GLB</span><span><b>{{inspectedFloor.entities.length}}</b>{{externalWorkspace?'新增 SPACE':'个构件'}}</span><span><b>{{inspectedFloor.level??'—'}}</b>标高层</span></div><label>楼层类型<input :value="inspectedFloor.floorType" readonly></label><label>标高<input :value="`${inspectedFloor.elevation} m`" readonly></label><label>净高<input :value="`${inspectedFloor.clearHeight} m`" readonly></label></section>
    </template>
    <div v-else class="no-selection"><span>↖</span><b>未选择节点</b><small>从项目树或视口中选择一个节点</small></div>
  </aside>
  <footer><span><i class="online" :class="{bad:errorCount}"></i>{{errorCount?'项目存在错误':'项目数据可验证'}}</span><span>Y-up · 米制 · 北向 {{project.settings.north.x}} / {{project.settings.north.z}}</span><span class="foot-right">Metadata 3.3-semantic&nbsp;&nbsp;·&nbsp;&nbsp;{{floor.floorName}}&nbsp;&nbsp;·&nbsp;&nbsp;{{warningCount}} warnings</span></footer>
  <div v-if="entityContextMenu" ref="contextMenuElement" class="entity-context-menu" :style="{left:`${entityContextMenu.x}px`,top:`${entityContextMenu.y}px`}" role="menu" aria-label="选择操作" @pointerdown.stop @contextmenu.prevent.stop>
    <div class="entity-context-title"><span>{{contextMenuIcon}}</span><strong>{{contextMenuTitle}}</strong></div>
    <button v-for="action in contextAuxActions" :key="action.id" class="context-action" type="button" role="menuitem" @click="runContextAction(action.id)"><span>{{action.id==='duplicate-floor'?'⧉':'＋'}}</span>{{action.label}}</button>
    <button ref="contextDeleteButton" class="danger" type="button" role="menuitem" :disabled="contextLockedEntities.length>0" @click="deleteContextEntity"><span>⌫</span>{{contextDeleteLabel}}</button>
    <small v-if="contextLockedEntities.length">包含 {{contextLockedEntities.length}} 个锁定构件，无法删除</small>
  </div>
  <div v-if="confirmation" class="confirmation-backdrop" @pointerdown.self="confirmation=undefined">
    <section class="confirmation-dialog" role="dialog" aria-modal="true" :aria-label="confirmation.title">
      <h2>{{confirmation.title}}</h2><p>{{confirmation.message}}</p>
      <div class="confirmation-actions"><button type="button" @click="confirmation=undefined">取消</button><button v-if="confirmation.secondaryLabel" type="button" @click="chooseConfirmation('secondary')">{{confirmation.secondaryLabel}}</button><button type="button" :class="{danger:confirmation.danger}" @click="chooseConfirmation('confirm')">{{confirmation.confirmLabel}}</button></div>
    </section>
  </div>
  <TopologyWorkspace v-if="topologyOpen" :state="project.topology" :floor-name="floor.floorName" :busy="topologyBusy" :selected-node-id="selectedTopologyNodeId" :selected-edge-id="selectedTopologyEdgeId" @close="topologyOpen=false" @generate="generateProjectTopology" @select-node="selectTopologyNode" @select-edge="selectTopologyEdge" @add-node="topologyAddNode" @update-node="topologyUpdateNode" @delete-node="topologyDeleteNode" @restore-node="topologyRestoreNode" @add-edge="topologyAddEdge" @update-edge-via="topologyUpdateEdgeVia" @delete-edge="topologyDeleteEdge" @restore-edge="topologyRestoreEdge" />
  <transition name="toast"><div v-if="toast" class="toast">{{toast}}</div></transition>
</div>
</template>

<style src="./entity-context-menu.css"></style>
