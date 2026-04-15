import { mergeRange } from './documentOps'

function countTripleBackticks(s: string): number {
  return (s.match(/```/g) ?? []).length
}

/**
 * Extract full file content from assistant markdown.
 * - Requires **closed** ``` fences (odd count means streaming/partial → do not extract).
 * - Does not treat the whole message as file text (avoids "I'll help…" becoming the document).
 */
export function extractDocumentFromAssistantMarkdown(markdown: string): string | null {
  const t = markdown.trim()
  if (!t) return null
  if (t.startsWith('{') && t.endsWith('}')) return null

  const ticks = countTripleBackticks(t)
  if (ticks > 0 && ticks % 2 !== 0) {
    return null
  }

  const fenceRe = /```(?:[a-zA-Z0-9_.+-]+)?\n?([\s\S]*?)```/g
  let best: string | null = null
  let bestLen = 0
  let m: RegExpExecArray | null
  while ((m = fenceRe.exec(t)) !== null) {
    const inner = m[1].trim()
    if (inner.length > bestLen) {
      bestLen = inner.length
      best = inner
    }
  }
  if (best !== null && best.length >= 1) return best

  return null
}

export function mergeAiEditExtractWithSnapshot(
  snapshot: string,
  ctx: { diffMode: 'full' | 'selection'; selFrom: number; selTo: number },
  extracted: string
): string {
  if (ctx.diffMode === 'full') return extracted

  const from = ctx.selFrom
  const to = ctx.selTo
  if (from >= to) return extracted

  const prefix = snapshot.slice(0, from)
  const suffix = snapshot.slice(to)

  const looksLikeFullMerged =
    extracted.length >= snapshot.length - (to - from) - 1 &&
    extracted.slice(0, from) === prefix &&
    extracted.slice(extracted.length - suffix.length) === suffix

  if (looksLikeFullMerged) return extracted

  return mergeRange(snapshot, from, to, extracted)
}
