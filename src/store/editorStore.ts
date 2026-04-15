import { create } from 'zustand'
import type { EditorView } from '@codemirror/view'

interface EditorSelection {
  from: number
  to: number
  text: string
}

interface EditorState {
  selection: EditorSelection | null
  editorView: EditorView | null
  /** CodeMirror undo stack depth (for toolbar). */
  undoDepth: number
  /** CodeMirror redo stack depth (for toolbar). */
  redoDepth: number
  setSelection: (from: number, to: number, text: string) => void
  clearSelection: () => void
  setEditorView: (view: EditorView | null) => void
  setHistoryDepth: (undo: number, redo: number) => void
}

export const useEditorStore = create<EditorState>((set) => ({
  selection: null,
  editorView: null,
  undoDepth: 0,
  redoDepth: 0,
  setSelection: (from, to, text) => set({ selection: { from, to, text } }),
  clearSelection: () => set({ selection: null }),
  setEditorView: (view) => set({ editorView: view }),
  setHistoryDepth: (undo, redo) => set({ undoDepth: undo, redoDepth: redo }),
}))
