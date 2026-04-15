import { useState, useEffect } from 'react'
import { useFileStore } from './store/fileStore'
import { TabBar } from './components/TabBar'
import { EditorPanel } from './components/EditorPanel'
import { PdfViewer } from './components/PdfViewer'
import { StatusBar } from './components/StatusBar'
import { MenuBar } from './components/MenuBar'
import { DiffPanel } from './components/DiffPanel'
import { AgentPanel } from './components/AgentPanel'
import { openSearchPanel } from '@codemirror/search'
import { undo, redo } from '@codemirror/commands'
import { useEditorStore } from './store/editorStore'
import { openFile, detectLanguage, notify, pickSavePdfPath, saveBinaryFile, saveFile } from './utils/fileOps'
import { exportHtmlToPdfBytes } from './utils/exportPdf'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

function App() {
  const { files, activeFileId, setActiveFileId } = useFileStore()
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
  const [showPreview, setShowPreview] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [showAgent, setShowAgent] = useState(false)
  const agentPanelHeight = 260

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const handleOpenFile = async () => {
    const file = await openFile()
    if (file) {
      const content = file.content
      const lineCount = typeof content === 'string' ? content.split('\n').length : 0
      const fileSize = typeof content === 'string' ? content.length : (content as Uint8Array).byteLength
      useFileStore.getState().addFile({
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
  const canExportPdf = activeFile?.language === 'markdown' || activeFile?.language === 'html'
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

  const handleSaveFile = async () => {
    if (!activeFile) return
    if (isPdf) return
    if (typeof activeFile.content !== 'string') return
    if (!activeFile.path) return

    const ok = await saveFile(activeFile.path, activeFile.content)
    if (ok) {
      useFileStore.getState().setSavedContent(activeFile.id, activeFile.content)
      useFileStore.getState().markModified(activeFile.id, false)
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

  const handleExportPdf = async () => {
    try {
      if (!activeFile) return
      if (typeof activeFile.content !== 'string') return
      if (!canExportPdf) return

      const themeAttr = document.documentElement.getAttribute('data-theme')
      const themeMode: 'light' | 'dark' = themeAttr === 'light' ? 'light' : 'dark'

      let html = ''
      if (activeFile.language === 'markdown') {
        const raw = marked.parse(activeFile.content) as string
        html = DOMPurify.sanitize(raw)
      } else if (activeFile.language === 'html') {
        html = DOMPurify.sanitize(activeFile.content)
      } else {
        return
      }

      const pdfBytes = await exportHtmlToPdfBytes({
        html,
        title: activeFile.name,
        theme: themeMode,
      })

      const baseName = activeFile.name.replace(/\.(md|markdown|html|htm)$/i, '')
      const path = await pickSavePdfPath(`${baseName}.pdf`)
      if (!path) {
        await notify({ title: '导出 PDF', message: '已取消。', kind: 'info' })
        return
      }

      const ok = await saveBinaryFile(path, pdfBytes)
      if (ok) {
        await notify({ title: '导出 PDF 成功', message: `已保存到：\n${path}`, kind: 'info' })
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
    </div>
  )
}

export default App
