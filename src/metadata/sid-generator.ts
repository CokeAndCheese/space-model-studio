import {
  FIRE_TYPES,
  SPACE_TYPES,
  type Direction,
  type Entity,
  type FireType,
  type Floor,
  type RenderType,
  type SpaceType,
} from '../domain/contract'

export interface GenerateSidInput {
  renderType: RenderType
  floorName: string
  direction?: Direction
  sequence: number
  spaceType?: SpaceType | string
  fireType?: FireType | string
  sub?: string
}

export function formatSequence(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error('SID sequence 必须是从 1 开始的整数')
  return String(sequence).padStart(2, '0')
}

function assertFloorName(floorName: string): void {
  if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(floorName)) throw new Error(`非法 floorName: ${floorName}`)
}

export function generateSid(input: GenerateSidInput): string {
  assertFloorName(input.floorName)
  const sequence = formatSequence(input.sequence)

  if (input.renderType === 'CEILING') {
    const sub = input.sub?.toUpperCase()
    if (sub === 'LOWER' || sub === 'UPPER' || /^SLAB_[0-9]+$/.test(sub ?? '')) {
      return `CEILING_${input.floorName}_${sub}`
    }
    return `CEILING_${input.floorName}_SLAB_${sequence}`
  }

  if (input.renderType === 'FACILITY') {
    if (!input.fireType || !FIRE_TYPES.includes(input.fireType as FireType)) throw new Error('FACILITY SID 必须包含合法 fireType')
    return `FACILITY_${input.floorName}_${input.fireType}_${sequence}`
  }

  if (input.renderType === 'SPACE') {
    if (!input.spaceType || !SPACE_TYPES.includes(input.spaceType as SpaceType)) throw new Error('SPACE SID 必须包含合法 spaceType')
    return `SPACE_${input.floorName}_${input.spaceType}_${sequence}`
  }

  if (input.renderType === 'WALL') return `WALL_${input.floorName}_${sequence}`

  if (!input.direction) throw new Error(`${input.renderType} SID 必须包含方位`)
  return `${input.renderType}_${input.floorName}_${input.direction}_${sequence}`
}

export function generateEntitySid(entity: Entity, floor: Pick<Floor, 'floorName'>): string {
  if (entity.metadata.sidMode === 'manual') {
    const manual = entity.metadata.manualSid ?? entity.metadata.sid
    if (!manual) throw new Error(`实体 ${entity.id} 处于人工 SID 模式但没有 manualSid`)
    return manual
  }
  return generateSid({
    renderType: entity.metadata.renderType,
    floorName: floor.floorName,
    direction: entity.metadata.direction,
    sequence: entity.metadata.sequence,
    spaceType: entity.kind === 'space' ? entity.spaceType : undefined,
    fireType: entity.kind === 'facility' ? entity.fireType : undefined,
    sub: entity.metadata.sub,
  })
}

export function sidGroupKey(entity: Entity): string {
  if (entity.kind === 'facility') return `FACILITY:${entity.fireType}`
  if (entity.kind === 'space') return `SPACE:${entity.spaceType}`
  if (entity.kind === 'slab' || entity.kind === 'ceiling') return `CEILING:${entity.metadata.sub ?? 'SLAB'}`
  if (entity.kind === 'wall') return 'WALL'
  return `${entity.metadata.renderType}:${entity.metadata.direction ?? '?'}`
}

/** Uses max+1 so deletion never immediately recycles a previously issued SID. */
export function allocateNextSequence(floor: Floor, prototype: Entity): number {
  const group = sidGroupKey(prototype)
  let maximum = 0
  for (const entity of floor.entities) {
    if (sidGroupKey(entity) === group) maximum = Math.max(maximum, entity.metadata.sequence)
  }
  return maximum + 1
}

export function collectSidDuplicates(floors: readonly Floor[]): Map<string, string[]> {
  const occurrences = new Map<string, string[]>()
  for (const floor of floors) {
    for (const entity of floor.entities) {
      try {
        const sid = generateEntitySid(entity, floor)
        const ids = occurrences.get(sid) ?? []
        ids.push(entity.id)
        occurrences.set(sid, ids)
      } catch {
        // Invalid/missing SIDs are reported by metadata validation, not duplicate collection.
      }
    }
  }
  return new Map([...occurrences].filter(([, ids]) => ids.length > 1))
}
