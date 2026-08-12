import type { Project } from './contract'
import { cloneProject } from './project-serializer'

export interface ProjectCommand {
  readonly label: string
  apply(project: Project): Project
}

interface HistoryEntry {
  command: ProjectCommand
  before: Project
  after: Project
  beforeRevision: number
  afterRevision: number
}

export function createProjectCommand(label: string, apply: (project: Project) => Project): ProjectCommand {
  return { label, apply }
}

/** Snapshot-backed command history. Domain objects remain small enough for a Demo. */
export class CommandStack {
  private state: Project
  private readonly undoEntries: HistoryEntry[] = []
  private readonly redoEntries: HistoryEntry[] = []
  private revisionCounter = 0
  private currentRevision = 0
  private cleanRevision = 0

  constructor(initialProject: Project, readonly maxHistory = 100) {
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new Error('maxHistory 必须是正整数')
    this.state = cloneProject(initialProject)
  }

  get project(): Project {
    return cloneProject(this.state)
  }

  get canUndo(): boolean {
    return this.undoEntries.length > 0
  }

  get canRedo(): boolean {
    return this.redoEntries.length > 0
  }

  get isDirty(): boolean {
    return this.currentRevision !== this.cleanRevision
  }

  get revision(): number {
    return this.currentRevision
  }

  get undoLabel(): string | undefined {
    return this.undoEntries.at(-1)?.command.label
  }

  get redoLabel(): string | undefined {
    return this.redoEntries.at(-1)?.command.label
  }

  execute(command: ProjectCommand): Project {
    const before = cloneProject(this.state)
    const after = cloneProject(command.apply(before))
    const beforeRevision = this.currentRevision
    const afterRevision = ++this.revisionCounter
    this.undoEntries.push({ command, before, after, beforeRevision, afterRevision })
    if (this.undoEntries.length > this.maxHistory) this.undoEntries.splice(0, this.undoEntries.length - this.maxHistory)
    this.redoEntries.length = 0
    this.state = after
    this.currentRevision = afterRevision
    return this.project
  }

  undo(): Project {
    const entry = this.undoEntries.pop()
    if (!entry) return this.project
    this.redoEntries.push(entry)
    this.state = cloneProject(entry.before)
    this.currentRevision = entry.beforeRevision
    return this.project
  }

  redo(): Project {
    const entry = this.redoEntries.pop()
    if (!entry) return this.project
    this.undoEntries.push(entry)
    this.state = cloneProject(entry.after)
    this.currentRevision = entry.afterRevision
    return this.project
  }

  markClean(): void {
    this.cleanRevision = this.currentRevision
  }

  /** Replace after opening a project; open is a new clean history root. */
  reset(project: Project): Project {
    this.state = cloneProject(project)
    this.undoEntries.length = 0
    this.redoEntries.length = 0
    this.currentRevision = ++this.revisionCounter
    this.cleanRevision = this.currentRevision
    return this.project
  }
}
