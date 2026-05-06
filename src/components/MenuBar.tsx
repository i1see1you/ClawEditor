import { useEditorStore } from '../store/editorStore'

interface MenuBarProps {
  onOpenFile: () => void
  onSaveFile?: () => void
  canSave?: boolean
  onUndo?: () => void
  onRedo?: () => void
  /** When false (e.g. PDF / Diff / no file), undo/redo are disabled. */
  canUndoRedo?: boolean
  onExportPdf?: () => void
  canExportPdf?: boolean
  onToggleAgent?: () => void
  canAgent?: boolean
  isAgentShown?: boolean
  onOpenFind?: () => void
  canFind?: boolean
  onOpenGotoLine?: () => void
  onToggleDiff?: () => void
  canDiff?: boolean
  isDiffShown?: boolean
  onTogglePreview?: () => void
  canPreview?: boolean
  isPreviewShown?: boolean
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  /** Goto Anything (opened tabs + optional :line). */
  canGotoAnything?: boolean
  onOpenGoto?: () => void
}

export function MenuBar({
  onOpenFile,
  onSaveFile,
  canSave = false,
  onUndo,
  onRedo,
  canUndoRedo = false,
  onExportPdf,
  canExportPdf = false,
  onToggleAgent,
  canAgent = false,
  isAgentShown = false,
  onOpenFind,
  canFind = false,
  onOpenGotoLine,
  onToggleDiff,
  canDiff = false,
  isDiffShown = false,
  onTogglePreview,
  canPreview = false,
  isPreviewShown = false,
  theme,
  onToggleTheme,
  canGotoAnything = false,
  onOpenGoto,
}: MenuBarProps) {
  const undoDepth = useEditorStore((s) => s.undoDepth)
  const redoDepth = useEditorStore((s) => s.redoDepth)

  return (
    <div className="menu-bar">
      <div className="menu-left">
        <button className="menu-btn" onClick={onOpenFile}>
          打开
        </button>
        <button className="menu-btn" onClick={onSaveFile} disabled={!canSave}>
          保存
        </button>
        <button
          type="button"
          className="menu-btn"
          onClick={onUndo}
          disabled={!canUndoRedo || undoDepth === 0}
          title="撤销 (⌘Z / Ctrl+Z)"
        >
          撤销
        </button>
        <button
          type="button"
          className="menu-btn"
          onClick={onRedo}
          disabled={!canUndoRedo || redoDepth === 0}
          title="重做 (⌘⇧Z / Ctrl+Y)"
        >
          重做
        </button>
        <button className="menu-btn" onClick={onExportPdf} disabled={!canExportPdf}>
          导出 PDF
        </button>
        {canAgent ? (
          <button className="menu-btn" onClick={onToggleAgent}>
            {isAgentShown ? '关闭 Agent' : 'OpenClaw'}
          </button>
        ) : null}
        {canFind ? (
          <button type="button" className="menu-btn" onClick={onOpenFind}>
            查找
          </button>
        ) : null}
        {canFind && onOpenGotoLine ? (
          <button
            type="button"
            className="menu-btn"
            onClick={onOpenGotoLine}
            title="转到行 (⌘G / Ctrl+G)；支持 1-100 选行"
          >
            转到行
          </button>
        ) : null}
        {canGotoAnything && onOpenGoto ? (
          <button type="button" className="menu-btn" onClick={onOpenGoto} title="转到文件 (⌘P / Ctrl+P)">
            转到文件
          </button>
        ) : null}
        {canDiff ? (
          <button className="menu-btn" onClick={onToggleDiff}>
            {isDiffShown ? '关闭 Diff' : 'Diff'}
          </button>
        ) : null}
        {canPreview ? (
          <button className="menu-btn" onClick={onTogglePreview}>
            {isPreviewShown ? '关闭预览' : '预览'}
          </button>
        ) : null}
      </div>
      <div className="menu-right">
        <button className="theme-btn" onClick={onToggleTheme}>
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </div>
    </div>
  )
}