import type { Project } from '../domain/contract'

// Vue wraps the active project in a Proxy, which structuredClone cannot copy.
// The persisted project contract is JSON-only, so this also mirrors save/open semantics.
const clone = <T>(value:T):T => JSON.parse(JSON.stringify(value)) as T

export class ProjectHistory {
  private past:Project[]=[]
  private future:Project[]=[]
  private clean=''
  constructor(initial:Project,private readonly limit=100){this.clean=JSON.stringify(initial)}
  record(before:Project){this.past.push(clone(before));if(this.past.length>this.limit)this.past.shift();this.future=[]}
  undo(current:Project){const previous=this.past.pop();if(!previous)return;this.future.push(clone(current));return previous}
  redo(current:Project){const next=this.future.pop();if(!next)return;this.past.push(clone(current));return next}
  reset(project:Project){this.past=[];this.future=[];this.clean=JSON.stringify(project)}
  markClean(project:Project){this.clean=JSON.stringify(project)}
  isDirty(project:Project){return JSON.stringify(project)!==this.clean}
  get canUndo(){return this.past.length>0}
  get canRedo(){return this.future.length>0}
}
