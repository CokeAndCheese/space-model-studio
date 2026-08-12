import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')

describe('MVP editor wiring', () => {
  it('keeps the standalone injector and adds the Studio GLB SPACE workspace', () => {
    expect(appSource).toContain('GLB模型数据注入')
    expect(appSource).toContain('navigateToGlbInjection')
    expect(appSource).toContain('resolveGlbInjectionUrl')
    expect(appSource).toContain('GLB 模型数据注入服务未启动，请在项目目录运行 npm run injector')
    expect(appSource).toContain('ref="glbInput"')
    expect(appSource).toContain('function importGlb')
    expect(appSource).toContain('原 GLB 节点（只读）')
    expect(appSource).toContain('selectedExternalNode')
    expect(appSource).toContain('@external-load-error')
    expect(appSource).toContain('externalWorkspace')
    expect(appSource).toContain('导入 GLB 补空间')
  })

  it('exposes useful hierarchy context actions and confirms destructive cascades', () => {
    expect(appSource).toContain('getTreeContextActions')
    expect(appSource).toContain('runContextAction(action.id)')
    expect(appSource).toContain('buildHierarchyDeletionImpact')
    expect(appSource).toContain("title:'删除墙体及宿主门窗？'")
    expect(appSource).toContain('class="confirmation-backdrop"')
  })

  it('connects viewport safety, continuous wall drawing and real snap state', () => {
    expect(appSource).toContain(':snap-enabled="project.settings.snapEnabled"')
    expect(appSource).toContain(':wall-height="floor.clearHeight"')
    expect(appSource).toContain(':wall-thickness="0.2"')
    expect(appSource).not.toContain("tool.value='选择'")
    expect(appSource).not.toContain('@exit-tool=')
    expect(appSource).toContain('polygon:payload.polygon')
    expect(appSource).toContain('@wall-rejected=')
    expect(appSource).toContain('cancelViewportInteraction()')
  })

  it('guards locked edits, repairs stale editor ids, and protects dirty replacement flows', () => {
    expect(appSource).toContain(':disabled="selected.locked"')
    expect(appSource).toContain('normalizeEditorState')
    expect(appSource).toContain('guardUnsaved')
    expect(appSource).toContain("secondaryLabel:'放弃修改'")
  })
})
