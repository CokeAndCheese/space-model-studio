import type { Confidence, Project, SpaceType, Vec2 } from '../domain/contract'
import { makeSpace } from '../domain/entity-factory'
import { addEntity, findFloorLocation } from '../domain/project-commands'
import { decideSpacePolygonCommit } from '../components/space-polygon-drawing'
import { areSpacePolygonsEquivalent, areSpacePolygonsMateriallyOverlapping } from './external-space-candidates'

export interface DetectedSpaceCandidateLike {
  id: string
  polygon: readonly Vec2[]
  area: number
  confidence: Extract<Confidence, 'inferred-high' | 'inferred-low'>
  reasons: readonly string[]
  stats?: { sourceIds: readonly string[] }
  sliceHeight?: number
}

/** UI-owned review data. This type is deliberately outside the persisted Project contract. */
export interface ExternalSpaceCandidateDraft {
  id: string
  floorId: string
  polygon: Vec2[]
  area: number
  confidence: Extract<Confidence, 'inferred-high' | 'inferred-low'>
  reasons: string[]
  sourceIds: string[]
  sliceHeight?: number
  name: string
  spaceType: SpaceType
}

export interface ConfirmedSpaceCandidates {
  project: Project
  entityIds: string[]
}

export class SpaceCandidateConfirmationError extends Error {
  constructor(
    readonly candidateId: string,
    readonly reason: string,
  ) {
    super(`候选空间 ${candidateId} 的边界无效：${reason}`)
    this.name = 'SpaceCandidateConfirmationError'
  }
}

export function makeExternalSpaceCandidateDrafts(
  candidates: readonly DetectedSpaceCandidateLike[],
  existingSpaceCount = 0,
  floorId = '',
): ExternalSpaceCandidateDraft[] {
  return candidates.map((candidate, index) => ({
    id: floorId ? `${floorId}:${candidate.id}` : candidate.id,
    floorId,
    polygon: candidate.polygon.map((point) => ({ ...point })),
    area: candidate.area,
    confidence: candidate.confidence,
    reasons: [...candidate.reasons],
    sourceIds: [...(candidate.stats?.sourceIds ?? [])],
    ...(candidate.sliceHeight === undefined ? {} : { sliceHeight: candidate.sliceHeight }),
    name: `自动空间 ${existingSpaceCount + index + 1}`,
    spaceType: 'OFFICE',
  }))
}

/**
 * Converts reviewed candidates into confirmed Domain SPACE entities.
 * The input Project and transient candidate records are never mutated.
 */
export function confirmExternalSpaceCandidates(
  source: Project,
  floorId: string,
  candidates: readonly ExternalSpaceCandidateDraft[],
): ConfirmedSpaceCandidates {
  const mismatched = candidates.find((candidate) => !candidate.floorId || candidate.floorId !== floorId)
  if (mismatched) throw new SpaceCandidateConfirmationError(mismatched.id, 'candidate-floor-mismatch')
  let project = source
  const entityIds: string[] = []

  for (const candidate of candidates) {
    const decision = decideSpacePolygonCommit(candidate.polygon)
    if (!decision.accepted) throw new SpaceCandidateConfirmationError(candidate.id, decision.reason)
    const targetFloor = findFloorLocation(project, floorId)?.floor
    if (!targetFloor) throw new SpaceCandidateConfirmationError(candidate.id, 'floor-not-found')
    if (targetFloor.entities.some((entity) => entity.kind === 'space' && areSpacePolygonsEquivalent(entity.polygon, decision.polygon))) {
      throw new SpaceCandidateConfirmationError(candidate.id, 'equivalent-space-already-exists')
    }
    if (targetFloor.entities.some((entity) => entity.kind === 'space' && areSpacePolygonsMateriallyOverlapping(entity.polygon, decision.polygon))) {
      throw new SpaceCandidateConfirmationError(candidate.id, 'material-space-overlap')
    }
    const entity = makeSpace(floorId, {
      polygon: decision.polygon,
      name: candidate.name.trim() || '已确认空间',
      spaceType: candidate.spaceType,
      metadata: {
        confidence: 'confirmed',
        renderTypeMode: 'manual',
        sidMode: 'auto',
        directionMode: 'auto',
        sequence: 1,
      },
    })
    project = addEntity(project, floorId, entity)
    entityIds.push(entity.id)
  }

  return { project, entityIds }
}
