import { open, save, message, confirm } from '@tauri-apps/plugin-dialog'
import { readTextFile, readFile, stat } from '@tauri-apps/plugin-fs'
import type { FileHandle, FileTab } from '../types'
import { useFileStore } from '../store/fileStore'

function decodeRtfToText(rtfContent: string): string {
  let result = rtfContent
  result = result.replace(/\\uc\d+\\u(-?\d+)\s?/g, (_, code) => {
    return String.fromCharCode(parseInt(code))
  })
  result = result.replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => {
    return String.fromCharCode(parseInt(hex, 16))
  })
  result = result.replace(/\\[a-z]+\d*\s?/gi, '')
  result = result.replace(/[{}]/g, '')
  result = result.replace(/\\\\/g, '\\')
  result = result.replace(/\\par\s*/g, '\n')
  result = result.replace(/\s+/g, ' ').trim()
  return result
}

export async function openFile(): Promise<FileHandle | null> {
  try {
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: 'Documents',
          extensions: [
            'txt',
            'md',
            'markdown',
            'html',
            'htm',
            'css',
            'js',
            'jsx',
            'ts',
            'tsx',
            'json',
            'xml',
            'yaml',
            'yml',
            'rtf',
            'pdf',
          ],
        },
      ],
    })

    if (!selected || Array.isArray(selected)) return null

    const path = selected as string
    const name = path.split('/').pop() || path
    const isPdf = name.endsWith('.pdf')
    const isRtf = name.toLowerCase().endsWith('.rtf')

    if (isPdf) {
      const bytes = await readFile(path)
      return { path, name, content: bytes, isPdf: true }
    }

    const content = await readTextFile(path)
    
    if (isRtf) {
      const decoded = decodeRtfToText(content)
      return { path, name, content: decoded, isPdf: false }
    }

    return { path, name, content, isPdf: false }
  } catch (err) {
    console.error('Failed to open file:', err)
    return null
  }
}

/** Disk metadata for external-change detection (focus / stat). */
export async function getFileDiskBaseline(
  path: string
): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const info = await stat(path)
    if (!info.isFile || info.mtime === null) return null
    return { mtimeMs: info.mtime.getTime(), size: info.size }
  } catch {
    return null
  }
}

export async function saveFile(path: string, content: string): Promise<boolean> {
  try {
    const { writeTextFile } = await import('@tauri-apps/plugin-fs')
    await writeTextFile(path, content)
    return true
  } catch (err) {
    console.error('Failed to save file:', err)
    return false
  }
}

export async function saveBinaryFile(path: string, bytes: Uint8Array): Promise<boolean> {
  try {
    const { writeFile } = await import('@tauri-apps/plugin-fs')
    await writeFile(path, bytes)
    return true
  } catch (err) {
    console.error('Failed to save binary file:', err)
    await notify({
      title: '写入文件失败',
      message: err instanceof Error ? err.message : String(err),
      kind: 'error',
    })
    return false
  }
}

export async function pickSavePdfPath(defaultName: string): Promise<string | null> {
  try {
    const selected = await save({
      defaultPath: defaultName.endsWith('.pdf') ? defaultName : `${defaultName}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (!selected) return null
    return selected as string
  } catch (err) {
    console.error('Failed to pick save path:', err)
    return null
  }
}

export async function notify(options: {
  title: string
  message: string
  kind?: 'info' | 'warning' | 'error'
}): Promise<void> {
  try {
    await message(options.message, { title: options.title, kind: options.kind ?? 'info' })
  } catch (err) {
    console.error('Failed to show message dialog:', err)
  }
}

/** Text tabs with unsaved edits that can be written to disk. */
export function getModifiedSavableFiles(files: FileTab[]): FileTab[] {
  return files.filter(
    (f) =>
      f.isModified &&
      !f.isPdf &&
      typeof f.content === 'string' &&
      Boolean(f.path)
  )
}

export type UnsavedChangesChoice = 'save' | 'discard' | 'cancel'

export type UnsavedPromptContext = 'quit' | 'closeTab'

/** Save / Don't save / Cancel for unsaved files (quit or close tab). */
export async function promptUnsavedChanges(
  fileNames: string[],
  context: UnsavedPromptContext = 'quit'
): Promise<UnsavedChangesChoice> {
  if (fileNames.length === 0) return 'discard'

  const list =
    fileNames.length <= 5
      ? fileNames.map((n) => `· ${n}`).join('\n')
      : `${fileNames
          .slice(0, 5)
          .map((n) => `· ${n}`)
          .join('\n')}\n… 另有 ${fileNames.length - 5} 个文件`

  const body =
    fileNames.length === 1
      ? context === 'closeTab'
        ? `「${fileNames[0]}」有未保存的更改。关闭标签页前是否保存？`
        : `「${fileNames[0]}」有未保存的更改。是否在退出前保存？`
      : context === 'closeTab'
        ? `以下 ${fileNames.length} 个文件有未保存的更改：\n\n${list}\n\n关闭前是否保存？`
        : `以下 ${fileNames.length} 个文件有未保存的更改：\n\n${list}\n\n是否在退出前保存？`

  const buttons = { yes: '保存', no: '不保存', cancel: '取消' } as const
  try {
    const result = await message(body, {
      title: '未保存的更改',
      kind: 'warning',
      buttons,
    })
    // Custom button labels are returned as-is (not 'Yes' / 'No' / 'Cancel').
    if (result === buttons.yes) return 'save'
    if (result === buttons.no) return 'discard'
    return 'cancel'
  } catch (err) {
    console.error('Failed to show unsaved changes dialog:', err)
    return 'cancel'
  }
}

export async function promptQuitWithUnsaved(fileNames: string[]): Promise<UnsavedChangesChoice> {
  return promptUnsavedChanges(fileNames, 'quit')
}

/** Persist all given modified tabs; updates file store on success. */
export async function saveAllModifiedFiles(
  files: FileTab[],
  opts?: { cancelAction?: string }
): Promise<boolean> {
  const cancelAction = opts?.cancelAction ?? '退出'
  const store = useFileStore.getState()
  for (const file of files) {
    if (typeof file.content !== 'string' || !file.path) continue
    const ok = await saveFile(file.path, file.content)
    if (!ok) {
      await notify({
        title: '保存失败',
        message: `无法保存「${file.name}」，已取消${cancelAction}。`,
        kind: 'error',
      })
      return false
    }
    store.setSavedContent(file.id, file.content)
    store.markModified(file.id, false)
    const baseline = await getFileDiskBaseline(file.path)
    if (baseline) store.setDiskBaseline(file.id, baseline.mtimeMs, baseline.size)
  }
  return true
}

/** Close a tab after optional save prompt when it has unsaved edits. */
export async function confirmCloseTab(tabId: string): Promise<void> {
  const store = useFileStore.getState()
  const file = store.files.find((f) => f.id === tabId)
  if (!file) return

  const modified = getModifiedSavableFiles([file])
  if (modified.length > 0) {
    const choice = await promptUnsavedChanges([file.name], 'closeTab')
    if (choice === 'cancel') return
    if (choice === 'save') {
      const ok = await saveAllModifiedFiles(modified, { cancelAction: '关闭标签页' })
      if (!ok) return
    }
  }

  useFileStore.getState().removeFile(tabId)
}

export async function confirmTruncatedPdfExport(options: {
  totalLines: number
  maxLines: number
}): Promise<boolean> {
  const { totalLines, maxLines } = options
  try {
    return await confirm(
      `当前文件共 ${totalLines} 行，超过 PDF 导出上限（${maxLines} 行）。\n\n是否仅导出前 ${maxLines} 行并继续？`,
      {
        title: '导出 PDF',
        kind: 'warning',
        okLabel: '继续导出',
        cancelLabel: '取消',
      },
    )
  } catch (err) {
    console.error('Failed to show confirm dialog:', err)
    return false
  }
}

export function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  const langMap: Record<string, string> = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', html: 'html', css: 'css', json: 'json', md: 'markdown',
    xml: 'xml', txt: 'plaintext',
  }
  return langMap[ext || ''] || 'plaintext'
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
