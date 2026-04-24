import { useState, useEffect, useCallback } from 'react'
import { readTextFile } from '@tauri-apps/plugin-fs'
import { useFileStore } from './store/fileStore'
import { TabBar } from './components/TabBar'
import { EditorPanel } from './components/EditorPanel'
import { PdfViewer } from './components/PdfViewer'
import { StatusBar } from './components/StatusBar'
import { MenuBar } from './components/MenuBar'
import { DiffPanel } from './components/DiffPanel'
import { AgentPanel } from './components/AgentPanel'
import { ExternalFileChangedDialog } from './components/ExternalFileChangedDialog'
import { openSearchPanel } from '@codemirror/search'
import { undo, redo } from '@codemirror/commands'
import { useEditorStore } from './store/editorStore'
import {
  openFile,
  detectLanguage,
  notify,
  confirmTruncatedPdfExport,
  pickSavePdfPath,
  saveBinaryFile,
  saveFile,
  getFileDiskBaseline,
} from './utils/fileOps'
import { exportHtmlToPdfBytes, exportTextToPdfBytes } from './utils/exportPdf'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

const MAX_PDF_EXPORT_LINES = 10_000
/** Narrow no-break space between digits (same as product copy). */
const PDF_TRUNC_TAIL_NOTICE = '本 PDF 仅包含原文前 10\u202F000 行。'

function App() {
  const { files, activeFileId, setActiveFileId } = useFileStore()
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
  const [showPreview, setShowPreview] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [showAgent, setShowAgent] = useState(false)
  const agentPanelHeight = 260
  /** When disk changed while buffer has unsaved edits (focus-time check). */
  const [externalConflictFileId, setExternalConflictFileId] = useState<string | null>(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const handleOpenFile = async () => {
    const file = await openFile()
    if (file) {
      const content = file.content
      const lineCount = typeof content === 'string' ? content.split('\n').length : 0
      const fileSize = typeof content === 'string' ? content.length : (content as Uint8Array).byteLength
      const id = useFileStore.getState().addFile({
        name: file.name,
        path: file.path,
        content: content,
        savedContent: typeof content === 'string' ? content : undefined,
        language: file.isPdf ? 'pdf' : detectLanguage(file.name),
        encoding: 'UTF-8',
        lineCount,
        fileSize,
        isPdf: file.isPdf,
        isModified: false,
      })
      if (!file.isPdf && typeof file.content === 'string' && file.path) {
        const b = await getFileDiskBaseline(file.path)
        if (b) useFileStore.getState().setDiskBaseline(id, b.mtimeMs, b.size)
      }
    }
  }

  const activeFile = files.find((f) => f.id === activeFileId)
  const isPdf = activeFile?.name.endsWith('.pdf')
  const canPreview = activeFile?.language === 'markdown' || activeFile?.language === 'html'
  const canSave =
    Boolean(activeFile) &&
    !isPdf &&
    typeof activeFile?.content === 'string' &&
    Boolean(activeFile?.path)
  const canDiff = canSave
  const canExportPdf =
    Boolean(activeFile) &&
    !isPdf &&
    typeof activeFile?.content === 'string'
  const canAgent =
    Boolean(activeFile) &&
    !isPdf &&
    typeof activeFile?.content === 'string' &&
    Boolean(activeFile?.path)
  const canFind = Boolean(activeFile) && !isPdf && !showDiff

  useEffect(() => {
    if (!canPreview) setShowPreview(false)
  }, [canPreview])

  useEffect(() => {
    if (!canDiff) setShowDiff(false)
  }, [canDiff])

  useEffect(() => {
    if (!canAgent) setShowAgent(false)
  }, [canAgent])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        if (canAgent) setShowAgent((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canAgent])

  const checkExternalChangeOnFocus = useCallback(async () => {
    const state = useFileStore.getState()
    const id = state.activeFileId
    if (!id) return
    const file = state.files.find((f) => f.id === id)
    if (!file || file.isPdf || typeof file.content !== 'string' || !file.path) return

    const onDisk = await getFileDiskBaseline(file.path)
    if (!onDisk) {
      await notify({
        title: '无法读取文件',
        message: '无法在磁盘上访问该文件，可能已被移动或删除。',
        kind: 'warning',
      })
      return
    }

    const hasBaseline =
      typeof file.diskMtimeMs === 'number' && typeof file.diskSize === 'number'

    if (!hasBaseline) {
      useFileStore.getState().setDiskBaseline(id, onDisk.mtimeMs, onDisk.size)
      return
    }

    if (onDisk.mtimeMs === file.diskMtimeMs && onDisk.size === file.diskSize) {
      return
    }

    if (!file.isModified) {
      try {
        const text = await readTextFile(file.path)
        useFileStore.getState().replaceContentFromDisk(id, text)
        useFileStore.getState().setDiskBaseline(id, onDisk.mtimeMs, onDisk.size)
        await notify({
          title: '已从磁盘更新',
          message: `「${file.name}」在磁盘上的内容已变更，编辑器已自动加载最新内容。`,
          kind: 'info',
        })
      } catch (e) {
        await notify({
          title: '重新加载失败',
          message: e instanceof Error ? e.message : String(e),
          kind: 'error',
        })
      }
      return
    }

    setExternalConflictFileId(id)
  }, [])

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        void checkExternalChangeOnFocus()
      }, 320)
    }
    const onVis = () => {
      if (document.visibilityState === 'visible') schedule()
    }
    window.addEventListener('focus', schedule)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      if (t) clearTimeout(t)
      window.removeEventListener('focus', schedule)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [checkExternalChangeOnFocus])

  useEffect(() => {
    if (externalConflictFileId && activeFileId !== externalConflictFileId) {
      setExternalConflictFileId(null)
    }
  }, [activeFileId, externalConflictFileId])

  const handleSaveFile = async () => {
    if (!activeFile) return
    if (isPdf) return
    if (typeof activeFile.content !== 'string') return
    if (!activeFile.path) return

    const ok = await saveFile(activeFile.path, activeFile.content)
    if (ok) {
      useFileStore.getState().setSavedContent(activeFile.id, activeFile.content)
      useFileStore.getState().markModified(activeFile.id, false)
      const b = await getFileDiskBaseline(activeFile.path)
      if (b) useFileStore.getState().setDiskBaseline(activeFile.id, b.mtimeMs, b.size)
    }
  }

  const handleUndo = () => {
    const view = useEditorStore.getState().editorView
    if (view) undo(view)
  }

  const handleRedo = () => {
    const view = useEditorStore.getState().editorView
    if (view) redo(view)
  }

  const conflictFile = externalConflictFileId
    ? files.find((f) => f.id === externalConflictFileId)
    : null

  const handleReloadFromDiskConflict = async () => {
    if (!conflictFile || typeof conflictFile.content !== 'string' || !conflictFile.path) return
    try {
      const text = await readTextFile(conflictFile.path)
      const onDisk = await getFileDiskBaseline(conflictFile.path)
      useFileStore.getState().replaceContentFromDisk(conflictFile.id, text)
      if (onDisk) useFileStore.getState().setDiskBaseline(conflictFile.id, onDisk.mtimeMs, onDisk.size)
      setExternalConflictFileId(null)
    } catch (e) {
      await notify({
        title: '重新加载失败',
        message: e instanceof Error ? e.message : String(e),
        kind: 'error',
      })
    }
  }

  const handleExportPdf = async () => {
    try {
      if (!activeFile) return
      if (typeof activeFile.content !== 'string') return
      const themeAttr = document.documentElement.getAttribute('data-theme')
      const themeMode: 'light' | 'dark' = themeAttr === 'light' ? 'light' : 'dark'

      const full = activeFile.content
      const totalLines = full.split('\n').length
      let sourceForPdf = full
      let truncatedForPdf = false
      if (totalLines > MAX_PDF_EXPORT_LINES) {
        const go = await confirmTruncatedPdfExport({
          totalLines,
          maxLines: MAX_PDF_EXPORT_LINES,
        })
        if (!go) {
          await notify({ title: '导出 PDF', message: '已取消。', kind: 'info' })
          return
        }
        sourceForPdf = full.split('\n').slice(0, MAX_PDF_EXPORT_LINES).join('\n')
        truncatedForPdf = true
      }

      let html = ''
      if (activeFile.language === 'markdown') {
        const raw = marked.parse(sourceForPdf) as string
        html = DOMPurify.sanitize(raw)
      } else if (activeFile.language === 'html') {
        html = DOMPurify.sanitize(sourceForPdf)
      } else {
        // Code-like files export as real text (searchable + crisp).
        const pdfBytes = await exportTextToPdfBytes({
          text: sourceForPdf,
          title: activeFile.name,
          theme: themeMode,
        })

        const baseName = activeFile.name.replace(/\.[^.\\/]+$/u, '')
        const path = await pickSavePdfPath(`${baseName}.pdf`)
        if (!path) {
          await notify({ title: '导出 PDF', message: '已取消。', kind: 'info' })
          return
        }

        const ok = await saveBinaryFile(path, pdfBytes)
        if (ok) {
          const tail = truncatedForPdf ? `\n\n${PDF_TRUNC_TAIL_NOTICE}` : ''
          await notify({
            title: '导出 PDF 成功',
            message: `已保存到：\n${path}${tail}`,
            kind: 'info',
          })
        } else {
          await notify({ title: '导出 PDF 失败', message: '写入文件失败，请检查权限或路径。', kind: 'error' })
        }
        return
      }

      const pdfBytes = await exportHtmlToPdfBytes({
        html,
        title: activeFile.name,
        theme: themeMode,
      })

      const baseName = activeFile.name.replace(/\.[^.\\/]+$/u, '')
      const path = await pickSavePdfPath(`${baseName}.pdf`)
      if (!path) {
        await notify({ title: '导出 PDF', message: '已取消。', kind: 'info' })
        return
      }

      const ok = await saveBinaryFile(path, pdfBytes)
      if (ok) {
        const tail = truncatedForPdf ? `\n\n${PDF_TRUNC_TAIL_NOTICE}` : ''
        await notify({
          title: '导出 PDF 成功',
          message: `已保存到：\n${path}${tail}`,
          kind: 'info',
        })
      } else {
        await notify({ title: '导出 PDF 失败', message: '写入文件失败，请检查权限或路径。', kind: 'error' })
      }
    } catch (err) {
      console.error('Export PDF failed:', err)
      await notify({
        title: '导出 PDF 失败',
        message: err instanceof Error ? err.message : String(err),
        kind: 'error',
      })
    }
  }

  return (
    <div className="app-container">
      <MenuBar
        onOpenFile={handleOpenFile}
        onSaveFile={handleSaveFile}
        canSave={canSave && Boolean(activeFile?.isModified)}
        onUndo={handleUndo}
        onRedo={handleRedo}
        canUndoRedo={canFind}
        onExportPdf={handleExportPdf}
        canExportPdf={Boolean(canExportPdf)}
        canAgent={canAgent}
        isAgentShown={showAgent}
        onToggleAgent={() => setShowAgent((v) => !v)}
        canFind={canFind}
        onOpenFind={() => {
          const view = useEditorStore.getState().editorView
          if (view) openSearchPanel(view)
        }}
        canDiff={Boolean(canDiff) && Boolean(activeFile?.savedContent)}
        isDiffShown={showDiff}
        onToggleDiff={() => {
          setShowDiff((v) => !v)
          setShowPreview(false)
        }}
        canPreview={Boolean(canPreview) && !isPdf}
        isPreviewShown={showPreview}
        onTogglePreview={() => {
          setShowPreview((v) => !v)
          setShowDiff(false)
        }}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      />
      <TabBar
        files={files}
        activeFileId={activeFileId}
        onTabClick={setActiveFileId}
        onTabClose={(id) => useFileStore.getState().removeFile(id)}
      />
      <div className="main-workspace">
        <div className="editor-area">
          {activeFile ? (
            isPdf ? (
              <PdfViewer file={activeFile} />
            ) : showDiff ? (
              <DiffPanel file={activeFile} />
            ) : (
              <EditorPanel file={activeFile} showPreview={showPreview} />
            )
          ) : (
            <div className="welcome-screen">
              <h1>ClawEditor</h1>
              <p>按 Ctrl/Cmd+O 打开文件</p>
              <button onClick={handleOpenFile}>打开文件</button>
            </div>
          )}
        </div>
        {showAgent && canAgent ? (
          <AgentPanel activeFile={activeFile} height={agentPanelHeight} />
        ) : null}
      </div>
      <StatusBar
        file={activeFile || null}
        theme={theme}
      />
      {conflictFile && typeof conflictFile.content === 'string' ? (
        <ExternalFileChangedDialog
          fileName={conflictFile.name}
          onReload={() => void handleReloadFromDiskConflict()}
          onKeepEditing={() => setExternalConflictFileId(null)}
        />
      ) : null}
    </div>
  )
}

export default App
