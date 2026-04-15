import { useMemo } from 'react'
import { diffLines } from 'diff'

type DiffLine =
  | { kind: 'ctx'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'del'; text: string }

function splitLinesKeepEnds(text: string): string[] {
  if (!text) return ['']
  return text.split('\n')
}

interface TextDiffViewProps {
  before: string
  after: string
  title?: string
  subtitle?: string
}

export function TextDiffView({ before, after, title, subtitle }: TextDiffViewProps) {
  const lines = useMemo(() => {
    const parts = diffLines(before, after)
    const out: DiffLine[] = []
    for (const p of parts) {
      const chunkLines = splitLinesKeepEnds(p.value)
      for (let i = 0; i < chunkLines.length; i++) {
        const t = chunkLines[i]
        if (i === chunkLines.length - 1 && t === '' && p.value.endsWith('\n')) continue
        if (p.added) out.push({ kind: 'add', text: t })
        else if (p.removed) out.push({ kind: 'del', text: t })
        else out.push({ kind: 'ctx', text: t })
      }
    }
    return out
  }, [before, after])

  return (
    <div className="diff-panel text-diff-view">
      {(title || subtitle) && (
        <div className="diff-header">
          {title ? <div className="diff-title">{title}</div> : null}
          {subtitle ? <div className="diff-subtitle">{subtitle}</div> : null}
        </div>
      )}
      <div className="diff-body" role="table" aria-label="diff">
        {lines.map((l, idx) => (
          <div key={idx} className={`diff-line diff-${l.kind}`} role="row">
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
