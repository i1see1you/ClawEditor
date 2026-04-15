import { useMemo } from 'react'
import { diffLines } from 'diff'
import type { FileTab } from '../types'

interface DiffPanelProps {
  file: FileTab
}

type DiffLine =
  | { kind: 'ctx'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'del'; text: string }

function splitLinesKeepEnds(text: string): string[] {
  if (!text) return ['']
  const lines = text.split('\n')
  return lines
}

export function DiffPanel({ file }: DiffPanelProps) {
  const current = typeof file.content === 'string' ? file.content : ''
  const saved = typeof file.savedContent === 'string' ? file.savedContent : ''

  const lines = useMemo(() => {
    const parts = diffLines(saved, current)
    const out: DiffLine[] = []
    for (const p of parts) {
      const chunkLines = splitLinesKeepEnds(p.value)
      for (let i = 0; i < chunkLines.length; i++) {
        const t = chunkLines[i]
        // drop the trailing empty line that comes from diff chunk ending with '\n'
        if (i === chunkLines.length - 1 && t === '' && p.value.endsWith('\n')) continue
        if (p.added) out.push({ kind: 'add', text: t })
        else if (p.removed) out.push({ kind: 'del', text: t })
        else out.push({ kind: 'ctx', text: t })
      }
    }
    return out
  }, [saved, current])

  return (
    <div className="diff-panel">
      <div className="diff-header">
        <div className="diff-title">{file.name}</div>
        <div className="diff-subtitle">修改前（已保存） vs 修改后（当前）</div>
      </div>
      <div className="diff-body" role="table" aria-label="diff">
        {lines.map((l, idx) => (
          <div
            key={idx}
            className={`diff-line diff-${l.kind}`}
            role="row"
          >
            <div className="diff-prefix" aria-hidden="true">
              {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}
            </div>
            <pre className="diff-text">{l.text}</pre>
          </div>
        ))}
      </div>
    </div>
  )
}

