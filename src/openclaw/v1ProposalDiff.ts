import { useFileStore } from '../store/fileStore'
import type { PendingProposal } from '../store/agentStore'
import type { FileTab } from '../types'
import { appendAuditLog } from '../utils/auditLog'
import { generateUnifiedDiff } from './unifiedDiff'
import type { ClawEditorV1OutboundEvent } from './clawEditorV1'

const emittedV1DiffIds = new Set<string>()

export function clearV1DiffEmitted(requestId: string): void {
  emittedV1DiffIds.delete(requestId)
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Resolve proposal target file from map entry (not active tab). */
export function resolveProposalTargetFile(
  proposal: Pick<PendingProposal, 'fileId' | 'filePath' | 'fileName'>,
  files: FileTab[]
): FileTab | undefined {
  if (proposal.fileId) {
    return files.find((f) => f.id === proposal.fileId)
  }
  if (proposal.filePath) {
    const target = normPath(proposal.filePath)
    return (
      files.find((f) => (f.path ? normPath(f.path) === target : false)) ??
      files.find((f) => (f.path ? normPath(f.path).endsWith('/' + target) : false)) ??
      files.find(
        (f) => (f.path ? normPath(f.path).split('/').pop() === target.split('/').pop() : false)
      )
    )
  }
  if (proposal.fileName) {
    const target = proposal.fileName.toLowerCase()
    return files.find((f) => f.name.toLowerCase() === target)
  }
  return undefined
}

export type EmitV1DiffDeps = {
  emitV1Event: (event: ClawEditorV1OutboundEvent) => void
  clearProposal: (requestId: string) => void
}

/**
 * Emit claw_editor.v1.diff_response (or no-op commit_response) for a v1 proposal by request_id.
 * Does not use activeProposalId — safe while local proposals own the diff popup.
 */
export function tryEmitV1DiffForProposal(
  proposal: PendingProposal,
  deps: EmitV1DiffDeps
): boolean {
  if (!proposal.remoteV1Context) return false
  if (emittedV1DiffIds.has(proposal.requestId)) return false

  const files = useFileStore.getState().files
  const targetFile = resolveProposalTargetFile(proposal, files)
  const fileName = targetFile?.name ?? proposal.fileName ?? 'unknown'
  const before =
    typeof targetFile?.content === 'string'
      ? targetFile.content
      : ''
  const after = proposal.newText
  const ctx = proposal.remoteV1Context

  emittedV1DiffIds.add(proposal.requestId)

  if (before === after) {
    deps.emitV1Event({
      type: 'claw_editor.v1.commit_response',
      request_id: proposal.requestId,
      context: ctx,
      payload: {
        action: 'ignore',
        ok: true,
        message: '命令未产生修改',
      },
    })
    deps.clearProposal(proposal.requestId)
    if (proposal.correlationId) {
      void appendAuditLog({
        event: 'finished',
        correlationId: proposal.correlationId,
        source: 'channel',
        command: proposal.originalCommand ?? '',
        channel: proposal.channel,
        sessionKey: proposal.sessionKey,
        deliveryId: proposal.deliveryId,
        file: proposal.fileName,
        fileId: proposal.fileId,
        outcome: 'completed',
        reason: 'no_document_change',
      })
    }
    return true
  }

  const diffText = generateUnifiedDiff(before, after, fileName)
  deps.emitV1Event({
    type: 'claw_editor.v1.diff_response',
    request_id: proposal.requestId,
    context: ctx,
    payload: {
      summary: `修改建议 (${fileName})`,
      diff_text: diffText,
      file_name: fileName,
    },
  })
  return true
}

/** Look up proposal by request_id in agent store map and emit v1 diff if needed. */
export function tryEmitV1DiffByRequestId(
  requestId: string,
  getProposal: () => PendingProposal | undefined,
  deps: EmitV1DiffDeps
): boolean {
  const proposal = getProposal()
  if (!proposal || proposal.requestId !== requestId) return false
  return tryEmitV1DiffForProposal(proposal, deps)
}
