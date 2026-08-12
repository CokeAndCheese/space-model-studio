import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')

describe('project tree hierarchy selection wiring', () => {
  it('wires every tree level to an explicit selection path', () => {
    expect(appSource).toContain('@click="selectProjectNode"')
    expect(appSource).toContain('@click="selectBuildingNode(b.id)"')
    expect(appSource).toContain('@click="setFloor(f.id,b.id)"')
    expect(appSource).toContain('@click="selectEntity(e.id,$event.shiftKey)"')
  })

  it('keeps entity context deletion and viewport multi-selection connected', () => {
    expect(appSource).toContain('@contextmenu.prevent.stop="openEntityContextMenu($event,e)"')
    expect(appSource).toContain(':selected-ids="selectedIds"')
    expect(appSource).toContain('@selection="applyViewportSelection"')
  })

  it('renders type-specific inspectors instead of treating hierarchy nodes as entities', () => {
    expect(appSource).toContain("v-else-if=\"treeSelection.type==='project'\"")
    expect(appSource).toContain('v-else-if="inspectedBuilding"')
    expect(appSource).toContain('v-else-if="inspectedFloor"')
  })

  it('routes keyboard, viewport and hierarchy context deletion through the current selection', () => {
    expect(appSource).toContain('shouldHandleDeleteShortcut(event)')
    expect(appSource).toContain('@selection-context="openViewportSelectionContextMenu"')
    expect(appSource).toContain("openHierarchyContextMenu($event,{type:'project',id:project.projectId})")
    expect(appSource).toContain("openHierarchyContextMenu($event,{type:'building',id:b.id})")
    expect(appSource).toContain("openHierarchyContextMenu($event,{type:'floor',id:f.id})")
    expect(appSource).toContain('@click="removeCurrentSelection"')
  })
})
