import { create } from 'zustand'
import type { EditorView } from '@codemirror/view'

/** Find panel statistics for StatusBar (CodeMirror search). */
export interface FindMatchStatusPayload {
  panelOpen: true
  queryValid: boolean
  total: number
  current: number | null
  capped: boolean
}

interface EditorSelection {
  from: number
  to: number
  text: string
}

let findTransientClearTimer: ReturnType<typeof setTimeout> | null = null

interface EditorState {
  selection: EditorSelection | null
  editorView: EditorView | null
  /** CodeMirror undo stack depth (for toolbar). */
  undoDepth: number
  /** CodeMirror redo stack depth (for toolbar). */
  redoDepth: number
  /** Find panel open + match counts (from CodeMirror search). */
  findMatchStatus: FindMatchStatusPayload | null
  /** Short-lived hint (e.g. find next failed). */
  findTransientMessage: string | null
  setSelection: (from: number, to: number, text: string) => void
  clearSelection: () => void
  setEditorView: (view: EditorView | null) => void
  setHistoryDepth: (undo: number, redo: number) => void
  setFindMatchStatus: (s: FindMatchStatusPayload | null) => void
  clearFindMatchStatus: () => void
  setFindTransientMessage: (msg: string | null) => void
}

export const useEditorStore = create<EditorState>((set) => ({
  selection: null,
  editorView: null,
  undoDepth: 0,
  redoDepth: 0,
  findMatchStatus: null,
  findTransientMessage: null,
  setSelection: (from, to, text) => set({ selection: { from, to, text } }),
  clearSelection: () => set({ selection: null }),
  setEditorView: (view) => set({ editorView: view }),
  setHistoryDepth: (undo, redo) => set({ undoDepth: undo, redoDepth: redo }),
  setFindMatchStatus: (findMatchStatus) => set({ findMatchStatus }),
  clearFindMatchStatus: () => set({ findMatchStatus: null }),
  setFindTransientMessage: (msg) => {
    if (findTransientClearTimer !== null) {
      clearTimeout(findTransientClearTimer)
      findTransientClearTimer = null
    }
    set({ findTransientMessage: msg })
    if (msg) {
      findTransientClearTimer = setTimeout(() => {
        findTransientClearTimer = null
        set({ findTransientMessage: null })
      }, 3500)
    }
  },
}))
