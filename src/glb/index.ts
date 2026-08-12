export { buildEntityGeometry, EntityGeometryError } from './entity-geometry'
export { exportFloorToGlb, GlbExportError } from './floor-exporter'
export {
  appendExternalSpacesToGlb,
  ExternalSpaceExportError,
} from './external-space-exporter'
export { encodeGlb, GlbParseError, parseGlb } from './glb-codec'
export { sha256 } from './bin-integrity'
export { createGlbAuditReport, validateGlb } from '../validation/glb-validator'
export type {
  FloorGlbExportResult,
  GlbAuditReport,
  GlbFileAudit,
  GlbJson,
  GlbNodeExtras,
  GlbSceneExtras,
  GlbValidationIssue,
  ParsedGlb,
} from './types'
export type { GlbValidationResult, ValidateGlbOptions } from '../validation/glb-validator'
export type {
  ExternalSpaceExportInput,
  ExternalSpaceExportResult,
  ExternalSpacePreservationSummary,
} from './external-space-exporter'
