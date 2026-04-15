import { useMemo } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { FileTab } from '../types'

interface PreviewPanelProps {
  file: FileTab
}

export function PreviewPanel({ file }: PreviewPanelProps) {
  const content = typeof file.content === 'string' ? file.content : ''

  const isMarkdown = file.language === 'markdown'
  const isHtml = file.language === 'html'

  const markdownHtml = useMemo(() => {
    if (!isMarkdown) return ''
    const raw = marked.parse(content) as string
    return DOMPurify.sanitize(raw)
  }, [content, isMarkdown])

  if (!isMarkdown && !isHtml) {
    return (
      <div className="preview-panel">
        <div className="preview-empty">该文件类型暂无预览</div>
      </div>
    )
  }

  if (isHtml) {
    return (
      <div className="preview-panel">
        <iframe
          className="preview-iframe"
          title="HTML Preview"
          sandbox=""
          srcDoc={content}
        />
      </div>
    )
  }

  return (
    <div className="preview-panel">
      <div
        className="preview-markdown"
        dangerouslySetInnerHTML={{ __html: markdownHtml }}
      />
    </div>
  )
}

