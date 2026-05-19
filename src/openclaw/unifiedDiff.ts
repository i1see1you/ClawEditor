import { createPatch } from 'diff'

const REMOTE_DIFF_MAX_CHARS = 1800

/** Generate a compact unified diff string for Channel / proposal UI. */
export function generateUnifiedDiff(before: string, after: string, fileName: string): string {
  const patch = createPatch(fileName, before, after, '', '', { context: 3 })
  const hunks = patch.split('\n').slice(4).join('\n').trim()
  if (hunks.length <= REMOTE_DIFF_MAX_CHARS) return hunks
  return hunks.slice(0, REMOTE_DIFF_MAX_CHARS) + '\n…（diff 过长，已截断，建议在编辑器查看完整内容）'
}
