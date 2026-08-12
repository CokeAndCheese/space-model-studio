import type { RenderType } from '../domain/contract'
import type { GlbJson } from '../glb/types'

export interface ExternalGlbNodeSummary {
  nodeIndex: number
  meshIndex: number
  name: string
  sid: string
  findId: string
  renderType: RenderType
  renderTypeConfidence: 'high' | 'low'
  spaceType?: string
  fireType?: string
}

export function listExternalGlbNodes(json: GlbJson): ExternalGlbNodeSummary[] {
  const output: ExternalGlbNodeSummary[] = []
  for (const [nodeIndex, node] of (json.nodes ?? []).entries()) {
    if (node.mesh === undefined) continue
    const extras = node.extras
    if (!extras) continue
    if (
      typeof extras.sid !== 'string'
      || typeof extras.findId !== 'string'
      || typeof extras.renderType !== 'string'
      || (extras.renderTypeConfidence !== 'high' && extras.renderTypeConfidence !== 'low')
    ) continue
    output.push({
      nodeIndex,
      meshIndex: node.mesh,
      name: node.name || extras.sid,
      sid: extras.sid,
      findId: extras.findId,
      renderType: extras.renderType as RenderType,
      renderTypeConfidence: extras.renderTypeConfidence,
      spaceType: typeof extras.spaceType === 'string' ? extras.spaceType : undefined,
      fireType: typeof extras.fireType === 'string' ? extras.fireType : undefined,
    })
  }
  return output
}
