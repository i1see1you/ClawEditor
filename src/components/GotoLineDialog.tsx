import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditorStore } from '../store/editorStore'
import { parseGotoLineInput, type GotoLineCommand } from '../utils/gotoLineInput'

interface GotoLineDialogProps {
  open: boolean
  onClose: () => void
  onSubmit: (cmd: GotoLineCommand) => void
}

function currentLine1FromView(): number {
  const view = useEditorStore.getState().editorView
  if (!view) return 1
  try {
    return view.state.doc.lineAt(view.state.selection.main.head).number
  } catch {
    return 1
  }
}

export function GotoLineDialog({ open, onClose, onSubmit }: GotoLineDialogProps) {
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setInput(String(currentLine1FromView()))
    const t = window.setTimeout(() => {
      const el = inputRef.current
      if (el) {
        el.focus()
        el.select()
      }
    }, 0)
    return () => window.clearTimeout(t)
  }, [open])

  const submit = useCallback(() => {
    const cmd = parseGotoLineInput(input)
    if (!cmd) return
    onSubmit(cmd)
    onClose()
  }, [input, onSubmit, onClose])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        submit()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, submit, onClose])

  if (!open) return null

  return (
    <div
      className="goto-line-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="转到行"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="goto-line-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="goto-line-title">转到行</div>
        <div className="goto-line-sub">
          Ctrl/Cmd+G · 单行号跳转；或 a-b（如 1-100）选中第 a～b 行全文（1-based）
        </div>
        <input
          ref={inputRef}
          className="goto-line-input"
          type="text"
          inputMode="text"
          spellCheck={false}
          autoComplete="off"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <div className="goto-line-actions">
          <button type="button" className="goto-line-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="goto-line-btn primary" onClick={submit}>
            跳转
          </button>
        </div>
      </div>
    </div>
  )
}
