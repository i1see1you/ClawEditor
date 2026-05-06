import {
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from 'react'
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
import { GotoAnything } from './components/GotoAnything'
import { GotoLineDialog } from './components/GotoLineDialog'
import { openSearchPanel } from '@codemirror/search'
import { undo, redo } from '@codemirror/commands'
import { useEditorStore } from './store/editorStore'
import { gotoLineInEditor, selectLineRangeInEditor } from './utils/gotoLine'
import type { GotoLineCommand } from './utils/gotoLineInput'
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

const AGENT_PANEL_MIN_HEIGHT = 140
function maxAgentPanelHeight(): number {
  return Math.max(AGENT_PANEL_MIN_HEIGHT, Math.floor(window.innerHeight * 0.92))
}

function App() {
  const { files, activeFileId, setActiveFileId } = useFileStore()
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
  const [showPreview, setShowPreview] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [showAgent, setShowAgent] = useState(false)
  const [agentPanelHeight, setAgentPanelHeight] = useState(260)
  const agentDragRef = useRef<{ startY: number; startHeight: number } | null>(null)
  /** When disk changed while buffer has unsaved edits (focus-time check). */
  const [externalConflictFileId, setExternalConflictFileId] = useState<string | null>(null)
  const [gotoOpen, setGotoOpen] = useState(false)
  const [gotoLineOpen, setGotoLineOpen] = useState(false)
  const pendingGotoLineRef = useRef<{ targetId: string; line: number } | null>(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    const onWinResize = () => {
      setAgentPanelHeight((h) =>
        Math.min(maxAgentPanelHeight(), Math.max(AGENT_PANEL_MIN_HEIGHT, h))
      )
    }
    window.addEventListener('resize', onWinResize)
    return () => window.removeEventListener('resize', onWinResize)
  }, [])

  const handleAgentResizeStart = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    agentDragRef.current = { startY: e.clientY, startHeight: agentPanelHeight }
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev: MouseEvent) => {
      const d = agentDragRef.current
      if (!d) return
      const delta = d.startY - ev.clientY
      const next = Math.min(
        maxAgentPanelHeight(),
        Math.max(AGENT_PANEL_MIN_HEIGHT, d.startHeight + delta)
      )
      setAgentPanelHeight(next)
    }
    const onUp = () => {
      agentDragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [agentPanelHeight])

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

  const gotoTabItems = useMemo(
    () =>
      files
        .filter((f) => !f.isPdf && typeof f.content === 'string')
        .map((f) => ({ id: f.id, name: f.name, path: f.path })),
    [files]
  )

  const canGotoAnything = gotoTabItems.length > 0

  const handleGotoPick = useCallback((fileId: string, line?: number) => {
    setGotoOpen(false)
    const priorId = useFileStore.getState().activeFileId
    setActiveFileId(fileId)
    if (line !== undefined && line >= 1) {
      if (fileId === priorId) {
        requestAnimationFrame(() => {
          const view = useEditorStore.getState().editorView
          if (view) gotoLineInEditor(view, line)
        })
      } else {
        pendingGotoLineRef.current = { targetId: fileId, line }
      }
    } else {
      pendingGotoLineRef.current = null
    }
  }, [setActiveFileId])

  useLayoutEffect(() => {
    const p = pendingGotoLineRef.current
    if (!p || p.targetId !== activeFileId) return
    const id = requestAnimationFrame(() => {
      const view = useEditorStore.getState().editorView
      if (!view) return
      if (pendingGotoLineRef.current?.targetId !== p.targetId) return
      gotoLineInEditor(view, p.line)
      pendingGotoLineRef.current = null
    })
    return () => cancelAnimationFrame(id)
  }, [activeFileId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'p') return
      if (!canGotoAnything) return
      e.preventDefault()
      e.stopPropagation()
      setGotoLineOpen(false)
      setGotoOpen((o) => !o)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [canGotoAnything])

  useEffect(() => {
    if (!canFind) setGotoLineOpen(false)
  }, [canFind])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key.toLowerCase() !== 'g') return
      if (!canFind) return
      e.preventDefault()
      e.stopPropagation()
      setGotoOpen(false)
      setGotoLineOpen((v) => !v)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [canFind])

  const handleGotoLineSubmit = useCallback((cmd: GotoLineCommand) => {
    const view = useEditorStore.getState().editorView
    if (!view) return
    if (cmd.kind === 'goto') {
      gotoLineInEditor(view, cmd.line)
    } else {
      selectLineRangeInEditor(view, cmd.fromLine, cmd.toLine)
    }
  }, [])

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
        canGotoAnything={canGotoAnything}
        onOpenGoto={() => {
          setGotoLineOpen(false)
          setGotoOpen(true)
        }}
        onOpenGotoLine={() => {
          setGotoOpen(false)
          setGotoLineOpen(true)
        }}
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
              {canGotoAnything ? <p>按 Ctrl/Cmd+P 转到已打开文件（可后缀 :行号）</p> : null}
              <button onClick={handleOpenFile}>打开文件</button>
            </div>
          )}
        </div>
        {showAgent && canAgent ? (
          <>
            <div
              className="agent-dock-resize-handle"
              role="separator"
              aria-orientation="horizontal"
              aria-label="调整 OpenClaw 面板高度"
              onMouseDown={handleAgentResizeStart}
            />
            <AgentPanel activeFile={activeFile} height={agentPanelHeight} />
          </>
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
      <GotoAnything
        open={gotoOpen}
        onClose={() => setGotoOpen(false)}
        items={gotoTabItems}
        activeFileId={activeFileId}
        onPick={handleGotoPick}
      />
      <GotoLineDialog
        open={gotoLineOpen}
        onClose={() => setGotoLineOpen(false)}
        onSubmit={handleGotoLineSubmit}
      />
    </div>
  )
}

export default App
