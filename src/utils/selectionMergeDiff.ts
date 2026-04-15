/**
 * For AI edit proposals that only changed a single [from, to) range in the file,
 * derive before/after slices for a selection-only diff. If prefix/suffix outside
 * the range differ, callers should fall back to full-file diff.
 */
export function computeSelectionDiffSlices(
  fileTextBefore: string,
  newFullText: string,
  selFrom: number,
  selTo: number
): { ok: true; before: string; after: string } | { ok: false } {
  if (selFrom < 0 || selTo < selFrom || selTo > fileTextBefore.length) return { ok: false }

  const selLen = selTo - selFrom
  const replLen = newFullText.length - fileTextBefore.length + selLen
  if (replLen < 0 || !Number.isFinite(replLen)) return { ok: false }

  const prefixOk = newFullText.slice(0, selFrom) === fileTextBefore.slice(0, selFrom)
  const suffixOk = newFullText.slice(selFrom + replLen) === fileTextBefore.slice(selTo)
  if (!prefixOk || !suffixOk) return { ok: false }

  return {
    ok: true,
    before: fileTextBefore.slice(selFrom, selTo),
    after: newFullText.slice(selFrom, selFrom + replLen),
  }
}
