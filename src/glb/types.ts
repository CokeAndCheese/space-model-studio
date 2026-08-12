import type { FloorType, RenderType } from '../domain/contract'

export const GLB_MAGIC = 0x46546c67
export const GLB_VERSION = 2
export const GLB_JSON_CHUNK_TYPE = 0x4e4f534a
export const GLB_BIN_CHUNK_TYPE = 0x004e4942

export interface GlbSceneExtras {
  [key: string]: unknown
  floorName: string
  building: string | null
  level: number | null
  floorType: FloorType
  name: string
}

export interface GlbNodeExtras extends GlbSceneExtras {
  sid: string
  findId: string
  renderType: RenderType
  renderTypeConfidence: 'high' | 'low'
  spaceType?: string
  fireType?: string
}

export interface GlbJson {
  asset: { version: string; generator?: string }
  scene?: number
  scenes?: Array<{ name?: string; nodes?: number[]; extras?: Record<string, unknown> }>
  nodes?: Array<{
    name?: string
    mesh?: number
    children?: number[]
    translation?: number[]
    rotation?: number[]
    scale?: number[]
    matrix?: number[]
    extras?: Record<string, unknown>
  }>
  meshes?: Array<{
    name?: string
    primitives: Array<{
      attributes: Record<string, number>
      indices?: number
      material?: number
      mode?: number
    }>
  }>
  buffers?: Array<{ byteLength: number; uri?: string }>
  bufferViews?: Array<{
    buffer: number
    byteOffset?: number
    byteLength: number
    byteStride?: number
    target?: number
  }>
  accessors?: Array<{
    bufferView?: number
    byteOffset?: number
    componentType: number
    normalized?: boolean
    count: number
    type: string
    min?: number[]
    max?: number[]
  }>
  materials?: Array<Record<string, unknown>>
  [key: string]: unknown
}

export interface GlbChunk {
  type: number
  byteLength: number
  data: Uint8Array
  byteOffset: number
}

export interface ParsedGlb {
  header: {
    magic: number
    version: number
    totalLength: number
  }
  chunks: GlbChunk[]
  jsonChunk: GlbChunk
  binChunk?: GlbChunk
  json: GlbJson
}

export type GlbIssueSeverity = 'error' | 'warning'

export interface GlbValidationIssue {
  severity: GlbIssueSeverity
  code: string
  message: string
  path?: string
}

export interface GlbFileAudit {
  fileName: string
  sizeBytes: number
  sceneMetadata: Partial<GlbSceneExtras> | null
  meshNodes: number
  sidCount: number
  findIdCount: number
  sidDuplicates: number
  findIdDuplicates: number
  metadataCoverage: number
  reloadSuccess: boolean
  binHash: string | null
  renderTypeCounts: Partial<Record<RenderType, number>>
  errors: GlbValidationIssue[]
  warnings: GlbValidationIssue[]
}

export interface GlbAuditReport {
  metadataSpecVersion: '3.3-semantic'
  project: { id: string; name: string }
  summary: {
    files: number
    meshNodes: number
    sidCount: number
    findIdCount: number
    sidDuplicates: number
    findIdDuplicates: number
    metadataCoverage: number
    reloadSuccess: boolean
    errors: number
    warnings: number
  }
  renderTypeCounts: Partial<Record<RenderType, number>>
  files: GlbFileAudit[]
}

export interface FloorGlbExportResult {
  fileName: string
  bytes: Uint8Array
  auditReport: GlbAuditReport
}
