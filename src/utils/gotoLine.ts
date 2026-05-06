import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/** Move cursor to 1-based line number and scroll into view. */
export function gotoLineInEditor(view: EditorView, line: number): boolean {
  const doc = view.state.doc
  const n = Math.min(Math.max(1, Math.floor(line)), doc.lines)
  try {
    const pos = doc.line(n).from
    view.dispatch({
      selection: EditorSelection.cursor(pos),
      scrollIntoView: true,
    })
    view.focus()
    return true
  } catch {
    return false
  }
}

/**
 * Select document range from start of `fromLine1` through end of `toLine1` (inclusive, 1-based).
 * Lines are clamped to the document.
 */
export function selectLineRangeInEditor(
  view: EditorView,
  fromLine1: number,
  toLine1: number
): boolean {
  const doc = view.state.doc
  const nLines = doc.lines
  const lo = Math.min(Math.max(1, Math.floor(fromLine1)), nLines)
  const hi = Math.min(Math.max(1, Math.floor(toLine1)), nLines)
  const a = Math.min(lo, hi)
  const b = Math.max(lo, hi)
  try {
    const from = doc.line(a).from
    const to = doc.line(b).to
    view.dispatch({
      selection: EditorSelection.single(from, to),
      scrollIntoView: true,
    })
    view.focus()
    return true
  } catch {
    return false
  }
}
