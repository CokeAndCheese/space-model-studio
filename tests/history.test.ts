import { describe,expect,it } from 'vitest'
import { createDemoProject } from '../src/domain/project-factory'
import { ProjectHistory } from '../src/editor/project-history'

describe('editor project history',()=>{
  it('undoes, redoes and invalidates redo after a new operation',()=>{
    let project=createDemoProject();const history=new ProjectHistory(project)
    const before=structuredClone(project);project.name='Edited';history.record(before)
    project=history.undo(project)!;expect(project.name).toBe('Demo Hospital');expect(history.canRedo).toBe(true)
    project=history.redo(project)!;expect(project.name).toBe('Edited')
    const second=structuredClone(project);project.name='New branch';history.record(second);expect(history.canRedo).toBe(false)
  })
  it('tracks clean revisions',()=>{
    const project=createDemoProject();const history=new ProjectHistory(project);expect(history.isDirty(project)).toBe(false);project.name='Changed';expect(history.isDirty(project)).toBe(true);history.markClean(project);expect(history.isDirty(project)).toBe(false)
  })
})
