import { create } from 'zustand'
import type { FileTab } from '../types'

interface FileState {
  files: FileTab[]
  activeFileId: string | null
  addFile: (file: Omit<FileTab, 'id'>) => string
  removeFile: (id: string) => void
  setActiveFileId: (id: string | null) => void
  updateContent: (id: string, content: string) => void
  markModified: (id: string, modified: boolean) => void
  setSavedContent: (id: string, savedContent: string) => void
  setDiskBaseline: (id: string, mtimeMs: number, size: number) => void
  replaceContentFromDisk: (id: string, content: string) => void
}

let idCounter = 0

export const useFileStore = create<FileState>((set) => ({
  files: [],
  activeFileId: null,

  addFile: (file) => {
    const id = `file-${++idCounter}`
    const newFile: FileTab = { ...file, id, isModified: false }
    set((state) => ({
      files: [...state.files, newFile],
      activeFileId: id,
    }))
    return id
  },

  removeFile: (id) =>
    set((state) => {
      const idx = state.files.findIndex((f) => f.id === id)
      const newFiles = state.files.filter((f) => f.id !== id)
      let newActive = state.activeFileId
      if (state.activeFileId === id) {
        newActive = newFiles[Math.min(idx, newFiles.length - 1)]?.id ?? null
      }
      return { files: newFiles, activeFileId: newActive }
    }),

  setActiveFileId: (id) => set({ activeFileId: id }),

  updateContent: (id, content) =>
    set((state) => ({
      files: state.files.map((f) =>
        f.id === id ? { ...f, content, lineCount: content.split('\n').length } : f
      ),
    })),

  markModified: (id, modified) =>
    set((state) => ({
      files: state.files.map((f) => (f.id === id ? { ...f, isModified: modified } : f)),
    })),

  setSavedContent: (id, savedContent) =>
    set((state) => ({
      files: state.files.map((f) => (f.id === id ? { ...f, savedContent } : f)),
    })),

  setDiskBaseline: (id, mtimeMs, size) =>
    set((state) => ({
      files: state.files.map((f) =>
        f.id === id ? { ...f, diskMtimeMs: mtimeMs, diskSize: size } : f
      ),
    })),

  replaceContentFromDisk: (id, content) =>
    set((state) => ({
      files: state.files.map((f) =>
        f.id === id
          ? {
              ...f,
              content,
              savedContent: content,
              isModified: false,
              lineCount: content.split('\n').length,
              fileSize: content.length,
            }
          : f
      ),
    })),
}))
