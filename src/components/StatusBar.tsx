import type { FileTab } from '../types'
import { formatFileSize } from '../utils/fileOps'

interface StatusBarProps {
  file: FileTab | null
  theme: 'light' | 'dark'
}

export function StatusBar({ file, theme }: StatusBarProps) {
  if (!file) {
    return (
      <div className="status-bar">
        <span className="status-item">就绪</span>
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
      <span className="status-right">{formatFileSize(file.fileSize)}</span>
    </div>
  )
}