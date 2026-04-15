import { open, save, message } from '@tauri-apps/plugin-dialog'
import { readTextFile, readFile } from '@tauri-apps/plugin-fs'
import type { FileHandle } from '../types'

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
