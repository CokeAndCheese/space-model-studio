import { describe, expect, it } from 'vitest'
import { TransientCandidateHistory } from '../src/editor/transient-candidate-history'

type Candidate = { id: string; name: string }

describe('transient candidate history', () => {
  it('restores reviewed candidates on undo and removes them again on redo', () => {
    const history = new TransientCandidateHistory<Candidate>()
    const reviewed = {
      candidates: [{ id: 'candidate-a', name: '人工命名' }, { id: 'candidate-b', name: 'B' }],
      selectedCandidateIds: ['candidate-a', 'candidate-b'],
      selectedEntityIds: [],
    }
    const confirmed = {
      candidates: [] as Candidate[],
      selectedCandidateIds: [] as string[],
      selectedEntityIds: ['space-a', 'space-b'],
    }

    history.record(reviewed)
    expect(history.undo(confirmed)).toEqual(reviewed)
    expect(history.redo(reviewed)).toEqual(confirmed)
  })

  it('clears redo after a new project mutation and clones snapshots', () => {
    const history = new TransientCandidateHistory<Candidate>()
    const first = { candidates: [{ id: 'candidate-a', name: 'A' }], selectedCandidateIds: ['candidate-a'], selectedEntityIds: [] }
    history.record(first)
    first.candidates[0]!.name = 'mutated after record'
    first.selectedCandidateIds.push('candidate-b')
    expect(history.undo({ candidates: [], selectedCandidateIds: [], selectedEntityIds: ['space-a'] })).toMatchObject({
      candidates: [{ name: 'A' }],
      selectedCandidateIds: ['candidate-a'],
    })

    history.record({ candidates: [{ id: 'candidate-b', name: 'B' }], selectedCandidateIds: ['candidate-b'], selectedEntityIds: [] })
    expect(history.redo({ candidates: [], selectedCandidateIds: [], selectedEntityIds: [] })).toBeUndefined()
    history.reset()
    expect(history.undo({ candidates: [], selectedCandidateIds: [], selectedEntityIds: [] })).toBeUndefined()
  })
})
