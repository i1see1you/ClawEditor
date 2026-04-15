import type { FileTab } from '../types'

interface TabBarProps {
  files: FileTab[]
  activeFileId: string | null
  onTabClick: (id: string) => void
  onTabClose: (id: string) => void
}

export function TabBar({ files, activeFileId, onTabClick, onTabClose }: TabBarProps) {
  if (files.length === 0) return null

  return (
    <div className="tab-bar">
      {files.map((file) => (
        <div
          key={file.id}
          className={`tab ${file.id === activeFileId ? 'active' : ''}`}
          onClick={() => onTabClick(file.id)}
        >
          <span className="tab-name">
            {file.name}
            {file.isModified && ' •'}
          </span>
          <button
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation()
              onTabClose(file.id)
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}