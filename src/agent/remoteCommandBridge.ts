import type { ClawEditorV1Context } from '../openclaw/clawEditorV1'

export interface RemoteCommandMeta {
  deliveryId?: string
  sessionKey?: string
  channel?: string
  /** Basename of the target file specified via --file <name> in the command. */
  targetFile?: string
  /** claw_editor.v1 round-trip (Channel plugin → Master). */
  v1?: {
    requestId: string
    context: ClawEditorV1Context
  }
}

export type RemoteCommandExecutor = (line: string, meta: RemoteCommandMeta) => void

export type V1CommitExecutor = (commit: {
  request_id: string
  context: ClawEditorV1Context
  action: 'apply' | 'ignore'
}) => void

let executor: RemoteCommandExecutor | null = null
let v1CommitExecutor: V1CommitExecutor | null = null

const activeV1Requests = new Map<
  string,
  { context: ClawEditorV1Context; originalCommand: string }
>()

export function setRemoteCommandExecutor(fn: RemoteCommandExecutor | null): void {
  executor = fn
}

export function setV1CommitExecutor(fn: V1CommitExecutor | null): void {
  v1CommitExecutor = fn
}

/** @returns whether an Agent panel registered an executor */
export function runRemoteEditorCommand(line: string, meta: RemoteCommandMeta = {}): boolean {
  if (!executor) return false
  if (meta.v1) {
    activeV1Requests.set(meta.v1.requestId, {
      context: meta.v1.context,
      originalCommand: line.trim(),
    })
  }
  executor(line, meta)
  return true
}

export function runV1Commit(commit: {
  request_id: string
  context: ClawEditorV1Context
  action: 'apply' | 'ignore'
}): boolean {
  if (!v1CommitExecutor) return false
  v1CommitExecutor(commit)
  return true
}

export function peekV1Request(requestId: string) {
  return activeV1Requests.get(requestId)
}

export function clearV1Request(requestId: string): void {
  activeV1Requests.delete(requestId)
}
