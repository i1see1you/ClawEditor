/** Parsed Ctrl+G input: jump to one line, or select an inclusive 1-based line range. */
export type GotoLineCommand =
  | { kind: 'goto'; line: number }
  | { kind: 'selectLines'; fromLine: number; toLine: number }

/**
 * Accepts `42` (goto) or `1-100` / `1 - 100` (select lines 1–100 inclusive, 1-based).
 */
export function parseGotoLineInput(raw: string): GotoLineCommand | null {
  const t = raw.trim()
  const range = t.match(/^(\d+)\s*-\s*(\d+)$/)
  if (range) {
    const a = Number.parseInt(range[1], 10)
    const b = Number.parseInt(range[2], 10)
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < 1) return null
    const fromLine = Math.min(a, b)
    const toLine = Math.max(a, b)
    return { kind: 'selectLines', fromLine, toLine }
  }
  const single = t.match(/^(\d+)$/)
  if (single) {
    const line = Number.parseInt(single[1], 10)
    if (!Number.isFinite(line) || line < 1) return null
    return { kind: 'goto', line }
  }
  return null
}
