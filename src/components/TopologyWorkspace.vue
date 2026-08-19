<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { resolveTopology, type TopologyAuthoringState } from '../topology/authoring'
import { createTopologyReport } from '../topology/report'
import type { TopologyEdge, TopologyNode, TopologyPoint } from '../topology/contract'

const props = defineProps<{ state?: TopologyAuthoringState; floorName: string; busy?: boolean; selectedNodeId?: string; selectedEdgeId?: string }>()
const emit = defineEmits<{
  close: []
  generate: []
  addNode: [value: { layerId: string; label: string; position: TopologyPoint }]
  updateNode: [value: { id: string; position: TopologyPoint; connectorId: string | null }]
  deleteNode: [id: string]
  restoreNode: [id: string]
  addEdge: [value: { source: string; target: string }]
  updateEdgeVia: [value: { id: string; via: TopologyPoint[] }]
  deleteEdge: [id: string]
  restoreEdge: [id: string]
  selectNode: [id: string]
  selectEdge: [id: string]
}>()

const selectedNodeId = ref('')
const selectedEdgeId = ref('')
const newNode = ref({ label: '人工节点', x: 0, y: 0.08, z: 0 })
const edgeSource = ref('')
const edgeTarget = ref('')
const editNode = ref({ x: 0, y: 0, z: 0, connectorId: '' })
const viaText = ref('')
const topology = computed(() => props.state ? resolveTopology(props.state) : undefined)
const graph = computed(() => topology.value?.graphs.find((item) => item.layers.some((layer) => layer.id === props.floorName)) ?? topology.value?.graphs[0])
const report = computed(() => topology.value ? createTopologyReport(topology.value) : undefined)
const graphReport = computed(() => report.value?.graphs.find((item) => item.graphId === graph.value?.id))
const selectedNode = computed(() => graph.value?.nodes.find((node) => node.id === selectedNodeId.value))
const selectedEdge = computed(() => graph.value?.edges.find((edge) => edge.id === selectedEdgeId.value))
const deletedNodes = computed(() => Object.entries(props.state?.nodeEdits ?? {}).filter(([, edit]) => edit.deleted).map(([id]) => id).sort())
const deletedEdges = computed(() => Object.entries(props.state?.edgeEdits ?? {}).filter(([, edit]) => edit.deleted).map(([id]) => id).sort())

watch(selectedNode, (node) => {
  if (!node) return
  editNode.value = { ...node.position, connectorId: node.connectorId ?? '' }
})
watch(selectedEdge, (edge) => { viaText.value = (edge?.path?.via ?? []).map((point) => `${point.x},${point.y},${point.z}`).join('; ') })
watch(selectedNodeId, (id) => { if (id) emit('selectNode', id) })
watch(selectedEdgeId, (id) => { if (id) emit('selectEdge', id) })
watch(() => props.selectedNodeId, (id) => { if (id && graph.value?.nodes.some((node) => node.id === id)) selectedNodeId.value = id }, { immediate: true })
watch(() => props.selectedEdgeId, (id) => { if (id && graph.value?.edges.some((edge) => edge.id === id)) selectedEdgeId.value = id }, { immediate: true })
watch(graph, (value) => {
  if (!value) return
  if (!value.nodes.some((node) => node.id === selectedNodeId.value)) selectedNodeId.value = value.nodes[0]?.id ?? ''
  if (!value.edges.some((edge) => edge.id === selectedEdgeId.value)) selectedEdgeId.value = value.edges[0]?.id ?? ''
  edgeSource.value ||= value.nodes[0]?.id ?? ''
  edgeTarget.value ||= value.nodes[1]?.id ?? ''
}, { immediate: true })

const bounds = computed(() => {
  const nodes = graph.value?.nodes ?? []
  if (!nodes.length) return { minX: 0, maxX: 1, minZ: 0, maxZ: 1 }
  const xs = nodes.map((node) => node.position.x), zs = nodes.map((node) => node.position.z)
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs)
  return { minX, maxX: maxX === minX ? maxX + 1 : maxX, minZ, maxZ: maxZ === minZ ? maxZ + 1 : maxZ }
})
function screen(point: TopologyPoint) {
  const value = bounds.value
  return { x: 30 + (point.x - value.minX) / (value.maxX - value.minX) * 640, y: 330 - (point.z - value.minZ) / (value.maxZ - value.minZ) * 290 }
}
function polyline(edge: TopologyEdge) {
  const byId = new Map((graph.value?.nodes ?? []).map((node) => [node.id, node]))
  const source = byId.get(edge.source), target = byId.get(edge.target)
  if (!source || !target) return ''
  return [source.position, ...(edge.path?.via ?? []), target.position].map((point) => { const value = screen(point); return `${value.x},${value.y}` }).join(' ')
}
function nodeColor(node: TopologyNode) {
  const type = node.data?.renderType
  return type === 'DOOR' ? '#f6b84a' : type === 'STAIR' || type === 'ELEVATOR' ? '#a983ff' : type === 'FACILITY' ? '#ff7185' : '#3dd7bd'
}
function parseVia(): TopologyPoint[] {
  const source = viaText.value.trim()
  if (!source) return []
  return source.split(';').map((part) => {
    const values = part.split(',').map((value) => Number(value.trim()))
    if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) throw new Error('via 格式应为 x,y,z; x,y,z')
    return { x: values[0]!, y: values[1]!, z: values[2]! }
  })
}
function saveVia() {
  if (!selectedEdge.value) return
  try { emit('updateEdgeVia', { id: selectedEdge.value.id, via: parseVia() }) } catch (error) { window.alert(error instanceof Error ? error.message : 'via 格式无效') }
}
</script>

<template>
  <div class="topology-backdrop" @click.self="emit('close')">
    <section class="topology-workspace" aria-label="Topology 工作区">
      <header><div><strong>生成拓扑</strong><small>Model Studio · 不可变 baseline + 人工 edits</small></div><div><button :disabled="busy" @click="emit('generate')">{{state?'重新生成 baseline':'从语义实体生成'}}</button><button class="close" @click="emit('close')">×</button></div></header>
      <div v-if="!state" class="topology-empty"><b>尚未生成 topology baseline</b><span>将从当前 Domain Model 或导入模型的 SPACE、DOOR、STAIR、ELEVATOR、FACILITY 生成一实体一节点的连通图。</span><button :disabled="busy" @click="emit('generate')">{{busy?'生成中…':'生成 topology baseline'}}</button></div>
      <template v-else-if="graph">
        <div class="topology-summary">
          <span><b>{{graph.nodes.length}}</b> 节点</span><span><b>{{graph.edges.length}}</b> 边</span><span :class="{bad:(graphReport?.components??0)!==1}"><b>{{graphReport?.components}}</b> 连通分量</span><span :class="{warn:(report?.missingConnectorIds.length??0)>0}"><b>{{report?.missingConnectorIds.length}}</b> connector 诊断</span><span :class="{bad:!report?.valid}">{{report?.valid?'✓ 可嵌入 Release':'× 校验失败'}}</span>
        </div>
        <div class="topology-main">
          <div class="topology-canvas">
            <svg viewBox="0 0 700 360" role="img" aria-label="Topology 节点与边预览">
              <rect width="700" height="360" fill="#0d141c"/>
              <g class="topology-grid"><line v-for="i in 8" :key="'x'+i" :x1="i*87.5" y1="0" :x2="i*87.5" y2="360"/><line v-for="i in 5" :key="'y'+i" x1="0" :y1="i*72" x2="700" :y2="i*72"/></g>
              <polyline v-for="edge in graph.edges" :key="edge.id" :points="polyline(edge)" :class="{selected:selectedEdgeId===edge.id,manual:edge.tags?.includes('manual')}" @click="selectedEdgeId=edge.id"/>
              <g v-for="node in graph.nodes" :key="node.id" class="topology-node" :class="{selected:selectedNodeId===node.id}" :transform="`translate(${screen(node.position).x} ${screen(node.position).y})`" @click="selectedNodeId=node.id"><circle r="6" :fill="nodeColor(node)"/><text x="9" y="4">{{node.label||node.id}}</text></g>
            </svg>
            <div class="topology-legend"><span><i class="space"></i>SPACE</span><span><i class="door"></i>DOOR</span><span><i class="connector"></i>STAIR / ELEVATOR</span><span><i class="facility"></i>FACILITY</span><em>当前层 {{graph.layers[0]?.id}} · MODEL_LOCAL</em></div>
          </div>
          <aside class="topology-editor">
            <section><h3>节点</h3><select v-model="selectedNodeId"><option v-for="node in graph.nodes" :key="node.id" :value="node.id">{{node.label||node.id}}</option></select><template v-if="selectedNode"><div class="coord-row"><input v-model.number="editNode.x" type="number" step="0.1" aria-label="节点 X"><input v-model.number="editNode.y" type="number" step="0.1" aria-label="节点 Y"><input v-model.number="editNode.z" type="number" step="0.1" aria-label="节点 Z"></div><input v-model="editNode.connectorId" placeholder="connectorId（楼梯/电梯）"><div class="button-row"><button @click="emit('updateNode',{id:selectedNode.id,position:{x:editNode.x,y:editNode.y,z:editNode.z},connectorId:editNode.connectorId||null})">应用调整</button><button class="danger" @click="emit('deleteNode',selectedNode.id)">删除</button></div></template></section>
            <section><h3>新增节点</h3><input v-model="newNode.label" placeholder="节点名称"><div class="coord-row"><input v-model.number="newNode.x" type="number" step="0.1"><input v-model.number="newNode.y" type="number" step="0.1"><input v-model.number="newNode.z" type="number" step="0.1"></div><button @click="emit('addNode',{layerId:graph.layers[0]!.id,label:newNode.label,position:{x:newNode.x,y:newNode.y,z:newNode.z}})">新增人工节点</button></section>
            <section><h3>边与 via 路径</h3><select v-model="selectedEdgeId"><option v-for="edge in graph.edges" :key="edge.id" :value="edge.id">{{edge.source}} → {{edge.target}}</option></select><template v-if="selectedEdge"><textarea v-model="viaText" rows="2" placeholder="x,y,z; x,y,z"></textarea><div class="button-row"><button @click="saveVia">更新 via</button><button class="danger" @click="emit('deleteEdge',selectedEdge.id)">删除</button></div></template><div class="edge-add"><select v-model="edgeSource"><option v-for="node in graph.nodes" :key="node.id" :value="node.id">{{node.label||node.id}}</option></select><select v-model="edgeTarget"><option v-for="node in graph.nodes" :key="node.id" :value="node.id">{{node.label||node.id}}</option></select><button :disabled="!edgeSource||!edgeTarget||edgeSource===edgeTarget" @click="emit('addEdge',{source:edgeSource,target:edgeTarget})">新增边</button></div></section>
            <section v-if="deletedNodes.length||deletedEdges.length"><h3>恢复已删除项</h3><button v-for="id in deletedNodes" :key="id" class="restore" @click="emit('restoreNode',id)">恢复节点 · {{id}}</button><button v-for="id in deletedEdges" :key="id" class="restore" @click="emit('restoreEdge',id)">恢复边 · {{id}}</button></section>
          </aside>
        </div>
        <footer><span>策略 SEMANTIC_NODE_MST_KNN · K={{graph.data?.nearestNeighbors}}</span><span v-if="report?.missingConnectorIds.length" class="warn">connectorId 缺失：{{report.missingConnectorIds.join('、')}}</span><span v-else>节点、边、连通性与路径几何检查通过</span></footer>
      </template>
    </section>
  </div>
</template>
