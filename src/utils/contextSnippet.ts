/** 0-based line index containing position `pos` (UTF-16 offset, matches CodeMirror). */
export function lineIndexAtPos(text: string, pos: number): number {
  const p = Math.max(0, Math.min(pos, text.length))
  let line = 0
  for (let i = 0; i < p; i++) {
    if (text.charCodeAt(i) === 10) line++
  }
  return line
}

/**
 * 取光标所在行及其前后若干行，带行号前缀，便于 OpenClaw 理解位置且不发送全文。
 */
export function getContextLinesAroundCursor(
  fileText: string,
  cursorPos: number,
  linesBefore = 10,
  linesAfter = 10
): {
  snippet: string
  startLine1: number
  endLine1: number
  cursorLine1: number
  totalLines: number
} {
  const lines = fileText.split(/\r?\n/)
  const totalLines = Math.max(1, lines.length)
  const line0 = lineIndexAtPos(fileText, cursorPos)
  const cursorLine1 = line0 + 1
  const start0 = Math.max(0, line0 - linesBefore)
  const end0 = Math.min(lines.length - 1, line0 + linesAfter)
  const slice = lines.slice(start0, end0 + 1)
  const w = String(end0 + 1).length
  const numbered = slice.map((line, i) => {
    const n = start0 + i + 1
    return `${String(n).padStart(w, ' ')}|${line}`
  })
  return {
    snippet: numbered.join('\n'),
    startLine1: start0 + 1,
    endLine1: end0 + 1,
    cursorLine1,
    totalLines,
  }
}
