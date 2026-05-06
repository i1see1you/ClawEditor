import { useMemo } from 'react'
import type { FileTab } from '../types'
import { formatFileSize } from '../utils/fileOps'
import { useEditorStore } from '../store/editorStore'

interface StatusBarProps {
  file: FileTab | null
  theme: 'light' | 'dark'
}

export function StatusBar({ file, theme }: StatusBarProps) {
  const findMatchStatus = useEditorStore((s) => s.findMatchStatus)
  const findTransientMessage = useEditorStore((s) => s.findTransientMessage)

  const findLine = useMemo(() => {
    if (!findMatchStatus && !findTransientMessage) return null
    const parts: string[] = []
    const fm = findMatchStatus
    if (fm) {
      if (!fm.queryValid) {
        parts.push('查找 · 条件无效（例如正则错误）')
      } else if (fm.total === 0) {
        parts.push('查找 · 未找到匹配')
      } else {
        const totalLabel = fm.capped ? `${fm.total}+` : String(fm.total)
        if (fm.current != null) {
          parts.push(`查找 · 第 ${fm.current} / ${totalLabel} 处`)
        } else {
          parts.push(`查找 · 共 ${totalLabel} 处`)
        }
      }
    }
    if (findTransientMessage) {
      parts.push(findTransientMessage)
    }
    return parts.join(' · ')
  }, [findMatchStatus, findTransientMessage])

  if (!file) {
    return (
      <div className="status-bar">
        <span className="status-item">就绪</span>
        {findLine ? (
          <span className="status-item status-find-line">{findLine}</span>
        ) : null}
        <span className="status-right">{theme === 'dark' ? '深色' : '浅色'}主题</span>
      </div>
    )
  }

  return (
    <div className="status-bar">
      <span className="status-item">{file.name}</span>
      <span className="status-item">{file.language}</span>
      <span className="status-item">{file.encoding || 'UTF-8'}</span>
      <span className="status-item">行数: {file.lineCount}</span>
      {findLine ? (
        <span className="status-item status-find-line">{findLine}</span>
      ) : null}
      <span className="status-right">{formatFileSize(file.fileSize)}</span>
    </div>
  )
}
