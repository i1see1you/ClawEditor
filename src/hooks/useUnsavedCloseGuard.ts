import { useEffect } from 'react'
import { useFileStore } from '../store/fileStore'
import {
  getModifiedSavableFiles,
  promptQuitWithUnsaved,
  saveAllModifiedFiles,
} from '../utils/fileOps'

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Intercept window close when text files have unsaved edits (Tauri only). */
export function useUnsavedCloseGuard(): void {
  useEffect(() => {
    if (!isTauriRuntime()) return

    let disposed = false
    let unlisten: (() => void) | undefined

    const register = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        if (disposed) return

        const appWindow = getCurrentWindow()
        unlisten = await appWindow.onCloseRequested(async (event) => {
          const modified = getModifiedSavableFiles(useFileStore.getState().files)
          if (modified.length === 0) return

          event.preventDefault()

          const choice = await promptQuitWithUnsaved(modified.map((f) => f.name))
          if (choice === 'cancel') return

          if (choice === 'save') {
            const ok = await saveAllModifiedFiles(modified)
            if (!ok) return
          }

          await appWindow.destroy()
        })
      } catch (err) {
        console.error('[useUnsavedCloseGuard] failed to register close handler:', err)
      }
    }

    void register()

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])
}
