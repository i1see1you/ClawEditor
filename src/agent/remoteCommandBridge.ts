export type RemoteCommandExecutor = (line: string) => void

let executor: RemoteCommandExecutor | null = null

export function setRemoteCommandExecutor(fn: RemoteCommandExecutor | null): void {
  executor = fn
}

/** @returns whether an Agent panel registered an executor */
export function runRemoteEditorCommand(line: string): boolean {
  if (!executor) return false
  executor(line)
  return true
}
