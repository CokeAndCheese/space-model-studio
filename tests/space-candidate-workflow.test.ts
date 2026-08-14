import { describe, expect, it } from 'vitest'
import { createBuilding, createFloor, createProject } from '../src/domain/project-factory'
import {
  confirmExternalSpaceCandidates,
  makeExternalSpaceCandidateDrafts,
  SpaceCandidateConfirmationError,
} from '../src/inference/space-candidate-workflow'

function emptyProject() {
  const project = createProject({ name: '候选确认测试' })
  const building = createBuilding('A', 'A栋')
  const floor = createFloor({ buildingId: building.id, buildingCode: building.code, level: 1 })
  building.floors.push(floor)
  project.buildings.push(building)
  return { project, floor }
}

function detected(id: string, x = 0) {
  return {
    id,
    polygon: [
      { x, z: 0 },
      { x: x + 4, z: 0 },
      { x: x + 4, z: 3 },
      { x, z: 3 },
    ],
    area: 12,
    confidence: 'inferred-high' as const,
    reasons: ['multi-slice-match'],
  }
}

describe('external SPACE candidate confirmation', () => {
  it('keeps inferred metadata transient and writes only a confirmed SPACE', () => {
    const { project, floor } = emptyProject()
    const [draft] = makeExternalSpaceCandidateDrafts([detected('candidate-a')], 0, floor.id)

    expect(floor.entities).toEqual([])
    expect(draft?.floorId).toBe(floor.id)
    expect(draft?.id).toBe(`${floor.id}:candidate-a`)
    expect(draft?.confidence).toBe('inferred-high')

    draft!.name = '护士站'
    draft!.spaceType = 'OFFICE'
    const result = confirmExternalSpaceCandidates(project, floor.id, [draft!])
    const confirmed = result.project.buildings[0]!.floors[0]!.entities[0]!

    expect(project.buildings[0]!.floors[0]!.entities).toEqual([])
    expect(confirmed).toMatchObject({
      id: result.entityIds[0],
      kind: 'space',
      name: '护士站',
      spaceType: 'OFFICE',
      metadata: {
        confidence: 'confirmed',
        renderType: 'SPACE',
        renderTypeMode: 'manual',
        sidMode: 'auto',
      },
    })
  })

  it('allocates unique SPACE sequences when confirming a batch', () => {
    const { project, floor } = emptyProject()
    const drafts = makeExternalSpaceCandidateDrafts([detected('candidate-a'), detected('candidate-b', 5)], 0, floor.id)
    const result = confirmExternalSpaceCandidates(project, floor.id, drafts)
    const spaces = result.project.buildings[0]!.floors[0]!.entities

    expect(spaces.map((space) => space.metadata.sequence)).toEqual([1, 2])
    expect(new Set(spaces.map((space) => space.metadata.sid)).size).toBe(2)
  })

  it('rejects an invalid polygon without mutating the source project', () => {
    const { project, floor } = emptyProject()
    const [draft] = makeExternalSpaceCandidateDrafts([detected('candidate-a')], 0, floor.id)
    draft!.polygon = [{ x: 0, z: 0 }, { x: 1, z: 0 }]

    expect(() => confirmExternalSpaceCandidates(project, floor.id, [draft!])).toThrow(SpaceCandidateConfirmationError)
    expect(project.buildings[0]!.floors[0]!.entities).toEqual([])
  })

  it('does not duplicate an equivalent SPACE if project state changed after detection', () => {
    const { project, floor } = emptyProject()
    const [draft] = makeExternalSpaceCandidateDrafts([detected('candidate-a')], 0, floor.id)
    const first = confirmExternalSpaceCandidates(project, floor.id, [draft!])

    expect(() => confirmExternalSpaceCandidates(first.project, floor.id, [draft!])).toThrow(/equivalent-space-already-exists/)
    expect(first.project.buildings[0]!.floors[0]!.entities).toHaveLength(1)
  })

  it('rejects material overlap with a confirmed SPACE even when polygons are not equivalent', () => {
    const { project, floor } = emptyProject()
    const [firstDraft] = makeExternalSpaceCandidateDrafts([detected('candidate-a')], 0, floor.id)
    const first = confirmExternalSpaceCandidates(project, floor.id, [firstDraft!])
    const [overlappingDraft] = makeExternalSpaceCandidateDrafts([detected('candidate-b', 1)], 1, floor.id)

    expect(() => confirmExternalSpaceCandidates(first.project, floor.id, [overlappingDraft!])).toThrow(/material-space-overlap/)
    expect(first.project.buildings[0]!.floors[0]!.entities).toHaveLength(1)
  })

  it('fails an overlapping high-confidence batch atomically without adding an extra SPACE', () => {
    const { project, floor } = emptyProject()
    const drafts = makeExternalSpaceCandidateDrafts([
      detected('candidate-a'),
      detected('candidate-b', 1),
    ], 0, floor.id)

    expect(() => confirmExternalSpaceCandidates(project, floor.id, drafts)).toThrow(/material-space-overlap/)
    expect(project.buildings[0]!.floors[0]!.entities).toEqual([])
  })

  it('rejects confirmation into a different floor without changing either floor', () => {
    const { project, floor } = emptyProject()
    const building = project.buildings[0]!
    const otherFloor = createFloor({ buildingId: building.id, buildingCode: building.code, level: 2 })
    building.floors.push(otherFloor)
    const [draft] = makeExternalSpaceCandidateDrafts([detected('candidate-a')], 0, floor.id)

    expect(() => confirmExternalSpaceCandidates(project, otherFloor.id, [draft!])).toThrow(/candidate-floor-mismatch/)
    expect(floor.entities).toEqual([])
    expect(otherFloor.entities).toEqual([])
  })
})
