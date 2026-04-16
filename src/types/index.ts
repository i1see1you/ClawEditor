export interface FileTab {
  id: string
  name: string
  path: string
  content: string | Uint8Array
  savedContent?: string
  isModified: boolean
  language: string
  encoding: string
  lineCount: number
  fileSize: number
  isPdf: boolean
  /**
   * Last known disk metadata when the buffer was aligned with disk (open/save/reload).
   * Used by focus-time external change detection (mtime + size).
   */
  diskMtimeMs?: number
  diskSize?: number
}

export interface FileHandle {
  path: string
  name: string
  content: string | Uint8Array
  isPdf: boolean
}
