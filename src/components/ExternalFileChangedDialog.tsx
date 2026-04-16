interface ExternalFileChangedDialogProps {
  fileName: string
  onReload: () => void
  onKeepEditing: () => void
}

export function ExternalFileChangedDialog({
  fileName,
  onReload,
  onKeepEditing,
}: ExternalFileChangedDialogProps) {
  return (
    <div className="external-file-dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="ext-file-title">
      <div className="external-file-dialog-card">
        <div id="ext-file-title" className="external-file-dialog-title">
          磁盘上的文件已更新
        </div>
        <p className="external-file-dialog-body">
          「{fileName}」在编辑器外已被修改，而当前缓冲区内有未保存的更改。
          请选择重新加载（将丢失未保存内容）或保留当前编辑。
        </p>
        <div className="external-file-dialog-buttons">
          <button type="button" className="agent-btn" onClick={onKeepEditing}>
            保留编辑
          </button>
          <button type="button" className="agent-btn primary" onClick={onReload}>
            重新加载
          </button>
        </div>
      </div>
    </div>
  )
}
