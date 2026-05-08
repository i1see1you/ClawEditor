import { useMemo } from 'react'
import { diffLines } from 'diff'
import { buildSideBySideRows } from '../utils/lineAlignedPartialMerge'

type DiffLine =
  | { kind: 'ctx'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'del'; text: string }

export type TextDiffVariant = 'unified' | 'sideBySide'

/** Empty `<pre>` collapses to no visible height; use NBSP so unchanged blank lines still occupy one line. */
function displayLineText(s: string): string {
  return s === '' ? '\u00a0' : s
}

function splitLinesKeepEnds(text: string): string[] {
  if (!text) return ['']
  return text.split('\n')
}

interface TextDiffViewProps {
  before: string
  after: string
  title?: string
  subtitle?: string
  /** Default `unified` (single column +/-). */
  variant?: TextDiffVariant
  /**
   * With `variant="sideBySide"`, show a gutter control on changed lines.
   * Requires `adoptedLineIndices` and `onToggleAdoptedLine`.
   */
  interactive?: boolean
  /** Row indices where the right-hand (after) line is adopted for apply-selected. */
  adoptedLineIndices?: ReadonlySet<number>
  onToggleAdoptedLine?: (lineIndex: number) => void
}

export function TextDiffView({
  before,
  after,
  title,
  subtitle,
  variant = 'unified',
  interactive = false,
  adoptedLineIndices,
  onToggleAdoptedLine,
}: TextDiffViewProps) {
  const unifiedLines = useMemo(() => {
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

  const sideBySide = useMemo(() => buildSideBySideRows(before, after), [before, after])

  const effectiveVariant = variant === 'sideBySide' && !sideBySide.lineAligned ? 'unified' : variant
  const showMisalignedNote = variant === 'sideBySide' && !sideBySide.lineAligned

  const mergedSubtitle = showMisalignedNote
    ? `${subtitle ? `${subtitle} · ` : ''}行数不一致，已改用单列 diff`
    : subtitle

  if (effectiveVariant === 'sideBySide') {
    const canInteract = Boolean(
      interactive && adoptedLineIndices && onToggleAdoptedLine && sideBySide.lineAligned
    )

    return (
      <div className="diff-panel text-diff-view text-diff-view--side-by-side">
        {(title || mergedSubtitle) && (
          <div className="diff-header">
            {title ? <div className="diff-title">{title}</div> : null}
            {mergedSubtitle ? <div className="diff-subtitle">{mergedSubtitle}</div> : null}
          </div>
        )}
        <div className="diff-sidebyside-head" aria-hidden="true">
          <span className="diff-sidebyside-gutter-spacer" />
          <span className="diff-sidebyside-col-title">当前</span>
          <span className="diff-sidebyside-col-title">建议</span>
        </div>
        <div className="diff-body diff-body--side-by-side" role="table" aria-label="并排 diff">
          {sideBySide.rows.map((row) => (
            <div
              key={row.lineIndex}
              className={`diff-sidebyside-row${row.changed ? ' diff-sidebyside-row--changed' : ''}`}
              role="row"
            >
              <div className="diff-sidebyside-gutter">
                {row.changed && canInteract ? (
                  <button
                    type="button"
                    className={`diff-line-adopt-btn${adoptedLineIndices!.has(row.lineIndex) ? ' is-on' : ''}`}
                    aria-pressed={adoptedLineIndices!.has(row.lineIndex)}
                    aria-label={
                      adoptedLineIndices!.has(row.lineIndex)
                        ? `第 ${row.lineIndex + 1} 行：已采纳建议，点击取消`
                        : `第 ${row.lineIndex + 1} 行：未采纳建议，点击采纳`
                    }
                    onClick={() => onToggleAdoptedLine!(row.lineIndex)}
                  >
                    {adoptedLineIndices!.has(row.lineIndex) ? '✓' : '○'}
                  </button>
                ) : row.changed ? (
                  <span className="diff-line-adopt-mark" aria-hidden="true">
                    ·
                  </span>
                ) : null}
              </div>
              <pre className="diff-sidebyside-cell diff-sidebyside-left">
                {displayLineText(row.left)}
              </pre>
              <pre className="diff-sidebyside-cell diff-sidebyside-right">
                {displayLineText(row.right)}
              </pre>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="diff-panel text-diff-view">
      {(title || mergedSubtitle) && (
        <div className="diff-header">
          {title ? <div className="diff-title">{title}</div> : null}
          {mergedSubtitle ? <div className="diff-subtitle">{mergedSubtitle}</div> : null}
        </div>
      )}
      <div className="diff-body" role="table" aria-label="diff">
        {unifiedLines.map((l, idx) => (
          <div key={idx} className={`diff-line diff-${l.kind}`} role="row">
            <div className="diff-prefix" aria-hidden="true">
              {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}
            </div>
            <pre className="diff-text">{displayLineText(l.text)}</pre>
          </div>
        ))}
      </div>
    </div>
  )
}
