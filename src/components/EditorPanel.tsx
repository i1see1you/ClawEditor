import { useEffect, useMemo } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { xml } from '@codemirror/lang-xml'
import { Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { undoDepth, redoDepth } from '@codemirror/commands'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { searchMatchStatusExtensions } from '../editor/searchMatchStatus'
import { useFileStore } from '../store/fileStore'
import { useEditorStore } from '../store/editorStore'
import type { FileTab } from '../types'
import { PreviewPanel } from './PreviewPanel'

interface EditorPanelProps {
  file: FileTab
  showPreview?: boolean
}

const langMap: Record<string, () => Extension[]> = {
  javascript: () => [javascript()],
  typescript: () => [javascript({ typescript: true })],
  python: () => [python()],
  html: () => [html()],
  css: () => [css()],
  json: () => [json()],
  markdown: () => [markdown()],
  xml: () => [xml()],
}

export function EditorPanel({ file, showPreview = false }: EditorPanelProps) {
  const updateContent = useFileStore((s) => s.updateContent)
  const markModified = useFileStore((s) => s.markModified)

  const onChange = (value: string) => {
    updateContent(file.id, value)
    markModified(file.id, true)
  }

  const selectionExt = useMemo(
    () =>
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          const sel = update.state.selection.main
          const text = update.state.doc.sliceString(sel.from, sel.to)
          useEditorStore.getState().setSelection(sel.from, sel.to, text)
        }
      }),
    []
  )

  const searchExts = useMemo(
    () => [
      search(),
      highlightSelectionMatches(),
      keymap.of(searchKeymap),
      ...searchMatchStatusExtensions(),
    ],
    []
  )

  const historyDepthExt = useMemo(
    () =>
      EditorView.updateListener.of((update) => {
        const s = update.state
        useEditorStore.getState().setHistoryDepth(undoDepth(s), redoDepth(s))
      }),
    []
  )

  useEffect(() => {
    return () => {
      useEditorStore.getState().setEditorView(null)
      useEditorStore.getState().setHistoryDepth(0, 0)
    }
  }, [])

  const extensions = useMemo(() => {
    const lang = langMap[file.language]
    const langExts = lang ? lang() : []
    return [...langExts, selectionExt, historyDepthExt, ...searchExts]
  }, [file.language, selectionExt, historyDepthExt, searchExts])

  const isDark = typeof window !== 'undefined' &&
    document.documentElement.getAttribute('data-theme') !== 'light'

  const canPreview = file.language === 'markdown' || file.language === 'html'
  const shouldShowPreview = canPreview && showPreview

  return (
    <div className={`editor-panel ${shouldShowPreview ? 'split' : ''}`}>
      <div className="editor-pane">
        <CodeMirror
          value={typeof file.content === 'string' ? file.content : ''}
          height="100%"
          extensions={extensions}
          onChange={onChange}
          onCreateEditor={(view) => {
            useEditorStore.getState().setEditorView(view)
          }}
          theme={isDark ? 'dark' : 'light'}
          style={{ height: '100%', fontSize: '14px' }}
        />
      </div>
      {shouldShowPreview ? <PreviewPanel file={file} /> : null}
    </div>
  )
}