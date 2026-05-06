import { EditorState, Prec, type Extension } from '@codemirror/state'
import {
  findNext,
  findPrevious,
  getSearchQuery,
  searchPanelOpen,
} from '@codemirror/search'
import { EditorView, ViewPlugin, ViewUpdate, keymap } from '@codemirror/view'
import { useEditorStore, type FindMatchStatusPayload } from '../store/editorStore'

/** Stop counting here; show as `${MATCH_COUNT_CAP}+`. */
const MATCH_COUNT_CAP = 5000

function computeMatchStatus(state: EditorState): FindMatchStatusPayload | null {
  if (!searchPanelOpen(state)) return null

  const query = getSearchQuery(state)
  if (!query.valid) {
    return {
      panelOpen: true,
      queryValid: false,
      total: 0,
      current: null,
      capped: false,
    }
  }

  const sel = state.selection.main
  let idx = 0
  let current: number | null = null
  let capped = false

  const cursor = query.getCursor(state, 0, state.doc.length)
  for (;;) {
    const step = cursor.next()
    if (step.done) break
    const v = step.value
    idx++
    if (!sel.empty && v.from === sel.from && v.to === sel.to) {
      current = idx
    }
    if (idx >= MATCH_COUNT_CAP) {
      const peek = cursor.next()
      if (!peek.done) capped = true
      break
    }
  }

  if (capped && !sel.empty && current === null) {
    let j = 0
    const c2 = query.getCursor(state, 0, state.doc.length)
    for (;;) {
      const step = c2.next()
      if (step.done) break
      const v = step.value
      j++
      if (v.from === sel.from && v.to === sel.to) {
        current = j
        break
      }
    }
  }

  return {
    panelOpen: true,
    queryValid: true,
    total: capped ? MATCH_COUNT_CAP : idx,
    current,
    capped,
  }
}

/** Push latest counts to the store (also used after `/find` so the bar updates immediately). */
export function flushSearchMatchStatus(view: EditorView) {
  const next = computeMatchStatus(view.state)
  if (!next) {
    useEditorStore.getState().clearFindMatchStatus()
    return
  }
  useEditorStore.getState().setFindMatchStatus(next)
}

const searchMatchStatusPlugin = ViewPlugin.fromClass(
  class {
    debounce: ReturnType<typeof setTimeout> | null = null

    constructor(readonly view: EditorView) {
      this.schedule()
    }

    update(u: ViewUpdate) {
      if (!searchPanelOpen(u.state)) {
        this.clearDebounce()
        useEditorStore.getState().clearFindMatchStatus()
        return
      }
      this.schedule()
    }

    destroy() {
      this.clearDebounce()
      useEditorStore.getState().clearFindMatchStatus()
    }

    clearDebounce() {
      if (this.debounce !== null) {
        clearTimeout(this.debounce)
        this.debounce = null
      }
    }

    schedule() {
      this.clearDebounce()
      this.debounce = window.setTimeout(() => {
        this.debounce = null
        flushSearchMatchStatus(this.view)
      }, 100)
    }
  }
)

function notifyNoMatch() {
  useEditorStore.getState().setFindTransientMessage('未找到匹配')
}

/** Find next when panel is open; transient message if none. */
export function runFindNextWithFeedback(view: EditorView): boolean {
  if (!searchPanelOpen(view.state)) return false
  const ok = findNext(view)
  if (!ok) notifyNoMatch()
  return ok
}

export function runFindPreviousWithFeedback(view: EditorView): boolean {
  if (!searchPanelOpen(view.state)) return false
  const ok = findPrevious(view)
  if (!ok) notifyNoMatch()
  return ok
}

/** Higher prec than default search keymap; runs when panel open from editor focus. */
const findFeedbackKeymap = keymap.of([
  {
    key: 'Mod-g',
    run: (view) => {
      if (!searchPanelOpen(view.state)) return false
      runFindNextWithFeedback(view)
      return true
    },
    preventDefault: true,
  },
  {
    key: 'Shift-Mod-g',
    run: (view) => {
      if (!searchPanelOpen(view.state)) return false
      runFindPreviousWithFeedback(view)
      return true
    },
    preventDefault: true,
  },
  {
    key: 'F3',
    run: (view) => {
      if (!searchPanelOpen(view.state)) return false
      runFindNextWithFeedback(view)
      return true
    },
    preventDefault: true,
  },
  {
    key: 'Shift-F3',
    run: (view) => {
      if (!searchPanelOpen(view.state)) return false
      runFindPreviousWithFeedback(view)
      return true
    },
    preventDefault: true,
  },
])

export function searchMatchStatusExtensions(): Extension[] {
  return [searchMatchStatusPlugin, Prec.high(findFeedbackKeymap)]
}
