import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { detectExternalSpaceCandidates } from '../src/inference/external-space-candidates'

const filePath = resolve(process.argv[2] ?? '')
if (!process.argv[2]) {
  throw new Error('Usage: npm exec vite-node scripts/detect-external-spaces.ts -- model.glb [cellSize] [gapDistance] [doorPadding] [minArea] [--summary]')
}

const cellSize = Number(process.argv[3] ?? 0.1)
const gapClosingDistance = Number(process.argv[4] ?? 0.1)
const doorPadding = Number(process.argv[5] ?? 0.1)
const minArea = Number(process.argv[6] ?? 2)
const summaryOnly = process.argv.includes('--summary')
const bytes = new Uint8Array(await readFile(filePath))

const startedAt = performance.now()
const result = detectExternalSpaceCandidates(bytes, {
  cellSize,
  gapClosingDistance,
  doorPadding,
  minArea,
})

const report = {
  filePath,
  options: { cellSize, gapClosingDistance, doorPadding, minArea },
  elapsedMs: Math.round(performance.now() - startedAt),
  wallVerticalRange: result.wallVerticalRange,
  sliceHeights: result.sliceHeights,
  stats: result.stats,
  reasons: result.reasons,
  summary: {
    candidates: result.candidates.length,
    highConfidence: result.candidates.filter((candidate) => candidate.confidence === 'inferred-high').length,
    needsReview: result.candidates.filter((candidate) => candidate.confidence === 'inferred-low').length,
  },
  candidates: result.candidates.map((candidate) => ({
    id: candidate.id,
    area: Number(candidate.area.toFixed(2)),
    vertices: candidate.polygon.length,
    confidence: candidate.confidence,
    reasons: candidate.reasons,
    sourceIds: candidate.stats.sourceIds,
  })),
}

console.log(JSON.stringify(summaryOnly
  ? {
      filePath: report.filePath,
      options: report.options,
      elapsedMs: report.elapsedMs,
      wallVerticalRange: report.wallVerticalRange,
      sliceHeights: report.sliceHeights,
      stats: report.stats,
      reasons: report.reasons,
      summary: report.summary,
    }
  : report, null, 2))
