import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export interface XTerminalRef {
  write: (data: string) => void
  writeln: (data: string) => void
  clear: () => void
  focus: () => void
}

interface XTerminalProps {
  onLine?: (line: string) => void
  prompt?: string
  className?: string
}

/** 去掉最后一个 Unicode 标量（适配中文等 BMP 外字符） */
function popLastChar(s: string): string {
  const chars = [...s]
  chars.pop()
  return chars.join('')
}

export const XTerminal = forwardRef<XTerminalRef, XTerminalProps>(
  ({ onLine, prompt = '> ', className }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null)
    const termRef = useRef<Terminal | null>(null)
    const fitRef = useRef<FitAddon | null>(null)
    const lineBufferRef = useRef('')
    const historyRef = useRef<string[]>([])
    const historyPosRef = useRef(0) // 0..history.length (history.length = draft)
    const draftRef = useRef('')
    const onLineRef = useRef(onLine)
    const promptRef = useRef(prompt)

    function charCount(s: string): number {
      return [...s].length
    }

    function clearTyped(term: Terminal, typed: string): void {
      const n = charCount(typed)
      for (let i = 0; i < n; i++) term.write('\b \b')
    }

    function replaceTyped(term: Terminal, next: string): void {
      clearTyped(term, lineBufferRef.current)
      lineBufferRef.current = next
      term.write(next)
    }

    useImperativeHandle(ref, () => ({
      write: (data: string) => {
        termRef.current?.write(data)
      },
      writeln: (data: string) => {
        termRef.current?.writeln(data)
      },
      clear: () => {
        termRef.current?.clear()
      },
      focus: () => {
        termRef.current?.focus()
      },
    }), [])

    useEffect(() => {
      onLineRef.current = onLine
    }, [onLine])

    useEffect(() => {
      promptRef.current = prompt
    }, [prompt])

    useEffect(() => {
      if (!containerRef.current || termRef.current) return

      const term = new Terminal({
        convertEol: true,
        cursorBlink: true,
        cursorStyle: 'block',
        fontSize: 13,
        fontFamily:
          'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", monospace',
        theme: {
          background: '#1e1e1e',
          foreground: '#cccccc',
          cursor: '#cccccc',
          selectionBackground: 'rgba(255, 255, 255, 0.15)',
        },
        scrollback: 500,
      })

      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(containerRef.current)

      setTimeout(() => {
        try {
          fitAddon.fit()
        } catch {
          // ignore
        }
        term.focus()
      }, 0)

      termRef.current = term
      fitRef.current = fitAddon

      term.write(promptRef.current)

      term.onKey(({ domEvent }) => {
        if (!domEvent) return
        const term = termRef.current
        if (!term) return

        // Some keyboards send numpad operators in a way that doesn't reach onData as plain '+'/'-'.
        // Handle them here so they behave like normal typed characters.
        if (
          domEvent.location === 3 && // KeyboardEvent.DOM_KEY_LOCATION_NUMPAD
          (domEvent.key === '+' || domEvent.key === '-' || domEvent.key === '*' || domEvent.key === '/')
        ) {
          domEvent.preventDefault()
          domEvent.stopPropagation()
          lineBufferRef.current += domEvent.key
          term.write(domEvent.key)
          return
        }

        if (domEvent.key !== 'ArrowUp' && domEvent.key !== 'ArrowDown') return

        domEvent.preventDefault()
        domEvent.stopPropagation()

        const hist = historyRef.current
        const pos = historyPosRef.current

        if (domEvent.key === 'ArrowUp') {
          if (hist.length === 0) return
          if (pos === hist.length) {
            draftRef.current = lineBufferRef.current
          }
          if (pos <= 0) return
          historyPosRef.current = pos - 1
          replaceTyped(term, hist[pos - 1] ?? '')
          return
        }

        // ArrowDown
        if (pos >= hist.length) return
        const nextPos = pos + 1
        historyPosRef.current = nextPos
        if (nextPos === hist.length) {
          replaceTyped(term, draftRef.current ?? '')
        } else {
          replaceTyped(term, hist[nextPos] ?? '')
        }
      })

      // onData：UTF-8 / 中文输入法提交后的完整字符会在此出现；onKey 对 IME 基本不可用
      term.onData((data) => {
        if (!data) return
        // Normalize a few common keypad/application-mode escape sequences into printable characters.
        // (Some keyboards send these for numpad operators instead of '+'/'-'.)
        const keypadMap: Record<string, string> = {
          '\x1bOk': '+', // KP+
          '\x1bOm': '-', // KP-
          '\x1bOj': '*', // KP*
          '\x1bOo': '/', // KP/
        }
        if (data in keypadMap) {
          data = keypadMap[data]
        }

        // Arrow keys may arrive as escape sequences here as well (e.g. "\x1b[A").
        // We handle history navigation via onKey; ignore these to avoid polluting the input buffer.
        if (
          data === '\x1b[A' || // Up
          data === '\x1b[B' || // Down
          data === '\x1bOA' || // Up (application cursor mode)
          data === '\x1bOB' // Down (application cursor mode)
        ) {
          return
        }

        // Other escape sequences (Home/End/PageUp/etc.) should not be treated as typed text.
        // Strip CSI/SS3 sequences and keep any remaining printable characters.
        if (data.includes('\x1b')) {
          const stripped = data
            // CSI: ESC [ ... final
            .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
            // SS3: ESC O <char>
            .replace(/\x1bO./g, '')
          if (!stripped) return
          data = stripped
        }
        for (const ch of data) {
          if (ch === '\r' || ch === '\n') {
            const line = lineBufferRef.current
            term.writeln('')
            lineBufferRef.current = ''
            draftRef.current = ''
            historyPosRef.current = historyRef.current.length
            if (onLineRef.current && line.trim()) {
              const trimmed = line.trim()
              const hist = historyRef.current
              if (hist.length === 0 || hist[hist.length - 1] !== trimmed) {
                hist.push(trimmed)
                if (hist.length > 200) hist.splice(0, hist.length - 200)
              }
              historyPosRef.current = historyRef.current.length
              onLineRef.current(line)
            }
            term.write(promptRef.current)
          } else if (ch === '\x7f' || ch === '\b') {
            if (lineBufferRef.current.length > 0) {
              lineBufferRef.current = popLastChar(lineBufferRef.current)
              term.write('\b \b')
            }
          } else if (ch === '\t') {
            lineBufferRef.current += ch
            term.write(ch)
          } else if (ch >= ' ' || ch > '\u007f') {
            lineBufferRef.current += ch
            term.write(ch)
          }
        }
      })

      const handleResize = () => {
        if (fitRef.current && termRef.current) {
          try {
            fitRef.current.fit()
          } catch {
            // ignore
          }
        }
      }

      const resizeObserver = new ResizeObserver(() => {
        handleResize()
      })
      resizeObserver.observe(containerRef.current)

      return () => {
        resizeObserver.disconnect()
        term.dispose()
        termRef.current = null
        fitRef.current = null
      }
    }, [])

    return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%' }} />
  }
)

XTerminal.displayName = 'XTerminal'
