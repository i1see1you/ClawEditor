import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import fuzzysort from 'fuzzysort'
import { parseGotoAnythingQuery } from '../utils/gotoAnythingQuery'

export type GotoTabItem = { id: string; name: string; path: string }

interface GotoAnythingProps {
  open: boolean
  onClose: () => void
  /** Text tabs only (caller filters PDF / non-string). */
  items: GotoTabItem[]
  activeFileId: string | null
  onPick: (fileId: string, line?: number) => void
}

const LIST_LIMIT = 80

function rankItems(query: string, list: GotoTabItem[]): GotoTabItem[] {
  const q = query.trim()
  if (!q) {
    const r = fuzzysort.go('', list, {
      keys: ['name', 'path'],
      all: true,
      limit: LIST_LIMIT,
    })
    return r.map((x) => x.obj)
  }
  const r = fuzzysort.go(q, list, {
    keys: ['name', 'path'],
    limit: LIST_LIMIT,
  })
  return r.map((x) => x.obj)
}

export function GotoAnything({
  open,
  onClose,
  items,
  activeFileId,
  onPick,
}: GotoAnythingProps) {
  const [input, setInput] = useState('')
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const { fileQuery, line } = useMemo(() => parseGotoAnythingQuery(input), [input])

  const ranked = useMemo(() => rankItems(fileQuery, items), [fileQuery, items])

  useEffect(() => {
    if (!open) return
    setInput('')
    setHighlight(0)
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  useEffect(() => {
    setHighlight((h) => {
      if (ranked.length === 0) return 0
      return Math.min(h, ranked.length - 1)
    })
  }, [ranked.length])

  const confirm = useCallback(
    (clickedIndex?: number) => {
      const i = clickedIndex ?? highlight
      const row = ranked[i]
      const onlyLine = fileQuery.trim() === '' && line !== undefined
      // Enter（无点击索引）：与 Sublime 一致，仅 `:N` 时跳到当前活动标签第 N 行
      if (onlyLine && clickedIndex === undefined) {
        if (activeFileId && items.some((x) => x.id === activeFileId)) {
          onPick(activeFileId, line)
          return
        }
      }
      if (!row) return
      onPick(row.id, line)
    },
    [activeFileId, fileQuery, highlight, items, line, onPick, ranked]
  )

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setHighlight((h) => (ranked.length ? Math.min(h + 1, ranked.length - 1) : 0))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setHighlight((h) => (ranked.length ? Math.max(h - 1, 0) : 0))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        confirm()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, ranked.length, confirm, onClose])

  if (!open) return null

  const onlyLineSublime =
    fileQuery.trim() === '' &&
    line !== undefined &&
    Boolean(activeFileId && items.some((x) => x.id === activeFileId))

  const hint = onlyLineSublime
    ? `回车：当前活动标签 → 第 ${line} 行（1-based）；点列表可改目标文件`
    : line !== undefined
      ? `打开后跳到第 ${line} 行（1-based）`
      : '仅 :行号 回车跳当前活动标签；或 foo:42 匹配文件名'

  return (
    <div
      className="goto-anything-overlay"
      data-goto-anything
      role="dialog"
      aria-modal="true"
      aria-label="转到文件"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="goto-anything-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="goto-anything-title">转到文件</div>
        <div className="goto-anything-sub">Ctrl/Cmd+P · 模糊匹配已打开标签 · {hint}</div>
        <input
          ref={inputRef}
          className="goto-anything-input"
          type="text"
          spellCheck={false}
          autoComplete="off"
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setHighlight(0)
          }}
          placeholder="输入文件名或路径…"
        />
        <div className="goto-anything-list" role="listbox" aria-label="匹配的文件">
          {ranked.length === 0 ? (
            <div className="goto-anything-empty">无匹配标签（仅已打开的非 PDF 文本文件）</div>
          ) : (
            ranked.map((row, idx) => (
              <button
                key={row.id}
                type="button"
                role="option"
                aria-selected={idx === highlight}
                className={`goto-anything-row${idx === highlight ? ' active' : ''}${
                  row.id === activeFileId ? ' current' : ''
                }`}
                onMouseEnter={() => setHighlight(idx)}
                onClick={() => confirm(idx)}
              >
                <span className="goto-anything-name">{row.name}</span>
                <span className="goto-anything-path">{row.path}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
