/** Shared little-endian mesh packing used by native and append-only exporters. */
export function float32Bytes(values: readonly number[]) {
  const output = new Uint8Array(values.length * 4)
  const view = new DataView(output.buffer)
  values.forEach((value, index) => view.setFloat32(index * 4, value, true))
  return output
}

export function indexBytes(values: readonly number[], useUint32: boolean) {
  const componentBytes = useUint32 ? 4 : 2
  const output = new Uint8Array(values.length * componentBytes)
  const view = new DataView(output.buffer)
  values.forEach((value, index) => {
    if (useUint32) view.setUint32(index * componentBytes, value, true)
    else view.setUint16(index * componentBytes, value, true)
  })
  return output
}

export function positionBounds(positions: readonly number[]) {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis]!
      min[axis] = Math.min(min[axis]!, value)
      max[axis] = Math.max(max[axis]!, value)
    }
  }
  return { min, max }
}
