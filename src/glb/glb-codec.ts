import {
  GLB_BIN_CHUNK_TYPE,
  GLB_JSON_CHUNK_TYPE,
  GLB_MAGIC,
  GLB_VERSION,
  type GlbChunk,
  type GlbJson,
  type ParsedGlb,
} from './types'

const HEADER_BYTES = 12
const CHUNK_HEADER_BYTES = 8

export class GlbParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GlbParseError'
  }
}

function padToFour(value: number) {
  return (value + 3) & ~3
}

function asBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input)
}

/** Pack glTF JSON and its binary buffer into a standards-compliant GLB 2.0 file. */
export function encodeGlb(json: GlbJson, binary: Uint8Array = new Uint8Array()): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const paddedJsonLength = padToFour(jsonBytes.byteLength)
  const paddedBinLength = padToFour(binary.byteLength)
  const hasBinary = binary.byteLength > 0
  const totalLength = HEADER_BYTES
    + CHUNK_HEADER_BYTES
    + paddedJsonLength
    + (hasBinary ? CHUNK_HEADER_BYTES + paddedBinLength : 0)

  const output = new Uint8Array(totalLength)
  const view = new DataView(output.buffer)
  view.setUint32(0, GLB_MAGIC, true)
  view.setUint32(4, GLB_VERSION, true)
  view.setUint32(8, totalLength, true)

  let offset = HEADER_BYTES
  view.setUint32(offset, paddedJsonLength, true)
  view.setUint32(offset + 4, GLB_JSON_CHUNK_TYPE, true)
  offset += CHUNK_HEADER_BYTES
  output.set(jsonBytes, offset)
  output.fill(0x20, offset + jsonBytes.byteLength, offset + paddedJsonLength)
  offset += paddedJsonLength

  if (hasBinary) {
    view.setUint32(offset, paddedBinLength, true)
    view.setUint32(offset + 4, GLB_BIN_CHUNK_TYPE, true)
    offset += CHUNK_HEADER_BYTES
    output.set(binary, offset)
  }

  return output
}

/** Strictly parse the GLB container. glTF graph validation is handled separately. */
export function parseGlb(input: ArrayBuffer | Uint8Array): ParsedGlb {
  const bytes = asBytes(input)
  if (bytes.byteLength < HEADER_BYTES) {
    throw new GlbParseError(`GLB is ${bytes.byteLength} bytes; the 12-byte header is missing`)
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = view.getUint32(0, true)
  const version = view.getUint32(4, true)
  const totalLength = view.getUint32(8, true)
  if (magic !== GLB_MAGIC) throw new GlbParseError('GLB magic must be "glTF"')
  if (version !== GLB_VERSION) throw new GlbParseError(`Unsupported GLB version ${version}; expected 2`)
  if (totalLength !== bytes.byteLength) {
    throw new GlbParseError(`Header length ${totalLength} does not equal actual length ${bytes.byteLength}`)
  }

  const chunks: GlbChunk[] = []
  let offset = HEADER_BYTES
  while (offset < totalLength) {
    if (offset + CHUNK_HEADER_BYTES > totalLength) {
      throw new GlbParseError(`Truncated chunk header at byte ${offset}`)
    }
    const byteLength = view.getUint32(offset, true)
    const type = view.getUint32(offset + 4, true)
    if (byteLength % 4 !== 0) {
      throw new GlbParseError(`Chunk at byte ${offset} is not 4-byte aligned`)
    }
    const dataOffset = offset + CHUNK_HEADER_BYTES
    const end = dataOffset + byteLength
    if (end > totalLength) throw new GlbParseError(`Chunk at byte ${offset} exceeds GLB bounds`)
    chunks.push({
      type,
      byteLength,
      byteOffset: dataOffset,
      data: bytes.slice(dataOffset, end),
    })
    offset = end
  }

  if (chunks.length === 0) throw new GlbParseError('GLB does not contain a JSON chunk')
  if (chunks[0]!.type !== GLB_JSON_CHUNK_TYPE) {
    throw new GlbParseError('The first GLB chunk must be JSON')
  }
  const jsonChunks = chunks.filter((chunk) => chunk.type === GLB_JSON_CHUNK_TYPE)
  if (jsonChunks.length !== 1) throw new GlbParseError('GLB must contain exactly one JSON chunk')
  const binChunks = chunks.filter((chunk) => chunk.type === GLB_BIN_CHUNK_TYPE)
  if (binChunks.length > 1) throw new GlbParseError('GLB may contain at most one BIN chunk')

  const jsonChunk = jsonChunks[0]!
  let json: GlbJson
  try {
    const source = new TextDecoder('utf-8', { fatal: true })
      .decode(jsonChunk.data)
      .replace(/[\u0000\u0020\t\r\n]+$/u, '')
    json = JSON.parse(source) as GlbJson
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new GlbParseError(`Invalid GLB JSON chunk: ${detail}`)
  }

  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new GlbParseError('GLB JSON root must be an object')
  }

  return {
    header: { magic, version, totalLength },
    chunks,
    jsonChunk,
    binChunk: binChunks[0],
    json,
  }
}
