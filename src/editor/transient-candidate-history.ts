export interface TransientCandidateState<T> {
  candidates: T[]
  selectedCandidateIds: string[]
  selectedEntityIds: string[]
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** Keeps transient review state aligned with the persisted Project undo stack. */
export class TransientCandidateHistory<T> {
  private past: TransientCandidateState<T>[] = []
  private future: TransientCandidateState<T>[] = []

  constructor(private readonly limit = 100) {}

  record(before: TransientCandidateState<T>): void {
    this.past.push(clone(before))
    if (this.past.length > this.limit) this.past.shift()
    this.future = []
  }

  undo(current: TransientCandidateState<T>): TransientCandidateState<T> | undefined {
    const previous = this.past.pop()
    if (!previous) return undefined
    this.future.push(clone(current))
    return previous
  }

  redo(current: TransientCandidateState<T>): TransientCandidateState<T> | undefined {
    const next = this.future.pop()
    if (!next) return undefined
    this.past.push(clone(current))
    return next
  }

  reset(): void {
    this.past = []
    this.future = []
  }
}
