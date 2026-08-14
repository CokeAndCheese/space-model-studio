import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const viewportSource = readFileSync(new URL('../src/components/EditorViewport.vue', import.meta.url), 'utf8')

describe('external GLB viewport rendering', () => {
  it('uses a dedicated high-contrast read-only plan style', () => {
    expect(viewportSource).toContain('externalPlanColors')
    expect(viewportSource).toContain("renderType === 'CEILING' ? 0.16 : 0.88")
    expect(viewportSource).toContain('EdgesGeometry')
    expect(viewportSource).toContain('applyExternalViewMode()')
  })

  it('does not hide large external models behind the fixed native-scene fog', () => {
    expect(viewportSource).toContain('scene.fog = plan && externalModel.children.length === 0')
    expect(viewportSource).toContain(': null')
  })

  it('draws newly added SPACE above the read-only external plan in 2D', () => {
    expect(viewportSource).toContain('function applySpaceViewMode')
    expect(viewportSource).toContain("mesh.renderOrder = plan ? 65 : 0")
    expect(viewportSource).toContain('current.depthTest = !plan')
    expect(viewportSource).toContain('applyDomainViewMode()')
  })

  it('renders transient inferred candidates separately and exposes candidate picking', () => {
    expect(viewportSource).toContain('spaceCandidates?: SpaceCandidatePreview[]')
    expect(viewportSource).toContain('let candidateSpaces = new THREE.Group()')
    expect(viewportSource).toContain('function rebuildCandidates()')
    expect(viewportSource).toContain("'candidate-select': [id: string, additive?: boolean]")
    expect(viewportSource).toContain("'candidate-selection': [payload: ViewportSelectionPayload]")
    expect(viewportSource).toContain('selectedCandidateIds?: string[]')
    expect(viewportSource).toContain('props.selectedCandidateIds?.includes(candidate.id)')
    expect(viewportSource).toContain('function projectCandidateBounds()')
    expect(viewportSource).toContain("selection.operation === 'merge' && (props.selectedCandidateIds?.length ?? 0) > 0")
    expect(viewportSource).toContain("emit('candidate-selection', candidatePayload)")
    expect(viewportSource).toContain("candidate.confidence === 'high'")
    expect(viewportSource).toContain('disposeObjectResources(candidateSpaces)')
    expect(viewportSource).toContain('new THREE.LineLoop(')
    expect(viewportSource).toContain('new THREE.BufferGeometry().setFromPoints(')
    expect(viewportSource).toContain('candidate.polygon.map((point) => new THREE.Vector3(point.x, 0, point.z))')
  })

  it('emits structured lifecycle and camera diagnostics', () => {
    expect(viewportSource).toContain('[SpaceModelStudio][ExternalGLB]')
    expect(viewportSource).toContain('load:start')
    expect(viewportSource).toContain('load:success')
    expect(viewportSource).toContain('view:fit')
    expect(viewportSource).toContain('view:mode')
    expect(viewportSource).toContain('load:error')
  })

  it('releases app-owned domain and grid resources when the viewport unmounts', () => {
    expect(viewportSource).toContain('disposeObjectResources(objects)')
    expect(viewportSource).toContain('disposeObjectResources(grid)')
    expect(viewportSource).toContain('scene?.remove(objects)')
    expect(viewportSource).toContain('scene?.remove(grid)')
  })
})
