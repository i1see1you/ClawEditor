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
