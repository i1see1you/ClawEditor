/**
 * Line-aligned side-by-side diff helpers for interactive partial apply
 * (e.g. /aicorrect proposals where before/after must keep the same newline structure).
 */

export type SideBySideRow = {
  /** 0-based index in the aligned line array */
  lineIndex: number
  left: string
  right: string
  changed: boolean
}

export function splitLinesPreserve(text: string): string[] {
  if (!text) return ['']
  return text.split('\n')
}

export function buildSideBySideRows(
  before: string,
  after: string
): { rows: SideBySideRow[]; lineAligned: boolean } {
  const leftLines = splitLinesPreserve(before)
  const rightLines = splitLinesPreserve(after)
  const lineAligned = leftLines.length === rightLines.length
  const n = Math.max(leftLines.length, rightLines.length)
  const rows: SideBySideRow[] = []
  for (let i = 0; i < n; i++) {
    const l = i < leftLines.length ? leftLines[i]! : ''
    const r = i < rightLines.length ? rightLines[i]! : ''
    rows.push({
      lineIndex: i,
      left: l,
      right: r,
      changed: l !== r,
    })
  }
  return { rows, lineAligned }
}

/**
 * For each line index i: use `after` line if i is in adoptedLineIndices, else `before` line.
 * When lineAligned is false, callers should not use this result for partial apply.
 */
export function mergeLinesByAdoption(
  before: string,
  after: string,
  adoptedLineIndices: ReadonlySet<number>,
  lineAligned: boolean
): { ok: true; text: string } | { ok: false; message: string } {
  if (!lineAligned) {
    return { ok: false, message: '行数不一致，无法按行合并。' }
  }
  const leftLines = splitLinesPreserve(before)
  const rightLines = splitLinesPreserve(after)
  const out = leftLines.map((l, i) =>
    adoptedLineIndices.has(i) ? (rightLines[i] ?? '') : l
  )
  return { ok: true, text: out.join('\n') }
}
