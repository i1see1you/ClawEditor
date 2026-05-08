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
  if (Array.isArray(intent)) {
    for (let i = intent.length - 1; i >= 0; i--) {
      const step = intent[i]
      if (!step || typeof step !== 'object' || Array.isArray(step)) continue
      const o = step as Record<string, unknown>
      if (o.op !== 'replace_selection') continue
      const sf = o.selFrom
      const st = o.selTo
      if (typeof sf !== 'number' || typeof st !== 'number') continue
      if (!Number.isInteger(sf) || !Number.isInteger(st)) continue
      if (sf < 0 || st <= sf || st > baseTextLen) continue
      return { diffMode: 'selection', selectionFrom: sf, selectionTo: st }
    }
    return null
  }
  if (!intent || typeof intent !== 'object') return null
  const o = intent as Record<string, unknown>
  if (o.op !== 'replace_selection') return null
  const sf = o.selFrom
  const st = o.selTo
  if (typeof sf !== 'number' || typeof st !== 'number') return null
  if (!Number.isInteger(sf) || !Number.isInteger(st)) return null
  if (sf < 0 || st <= sf || st > baseTextLen) return null
  return { diffMode: 'selection', selectionFrom: sf, selectionTo: st }
}
