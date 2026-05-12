export interface RemoteCommandMeta {
  deliveryId?: string
  sessionKey?: string
  channel?: string
  /** Basename of the target file specified via --file <name> in the command. */
  targetFile?: string
}

export type RemoteCommandExecutor = (line: string, meta: RemoteCommandMeta) => void

let executor: RemoteCommandExecutor | null = null

export function setRemoteCommandExecutor(fn: RemoteCommandExecutor | null): void {
  executor = fn
}

/** @returns whether an Agent panel registered an executor */
export function runRemoteEditorCommand(line: string, meta: RemoteCommandMeta = {}): boolean {
  if (!executor) return false
  executor(line, meta)
  return true
}
