/**
 * Maps local four-op `replace_selection` intents to PendingProposal fields
 * so the proposal UI can diff only the edited range (see `computeSelectionDiffSlices`).
 */
export type SelectionDiffProposalFields = {
  diffMode: 'selection'
  selectionFrom: number
  selectionTo: number
}

export function selectionProposalFieldsFromReplaceSelectionIntent(
  intent: unknown,
  baseTextLen: number
): SelectionDiffProposalFields | null {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return null
  const o = intent as Record<string, unknown>
  if (o.op !== 'replace_selection') return null
  const sf = o.selFrom
  const st = o.selTo
  if (typeof sf !== 'number' || typeof st !== 'number') return null
  if (!Number.isInteger(sf) || !Number.isInteger(st)) return null
  if (sf < 0 || st <= sf || st > baseTextLen) return null
  return { diffMode: 'selection', selectionFrom: sf, selectionTo: st }
}
