export type GeometryErrorCode =
  | 'INVALID_DIMENSION'
  | 'INVALID_POLYGON'
  | 'INVALID_OPENING'
  | 'MISSING_HOST'
  | 'MERGE_FAILED'
  | 'UNSUPPORTED_ENTITY'

/** A deterministic, user-presentable failure produced while projecting Domain data. */
export class GeometryBuildError extends Error {
  readonly code: GeometryErrorCode
  readonly entityId?: string

  constructor(code: GeometryErrorCode, message: string, entityId?: string) {
    super(message)
    this.name = 'GeometryBuildError'
    this.code = code
    this.entityId = entityId
  }
}

export function assertFinite(value: number, label: string, entityId?: string): void {
  if (!Number.isFinite(value)) {
    throw new GeometryBuildError('INVALID_DIMENSION', `${label} must be finite`, entityId)
  }
}

export function assertPositive(value: number, label: string, entityId?: string): void {
  assertFinite(value, label, entityId)
  if (value <= 0) {
    throw new GeometryBuildError('INVALID_DIMENSION', `${label} must be greater than 0`, entityId)
  }
}

export function assertNonNegative(value: number, label: string, entityId?: string): void {
  assertFinite(value, label, entityId)
  if (value < 0) {
    throw new GeometryBuildError('INVALID_DIMENSION', `${label} must not be negative`, entityId)
  }
}
