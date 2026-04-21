import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import {
  getPaletteState,
  type PaletteItem,
} from './agentCommandPalette'

export interface AgentChatInputProps {
  value: string
  onChange: (v: string) => void
  onSubmit: (line: string) => void
  placeholder: string
  disabled?: boolean
  commandHistory: string[]
  'aria-label'?: string
}

function lineStartIndex(value: string, cursorPos: number): number {
  return value.lastIndexOf('\n', cursorPos - 1) + 1
}

/** Replace text from `/` through cursor with insertFromSlash (which includes leading `/`). */
function applyPaletteInsert(
  value: string,
  cursorPos: number,
  item: PaletteItem
): { value: string; cursor: number } {
  const lineStart = lineStartIndex(value, cursorPos)
  const line = value.slice(lineStart, cursorPos)
  const slashIdx = line.indexOf('/')
  if (slashIdx === -1) return { value, cursor: cursorPos }
  const before = value.slice(0, lineStart + slashIdx)
  const insert = item.insertFromSlash
  const after = value.slice(cursorPos)
  const next = before + insert + after
  return { value: next, cursor: before.length + insert.length }
}

export function AgentChatInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  commandHistory,
  'aria-label': ariaLabel,
}: AgentChatInputProps) {
  const id = useId()
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [cursorPos, setCursorPos] = useState(0)

  const [paletteIndex, setPaletteIndex] = useState(0)
  const [historyNav, setHistoryNav] = useState<{
    index: number
    draft: string
  } | null>(null)
  const skipHistoryClear = useRef(false)

  const syncCursor = useCallback(() => {
    const el = taRef.current
    if (!el) return
    setCursorPos(el.selectionStart)
  }, [])

  useEffect(() => {
    if (value === '') setHistoryNav(null)
  }, [value])

  const pal = getPaletteState(value, cursorPos)
  const paletteOpen = pal.open && pal.items.length > 0

  useEffect(() => {
    const p = getPaletteState(value, cursorPos)
    if (p.open && p.items.length > 0) setPaletteIndex(0)
  }, [value, cursorPos])

  const flushSubmit = useCallback(() => {
    const line = value.trim()
    if (!line || disabled) return
    onSubmit(line)
  }, [value, disabled, onSubmit])

  const applyHistory = useCallback(
    (next: string) => {
      skipHistoryClear.current = true
      onChange(next)
      requestAnimationFrame(() => {
        const el = taRef.current
        if (el) {
          const len = next.length
          el.setSelectionRange(len, len)
          setCursorPos(len)
        }
        skipHistoryClear.current = false
      })
    },
    [onChange]
  )

  const handleChange = useCallback(
    (v: string) => {
      if (!skipHistoryClear.current && historyNav !== null) {
        setHistoryNav(null)
      }
      onChange(v)
    },
    [historyNav, onChange]
  )

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return

    if (paletteOpen && pal.open) {
      const items = pal.items
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setPaletteIndex((i) => (i + 1) % items.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setPaletteIndex((i) => (i - 1 + items.length) % items.length)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        const item = items[paletteIndex] ?? items[0]
        if (!item) return
        const { value: nv, cursor } = applyPaletteInsert(
          value,
          cursorPos,
          item
        )
        handleChange(nv)
        requestAnimationFrame(() => {
          const el = taRef.current
          if (el) {
            el.setSelectionRange(cursor, cursor)
            setCursorPos(cursor)
          }
        })
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const item = items[paletteIndex] ?? items[0]
        if (!item) return
        const { value: nv, cursor } = applyPaletteInsert(
          value,
          cursorPos,
          item
        )
        handleChange(nv)
        requestAnimationFrame(() => {
          const el = taRef.current
          if (el) {
            el.setSelectionRange(cursor, cursor)
            setCursorPos(cursor)
          }
          el?.focus()
        })
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        const lineStart = lineStartIndex(value, cursorPos)
        const line = value.slice(lineStart, cursorPos)
        const slash = line.indexOf('/')
        if (slash !== -1) {
          const before = value.slice(0, lineStart + slash)
          const after = value.slice(cursorPos)
          const nv = before + after
          handleChange(nv)
          requestAnimationFrame(() => {
            const el = taRef.current
            if (el) {
              const p = before.length
              el.setSelectionRange(p, p)
              setCursorPos(p)
            }
          })
        }
        return
      }
    }

    if (e.key === 'ArrowUp' && !e.shiftKey && !paletteOpen) {
      if (commandHistory.length === 0) return
      e.preventDefault()
      if (historyNav === null) {
        setHistoryNav({ index: commandHistory.length - 1, draft: value })
        applyHistory(commandHistory[commandHistory.length - 1] ?? '')
      } else if (historyNav.index > 0) {
        const nextIdx = historyNav.index - 1
        setHistoryNav({ ...historyNav, index: nextIdx })
        applyHistory(commandHistory[nextIdx] ?? '')
      }
      return
    }

    if (e.key === 'ArrowDown' && !e.shiftKey && !paletteOpen) {
      if (historyNav === null) return
      e.preventDefault()
      if (historyNav.index < commandHistory.length - 1) {
        const nextIdx = historyNav.index + 1
        setHistoryNav({ ...historyNav, index: nextIdx })
        applyHistory(commandHistory[nextIdx] ?? '')
      } else {
        applyHistory(historyNav.draft)
        setHistoryNav(null)
      }
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      flushSubmit()
    }
  }

  return (
    <div className="agent-chat-input-wrap">
      {paletteOpen && pal.open ? (
        <ul
          className="agent-command-palette"
          role="listbox"
          aria-label="命令"
          id={`${id}-pal`}
        >
          {pal.items.map((it, i) => (
            <li
              key={it.id}
              role="option"
              aria-selected={i === paletteIndex}
              className={
                i === paletteIndex
                  ? 'agent-command-palette-item active'
                  : 'agent-command-palette-item'
              }
              onMouseDown={(ev) => {
                ev.preventDefault()
                const { value: nv, cursor } = applyPaletteInsert(
                  value,
                  cursorPos,
                  it
                )
                handleChange(nv)
                setPaletteIndex(i)
                requestAnimationFrame(() => {
                  const el = taRef.current
                  if (el) {
                    el.setSelectionRange(cursor, cursor)
                    setCursorPos(cursor)
                    el.focus()
                  }
                })
              }}
            >
              <span className="agent-command-palette-label">{it.label}</span>
              <span className="agent-command-palette-desc">{it.description}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={taRef}
        id={id}
        className="agent-chat-textarea"
        rows={2}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel ?? 'Agent 输入'}
        aria-controls={paletteOpen ? `${id}-pal` : undefined}
        aria-expanded={paletteOpen}
        aria-autocomplete={paletteOpen ? 'list' : undefined}
        onChange={(ev) => {
          handleChange(ev.target.value)
          syncCursor()
        }}
        onSelect={syncCursor}
        onClick={syncCursor}
        onKeyUp={syncCursor}
        onKeyDown={handleKeyDown}
      />
      <div className="agent-chat-hint">
        Enter 发送 · Shift+Enter 换行
        {paletteOpen ? ' · ↑↓ 选择 · Tab/Enter 填入 · Esc 取消 /' : ''}
        {!paletteOpen && commandHistory.length > 0
          ? ' · ↑↓ 历史命令'
          : ''}
      </div>
    </div>
  )
}
