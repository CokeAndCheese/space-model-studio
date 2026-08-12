import type { ValidationProfile } from './validation-profiles'

export type ValidationSeverity = 'error' | 'warning'

export interface ValidationIssue {
  code: string
  severity: ValidationSeverity
  message: string
  path: string
  buildingId?: string
  floorId?: string
  entityId?: string
}

export interface ValidationReport {
  profile: ValidationProfile
  valid: boolean
  issues: ValidationIssue[]
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
  summary: {
    buildings: number
    floors: number
    entities: number
    errors: number
    warnings: number
  }
}

export function createValidationReport(
  profile: ValidationProfile,
  issues: ValidationIssue[],
  counts: { buildings: number; floors: number; entities: number },
): ValidationReport {
  const errors = issues.filter((item) => item.severity === 'error')
  const warnings = issues.filter((item) => item.severity === 'warning')
  return {
    profile,
    valid: errors.length === 0,
    issues,
    errors,
    warnings,
    summary: { ...counts, errors: errors.length, warnings: warnings.length },
  }
}
